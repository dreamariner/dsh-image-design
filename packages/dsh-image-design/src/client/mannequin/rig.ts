// 骨架装配层：把 poses.ts 的「关节欧拉表」应用到自建骨架（MakeHuman 人偶）。
//
// 骨架特性（scripts/build-mannequin-body.mjs 建的）：
//   · 28 根骨，**局部旋转全是单位阵**（只有平移），所以每根骨在绑定姿态下的世界
//     朝向就是世界朝向 → 姿势欧拉直接按世界轴书写，语义清晰、零轴向猜测。
//   · 绑定姿态就是 **A-pose**（手臂自然下垂约 40°），所以**不需要落臂补偿**
//     （上一版对 Mixamo T-pose 骨架做的 Q_down 补偿在新骨架上是多余的）。
//
// 姿势合成：父先于子，骨的局部四元数 = 姿势欧拉；子骨随父骨的新朝向一起动
// （局部旋转天然级联），因此弯肘时前臂跟着走。
//
// 旋转约定（世界轴欧拉，XYZ 顺序；正负号已用 GLB 骨架 FK 逐项标定）：
//   · 髋 x > 0 = 大腿后伸，x < 0 = 前屈
//   · 膝 x > 0 = 小腿向后折（生理唯一方向），x < 0 = 反关节
//   · 踝 x > 0 = 跖屈（脚尖下压），x < 0 = 背屈（脚尖上抬）——与 poses.ts 标定一致
//     （2026-11-17 审计修正：此处曾写反；跪坐 ankle=+0.9 脚背放平证明 x>0 是跖屈）
//   · 肩 x > 0 = 手臂后摆，x < 0 = 前摆；z > 0 = 外展抬起（左臂）
//   · 肘 x < 0 = 屈肘（前臂向前），x > 0 = 过伸
//   · 脊柱 x > 0 = 前倾
//   详细说明与姿势表见 poses.ts 顶部。

import * as THREE from 'three'
import { BONE, JOINT_NAMES, type JointName } from './body.ts'
import type { JointRotations } from './poses.ts'

/** 关节 → 骨骼名。 */
export const JOINT_BONES: Record<JointName, string> = {
  spine: BONE.spine1,
  chest: BONE.spine3,
  neck: BONE.neck,
  head: BONE.head,
  shoulderL: BONE.armL,
  elbowL: BONE.foreArmL,
  wristL: BONE.handL,
  shoulderR: BONE.armR,
  elbowR: BONE.foreArmR,
  wristR: BONE.handR,
  hipL: BONE.upLegL,
  kneeL: BONE.legL,
  ankleL: BONE.footL,
  hipR: BONE.upLegR,
  kneeR: BONE.legR,
  ankleR: BONE.footR,
}

/** 关节 → 子关节（用于算骨轴与骨长）。 */
export const JOINT_CHILD: Partial<Record<JointName, JointName>> = {
  shoulderL: 'elbowL',
  elbowL: 'wristL',
  shoulderR: 'elbowR',
  elbowR: 'wristR',
  hipL: 'kneeL',
  kneeL: 'ankleL',
  hipR: 'kneeR',
  kneeR: 'ankleR',
}

/** 应用顺序：父先于子。 */
export const APPLY_ORDER: readonly JointName[] = [
  'spine', 'chest', 'neck', 'head',
  'shoulderL', 'elbowL', 'wristL',
  'shoulderR', 'elbowR', 'wristR',
  'hipL', 'kneeL', 'ankleL',
  'hipR', 'kneeR', 'ankleR',
]

/** 姿势应用所需的一次性骨架上下文。 */
export interface RigBinding {  bones: Map<JointName, THREE.Object3D>
  /** 绑定姿态下各骨的**世界位置**（形变枢轴）。 */
  restWorld: Map<JointName, THREE.Vector3>
  /** 绑定姿态下各骨的**局部位置**（骨链长度调整的基准）。 */
  restLocal: Map<JointName, THREE.Vector3>
  /** 骨名 → 场景里的对象（形变 / 长度调整按骨名找）。 */
  byName: Map<string, THREE.Object3D>
  /** 角色左手在世界系的方向符号（面朝 +z 时角色左 = +x → 1）。 */
  zSign: number
  /** 骨名 → 绑定姿态世界位置（形变枢轴；按骨名查，不是按关节名）。 */
  boneRest: Map<string, THREE.Vector3>
  /** 骨名 → 骨轴单位向量（指向子骨；无子骨的骨为 null）。 */
  boneAxis: Map<string, THREE.Vector3>
  /** 骨名 → 绑定姿态局部位置（骨链长度调整的基准）。 */
  boneRestLocal: Map<string, THREE.Vector3>
}

/** 从加载好的 glTF 场景抓骨架。 */
export function bindRig(scene: THREE.Object3D): RigBinding {
  const byName = new Map<string, THREE.Object3D>()
  scene.traverse((obj) => {
    if (obj.name !== '') byName.set(obj.name.replace(/:/g, ''), obj)
  })
  const bones = new Map<JointName, THREE.Object3D>()
  const restWorld = new Map<JointName, THREE.Vector3>()
  const restLocal = new Map<JointName, THREE.Vector3>()
  const missing: string[] = []
  for (const j of JOINT_NAMES) {
    const bone = byName.get(JOINT_BONES[j])
    if (bone === undefined) { missing.push(JOINT_BONES[j]); continue }
    // ⚠ three 的 GLTFLoader 对 glTF 节点设 matrixAutoUpdate = false（性能优化）：
    //   不改回来的话，改 quaternion / scale 都不会重算 matrixWorld，蒙皮纹丝不动
    //   （2026-11-17 实测事故：姿势应用成功但画面始终是绑定姿态）
    bone.matrixAutoUpdate = true
    bone.updateWorldMatrix(true, false)
    bones.set(j, bone)
    restWorld.set(j, bone.getWorldPosition(new THREE.Vector3()))
    restLocal.set(j, bone.position.clone())
  }
  if (missing.length > 0) throw new Error(`骨架缺骨：${missing.join(', ')}`)
  // 角色左手在世界系的位置符号：面朝 +z 时角色左 = +x
  const leftShoulder = bones.get('shoulderL')
  const zSign = leftShoulder !== undefined && leftShoulder.getWorldPosition(new THREE.Vector3()).x >= 0 ? 1 : -1

  // 骨名 → 绑定姿态世界位置 / 骨轴（形变用）
  const boneRest = new Map<string, THREE.Vector3>()
  for (const [name, node] of byName) {
    if (node.getWorldPosition(new THREE.Vector3()).lengthSq() === 0 && name === '') continue
    boneRest.set(name, node.getWorldPosition(new THREE.Vector3()))
  }
  const boneRestLocal = new Map<string, THREE.Vector3>()
  for (const [name, node] of byName) boneRestLocal.set(name, node.position.clone())
  const boneAxis = new Map<string, THREE.Vector3>()
  for (const [name, node] of byName) {
    const child = node.children.find((c) => c.name.includes('mixamorig'))
    if (child === undefined) continue
    const dir = child.getWorldPosition(new THREE.Vector3()).sub(node.getWorldPosition(new THREE.Vector3()))
    if (dir.lengthSq() > 1e-12) boneAxis.set(name, dir.normalize())
  }
  return { bones, restWorld, restLocal, byName, zSign, boneRest, boneAxis, boneRestLocal }
}

/**
 * 应用姿势表（世界轴欧拉；父先于子）。
 *
 * 骨架局部旋转在绑定姿态是单位阵，所以局部四元数直接取姿势欧拉即可：骨的最终
 * 世界朝向 = 父骨新朝向 ∘ 自身欧拉，天然级联（弯肘时前臂跟着走）。
 */
export function applyRigPose(binding: RigBinding, table: JointRotations): void {
  for (const j of APPLY_ORDER) {
    const bone = binding.bones.get(j)
    if (bone === undefined) continue
    const r = table[j] ?? { x: 0, y: 0, z: 0 }
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x, r.y, r.z * binding.zSign, 'XYZ'))
    bone.quaternion.copy(q)
    bone.updateMatrix()
    bone.updateWorldMatrix(true, false)
  }
}

/** 蒙皮采样所需的数据（与 three 的 SkinnedMesh 属性一一对应）。 */
export interface SkinSample {
  position: THREE.BufferAttribute
  skinIndex: THREE.BufferAttribute
  skinWeight: THREE.BufferAttribute
  bones: THREE.Object3D[]
  boneInverses: THREE.Matrix4[]
}

/**
 * 蒙皮后的世界最低点（m）——素体「落地」的唯一判据。
 *
 * 为什么不能沿用「绑定姿态脚趾骨 y − 脚掌厚度」：那只对 A-pose 成立。姿势一变
 * （跑/坐/跪），贴地的部位整体改变，固定偏移会让整个人浮空——实测修复前
 * run 悬空 17.1cm、walk 6.7cm、sit 36.2cm、kneel 27.3cm。
 *
 * `probe` 只传低位顶点（脚、小腿下段、垂下的手）就够：任何姿势真正贴地的部位
 * 都来自这批顶点，遍历量从 1.9 万降到 3 千，换姿势时 <5ms。
 */
export function lowestSkinnedY(sample: SkinSample, probe: readonly number[]): number {
  const { position, skinIndex, skinWeight, bones, boneInverses } = sample
  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  let minY = Infinity
  for (const i of probe) {
    let y = 0
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k)
      if (w === 0) continue
      const b = skinIndex.getComponent(i, k)
      const bone = bones[b]
      if (bone === undefined) continue
      m.multiplyMatrices(bone.matrixWorld, boneInverses[b])
      v.fromBufferAttribute(position, i).applyMatrix4(m)
      y += w * v.y
    }
    if (y < minY) minY = y
  }
  return minY === Infinity ? 0 : minY
}

// 骨骼装配层：把 poses.ts 的「关节欧拉表」应用到 Mixamo 蒙皮骨架（Soldier.glb）上。
//
// 设计：姿势表语义按世界轴书写（模型前方 = +z，实测脚尖方向）：
//   · x = 前后摆（x 负 = 向前抬），y = 转体，z = 向模型左侧展开；
//   · Mixamo 骨架的 rest 是 T-pose（双臂水平），应用姿势前先做「落臂补偿」Q_down
//     （把 rest 臂轴转到竖直向下 + 轻微外张），姿势欧拉以世界系 delta 前乘在
//     rest 世界朝向之前：
//
//       Q_target_world = Q_euler ∘ Q_down ∘ Q_rest_world      （臂）
//       Q_target_world = Q_euler ∘ Q_rest_world               （脊柱/颈/头/腿）
//       bone.quaternion = Q_parent_world⁻¹ ∘ Q_target_world
//
// 世界系合成的好处：完全不依赖 Mixamo 骨骼各自的本地轴约定（每根骨的 rest 朝向
// 各不相同，Xbot 臂轴 +x、Soldier 臂轴 -x 且骨架带根旋转），语义轴直接按世界轴写，
// 姿势表零修改可用。落臂补偿也按模型实测的 rest 臂轴动态算，不硬编码符号。
//
// 应用顺序父先于子（spine → chest → 颈头 → 四肢链），父级世界四元数取应用后状态。

import * as THREE from 'three'
import { BONE, JOINT_NAMES, type JointName } from './body.ts'
import type { JointRotations } from './poses.ts'

/** 落臂的目标方向（相对模型）：向下 + 轻微外张（外张角 rad）。 */
const ARM_SPREAD = 0.06

/** 关节 → 骨骼名（Xbot 的 mixamorig 骨架；名称冒号在加载时统一剥掉）。 */
export const JOINT_BONES: Record<JointName, string> = {
  spine: BONE.spine1,
  chest: BONE.spine2,
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

/** 关节 → 子关节（用于按「子骨位置差」算骨轴，与本地轴约定无关）。 */
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

/** 落臂补偿四元数（左右各一）：rest 臂轴 → 垂下 + 外张。 */
export const Q_DOWN_L = new THREE.Quaternion()
export const Q_DOWN_R = new THREE.Quaternion()
const IDENTITY = new THREE.Quaternion()
/**
 * 姿势表 z 分量的世界系换算系数（两侧统一）。
 *
 * 姿势表的 z 语义是「向身体外侧展开」：左臂 +z、右臂 -z（表里已是对称的一对）。
 * 但 Mixamo 骨架的「角色左」在世界系的方向随模型朝向而变（面朝 +z 时角色左 = +x，
 * 面朝 -z 时 = -x）。所以要按**左肩在世界系的位置符号**换算一次。
 * 之前误用「rest 臂轴方向」当手性，导致右臂向内收、穿进躯干（2026-11-17 实测事故）。
 */
let zSign = 1

/** 姿势应用所需的一次性骨架上下文。 */
export interface RigBinding {
  bones: Map<JointName, THREE.Object3D>
  /** rest 姿态下各骨的世界朝向（用于落臂补偿的轴向参考）。 */
  restWorld: Map<JointName, THREE.Quaternion>
  /** rest 姿态下各骨的**本地**旋转（级联公式的关键：子级跟随父级新朝向）。 */
  restLocal: Map<JointName, THREE.Quaternion>
}

/** 从加载好的 glTF 场景抓骨架：按归一化名（剥冒号）找骨骼，记 rest 世界朝向。 */
export function bindRig(scene: THREE.Object3D): RigBinding {
  const byName = new Map<string, THREE.Object3D>()
  scene.traverse((obj) => {
    const isBone = (obj as THREE.Object3D & { isBone?: boolean }).isBone === true
    if (!isBone && obj.name.includes('mixamorig') === false) return
    byName.set(obj.name.replace(/:/g, ''), obj)
  })
  const bones = new Map<JointName, THREE.Object3D>()
  const restWorld = new Map<JointName, THREE.Quaternion>()
  const restLocal = new Map<JointName, THREE.Quaternion>()
  const missing: string[] = []
  for (const j of JOINT_NAMES) {
    const bone = byName.get(JOINT_BONES[j])
    if (bone === undefined) { missing.push(JOINT_BONES[j]); continue }
    // ⚠ three 的 GLTFLoader 对 glTF 节点设 matrixAutoUpdate = false（性能优化）：
    //   不改回来的话，改 quaternion / scale 都不会重算 matrixWorld，蒙皮纹丝不动
    //   （2026-11-17 实测事故：姿势应用成功但画面始终 T-pose）
    bone.matrixAutoUpdate = true
    bone.updateWorldMatrix(true, false)
    bones.set(j, bone)
    restWorld.set(j, bone.getWorldQuaternion(new THREE.Quaternion()))
    restLocal.set(j, bone.quaternion.clone())
  }
  if (missing.length > 0) throw new Error(`骨架缺骨：${missing.join(', ')}`)
  initArmDrop({ bones, restWorld })
  return { bones, restWorld, restLocal }
}

/**
 * 按模型实测的 rest 臂轴，动态算落臂补偿：
 * Mixamo 各骨架的 rest 朝向不同（臂轴方向、左右手性都随模型变），硬编码符号会翻车。
 * 这里用「子骨世界位置 - 本骨世界位置」算骨轴（Mixamo 各骨架的骨轴本地约定
 * 不统一，本地 +X/+Y 都不可靠），转到「竖直向下 + 轻微外张」。
 */
function initArmDrop(binding: Pick<RigBinding, 'bones' | 'restWorld'>): void {
  const setup = (joint: JointName, child: JointName, out: THREE.Quaternion): void => {
    const bone = binding.bones.get(joint)
    const sub = binding.bones.get(child)
    if (bone === undefined || sub === undefined) return
    // 骨轴 = 子骨世界位置 - 本骨世界位置（rest 姿态）。
    // 不用本地 +X/+Y：Mixamo 各骨架的骨轴约定不一致（实测 Xbot 与 Soldier 不同），
    // 位置差是唯一可靠来源。
    const axis = sub.getWorldPosition(new THREE.Vector3())
      .sub(bone.getWorldPosition(new THREE.Vector3()))
      .normalize()
    // 目标：竖直向下，外张方向取臂的水平分量（保持左右各自向外）
    const target = new THREE.Vector3(axis.x * Math.sin(ARM_SPREAD), -Math.cos(ARM_SPREAD), 0).normalize()
    out.setFromUnitVectors(axis, target)
  }
  setup('shoulderL', 'elbowL', Q_DOWN_L)
  setup('shoulderR', 'elbowR', Q_DOWN_R)
  // 角色左手在世界系的位置符号：面朝 +z 时角色左 = +x
  const leftShoulder = binding.bones.get('shoulderL')
  if (leftShoulder !== undefined) {
    zSign = leftShoulder.getWorldPosition(new THREE.Vector3()).x >= 0 ? 1 : -1
  }
}

/** 应用姿势表（世界系合成；父先于子）。 */
export function applyRigPose(binding: RigBinding, table: JointRotations): void {
  for (const j of APPLY_ORDER) {
    const bone = binding.bones.get(j)
    const rest = binding.restWorld.get(j)
    if (bone === undefined || rest === undefined) continue
    const r = table[j] ?? { x: 0, y: 0, z: 0 }
    // 姿势表按世界轴书写：x = 前后摆（x 正 = 向后，x 负 = 向前）、y = 转体、
    // z = 向身体外侧展开（左 + / 右 -）。Mixamo 骨架的「角色左」在世界系的方向
    // 随模型朝向而变，故 z 分量统一乘以 zSign（按左肩位置判定）。
    const qEuler = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x, r.y, r.z * zSign, 'XYZ'))
    const qDown = j === 'shoulderL' ? Q_DOWN_L : j === 'shoulderR' ? Q_DOWN_R : IDENTITY
    // 级联公式：新本地旋转 = qEuler ∘ (落臂补偿) ∘ rest 本地旋转。
    //   子骨的 rest 本地旋转相对父骨固定，所以父级转多少，子级跟着转多少 ——
    //   落臂时整条臂链一起垂下（只转肩会让前臂留在水平，2026-11-17 实测事故）。
    const restLocal = binding.restLocal.get(j)
    if (restLocal === undefined) continue
    bone.quaternion.copy(qEuler.clone().multiply(qDown).multiply(restLocal))
    bone.updateMatrix()
    bone.updateWorldMatrix(true, false)
  }
}

// 姿势碰撞门禁：用**体段碰撞体**（沿肢体轴打射线量内外）断言「不穿模」。
//
// 为什么不用旧的 pose-clip 审计：旧判据靠「面法线多数表决 + 符号门槛 + 缝区剔除」，
// 在关节凹陷与大倾角面上会漏判——实机截图里手明显陷进大腿，审计却报「无穿插」。
// 于是「调到审计说 0 为止」是循环论证：判据错了，调出来的角度必然也错。
//
// 新判据（两法交叉，符号无歧义）：
//   · 轴心在肢体内部 → 从轴心沿「轴心→查询点」打射线，第一个命中就是外表面；
//   · 命中面必须属于该肢体，否则说明射线从别的部位/空洞穿出去了，不能拿来判内外；
//   · 查询点比命中点更近 = 点在体内，差值就是穿深。
// 深度量的是「沿径向到表面的距离」，比真正的最短距离略保守，但符号可靠。

import * as THREE from 'three'
import { poseJoints, type JointRotations } from '../../src/client/mannequin/poses.ts'
import { applyRigPose, type RigBinding } from '../../src/client/mannequin/rig.ts'
import { CollisionSurface, BodyPartCollider } from '../../src/client/mannequin/contact.ts'
import type { RigFixture } from './rig-fixture.ts'

/** 碰撞目标：躯干 + 双腿（手臂可能撞到的部位）。 */
const TARGET_BONES = new Set([
  'mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigSpine3',
  'mixamorigLeftUpLeg', 'mixamorigLeftLeg', 'mixamorigLeftFoot', 'mixamorigLeftToeBase',
  'mixamorigRightUpLeg', 'mixamorigRightLeg', 'mixamorigRightFoot', 'mixamorigRightToeBase',
])

export interface PoseContact {
  /** 最大穿深（米）。 */
  maxPen: number
  /** 穿得最深的部位说明。 */
  label: string
  /** 各部位的穿深（米），键为部位名。 */
  byPart: Record<string, number>
  /** 穿得最深的顶点位置（调试用）。 */
  deepestPos?: [number, number, number]
}

/** 蒙皮后整身顶点世界坐标。 */
export function skinPositions(fx: RigFixture, joints: ReturnType<typeof poseJoints>): Float32Array {
  applyRigPose({ bones: fx.bones, zSign: fx.zSign } as unknown as RigBinding, joints)
  fx.root.updateMatrixWorld(true)
  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  const out = new Float32Array(fx.position.count * 3)
  for (let i = 0; i < fx.position.count; i++) {
    const px = fx.position.getX(i), py = fx.position.getY(i), pz = fx.position.getZ(i)
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 4; k++) {
      const w = fx.skinWeight.getComponent(i, k)
      if (w === 0) continue
      const b = fx.skinIndex.getComponent(i, k)
      const bone = fx.boneList[b]
      if (bone === undefined) continue
      m.multiplyMatrices(bone.matrixWorld, fx.boneInverses[b])
      v.set(px, py, pz).applyMatrix4(m)
      x += w * v.x; y += w * v.y; z += w * v.z
    }
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z
  }
  return out
}

/** 顶点的主导骨名。 */
export function dominantBone(fx: RigFixture, i: number): string {
  let bw = 0, bj = 0
  for (let k = 0; k < 4; k++) {
    const w = fx.skinWeight.getComponent(i, k)
    if (w > bw) { bw = w; bj = fx.skinIndex.getComponent(i, k) }
  }
  return fx.boneList[bj]?.name ?? ''
}

/** 目标部位的面片索引（三个顶点里至少两个属于目标部位；见 contact.ts 的说明）。 */
export function targetFaceIndices(fx: RigFixture): Uint32Array {
  const set = new Set<number>()
  for (let i = 0; i < fx.position.count; i++) if (TARGET_BONES.has(dominantBone(fx, i))) set.add(i)
  const out: number[] = []
  for (let t = 0; t < fx.index.length; t += 3) {
    const a = fx.index[t], b = fx.index[t + 1], c = fx.index[t + 2]
    const hits = (set.has(a) ? 1 : 0) + (set.has(b) ? 1 : 0) + (set.has(c) ? 1 : 0)
    if (hits >= 2) out.push(a, b, c)
  }
  return Uint32Array.from(out)
}

/** 该姿势下手臂相对躯干/腿的穿模情况。 */
export function poseContact(fx: RigFixture, poseId: string): PoseContact {
  return poseContactJoints(fx, poseJoints(poseId))
}

/** 任意关节表下手臂相对躯干/腿的穿模情况（求解器输出的姿势也走这条判据 ✓）。 */
export function poseContactJoints(fx: RigFixture, joints: JointRotations): PoseContact {
  const posed = skinPositions(fx, joints)
  const bindNormals = new Float32Array(fx.position.count * 3)
  for (let i = 0; i < fx.position.count; i++) {
    bindNormals[i * 3] = fx.normal.getX(i)
    bindNormals[i * 3 + 1] = fx.normal.getY(i)
    bindNormals[i * 3 + 2] = fx.normal.getZ(i)
  }
  const idx = targetFaceIndices(fx)
  const surface = new CollisionSurface({ positions: posed, indices: idx, bindNormals })
  const boneOfFace = (f: number) => dominantBone(fx, idx[f * 3])
  const at = (bone: string) => fx.byName.get(bone)!.getWorldPosition(new THREE.Vector3())
  const is = (...names: string[]) => (f: number) => names.includes(boneOfFace(f))
  const parts: BodyPartCollider[] = [
    new BodyPartCollider('左大腿', at('mixamorigLeftUpLeg'), at('mixamorigLeftLeg'), surface, is('mixamorigLeftUpLeg')),
    new BodyPartCollider('右大腿', at('mixamorigRightUpLeg'), at('mixamorigRightLeg'), surface, is('mixamorigRightUpLeg')),
    new BodyPartCollider('左小腿', at('mixamorigLeftLeg'), at('mixamorigLeftFoot'), surface, is('mixamorigLeftLeg')),
    new BodyPartCollider('右小腿', at('mixamorigRightLeg'), at('mixamorigRightFoot'), surface, is('mixamorigRightLeg')),
    new BodyPartCollider('躯干', at('mixamorigHips'), at('mixamorigSpine3'), surface,
      is('mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigSpine3')),
  ]
  const armIdx: number[] = []
  for (let i = 0; i < fx.position.count; i++) {
    const n = dominantBone(fx, i)
    if (/Arm$|ForeArm$|Hand$|HandEnd$/.test(n)) armIdx.push(i)
  }
  const p = new THREE.Vector3()
  const byPart: Record<string, number> = {}
  let maxPen = 0, label = ''
  let deepestPos: [number, number, number] | undefined
  for (const i of armIdx) {
    p.set(posed[i * 3], posed[i * 3 + 1], posed[i * 3 + 2])
    for (const part of parts) {
      const d = part.depth(p)
      if (d > (byPart[part.name] ?? 0)) byPart[part.name] = d
      if (d > maxPen) {
        maxPen = d
        label = `${part.name}（${dominantBone(fx, i)}）`
        deepestPos = [p.x, p.y, p.z]
      }
    }
  }
  return { maxPen, label, byPart, deepestPos }
}

/**
 * 手掌相对大腿面的间隙（米）：正 = 在腿面之上，负 = 陷进腿里。
 * 坐姿/跪坐的「手搭在大腿上」就靠这条断言把关（要接触级，不能悬空也不能陷进去）。
 */
export function handThighGap(fx: RigFixture, poseId: string, side: 'Left' | 'Right'): number {
  return handThighGapJoints(fx, poseJoints(poseId), side)
}

/** 任意关节表下，手掌相对大腿面的间隙（米）。 */
export function handThighGapJoints(
  fx: RigFixture, joints: JointRotations, side: 'Left' | 'Right',
): number {
  const posed = skinPositions(fx, joints)
  const bindNormals = new Float32Array(fx.position.count * 3)
  for (let i = 0; i < fx.position.count; i++) {
    bindNormals[i * 3] = fx.normal.getX(i)
    bindNormals[i * 3 + 1] = fx.normal.getY(i)
    bindNormals[i * 3 + 2] = fx.normal.getZ(i)
  }
  const idx = targetFaceIndices(fx)
  const surface = new CollisionSurface({ positions: posed, indices: idx, bindNormals })
  const boneOfFace = (f: number) => dominantBone(fx, idx[f * 3])
  const at = (bone: string) => fx.byName.get(bone)!.getWorldPosition(new THREE.Vector3())
  const thigh = new BodyPartCollider(
    side === 'Left' ? '左大腿' : '右大腿',
    at(`mixamorig${side}UpLeg`), at(`mixamorig${side}Leg`), surface,
    (f: number) => boneOfFace(f) === `mixamorig${side}UpLeg`,
  )
  const palm: number[] = []
  for (let i = 0; i < fx.position.count; i++) {
    const n = dominantBone(fx, i)
    if (n === `mixamorig${side}Hand` || n === `mixamorig${side}HandEnd`) palm.push(i)
  }
  const p = new THREE.Vector3()
  let gap = Infinity
  for (let k = 0; k < palm.length; k += 4) {
    const i = palm[k]
    p.set(posed[i * 3], posed[i * 3 + 1], posed[i * 3 + 2])
    const g = thigh.gap(p)
    if (g < gap) gap = g
  }
  return gap
}

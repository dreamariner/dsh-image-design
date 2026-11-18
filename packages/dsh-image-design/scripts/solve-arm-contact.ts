// 手臂姿态求解器：IK + 碰撞约束，取代「手拧角度 + 审计说 0 为止」。
//
// 旧做法的病根（2026-11-18 实机事故）：姿势表里的肩肘腕角是手拧的，穿模判据又不可靠
// （旧审计报「无穿插」，实机截图里手陷进大腿）。于是「调到审计说 0 为止」是循环论证
// ——判据错了，调出来的角度必然也错。
//
// 新做法（三层，各司其职）：
//   ① **变量换对**：不再手拧角度，而是声明「腕关节该落在哪、手掌该朝哪」；
//      肩肘角由**两骨解析 IK** 解出（src/client/mannequin/ik.ts）。
//   ② **碰撞作约束**：用**体段碰撞体**（沿肢体轴打射线量内外，符号无歧义，
//      见 contact.ts 的 BodyPartCollider）验收，穿深 > 0 的候选出局。
//   ③ **搜索而非硬猜**：在「腕落点沿腿轴的位置 / 离面间隙 / 落点内外偏角 /
//      肘朝向 / 手掌俯仰」上网格搜索，取「零穿深 + 手贴面 + 姿势自然」的最优解。
//
// 用法：
//   node --experimental-strip-types scripts/solve-arm-contact.ts check [poseId...]
//       体检：逐姿势报穿深与手-腿间隙
//   node --experimental-strip-types scripts/solve-arm-contact.ts solve <poseId> <L|R>
//       求解：手搭大腿的 IK 解，输出姿势表欧拉角
//   node --experimental-strip-types scripts/solve-arm-contact.ts debug <poseId> [L|R]
//       打印关节位置与最深处

import * as THREE from 'three'
import { poseJoints, normalizePose, type JointRotations } from '../src/client/mannequin/poses.ts'
import { applyRigPose } from '../src/client/mannequin/rig.ts'
import { loadRigFixture } from '../tests/helpers/rig-fixture.ts'
import { CollisionSurface, BodyPartCollider } from '../src/client/mannequin/contact.ts'
import {
  solveTwoBone, solveHandOrientation, makeHandFrame, localQuatToPoseEuler,
  type HandFrame, type TwoBoneSolution,
} from '../src/client/mannequin/ik.ts'

const fx = loadRigFixture()
const ZS = fx.zSign

// ── 顶点的骨归属 ──
const dominantOf = (i: number): string => {
  let bw = 0, bj = 0
  for (let k = 0; k < 4; k++) {
    const w = fx.skinWeight.getComponent(i, k)
    if (w > bw) { bw = w; bj = fx.skinIndex.getComponent(i, k) }
  }
  return fx.boneList[bj]?.name ?? ''
}
const vertIdxOf = (pred: (bone: string) => boolean): number[] => {
  const out: number[] = []
  for (let i = 0; i < fx.position.count; i++) if (pred(dominantOf(i))) out.push(i)
  return out
}

const ARM_BONES = (side: string) => [
  `mixamorig${side}Arm`, `mixamorig${side}ForeArm`, `mixamorig${side}Hand`, `mixamorig${side}HandEnd`,
]
const armVertsOf = (side: string): number[] => vertIdxOf((b) => ARM_BONES(side).includes(b))
const palmVertsOf = (side: string): number[] =>
  vertIdxOf((b) => b === `mixamorig${side}Hand` || b === `mixamorig${side}HandEnd`)

/** 碰撞目标：躯干 + 双腿（手臂可能撞到的部位）。 */
const TARGET_BONES = new Set([
  'mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigSpine3',
  'mixamorigLeftUpLeg', 'mixamorigLeftLeg', 'mixamorigLeftFoot', 'mixamorigLeftToeBase',
  'mixamorigRightUpLeg', 'mixamorigRightLeg', 'mixamorigRightFoot', 'mixamorigRightToeBase',
])

// ── 蒙皮：整身顶点世界坐标 ──
function skinAll(joints: JointRotations): Float32Array {
  applyRigPose({ bones: fx.bones, zSign: ZS } as never, joints)
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

/**
 * 目标部位的面片索引。
 *
 * 门槛取「三个顶点里**至少两个**属于目标部位」而不是全部三个：全部门槛会在
 * 主导骨切换处留下**一条空洞带**（比如大腿上表面靠近腹股沟，顶点主导骨从
 * UpLeg 变成 Hips），射线打过去会穿过空洞量到更远的表面，内外判定直接失真。
 * 放宽一环把空洞推到体外，表面才连续。
 */
function targetIndices(): Uint32Array {
  const set = new Set<number>()
  for (let i = 0; i < fx.position.count; i++) if (TARGET_BONES.has(dominantOf(i))) set.add(i)
  const out: number[] = []
  for (let t = 0; t < fx.index.length; t += 3) {
    const a = fx.index[t], b = fx.index[t + 1], c = fx.index[t + 2]
    const hits = (set.has(a) ? 1 : 0) + (set.has(b) ? 1 : 0) + (set.has(c) ? 1 : 0)
    if (hits >= 2) out.push(a, b, c)
  }
  return Uint32Array.from(out)
}
const TARGET_IDX = targetIndices()

const BIND_NORMALS = (() => {
  const n = new Float32Array(fx.position.count * 3)
  for (let i = 0; i < fx.position.count; i++) {
    n[i * 3] = fx.normal.getX(i); n[i * 3 + 1] = fx.normal.getY(i); n[i * 3 + 2] = fx.normal.getZ(i)
  }
  return n
})()

/** 全身闭合网格（奇偶判内外用；目标区域是开口面片，闭合网格才有无歧义的内外）。 */
const BODY_IDX = Uint32Array.from(fx.index)

const boneAt = (bone: string) => fx.byName.get(bone)!.getWorldPosition(new THREE.Vector3())

/** 命中面属于哪一段（射线归属判定：轴心在腿里，射线朝上命中的是腿表面）。 */
const boneOfFace = (f: number): string => dominantOf(TARGET_IDX[f * 3])

/** 体段碰撞体（大腿/小腿/躯干）。 */
function buildColliders(surface: CollisionSurface): BodyPartCollider[] {
  const is = (...names: string[]) => (f: number) => names.includes(boneOfFace(f))
  return [
    new BodyPartCollider('左大腿', boneAt('mixamorigLeftUpLeg'), boneAt('mixamorigLeftLeg'), surface, is('mixamorigLeftUpLeg')),
    new BodyPartCollider('右大腿', boneAt('mixamorigRightUpLeg'), boneAt('mixamorigRightLeg'), surface, is('mixamorigRightUpLeg')),
    new BodyPartCollider('左小腿', boneAt('mixamorigLeftLeg'), boneAt('mixamorigLeftFoot'), surface, is('mixamorigLeftLeg')),
    new BodyPartCollider('右小腿', boneAt('mixamorigRightLeg'), boneAt('mixamorigRightFoot'), surface, is('mixamorigRightLeg')),
    new BodyPartCollider('躯干', boneAt('mixamorigHips'), boneAt('mixamorigSpine3'), surface, is('mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigSpine3')),
  ]
}

// ── 静息手系（绑定姿态）──
interface RestData { wrist: THREE.Vector3; frame: HandFrame; handLen: number }
function restHand(side: 'Left' | 'Right'): RestData {
  const wrist = fx.byName.get(`mixamorig${side}Hand`)!.getWorldPosition(new THREE.Vector3())
  const handVerts = vertIdxOf((b) => b === `mixamorig${side}Hand` || b === `mixamorig${side}HandEnd`)
  // 指尖 = 离腕最远的那批顶点的质心。
  // ⚠ 不能用 HandEnd 骨的顶点：实测它离腕只有 3.5cm（不是指尖），
  //   拿它算手轴会让「手的方向」变成任意方向，掌心法向判定随之全废。
  const distOf = (i: number) =>
    new THREE.Vector3(fx.position.getX(i), fx.position.getY(i), fx.position.getZ(i)).distanceTo(wrist)
  const handLen = Math.max(...handVerts.map(distOf))
  const tipVerts = handVerts.filter((i) => distOf(i) > handLen * 0.8)
  const tips = new THREE.Vector3()
  for (const i of tipVerts) tips.add(new THREE.Vector3(fx.position.getX(i), fx.position.getY(i), fx.position.getZ(i)))
  tips.multiplyScalar(1 / Math.max(1, tipVerts.length))
  const forward = tips.clone().sub(wrist).normalize()
  // 掌心法向：取「法向指向身体中线」的那半边顶点的法线均值（A-pose 的掌心朝体侧）
  const medial = new THREE.Vector3(-Math.sign(wrist.x) || -1, 0, 0)
  const sideAxis = new THREE.Vector3().crossVectors(forward, medial).normalize()
  const axisNormal = new THREE.Vector3().crossVectors(forward, sideAxis).normalize()
  const acc = new THREE.Vector3()
  for (const i of handVerts) {
    const p = new THREE.Vector3(fx.position.getX(i), fx.position.getY(i), fx.position.getZ(i))
    const along = p.clone().sub(wrist).dot(forward)
    if (along < handLen * 0.3 || along > handLen * 0.75) continue
    const off = p.clone().sub(wrist.clone().addScaledVector(forward, along))
    if (off.length() > 0.035) continue
    const nrm = new THREE.Vector3(fx.normal.getX(i), fx.normal.getY(i), fx.normal.getZ(i))
    if (nrm.dot(axisNormal) <= 0) continue
    acc.add(nrm)
  }
  const palmNormal = acc.lengthSq() > 1e-12 ? acc.normalize() : axisNormal.clone()
  return { wrist, frame: makeHandFrame(forward, palmNormal), handLen }
}
const REST: Record<'Left' | 'Right', RestData> = { Left: restHand('Left'), Right: restHand('Right') }

// ── 评价：穿深 + 手-腿间隙 ──
//
// 判据（两法交叉，各司其职）：
//   · **内外**：在**闭合的全身网格**上做射线奇偶穿越计数（不看面朝向，无洞歧义）。
//     查询点先沿固定方向偏移 0.5mm（顶点本来就在体表上，直接打射线会有歧义）。
//   · **深浅**：到「躯干+腿」这一目标区域的**无符号距离**（目标区域是开口面片，
//     法线定向在边界不可靠，所以只用它的距离大小，不用它的符号）。
// 两者合起来：奇数穿越 = 点在人体内 = 穿深 = 那个距离。
const OFFSET = new THREE.Vector3(0.0009, 0.0004, 0.0007)

interface Eval {
  pen: number
  worst: string
  gap: number
}
function evaluate(
  posed: Float32Array, colliders: BodyPartCollider[],
  armIdx: number[], palmIdx: number[], thigh: BodyPartCollider,
): Eval {
  const p = new THREE.Vector3()
  let pen = 0, worst = '', gap = Infinity
  for (const i of armIdx) {
    p.set(posed[i * 3], posed[i * 3 + 1], posed[i * 3 + 2])
    for (const c of colliders) {
      const d = c.depth(p)
      if (d > pen) { pen = d; worst = `#${i}(${dominantOf(i)})→${c.name}` }
    }
  }
  for (let k = 0; k < palmIdx.length; k += 4) {
    const i = palmIdx[k]
    p.set(posed[i * 3], posed[i * 3 + 1], posed[i * 3 + 2])
    const g = thigh.gap(p)
    if (g < gap) gap = g
  }
  return { pen, worst, gap }
}

// ── 大腿局部坐标系 ──
interface ThighFrame {
  axis: THREE.Vector3
  len: number
  up: THREE.Vector3
  outward: THREE.Vector3
}
function thighFrame(side: 'Left' | 'Right'): ThighFrame {
  const hip = boneAt(`mixamorig${side}UpLeg`)
  const knee = boneAt(`mixamorig${side}Leg`)
  const axis = knee.clone().sub(hip)
  const len = axis.length()
  axis.normalize()
  const up = new THREE.Vector3(0, 1, 0).addScaledVector(axis, -axis.y)
  const outward = new THREE.Vector3(Math.sign(hip.x) || 1, 0, 0).addScaledVector(axis, -axis.x * (Math.sign(hip.x) || 1))
  return { axis, len, up: up.normalize(), outward: outward.normalize() }
}

// ── IK + 搜索 ──
interface ArmSolve {
  shoulder: { x: number; y: number; z: number }
  elbow: { x: number; y: number; z: number }
  wrist: { x: number; y: number; z: number }
  score: number
  info: string
  eval: Eval
}

function solveArm(poseId: string, side: 'Left' | 'Right', verbose = false): ArmSolve | null {
  const base = normalizePose(poseJoints(poseId))
  const sfx = side === 'Left' ? 'shoulderL' : 'shoulderR'
  const efx = side === 'Left' ? 'elbowL' : 'elbowR'
  const wfx = side === 'Left' ? 'wristL' : 'wristR'

  // 腿/躯干固定 → 目标表面与碰撞体只算一次
  const legPose: JointRotations = { ...base }
  legPose[sfx] = { x: 0, y: 0, z: 0 }
  legPose[efx] = { x: 0, y: 0, z: 0 }
  legPose[wfx] = { x: 0, y: 0, z: 0 }
  const posedBase = skinAll(legPose)
  const surface = new CollisionSurface({ positions: posedBase, indices: TARGET_IDX, bindNormals: BIND_NORMALS })
  const colliders = buildColliders(surface)
  const thigh = colliders.find((c) => c.name === (side === 'Left' ? '左大腿' : '右大腿'))!
  const tf = thighFrame(side)
  const armIdx = armVertsOf(side)
  const palmIdx = palmVertsOf(side)

  const shoulderBone = fx.byName.get(`mixamorig${side}Arm`)!
  const foreBone = fx.byName.get(`mixamorig${side}ForeArm`)!
  const handBone = fx.byName.get(`mixamorig${side}Hand`)!
  const upperOffset = foreBone.position.clone()
  const foreOffset = handBone.position.clone()
  const rest = REST[side]
  let best: ArmSolve | null = null

  const Ts = [0.24, 0.32, 0.40, 0.48]
  // 间隙下限 1.5cm：手掌厚约 2cm，且指尖离腕 18cm 处大腿面已下垂，
  // 腕只贴面的话指尖会扎进腿面（实测穿深 27mm）。
  const gaps = (process.env.GAPS ?? '0.015,0.025,0.035,0.045').split(',').map((v) => Number(v))
  const radials = [5, 18, 32].map((d) => d * Math.PI / 180)
  const poleYaws = [-25, 0, 25].map((d) => d * Math.PI / 180)
  const tilts = [-10, 0, 10].map((d) => d * Math.PI / 180)

  for (const t of Ts) {
    for (const gap of gaps) {
      for (const radial of radials) {
        for (const yaw of poleYaws) {
          for (const tilt of tilts) {
            // 腕目标：腿面上一点（沿轴 t，径向从「上」朝「外」偏），离面 gap
            const radialDir = tf.up.clone().applyAxisAngle(tf.axis, radial * (side === 'Left' ? 1 : -1))
            const surf = thigh.surfaceAlong(t, radialDir)
            if (surf === null) continue
            const target = surf.point.clone().addScaledVector(radialDir, gap)

            // 肘朝向提示：向后（-z）+ 略向下 + 偏外
            const pole = new THREE.Vector3(Math.sign(tf.outward.x) * 0.35, -0.35, -1).normalize()
              .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)

            const chain = {
              shoulderPos: shoulderBone.getWorldPosition(new THREE.Vector3()),
              parentQuat: shoulderBone.parent!.getWorldQuaternion(new THREE.Quaternion()),
              upperOffset, foreOffset,
            }
            const ik: TwoBoneSolution = solveTwoBone(chain, target, pole)
            if (!ik.reached) continue

            // 手掌朝向：指尖顺着大腿向前下，掌心贴腿面
            const desired = makeHandFrame(
              tf.axis.clone().applyAxisAngle(tf.outward, tilt * (side === 'Left' ? 1 : -1)),
              radialDir.clone().negate(),
            )
            const elbowWorld = chain.parentQuat.clone().multiply(ik.shoulderLocal).multiply(ik.elbowLocal)
            const wristQuat = solveHandOrientation(rest.frame, desired, elbowWorld)

            const joints: JointRotations = { ...base }
            joints[sfx] = localQuatToPoseEuler(ik.shoulderLocal, ZS)
            joints[efx] = localQuatToPoseEuler(ik.elbowLocal, ZS)
            joints[wfx] = localQuatToPoseEuler(wristQuat, ZS)

            const posed = skinAll(joints)
            const ev = evaluate(posed, colliders, armIdx, palmIdx, thigh)

            // 目标函数：零穿深是硬约束；手要贴面；肘要自然（靠后）
            const elbowBack = new THREE.Vector3().subVectors(ik.elbowPos, chain.shoulderPos).dot(new THREE.Vector3(0, 0, -1))
            const score =
              ev.pen * 1000 +
              Math.max(0, ev.gap - 0.006) * 60 +
              Math.max(0, 0.05 - ev.gap) * 40 +
              Math.max(0, 0.12 - elbowBack) * 20
            const info = `t=${t} gap=${gap * 1000}mm 偏=${(radial * 180 / Math.PI).toFixed(0)}° 肘偏航=${(yaw * 180 / Math.PI).toFixed(0)}° ` +
              `倾=${(tilt * 180 / Math.PI).toFixed(0)}° | 穿深=${(ev.pen * 1000).toFixed(1)}mm 手间隙=${(ev.gap * 1000).toFixed(1)}mm 肘后=${(elbowBack * 100).toFixed(0)}cm`
            if (verbose) console.log(`  ${score.toFixed(3)} ${info}`)
            if (best === null || score < best.score) {
              best = { shoulder: joints[sfx], elbow: joints[efx], wrist: joints[wfx], score, info, eval: ev }
            }
          }
        }
      }
    }
  }
  return best
}

// ── 命令 ──
const mode = process.argv[2] ?? 'check'

if (mode === 'check') {
  const poseIds = process.argv.length > 3
    ? process.argv.slice(3)
    : ['a-pose', 't-pose', 'stand', 'hands-on-hips', 'walk', 'run', 'sit', 'kneel']
  for (const pid of poseIds) {
    const joints = normalizePose(poseJoints(pid))
    const posed = skinAll(joints)
    const surface = new CollisionSurface({ positions: posed, indices: TARGET_IDX, bindNormals: BIND_NORMALS })
    const colliders = buildColliders(surface)
    let report = ''
    for (const side of ['Left', 'Right'] as const) {
      const ev = evaluate(posed, colliders, armVertsOf(side), palmVertsOf(side), colliders.find((c) => c.name === (side === 'Left' ? '左大腿' : '右大腿'))!)
      report += ` ${side}: 穿深=${(ev.pen * 1000).toFixed(1)}mm(${ev.worst}) 手-腿间隙=${(ev.gap * 1000).toFixed(1)}mm`
    }
    console.log(`[check] ${pid}${report}`)
  }
} else if (mode === 'solve') {
  const poseId = process.argv[3] ?? 'sit'
  const side = (process.argv[4] ?? 'L') === 'L' ? 'Left' : 'Right'
  console.log(`[solve] ${poseId} ${side}`)
  const best = solveArm(poseId, side, process.env.VERBOSE === '1')
  if (best === null) { console.log('  无解'); process.exit(1) }
  console.log(`  最优 ${best.info}`)
  const s = side === 'Left' ? 'L' : 'R'
  console.log(`  shoulder${s}: { x: ${best.shoulder.x.toFixed(3)}, y: ${best.shoulder.y.toFixed(3)}, z: ${best.shoulder.z.toFixed(3)} },`)
  console.log(`  elbow${s}: { x: ${best.elbow.x.toFixed(3)}, y: ${best.elbow.y.toFixed(3)}, z: ${best.elbow.z.toFixed(3)} },`)
  console.log(`  wrist${s}: { x: ${best.wrist.x.toFixed(3)}, y: ${best.wrist.y.toFixed(3)}, z: ${best.wrist.z.toFixed(3)} },`)
} else if (mode === 'debug') {
  const poseId = process.argv[3] ?? 'sit'
  const side = (process.argv[4] === 'R' ? 'Right' : 'Left') as 'Left' | 'Right'
  const joints = normalizePose(poseJoints(poseId))
  const posed = skinAll(joints)
  const surface = new CollisionSurface({ positions: posed, indices: TARGET_IDX, bindNormals: BIND_NORMALS })
  const colliders = buildColliders(surface)
  const thigh = colliders.find((c) => c.name === (side === 'Left' ? '左大腿' : '右大腿'))!
  const fmt = (v: THREE.Vector3) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`
  for (const s of ['Left', 'Right'] as const) {
    console.log(`  ${s} 髋${fmt(boneAt(`mixamorig${s}UpLeg`))} 膝${fmt(boneAt(`mixamorig${s}Leg`))} 踝${fmt(boneAt(`mixamorig${s}Foot`))}`)
    console.log(`      肩${fmt(boneAt(`mixamorig${s}Arm`))} 肘${fmt(boneAt(`mixamorig${s}ForeArm`))} 腕${fmt(boneAt(`mixamorig${s}Hand`))}`)
  }
  const ev = evaluate(posed, colliders, armVertsOf(side), palmVertsOf(side), colliders.find((c) => c.name === (side === 'Left' ? '左大腿' : '右大腿'))!)
  console.log(`  ${side} 穿深=${(ev.pen * 1000).toFixed(1)}mm (${ev.worst}) 手-腿间隙=${(ev.gap * 1000).toFixed(1)}mm`)
  // 射线自检：从髋关节向上打，应命中大腿上表面（约 10cm）
  const hip = boneAt(`mixamorig${side}UpLeg`)
  for (const [label, dir] of [['上', new THREE.Vector3(0, 1, 0)], ['前', new THREE.Vector3(0, 0, 1)]] as [string, THREE.Vector3][]) {
    const hit = surface.raycast(hip, dir, 1.0)
    console.log(`  自检 从${label}髋 ${fmt(hip)} 打${label} → ${hit === null ? '无命中' : `${(hit.distance * 100).toFixed(1)}cm 到 ${fmt(hit.point)}`}`)
  }
  console.log(`  目标面片数 ${TARGET_IDX.length / 3}`)
  {
    const cellsOf = (surface as unknown as { rayCells(p: THREE.Vector3, d: THREE.Vector3): number[][] }).rayCells(hip, new THREE.Vector3(0, 1, 0))
    const cells = (surface as unknown as { cells: Map<number, number[]>; cellKey(x: number, y: number, z: number): number }).cells
    const keyOf = (surface as unknown as { cellKey(x: number, y: number, z: number): number }).cellKey
    console.log(`  射线经过格数 ${cellsOf.length}，前 8 格的面片数：`)
    for (const c of cellsOf.slice(0, 8)) console.log(`    格 ${c.join(',')} → ${cells.get(keyOf(c[0], c[1], c[2]))?.length ?? 0} 片`)
  }
  const anySurf = surface as unknown as { cells: Map<number, number[]>; gridMin: THREE.Vector3; gridDim: THREE.Vector3; cellSize: number; cellIndex(p: THREE.Vector3): THREE.Vector3; cellKey(x: number, y: number, z: number): number }
  console.log(`  占用格数 ${anySurf.cells.size} 网格原点 ${fmt(anySurf.gridMin)} 维度 ${fmt(anySurf.gridDim)} 格长 ${anySurf.cellSize}`)
  const hc = anySurf.cellIndex(hip)
  const hk = anySurf.cellKey(hc.x, hc.y, hc.z)
  console.log(`  髋所在格 ${hc.toArray().join(',')} key=${hk} 该格面片数 ${anySurf.cells.get(hk)?.length ?? 0}`)
  for (let f = 0; f < 3; f++) {
    const ia = TARGET_IDX[f * 3], ib = TARGET_IDX[f * 3 + 1], ic = TARGET_IDX[f * 3 + 2]
    console.log(`  面${f} 顶点 ${fmt(new THREE.Vector3(posed[ia * 3], posed[ia * 3 + 1], posed[ia * 3 + 2]))} ${fmt(new THREE.Vector3(posed[ib * 3], posed[ib * 3 + 1], posed[ib * 3 + 2]))} ${fmt(new THREE.Vector3(posed[ic * 3], posed[ic * 3 + 1], posed[ic * 3 + 2]))}`)
  }
  // 大腿表面剖面（沿轴 0.1..0.9 打射线）
  const tf = thighFrame(side)
  for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    const hit = thigh.surfaceAlong(t, tf.up)
    if (hit !== null) console.log(`  大腿 t=${t} 顶面 ${fmt(hit.point)} 距离 ${(hit.distance * 100).toFixed(1)}cm`)
  }
} else {
  console.log('用法：check [poseId...] | solve <poseId> <L|R> | debug <poseId> [L|R]')
}

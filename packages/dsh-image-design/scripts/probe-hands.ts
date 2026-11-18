// 手部姿态体检：每个姿势里左右手的朝向、腕屈角、指尖张开度。
//
// 为什么单独量：碰撞审计只看「有没有插进去」，看不出「像不像手」——
// 用户的实机反馈是坐姿的手像爪子（爪形手），数值上「无穿插、gap 4.6mm」却是错的。
// 爪形手有两个来源：① 基础网格的手指本来就张开（资产问题，已在构建脚本 4d 段收拢）；
// ② 腕屈角过大（姿势问题，本脚本量出来）。
//
// 口径：骨世界坐标单位 = m，输出统一转 cm。
// 指尖层 = 绑定姿态里沿手轴 > 60% 手长的顶点（手的顶点由主导骨 Hand/HandEnd 判定）。
//
// 用法：node --experimental-strip-types scripts/probe-hands.ts [poseId…]

import * as THREE from 'three'
import { loadRigFixture } from '../tests/helpers/rig-fixture.ts'
import { applyRigPose, type RigBinding, type SkinSample } from '../src/client/mannequin/rig.ts'
import { poseJoints, type JointRotations } from '../src/client/mannequin/poses.ts'

const fx = loadRigFixture()
const binding = { bones: fx.bones, zSign: fx.zSign } as unknown as RigBinding
const sample: SkinSample = {
  position: fx.position, skinIndex: fx.skinIndex, skinWeight: fx.skinWeight,
  bones: fx.boneList, boneInverses: fx.boneInverses,
}
const CM = 100
const DEG = 180 / Math.PI

/** 顶点主导骨名。 */
function dominantBone(i: number): string {
  let bw = 0, bj = 0
  for (let k = 0; k < 4; k++) {
    const w = fx.skinWeight.getComponent(i, k)
    if (w > bw) { bw = w; bj = fx.skinIndex.getComponent(i, k) }
  }
  return fx.boneList[bj]?.name ?? ''
}

// ── 绑定姿态的手部基准（必须在任何姿势应用之前抓）────────────────────────
interface HandBase {
  /** 绑定姿态腕骨世界位置。 */
  wrist: THREE.Vector3
  /** 绑定姿态手轴（腕→指尖层质心）。 */
  axis: THREE.Vector3
  /** 绑定姿态手长（腕→指尖层最远点）。 */
  len: number
  /** 指尖层顶点索引。 */
  tipIdx: number[]
  /** 全部手部顶点索引（用于算掌的横向）。 */
  allIdx: number[]
}

const BASES = new Map<string, HandBase>()
for (const side of ['Left', 'Right'] as const) {
  const handName = `mixamorig${side}Hand`
  const endName = `mixamorig${side}HandEnd`
  const wrist = fx.byName.get(handName)!.getWorldPosition(new THREE.Vector3())
  const allIdx: number[] = []
  for (let i = 0; i < fx.position.count; i++) {
    const nm = dominantBone(i)
    if (nm === handName || nm === endName) allIdx.push(i)
  }
  // 绑定姿态的手轴：用腕→该手所有顶点的最远方向（比 HandEnd 骨可靠）
  let far = wrist.clone(), farD = 0
  for (const i of allIdx) {
    const p = new THREE.Vector3(fx.position.getX(i), fx.position.getY(i), fx.position.getZ(i))
    const d = p.distanceTo(wrist)
    if (d > farD) { farD = d; far = p }
  }
  const axis = far.clone().sub(wrist).normalize()
  const tipIdx: number[] = []
  for (const i of allIdx) {
    const p = new THREE.Vector3(fx.position.getX(i), fx.position.getY(i), fx.position.getZ(i))
    if (p.clone().sub(wrist).dot(axis) > farD * 0.6) tipIdx.push(i)
  }
  BASES.set(side, { wrist, axis, len: farD, tipIdx, allIdx })
}

/** 全量蒙皮（世界坐标，m）。 */
function skinAll(joints: JointRotations): Float32Array {
  applyRigPose(binding, joints)
  fx.root.updateMatrixWorld(true)
  const { position, skinIndex, skinWeight, boneList, boneInverses } = fx
  const out = new Float32Array(position.count * 3)
  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    const px = position.getX(i), py = position.getY(i), pz = position.getZ(i)
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k)
      if (w === 0) continue
      const b = skinIndex.getComponent(i, k)
      const bone = boneList[b]
      if (bone === undefined) continue
      m.multiplyMatrices(bone.matrixWorld, boneInverses[b])
      v.set(px, py, pz).applyMatrix4(m)
      x += w * v.x; y += w * v.y; z += w * v.z
    }
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z
  }
  return out
}

const at = (name: string): THREE.Vector3 =>
  fx.byName.get(name)!.getWorldPosition(new THREE.Vector3())

interface HandInfo {
  wrist: THREE.Vector3
  tip: THREE.Vector3
  axis: THREE.Vector3
  wristDeg: number
  spread: number
  tipCount: number
}

function handInfo(skinned: Float32Array, side: 'Left' | 'Right'): HandInfo {
  const base = BASES.get(side)!
  const wrist = at(`mixamorig${side}Hand`).clone()
  const elbow = at(`mixamorig${side}ForeArm`).clone()
  const tip = new THREE.Vector3()
  for (const i of base.tipIdx) tip.add(new THREE.Vector3(skinned[i * 3], skinned[i * 3 + 1], skinned[i * 3 + 2]))
  tip.multiplyScalar(1 / Math.max(1, base.tipIdx.length))
  const axis = tip.clone().sub(wrist).normalize()
  // 指尖横向张开：垂直手轴的平面上，指尖层的最大点间距
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(axis.dot(u)) > 0.9) u.set(0, 0, 1)
  const e1 = new THREE.Vector3().crossVectors(axis, u).normalize()
  const e2 = new THREE.Vector3().crossVectors(axis, e1).normalize()
  const rows = base.tipIdx.map((i) => new THREE.Vector3(skinned[i * 3], skinned[i * 3 + 1], skinned[i * 3 + 2]))
  let spread = 0
  for (let a = 0; a < rows.length; a++) {
    for (let b = a + 1; b < rows.length; b++) {
      const da = rows[a].clone().sub(wrist)
      const db = rows[b].clone().sub(wrist)
      const d = Math.hypot(da.dot(e1) - db.dot(e1), da.dot(e2) - db.dot(e2))
      if (d > spread) spread = d
    }
  }
  const fore = wrist.clone().sub(elbow).normalize()
  const wristDeg = Math.acos(Math.max(-1, Math.min(1, fore.dot(axis)))) * DEG
  return { wrist, tip, axis, wristDeg, spread, tipCount: base.tipIdx.length }
}

/** 大腿轴（髋→膝）与大腿面「上」方向。 */
function thighInfo(side: 'Left' | 'Right') {
  const hip = at(`mixamorig${side}UpLeg`).clone()
  const knee = at(`mixamorig${side}Leg`).clone()
  const dir = knee.clone().sub(hip).normalize()
  const upRef = new THREE.Vector3(0, 1, 0)
  const up = upRef.clone().addScaledVector(dir, -upRef.dot(dir)).normalize()
  return { hip, knee, dir, up }
}

const args = process.argv.slice(2)
const poses = args.length > 0 ? args : ['a-pose', 't-pose', 'stand', 'hands-on-hips', 'walk', 'run', 'sit', 'kneel']

for (const poseId of poses) {
  const sk = skinAll(poseJoints(poseId))
  const out: string[] = []
  for (const side of ['Left', 'Right'] as const) {
    const h = handInfo(sk, side)
    const t = thighInfo(side)
    // 手轴与大腿轴的夹角（度）：手掌顺着大腿放 ≈ 0°，垂直插下去 ≈ 90°
    const thighDot = Math.acos(Math.max(-1, Math.min(1, h.axis.dot(t.dir)))) * DEG
    // 指尖在大腿轴上距髋多远 + 离大腿面多高（cm）
    const rel = h.tip.clone().sub(t.hip)
    const s = rel.dot(t.dir)
    const upH = rel.clone().addScaledVector(t.dir, -s).dot(t.up)
    out.push(
      `${side === 'Left' ? '左' : '右'} 腕屈=${h.wristDeg.toFixed(0)}° 张开=${(h.spread * CM).toFixed(1)}cm` +
      ` 腕=(${ (h.wrist.x*CM).toFixed(0)},${(h.wrist.y*CM).toFixed(0)},${(h.wrist.z*CM).toFixed(0)})` +
      ` 指尖=(${ (h.tip.x*CM).toFixed(0)},${(h.tip.y*CM).toFixed(0)},${(h.tip.z*CM).toFixed(0)})` +
      ` 手轴·大腿轴=${thighDot.toFixed(0)}° 沿腿=${(s*CM).toFixed(0)}cm 离面=${(upH*CM).toFixed(1)}cm`,
    )
  }
  console.log(`── ${poseId} ──`)
  for (const line of out) console.log('  ' + line)
}

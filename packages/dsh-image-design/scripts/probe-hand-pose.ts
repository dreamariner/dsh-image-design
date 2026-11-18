// 手部姿势量化器（issue 005）：把「手扭没扭 / 穿没穿模」变成数字。
//
// 用法（包目录下）：
//   node --experimental-strip-types scripts/probe-hand-pose.ts          8 个预设
//   node --experimental-strip-types scripts/probe-hand-pose.ts --drag   拖动场景
//
// 每行报：落定 / 腕屈角（手轴与前臂轴的几何夹角，>40° = 耙子手）/ 掌心朝向 /
// 网格穿插（poseContactJoints 审计，按部位拆）/ 指尖贴面距（指尖到体表的距离）。
// 判据出处：docs/issues/005 的腕屈 40° 上限与穿深 ≤8mm 门禁。
// 手部量具全部基于网格顶点（HM08 没有手指骨，手指顶点都挂在 Hand 上）。
import * as THREE from 'three'
import { loadRigFixture } from '../tests/helpers/rig-fixture.ts'
import { createSolverHostFixture } from '../tests/helpers/solver-host.ts'
import { poseContactJoints, skinPositions, dominantBone } from '../tests/helpers/pose-contact.ts'
import { computeBodyMetrics, poseTargets, TARGET_PRESET_IDS } from '../src/client/mannequin/targets.ts'
import { PoseSolver, type PoseTargets, type JointRotations } from '../src/client/mannequin/solver.ts'

const fx = loadRigFixture()
const { host } = createSolverHostFixture(fx)
const metrics = computeBodyMetrics((n) => fx.bindWorld.get(n)?.clone() ?? new THREE.Vector3())

/** 解一个目标（规范复位 → 落定），留下关节表供各量具用。 */
let joints: JointRotations = {}
function solve(t: PoseTargets): boolean {
  const solver = new PoseSolver(host)
  solver.setTargets(t)
  const r = solver.settle()
  joints = r.joints
  return r.settled
}

const boneAt = (b: string) => fx.byName.get(b)!.getWorldPosition(new THREE.Vector3())

/** 某侧手的主导顶点（姿势坐标）。 */
function handVerts(side: 'Left' | 'Right'): THREE.Vector3[] {
  const posed = skinPositions(fx, joints)
  const out: THREE.Vector3[] = []
  for (let i = 0; i < fx.position.count; i++) {
    if (dominantBone(fx, i) !== `mixamorig${side}Hand`) continue
    out.push(new THREE.Vector3(posed[i * 3], posed[i * 3 + 1], posed[i * 3 + 2]))
  }
  return out
}

/** 腕屈角（度）：前臂轴（肘→腕）与手轴（腕→最远手顶点 = 指尖）的几何夹角。 */
function wristFlexDeg(side: 'Left' | 'Right'): number {
  const elbow = boneAt(`mixamorig${side}ForeArm`)
  const wrist = boneAt(`mixamorig${side}Hand`)
  let far = wrist
  let farD = 0
  for (const v of handVerts(side)) {
    const d = v.distanceTo(wrist)
    if (d > farD) { farD = d; far = v }
  }
  const fore = wrist.clone().sub(elbow).normalize()
  const hand = far.clone().sub(wrist).normalize()
  return (Math.acos(Math.max(-1, Math.min(1, fore.dot(hand)))) * 180) / Math.PI
}

/** 手部顶点在垂直于手轴平面上的主展开方向（PCA 主轴，3D 向量）。 */
function spreadAxis(verts: THREE.Vector3[], u: THREE.Vector3): THREE.Vector3 {
  const c = new THREE.Vector3()
  for (const v of verts) c.add(v)
  c.multiplyScalar(1 / verts.length)
  const helper = Math.abs(u.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  const e1 = helper.clone().sub(u.clone().multiplyScalar(helper.dot(u))).normalize()
  const e2 = new THREE.Vector3().crossVectors(u, e1)
  let a = 0, b = 0, ab = 0
  for (const v of verts) {
    const r = v.clone().sub(c)
    const x = r.dot(e1)
    const y = r.dot(e2)
    a += x * x; b += y * y; ab += x * y
  }
  const theta = 0.5 * Math.atan2(2 * ab, a - b)
  return e1.multiplyScalar(Math.cos(theta)).addScaledVector(e2, Math.sin(theta)).normalize()
}

/** 掌心朝向（姿势系）：法线的「朝内 / 朝前」分量。法线 = 手轴 × 展开轴，
 * 全局符号用站姿校准（站立掌心朝体侧：左掌心 = −x）✓。 */
function palmFacing(side: 'Left' | 'Right'): string {
  const verts = handVerts(side)
  if (verts.length === 0) return '无顶点'
  const wrist = boneAt(`mixamorig${side}Hand`)
  let far = wrist
  let farD = 0
  for (const v of verts) {
    const d = v.distanceTo(wrist)
    if (d > farD) { farD = d; far = v }
  }
  const u = far.clone().sub(wrist).normalize()
  const w = spreadAxis(verts, u)
  let n = new THREE.Vector3().crossVectors(u, w)
  if (n.lengthSq() < 1e-9) return '退化'
  n.normalize()
  const inward = side === 'Left' ? -1 : 1
  if (n.x * inward > 0) n.negate()
  return `内${(n.x * inward).toFixed(2)} 前${n.z.toFixed(2)}`
}

/** 指尖贴面距（cm）：指尖带（沿手轴前 25%）到体段代理的最近有符号距离
 * （负 = 戳进体表）。悬手贴腿的姿势这里应是 +1~2cm。 */
function fingerGapCm(side: 'Left' | 'Right'): number {
  const verts = handVerts(side)
  if (verts.length === 0) return 0
  const wrist = boneAt(`mixamorig${side}Hand`)
  let farD = 0
  for (const v of verts) farD = Math.max(farD, v.distanceTo(wrist))
  const tips = verts.filter((v) => v.distanceTo(wrist) > farD * 0.75)
  let worst = Infinity
  for (const seg of host.segments()) {
    for (const v of tips) worst = Math.min(worst, seg.distance(v))
  }
  return worst === Infinity ? 0 : worst * 100
}

function line(name: string, settled: boolean): void {
  const contact = poseContactJoints(fx, joints)
  const parts = Object.entries(contact.byPart)
    .filter(([, v]) => v > 0.0005)
    .map(([k, v]) => `${k}${(v * 1000).toFixed(1)}`)
    .join(' ')
  console.log(
    `[${name.padEnd(16)}] 落定=${settled ? '是' : '否'} ` +
    `腕屈 L/R=${wristFlexDeg('Left').toFixed(0)}°/${wristFlexDeg('Right').toFixed(0)}° ` +
    `掌心 L=${palmFacing('Left')} 穿插=${(contact.maxPen * 1000).toFixed(1)}mm` +
    (parts === '' ? '' : ` (${parts})`) +
    ` 指尖贴面距 L/R=${fingerGapCm('Left').toFixed(1)}/${fingerGapCm('Right').toFixed(1)}cm`,
  )
}

if (!process.argv.includes('--drag')) {
  console.log('── 8 个预设：腕屈角 / 掌心朝向 / 手臂穿插 / 指尖贴面距 ──')
  for (const id of TARGET_PRESET_IDS) {
    const t = poseTargets(id, metrics)
    if (t === null) continue
    line(id, solve(t))
  }
} else {
  console.log('── 拖动场景（目标给到身体内部 / 够不着处 / 跨中线）──')
  const base = poseTargets('stand', metrics)!
  const thighMid = fx.bindWorld.get('mixamorigLeftUpLeg')!.clone()
    .lerp(fx.bindWorld.get('mixamorigLeftLeg')!, 0.5)
  const belly = fx.bindWorld.get('mixamorigSpine')!.clone()
  const scenarios: Array<{ name: string; t: PoseTargets }> = [
    {
      name: '手拖进左大腿',
      t: { ...base, effectors: { ...base.effectors, handL: { pos: { x: thighMid.x, y: thighMid.y, z: thighMid.z } } } },
    },
    {
      name: '手拖进腹部',
      t: { ...base, effectors: { ...base.effectors, handL: { pos: { x: belly.x, y: belly.y, z: belly.z } } } },
    },
    {
      name: '手拖到够不着的高处',
      t: { ...base, effectors: { ...base.effectors, handL: { pos: { x: 0.5, y: 2.2, z: 0.2 } } } },
    },
    {
      name: '手拖过中线',
      t: { ...base, effectors: { ...base.effectors, handL: { pos: { x: -0.2, y: 0.9, z: 0.25 } } } },
    },
    {
      name: '手拖到大腿面外 2cm',
      t: { ...base, effectors: { ...base.effectors, handL: { pos: { x: thighMid.x + 0.02, y: thighMid.y, z: thighMid.z } } } },
    },
  ]
  for (const sc of scenarios) line(sc.name, solve(sc.t))
}

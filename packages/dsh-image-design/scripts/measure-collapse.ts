// 关节塌陷量测：LBS（线性混合蒙皮）在大角度弯曲时的「糖果纸」效应。
//
// 现象：膝/肘弯曲 90° 时，关节附近顶点被两骨各拉一半 → 关节处体积塌掉，
// 膝盖看起来被「压扁」（用户实机反馈：坐姿膝盖压扁、不符合人体）。
//
// 量法（三个互补指标，都以绑定姿态为基准 = 1.0）：
//   · 体积比：关节邻域顶点的凸包体积（姿势态 / 绑定态）
//   · 半径比：关节邻域顶点到关节轴线的平均距离（姿势态 / 绑定态）
//   · 环距比：过关节中心、垂直于轴线的截面上，对角距离（姿势态 / 绑定态）
//
// 用法：node --experimental-strip-types scripts/measure-collapse.ts [poseId…]

import * as THREE from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'
import { loadRigFixture } from '../tests/helpers/rig-fixture.ts'
import { applyRigPose, type RigBinding } from '../src/client/mannequin/rig.ts'
import { poseJoints, type JointRotations } from '../src/client/mannequin/poses.ts'
import { BONE } from '../src/client/mannequin/body.ts'

const fixture = loadRigFixture()
const binding = { bones: fixture.bones, zSign: fixture.zSign } as unknown as RigBinding

/** 全量蒙皮（世界坐标）。 */
function skinAll(joints: JointRotations): Float32Array {
  applyRigPose(binding, joints)
  fixture.root.updateMatrixWorld(true)
  const { position, skinIndex, skinWeight, boneList, boneInverses } = fixture
  const n = position.count
  const out = new Float32Array(n * 3)
  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
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

/** 关节邻域的顶点集合（绑定姿态下距关节中心 < radius 的主导骨顶点）。 */
interface JointSpec {
  id: string
  /** 关节中心骨（弯折点） */
  center: string
  /** 参与的两根骨（近端 / 远端） */
  bones: [string, string]
  /** 远端骨子骨（轴线方向用） */
  distalChild: string
}

const JOINTS: JointSpec[] = [
  { id: 'kneeL', center: BONE.legL, bones: [BONE.upLegL, BONE.legL], distalChild: BONE.footL },
  { id: 'kneeR', center: BONE.legR, bones: [BONE.upLegR, BONE.legR], distalChild: BONE.footR },
  { id: 'elbowL', center: BONE.foreArmL, bones: [BONE.armL, BONE.foreArmL], distalChild: BONE.handL },
  { id: 'elbowR', center: BONE.foreArmR, bones: [BONE.armR, BONE.foreArmR], distalChild: BONE.handR },
]

const RADIUS = 0.11

/** 凸包体积（散度定理）。 */
function hullVolume(pts: THREE.Vector3[]): number {
  if (pts.length < 4) return 0
  let geo: THREE.BufferGeometry
  try {
    geo = new ConvexGeometry(pts)
  } catch {
    return 0
  }
  const pos = geo.getAttribute('position')
  const index = geo.getIndex()
  const n = index !== null ? index.count : pos.count
  let vol = 0
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let i = 0; i < n; i += 3) {
    const ia = index !== null ? index.getX(i) : i
    const ib = index !== null ? index.getX(i + 1) : i + 1
    const ic = index !== null ? index.getX(i + 2) : i + 2
    a.fromBufferAttribute(pos, ia); b.fromBufferAttribute(pos, ib); c.fromBufferAttribute(pos, ic)
    vol += a.dot(b.clone().cross(c)) / 6
  }
  geo.dispose()
  return Math.abs(vol)
}

/** 顶点到直线的距离（线过 a，方向 d）。 */
function distToLine(p: THREE.Vector3, a: THREE.Vector3, d: THREE.Vector3): number {
  const rel = p.clone().sub(a)
  const proj = rel.dot(d)
  return rel.clone().addScaledVector(d, -proj).length()
}

interface Metrics { vol: number; radius: number; span: number; area: number }

/** 2D 凸包面积（Andrew monotone chain）。 */
function hullArea2d(pts: Array<[number, number]>): number {
  if (pts.length < 3) return 0
  const p = [...pts].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Array<[number, number]> = []
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop()
    lower.push(pt)
  }
  const upper: Array<[number, number]> = []
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop()
    upper.push(pt)
  }
  lower.pop(); upper.pop()
  const h = [...lower, ...upper]
  let a2 = 0
  for (let i = 0; i < h.length; i++) {
    const j = (i + 1) % h.length
    a2 += h[i][0] * h[j][1] - h[j][0] * h[i][1]
  }
  return Math.abs(a2) / 2
}

/** 量一个关节邻域的塌陷指标（给定蒙皮结果 + 关节轴线）。 */
function measure(j: JointSpec, skinned: Float32Array, verts: number[], center: THREE.Vector3, axis: THREE.Vector3): Metrics {
  const pts: THREE.Vector3[] = []
  let rSum = 0
  let rMax = 0
  for (const vi of verts) {
    const p = new THREE.Vector3(skinned[vi * 3], skinned[vi * 3 + 1], skinned[vi * 3 + 2])
    pts.push(p)
    const d = distToLine(p, center, axis)
    rSum += d
    if (d > rMax) rMax = d
  }
  // 截面跨度：与轴线垂直方向上的最大顶点间距（投影到过中心的垂面）
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(axis.dot(u)) > 0.9) u.set(0, 0, 1)
  const e1 = new THREE.Vector3().crossVectors(axis, u).normalize()
  const e2 = new THREE.Vector3().crossVectors(axis, e1).normalize()
  let span = 0
  const proj: Array<[number, number]> = []
  for (let i = 0; i < pts.length; i++) {
    const ri = pts[i].clone().sub(center)
    const ai = ri.dot(e1), bi = ri.dot(e2)
    proj.push([ai, bi])
    for (let k = i + 1; k < pts.length; k++) {
      const rk = pts[k].clone().sub(center)
      const ak = rk.dot(e1), bk = rk.dot(e2)
      const d = Math.hypot(ai - ak, bi - bk)
      if (d > span) span = d
    }
  }
  const area2d = hullArea2d(proj)
  return { vol: hullVolume(pts), radius: rSum / Math.max(1, pts.length), span, area: area2d }
}

/** 找关节邻域顶点（绑定姿态下按主导骨 + 距中心距离筛）。 */
function bandVerts(j: JointSpec): number[] {
  const boneSet = new Set(j.bones)
  const obj = fixture.byName.get(j.center)
  if (obj === undefined) return []
  const c = obj.getWorldPosition(new THREE.Vector3())
  const out: number[] = []
  const { position, skinIndex, skinWeight, boneList } = fixture
  for (let i = 0; i < position.count; i++) {
    let bw = 0, bj = 0
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k)
      if (w > bw) { bw = w; bj = skinIndex.getComponent(i, k) }
    }
    const name = boneList[bj]?.name ?? ''
    if (!boneSet.has(name)) continue
    const dx = position.getX(i) - c.x, dy = position.getY(i) - c.y, dz = position.getZ(i) - c.z
    if (dx * dx + dy * dy + dz * dz > RADIUS * RADIUS) continue
    out.push(i)
  }
  return out
}

const bands = new Map<string, number[]>()
for (const j of JOINTS) bands.set(j.id, bandVerts(j))

// 绑定姿态基准
const bindSkin = skinAll(poseJoints('a-pose'))
const base = new Map<string, Metrics>()
for (const j of JOINTS) {
  const obj = fixture.byName.get(j.center)!
  const child = fixture.byName.get(j.distalChild)!
  const center = obj.getWorldPosition(new THREE.Vector3())
  const axis = child.getWorldPosition(new THREE.Vector3()).sub(center).normalize()
  base.set(j.id, measure(j, bindSkin, bands.get(j.id)!, center, axis))
}

const args = process.argv.slice(2)
const poseIds = args.length > 0 ? args : ['a-pose', 'stand', 'walk', 'run', 'sit', 'kneel']

console.log('关节塌陷比（1.0 = 与绑定姿态一致；<1 = 塌陷）')
for (const poseId of poseIds) {
  const sk = skinAll(poseJoints(poseId))
  const out: string[] = []
  for (const j of JOINTS) {
    const obj = fixture.byName.get(j.center)!
    const child = fixture.byName.get(j.distalChild)!
    const center = obj.getWorldPosition(new THREE.Vector3())
    const axis = child.getWorldPosition(new THREE.Vector3()).sub(center).normalize()
    const m = measure(j, sk, bands.get(j.id)!, center, axis)
    const b = base.get(j.id)!
    out.push(`${j.id}: 体积 ${(m.vol / b.vol).toFixed(2)} 半径 ${(m.radius / b.radius).toFixed(2)} 跨 ${(m.span / b.span).toFixed(2)} 截面 ${(m.area / b.area).toFixed(2)}`)
  }
  console.log(`  ${poseId.padEnd(10)} ${out.join('  |  ')}`)
}

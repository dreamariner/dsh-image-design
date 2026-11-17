// 素体人偶资产构建：MakeHuman 基础网格 → 自建骨架 + 蒙皮权重 → 带蒙皮的 GLB。
//
// 为什么自己建骨架：Mixamo 现成骨架绑的是「机械分段」人偶（X Bot），换成真人身体
// 后骨骼位置不再适用；MakeHuman 的 base.obj 里带 `joint-*` 辅助球，正好是解剖关节
// 标记，直接拿来摆骨。
//
// 资产出处（CC0，可商用）：
//   MakeHuman 基础网格 hm08，https://github.com/makehumancommunity/makehuman
//   commit a8bc2d54ff0ac92e78ff71431b1023eda42bf482
//   data/3dobjs/base.obj（文件头写明 2020 年 9 月以 CC0 释出）
//
// 流程：
//   1) 读 base.obj：只取 `body` 组的面（丢掉 helper-tights / 睫毛 / joint 辅助球）
//   2) 读 `joint-*` 组球心 → 骨架关节点
//   3) 建 27 根骨（平移静止姿态，局部旋转为单位阵）
//   4) 顶点→骨段距离权重（取前 4 根归一化，再做一次邻域平滑）
//   5) gltf-transform 写 GLB：POSITION / NORMAL / JOINTS_0 / WEIGHTS_0 + skin
//
// 用法：node scripts/build-mannequin-body.mjs [in.obj] [out.glb]

import { Document, NodeIO, VertexLayout } from '@gltf-transform/core'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const inPath = process.argv[2] ?? join(here, '..', 'assets', 'makehuman-base.obj')
const outPath = process.argv[3] ?? join(here, '..', 'assets', 'mannequin-body.glb')

if (!existsSync(inPath)) {
  console.error(`找不到源网格：${inPath}\n用 scripts/fetch-makehuman-base.mjs 拉取。`)
  process.exit(1)
}

// ── 1) 解析 OBJ ────────────────────────────────────────────────────────────
const verts = []
const faces = []
const jointGroups = new Map()
let group = ''
for (const line of readFileSync(inPath, 'utf8').split('\n')) {
  if (line.startsWith('g ')) {
    group = line.trim().slice(2)
    if (group.startsWith('joint-') && !jointGroups.has(group)) jointGroups.set(group, [])
  } else if (line.startsWith('v ')) {
    const p = line.trim().split(/\s+/)
    verts.push([Number(p[1]), Number(p[2]), Number(p[3])])
  } else if (line.startsWith('f ')) {
    if (group === 'body') {
      const idx = line.trim().split(/\s+/).slice(1).map((t) => Number(t.split('/')[0]) - 1)
      for (let i = 1; i + 1 < idx.length; i++) faces.push([idx[0], idx[i], idx[i + 1]])
    } else if (group.startsWith('joint-')) {
      for (const t of line.trim().split(/\s+/).slice(1)) jointGroups.get(group).push(Number(t.split('/')[0]) - 1)
    }
  }
}
if (verts.length === 0 || faces.length === 0) throw new Error('OBJ 解析为空')
console.log(`[build] 顶点 ${verts.length} / 三角面 ${faces.length}`)

// ── 2) 关节地标（joint-* 球心）─────────────────────────────────────────────
const landmarks = new Map()
for (const [name, ids] of jointGroups) {
  if (ids.length === 0) continue
  const c = [0, 0, 0]
  for (const i of ids) { c[0] += verts[i][0]; c[1] += verts[i][1]; c[2] += verts[i][2] }
  landmarks.set(name, c.map((v) => v / ids.length))
}
const lm = (name) => {
  const p = landmarks.get(name)
  if (p === undefined) throw new Error(`缺少关节地标：${name}`)
  return p
}

// ── 3) 骨架定义（MakeHuman 单位 = 分米；角色左 = +x，面朝 +z）───────────────
//   名称沿用 mixamorig 风格（与既有 rig.ts 的语义一致），但静止姿态是 A-pose（手臂
//   自然下垂约 40°），所以不再需要「落臂补偿」。
const DM = 0.1 // 分米 → 米
/** 骨：名称 / 父骨 / 关节点来源（local = 相对父骨的偏移量纲为绝对坐标） */
const BONES = [
  { name: 'mixamorigHips', parent: null, at: lm('joint-pelvis') },
  { name: 'mixamorigSpine', parent: 'mixamorigHips', at: lm('joint-spine-4') },
  { name: 'mixamorigSpine1', parent: 'mixamorigSpine', at: lm('joint-spine-3') },
  { name: 'mixamorigSpine2', parent: 'mixamorigSpine1', at: lm('joint-spine-2') },
  { name: 'mixamorigSpine3', parent: 'mixamorigSpine2', at: lm('joint-spine-1') },
  { name: 'mixamorigNeck', parent: 'mixamorigSpine3', at: lm('joint-neck') },
  { name: 'mixamorigHead', parent: 'mixamorigNeck', at: lm('joint-head') },
  { name: 'mixamorigHeadTop', parent: 'mixamorigHead', at: lm('joint-head-2') },
  { name: 'mixamorigLeftShoulder', parent: 'mixamorigSpine3', at: lm('joint-l-clavicle') },
  { name: 'mixamorigLeftArm', parent: 'mixamorigLeftShoulder', at: lm('joint-l-shoulder') },
  { name: 'mixamorigLeftForeArm', parent: 'mixamorigLeftArm', at: lm('joint-l-elbow') },
  { name: 'mixamorigLeftHand', parent: 'mixamorigLeftForeArm', at: lm('joint-l-hand') },
  { name: 'mixamorigLeftHandEnd', parent: 'mixamorigLeftHand', at: lm('joint-l-hand-3') },
  { name: 'mixamorigRightShoulder', parent: 'mixamorigSpine3', at: lm('joint-r-clavicle') },
  { name: 'mixamorigRightArm', parent: 'mixamorigRightShoulder', at: lm('joint-r-shoulder') },
  { name: 'mixamorigRightForeArm', parent: 'mixamorigRightArm', at: lm('joint-r-elbow') },
  { name: 'mixamorigRightHand', parent: 'mixamorigRightForeArm', at: lm('joint-r-hand') },
  { name: 'mixamorigRightHandEnd', parent: 'mixamorigRightHand', at: lm('joint-r-hand-3') },
  { name: 'mixamorigLeftUpLeg', parent: 'mixamorigHips', at: lm('joint-l-upper-leg') },
  { name: 'mixamorigLeftLeg', parent: 'mixamorigLeftUpLeg', at: lm('joint-l-knee') },
  { name: 'mixamorigLeftFoot', parent: 'mixamorigLeftLeg', at: lm('joint-l-ankle') },
  { name: 'mixamorigLeftToeBase', parent: 'mixamorigLeftFoot', at: lm('joint-l-foot-1') },
  { name: 'mixamorigLeftToeEnd', parent: 'mixamorigLeftToeBase', at: lm('joint-l-foot-2') },
  { name: 'mixamorigRightUpLeg', parent: 'mixamorigHips', at: lm('joint-r-upper-leg') },
  { name: 'mixamorigRightLeg', parent: 'mixamorigRightUpLeg', at: lm('joint-r-knee') },
  { name: 'mixamorigRightFoot', parent: 'mixamorigRightLeg', at: lm('joint-r-ankle') },
  { name: 'mixamorigRightToeBase', parent: 'mixamorigRightFoot', at: lm('joint-r-foot-1') },
  { name: 'mixamorigRightToeEnd', parent: 'mixamorigRightToeBase', at: lm('joint-r-foot-2') },
]

// 地面：脚底最低点抬到 y = 0；整体缩放到米
const footBottom = Math.min(...verts.map((v) => v[1]))
const SCALE = DM
const OFFSET_Y = -footBottom * SCALE
/** 骨的世界坐标（米）：y 平移到地面之上，x/z 原样（角色左 = +x） */
const boneWorld = new Map()
for (const b of BONES) {
  const p = b.at
  boneWorld.set(b.name, [p[0] * SCALE, p[1] * SCALE + OFFSET_Y, p[2] * SCALE])
}
const bodyHeight = Math.max(boneWorld.get('mixamorigHeadTop')[1], 0)

// 顶点也做同样的变换
const positions = verts.map((v) => [v[0] * SCALE, v[1] * SCALE + OFFSET_Y, v[2] * SCALE])
console.log(`[build] 身高 ${bodyHeight.toFixed(3)} m（${BONES.length} 根骨）`)

// ── 4) 蒙皮权重：顶点→骨段距离 ─────────────────────────────────────────────
// 骨段 = 骨关节点 → 子骨关节点；叶子骨退化成一个点。
const childOf = new Map()
for (const b of BONES) if (b.parent !== null) childOf.set(b.parent, b.name)
const segOf = new Map()
for (const b of BONES) {
  const a = boneWorld.get(b.name)
  const c = childOf.has(b.name) ? boneWorld.get(childOf.get(b.name)) : a
  segOf.set(b.name, [a, c])
}
/** 左右侧归属：用于避免左臂影响右半身。side: 'L' | 'R' | 'C' */
const sideOf = (name) => {
  if (name.includes('Left')) return 'L'
  if (name.includes('Right')) return 'R'
  return 'C'
}
/** 骨轴向（子骨方向）：用于构造「沿骨轴」的距离度量 */
const axisOf = new Map()
for (const b of BONES) {
  const a = boneWorld.get(b.name)
  const c = childOf.has(b.name) ? boneWorld.get(childOf.get(b.name)) : a
  const d = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const len = Math.hypot(d[0], d[1], d[2]) || 1
  axisOf.set(b.name, [d[0] / len, d[1] / len, d[2] / len])
}

const pointSegDist = (p, a, b) => {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2]
  const denom = abx * abx + aby * aby + abz * abz
  let t = denom > 1e-12 ? (apx * abx + apy * aby + apz * abz) / denom : 0
  t = Math.max(0, Math.min(1, t))
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t
  return Math.hypot(dx, dy, dz)
}

/** 顶点所在侧（用于排除异侧肢体影响）：以骨盆宽度的 1.6 倍为界 */
const sideThreshold = Math.abs(boneWorld.get('mixamorigLeftUpLeg')[0]) * 1.6

const MAX_INFLUENCE = 4
const rawWeights = new Float32Array(positions.length * MAX_INFLUENCE)
const rawIndices = new Uint16Array(positions.length * MAX_INFLUENCE)
const cand = []

for (let vi = 0; vi < positions.length; vi++) {
  const p = positions[vi]
  const vSide = p[0] > sideThreshold ? 'L' : p[0] < -sideThreshold ? 'R' : 'C'
  cand.length = 0
  for (const b of BONES) {
    const s = sideOf(b.name)
    // 异侧肢体排除（躯干/头是中央骨，两侧都吃）
    if (s !== 'C' && vSide !== 'C' && s !== vSide) continue
    const [a, c] = segOf.get(b.name)
    const d = pointSegDist(p, a, c)
    cand.push([b.name, d])
  }
  cand.sort((x, y) => x[1] - y[1])
  const take = cand.slice(0, MAX_INFLUENCE)
  // 距离权重：1 / (d^3 + eps)，近骨主导；再归一化
  let sum = 0
  const w = take.map(([, d]) => {
    const v = 1 / (Math.pow(d, 3) + 1e-6)
    sum += v
    return v
  })
  for (let k = 0; k < take.length; k++) {
    rawIndices[vi * MAX_INFLUENCE + k] = BONES.findIndex((b) => b.name === take[k][0])
    rawWeights[vi * MAX_INFLUENCE + k] = w[k] / sum
  }
}

// ── 4b) 权重平滑（一次邻域平均，压掉硬边）──────────────────────────────────
// 邻接表：三角形共享边 → 面邻接
const adj = new Map()
const addAdj = (a, b) => {
  if (!adj.has(a)) adj.set(a, [])
  adj.get(a).push(b)
}
for (const [a, b, c] of faces) {
  addAdj(a, b); addAdj(b, a); addAdj(a, c); addAdj(c, a); addAdj(b, c); addAdj(c, b)
}
const smoothed = new Float32Array(rawWeights.length)
const tmpIndex = new Uint16Array(rawWeights.length)
for (let vi = 0; vi < positions.length; vi++) {
  const neighbours = adj.get(vi) ?? []
  const acc = new Map()
  const add = (idx, w) => {
    if (w <= 1e-6) return
    acc.set(idx, (acc.get(idx) ?? 0) + w)
  }
  for (let k = 0; k < MAX_INFLUENCE; k++) add(rawIndices[vi * MAX_INFLUENCE + k], rawWeights[vi * MAX_INFLUENCE + k])
  for (const nb of neighbours) {
    for (let k = 0; k < MAX_INFLUENCE; k++) add(rawIndices[nb * MAX_INFLUENCE + k], rawWeights[nb * MAX_INFLUENCE + k] * 0.35)
  }
  const sorted = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_INFLUENCE)
  let sum = 0
  for (const [, w] of sorted) sum += w
  for (let k = 0; k < MAX_INFLUENCE; k++) {
    const e = sorted[k]
    tmpIndex[vi * MAX_INFLUENCE + k] = e === undefined ? 0 : e[0]
    smoothed[vi * MAX_INFLUENCE + k] = e === undefined ? 0 : e[1] / sum
  }
}

// ── 5) 法线（面积加权）─────────────────────────────────────────────────────
const normals = new Float32Array(positions.length * 3)
for (const [a, b, c] of faces) {
  const pa = positions[a], pb = positions[b], pc = positions[c]
  const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2]
  const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2]
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  for (const i of [a, b, c]) {
    normals[i * 3] += nx; normals[i * 3 + 1] += ny; normals[i * 3 + 2] += nz
  }
}
for (let i = 0; i < positions.length; i++) {
  const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1
  normals[i * 3] /= l; normals[i * 3 + 1] /= l; normals[i * 3 + 2] /= l
}

// ── 6) 写 GLB ──────────────────────────────────────────────────────────────
const doc = new Document()
doc.createBuffer()
const buffer = doc.getRoot().listBuffers()[0]

const posArr = new Float32Array(positions.length * 3)
for (let i = 0; i < positions.length; i++) {
  posArr[i * 3] = positions[i][0]; posArr[i * 3 + 1] = positions[i][1]; posArr[i * 3 + 2] = positions[i][2]
}
const idxArr = new Uint32Array(faces.length * 3)
for (let i = 0; i < faces.length; i++) {
  idxArr[i * 3] = faces[i][0]; idxArr[i * 3 + 1] = faces[i][1]; idxArr[i * 3 + 2] = faces[i][2]
}

const posAcc = doc.createAccessor('POSITION').setType('VEC3').setArray(posArr).setBuffer(buffer)
const nrmAcc = doc.createAccessor('NORMAL').setType('VEC3').setArray(normals).setBuffer(buffer)
const jntAcc = doc.createAccessor('JOINTS_0').setType('VEC4').setArray(tmpIndex).setBuffer(buffer)
const wgtAcc = doc.createAccessor('WEIGHTS_0').setType('VEC4').setArray(smoothed).setBuffer(buffer)
const idxAcc = doc.createAccessor().setType('SCALAR').setArray(idxArr).setBuffer(buffer)

// 逆绑定矩阵：骨的世界矩阵是纯平移 → 逆矩阵是纯平移取负
const ibm = new Float32Array(BONES.length * 16)
const nodeOf = new Map()
for (let bi = 0; bi < BONES.length; bi++) {
  const b = BONES[bi]
  const p = boneWorld.get(b.name)
  const m = new Float32Array(16)
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1
  m[12] = -p[0]; m[13] = -p[1]; m[14] = -p[2]
  ibm.set(m, bi * 16)
  const node = doc.createNode(b.name)
  const parent = b.parent === null ? null : nodeOf.get(b.parent)
  const local = parent === null ? p : [
    p[0] - boneWorld.get(b.parent)[0],
    p[1] - boneWorld.get(b.parent)[1],
    p[2] - boneWorld.get(b.parent)[2],
  ]
  node.setTranslation(local)
  nodeOf.set(b.name, node)
}
for (const b of BONES) {
  const parent = b.parent === null ? null : nodeOf.get(b.parent)
  if (parent !== null) parent.addChild(nodeOf.get(b.name))
}
const ibmAcc = doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer)

const material = doc.createMaterial('MannequinClay')
  .setBaseColorFactor([0.72, 0.74, 0.78, 1])
  .setRoughnessFactor(0.82)
  .setMetallicFactor(0)

const prim = doc.createPrimitive()
  .setAttribute('POSITION', posAcc)
  .setAttribute('NORMAL', nrmAcc)
  .setAttribute('JOINTS_0', jntAcc)
  .setAttribute('WEIGHTS_0', wgtAcc)
  .setIndices(idxAcc)
  .setMaterial(material)

const mesh = doc.createMesh('MannequinBody').addPrimitive(prim)
const meshNode = doc.createNode('Body').setMesh(mesh)
const skin = doc.createSkin('BodySkin').setInverseBindMatrices(ibmAcc)
for (const b of BONES) skin.addJoint(nodeOf.get(b.name))
skin.setSkeleton(nodeOf.get('mixamorigHips'))
meshNode.setSkin(skin)

const scene = doc.createScene('Scene').addChild(meshNode)
scene.addChild(nodeOf.get('mixamorigHips'))
doc.getRoot().setDefaultScene(scene)

// ⚠ 必须用 SEPARATE 布局（每个属性一个 bufferView）：默认的 interleaved 会把
//   JOINTS_0（UNSIGNED_SHORT）与 POSITION / NORMAL / WEIGHTS_0（FLOAT）混进同
//   一个交错视图 —— glTF 不允许（视图内各 accessor 的 componentType 必须一致），
//   three.js 读出来全是乱值（蒙皮索引变成顶点坐标，实测：模型整个人散架）。
const io = new NodeIO().setVertexLayout(VertexLayout.SEPARATE)
const out = await io.writeBinary(doc)
writeFileSync(outPath, out)
console.log(`[build] ${outPath}（${(out.length / 1024 / 1024).toFixed(2)} MB，${positions.length} 顶点 / ${faces.length} 面）`)

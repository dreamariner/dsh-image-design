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
//   3) 建 28 根骨（平移静止姿态，局部旋转为单位阵）
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

// ── 4b) 权重平滑（多轮邻域平均，压掉硬边）──────────────────────────────────
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
const SMOOTH_PASSES = 3
const SMOOTH_NEIGHBOUR = 0.3
let srcIndex = rawIndices
let srcWeight = rawWeights
for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
  const nextIndex = new Uint16Array(rawWeights.length)
  const nextWeight = new Float32Array(rawWeights.length)
  for (let vi = 0; vi < positions.length; vi++) {
    const neighbours = adj.get(vi) ?? []
    const acc = new Map()
    const add = (idx, w) => {
      if (w <= 1e-6) return
      acc.set(idx, (acc.get(idx) ?? 0) + w)
    }
    for (let k = 0; k < MAX_INFLUENCE; k++) add(srcIndex[vi * MAX_INFLUENCE + k], srcWeight[vi * MAX_INFLUENCE + k])
    for (const nb of neighbours) {
      for (let k = 0; k < MAX_INFLUENCE; k++) add(srcIndex[nb * MAX_INFLUENCE + k], srcWeight[nb * MAX_INFLUENCE + k] * SMOOTH_NEIGHBOUR)
    }
    const sorted = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_INFLUENCE)
    let sum = 0
    for (const [, w] of sorted) sum += w
    for (let k = 0; k < MAX_INFLUENCE; k++) {
      const e = sorted[k]
      nextIndex[vi * MAX_INFLUENCE + k] = e === undefined ? 0 : e[0]
      nextWeight[vi * MAX_INFLUENCE + k] = e === undefined ? 0 : e[1] / sum
    }
  }
  srcIndex = nextIndex
  srcWeight = nextWeight
}
tmpIndex.set(srcIndex)
smoothed.set(srcWeight)

// ── 4c) 解剖归属：关节处按「链向坐标」互补分配 + 祖先骨切断 ──────────────────
// 纯距离权重在关节处给两骨各约 50% → 大角度屈曲时关节顶点被两套变换平均 →
// 关节体积塌掉（LBS 的「糖果纸」效应），膝盖看起来被压扁。实测（硬切实验）：
//   距离权重：坐姿膝环半径比 0.89、膝截面比 0.57（塌了一半）
//   关节硬切：两项都是 1.000（完全不塌）→ 证实病因就在「关节处两骨权重相当」
//
// 正确做法不是硬切（会折出硬棱），而是**链向互补分配**：
//   沿肢体轴取关节的有符号偏移 x（>0 = 子骨侧），子骨权重 = logistic(x/σ)，
//   父骨权重 = 1 − 子骨权重（两者互补，关节面处各 50%，σ 控制过渡带宽）。
// 再叠一层解剖修正：关节**前方**（髌骨/鹰嘴）应留在父骨、**后方**（腘窝/肘窝）
// 交给子骨 → 把过渡带沿轴向平移 x_eff = x − 0.6·s（s = 前后偏移）。
// 于是：膝前方是硬的（保髌骨凸起）、膝后方是软的（出皱褶），与真实膝盖一致。
//
// **祖先骨必须切断**（2026-11-18 实机定位的「爪形手」根因）：
// 手指离腕关节 18cm，本该整根属于手骨链，但距离权重给了指尖 23% 的前臂骨权重 →
// 手腕一转（坐姿腕屈 80°），前臂那 23% 把指尖往回拽 → 手指被撕成扇形尖刺
// （实机截图的「爪子」）。规则：**关节子骨侧的顶点不得带任何祖先骨权重**，
// 祖先权重按同一条 logistic 曲线平滑退场（不是硬切，关节面仍各 50%）。
// 覆盖范围用**圆柱**（垂直骨轴的半径）而不是球：球会把腋窝/腿缝的邻部位顶点
// 也算进来 → 邻部位被硬切出裂缝。
const HINGES = [
  { parent: 'mixamorigHips', child: 'mixamorigLeftUpLeg', distal: 'mixamorigLeftLeg', radius: 0.13, front: 0.6 },
  { parent: 'mixamorigHips', child: 'mixamorigRightUpLeg', distal: 'mixamorigRightLeg', radius: 0.13, front: 0.6 },
  { parent: 'mixamorigLeftUpLeg', child: 'mixamorigLeftLeg', distal: 'mixamorigLeftFoot', radius: 0.12, front: 0.6 },
  { parent: 'mixamorigRightUpLeg', child: 'mixamorigRightLeg', distal: 'mixamorigRightFoot', radius: 0.12, front: 0.6 },
  { parent: 'mixamorigLeftArm', child: 'mixamorigLeftForeArm', distal: 'mixamorigLeftHand', radius: 0.11, front: 0.6 },
  { parent: 'mixamorigRightArm', child: 'mixamorigRightForeArm', distal: 'mixamorigRightHand', radius: 0.11, front: 0.6 },
  // 腕：整条子骨链（手 + 手末端）都要与前臂断开。
  // 圆柱半径按手的外廓给（手宽 9cm + 余量），比旧的球半径 0.17 更贴合。
  { parent: 'mixamorigLeftForeArm', child: 'mixamorigLeftHand', distal: 'mixamorigLeftHandEnd', radius: 0.13, front: 0.4 },
  { parent: 'mixamorigRightForeArm', child: 'mixamorigRightHand', distal: 'mixamorigRightHandEnd', radius: 0.13, front: 0.4 },
  // 踝：整只脚（脚掌 + 脚趾）与小腿断开。
  { parent: 'mixamorigLeftLeg', child: 'mixamorigLeftFoot', distal: 'mixamorigLeftToeBase', radius: 0.12, front: 0.4 },
  { parent: 'mixamorigRightLeg', child: 'mixamorigRightFoot', distal: 'mixamorigRightToeBase', radius: 0.12, front: 0.4 },
  // 肩（锁骨 → 上臂）：上臂与锁骨断开，否则抬臂时三角肌被锁骨拽住。
  // 祖先骨（脊柱链）**不**切断：腋窝离上臂轴只有 5cm，硬切会把腋窝撕开。
  { parent: 'mixamorigLeftShoulder', child: 'mixamorigLeftArm', distal: 'mixamorigLeftForeArm', radius: 0.10, front: 0.6, ancestors: false },
  { parent: 'mixamorigRightShoulder', child: 'mixamorigRightArm', distal: 'mixamorigRightForeArm', radius: 0.10, front: 0.6, ancestors: false },
]
/** 过渡带宽 σ（米）：σ 越大过渡越宽（塌陷越多），越小越硬（棱越明显）。 */
const SIGMA = 0.015
/** 骨名 → BONES 下标 */
const boneIndex = new Map(BONES.map((b, i) => [b.name, i]))
/** 骨名 → 父骨名（祖先链用） */
const parentBoneOf = new Map(BONES.map((b) => [b.name, b.parent]))
for (const h of HINGES) {
  const joint = boneWorld.get(h.child) // 子骨原点 = 关节中心
  const distal = boneWorld.get(h.distal) // 远端骨 → 肢体轴方向
  if (joint === undefined || distal === undefined) continue
  const ax = distal[0] - joint[0], ay = distal[1] - joint[1], az = distal[2] - joint[2]
  const al = Math.hypot(ax, ay, az) || 1
  const u = [ax / al, ay / al, az / al]
  // 屈曲轴 = 肢体轴 × 面向(+z) → 内/外侧；前向 = 屈曲轴 × 肢体轴（矢状面内）
  const bend = [u[1], -u[0], 0]
  const bl = Math.hypot(bend[0], bend[1], bend[2]) || 1
  bend[0] /= bl; bend[1] /= bl; bend[2] /= bl
  const front = [
    bend[1] * u[2] - bend[2] * u[1],
    bend[2] * u[0] - bend[0] * u[2],
    bend[0] * u[1] - bend[1] * u[0],
  ]
  const pi = boneIndex.get(h.parent)
  const ci = boneIndex.get(h.child)
  if (pi === undefined || ci === undefined) continue
  // 祖先骨（父骨的父骨…）：子骨侧顶点不得带它们，否则关节一转就把子骨拽回去
  const ancestorIdx = []
  if (h.ancestors !== false) {
    let cur = parentBoneOf.get(h.parent)
    while (cur !== null && cur !== undefined) {
      const idx = boneIndex.get(cur)
      if (idx !== undefined) ancestorIdx.push(idx)
      cur = parentBoneOf.get(cur)
    }
  }
  // 备选子骨：子骨不在权重槽里时用它自己的子骨（腕：Hand → HandEnd）
  const fallback = parentBoneOf.get(h.distal) === h.child ? boneIndex.get(h.distal) : undefined
  for (let vi = 0; vi < positions.length; vi++) {
    const p = positions[vi]
    const dx = p[0] - joint[0], dy = p[1] - joint[1], dz = p[2] - joint[2]
    const x = dx * u[0] + dy * u[1] + dz * u[2] // 链向偏移：>0 = 子骨侧
    const rPerp2 = dx * dx + dy * dy + dz * dz - x * x
    if (rPerp2 > h.radius * h.radius) continue // 圆柱：垂直骨轴太远 → 不是这条链的
    if (x < -0.25) continue // 关节后方的顶点不参与
    const s = dx * front[0] + dy * front[1] + dz * front[2] // 前后偏移：>0 = 前
    const xEff = x - h.front * s
    const wc = 1 / (1 + Math.exp(-xEff / SIGMA)) // 子骨权重
    // 在该顶点的 4 个权重槽里找父/子骨
    let wp = -1, wci = -1
    for (let k = 0; k < MAX_INFLUENCE; k++) {
      const bi = tmpIndex[vi * MAX_INFLUENCE + k]
      if (bi === pi) wp = k
      if (bi === ci) wci = k
    }
    if (wp < 0) continue
    if (wci < 0 && fallback !== undefined) {
      for (let k = 0; k < MAX_INFLUENCE; k++) {
        if (tmpIndex[vi * MAX_INFLUENCE + k] === fallback) { wci = k; break }
      }
    }
    // 祖先权重（要按同一条曲线退场）
    const ancestorSlots = []
    let wAncestor = 0
    for (let k = 0; k < MAX_INFLUENCE; k++) {
      const bi = tmpIndex[vi * MAX_INFLUENCE + k]
      if (ancestorIdx.includes(bi)) { ancestorSlots.push(k); wAncestor += smoothed[vi * MAX_INFLUENCE + k] }
    }
    const wParent = smoothed[vi * MAX_INFLUENCE + wp]
    if (wci < 0) {
      // 子骨不在槽里：父骨保留全部权重，祖先按曲线退场（权重损失交给末尾归一化）
      for (const k of ancestorSlots) smoothed[vi * MAX_INFLUENCE + k] *= 1 - wc
      continue
    }
    const wChild = smoothed[vi * MAX_INFLUENCE + wci]
    const pair = wParent + wChild
    smoothed[vi * MAX_INFLUENCE + wp] = pair * (1 - wc)
    smoothed[vi * MAX_INFLUENCE + wci] = pair * wc + wAncestor * wc
    for (const k of ancestorSlots) smoothed[vi * MAX_INFLUENCE + k] *= 1 - wc
  }
}

// ── 4d) 手指收拢（轻量版：把基础网格张开的四指收成自然的手）──────────────────
// 基础网格（hm08）的四指本来是张开的（指间夹角 25–35°、指尖横距 7cm），侧视像耙子，
// 摆臂姿势里尤其扎眼（用户实机截图的「爪子」）。
// 本段把四指的**指尖位置**改排到「等间距 1.9cm」的目标，指长与指宽不变：
//   ① 远端 7cm 的连通分量聚成 4 指 + 1 拇指（指尖是彼此断开的连通块）；
//   ② 四指沿「横过手掌」方向各自平移（差量按沿指轴衰减：掌缘 0 → 指尖全量）；
//   ③ 归属用**高斯软权重**（不是硬归属）→ 指间蹼部拿到两指位移的平滑混合，不撕裂。
// 2026-11-18 三次失败记录（勿回退）：
//   ① 远端横坐标整体缩放（0.45）→ 四指压成一片、指面翻成尖刺（成品是薄片不是手）；
//   ② 硬归属 + 目标间距 1.45cm → 指根蹼部被压出褶皱/锯齿，视觉更脏；
//   ③ 软归属 + 目标间距 1.9cm（现版）→ 指尖横距 7→5.7cm，蹼部只被压缩约 3mm，
//      实机（三档平滑法线）复查无破面。
// 若日后改成「整手重指」（重排手指骨架 + 重新蒙皮），把本段整段删掉即可。
{
  const dominantBoneOf = (vi) => {
    let bw = 0, bj = 0
    for (let k = 0; k < MAX_INFLUENCE; k++) {
      const w = smoothed[vi * MAX_INFLUENCE + k]
      if (w > bw) { bw = w; bj = tmpIndex[vi * MAX_INFLUENCE + k] }
    }
    return BONES[bj]?.name ?? ''
  }
  const FINGER_PITCH = 0.019 // 指尖目标间距（米）
  const TIP_REGION = 0.07 // 指尖聚类用的远端长度（米）
  const GATHER_START = 0.55 // 平移开始爬升的位置（掌长占比）
  const SIGMA_THETA = 0.18 // 指间软归属的高斯带宽（弧度）
  for (const side of ['Left', 'Right']) {
    const handName = `mixamorig${side}Hand`
    const endName = `mixamorig${side}HandEnd`
    const wrist = boneWorld.get(handName)
    if (wrist === undefined) continue
    const handVerts = []
    for (let vi = 0; vi < positions.length; vi++) {
      const nm = dominantBoneOf(vi)
      if (nm === handName || nm === endName) handVerts.push(vi)
    }
    if (handVerts.length < 100) continue
    const distOf = (vi) => {
      const p = positions[vi]
      return Math.hypot(p[0] - wrist[0], p[1] - wrist[1], p[2] - wrist[2])
    }
    const handLen = Math.max(...handVerts.map(distOf))
    const tipSet = new Set(handVerts.filter((vi) => distOf(vi) > handLen - TIP_REGION))
    const seen = new Set()
    const clusters = []
    for (const s0 of tipSet) {
      if (seen.has(s0)) continue
      const comp = []
      const stack = [s0]
      seen.add(s0)
      while (stack.length > 0) {
        const v = stack.pop()
        comp.push(v)
        for (const nb of adj.get(v) ?? []) {
          if (tipSet.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb) }
        }
      }
      if (comp.length >= 20) clusters.push(comp)
    }
    if (clusters.length !== 5) {
      console.log(`[gather] ${side} 指聚类数 ${clusters.length}（期望 5），跳过收拢`)
      continue
    }
    const centroid = (comp) => {
      const c = [0, 0, 0]
      for (const vi of comp) { c[0] += positions[vi][0]; c[1] += positions[vi][1]; c[2] += positions[vi][2] }
      return [c[0] / comp.length, c[1] / comp.length, c[2] / comp.length]
    }
    const cents = clusters.map(centroid)
    // 拇指 = 离其余四指质心最远的那一簇
    let thumbIdx = 0
    let thumbDist = -1
    for (let i = 0; i < cents.length; i++) {
      const others = cents.filter((_, k) => k !== i)
      const oc = [0, 0, 0]
      for (const o of others) { oc[0] += o[0]; oc[1] += o[1]; oc[2] += o[2] }
      oc[0] /= others.length; oc[1] /= others.length; oc[2] /= others.length
      const d = Math.hypot(cents[i][0] - oc[0], cents[i][1] - oc[1], cents[i][2] - oc[2])
      if (d > thumbDist) { thumbDist = d; thumbIdx = i }
    }
    const fingerIdx = cents.map((_, i) => i).filter((i) => i !== thumbIdx)
    const fc = [0, 0, 0]
    for (const i of fingerIdx) { fc[0] += cents[i][0]; fc[1] += cents[i][1]; fc[2] += cents[i][2] }
    fc[0] /= fingerIdx.length; fc[1] /= fingerIdx.length; fc[2] /= fingerIdx.length
    // 手轴（腕 → 四指质心）与横过手掌的方向（4 指偏移的主轴）
    const ax = [fc[0] - wrist[0], fc[1] - wrist[1], fc[2] - wrist[2]]
    const al = Math.hypot(ax[0], ax[1], ax[2]) || 1
    const A = [ax[0] / al, ax[1] / al, ax[2] / al]
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
    const proj = (v, a) => { const d = dot3(v, a); return [v[0] - a[0] * d, v[1] - a[1] * d, v[2] - a[2] * d] }
    let E1 = Math.abs(A[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0]
    E1 = norm3(proj(E1, A))
    const E2 = norm3(cross3(A, E1))
    let s11 = 0, s22 = 0, s12 = 0
    for (const i of fingerIdx) {
      const q = proj([cents[i][0] - fc[0], cents[i][1] - fc[1], cents[i][2] - fc[2]], A)
      const a1 = dot3(q, E1), a2 = dot3(q, E2)
      s11 += a1 * a1; s22 += a2 * a2; s12 += a1 * a2
    }
    let U = [s11, s12]
    for (let it = 0; it < 24; it++) {
      const nxt = [U[0] * s11 + U[1] * s12, U[0] * s12 + U[1] * s22]
      const l = Math.hypot(nxt[0], nxt[1]) || 1
      U = [nxt[0] / l, nxt[1] / l]
    }
    let Uv = [E1[0] * U[0] + E2[0] * U[1], E1[1] * U[0] + E2[1] * U[1], E1[2] * U[0] + E2[2] * U[1]]
    Uv = norm3(proj(Uv, A))
    // 拇指应在 U 的正侧（食指挨着拇指）；**先定方向再算偏移**，
    // 否则翻转 U 之后偏移量的符号与实际平移方向相反（会把四指往外掰开）。
    const thumbO = dot3([cents[thumbIdx][0] - fc[0], cents[thumbIdx][1] - fc[1], cents[thumbIdx][2] - fc[2]], Uv)
    if (thumbO < 0) { Uv = [-Uv[0], -Uv[1], -Uv[2]] }
    const fingerOs = fingerIdx.map((i) => dot3([cents[i][0] - fc[0], cents[i][1] - fc[1], cents[i][2] - fc[2]], Uv))
    const order = fingerIdx.map((i, k) => ({ i, o: fingerOs[k] })).sort((a, b) => a.o - b.o)
    const deltaOf = new Map()
    const span = FINGER_PITCH * 3
    order.forEach((f, k) => {
      const target = -span / 2 + k * FINGER_PITCH
      deltaOf.set(f.i, target - f.o)
    })
    const thetaOf = (p) => {
      const q = proj([p[0] - fc[0], p[1] - fc[1], p[2] - fc[2]], A)
      return Math.atan2(dot3(q, E2), dot3(q, E1))
    }
    const fingerTheta = new Map()
    for (const i of fingerIdx) fingerTheta.set(i, thetaOf(cents[i]))
    const tipAlong = new Map()
    for (const i of fingerIdx) tipAlong.set(i, Math.max(...clusters[i].map((vi) => {
      const p = positions[vi]
      return (p[0] - wrist[0]) * A[0] + (p[1] - wrist[1]) * A[1] + (p[2] - wrist[2]) * A[2]
    })))
    const palmEnd = handLen * GATHER_START
    let moved = 0
    for (const vi of handVerts) {
      const p = positions[vi]
      const along = (p[0] - wrist[0]) * A[0] + (p[1] - wrist[1]) * A[1] + (p[2] - wrist[2]) * A[2]
      if (along <= palmEnd) continue
      const th = thetaOf(p)
      let wsum = 0
      const ws = []
      for (const i of fingerIdx) {
        let d = th - fingerTheta.get(i)
        if (d > Math.PI) d -= Math.PI * 2
        if (d < -Math.PI) d += Math.PI * 2
        const w = Math.exp(-(d * d) / (2 * SIGMA_THETA * SIGMA_THETA))
        ws.push(w); wsum += w
      }
      if (wsum < 1e-6) continue
      let delta = 0, ramp = 0
      fingerIdx.forEach((i, k) => {
        const w = ws[k] / wsum
        if (w < 1e-4) return
        delta += w * deltaOf.get(i)
        const tip = tipAlong.get(i)
        const t = Math.min(1, Math.max(0, (along - palmEnd) / Math.max(1e-4, tip - palmEnd)))
        ramp += w * t
      })
      const d = delta * ramp
      if (Math.abs(d) < 1e-6) continue
      positions[vi] = [p[0] + Uv[0] * d, p[1] + Uv[1] * d, p[2] + Uv[2] * d]
      moved++
    }
    console.log(`[gather] ${side} 四指收拢：聚类 5（拇指 idx=${thumbIdx}），移动顶点 ${moved}`)
  }
}

// ── 4e) 权重收尾：4 槽归一化（4c 重新分配后总和不再为 1）─────────────────────
for (let vi = 0; vi < positions.length; vi++) {
  let sum = 0
  for (let k = 0; k < MAX_INFLUENCE; k++) sum += smoothed[vi * MAX_INFLUENCE + k]
  if (sum <= 1e-9) {
    // 兜底：权重全空的顶点挂到最近的骨（避免 NaN 蒙皮）
    smoothed[vi * MAX_INFLUENCE] = 1
    continue
  }
  for (let k = 0; k < MAX_INFLUENCE; k++) smoothed[vi * MAX_INFLUENCE + k] /= sum
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

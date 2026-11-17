// 体型滑杆检查器：逐个参数跑「最小 / 默认 / 最大」，出对照图 + 量数值。
//
// 为什么要它：滑杆的问题（变形怪异）靠肉眼看单张截图很难定位，得把每个参数的
// 极值并排摆出来看，同时打印关键量纲（围度 / 肢长 / 身高）判断「动的是不是该动的」。
//
// 用法：node --experimental-strip-types scripts/check-shape.mjs [out.png]

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeIO } from '@gltf-transform/core'
import * as THREE from 'three'
import { DEFAULT_BODY, BODY_RANGES, lengthTunes, positionTunes, BONE } from '../src/client/mannequin/body.ts'
import { applyShape } from '../src/client/mannequin/shape.ts'

const here = dirname(fileURLToPath(import.meta.url))
const outPath = process.argv[2] ?? '/tmp/mh-preview/shape-check.png'

// ── 读 GLB ────────────────────────────────────────────────────────────────
const io = new NodeIO()
const doc = await io.read(join(here, '..', 'assets', 'mannequin-body.glb'))
const root = doc.getRoot()
const prim = root.listMeshes()[0].listPrimitives()[0]
const POS = Array.from(prim.getAttribute('POSITION').getArray())
const JOINTS = Array.from(prim.getAttribute('JOINTS_0').getArray())
const WEIGHTS = Array.from(prim.getAttribute('WEIGHTS_0').getArray())
const INDICES = Array.from(prim.getIndices().getArray())
const jointNodes = root.listSkins()[0].listJoints()

const parentOf = new Map()
for (const n of root.listNodes()) { const p = n.getParentNode(); if (p) parentOf.set(n.getName(), p.getName()) }
const localOf = new Map()
for (const n of jointNodes) localOf.set(n.getName(), n.getTranslation() ?? [0, 0, 0])

/** 绑定姿态下各骨的世界位置与骨轴。 */
function boneFrames() {
  const world = new Map()
  const axis = new Map()
  for (const n of jointNodes) {
    const name = n.getName()
    const t = localOf.get(name)
    const pn = parentOf.get(name)
    const pt = pn ? world.get(pn) : [0, 0, 0]
    world.set(name, [t[0] + pt[0], t[1] + pt[1], t[2] + pt[2]])
  }
  for (const n of jointNodes) {
    const name = n.getName()
    const kids = (n.getChildren?.() ?? [])
    const child = kids.find((c) => (c.getName?.() ?? '').includes('mixamorig'))
    if (child === undefined) continue
    const a = world.get(name), b = world.get(child.getName())
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const len = Math.hypot(d[0], d[1], d[2])
    if (len > 1e-9) axis.set(name, new THREE.Vector3(d[0] / len, d[1] / len, d[2] / len))
  }
  return { world, axis }
}
const FRAMES = boneFrames()
const boneIndex = new Map()
jointNodes.forEach((n, i) => boneIndex.set(n.getName(), i))
const boneWorld = new Map()
for (const [k, v] of FRAMES.world) boneWorld.set(k, new THREE.Vector3(v[0], v[1], v[2]))
const boneRestLocal = new Map()
for (const [k, v] of localOf) boneRestLocal.set(k, new THREE.Vector3(v[0], v[1], v[2]))

// ── 按参数集算：骨位姿（含臂长腿长 / 肩宽位移）+ 蒙皮 + 形变 ────────────────
function buildPose(params) {
  // 骨局部位移：肩宽外移 + 臂长腿长缩放
  const local = new Map()
  for (const [name, v] of localOf) local.set(name, new THREE.Vector3(v[0], v[1], v[2]))
  for (const [name, delta] of Object.entries(positionTunes(params))) {
    const l = local.get(name)
    if (l !== undefined) l.set(l.x + delta[0], l.y + delta[1], l.z + delta[2])
  }
  for (const [name, k] of Object.entries(lengthTunes(params))) {
    const l = local.get(name)
    if (l !== undefined) l.multiplyScalar(k)
  }
  // 骨世界位置
  const world = new Map()
  for (const n of jointNodes) {
    const name = n.getName()
    const l = local.get(name)
    const pn = parentOf.get(name)
    const pt = pn ? world.get(pn) : [0, 0, 0]
    world.set(name, [l.x + pt[0], l.y + pt[1], l.z + pt[2]])
  }
  return { local, world }
}

/** 蒙皮 + 形变 → 顶点数组（模型局部空间，脚底贴 y=0）。 */
function buildGeometry(params) {
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(POS, 3))
  geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(JOINTS, 4))
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(WEIGHTS, 4))
  const ctx = {
    base: new Float32Array(POS),
    joints: new Uint16Array(JOINTS),
    weights: new Float32Array(WEIGHTS),
    boneIndex,
    boneWorld,
  }
  applyShape(geom, ctx, params)
  const deformed = Array.from(geom.getAttribute('position').array)

  // 蒙皮：骨位姿（无旋转，只平移）→ 顶点
  const pose = buildPose(params)
  const out = new Float32Array(deformed.length)
  for (let vi = 0; vi < deformed.length / 3; vi++) {
    const v = [deformed[vi * 3], deformed[vi * 3 + 1], deformed[vi * 3 + 2]]
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 4; k++) {
      const w = WEIGHTS[vi * 4 + k]
      if (w <= 1e-6) continue
      const name = jointNodes[JOINTS[vi * 4 + k]].getName()
      const bw = FRAMES.world.get(name)
      const pw = pose.world.get(name)
      // 蒙皮：现在位姿的骨位 + （顶点 − 绑定位姿的骨位）
      x += w * (pw[0] + (v[0] - bw[0]))
      y += w * (pw[1] + (v[1] - bw[1]))
      z += w * (pw[2] + (v[2] - bw[2]))
    }
    out[vi * 3] = x; out[vi * 3 + 1] = y; out[vi * 3 + 2] = z
  }
  // 脚底贴地 + 整体缩放到目标身高（身高按**网格实测**算，形变改了头围也不会偏）
  let minY = Infinity, maxY = -Infinity
  for (let i = 0; i < out.length; i += 3) {
    if (out[i + 1] < minY) minY = out[i + 1]
    if (out[i + 1] > maxY) maxY = out[i + 1]
  }
  const localH = Math.max(0.5, maxY - minY)
  const scale = (params.height / 100) / localH
  for (let i = 0; i < out.length; i += 3) {
    out[i] *= scale
    out[i + 1] = (out[i + 1] - minY) * scale
    out[i + 2] *= scale
  }
  return out
}

// ── 量测 ──────────────────────────────────────────────────────────────────
// 量围度时必须**剔除手臂顶点**：手臂在胸高处的内缘会落进胸围的量测带里，
// 肩宽一变就污染胸围读数（实测：肩宽 0.8 时胸宽虚高到 0.439）。
const ARM_BONES = new Set([
  'mixamorigLeftShoulder', 'mixamorigLeftArm', 'mixamorigLeftForeArm', 'mixamorigLeftHand',
  'mixamorigRightShoulder', 'mixamorigRightArm', 'mixamorigRightForeArm', 'mixamorigRightHand',
])
/** 顶点是否归躯干（**权重最大**的骨不是手臂；JOINTS 的第一项不一定是主导骨）。 */
const isTorsoVert = (vi) => {
  let dom = 0
  let dw = -1
  for (let k = 0; k < 4; k++) {
    const w = WEIGHTS[vi * 4 + k]
    if (w > dw) { dw = w; dom = JOINTS[vi * 4 + k] }
  }
  return !ARM_BONES.has(jointNodes[dom].getName())
}

function measure(pos) {
  // 相对身高带（比例随身高缩放，量测才有可比性）
  let minY = 1e9, maxY = -1e9, maxX = -1e9, maxZ = -1e9
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 1] < minY) minY = pos[i + 1]
    if (pos[i + 1] > maxY) maxY = pos[i + 1]
    if (Math.abs(pos[i]) > maxX) maxX = Math.abs(pos[i])
    if (pos[i + 2] > maxZ) maxZ = pos[i + 2]
  }
  const H = maxY - minY
  const band = (f0, f1, maxX) => {
    let mnX = 1e9, mxX = -1e9, mnZ = 1e9, mxZ = -1e9
    const y0 = minY + H * f0, y1 = minY + H * f1
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2]
      if (y < y0 || y > y1 || Math.abs(x) > maxX) continue
      if (!isTorsoVert(i / 3)) continue
      if (x < mnX) mnX = x; if (x > mxX) mxX = x
      if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z
    }
    return { w: +(mxX - mnX).toFixed(3), d: +(mxZ - mnZ).toFixed(3) }
  }
  const limb = (f0, f1) => {
    // 取该高度带内离中线最远的点（手臂 / 腿的外缘）
    let far = 0, near = 1e9
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1]
      if (y < minY + H * f0 || y > minY + H * f1) continue
      const ax = Math.abs(x)
      if (ax > far) far = ax
      if (ax > 0.06 && ax < near) near = ax
    }
    return { 外缘: +far.toFixed(3), 内缘: +near.toFixed(3) }
  }
  // 头宽：直接量「主导骨是头骨」的顶点（按高度带量会随头身比漂移）
  let headW = 0
  for (let vi = 0; vi < JOINTS.length / 4; vi++) {
    if (jointNodes[JOINTS[vi * 4]].getName() !== 'mixamorigHead') continue
    const ax = Math.abs(pos[vi * 3])
    if (ax > headW) headW = ax
  }

  return {
    身高: +H.toFixed(3),
    头高: +(maxY - (minY + H * 0.87)).toFixed(3),
    头宽: +(headW * 2).toFixed(3),
    // 量测带对准体型剖面的控制点（绑定空间 y ≈ 身高 × 比例）：
    //   胸 0.705..0.725 → y≈1.20..1.23（胸控制点 1.21）
    //   腰 0.600..0.620 → y≈1.02..1.05（腰控制点 1.04）
    //   臀 0.520..0.545 → y≈0.88..0.93（骨盆控制点 0.90）
    //   肩 0.74..0.80 → y≈1.26..1.36（肩控制点 1.31）
    胸宽: band(0.705, 0.725, 0.22).w,
    胸深: band(0.705, 0.725, 0.22).d,
    腰宽: band(0.600, 0.620, 0.22).w,
    臀宽: band(0.520, 0.545, 0.22).w,
    肩宽: +(limb(0.74, 0.80).外缘 * 2).toFixed(3),
    臂外缘: limb(0.45, 0.62).外缘,
    臂内缘: limb(0.45, 0.62).内缘,
    腿间距: limb(0.05, 0.20).内缘,
    胸凸: +maxZ.toFixed(3),
  }
}

// ── 渲染（软件光栅，正视 / 侧视）────────────────────────────────────────
// ZONE=torso|head|hip|leg|arm 限定取景高度带（身高比例），便于看局部瑕疵
const ZONE = process.env.ZONE ?? 'full'
const ZONES = {
  full: [0, 1],
  torso: [0.42, 0.82],
  chest: [0.55, 0.82],
  hip: [0.38, 0.68],
  head: [0.82, 1],
  arm: [0.3, 0.72],
  leg: [0, 0.55],
}
const ZONE_RANGE = ZONES[ZONE] ?? ZONES.full

function render(pos, yaw, W, H) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  const v = new Float32Array(pos.length)
  for (let i = 0; i < pos.length / 3; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    v[i * 3] = x * cy + z * sy
    v[i * 3 + 1] = y
    v[i * 3 + 2] = -x * sy + z * cy
  }
  // 取景包围盒：整幅高度带（ZONE_RANGE 是身高比例）
  let allMinY = 1e9, allMaxY = -1e9
  for (let i = 0; i < v.length / 3; i++) {
    const y = v[i * 3 + 1]
    if (y < allMinY) allMinY = y
    if (y > allMaxY) allMaxY = y
  }
  const H0 = allMaxY - allMinY
  const y0 = allMinY + H0 * ZONE_RANGE[0]
  const y1 = allMinY + H0 * ZONE_RANGE[1]
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9
  for (let i = 0; i < v.length / 3; i++) {
    const x = v[i * 3], y = v[i * 3 + 1]
    if (y < y0 || y > y1) continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (minX > maxX) { minX = -0.2; maxX = 0.2; minY = y0; maxY = y1 }
  const scale = (Math.min(W, H) * 0.9) / Math.max(maxX - minX, maxY - minY)
  const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2
  const px = (x) => (x - ox) * scale + W / 2
  const py = (y) => H - ((y - oy) * scale + H / 2)
  const zbuf = new Float64Array(W * H).fill(Infinity)
  const color = new Uint8Array(W * H * 3).fill(255)
  const light = [-0.3, 0.5, 0.8]
  for (let t = 0; t < INDICES.length; t += 3) {
    const ia = INDICES[t], ib = INDICES[t + 1], ic = INDICES[t + 2]
    const a = [v[ia * 3], v[ia * 3 + 1], v[ia * 3 + 2]]
    const b = [v[ib * 3], v[ib * 3 + 1], v[ib * 3 + 2]]
    const c = [v[ic * 3], v[ic * 3 + 1], v[ic * 3 + 2]]
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    const val = Math.round(255 * Math.min(1, Math.max(0.12, 0.3 + 0.7 * Math.abs(nx * light[0] + ny * light[1] + nz * light[2]))))
    const x0 = px(a[0]), y0 = py(a[1]), x1 = px(b[0]), y1 = py(b[1]), x2 = px(c[0]), y2 = py(c[1])
    const minx = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxx = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)))
    const miny = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxy = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)))
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (Math.abs(area) < 1e-9) continue
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const pxc = x + 0.5, pyc = y + 0.5
        const w0 = ((x1 - pxc) * (y2 - pyc) - (x2 - pxc) * (y1 - pyc)) / area
        const w1 = ((x2 - pxc) * (y0 - pyc) - (x0 - pxc) * (y2 - pyc)) / area
        const w2 = 1 - w0 - w1
        if (w0 < 0 || w1 < 0 || w2 < 0) continue
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2]
        const idx = y * W + x
        if (z >= zbuf[idx]) continue
        zbuf[idx] = z
        color[idx * 3] = val; color[idx * 3 + 1] = val; color[idx * 3 + 2] = val
      }
    }
  }
  return color
}

// ── PNG ───────────────────────────────────────────────────────────────────
function writePng(path, W, H, color) {
  const raw = Buffer.alloc((W * 3 + 1) * H)
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 3, d = y * (W * 3 + 1) + 1 + x * 3
      raw[d] = color[s]; raw[d + 1] = color[s + 1]; raw[d + 2] = color[s + 2]
    }
  }
  const table = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, cc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]))
}

// ── 主流程：逐参数跑极值 ──────────────────────────────────────────────────
const PARAMS = ['height', 'headRatio', 'shoulderWidth', 'bust', 'waist', 'hip', 'limbThickness', 'armLength', 'legLength']
const CELL_W = 230, CELL_H = 400
const COLS = 5

const base = buildGeometry(DEFAULT_BODY)
const baseM = measure(base)
console.log('默认体型：', JSON.stringify(baseM))

for (const key of PARAMS) {
  const range = BODY_RANGES[key]
  const minP = { ...DEFAULT_BODY, [key]: range.min }
  const maxP = { ...DEFAULT_BODY, [key]: range.max }
  // 四个格子：最小 / 默认 / 最大（正视）/ 最大（侧视）
  const variants = [
    { p: minP, yaw: 0 },
    { p: DEFAULT_BODY, yaw: 0 },
    { p: maxP, yaw: 0 },
    { p: maxP, yaw: Math.PI / 2 },
    { p: DEFAULT_BODY, yaw: Math.PI / 2 },
  ]
  const W = CELL_W * COLS, H = CELL_H
  const big = new Uint8Array(W * H * 3).fill(255)
  const ms = []
  variants.forEach((v, ci) => {
    const pos = v.p === DEFAULT_BODY ? base : buildGeometry(v.p)
    if (ci === 0 || ci === 2) ms[ci === 0 ? 0 : 2] = measure(pos)
    const frame = render(pos, v.yaw, CELL_W, CELL_H)
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) {
        const s = (y * CELL_W + x) * 3
        const d = (y * W + ci * CELL_W + x) * 3
        big[d] = frame[s]; big[d + 1] = frame[s + 1]; big[d + 2] = frame[s + 2]
      }
    }
  })
  const diffs = []
  for (const k of Object.keys(baseM)) {
    const d = ms[2][k] - ms[0][k]
    if (Math.abs(d) > 0.005) diffs.push(`${k} ${ms[0][k]}→${ms[2][k]}`)
  }
  console.log(`${key.padEnd(14)} [${range.min}..${range.max}]  ${diffs.join('  ')}`)
  writePng(outPath.replace(/\.png$/, `-${key}.png`), W, H, big)
}
console.log(`[check-shape] 每参数一张图 → ${outPath.replace(/\.png$/, '-<参数>.png')}`)

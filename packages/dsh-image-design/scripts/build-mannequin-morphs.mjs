// 把 MakeHuman 的稀疏 .target 转成紧凑二进制 + manifest（精确素体的运行资产）。
//
// 为什么自定义格式而不是 glTF morph target：glTF morph 是密集数组（每顶点 3×f32），
// 140 个会到 20MB+；.target 本质是稀疏（平均 2000–3500 非零顶点），用
//   [u16 count, (u16 vertexIdx, f32 dx, f32 dy, f32 dz) × count]
// 只有 ~3MB。量纲：base.obj 是分米制，target 位移同坐标系；测量环求和 ×10 得 cm。
//
// 产物：
//   assets/mannequin-morphs.bin   全部 morph 位移拼接
//   assets/mannequin-morphs.json  manifest：morph 名 → offset/count；21 项测量的顶点环 +
//                                 baseCm（HM08 base 上的实测值，UI 滑杆基准）
//
// 用法：node scripts/build-mannequin-morphs.mjs [srcDir] [outBin] [outJson]

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = process.argv[2] ?? join(here, '..', 'assets', 'morphs-src')
const outBin = process.argv[3] ?? join(here, '..', 'assets', 'mannequin-morphs.bin')
const outJson = process.argv[4] ?? join(here, '..', 'assets', 'mannequin-morphs.json')

const MAX_BODY_VERTEX = 13380 // body 组 = 前 13380 顶点（003 已确认连续块）

// ── 1) 收集所有 .target 文件 ───────────────────────────────────────────────
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.target')) out.push(p)
  }
  return out
}
const files = walk(srcDir).sort()
if (files.length === 0) throw new Error(`没有找到 .target：${srcDir}（先跑 fetch-makehuman-morphs.mjs）`)

// ── 2) 解析 .target，写紧凑二进制，记录 manifest ───────────────────────────
const chunks = []
const morphs = {}
let cursor = 0
for (const file of files) {
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue
    const p = line.trim().split(/\s+/)
    const idx = Number(p[0])
    if (!Number.isInteger(idx) || idx >= MAX_BODY_VERTEX) continue
    rows.push([idx, Number(p[1]), Number(p[2]), Number(p[3])])
  }
  // 布局：u32 count + (u16 idx + f32 dx/dy/dz) × count
  const buf = Buffer.alloc(4 + rows.length * 14)
  buf.writeUInt32LE(rows.length, 0)
  let off = 4
  for (const [idx, dx, dy, dz] of rows) {
    buf.writeUInt16LE(idx, off); off += 2
    buf.writeFloatLE(dx, off); off += 4
    buf.writeFloatLE(dy, off); off += 4
    buf.writeFloatLE(dz, off); off += 4
  }
  const name = relative(srcDir, file).replace(/\.target$/, '').replace(/^target\//, '')
  morphs[name] = { offset: cursor, count: rows.length, bytes: buf.length }
  chunks.push(buf)
  cursor += buf.length
}
const bin = Buffer.concat(chunks)
writeFileSync(outBin, bin)

// ── 3) OBJ 顶点 + 从 Python 源提取 Ruler 顶点环 ────────────────────────────
const objPath = join(srcDir, '..', 'makehuman-base.obj')
const pts = [] // [x, y, z][]（分米，OBJ 顶点序）
if (existsSync(objPath)) {
  for (const line of readFileSync(objPath, 'utf8').split('\n')) {
    if (!line.startsWith('v ')) continue
    const p = line.trim().split(/\s+/)
    pts.push([Number(p[1]), Number(p[2]), Number(p[3])])
  }
} else {
  console.warn('[build-morphs] 缺 makehuman-base.obj：shoulder-breadth 与 baseCm 将跳过')
}

const pyPath = join(srcDir, 'measurement-ruler.py')
const rings = {}
if (existsSync(pyPath)) {
  const py = readFileSync(pyPath, 'utf8')
  const re = /self\.Measures\['measure\/(measure-[^']+)'\]\s*=\s*\[([^\]]+)\]/g
  let m
  while ((m = re.exec(py)) !== null) {
    const name = m[1].replace(/-decr\|incr$/, '')
    const idx = m[2].split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n))
    rings[name] = idx
  }
}

// ── 3b) 真肩宽环 shoulder-breadth（左右肩峰两点）─────────────────────────────
// MakeHuman 的 measure-shoulder-dist 只有两个顶点 [7478, 8274]，实测是
// 「颈根(7478) → 右肩峰(8274)」的单侧斜距 ≈14.7cm，不是肩宽；UI 按 39cm 用会
// 卡在求解上限（只能到 20cm）。真肩宽要取左右肩峰：对 8274 求 x 镜像点。
// 这里动态算镜像（残差 <1e-4 才算匹配），并另立 shoulder-breadth 测量项，
// 复用 measure-shoulder-dist-incr/decr 作调节 morph（实测 w=1 时肩宽 +5cm）。
{
  const APEX = 8274 // MakeHuman Ruler 里的右肩峰顶点
  const a = pts[APEX]
  if (a !== undefined) {
    let mirror = -1
    let best = Infinity
    for (let i = 0; i < MAX_BODY_VERTEX; i++) {
      const p = pts[i]
      if (p === undefined) continue
      const d = Math.hypot(p[0] + a[0], p[1] - a[1], p[2] - a[2])
      if (i !== APEX && d < best) { best = d; mirror = i }
    }
    if (mirror >= 0 && best < 1e-4) {
      rings['measure-shoulder-breadth'] = [mirror, APEX]
      console.log(`[build-morphs] 肩宽环 = [${mirror}, ${APEX}]（镜像残差 ${best.toExponential(1)}）`)
    } else {
      console.warn('[build-morphs] 肩峰镜像点匹配失败，跳过 shoulder-breadth')
    }
  }
}

// ── 3c) baseCm：每项测量在 HM08 base 上的实测值 ────────────────────────────
// UI 滑杆的基准值必须与资产实测一致，此前手填的 21 项有 13 项不符（2026-11-17
// 审计实测，最大偏差 frontchest 18 vs 27.2）。改为构建期实测写进 manifest，
// UI 运行时经 readAsset 读 manifest 取值，禁止再手填。
function ringCm(ring) {
  let sum = 0
  let prev = ring[0]
  for (const cur of ring) {
    const a = pts[prev]
    const b = pts[cur]
    if (a === undefined || b === undefined) return -1
    sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    prev = cur
  }
  return 10 * sum
}

// 合成测量项：真肩宽没有自己的 target，复用 measure-shoulder-dist 的调节 morph。
const SYNTHETIC_MEASUREMENTS = [
  { name: 'shoulder-breadth', target: 'measure-shoulder-dist', morph: 'measure/measure-shoulder-dist' },
]

// ── 4) 从 modifiers json 提取测量名与分组 ──────────────────────────────────
const modPath = join(srcDir, 'modifiers', 'measurement_modifiers.json')
const measurements = []
if (existsSync(modPath)) {
  const mods = JSON.parse(readFileSync(modPath, 'utf8'))
  for (const group of mods) {
    for (const mod of group.modifiers ?? []) {
      const name = mod.target.replace(/-decr\|incr$/, '').replace(/^measure-/, '')
      measurements.push({ name, target: mod.target })
    }
  }
}

const allMeasurements = [...measurements, ...SYNTHETIC_MEASUREMENTS]
for (const m of allMeasurements) {
  const ring = rings[`measure-${m.name}`]
  const baseCm = ring !== undefined ? ringCm(ring) : -1
  if (baseCm >= 0) m.baseCm = Number(baseCm.toFixed(2))
}
const manifest = {
  version: 2,
  sourceCommit: 'a8bc2d54ff0ac92e78ff71431b1023eda42bf482',
  baseMesh: 'MakeHuman HM08 (CC0), body = 前 13380 顶点',
  unit: 'base 与 target 位移均为分米制；围度测量求和后 ×10 得 cm',
  byteOrder: 'little-endian; morph = u32 count + (u16 vertexIndex + f32 dx + f32 dy + f32 dz) × count',
  morphs,
  measurements: allMeasurements,
  rings,
}
writeFileSync(outJson, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')

console.log(`[build-morphs] ${files.length} morph → ${(bin.length / 1024 / 1024).toFixed(2)} MB bin`)
console.log(`[build-morphs] ${measurements.length} 项测量, ${Object.keys(rings).length} 个顶点环 → ${outJson}`)

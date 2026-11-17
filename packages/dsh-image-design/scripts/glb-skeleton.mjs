// GLB 骨架探针：直接解析 GLB 的 JSON chunk（不需要解压网格），dump 节点层级、
// 蒙皮骨骼名、包围盒，做两件事：
//   1) 核对 mixamorig 骨名（bindRig 的映射依据）
//   2) 核对 rest 朝向与模型正背朝向（相机 / 姿势轴向的依据）
//
// 用法：node --experimental-strip-types scripts/glb-skeleton.mjs

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const buf = readFileSync(join(here, '..', 'assets', 'soldier.glb'))

// GLB: magic(4) version(4) length(4) | chunk: len(4) type(4) data
const jsonLen = buf.readUInt32LE(12)
const jsonType = buf.readUInt32LE(16)
if (jsonType !== 0x4e4f534a) throw new Error('第一个 chunk 不是 JSON')
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))

const nodes = gltf.nodes ?? []
console.log('nodes:', nodes.length, 'meshes:', (gltf.meshes ?? []).length, 'skins:', (gltf.skins ?? []).length)

// 节点索引 → 名称
const nameOf = (i) => nodes[i]?.name ?? `#${i}`

// 打印 mixamorig 节点及其父
const parentOf = new Array(nodes.length).fill(-1)
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => { parentOf[c] = i }))

console.log('\n── mixamorig 节点（含父）──')
for (let i = 0; i < nodes.length; i++) {
  const n = nodes[i]
  if (!n.name?.includes('mixamorig')) continue
  console.log(`  ${String(i).padStart(3)} ${n.name.padEnd(30)} parent=${parentOf[i] >= 0 ? nameOf(parentOf[i]) : '-'}`)
}

// 骨骼名（skin 里引用的 joints）
console.log('\n── skin joints（前 30）──')
const skin = (gltf.skins ?? [])[0]
if (skin !== undefined) {
  console.log('  joints count:', skin.joints.length)
  console.log('  ', skin.joints.slice(0, 30).map((j) => nameOf(j)).join(', '))
}

// 根节点与整体变换
console.log('\n── 根节点 ──')
const roots = nodes.map((_, i) => i).filter((i) => parentOf[i] === -1)
for (const r of roots) {
  console.log(`  ${nameOf(r)}`, JSON.stringify({ t: nodes[r].translation, r: nodes[r].rotation, s: nodes[r].scale, children: (nodes[r].children ?? []).length }))
}

// 网格包围盒（用 accessor min/max，够看尺度）
console.log('\n── 各 primitive 包围盒（原始单位）──')
for (const [mi, m] of (gltf.meshes ?? []).entries()) {
  for (const [pi, p] of (m.primitives ?? []).entries()) {
    const acc = gltf.accessors?.[p.attributes?.POSITION]
    if (acc?.min === undefined) continue
    console.log(`  mesh${mi}.prim${pi}: min=[${acc.min.map((v) => v.toFixed(3))}] max=[${acc.max.map((v) => v.toFixed(3))}]`)
  }
}

// 节点变换统计：看 rest 朝向的关键节点
const show = ['mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigNeck', 'mixamorigHead', 'mixamorigLeftShoulder', 'mixamorigLeftArm', 'mixamorigLeftForeArm', 'mixamorigLeftUpLeg', 'mixamorigLeftLeg']
console.log('\n── 关键节点 rest 变换 ──')
for (const nm of show) {
  const i = nodes.findIndex((n) => n.name === nm)
  if (i < 0) { console.log(`  ${nm}: 未找到`); continue }
  const n = nodes[i]
  console.log(`  ${nm.padEnd(28)} t=${JSON.stringify(n.translation ?? [0, 0, 0])} r=${JSON.stringify(n.rotation ?? [0, 0, 0, 1])} s=${JSON.stringify(n.scale ?? [1, 1, 1])}`)
}

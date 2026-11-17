// 骨骼轴向探针：从 GLB 的 JSON chunk 重建节点层级（three Object3D），算每根骨的
// rest 世界朝向与「骨轴方向」（子节点位置差），用于核对：
//   · LeftArm/RightArm 的 rest 臂轴方向（决定落臂补偿的旋转轴与符号）
//   · LeftUpLeg 的腿轴、Head 的朝向（决定正背朝向）
//   · 身高（米）

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'

const here = dirname(fileURLToPath(import.meta.url))
const buf = readFileSync(join(here, '..', 'assets', 'soldier.glb'))
const jsonLen = buf.readUInt32LE(12)
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
const nodes = gltf.nodes ?? []

// 重建层级
const objs = nodes.map((n) => {
  const o = new THREE.Object3D()
  o.name = n.name ?? ''
  if (n.translation !== undefined) o.position.fromArray(n.translation)
  if (n.rotation !== undefined) o.quaternion.fromArray(n.rotation)
  if (n.scale !== undefined) o.scale.fromArray(n.scale)
  return o
})
const parentOf = new Array(nodes.length).fill(-1)
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => { parentOf[c] = i }))
nodes.forEach((n, i) => {
  const kids = n.children ?? []
  for (const c of kids) objs[i].add(objs[c])
})
const roots = nodes.map((_, i) => i).filter((i) => parentOf[i] === -1)
const scene = new THREE.Group()
for (const r of roots) scene.add(objs[r])
scene.updateMatrixWorld(true)

// 找节点
const byName = new Map()
scene.traverse((o) => { if (o.name !== '') byName.set(o.name.replace(/:/g, ''), o) })

const axisOf = (boneName, childName) => {
  const b = byName.get(boneName)
  const c = byName.get(childName)
  if (b === undefined || c === undefined) return null
  const dir = c.getWorldPosition(new THREE.Vector3()).sub(b.getWorldPosition(new THREE.Vector3()))
  return dir
}

const fmt = (v) => v === null ? 'null' : `[${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}]`

console.log('── 骨轴方向（rest）──')
console.log('LeftArm  → LeftForeArm :', fmt(axisOf('mixamorigLeftArm', 'mixamorigLeftForeArm')))
console.log('RightArm → RightForeArm:', fmt(axisOf('mixamorigRightArm', 'mixamorigRightForeArm')))
console.log('LeftUpLeg → LeftLeg    :', fmt(axisOf('mixamorigLeftUpLeg', 'mixamorigLeftLeg')))
console.log('Spine1 → Spine2        :', fmt(axisOf('mixamorigSpine1', 'mixamorigSpine2')))
console.log('Head → HeadTop_End     :', fmt(axisOf('mixamorigHead', 'mixamorigHeadTop_End')))
console.log('Hips → Spine           :', fmt(axisOf('mixamorigHips', 'mixamorigSpine')))

// 世界朝向（分解成欧拉）
const eulerOf = (nm) => {
  const b = byName.get(nm)
  if (b === undefined) return 'null'
  const q = b.getWorldQuaternion(new THREE.Quaternion())
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ')
  return `x=${e.x.toFixed(3)} y=${e.y.toFixed(3)} z=${e.z.toFixed(3)}`
}
console.log('\n── 关键骨 rest 世界欧拉 ──')
for (const nm of ['mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigNeck', 'mixamorigHead', 'mixamorigLeftShoulder', 'mixamorigLeftArm', 'mixamorigLeftForeArm', 'mixamorigLeftUpLeg', 'mixamorigLeftLeg']) {
  console.log(`  ${nm.padEnd(26)} ${eulerOf(nm)}`)
}

// 身高：所有骨的包围盒（骨骼位置不含皮肤外扩，但够量级）
const box = new THREE.Box3()
scene.traverse((o) => { if (o.name.startsWith('mixamorig')) box.expandByPoint(o.getWorldPosition(new THREE.Vector3())) })
console.log('\n骨骼点包围盒:', fmt(box.min), fmt(box.max), ' 高度(m):', (box.max.y - box.min.y).toFixed(3))

// 正背朝向线索：Head 的「前方」= 面部朝向。Mixamo 骨骼的 Head 本地 +z 通常指向面正前方
const head = byName.get('mixamorigHead')
if (head !== undefined) {
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()))
  console.log('Head 本地 +z（面部朝向）在世界系:', fmt(fwd))
}

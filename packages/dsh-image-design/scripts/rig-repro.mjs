// 姿势合成复现探针：从 GLB JSON 重建骨架 → bindRig → applyRigPose(a-pose)，
// 打印每根关键骨应用后的世界朝向与骨轴方向，与渲染结果对照定位。

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { bindRig, applyRigPose } from '../src/client/mannequin/rig.ts'
import { poseJoints } from '../src/client/mannequin/poses.ts'

const here = dirname(fileURLToPath(import.meta.url))
const buf = readFileSync(join(here, '..', 'assets', 'xbot.glb'))
const jsonLen = buf.readUInt32LE(12)
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
const nodes = gltf.nodes ?? []

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
nodes.forEach((n, i) => { for (const c of n.children ?? []) objs[i].add(objs[c]) })
const scene = new THREE.Group()
for (const i of nodes.map((_, i) => i).filter((i) => parentOf[i] === -1)) scene.add(objs[i])
scene.updateMatrixWorld(true)

const byName = new Map()
scene.traverse((o) => { if (o.name !== '') byName.set(o.name.replace(/:/g, ''), o) })

const fmt = (v) => `[${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}]`
const axis = (a, b) => byName.get(b).getWorldPosition(new THREE.Vector3()).sub(byName.get(a).getWorldPosition(new THREE.Vector3()))

const binding = bindRig(scene)
console.log('bindRig OK，绑定骨数:', binding.bones.size)

const before = {
  'LeftArm→ForeArm': axis('mixamorigLeftArm', 'mixamorigLeftForeArm'),
  'RightArm→ForeArm': axis('mixamorigRightArm', 'mixamorigRightForeArm'),
}
applyRigPose(binding, poseJoints('a-pose'))
scene.updateMatrixWorld(true)

const after = {
  'LeftArm→ForeArm': axis('mixamorigLeftArm', 'mixamorigLeftForeArm'),
  'RightArm→ForeArm': axis('mixamorigRightArm', 'mixamorigRightForeArm'),
  'LeftUpLeg→Leg': axis('mixamorigLeftUpLeg', 'mixamorigLeftLeg'),
  'Head→HeadTop': axis('mixamorigHead', 'mixamorigHeadTop_End'),
}
console.log('\n── 应用 a-pose 后骨轴 ──')
for (const k of Object.keys(after)) console.log(`  ${k.padEnd(22)} before=${fmt(before[k] ?? new THREE.Vector3())} after=${fmt(after[k])}`)

// 应用后各骨世界欧拉
const eulerOf = (nm) => {
  const b = byName.get(nm)
  const e = new THREE.Euler().setFromQuaternion(b.getWorldQuaternion(new THREE.Quaternion()), 'XYZ')
  return `x=${e.x.toFixed(3)} y=${e.y.toFixed(3)} z=${e.z.toFixed(3)}`
}
console.log('\n── 应用后世界欧拉 ──')
for (const nm of ['mixamorigLeftShoulder', 'mixamorigLeftArm', 'mixamorigLeftForeArm', 'mixamorigSpine2', 'mixamorigHead']) {
  console.log(`  ${nm.padEnd(26)} ${eulerOf(nm)}`)
}

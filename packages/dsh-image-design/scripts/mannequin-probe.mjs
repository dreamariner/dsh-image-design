// 素体几何探针：Node 直接跑 buildBody，dump 每个 mesh 的世界包围盒，
// 找相邻体块之间的真实间隙（背景色缺口 = 包围盒不相交）。
// 用 node --experimental-strip-types 直跑（无渲染依赖，three 只建几何）。

import { buildBody, DEFAULT_BODY } from '../src/client/mannequin/body.ts'
import * as THREE from 'three'

const body = buildBody(DEFAULT_BODY)
body.root.updateMatrixWorld(true)

const rows = []
body.root.traverse((obj) => {
  const mesh = obj
  if (mesh.isMesh !== true) return
  const box = new THREE.Box3().setFromObject(mesh)
  const path = []
  let cur = mesh
  while (cur && cur !== body.root) {
    path.unshift(cur.name || cur.type)
    cur = cur.parent
  }
  rows.push({ path: path.join('/'), mesh: mesh.geometry.type, box: {
    x: [+box.min.x.toFixed(3), +box.max.x.toFixed(3)],
    y: [+box.min.y.toFixed(3), +box.max.y.toFixed(3)],
    z: [+box.min.z.toFixed(3), +box.max.z.toFixed(3)],
  } })
})

for (const r of rows) {
  console.log(r.path.padEnd(46), r.mesh.padEnd(16), `x[${r.box.x}] y[${r.box.y}] z[${r.box.z}]`)
}

// 关键衔接断言：两两包围盒是否相交（x/y/z 三轴同时重叠才算物理相连）
function overlaps(a, b) {
  return a.x[0] <= b.x[1] && b.x[0] <= a.x[1] && a.y[0] <= b.y[1] && b.y[0] <= a.y[1] && a.z[0] <= b.z[1] && b.z[0] <= a.z[1]
}
const find = (sub) => rows.filter((r) => r.path.includes(sub))
const pairs = [
  ['躯干上段 vs 躯干下段', find('LatheGeometry')],
  ['骨盆球 vs 左大腿', find('pelvis').concat(find('hipL')), find('hipL')],
]
console.log('\n── 相邻体块相交检查 ──')
const upper = rows.filter((r) => r.path.startsWith('spine/') && r.mesh === 'LatheGeometry')
const lower = rows.filter((r) => r.mesh === 'LatheGeometry' && !r.path.startsWith('spine/'))
if (upper.length && lower.length) {
  console.log('上段 vs 下段:', overlaps(upper[0].box, lower[0].box))
}
const pelvis = rows.find((r) => r.path === 'pelvis' || r.path.startsWith('pelvis'))
const thighL = rows.find((r) => r.path.startsWith('hipL/'))
if (pelvis && thighL) console.log('骨盆球 vs 左大腿上端:', overlaps(pelvis.box, thighL.box))

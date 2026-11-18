// 素体离线渲染（带紧身衣）：读 assets/mannequin-body.glb → 建壳 → 蒙皮 → 软件光栅出 PNG。
//
// 为什么带壳：HM08 是裸体网格，直接渲染会把裸体带进评审/会话（安全审查风险）。
// 这里复用运行时的 buildSuit（同一套权重场与阈值），渲染结果 = 面板里的样子。
//
// 用法：
//   node --experimental-strip-types scripts/preview-mannequin.mjs <poseId> <out.png>
//   GRID=1 node --experimental-strip-types scripts/preview-mannequin.mjs x <out.png>  8 姿势 ×（正/侧）
//   YAW=1.5708 node --experimental-strip-types scripts/preview-mannequin.mjs sit <out.png>  侧视
//   HAND=1 node --experimental-strip-types scripts/preview-mannequin.mjs sit <out.png>  只出手

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { NodeIO } from '@gltf-transform/core'
import { poseJoints, POSES } from '../src/client/mannequin/poses.ts'
import { JOINT_BONES } from '../src/client/mannequin/rig.ts'
import { buildSuit } from '../src/client/mannequin/suit.ts'
import { computeBodyMetrics, poseTargets } from '../src/client/mannequin/targets.ts'
import { PoseSolver } from '../src/client/mannequin/solver.ts'
import { loadRigFixture } from '../tests/helpers/rig-fixture.ts'
import { createSolverHostFixture } from '../tests/helpers/solver-host.ts'

const here = dirname(fileURLToPath(import.meta.url))
const glbPath = process.env.GLB ?? join(here, '..', 'assets', 'mannequin-body.glb')
const poseId = process.argv[2] ?? 'a-pose'
const outPath = process.argv[3] ?? '/tmp/mh-preview/mannequin.png'
const GRID = process.env.GRID === '1'
const YAW = process.env.YAW ? Number(process.env.YAW) : 0
const HAND = process.env.HAND === '1'

// ── 读 GLB ────────────────────────────────────────────────────────────────
const io = new NodeIO()
const doc = await io.read(glbPath)
const root = doc.getRoot()
const prim = root.listMeshes()[0].listPrimitives()[0]
const pos = prim.getAttribute('POSITION').getArray()
const nor = prim.getAttribute('NORMAL').getArray()
const joints = prim.getAttribute('JOINTS_0').getArray()
const weights = prim.getAttribute('WEIGHTS_0').getArray()
const indices = prim.getIndices().getArray()
const skin = root.listSkins()[0]
const jointNodes = skin.listJoints()

const localOf = (node) => node.getTranslation() ?? [0, 0, 0]
const parentOf = new Map()
for (const node of root.listNodes()) {
  const p = node.getParentNode()
  if (p !== null) parentOf.set(node.getName(), p.getName())
}
const bindWorld = new Map()
for (const node of jointNodes) {
  const name = node.getName()
  const t = localOf(node)
  const pn = parentOf.get(name)
  const pt = pn !== undefined ? bindWorld.get(pn) : [0, 0, 0]
  bindWorld.set(name, [t[0] + pt[0], t[1] + pt[1], t[2] + pt[2]])
}
const zSign = 1

// ── 四元数工具 ────────────────────────────────────────────────────────────
const mulQ = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]
const quatFromEulerXYZ = (x, y, z) => {
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2)
  const cy = Math.cos(y / 2), sy = Math.sin(y / 2)
  const cz = Math.cos(z / 2), sz = Math.sin(z / 2)
  return mulQ(mulQ([sx, 0, 0, cx], [0, sy, 0, cy]), [0, 0, sz, cz])
}
const rot = (v, q) => {
  const [x, y, z] = v
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3]
  const ix = qw * x + qy * z - qz * y
  const iy = qw * y + qz * x - qx * z
  const iz = qw * z + qx * y - qy * x
  const iw = -qx * x - qy * y - qz * z
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ]
}

function poseBones(poseTable, rootOffset) {
  const eulerOf = new Map()
  for (const [joint, bone] of Object.entries(JOINT_BONES)) {
    const r = poseTable[joint] ?? { x: 0, y: 0, z: 0 }
    eulerOf.set(bone, [r.x, r.y, r.z * zSign])
  }
  const poseWorld = new Map()
  const poseQuat = new Map()
  for (const node of jointNodes) {
    const name = node.getName()
    const e = eulerOf.get(name)
    const q = e === undefined ? [0, 0, 0, 1] : quatFromEulerXYZ(e[0], e[1], e[2])
    const pn = parentOf.get(name)
    const parentQ = pn !== undefined ? poseQuat.get(pn) : [0, 0, 0, 1]
    const pq = mulQ(parentQ, q)
    poseQuat.set(name, pq)
    const local = localOf(node)
    const parentPos = pn !== undefined ? poseWorld.get(pn) : [0, 0, 0]
    const rp = rot([local[0], local[1], local[2]], parentQ)
    // 根位移（求解器的 root：髋在模型空间的位置）只作用于髋骨（根）✓
    const off = name === 'mixamorigHips' && rootOffset !== undefined ? rootOffset : [0, 0, 0]
    poseWorld.set(name, [parentPos[0] + rp[0] + off[0], parentPos[1] + rp[1] + off[1], parentPos[2] + rp[2] + off[2]])
  }
  return { poseWorld, poseQuat }
}

/** 蒙皮：skinned = Σ w * (worldPose ∘ IBM) * v（世界坐标，米）。 */
function skinMesh(positions, skinIndex, skinWeight, poseTable, rootOffset) {
  const { poseWorld, poseQuat } = poseBones(poseTable, rootOffset)
  const vcount = positions.length / 3
  const skinned = new Float32Array(positions.length)
  for (let vi = 0; vi < vcount; vi++) {
    const v = [positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]]
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[vi * 4 + k]
      if (w <= 1e-6) continue
      const name = jointNodes[skinIndex[vi * 4 + k]].getName()
      const wp = poseWorld.get(name)
      const bw = bindWorld.get(name)
      const pv = rot([v[0] - bw[0], v[1] - bw[1], v[2] - bw[2]], poseQuat.get(name))
      x += w * (wp[0] + pv[0]); y += w * (wp[1] + pv[1]); z += w * (wp[2] + pv[2])
    }
    skinned[vi * 3] = x; skinned[vi * 3 + 1] = y; skinned[vi * 3 + 2] = z
  }
  return skinned
}

// ── 紧身衣壳（复用运行时 buildSuit）────────────────────────────────────────
const boneList = jointNodes.map((n) => ({ name: n.getName() }))
const neckY = bindWorld.get('mixamorigNeck')?.[1] ?? 1.4
const hipY = bindWorld.get('mixamorigLeftUpLeg')?.[1] ?? 0.9
const kneeY = bindWorld.get('mixamorigLeftLeg')?.[1] ?? 0.5
const suit = buildSuit({
  position: new THREE.BufferAttribute(pos.slice(), 3),
  normal: new THREE.BufferAttribute(nor.slice(), 3),
  skinIndex: new THREE.BufferAttribute(joints.slice(), 4),
  skinWeight: new THREE.BufferAttribute(weights.slice(), 4),
  boneList,
  index: Array.from(indices),
  shortsHemY: (hipY + kneeY) / 2,
  necklineY: neckY,
})
const suitPos = suit.geometry.getAttribute('position').array
const suitNor = suit.geometry.getAttribute('normal').array
const suitIndex = suit.geometry.getIndex().array
const suitSkinIndex = suit.geometry.getAttribute('skinIndex').array
const suitSkinWeight = suit.geometry.getAttribute('skinWeight').array
console.log(`[suit] 壳顶点 ${suitPos.length / 3} 三角形 ${suitIndex.length / 3}`)

// ── 渲染 ───────────────────────────────────────────────────────────────────
/** 投影参数：由参考网格的包围盒算出（所有网格共用同一投影，否则各画各的会错位）。 */
function makeProjection(cam, W, H, yaw, crop) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const range = crop ?? Array.from({ length: cam.length / 3 }, (_, i) => i)
  for (const i of range) {
    const x = cam[i * 3] * cy + cam[i * 3 + 2] * sy
    const y = cam[i * 3 + 1]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const span = Math.max(maxX - minX, maxY - minY)
  const scale = (Math.min(W, H) * 0.94) / span
  const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2
  return {
    px: (x) => (x - ox) * scale + W / 2,
    py: (y) => H - ((y - oy) * scale + H / 2),
  }
}

function renderMesh(mesh, cam, W, H, yaw, zbuf, color, proj) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  const v = new Float32Array(cam.length)
  for (let i = 0; i < cam.length / 3; i++) {
    const x = cam[i * 3], y = cam[i * 3 + 1], z = cam[i * 3 + 2]
    v[i * 3] = x * cy + z * sy
    v[i * 3 + 1] = y
    v[i * 3 + 2] = -x * sy + z * cy
  }
  const { px, py } = proj
  const put = (x, y, z, rgb) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = y * W + x
    if (z >= zbuf[i]) return
    zbuf[i] = z
    color[i * 3] = rgb[0]; color[i * 3 + 1] = rgb[1]; color[i * 3 + 2] = rgb[2]
  }
  const light = [-0.35, 0.45, 0.82]
  const idx = mesh.index
  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2]
    const a = [v[ia * 3], v[ia * 3 + 1], v[ia * 3 + 2]]
    const b = [v[ib * 3], v[ib * 3 + 1], v[ib * 3 + 2]]
    const c = [v[ic * 3], v[ic * 3 + 1], v[ic * 3 + 2]]
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len
    const sh = Math.max(0.12, 0.32 + 0.68 * Math.abs(nx * light[0] + ny * light[1] + nz * light[2]))
    const rgb = [Math.round(mesh.color[0] * sh), Math.round(mesh.color[1] * sh), Math.round(mesh.color[2] * sh)]
    const x0 = px(a[0]), y0 = py(a[1]), x1 = px(b[0]), y1 = py(b[1]), x2 = px(c[0]), y2 = py(c[1])
    const minx = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxx = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)))
    const miny = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxy = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)))
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (Math.abs(area) < 1e-12) continue
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const pxc = x + 0.5, pyc = y + 0.5
        const w0 = ((x1 - pxc) * (y2 - pyc) - (x2 - pxc) * (y1 - pyc)) / area
        const w1 = ((x2 - pxc) * (y0 - pyc) - (x0 - pxc) * (y2 - pyc)) / area
        const w2 = 1 - w0 - w1
        if (w0 < 0 || w1 < 0 || w2 < 0) continue
        put(x, y, w0 * a[2] + w1 * b[2] + w2 * c[2], rgb)
      }
    }
  }
}

/**
 * 离线求解器（与运行时同源）。
 *
 * 为什么离线也要走求解器：姿势已经不是静态关节表了（005 起是「意图 + 物理」的解），
 * 离线若还渲染静态表，看到的就不是面板里那个姿势 —— 「离线与运行时同源」是验收前提。
 * 这里复用测试夹具的装配（与 viewer 走同一个 `createSolverHost`）✓。
 */
const rigFixture = loadRigFixture()
const solverHost = createSolverHostFixture(rigFixture).host
const bodyMetrics = computeBodyMetrics(
  (n) => rigFixture.byName.get(n)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3())

/** 预设 id → 求解出的关节表 + 骨盆位移（缓存：同一进程里只解一次）。 */
const solvedCache = new Map()
function solvePose(poseId) {
  if (solvedCache.has(poseId)) return solvedCache.get(poseId)
  const targets = poseTargets(poseId, bodyMetrics)
  if (targets === null) { solvedCache.set(poseId, null); return null }
  const solver = new PoseSolver(solverHost)
  solver.setTargets(targets)
  const result = solver.settle()
  const table = {}
  for (const [k, v] of Object.entries(result.joints)) table[k] = { x: v.x, y: v.y, z: v.z }
  // 骨盆位移（相对绑定姿态的髋位置；数组形式与 poseBones 的读取口径一致）
  const rootOffset = [
    targets.root.x,
    targets.root.y - bodyMetrics.hipsY,
    targets.root.z,
  ]
  const out = { table, rootOffset }
  solvedCache.set(poseId, out)
  return out
}

/** 一个姿势的所有网格（身体 + 壳），已蒙皮 + 落地。 */
function poseTable(poseId) {
  // POSE_JSON 环境变量：临时覆盖某些关节（试姿势用，不入库）
  //   额外支持 "_root"：求解器解出的骨盆位移（髋在模型空间的位置）✓
  const over = process.env.POSE_JSON
  if (over !== undefined && over !== '') {
    const table = poseJoints(poseId)
    let rootOffset
    const patch = JSON.parse(over)
    for (const [k, v] of Object.entries(patch)) {
      if (k === '_root') { rootOffset = [v.x ?? 0, v.y ?? 0, v.z ?? 0]; continue }
      table[k] = { x: v.x ?? 0, y: v.y ?? 0, z: v.z ?? 0 }
    }
    return { table, rootOffset }
  }
  // 默认：走求解器（与运行时同源）
  const solved = solvePose(poseId)
  if (solved === null) return { table: poseJoints(poseId), rootOffset: undefined }
  return { table: solved.table, rootOffset: solved.rootOffset }
}

function poseMeshes(poseId) {
  const { table, rootOffset } = poseTable(poseId)
  const body = skinMesh(pos, joints, weights, table, rootOffset)
  // 落地：蒙皮后最低点归零（与 viewer 的 reground 同义）
  let minY = Infinity
  for (let i = 0; i < pos.length / 3; i++) {
    if (pos[i * 3 + 1] > 0.45) continue
    if (body[i * 3 + 1] < minY) minY = body[i * 3 + 1]
  }
  for (let i = 0; i < body.length; i += 3) body[i + 1] -= minY
  // 壳必须带同一个 rootOffset：骨盆位移不传给壳 → 壳停在绑定高度，
  // 坐/跪这类有骨盆位移的姿势会「壳在上、身子在下」（2026-11-18 离线渲染实测）
  const suitSk = skinMesh(suitPos, suitSkinIndex, suitSkinWeight, table, rootOffset)
  for (let i = 0; i < suitSk.length; i += 3) suitSk[i + 1] -= minY
  const meshes = [
    { pos: body, index: Array.from(indices), color: [196, 176, 158] },
    { pos: suitSk, index: Array.from(suitIndex), color: [96, 104, 114] },
  ]
  if (HAND) {
    // 只保留手部（+ 手腕）三角形：评审手部细节时避免带出躯干
    const handBones = new Set(['mixamorigLeftHand', 'mixamorigLeftHandEnd', 'mixamorigRightHand', 'mixamorigRightHandEnd'])
    const dom = (vi) => {
      let bw = 0, bj = 0
      for (let k = 0; k < 4; k++) {
        const w = weights[vi * 4 + k]
        if (w > bw) { bw = w; bj = joints[vi * 4 + k] }
      }
      return jointNodes[bj].getName()
    }
    const keepIdx = []
    const keepVerts = new Set()
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t], b = indices[t + 1], c = indices[t + 2]
      if (handBones.has(dom(a)) && handBones.has(dom(b)) && handBones.has(dom(c))) {
        keepIdx.push(a, b, c)
        keepVerts.add(a); keepVerts.add(b); keepVerts.add(c)
      }
    }
    meshes.length = 0
    meshes.push({ pos: body, index: keepIdx, color: [196, 176, 158] })
    // 投影裁到手部（评审手部细节时全身包围盒会把手缩成几个像素）
    meshes[0].crop = Array.from(keepVerts)
  } else if (process.env.CROP === 'hands') {
    // 只画手 + 大腿（看「手有没有落在大腿面上」用），投影裁到这两块的包围盒
    const want = new Set(['mixamorigLeftHand', 'mixamorigLeftHandEnd', 'mixamorigRightHand', 'mixamorigRightHandEnd',
      'mixamorigLeftUpLeg', 'mixamorigLeftLeg', 'mixamorigRightUpLeg', 'mixamorigRightLeg'])
    const dom = (vi) => {
      let bw = 0, bj = 0
      for (let k = 0; k < 4; k++) {
        const w = weights[vi * 4 + k]
        if (w > bw) { bw = w; bj = joints[vi * 4 + k] }
      }
      return jointNodes[bj].getName()
    }
    const keepIdx = []
    const keepVerts = new Set()
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t], b = indices[t + 1], c = indices[t + 2]
      if (want.has(dom(a)) && want.has(dom(b)) && want.has(dom(c))) {
        keepIdx.push(a, b, c)
        keepVerts.add(a); keepVerts.add(b); keepVerts.add(c)
      }
    }
    meshes.length = 0
    meshes.push({ pos: body, index: keepIdx, color: [196, 176, 158] })
    meshes[0].crop = Array.from(keepVerts)
  }
  return meshes
}

function writePng(path, W, H, color) {
  const raw = Buffer.alloc((W * 3 + 1) * H)
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 3, d = y * (W * 3 + 1) + 1 + x * 3
      raw[d] = color[s]; raw[d + 1] = color[s + 1]; raw[d + 2] = color[s + 2]
    }
  }
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, cc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 2
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]))
}

if (GRID) {
  const ids = POSES.map((p) => p.id)
  const CELL_W = 300, CELL_H = 520
  const cols = 4, rows = Math.ceil((ids.length * 2) / cols)
  const W = CELL_W * cols, H = CELL_H * rows
  const big = new Uint8Array(W * H * 3).fill(255)
  let cell = 0
  for (const id of ids) {
    const meshes = poseMeshes(id)
    for (const yaw of [0, Math.PI / 2]) {
      const zbuf = new Float64Array(CELL_W * CELL_H).fill(Infinity)
      const color = new Uint8Array(CELL_W * CELL_H * 3).fill(255)
      const proj = makeProjection(meshes[0].pos, CELL_W, CELL_H, yaw, meshes[0].crop)
      for (const m of meshes) renderMesh(m, m.pos, CELL_W, CELL_H, yaw, zbuf, color, proj)
      const ox = (cell % cols) * CELL_W
      const oy = Math.floor(cell / cols) * CELL_H
      for (let y = 0; y < CELL_H; y++) {
        for (let x = 0; x < CELL_W; x++) {
          const s = (y * CELL_W + x) * 3
          const d = ((oy + y) * W + ox + x) * 3
          big[d] = color[s]; big[d + 1] = color[s + 1]; big[d + 2] = color[s + 2]
        }
      }
      cell++
    }
  }
  writePng(outPath, W, H, big)
  console.log(`[preview] 网格 ${ids.length} 姿势 ×（正/侧）→ ${outPath}`)
} else {
  const meshes = poseMeshes(poseId)
  const W = 640, H = 900
  const zbuf = new Float64Array(W * H).fill(Infinity)
  const color = new Uint8Array(W * H * 3).fill(255)
  const proj = makeProjection(meshes[0].pos, W, H, YAW, meshes[0].crop)
  for (const m of meshes) renderMesh(m, m.pos, W, H, YAW, zbuf, color, proj)
  writePng(outPath, W, H, color)
  console.log(`[preview] pose=${poseId} → ${outPath}`)
}

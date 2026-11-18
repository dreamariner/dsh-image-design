// 手部特写离线渲染：只取手部顶点（左手或右手），正交投影出 PNG。
//
// 为什么单独渲染手：全身渲染会把裸体网格带进来（安全审查风险），而当前要看的
// 缺陷（爪形手 / 腕角）只在手上。正交投影 + 手部包围盒 = 只出手臂末端。
//
// 用法：
//   node --experimental-strip-types scripts/preview-hand.mjs <poseId> <out.png> [Left|Right]
//   YAW=0.6 node --experimental-strip-types scripts/preview-hand.mjs sit /tmp/h.png Left

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeIO } from '@gltf-transform/core'
import { poseJoints } from '../src/client/mannequin/poses.ts'
import { JOINT_BONES } from '../src/client/mannequin/rig.ts'

const here = dirname(fileURLToPath(import.meta.url))
const glbPath = process.env.GLB ?? join(here, '..', 'assets', 'mannequin-body.glb')
const poseId = process.argv[2] ?? 'sit'
const outPath = process.argv[3] ?? '/tmp/mh-preview/hand.png'
const side = process.argv[4] ?? 'Left'
const YAW = process.env.YAW ? Number(process.env.YAW) : 0

const io = new NodeIO()
const doc = await io.read(glbPath)
const root = doc.getRoot()
const prim = root.listMeshes()[0].listPrimitives()[0]
const pos = prim.getAttribute('POSITION').getArray()
const joints = prim.getAttribute('JOINTS_0').getArray()
const weights = prim.getAttribute('WEIGHTS_0').getArray()
const indices = prim.getIndices().getArray()
const skin = root.listSkins()[0]
const jointNodes = skin.listJoints()

const localOf = (node) => node.getTranslation() ?? [0, 0, 0]
const parentOf = new Map()
for (const node of root.listNodes()) {
  const p = node.getParentNode()
  if (p !== null) parentOf.set(node.name, p.getName())
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

function poseBones(poseTable) {
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
    poseWorld.set(name, [parentPos[0] + rp[0], parentPos[1] + rp[1], parentPos[2] + rp[2]])
  }
  return { poseWorld, poseQuat }
}

function skinPose(poseTable) {
  const { poseWorld, poseQuat } = poseBones(poseTable)
  const vcount = pos.length / 3
  const skinned = new Float32Array(pos.length)
  for (let vi = 0; vi < vcount; vi++) {
    const v = [pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]]
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 4; k++) {
      const w = weights[vi * 4 + k]
      if (w <= 1e-6) continue
      const name = jointNodes[joints[vi * 4 + k]].getName()
      const wp = poseWorld.get(name)
      const bw = bindWorld.get(name)
      const pv = rot([v[0] - bw[0], v[1] - bw[1], v[2] - bw[2]], poseQuat.get(name))
      x += w * (wp[0] + pv[0]); y += w * (wp[1] + pv[1]); z += w * (wp[2] + pv[2])
    }
    skinned[vi * 3] = x; skinned[vi * 3 + 1] = y; skinned[vi * 3 + 2] = z
  }
  return skinned
}

/** 主导骨名（用于筛手部顶点）。 */
const boneNameOf = (vi) => {
  let bw = 0, bj = 0
  for (let k = 0; k < 4; k++) {
    const w = weights[vi * 4 + k]
    if (w > bw) { bw = w; bj = joints[vi * 4 + k] }
  }
  return jointNodes[bj].getName()
}

const handBones = new Set([`mixamorig${side}Hand`, `mixamorig${side}HandEnd`])
const foreBones = new Set([`mixamorig${side}ForeArm`, ...handBones])
// 只画手（+ 手腕一小段），避免带出前臂的裸露皮肤
const keep = []
for (let vi = 0; vi < pos.length / 3; vi++) {
  const nm = boneNameOf(vi)
  if (!handBones.has(nm)) continue
  keep.push(vi)
}
console.log(`[hand] ${side} 手部顶点 ${keep.length}`)

// 只画手部相关三角形（三角形的三个顶点都得属于手部）
const tri = []
for (let t = 0; t < indices.length; t += 3) {
  const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2]
  if (keep.includes(ia) && keep.includes(ib) && keep.includes(ic)) tri.push(ia, ib, ic)
}
console.log(`[hand] 手部三角形 ${tri.length / 3}`)

const skinned = skinPose(poseJoints(poseId))

// 正交投影：包围盒 → 画布
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
for (const vi of keep) {
  const x = skinned[vi * 3], y = skinned[vi * 3 + 1], z = skinned[vi * 3 + 2]
  if (x < minX) minX = x; if (x > maxX) maxX = x
  if (y < minY) minY = y; if (y > maxY) maxY = y
  if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
}
const cy = Math.cos(YAW), sy = Math.sin(YAW)
const rx = (x, z) => x * cy + z * sy
const rz = (x, z) => -x * sy + z * cy
let rxMin = Infinity, rxMax = -Infinity
for (const vi of keep) {
  const r = rx(skinned[vi * 3], skinned[vi * 3 + 2])
  if (r < rxMin) rxMin = r; if (r > rxMax) rxMax = r
}
const W = 700, H = 700
const spanX = Math.max(rxMax - rxMin, (maxY - minY) * 1.05, 0.12)
const spanY = Math.max(maxY - minY, spanX)
const scale = Math.min(W, H) * 0.82 / Math.max(spanX, spanY)
const ox = (rxMin + rxMax) / 2, oy = (minY + maxY) / 2
const px = (x) => (x - ox) * scale + W / 2
const py = (y) => H - ((y - oy) * scale + H / 2)

const zbuf = new Float64Array(W * H).fill(Infinity)
const color = new Uint8Array(W * H * 3).fill(255)
const put = (x, y, z, val) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = y * W + x
  if (z >= zbuf[i]) return
  zbuf[i] = z
  color[i * 3] = val; color[i * 3 + 1] = val; color[i * 3 + 2] = val
}
const light = [-0.3, 0.5, 0.8]
for (let t = 0; t < tri.length; t += 3) {
  const ia = tri[t], ib = tri[t + 1], ic = tri[t + 2]
  const a = [rx(skinned[ia * 3], skinned[ia * 3 + 2]), skinned[ia * 3 + 1], rz(skinned[ia * 3], skinned[ia * 3 + 2])]
  const b = [rx(skinned[ib * 3], skinned[ib * 3 + 2]), skinned[ib * 3 + 1], rz(skinned[ib * 3], skinned[ib * 3 + 2])]
  const c = [rx(skinned[ic * 3], skinned[ic * 3 + 2]), skinned[ic * 3 + 1], rz(skinned[ic * 3], skinned[ic * 3 + 2])]
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  nx /= len; ny /= len; nz /= len
  const sh = Math.max(0.1, 0.3 + 0.7 * Math.abs(nx * light[0] + ny * light[1] + nz * light[2]))
  const val = Math.round(255 * Math.min(1, sh))
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
      put(x, y, w0 * a[2] + w1 * b[2] + w2 * c[2], val)
    }
  }
}

// PNG
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
writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]))
console.log(`[hand] pose=${poseId} side=${side} → ${outPath}`)

// 素体离线预览：读 assets/mannequin-body.glb → 蒙皮 → 软件光栅出 PNG。
//
// 为什么需要：不靠浏览器就能验骨架与姿势（骨轴、朝向、蒙皮撕裂），迭代快得多。
// 用法：
//   node --experimental-strip-types scripts/preview-body.mjs <poseId> <out.png>   单姿势
//   GRID=1 node --experimental-strip-types scripts/preview-body.mjs x <out.png>  全部姿势拼图
//   YAW=1.5708 ...                                                          侧视（弧度）

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeIO } from '@gltf-transform/core'
import { poseJoints, POSES } from '../src/client/mannequin/poses.ts'
import { JOINT_BONES } from '../src/client/mannequin/rig.ts'

const here = dirname(fileURLToPath(import.meta.url))
const glbPath = join(here, '..', 'assets', 'mannequin-body.glb')
const poseId = process.argv[2] ?? 'a-pose'
const outPath = process.argv[3] ?? '/tmp/mh-preview/body.png'
const GRID = process.env.GRID === '1'
const YAW = process.env.YAW ? Number(process.env.YAW) : 0

// ── 读 GLB ────────────────────────────────────────────────────────────────
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
  if (p !== null) parentOf.set(node.getName(), p.getName())
}
/** 绑定姿态下各骨的世界位置（局部旋转全是单位阵 → 直接累加平移） */
const bindWorld = new Map()
for (const node of jointNodes) {
  const name = node.getName()
  const t = localOf(node)
  const pn = parentOf.get(name)
  const pt = pn !== undefined ? bindWorld.get(pn) : [0, 0, 0]
  bindWorld.set(name, [t[0] + pt[0], t[1] + pt[1], t[2] + pt[2]])
}

// 角色左在世界系 = +x（面朝 +z）→ zSign = 1
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
  // 与 three.js Euler 'XYZ' 一致：q = qx * qy * qz
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

// ── 蒙皮：skinned = Σ w * (worldPose ∘ IBM) * v ──────────────────────────
/** 姿势后的骨世界位姿（位置 + 朝向）。父先于子级联。 */
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
    // 子骨世界位置 = 父骨世界位置 + 父骨世界朝向 × 子骨局部位移
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

// ── 软件光栅（单帧 → 灰度）───────────────────────────────────────────────
function renderFrame(cam, W, H, yaw) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  const v = new Float32Array(cam.length)
  for (let i = 0; i < cam.length / 3; i++) {
    const x = cam[i * 3], y = cam[i * 3 + 1], z = cam[i * 3 + 2]
    v[i * 3] = x * cy + z * sy
    v[i * 3 + 1] = y
    v[i * 3 + 2] = -x * sy + z * cy
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < v.length / 3; i++) {
    const x = v[i * 3], y = v[i * 3 + 1]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const span = Math.max(maxX - minX, maxY - minY)
  const scale = (Math.min(W, H) * 0.92) / span
  const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2
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
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2]
    const a = [v[ia * 3], v[ia * 3 + 1], v[ia * 3 + 2]]
    const b = [v[ib * 3], v[ib * 3 + 1], v[ib * 3 + 2]]
    const c = [v[ic * 3], v[ic * 3 + 1], v[ic * 3 + 2]]
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
    if (Math.abs(area) < 1e-9) continue
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const pxc = x + 0.5, pyc = y + 0.5
        const w0 = ((x1 - pxc) * (y2 - pyc) - (x2 - pxc) * (y1 - pyc)) / area
        const w1 = ((x2 - pxc) * (y0 - pyc) - (x0 - pxc) * (y2 - pyc)) / area
        const w2 = 1 - w0 - w1
        if (w0 < 0 || w1 < 0 || w2 < 0) continue
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2]
        put(x, y, z, val)
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

// ── 关节点世界坐标（调姿势用：数字比眼力准）──────────────────────────────
const LANDMARKS = [
  ['头', 'mixamorigHead'], ['颈', 'mixamorigNeck'],
  ['左肩', 'mixamorigLeftArm'], ['左肘', 'mixamorigLeftForeArm'], ['左手', 'mixamorigLeftHand'],
  ['右肩', 'mixamorigRightArm'], ['右肘', 'mixamorigRightForeArm'], ['右手', 'mixamorigRightHand'],
  ['骨盆', 'mixamorigHips'], ['左髋', 'mixamorigLeftUpLeg'], ['左膝', 'mixamorigLeftLeg'],
  ['左踝', 'mixamorigLeftFoot'], ['左脚尖', 'mixamorigLeftToeBase'],
  ['右髋', 'mixamorigRightUpLeg'], ['右膝', 'mixamorigRightLeg'],
  ['右踝', 'mixamorigRightFoot'], ['右脚尖', 'mixamorigRightToeBase'],
]
function printLandmarks(poseTable) {
  const { poseWorld: pw } = poseBones(poseTable)
  console.log(`── ${poseId} 关节点世界坐标（x 右为角色左 / y 上 / z 前）──`)
  for (const [label, bone] of LANDMARKS) {
    const w = pw.get(bone)
    if (w === undefined) continue
    console.log(`  ${label.padEnd(6)} x=${w[0].toFixed(3).padStart(7)} y=${w[1].toFixed(3).padStart(7)} z=${w[2].toFixed(3).padStart(7)}`)
  }
}

// ── 出图 ──────────────────────────────────────────────────────────────────
if (GRID) {
  const ids = POSES.map((p) => p.id)
  const CELL_W = 250, CELL_H = 440
  const cols = Math.ceil(ids.length / 2)
  const W = CELL_W * cols, H = CELL_H * 2
  const big = new Uint8Array(W * H * 3).fill(255)
  ids.forEach((id, i) => {
    const frame = renderFrame(skinPose(poseJoints(id)), CELL_W, CELL_H, i % 2 === 0 ? 0 : Math.PI / 2)
    const ox = (i % cols) * CELL_W
    const oy = Math.floor(i / cols) * CELL_H
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) {
        const s = (y * CELL_W + x) * 3
        const d = ((oy + y) * W + ox + x) * 3
        big[d] = frame[s]; big[d + 1] = frame[s + 1]; big[d + 2] = frame[s + 2]
      }
    }
  })
  writePng(outPath, W, H, big)
  console.log(`[preview] 网格（左列正视 / 右列侧视）: ${ids.join(', ')} → ${outPath}`)
} else {
  printLandmarks(poseJoints(poseId))
  const color = renderFrame(skinPose(poseJoints(poseId)), 520, 900, YAW)
  writePng(outPath, 520, 900, color)
  console.log(`[preview] pose=${poseId} → ${outPath}`)
}

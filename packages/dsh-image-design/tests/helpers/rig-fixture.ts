// 测试夹具：从 GLB 还原骨架与蒙皮数据，供姿势几何门禁使用。
//
// 为什么要还原而不是 mock：姿势数值错在「几何」上（膝盖朝反、整个人浮空），
// 只有真骨架 + 真蒙皮权重才能量出来。这里解析的 GLB 与实际渲染用的是同一个文件，
// 数学则复用运行时同一套 three 对象（applyRigPose / lowestSkinnedY）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { JOINT_BONES } from '../../src/client/mannequin/rig.ts'
import type { JointName } from '../../src/client/mannequin/body.ts'

const ASSET_DIR = join(import.meta.dirname, '..', '..', 'assets')

interface Gltf {
  json: Record<string, any>
  bin: Buffer
}

function readGlb(path: string): Gltf {
  const buf = readFileSync(path)
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  let off = 20 + jsonLen
  let bin = Buffer.alloc(0)
  while (off < buf.length) {
    const chunkLen = buf.readUInt32LE(off)
    const chunkType = buf.readUInt32LE(off + 4)
    if (chunkType === 0x004e4942) bin = buf.subarray(off + 8, off + 8 + chunkLen)
    off += 8 + chunkLen
  }
  return { json, bin }
}

const COMPONENT: Record<number, { Arr: any; size: number }> = {
  5120: { Arr: Int8Array, size: 1 },
  5121: { Arr: Uint8Array, size: 1 },
  5122: { Arr: Int16Array, size: 2 },
  5123: { Arr: Uint16Array, size: 2 },
  5125: { Arr: Uint32Array, size: 4 },
  5126: { Arr: Float32Array, size: 4 },
}
const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

function readAccessor(gltf: Gltf, index: number): { data: Float32Array; n: number; count: number } {
  const a = gltf.json.accessors[index]
  const bv = gltf.json.bufferViews[a.bufferView]
  const { Arr, size } = COMPONENT[a.componentType]
  const n = TYPE_SIZE[a.type]
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
  const stride = bv.byteStride ?? size * n
  const out = new Float32Array(a.count * n)
  for (let k = 0; k < a.count; k++) {
    const typed = new Arr(gltf.bin.buffer, gltf.bin.byteOffset + start + k * stride, n)
    for (let c = 0; c < n; c++) out[k * n + c] = typed[c]
  }
  return { data: out, n, count: a.count }
}

export interface RigFixture {
  /** 关节名 → 骨对象（已按 glTF 层级建好，matrixWorld 最新于 A-pose）。 */
  bones: Map<JointName, THREE.Object3D>
  /** 骨名（mixamorigXxx）→ 对象，用于取落地高度。 */
  byName: Map<string, THREE.Object3D>
  /** 场景根，用于 updateMatrixWorld。 */
  root: THREE.Object3D
  position: THREE.BufferAttribute
  normal: THREE.BufferAttribute
  skinIndex: THREE.BufferAttribute
  skinWeight: THREE.BufferAttribute
  /** 三角形索引（贴皮分段/覆盖判定用）。 */
  index: number[]
  boneList: THREE.Object3D[]
  boneInverses: THREE.Matrix4[]
  /** 落地候选顶点（A-pose 下 y < 0.45m）。 */
  probe: number[]
  /** 角色左手世界方向符号（与 bindRig 一致）。 */
  zSign: number
  /** 绑定姿态（A-pose）下各骨的世界位置快照：测试要读「绑定姿态的坐标」时用它，
   *  别读当前骨位（前面的用例会把姿势改掉，坐标就脏了）。 */
  bindWorld: Map<string, THREE.Vector3>
}

export function loadRigFixture(): RigFixture {
  const gltf = readGlb(join(ASSET_DIR, 'mannequin-body.glb'))
  const nodes: any[] = gltf.json.nodes
  const byName = new Map<string, THREE.Object3D>()
  const objs: THREE.Object3D[] = nodes.map(() => new THREE.Object3D())

  nodes.forEach((node, i) => {
    const obj = objs[i]
    obj.name = node.name ?? `node-${i}`
    if (node.matrix !== undefined) {
      obj.matrix.fromArray(node.matrix)
      obj.matrix.decompose(obj.position, obj.quaternion, obj.scale)
    }
    const t = node.translation
    if (t !== undefined) obj.position.set(t[0], t[1], t[2])
    const r = node.rotation
    if (r !== undefined) obj.quaternion.set(r[0], r[1], r[2], r[3])
    const s = node.scale
    if (s !== undefined) obj.scale.set(s[0], s[1], s[2])
    byName.set(obj.name, obj)
  })

  const root = new THREE.Group()
  root.name = 'fixture-root'
  const parents = new Set<number>()
  nodes.forEach((node, i) => {
    for (const c of node.children ?? []) {
      objs[i].add(objs[c])
      parents.add(c)
    }
  })
  nodes.forEach((_, i) => {
    if (!parents.has(i)) root.add(objs[i])
  })
  root.updateMatrixWorld(true)

  const bones = new Map<JointName, THREE.Object3D>()
  for (const [joint, boneName] of Object.entries(JOINT_BONES)) {
    const bone = byName.get(boneName)
    if (bone === undefined) throw new Error(`夹具缺骨：${boneName}`)
    bones.set(joint as JointName, bone)
  }
  const leftShoulder = bones.get('shoulderL') as THREE.Object3D
  const zSign = leftShoulder.getWorldPosition(new THREE.Vector3()).x >= 0 ? 1 : -1

  const prim = gltf.json.meshes[0].primitives[0]
  const pos = readAccessor(gltf, prim.attributes.POSITION)
  const nrm = readAccessor(gltf, prim.attributes.NORMAL)
  const jnt = readAccessor(gltf, prim.attributes.JOINTS_0)
  const wgt = readAccessor(gltf, prim.attributes.WEIGHTS_0)
  const position = new THREE.BufferAttribute(pos.data, 3)
  const normal = new THREE.BufferAttribute(nrm.data, 3)
  const skinIndex = new THREE.BufferAttribute(jnt.data, 4)
  const skinWeight = new THREE.BufferAttribute(wgt.data, 4)
  // 三角形索引（贴皮分段/覆盖判定用）；顶点索引 < 2^24，readAccessor 的 Float32 承载无损。
  // accessor 读出的可能是 Uint16 风格整数值，统一转成普通数组方便 ArrayLike 消费。
  const index: number[] = prim.indices !== undefined
    ? Array.from(readAccessor(gltf, prim.indices).data)
    : []

  const skin = gltf.json.skins[0]
  const boneList = skin.joints.map((ni: number) => objs[ni])
  const ibm = readAccessor(gltf, skin.inverseBindMatrices)
  const boneInverses = skin.joints.map((_: number, k: number) => {
    const m = new THREE.Matrix4()
    const slice = Array.from(ibm.data.subarray(k * 16, k * 16 + 16))
    m.fromArray(slice)
    return m
  })

  const probe: number[] = []
  for (let i = 0; i < pos.count; i++) if (position.getY(i) < 0.45) probe.push(i)

  // 绑定姿态的骨位快照（加载时抓一份，之后用例改姿势也不影响）
  root.updateMatrixWorld(true)
  const bindWorld = new Map<string, THREE.Vector3>()
  for (const [name, obj] of byName) bindWorld.set(name, obj.getWorldPosition(new THREE.Vector3()))
  return { bones, byName, root, position, normal, skinIndex, skinWeight, index, boneList, boneInverses, probe, zSign, bindWorld }
}

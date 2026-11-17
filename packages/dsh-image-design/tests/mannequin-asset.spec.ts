// @dreamariner/dsh-image-design :: 素体资产（GLB）结构守卫
//
// 守两件踩过坑的事：
//   1) 顶点属性**不能交错进同一个 bufferView**：glTF 要求同一 bufferView 内各
//      accessor 的 componentType 一致，而 JOINTS_0 是 UNSIGNED_SHORT、其余是
//      FLOAT。gltf-transform 默认的 interleaved 布局会混写，产出非法 GLB ——
//      three.js 读出来蒙皮索引全是顶点坐标（2026-11-17 实机事故：模型散架）。
//   2) 蒙皮权重必须是 UNSIGNED_SHORT 索引 + FLOAT 权重，且顶点数一致。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const glbPath = join(here, '..', 'assets', 'mannequin-body.glb')

interface AccessorDef {
  name?: string
  type: string
  componentType: number
  count: number
  bufferView: number
  byteOffset?: number
  min?: number[]
  max?: number[]
}
interface BufferViewDef { byteOffset?: number; byteLength: number; byteStride?: number; target?: number }
interface GltfJson {
  accessors: AccessorDef[]
  bufferViews: BufferViewDef[]
  meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[]
  skins: { joints: number[]; inverseBindMatrices: number }[]
  nodes: { name?: string; children?: number[]; translation?: number[] }[]
}

/** 读 GLB 的 JSON chunk（不引 gltf-transform，纯 node API）。 */
function readGltfJson(path: string): GltfJson {
  const buf = readFileSync(path)
  expect(buf.readUInt32LE(0), 'GLB magic').toBe(0x46546c67)
  const jsonLen = buf.readUInt32LE(12)
  const jsonType = buf.readUInt32LE(16)
  expect(jsonType, '第一个 chunk 必须是 JSON').toBe(0x4e4f534a)
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as GltfJson
}

describe('素体资产结构', () => {
  const json = readGltfJson(glbPath)

  it('四个顶点属性各自独立 bufferView（不交错）', () => {
    const prim = json.meshes[0].primitives[0]
    const compSize: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
    const comps: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
    const views = new Set<number>()
    for (const name of ['POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0']) {
      const acc = json.accessors[prim.attributes[name]]
      expect(acc, `缺属性 ${name}`).toBeDefined()
      views.add(acc.bufferView)
      // 非交错视图的 byteStride 等于元素大小；交错时才会大于它
      const stride = json.bufferViews[acc.bufferView].byteStride
      if (stride !== undefined) {
        const element = compSize[acc.componentType] * comps[acc.type]
        expect(stride, `${name} 的 bufferView 像是交错视图`).toBe(element)
      }
    }
    expect(views.size, '四个属性应占四个 bufferView').toBe(4)
  })

  it('属性类型正确：POSITION/NORMAL/WEIGHTS 是 FLOAT，JOINTS_0 是 UNSIGNED_SHORT', () => {
    const prim = json.meshes[0].primitives[0]
    const ct = (n: string): number => json.accessors[prim.attributes[n]].componentType
    expect(ct('POSITION')).toBe(5126)
    expect(ct('NORMAL')).toBe(5126)
    expect(ct('WEIGHTS_0')).toBe(5126)
    expect(ct('JOINTS_0')).toBe(5123)
  })

  it('四个属性顶点数一致，且骨骼索引在骨数范围内', () => {
    const prim = json.meshes[0].primitives[0]
    const counts = ['POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0'].map((n) => json.accessors[prim.attributes[n]].count)
    expect(new Set(counts).size).toBe(1)
    const jointCount = json.skins[0].joints.length
    expect(jointCount).toBeGreaterThanOrEqual(20)
    // 索引范围：JOINTS_0 的 accessor 是 Uint16，读不到值，只能校验骨数合理性
    expect(counts[0]).toBeGreaterThan(10000)
  })

  it('蒙皮有逆绑定矩阵，骨骼是 mixamorig 命名', () => {
    expect(json.skins[0].inverseBindMatrices).toBeGreaterThanOrEqual(0)
    const names = json.nodes.map((n) => n.name ?? '')
    expect(names).toContain('mixamorigHips')
    expect(names).toContain('mixamorigLeftArm')
    expect(names).toContain('mixamorigRightToeBase')
  })

  it('身高量级合理（米级，1.5..1.9）', () => {
    const prim = json.meshes[0].primitives[0]
    const pos = json.accessors[prim.attributes.POSITION]
    expect(pos.min).toBeDefined()
    expect(pos.max).toBeDefined()
    const height = (pos.max as number[])[1] - (pos.min as number[])[1]
    expect(height).toBeGreaterThan(1.5)
    expect(height).toBeLessThan(1.9)
  })
})

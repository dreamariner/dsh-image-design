// morph 资产加载与解析：从外部文件（readAsset Remote）读 manifest + bin，
// 解析成可直接查询的 MorphData，供测量求解器与 GPU 叠加使用。
//
// 资产走外部文件而非内联：client 产物是单文件 CJS，运行期无可靠相对资源 URL；
// host 通过 readAsset(name) 从包目录读作 base64，client 解码成字节。

import type { MeasurementDef } from './measure.ts'

/** 单个 morph 的稀疏位移（base 顶点索引 + 分米制位移增量）。 */
export interface MorphData {
  name: string
  count: number
  /** 顶点索引（body 组前 13380）。 */
  indices: Uint16Array
  /** 位移增量，xyz 交错（分米）。 */
  deltas: Float32Array
}

/** manifest 中单个 morph 的元信息。 */
interface MorphMeta {
  offset: number
  count: number
  bytes: number
}

/** manifest 结构（与 build-mannequin-morphs.mjs 产物一致）。 */
export interface MorphManifest {
  version: number
  sourceCommit: string
  baseMesh: string
  unit: string
  byteOrder: string
  morphs: Record<string, MorphMeta>
  measurements: Array<{ name: string; target: string; morph?: string; baseCm?: number }>
  rings: Record<string, number[]>
}

/** 加载完成的全套 morph 资产。 */
export interface MorphAssets {
  manifest: MorphManifest
  data: Map<string, MorphData>
  measurements: MeasurementDef[]
}

/** base64 → 字节（浏览器 atob）。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * 解析 morph bin：小端 u32 count + (u16 idx + f32 dx/dy/dz) × count。
 */
export function parseMorphBin(
  bytes: Uint8Array,
  manifest: MorphManifest,
): Map<string, MorphData> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Map<string, MorphData>()
  for (const [name, meta] of Object.entries(manifest.morphs)) {
    const count = view.getUint32(meta.offset, true)
    if (count !== meta.count) {
      throw new Error(`morph ${name} 顶点数不符：manifest=${meta.count} bin=${count}`)
    }
    const indices = new Uint16Array(count)
    const deltas = new Float32Array(count * 3)
    let off = meta.offset + 4
    for (let i = 0; i < count; i++) {
      indices[i] = view.getUint16(off, true); off += 2
      deltas[i * 3] = view.getFloat32(off, true); off += 4
      deltas[i * 3 + 1] = view.getFloat32(off, true); off += 4
      deltas[i * 3 + 2] = view.getFloat32(off, true); off += 4
    }
    out.set(name, { name, count, indices, deltas })
  }
  return out
}

/** 从 manifest 组装测量项定义（顶点环 + 名称 + 构建期实测基准）。 */
export function toMeasurementDefs(manifest: MorphManifest): MeasurementDef[] {
  return manifest.measurements.map((m) => ({
    name: m.name,
    target: m.target,
    morph: m.morph,
    ring: manifest.rings[`measure-${m.name}`] ?? [],
    baseCm: m.baseCm,
  })).filter((d) => d.ring.length > 0)
}

/**
 * 从 readAsset 的两个 base64 载入 morph 资产。
 * @param jsonBase64 manifest.json 的 base64
 * @param binBase64 morph bin 的 base64
 */
export function parseMorphAssets(jsonBase64: string, binBase64: string): MorphAssets {
  const jsonText = new TextDecoder().decode(base64ToBytes(jsonBase64))
  const manifest = JSON.parse(jsonText) as MorphManifest
  if (manifest.version < 1 || manifest.version > 2) {
    throw new Error(`未知的 morph manifest 版本：${manifest.version}`)
  }
  const data = parseMorphBin(base64ToBytes(binBase64), manifest)
  return { manifest, data, measurements: toMeasurementDefs(manifest) }
}

/** 资产文件名（readAsset 白名单用）。 */
export const MORPH_MANIFEST_FILE = 'mannequin-morphs.json'
export const MORPH_BIN_FILE = 'mannequin-morphs.bin'
export const BODY_GLB_FILE = 'mannequin-body.glb'

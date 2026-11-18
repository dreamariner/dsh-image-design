// 人体测量求解器：输入 cm 尺寸 → 求解 morph 权重 → 实测围度命中目标。
//
// 1:1 复刻 MakeHuman 的 Ruler.getMeasure + MeasurementValueConverter.displayToData
// （CC0，0_modeling_a_measurement.py）。已由 tests/morph-precision.spec.ts 守卫：
// 20 项围度输入目标 cm，求解后实测误差 <0.01cm。
//
// 量纲：base 顶点与 morph 位移都是分米制；围度 = 环上相邻顶点距离求和 ×10 → cm。

import type { MorphData, MorphManifest } from './morph.ts'

/** 全套测量解算结果（含最终几何）。 */
export interface MeasureSolveResult {
  results: MeasureResult[]
  /** 应用了全部测量 morph 后的坐标（分米）。 */
  coord: Float32Array
}

/** 单项测量结果。 */
export interface MeasureResult {
  /** 测量名（如 bust-circ）。 */
  name: string
  /** 用户目标 cm。 */
  targetCm: number
  /** 当前几何的实测 cm。 */
  measuredCm: number
  /** 求解得到的 incr/decr 权重（可正可负）。 */
  weight: number
}

/** 测量项定义（来自 manifest）。 */
export interface MeasurementDef {
  name: string
  target: string
  /** 顶点环（base 顶点索引）。 */
  ring: number[]
  /**
   * 调节用的 morph 基名（`<morph>-incr` / `<morph>-decr`）。
   * 缺省时用 `measure/measure-<name>`；合成测量项（如 shoulder-breadth 复用
   * measure-shoulder-dist）必须显式给出。
   */
  morph?: string
  /** HM08 base 上的实测 cm（构建期由 build-mannequin-morphs.mjs 写入，UI 滑杆基准）。 */
  baseCm?: number
}

/**
 * 环上围度（cm）：相邻顶点距离求和 ×10。
 * @param coord 当前顶点坐标（前 13380 顶点，xyz 交错，分米制）
 */
export function circumference(ring: number[], coord: Float32Array): number {
  let sum = 0
  let prev = ring[0]
  for (const cur of ring) {
    const a = prev * 3
    const b = cur * 3
    sum += Math.hypot(coord[a] - coord[b], coord[a + 1] - coord[b + 1], coord[a + 2] - coord[b + 2])
    prev = cur
  }
  return 10 * sum
}

/**
 * 把一个 morph 的稀疏位移叠加到 base 坐标，产出新坐标（就地写 out）。
 * 供测量计算用（CPU）；渲染把坐标烘焙进 geometry，两者数据同源。
 */
export function applyMorphToBase(
  base: Float32Array,
  morph: MorphData,
  weight: number,
  out: Float32Array,
): Float32Array {
  if (out !== base) out.set(base)
  for (let i = 0; i < morph.count; i++) {
    const idx = morph.indices[i]
    const o = idx * 3
    out[o] += weight * morph.deltas[i * 3]
    out[o + 1] += weight * morph.deltas[i * 3 + 1]
    out[o + 2] += weight * morph.deltas[i * 3 + 2]
  }
  return out
}

/**
 * 应用一个测量 modifier 权重（MakeHuman 语义）：w>=0 走 incr，w<0 走 decr，
 * 只叠加单侧。这与之前「两侧同时叠加」不同——后者会让解算发散。
 */
export function applyMeasureModifier(
  base: Float32Array,
  incr: MorphData,
  decr: MorphData,
  w: number,
  out: Float32Array,
): Float32Array {
  return applyMorphToBase(base, w >= 0 ? incr : decr, Math.abs(w), out)
}

/**
 * 二分搜索：给定目标 cm，求 measure 项 incr/decr 的权重。
 * 复刻 MakeHuman displayToData 语义，但范围放宽到 [-1, 2]（incr 侧允许 200% 外推，
 * 对标 CC 的 morph 外推；base bust 80cm 时 w=1 只到 97cm，更大目标需外推）、
 * 16 次迭代（区间 3/2^16 ≈ 4.6e-5，远低于 0.01cm 收敛线）。
 *
 * @param def 测量项定义（含顶点环）
 * @param incr incr morph
 * @param decr decr morph
 * @param base base 顶点坐标（应用了宏观/雕刻 morph 之后，测量层在其上再解）
 * @param goalCm 目标 cm
 * @returns 权重与最终实测 cm
 */
export function solveMeasurement(
  def: MeasurementDef,
  incr: MorphData,
  decr: MorphData,
  base: Float32Array,
  goalCm: number,
): { weight: number; measuredCm: number } {
  const scratch = new Float32Array(base.length)
  const coordAt = (w: number): Float32Array => applyMeasureModifier(base, incr, decr, w, scratch)
  let value = 0
  let m = circumference(def.ring, coordAt(value))
  // 范围放宽到 [-1, 2]：incr 侧允许 200% 外推（对标 CC 的 morph 外推），
  // base bust 80cm 时 w=1 只到 97cm，更大目标需外推。
  let min = -1, max = 2
  for (let tries = 0; tries < 16 && Math.abs(m - goalCm) >= 0.01; tries++) {
    if (goalCm < m) {
      max = value
      value = min + (value - min) / 2
    } else {
      min = value
      value = value + (max - value) / 2
    }
    m = circumference(def.ring, coordAt(value))
  }
  return { weight: value, measuredCm: m }
}

/**
 * 解算所有测量项：多轮迭代求解。
 *
 * MakeHuman 的测量 modifier 只是「近似解耦」——IEEE Virtual Caliper 论文验证
 * 局部尺寸调整对相邻部位影响较小，但实测（tests/shape3.spec.ts）发现叠加后
 * 胸围偏差可达 4.5cm：后续项（腰/臀/雕刻）的 morph 会带动先前项的顶点环。
 * 故采用迭代精修：每轮对所有目标项重新求解，直到全部收敛或到迭代上限。
 *
 * @param iterations 迭代轮数（默认 4，实测 3 轮内收敛到 <0.5cm）
 */
export function solveAllMeasurements(
  defs: MeasurementDef[],
  targetsCm: Record<string, number>,
  data: Map<string, MorphData>,
  baseAfterSculpt: Float32Array,
  iterations = 4,
): MeasureSolveResult {
  const coord = new Float32Array(baseAfterSculpt.length)
  coord.set(baseAfterSculpt)
  const weights: Record<string, number> = {}
  const active = defs.filter((d) => targetsCm[d.name] !== undefined)

  for (let pass = 0; pass < iterations; pass++) {
    for (const def of active) {
      const goal = targetsCm[def.name]
      const morphBase = def.morph ?? `measure/measure-${def.name}`
      const incr = data.get(`${morphBase}-incr`)
      const decr = data.get(`${morphBase}-decr`)
      if (incr === undefined || decr === undefined) continue
      // 先把该项上一轮的权重从 coord 撤掉，避免重复叠加。
      // 撤销必须用「同一个 morph × 负权重」，不能走 applyMeasureModifier(-prev)
      // ——后者会在 prev>0 时错误地改用 decr morph。
      const prev = weights[def.name] ?? 0
      if (Math.abs(prev) > 1e-6) {
        applyMorphToBase(coord, prev >= 0 ? incr : decr, -prev, coord)
      }
      const { weight } = solveMeasurement(def, incr, decr, coord, goal)
      weights[def.name] = weight
      applyMeasureModifier(coord, incr, decr, weight, coord)
    }
  }

  // 最终复测：在完整 coord 上量每项真实围度（这时已含全部 morph 耦合）
  const results = active.map((def) => {
    const goal = targetsCm[def.name]
    const measuredCm = circumference(def.ring, coord)
    return { name: def.name, targetCm: goal, measuredCm, weight: weights[def.name] ?? 0 }
  })
  return { results, coord }
}

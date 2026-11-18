// 精确素体形变引擎：三层 morph 叠加到 base 网格（替代 003 的解析场 shape.ts）。
//
// 叠加顺序（测量最后，保证 cm 精度不被雕刻破坏）：
//   1) base 顶点（分米制，绑定姿态）
//   2) 性别基 morph（caucasian-female-young ↔ caucasian-male-young 插值）
//      —— HM08 是中性网格，男女差异全部是位移；性别决定骨相/肩宽/骨盆/胸廓
//   3) 乳房形态 morph（cup × firmness 二维档位 + 尖挺/间距/下垂/乳头）
//      —— 与 4) 的 cm 围度解耦：围度只是尺寸，形状靠这一层
//   4) 局部雕刻 morph（肌肉/脂肪/脸/手）+ 宏观 quick 参数
//      —— l- 前缀的 morph 自动补 r- 同权重（MakeHuman 对称 modifier 语义，UI 无单侧控制）
//   5) 测量 morph（21 项 cm）—— 在 2–4 的结果上求解，逐项累积
//
// 关键：只调 measure-bust-circ 会把胸腔一起撑大（实测 w=1：胸 +16.8cm 但下胸也 +12.4cm，
// 乳房峰点只前移 1.1cm），所以女性形态必须靠 cup/firmness，围度求解只做尺寸校准。
//
// 身高与测量口径：holder 按 (身高/100)/localHeight 整体缩放渲染，测量求解若不知道
// 缩放就会回显失真（身高 210cm 时回显 92 实际渲染 114.6，2026-11-17 审计量化）。
// 故 applyPreciseShape 接收 scale：测量目标按 1/scale 换算进求解空间，回显乘回
// scale，保证「实测 cm = 渲染出来的世界 cm」。
//
// 输出：形变后的 position（分米）+ 实测 cm 结果（回显给 UI 校验）。
// 渲染时这些位移已体现在 geometry.position，GPU 无需 morphTargetInfluences
// （我们把 morph 在 CPU 烘焙进 position——顶点数 13380，基准叠加 <10ms，
//  只在参数变化时重算，不是每帧）。

import * as THREE from 'three'
import type { MorphAssets, MorphData } from './morph.ts'
import { applyMorphToBase, circumference, solveAllMeasurements, type MeasureResult } from './measure.ts'

/** 性别基：MakeHuman macrodetails 里真正带位移的两个端点（universal-* 是空占位）。 */
export const MORPH_GENDER_FEMALE = 'macrodetails/caucasian-female-young'
export const MORPH_GENDER_MALE = 'macrodetails/caucasian-male-young'

/** 宏观体型参数。 */
export interface MacroParams {
  /** 性别：0=男性 1=女性。在 caucasian-male-young / caucasian-female-young 之间插值。 */
  gender: number
  /** 年龄：0=年轻 1=老（head-age-incr）。 */
  age: number
  /** 体脂：0=瘦 1=胖（多个 fat/weight morph 组合）。 */
  fat: number
  /** 肌肉：0=少 1=多（ pectoral + arms/legs muscle 组合）。 */
  muscle: number
}

/**
 * 乳房形态参数（决定「像不像女性」，与 cm 围度解耦）。
 * 所有值最终都乘以 gender 淡出——男性体上不产生乳房形变。
 */
export interface BreastParams {
  /** 罩杯 -1..1：-1=mincup，0=averagecup，1=maxcup（三档插值）。 */
  cup: number
  /** 紧致度 -1..1：-1=软塌下垂，0=平均，1=紧实上挺。 */
  firmness: number
  /** 尖挺度 0..1（breast-point-incr）：0=圆润 1=尖挺。 */
  point: number
  /** 间距 0..1（breast-dist-incr）：0=聚拢 1=外扩。 */
  gap: number
  /** 上提/下垂 -1..1：负=上提（trans-up） 正=下垂（trans-down）。 */
  droop: number
  /** 乳头大小 0..1（nipple-size-incr）。 */
  nipple: number
}

/** 精确素体参数（存档快照的运行时形态）。 */
export interface PreciseBodyParams {
  /** 21 项测量目标 cm（仅有值的项参与求解）。 */
  measurementsCm: Record<string, number>
  /** 局部雕刻 morph 权重（morph 名 → 0..1）。 */
  sculpt: Record<string, number>
  /** 宏观体型。 */
  macro: MacroParams
  /** 乳房形态（旧档缺失时用 DEFAULT_BREAST）。 */
  breast: BreastParams
  /** 身高（cm），沿用 003 的整体缩放逻辑（在形变之外）。 */
  height: number
}

export const DEFAULT_MACRO: MacroParams = { gender: 0.5, age: 0.35, fat: 0.5, muscle: 0.4 }
export const DEFAULT_BREAST: BreastParams = { cup: 0, firmness: 0, point: 0, gap: 0, droop: 0, nipple: 0 }

/**
 * 三档权重插值：把 -1..1 的连续值拆成 (min, avg, max) 三个档位的混合权重。
 * v=-1 → min 1.0；v=0 → avg 1.0；v=1 → max 1.0；中间线性。
 */
export function trioWeights(v: number): { min: number; avg: number; max: number } {
  const c = Math.min(1, Math.max(-1, v))
  if (c < 0) return { min: -c, avg: 1 + c, max: 0 }
  return { min: 0, avg: 1 - c, max: c }
}

/** 宏观参数 → 具体 morph 权重贡献（morph 名 → 权重）。 */
export function macroMorphWeights(macro: MacroParams): Record<string, number> {
  const w: Record<string, number> = {}
  const add = (name: string, v: number): void => { w[name] = (w[name] ?? 0) + v }
  // 性别基：两端线性插值（HM08 中性 → 女 / 男）
  const g = Math.min(1, Math.max(0, macro.gender))
  if (g > 1e-4) add(MORPH_GENDER_FEMALE, g)
  if (1 - g > 1e-4) add(MORPH_GENDER_MALE, 1 - g)
  // 年龄：head-age-incr（脸老态）+ neck-double-incr
  add('head/head-age-incr', macro.age)
  add('neck/neck-double-incr', macro.age * 0.5)
  // 体脂：腹部/胸部/上臂/大腿 fat 类 incr（用 tone-decr 近似反向）
  add('stomach/stomach-tone-decr', macro.fat)
  add('armslegs/l-lowerarm-fat-incr', macro.fat * 0.6)
  // 肌肉：胸大肌 + 四肢肌肉 incr
  add('torso/torso-muscle-pectoral-incr', macro.muscle)
  add('armslegs/l-upperarm-muscle-incr', macro.muscle * 0.7)
  add('armslegs/l-upperleg-muscle-incr', macro.muscle * 0.7)
  add('torso/torso-vshape-incr', macro.muscle * 0.5)
  return w
}

/**
 * 乳房参数 → morph 权重。
 *
 * cup × firmness 是 MakeHuman 的二维档位网格（上游缺 averagecup-averagefirmness，
 * 那一格代表零位移基准，权重落在它上面即等于不做任何事）。
 * 全部权重再乘以 gender：男性体上这些 morph 平滑淡出，不会长出乳房。
 */
export function breastMorphWeights(breast: BreastParams, gender: number): Record<string, number> {
  const w: Record<string, number> = {}
  const g = Math.min(1, Math.max(0, gender))
  if (g < 1e-4) return w
  const cup = trioWeights(breast.cup)
  const firm = trioWeights(breast.firmness)
  const CUPS: Array<[keyof typeof cup, string]> = [['min', 'mincup'], ['avg', 'averagecup'], ['max', 'maxcup']]
  const FIRMS: Array<[keyof typeof firm, string]> = [['min', 'minfirmness'], ['avg', 'averagefirmness'], ['max', 'maxfirmness']]
  for (const [ck, cupName] of CUPS) {
    const cw = cup[ck]
    if (cw < 1e-4) continue
    for (const [fk, firmName] of FIRMS) {
      const fw = firm[fk]
      if (fw < 1e-4) continue
      // 上游没有 averagecup-averagefirmness（零位移基准），跳过即可
      if (cupName === 'averagecup' && firmName === 'averagefirmness') continue
      const name = `breast/female-young-averagemuscle-averageweight-${cupName}-${firmName}`
      w[name] = (w[name] ?? 0) + cw * fw * g
    }
  }
  // 单维雕刻（同样按性别淡出）
  const sculpt: Array<[string, number]> = [
    ['breast/breast-point-incr', breast.point],
    ['breast/breast-dist-incr', breast.gap],
    ['breast/nipple-size-incr', breast.nipple],
  ]
  for (const [name, v] of sculpt) {
    if (v > 1e-4) w[name] = (w[name] ?? 0) + Math.min(1, v) * g
  }
  // droop：负=上提（trans-up 位移 y 全为正），正=下垂（trans-down）。与 UI「上提/下垂」
  // 滑杆的 −1..1 顺序一致；2026-11-17 审计修正（原实现两侧映射写反）。
  if (breast.droop < -1e-4) w['breast/breast-trans-up'] = (w['breast/breast-trans-up'] ?? 0) + Math.min(1, -breast.droop) * g
  if (breast.droop > 1e-4) w['breast/breast-trans-down'] = (w['breast/breast-trans-down'] ?? 0) + Math.min(1, breast.droop) * g
  return w
}

/** 形变结果。 */
export interface Shape3Result {
  /** 形变后的 position（分米，写回 geometry）。 */
  position: Float32Array
  /** 测量回显（目标 vs 实测）。 */
  measured: MeasureResult[]
  /** 测量预览（世界 cm）：性别/宏观/雕刻/胸型已应用、**无测量 morph** 时的实测值。
   *  UI 滑杆基准用预览而非 manifest baseCm——baseCm 只是无性别裸网格的值，性别
   *  morph 后胸围等早已漂移，拿它当基准一动滑杆就把目标写成裸网格值，求解器把
   *  性别形变出来的胸压回去（2026-11-18 实机「胸围极速坍塌且滑回原位无法恢复」）。 */
  previews: Array<{ name: string; measuredCm: number }>
}

/**
 * 应用精确体型形变。
 *
 * @param base 绑定姿态原始顶点（分米，xyz 交错）
 * @param assets morph 资产
 * @param params 精确参数
 * @param scale 渲染缩放系数（holder.scale = (身高cm/100)/localHeight）。
 *   测量目标按 1/scale 换算进求解空间，回显乘回 scale，保证回显 = 世界 cm。
 *   缺省 1（等价于素体原始身高）。
 */
export function applyPreciseShape(
  base: Float32Array,
  assets: MorphAssets,
  params: PreciseBodyParams,
  scale = 1,
): Shape3Result {
  const position = new Float32Array(base)

  // 1) 权重合并：性别基 + 乳房形态（≥0，clamp [0,1]）+ 雕刻（−1..1，clamp [-1,1]；
  //    负权重 = incr target 反向形变，clamp 到 [0,1] 曾把负半轴整个打没，2026-11-17 审计）
  const weights: Record<string, number> = { ...macroMorphWeights(params.macro) }
  const breastWeights = breastMorphWeights(params.breast ?? DEFAULT_BREAST, params.macro.gender)
  for (const [name, v] of Object.entries(breastWeights)) {
    weights[name] = Math.min(1, Math.max(0, (weights[name] ?? 0) + v))
  }
  for (const [name, v] of Object.entries(params.sculpt)) {
    weights[name] = Math.min(1, Math.max(-1, (weights[name] ?? 0) + v))
  }

  // 1.5) l-/r- 成对镜像：MakeHuman 的左右对称 modifier 是 l-/r- 两个 target 同权重，
  //      fetch 已把两侧都拉进资产；UI 不提供单侧控制，这里对 l- 名自动补 r- 同权重。
  //      （此前只应用 l- 侧，上臂肌/颧骨/耳大等滑杆全部只形变左半身，审计实测修复。）
  for (const [name, w] of Object.entries(weights)) {
    const m = /^([^/]+)\/l-(.+)$/.exec(name)
    if (m === null) continue
    const r = `${m[1]}/r-${m[2]}`
    weights[r] = (weights[r] ?? 0) + w
  }

  // 2) 应用宏观 + 雕刻 morph 到 position
  const tmp = new Float32Array(base.length)
  for (const [name, w] of Object.entries(weights)) {
    const morph = assets.data.get(name)
    if (morph === undefined || Math.abs(w) < 1e-4) continue
    applyMorphToBase(position, morph, w, tmp)
    position.set(tmp)
  }

  // 2.5) 测量预览：无测量 morph 的当前体形实测（UI 滑杆基准，世界 cm 口径）。
  //       必须在求解前量——求解后 coord 已含测量 morph，预览会随目标值漂移。
  const previews = assets.measurements.map((d) => ({
    name: d.name,
    measuredCm: circumference(d.ring, position) * scale,
  }))

  // 3) 测量求解：在宏观+雕刻结果上迭代求解 cm（多轮收敛，处理 morph 耦合）。
  //    目标按 1/scale 换算（holder 缩放会把求解空间围度再放大 scale 倍）。
  //    返回的 coord 已含全部测量 morph，直接作为最终渲染几何，保证渲染与实测一致。
  const goals: Record<string, number> = {}
  for (const [k, v] of Object.entries(params.measurementsCm)) goals[k] = v / scale
  const solved = solveAllMeasurements(assets.measurements, goals, assets.data, position)
  position.set(solved.coord)

  // 4) 回显换回世界 cm：目标与实测都乘回 scale（目标项要回用户的原始输入）
  const measured = solved.results.map((r) => ({
    name: r.name,
    targetCm: r.targetCm * scale,
    measuredCm: r.measuredCm * scale,
    weight: r.weight,
  }))

  return { position, measured, previews }
}

/**
 * 把形变结果写进 three.js geometry（position 属性，分米坐标需 ×0.1 转米）。
 * 003 的 GLB 顶点是米制，而 base/target 是分米制——写入时统一换算。
 */
export function writePositionToGeometry(
  geometry: THREE.BufferGeometry,
  positionDm: Float32Array,
  dmToMeter: number,
): void {
  const attr = geometry.getAttribute('position') as THREE.BufferAttribute
  const arr = attr.array as Float32Array
  const n = Math.min(arr.length, positionDm.length)
  for (let i = 0; i < n; i++) arr[i] = positionDm[i] * dmToMeter
  attr.needsUpdate = true
  geometry.computeVertexNormals()
}

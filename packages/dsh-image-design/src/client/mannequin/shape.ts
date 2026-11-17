// 体型形变：把「体型参数」落到真实网格上。
//
// 三条纪律（都是踩坑换来的）：
//
//   1) 躯干围度必须**改顶点**，不能只缩放脊柱骨：躯干是跨骨平滑蒙皮的
//      （胸腔同时吃 spine / spine1 / spine2 / 锁骨），单根骨的缩放会被权重
//      稀释，围度几乎看不出来（上一版「滑杆形同虚设」的根因）。
//   2) 躯干围度用**沿身体轴的 1D 剖面**，不用「高度带区域场」：相邻高度带
//      必然重叠，各自叠加会互相抵消：胸围一大，腰围跟着涨（实测：胸围
//      0.6→1.6，腰宽 0.341→0.387）。剖面是单值函数：腰的控制点只由腰滑杆
//      决定，胸动不了腰。
//   3) 区域限定用**蒙皮权重软遮罩**，不用「主导骨」硬判定：跨过主导骨边界
//      会出现硬边（实测：臀围调大在髋部甩出一圈裙状法兰）。
//
// 每个形变组 = 「空间场（胶囊） × 蒙皮权重遮罩」× 一个变换：
//   · 空间场决定作用范围（沿骨轴的胶囊，横向半径 + 轴向半长）
//   · 蒙皮权重遮罩决定归属（相关骨的权重之和，连续 0..1）
//   · 两者相乘 → 边界处处连续，不会出现台阶或接缝。

import * as THREE from 'three'
import { shapeTunes, TORSO_BONES, BONE, type BodyParams, type ShapeGroup, type ShapeTune } from './body.ts'

export interface ShapeContext {
  /** 绑定姿态原始顶点位置（每顶点 3 个 float，geometry 顺序）。 */
  base: Float32Array
  /** 蒙皮骨索引（每顶点 4 个）。 */
  joints: Uint16Array
  /** 蒙皮权重（每顶点 4 个）。 */
  weights: Float32Array
  /** 骨名 → 蒙皮索引。 */
  boneIndex: Map<string, number>
  /** 骨名 → 绑定姿态世界位置（枢轴 / 轴段端点）。 */
  boneWorld: Map<string, THREE.Vector3>
}

/** 形变组：空间场 + 蒙皮权重遮罩 + 变换。 */
interface Group {
  /** 蒙皮权重遮罩骨名（权重之和）。 */
  mask: readonly string[]
  /** 预备：把参数算成这一组要用的常量（每个顶点都会调用 transform，别在里面做重活）。 */
  prepare?(tune: ShapeTune, ctx: ShapeContext): unknown
  /** 空间场：顶点位置的权重（0..1）。 */
  field(p: THREE.Vector3, ctx: ShapeContext, tune: ShapeTune, prep: unknown): number
  /** 变换：把 p 变成变形后的位置（写到 out）。 */
  transform(p: THREE.Vector3, out: THREE.Vector3, tune: ShapeTune, ctx: ShapeContext, prep: unknown): void
}

/** 剖面控制点（绑定空间 y + 缩放值）。 */
export interface ProfilePoint {
  y: number
  v: number
}

/** 剖面曲线（x / z 两条独立曲线 + 单调三次插值）。 */
export interface Profile {
  xs: ProfilePoint[]
  zs: ProfilePoint[]
  slopeX: number[]
  slopeZ: number[]
}

/**
 * 躯干围度剖面：控制点由滑杆系数决定，点间用**单调三次插值（PCHIP）**。
 *
 * 为什么不是「每段 smoothstep」：smoothstep 在每个控制点处导数为 0，剖面会出现
 * 一段段平台，视觉上像「梯田」；而且每个参数只管一段高度带，相邻段的过渡太急，
 * 会出现硬边（实测：臀围 1.5 时髋部像穿了一条短裤）。
 * PCHIP 单调、不过冲、导数连续，过渡平顺 ✓。
 *
 * x（左右）与 z（前后）**分开给控制点**：臀围的横向峰值在髂嵴（0.90），纵深的
 * 峰值在臀部最鼓处（0.88），共用一套控制点会在髂嵴上留下一道折痕。
 *
 * 控制点位置（绑定空间，y 向上）：
 *   0.68 大腿  0.80 臀上  0.88~0.90 骨盆  0.96~0.98 胯腰  1.05 腰
 *   1.13 肋  1.21 胸  1.31 肩  1.44 颈根
 */
export function torsoProfile(scale: number[]): Profile {
  const hip = scale[0] ?? 1
  const waist = scale[1] ?? 1
  const bust = scale[2] ?? 1
  const shoulder = scale[3] ?? 1
  /** 按权重混合各因素（权重和为 1）：s = 1 + Σ w·(factor − 1)。 */
  const mix = (w: { hip?: number; waist?: number; bust?: number; shoulder?: number }): number =>
    1
    + (hip - 1) * (w.hip ?? 0)
    + (waist - 1) * (w.waist ?? 0)
    + (bust - 1) * (w.bust ?? 0)
    + (shoulder - 1) * (w.shoulder ?? 0)
  // 横向：骨盆要「宽而缓」，峰太尖时髂嵴会留折痕（实测臀围 1.5 像穿短裤）
  const xs: ProfilePoint[] = [
    { y: 0.68, v: 1 },
    { y: 0.80, v: mix({ hip: 0.4 }) },
    { y: 0.90, v: mix({ hip: 0.88 }) },
    { y: 0.98, v: mix({ hip: 0.6, waist: 0.4 }) },
    { y: 1.05, v: mix({ waist: 1 }) },
    { y: 1.13, v: mix({ waist: 0.35, bust: 0.5 }) },
    { y: 1.21, v: mix({ bust: 1 }) },
    { y: 1.31, v: mix({ bust: 0.3, shoulder: 0.55 }) },
    { y: 1.44, v: 1 },
  ]
  // 纵深：臀部最鼓处在 0.88，峰值比横向略低，臀围的纵深权重也小于横向
  const zs: ProfilePoint[] = [
    { y: 0.68, v: 1 },
    { y: 0.78, v: mix({ hip: 0.3 }) },
    { y: 0.88, v: mix({ hip: 0.55 }) },
    { y: 0.97, v: mix({ hip: 0.35, waist: 0.45 }) },
    { y: 1.05, v: mix({ waist: 1 }) },
    { y: 1.13, v: mix({ waist: 0.35, bust: 0.3 }) },
    { y: 1.21, v: mix({ bust: 0.5 }) },
    { y: 1.31, v: mix({ bust: 0.25 }) },
    { y: 1.44, v: 1 },
  ]
  const ysX = xs.map((p) => p.y)
  const ysZ = zs.map((p) => p.y)
  return {
    xs,
    zs,
    slopeX: pchipSlopes(ysX, xs.map((p) => p.v)),
    slopeZ: pchipSlopes(ysZ, zs.map((p) => p.v)),
  }
}

/** PCHIP 单调三次插值的斜率（Fritsch–Carlson）。 */
function pchipSlopes(xs: number[], ys: number[]): number[] {
  const n = xs.length
  if (n < 2) return new Array(n).fill(0)
  const h: number[] = []
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i])
    d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
  }
  const m: number[] = new Array(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0
    } else {
      const w1 = 2 * h[i] + h[i - 1]
      const w2 = h[i] + 2 * h[i - 1]
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    }
  }
  // 端点：单侧斜率 + 过冲限制
  const endSlope = (h0: number, h1: number, d0: number, d1: number): number => {
    let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
    if (m * d0 <= 0) return 0
    if (d0 * d1 <= 0 && Math.abs(m) > Math.abs(3 * d0)) return 3 * d0
    return m
  }
  m[0] = endSlope(h[0], h[1], d[0], d[1])
  m[n - 1] = endSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3])
  return m
}

/** 三次 Hermite 求值。 */
function hermite(y0: number, y1: number, m0: number, m1: number, h: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * y0
    + (t3 - 2 * t2 + t) * h * m0
    + (-2 * t3 + 3 * t2) * y1
    + (t3 - t2) * h * m1
}

/** 剖面插值：返回该高度处的 x/z 缩放。 */
export function profileAt(profile: Profile, y: number): [number, number] {
  return [
    profileValue(profile.xs, profile.slopeX, y),
    profileValue(profile.zs, profile.slopeZ, y),
  ]
}

/** 单条剖面曲线求值（PCHIP）。 */
function profileValue(pts: ProfilePoint[], slopes: number[], y: number): number {
  if (pts.length === 0) return 1
  if (y <= pts[0].y) return pts[0].v
  const last = pts[pts.length - 1]
  if (y >= last.y) return last.v
  let i = 0
  while (i < pts.length - 2 && y > pts[i + 1].y) i++
  const a = pts[i]
  const b = pts[i + 1]
  const h = b.y - a.y
  const t = (y - a.y) / h
  return hermite(a.v, b.v, slopes[i], slopes[i + 1], h, t)
}

/** 点到线段的各向异性距离 → 权重（横向半径 radius，轴向半长 half）。 */
function segmentWeight(
  p: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  half: number,
): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-9) return 0
  const ux = dx / len, uy = dy / len, uz = dz / len
  const vx = p.x - a.x, vy = p.y - a.y, vz = p.z - a.z
  const along = vx * ux + vy * uy + vz * uz
  const px = vx - along * ux, py = vy - along * uy, pz = vz - along * uz
  const dPerp = Math.hypot(px, py, pz)
  const dAxis = along < 0 ? -along : (along > len ? along - len : 0)
  const u = Math.sqrt((dPerp / radius) ** 2 + (dAxis / half) ** 2)
  if (u >= 1) return 0
  const w = 1 - u * u
  return w * w
}

/** 沿骨轴的径向放大（绕骨轴线，轴向分量不变 → 关节位置不动）。 */
function radialScale(
  p: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  k: number,
  out: THREE.Vector3,
): void {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const len = Math.hypot(dx, dy, dz) || 1
  const ux = dx / len, uy = dy / len, uz = dz / len
  const vx = p.x - a.x, vy = p.y - a.y, vz = p.z - a.z
  const along = vx * ux + vy * uy + vz * uz
  const px = vx - along * ux, py = vy - along * uy, pz = vz - along * uz
  out.set(
    a.x + along * ux + px * k,
    a.y + along * uy + py * k,
    a.z + along * uz + pz * k,
  )
}

/** 绕枢轴的各向同性缩放。 */
function uniformScale(p: THREE.Vector3, pivot: THREE.Vector3, k: number, out: THREE.Vector3): void {
  out.set(
    pivot.x + (p.x - pivot.x) * k,
    pivot.y + (p.y - pivot.y) * k,
    pivot.z + (p.z - pivot.z) * k,
  )
}

/** 肢体链的采样折线（Catmull-Rom 细分 + 逐点切向）。 */
interface LimbChain {
  /** 采样点（沿骨链）。 */
  pts: THREE.Vector3[]
  /** 每个采样点的单位切向。 */
  tangents: THREE.Vector3[]
  /** 每个采样点的累计弧长（m）。 */
  arc: number[]
  /** 链的总长（m）。 */
  length: number
}

/**
 * 构建肢体链的平滑折线。
 *
 * 为什么不是「一根骨一组」：两段肢体的径向变换在关节处会各套一次，叠加后
 * 关节处鼓出一圈（实测：四肢粗细 1.6 时膝盖上套了个护膝）。一条链只做一次
 * 变换，关节处自然连续 ✓。
 *
 * 为什么还要细分 + 切向：骨链在关节处是折的（大腿 → 小腿的朝向差几度），
 * 直接用骨轴会在关节留下折痕；Catmull-Rom 细分后的切向连续变化 ✓。
 */
function buildLimbChain(bones: string[], ctx: ShapeContext): LimbChain | null {
  const pts: THREE.Vector3[] = []
  for (const name of bones) {
    const p = ctx.boneWorld.get(name)
    if (p === undefined) return null
    pts.push(p.clone())
  }
  if (pts.length < 2) return null
  // Catmull-Rom 细分（端点夹取）
  const SUB = 8
  const samples: THREE.Vector3[] = []
  const at = (i: number): THREE.Vector3 => pts[Math.max(0, Math.min(pts.length - 1, i))]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2)
    for (let s = 0; s < SUB; s++) {
      const t = s / SUB
      const t2 = t * t
      const t3 = t2 * t
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3)
      const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
      const z = 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3)
      samples.push(new THREE.Vector3(x, y, z))
    }
  }
  samples.push(pts[pts.length - 1].clone())
  // 累计弧长
  const arc: number[] = [0]
  for (let i = 1; i < samples.length; i++) {
    arc.push(arc[i - 1] + samples[i].distanceTo(samples[i - 1]))
  }
  // 逐点切向（中心差分）
  const tangents: THREE.Vector3[] = []
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)]
    const b = samples[Math.min(samples.length - 1, i + 1)]
    const d = b.clone().sub(a)
    if (d.lengthSq() < 1e-12) d.set(0, 1, 0)
    tangents.push(d.normalize())
  }
  return { pts: samples, tangents, arc, length: arc[arc.length - 1] }
}

/** 找折线上离 p 最近的采样点。 */
function nearestOnChain(chain: LimbChain, p: THREE.Vector3): { i: number; d: number } {
  let bi = 0
  let bd = Infinity
  for (let i = 0; i < chain.pts.length; i++) {
    const d = chain.pts[i].distanceToSquared(p)
    if (d < bd) { bd = d; bi = i }
  }
  return { i: bi, d: Math.sqrt(bd) }
}

/**
 * 肢体形变组：一条链一次变换。
 *
 * · 空间场 = 到折线的距离（横向半径内衰减到 0）
 * · 蒙皮遮罩 = 链上所有骨的权重
 * · 变换 = 绕链的局部切向做径向放大（沿链方向不变 → 关节位置不动）
 */
function limbChainGroup(bones: string[], radius: number, endFade = 0): Group {
  return {
    mask: bones,
    prepare: (_tune, ctx) => buildLimbChain(bones, ctx),
    field: (p, _ctx, _tune, prep) => {
      const chain = prep as LimbChain | null
      if (chain === null) return 0
      const { i, d } = nearestOnChain(chain, p)
      if (d >= radius) return 0
      const u = d / radius
      const w = 1 - u * u
      // 链末淡出：肢体的最远端（脚掌）不参与加粗，否则脚会被撑成「靴子」
      if (endFade > 0) {
        const remain = chain.length - chain.arc[i]
        if (remain < endFade) {
          const t = Math.max(0, remain) / endFade
          return w * w * (t * t * (3 - 2 * t))
        }
      }
      return w * w
    },
    transform: (p, out, tune, _ctx, prep) => {
      const chain = prep as LimbChain | null
      if (chain === null) { out.copy(p); return }
      const { i } = nearestOnChain(chain, p)
      const pivot = chain.pts[i]
      const dir = chain.tangents[i]
      const k = tune.scale[0] ?? 1
      const vx = p.x - pivot.x, vy = p.y - pivot.y, vz = p.z - pivot.z
      const along = vx * dir.x + vy * dir.y + vz * dir.z
      const px = vx - along * dir.x, py = vy - along * dir.y, pz = vz - along * dir.z
      out.set(
        pivot.x + along * dir.x + px * k,
        pivot.y + along * dir.y + py * k,
        pivot.z + along * dir.z + pz * k,
      )
    },
  }
}

const TORSO_MASK: readonly string[] = [
  ...TORSO_BONES,
  BONE.upLegL, BONE.upLegR,
]

const GROUPS: Record<ShapeGroup, Group> = {
  // 躯干：沿身体轴的围度剖面（绕身体中线缩放 x/z）
  torso: {
    mask: TORSO_MASK,
    prepare: (tune) => torsoProfile(tune.scale),
    field: () => 1,
    transform: (p, out, _tune, _ctx, prep) => {
      const profile = prep as Profile
      const [sx, sz] = profileAt(profile, p.y)
      out.set(p.x * sx, p.y, p.z * sz)
    },
  },
  // 胸廓双峰：底网格是中性体型，纯缩胸腔只是「变厚」，胸围要有局部隆起
  bust: {
    mask: TORSO_MASK,
    prepare: (_tune, ctx) => computeBustCenters(ctx),
    field: (p, _ctx, _tune, prep) => {
      const centers = prep as THREE.Vector3[]
      let best = 0
      for (const c of centers) {
        const dx = p.x - c.x, dy = p.y - c.y
        const r = Math.hypot(dx, dy) / BUST_RADIUS
        if (r >= 1) continue
        // 余弦剖面：中心最大、边缘归零（无硬块）
        const w = 0.5 * (1 + Math.cos(Math.PI * r))
        // 只推胸廓正面
        const front = Math.min(1, Math.max(0, (p.z - (c.z - 0.03)) / 0.05))
        best = Math.max(best, w * front)
      }
      return best
    },
    transform: (p, out, tune) => {
      const k = tune.scale[0] ?? 1
      out.set(p.x, p.y, p.z + (k - 1) * BUST_AMPLITUDE)
    },
  },
  // 头：各向同性缩放（头身比）
  head: {
    mask: [BONE.head],
    field: (p, ctx) => {
      const a = ctx.boneWorld.get(BONE.head)
      const b = ctx.boneWorld.get(BONE.headTop)
      if (a === undefined || b === undefined) return 0
      // 场要够大：头的表面离中轴有距离，场太小的话只缩到一半（头身比打了折）
      return segmentWeight(p, a, b, 0.45, 0.3)
    },
    transform: (p, out, tune, ctx) => {
      const pivot = ctx.boneWorld.get(BONE.head)
      if (pivot === undefined) { out.copy(p); return }
      uniformScale(p, pivot, tune.scale[0] ?? 1, out)
    },
  },
  // 四肢：整条链一次径向放大（分骨做会在关节处各套一次，膝盖上套出「护膝」）
  // 横向场半径要卡在「肢体截面」和「躯干」之间：太大时场的边缘会舔到躯干
  // （实测四肢粗细会顺带把腰围和胸围带偏）
  armL: limbChainGroup([BONE.armL, BONE.foreArmL, BONE.handL, BONE.handEndL], 0.13, 0.1),
  armR: limbChainGroup([BONE.armR, BONE.foreArmR, BONE.handR, BONE.handEndR], 0.13, 0.1),
  legL: limbChainGroup([BONE.upLegL, BONE.legL, BONE.footL, BONE.toeL], 0.22, 0.16),
  legR: limbChainGroup([BONE.upLegR, BONE.legR, BONE.footR, BONE.toeR], 0.22, 0.16),
}

/** 胸廓双峰的横向半径（m）。 */
export const BUST_RADIUS = 0.16
/** 胸廓双峰的最大隆起（胸围系数 1→2 对应 0..BUST_AMPLITUDE 米）。 */
export const BUST_AMPLITUDE = 0.05

/**
 * 应用体型形变到几何体（就地改 position，并重算法线）。
 *
 * @param geometry 目标几何（position / skinIndex / skinWeight 属性齐全）
 * @param ctx      形变上下文
 * @param params   体型参数
 */
export function applyShape(
  geometry: THREE.BufferGeometry,
  ctx: ShapeContext,
  params: BodyParams,
): void {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute
  const count = posAttr.count
  if (count === 0) return

  const tunes = shapeTunes(params)
  const out = new Float32Array(ctx.base.length)
  out.set(ctx.base)

  const p = new THREE.Vector3()
  const q = new THREE.Vector3()

  for (const tune of tunes) {
    const group = GROUPS[tune.group]
    if (group === undefined) continue
    // 遮罩骨的蒙皮索引
    const maskIdx: number[] = []
    for (const name of group.mask) {
      const bi = ctx.boneIndex.get(name)
      if (bi !== undefined) maskIdx.push(bi)
    }
    if (maskIdx.length === 0) continue
    const prep = group.prepare?.(tune, ctx)

    for (let vi = 0; vi < count; vi++) {
      // 蒙皮权重遮罩（相关骨权重之和，连续 0..1）
      //
      // ⚠ 遮罩要**除以该顶点的最大骨权重**再归一化：人偶的蒙皮权重本身很软
      //   （实测：没有任何一个顶点在单骨上的权重超过 0.9，头骨顶点普遍只有
      //   0.3~0.5），直接拿权重和当遮罩会把每一档滑杆的力度都打掉一大半
      //   （头身比只生效 40%）。归一化后：本组主导的顶点遮罩 = 1，边界处平滑
      //   过渡到 0。
      let mask = 0
      let maxW = 0
      for (let k = 0; k < 4; k++) {
        const w = ctx.weights[vi * 4 + k]
        if (w <= 1e-6) continue
        if (w > maxW) maxW = w
        const bi = ctx.joints[vi * 4 + k]
        for (const mi of maskIdx) {
          if (bi === mi) { mask += w; break }
        }
      }
      if (mask <= 1e-4 || maxW <= 1e-6) continue
      mask = Math.min(1, mask / maxW)
      p.set(out[vi * 3], out[vi * 3 + 1], out[vi * 3 + 2])
      const field = group.field(p, ctx, tune, prep)
      if (field <= 1e-4) continue
      const w = field * Math.min(1, mask)
      group.transform(p, q, tune, ctx, prep)
      out[vi * 3] += (q.x - p.x) * w
      out[vi * 3 + 1] += (q.y - p.y) * w
      out[vi * 3 + 2] += (q.z - p.z) * w
    }
  }

  posAttr.array.set(out)
  posAttr.needsUpdate = true
  geometry.computeVertexNormals()
}

/** 胸廓双峰中心（绑定空间）：从网格数据推，不硬编码。 */
export function computeBustCenters(ctx: ShapeContext): THREE.Vector3[] {
  const chest = ctx.boneWorld.get(BONE.spine2)
  if (chest === undefined) return []
  const y = chest.y + 0.03
  const zs: number[] = []
  for (let i = 0; i < ctx.base.length; i += 3) {
    const x = ctx.base[i], py = ctx.base[i + 1], z = ctx.base[i + 2]
    if (Math.abs(py - y) > 0.1) continue
    if (Math.abs(x) < 0.04 || Math.abs(x) > 0.17) continue
    zs.push(z)
  }
  if (zs.length === 0) return []
  zs.sort((a, b) => a - b)
  const z = zs[Math.floor(zs.length * 0.9)]
  return [new THREE.Vector3(-0.1, y, z), new THREE.Vector3(0.1, y, z)]
}

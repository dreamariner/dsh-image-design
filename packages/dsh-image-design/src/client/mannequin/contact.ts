// 碰撞查询：网格的**带符号距离**与穿深。
//
// 为什么自己写（2026-11-18 实机事故）：旧审计（tests/helpers/pose-clip.ts）用
// 「面法线多数表决 + 符号门槛 + 缝区剔除」判内外，在关节凹陷与大倾角面上会漏判——
// 实机截图里手明显陷进大腿 9cm，审计却报「无穿插」。于是「调到审计说 0 为止」
// 是循环论证：判据错了，调出来的角度必然也错。
//
// 本模块用**伪法线（pseudonormal）**做精确带符号距离，这是网格带符号距离的标准做法：
//   · 三角面按绑定姿态法线定向（保证整片外翻一致，源网格的翻面会被纠正）
//   · 面 / 边 / 顶点各备一份伪法线
//       面   = 该面法线
//       边   = 相邻两面的法线和（最近点落在边上时用它，符号才不会反）
//       顶点 = 关联各面法线按角权重求和（最近点落在顶点上时用它）
//   · 查询：找最近三角形 → 按落点特征取对应伪法线 → 符号 = sign((p − q)·n)
//     旧审计的漏判正是「最近点落在边/顶点上，符号用面法线算翻了」。
//
// 另附**射线奇偶穿越计数**（完全不看面朝向）作为独立交叉验证：两者一致才算可信。
//
// 空间索引用均匀网格：三角面按包围盒登记到所有覆盖格；查询点只需看自己所在格
// （最近点若落在某三角面上，该三角形的包围盒必覆盖该点所在格）。

import * as THREE from 'three'

export interface SignedDistance {
  /** 带符号距离（米）：负 = 点在网格内部。 */
  distance: number
  /** 最近点（网格表面上）。 */
  closest: THREE.Vector3
  /** 命中的面片序号（-1 = 没命中任何面）。 */
  face: number
  /** 符号是否可信（最近点落在目标区域的边界 → 内外方向无定义，distance 只能当绝对值用）。 */
  uncertain: boolean
}

/** 最近点落点特征（决定用哪个伪法线判符号）。 */
export type ClosestFeature =
  | 'vertex-a' | 'vertex-b' | 'vertex-c'
  | 'edge-ab' | 'edge-ac' | 'edge-bc'
  | 'interior'

export interface SurfaceInput {
  /** 蒙皮后顶点位置（世界坐标，xyz 连续）。 */
  positions: Float32Array
  /** 三角形索引（长度 = 面数 × 3）。 */
  indices: Uint32Array
  /** 绑定姿态顶点法线（用于给面定向）。 */
  bindNormals: Float32Array
  /** 空间索引格边长（米）。默认 0.05。 */
  cellSize?: number
}

const v3 = (a: Float32Array, i: number): THREE.Vector3 =>
  new THREE.Vector3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2])

/** 最近点搜索的最大扩展环数（格长 5cm → 最远 40cm）。 */
const MAX_RING = 8

/**
 * 体段碰撞体（胶囊式代理）：把一段肢体抽象成「轴 + 表面」。
 *
 * 内外判定**不用法线**（源网格有翻面三角形、法线朝向不可靠，带符号距离在
 * 关节凹陷处会判反），而是**从轴心沿「轴心→查询点」方向打射线**：轴心在体内，
 * 射线第一个命中必然是外表面，于是「查询点比命中点更近」= 点在体内，
 * 差值就是穿深。符号无歧义，也不需要网格是闭合的。
 */
export class BodyPartCollider {
  readonly name: string
  readonly a: THREE.Vector3
  readonly b: THREE.Vector3
  private readonly surface: CollisionSurface
  /** 命中面是否属于本段（用来排除「射线从别的部位穿出去」的误判）。 */
  private readonly belongs: (faceIndex: number) => boolean

  constructor(
    name: string, a: THREE.Vector3, b: THREE.Vector3, surface: CollisionSurface,
    belongs?: (faceIndex: number) => boolean,
  ) {
    this.name = name
    this.a = a
    this.b = b
    this.surface = surface
    this.belongs = belongs ?? (() => true)
  }

  /**
   * 查询点相对本段轴心的径向剖面。
   *
   * 命中面必须属于本段才算数：轴心在腿里，射线朝上打，命中的是大腿表面 ✓；
   * 但若射线从**别的部位**（比如裆部空洞）穿出去，命中面就不是本段的，
   * 这时不能拿来判「点在腿里」——否则会报出几十厘米的假穿深
   * （实测：坐姿手掌 vs 小腿曾误报 34cm）。
   */
  profile(p: THREE.Vector3): { anchor: THREE.Vector3; dir: THREE.Vector3; dist: number; surfaceDist: number } | null {
    const axis = new THREE.Vector3().subVectors(this.b, this.a)
    const len = axis.length()
    if (len < 1e-6) return null
    axis.divideScalar(len)
    const rel = new THREE.Vector3().subVectors(p, this.a)
    let t = rel.dot(axis)
    if (t < -0.12 || t > len + 0.12) return null
    t = Math.max(0, Math.min(len, t))
    const anchor = this.a.clone().addScaledVector(axis, t)
    const dir = new THREE.Vector3().subVectors(p, anchor)
    const dist = dir.length()
    if (dist < 1e-6) return null
    dir.divideScalar(dist)
    const hit = this.surface.raycast(anchor, dir, dist + 0.35)
    if (hit === null) return null
    if (!this.belongs(hit.face)) return null
    return { anchor, dir, dist, surfaceDist: hit.distance }
  }

  /** 点相对本段的穿深（米；0 = 不在体内）。 */
  depth(p: THREE.Vector3): number {
    const pr = this.profile(p)
    if (pr === null) return 0
    return pr.dist < pr.surfaceDist ? pr.surfaceDist - pr.dist : 0
  }

  /** 点相对本段表面的带符号间隙（米；正 = 在体外，负 = 陷进去）。 */
  gap(p: THREE.Vector3): number {
    const pr = this.profile(p)
    if (pr === null) return Infinity
    return pr.dist - pr.surfaceDist
  }

  /** 沿指定方向从轴心量到外表面的距离（用于把「手该落在哪」定在腿面上）。 */
  surfaceAlong(tFrac: number, dir: THREE.Vector3): { point: THREE.Vector3; distance: number } | null {
    const axis = new THREE.Vector3().subVectors(this.b, this.a)
    const len = axis.length()
    if (len < 1e-6) return null
    axis.divideScalar(len)
    const anchor = this.a.clone().addScaledVector(axis, Math.max(0, Math.min(len, tFrac * len)))
    const d = dir.clone().normalize()
    const hit = this.surface.raycast(anchor, d, 1.2)
    return hit === null ? null : { point: hit.point, distance: hit.distance }
  }
}

/**
 * 体段的**解析代理**（椭圆柱）：运行时物理层用。
 *
 * 为什么要有两套：
 * · `BodyPartCollider`（轴心射线打网格）：内外判定最准，但要每步重建空间索引
 *   （网格随姿势变），一次几十 ms，扛不住物理子步。
 * · 本类：只存「轴 + 两个半轴半径」，随姿势只改轴心 → 每步重算是 O(1) ✓。
 *   代价是比网格粗（腿是椭圆截面，用等效半径近似），碰撞位置会差 5~10mm
 *   （手搭腿面上肉眼不可见）；**离线验证与门禁仍用网格级的 `BodyPartCollider`** ✓。
 */
/**
 * 段的横截面基：u = 侧向、v = 前后。
 *
 * @param orientation 骨的局部朝向（世界四元数）；没有就用世界竖直兜底（会退化，慎用）。
 */
export function segmentFrame(dir: THREE.Vector3, orientation?: THREE.Quaternion): { u: THREE.Vector3; v: THREE.Vector3 } {
  let v = orientation !== undefined
    ? new THREE.Vector3(0, 0, 1).applyQuaternion(orientation)
    : new THREE.Vector3(0, 1, 0)
  v.addScaledVector(dir, -v.dot(dir))
  if (v.lengthSq() < 1e-9) {
    v = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y)
    if (v.lengthSq() < 1e-9) v.set(0, 0, 1).addScaledVector(dir, -dir.z)
  }
  v.normalize()
  const u = new THREE.Vector3().crossVectors(dir, v).normalize()
  return { u, v }
}

export class EllipsoidSegment {
  readonly name: string
  readonly a: THREE.Vector3
  readonly b: THREE.Vector3
  /** 横截面半轴：u = 侧向、v = 上下（均以段轴为参照）。 */
  readonly radiusU: number
  readonly radiusV: number
  /**
   * 骨的局部朝向（世界四元数）：定横截面基用。
   *
   * 为什么必须用它而不是「世界竖直」：大腿竖直时，「竖直在段轴的垂分量」几乎退化，
   * 得到的 u/v 是任意方向 → 半轴（宽/深）会张冠李戴 → 语义锚点解析出的接触点偏好几厘米。
   * 骨的局部轴（绑定姿态 = 模型轴）解剖方向明确，且随骨刚性旋转 ✓。
   */
  private readonly orientation?: THREE.Quaternion
  /**
   * 半径沿轴向的剖面（解剖位置 t → 半轴半径）。
   *
   * 为什么需要：体段的粗细沿长度变化很大（大腿根 ~12cm、近膝 ~7.5cm），
   * 整段用同一个分位数会在中段偏 2~4cm —— 语义锚点（手贴大腿）解析出来的
   * 接触点就会浮空，手又变成「悬在大腿上方」。剖面按解剖 t 采样，随骨一起转。
   */
  private readonly profile?: (t: number) => { radiusU: number; radiusV: number }
  /** 角向剖面（截面不是圆的肢体：大腿内前伸到 16cm、外侧只有 6cm）✓。 */
  private readonly radial?: RadialProfile

  constructor(
    name: string, a: THREE.Vector3, b: THREE.Vector3,
    radiusU: number, radiusV: number,
    orientation?: THREE.Quaternion,
    profile?: (t: number) => { radiusU: number; radiusV: number },
    radial?: RadialProfile,
  ) {
    this.name = name
    this.a = a
    this.b = b
    this.radiusU = radiusU
    this.radiusV = radiusV
    this.orientation = orientation?.clone()
    this.profile = profile
    this.radial = radial
  }

  /** 某轴向参数处的半轴半径（有剖面用剖面，否则用整段常数）。 */
  radiusAt(tFrac: number): { radiusU: number; radiusV: number } {
    if (this.profile === undefined) return { radiusU: this.radiusU, radiusV: this.radiusV }
    return this.profile(THREE.MathUtils.clamp(tFrac, 0, 1))
  }

  /** 段轴的单位向量与长度。 */
  private axis(): { dir: THREE.Vector3; len: number } {
    const dir = new THREE.Vector3().subVectors(this.b, this.a)
    const len = dir.length()
    if (len < 1e-9) return { dir: new THREE.Vector3(0, 1, 0), len: 0 }
    return { dir: dir.divideScalar(len), len }
  }

  /** 横截面基：u = 侧向、v = 前后（由骨的局部朝向定 ✓）。 */
  private frame(dir: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
    return segmentFrame(dir, this.orientation)
  }

  /**
   * 点相对本段的带符号距离（米）：负 = 在段内（陷入多深），正 = 在段外（离多远）。
   * 椭圆截面用等效半径近似：归一化径向 r = √((u/a)²+(v/b)²)，距离 ≈ (r−1)·min(a,b)。
   */
  distance(p: THREE.Vector3): number {
    const { dir, len } = this.axis()
    if (len < 1e-9) return Infinity
    const rel = new THREE.Vector3().subVectors(p, this.a)
    const t = rel.dot(dir)
    const { u, v } = this.frame(dir)
    const relU = rel.dot(u)
    const relV = rel.dot(v)
    if (t < 0 || t > len) {
      // 端点帽：近似成半径 min(a,b) 的球
      const end = t < 0 ? this.a : this.b
      return p.distanceTo(end) - Math.min(this.radiusU, this.radiusV)
    }
    if (this.radial !== undefined) {
      // 角向剖面：查该截面角的表面半径，距离 = 查询径距 − 表面半径 ✓
      const d = Math.hypot(relU, relV)
      const surface = this.radial.at(t / len, Math.atan2(relV, relU))
      return d - surface
    }
    const radii = this.radiusAt(t / len)
    const r = Math.hypot(relU / radii.radiusU, relV / radii.radiusV)
    return (r - 1) * Math.min(radii.radiusU, radii.radiusV)
  }

  /**
   * 沿某方向从轴心量到椭圆面（米）：用于把「手贴在大腿中段偏外 5°」这类**语义目标**
   * 解析成具体坐标（段的截面随姿势变，写死坐标做不到 ✓）。
   *
   * @param tFrac 轴向参数 [0,1]。
   * @param dir 世界方向（会被投影到横截面平面 ✓）。
   */
  surfaceAlong(tFrac: number, dir: THREE.Vector3): { point: THREE.Vector3; distance: number } | null {
    const { dir: axis, len } = this.axis()
    if (len < 1e-9) return null
    const t = THREE.MathUtils.clamp(tFrac, 0, 1)
    const anchor = this.a.clone().addScaledVector(axis, t * len)
    const { u, v } = this.frame(axis)
    const du = dir.dot(u)
    const dv = dir.dot(v)
    if (this.radial !== undefined) {
      // 角向剖面：沿查询方向的表面半径直接查表 ✓（截面不是圆，椭球拟合会错 2~5cm）
      const dn = Math.hypot(du, dv)
      if (dn < 1e-9) return null
      const r = this.radial.at(t, Math.atan2(dv, du))
      const point = anchor.clone().addScaledVector(u, (du / dn) * r).addScaledVector(v, (dv / dn) * r)
      return { point, distance: r }
    }
    const radii = this.radiusAt(t)
    const denom = Math.hypot(du / radii.radiusU, dv / radii.radiusV)
    if (denom < 1e-9) return null
    const r = 1 / denom
    const point = anchor.clone().addScaledVector(u, du * r).addScaledVector(v, dv * r)
    return { point, distance: r }
  }

  /** 点在本段内的最深处（负值）与外推方向（从轴心指向点、已归一化）。 */
  probe(p: THREE.Vector3): { depth: number; outward: THREE.Vector3 } | null {
    const { dir, len } = this.axis()
    if (len < 1e-9) return null
    const rel = new THREE.Vector3().subVectors(p, this.a)
    const t = rel.dot(dir)
    // 端帽区（轴向范围外）也要给外向：distance() 用端点帽处理这些点，probe 却
    // 返回 null —— 指尖伸到段端之外时（躯干下端/大腿上端），「推出方向」就拿不到，
    // 指尖修正与接触推挤全部哑火（2026-11-18 实测手插进腹部 119mm 推不出去）✓。
    // 帽区的外向 = 从帽心指向查询点（近似径向）✓。
    const clamped = THREE.MathUtils.clamp(t, 0, len)
    const axisPoint = this.a.clone().addScaledVector(dir, clamped)
    const outward = new THREE.Vector3().subVectors(p, axisPoint)
    const l = outward.length()
    if (l < 1e-9) {
      // 点在轴上：用段轴自己的垂直方向兜底（截面基的 u）
      const { u } = this.frame(dir)
      return { depth: this.distance(p), outward: u.clone() }
    }
    outward.divideScalar(l)
    return { depth: this.distance(p), outward }
  }
}

/**
 * 量一段肢体的横截面半轴（u=侧向、v=上下）。
 *
 * 用**分位数**而不是最大值：网格在大腿根/膝窝处有向躯干延伸的顶点（腿缝、臀缝），
 * 取最大值会把半径撑到 19cm（实测），手放上去会浮空好几厘米；取 92 分位则贴近
 * 真实截面（近臀 ~12cm、近膝 ~7.5cm），代价是极少量真穿模会被漏判 → 所以**网格级
 * 判定仍由 `BodyPartCollider` 负责**，解析代理只用于运行时物理的每步约束。
 *
 * @param tLo tHi 只统计轴向参数落在该区间的顶点（一段肢体分上下两半分别量）。
 */
/**
 * 角向半径剖面：截面不是圆（大腿外侧 6cm、内前 16cm），椭球拟合把外侧也撑到
 * 11cm —— 指尖贴腿面（网格审计 0.6mm）被判「体内 4.8cm」（2026-11-18 实测）。
 * 这个剖面按「截面角度 × 轴向位置」记真实的表面半径，distance 直接查表 ✓。
 */
export interface RadialProfile {
  /** tFrac ∈ [0,1] 轴向、angle ∈ [0, 2π) 截面角（以 u 轴为 0，向 v 正方向为正）→ 表面半径（m）。 */
  at(tFrac: number, angle: number): number
}

/**
 * 量角向半径剖面：把段内的顶点按（轴向带 × 截面角桶）分格，
 * 每格取分位数距离 = 该方向的表面半径。
 *
 * @param bands 轴向分段数；@param buckets 截面角桶数；@param percentile 每桶取的分位数。
 */
export function measureRadialProfile(
  positions: Float32Array,
  verts: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  tLo = 0,
  tHi = 1,
  orientation?: THREE.Quaternion,
  bands = 8,
  buckets = 16,
  percentile = 0.9,
): RadialProfile {
  const axis = new THREE.Vector3().subVectors(b, a)
  const len = axis.length()
  if (len < 1e-9) return { at: () => 0.05 }
  axis.divideScalar(len)
  const { u, v } = segmentFrame(axis, orientation)
  // 表格 [band][bucket]
  const table: number[][] = []
  for (let i = 0; i < bands; i++) table.push(new Array(buckets).fill(0))
  const counts: number[][] = []
  for (let i = 0; i < bands; i++) counts.push(new Array(buckets).fill(0))
  const rel = new THREE.Vector3()
  for (const vi of verts) {
    rel.set(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]).sub(a)
    const t = rel.dot(axis) / len
    if (t < tLo || t > tHi) continue
    const tf = tHi > tLo ? (t - tLo) / (tHi - tLo) : 0
    const ru = rel.dot(u)
    const rv = rel.dot(v)
    const d = Math.hypot(ru, rv)
    if (d < 1e-6) continue
    let ang = Math.atan2(rv, ru)
    if (ang < 0) ang += Math.PI * 2
    const bi = Math.min(bands - 1, Math.floor(tf * bands))
    const bk = Math.min(buckets - 1, Math.floor((ang / (Math.PI * 2)) * buckets))
    table[bi][bk] += d
    counts[bi][bk] += 1
  }
  // 每桶取「均值 × 收缩」近似分位数（逐桶排序再取分位数在顶点稀疏的桶不稳）：
  // 均值代表该方向的平均表面距离；桶内顶点就是该方向的表面顶点 ✓
  const surf: number[][] = table.map((row, i) => row.map((sum, j) => {
    const n = counts[i][j]
    if (n === 0) return 0
    return (sum / n) * percentile
  }))
  // 空桶用邻桶补（环形插值）
  for (let i = 0; i < bands; i++) {
    for (let j = 0; j < buckets; j++) {
      if (surf[i][j] > 0) continue
      for (const off of [1, -1, 2, -2, 3, -3]) {
        const jj = (j + off + buckets * 4) % buckets
        if (surf[i][jj] > 0) { surf[i][j] = surf[i][jj]; break }
      }
      if (surf[i][j] === 0) surf[i][j] = 0.05
    }
  }
  // 轴向空带用邻带补
  for (let j = 0; j < buckets; j++) {
    for (let i = 0; i < bands; i++) {
      if (surf[i][j] > 0) continue
      for (const off of [1, -1, 2, -2]) {
        const ii = i + off
        if (ii >= 0 && ii < bands && surf[ii][j] > 0) { surf[i][j] = surf[ii][j]; break }
      }
    }
  }
  return {
    at(tFrac: number, angle: number): number {
      const tf = THREE.MathUtils.clamp(tFrac, 0, 0.9999)
      let a2 = angle % (Math.PI * 2)
      if (a2 < 0) a2 += Math.PI * 2
      const bi = Math.floor(tf * bands)
      const bk = Math.floor((a2 / (Math.PI * 2)) * buckets) % buckets
      return surf[bi][bk]
    },
  }
}

export function measureSegmentRadii(
  positions: Float32Array,
  verts: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  tLo = 0,
  tHi = 1,
  percentile = 0.92,
  orientation?: THREE.Quaternion,
): { radiusU: number; radiusV: number } {
  const axis = new THREE.Vector3().subVectors(b, a)
  const len = axis.length()
  if (len < 1e-9) return { radiusU: 0.05, radiusV: 0.05 }
  axis.divideScalar(len)
  const { u, v: up } = segmentFrame(axis, orientation)
  const us: number[] = []
  const vs: number[] = []
  for (const vi of verts) {
    const p = new THREE.Vector3(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2])
    const rel = p.sub(a)
    const t = rel.dot(axis)
    if (t < tLo * len || t > tHi * len) continue
    us.push(Math.abs(rel.dot(u)))
    vs.push(Math.abs(rel.dot(up)))
  }
  const q = (arr: number[], k: number): number => {
    if (arr.length === 0) return 0.05
    const sorted = [...arr].sort((x, y) => x - y)
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * k))
    return Math.max(0.03, sorted[idx])
  }
  return { radiusU: q(us, percentile), radiusV: q(vs, percentile) }
}

/**
 * 量一段肢体的**径向半径剖面**（到轴心的距离随解剖位置 t 变化）。
 *
 * 为什么不用 measureSegmentRadii 的 u/v 半轴：那两个半轴是在**量测时那一帧的横截面
 * 坐标系**里定义的，而这个坐标系会随姿势转（大腿从竖直转到水平，坐标系跟着转 90°），
 * 于是「大腿根粗、近膝细」的剖面被套到错误的轴上 → 语义锚点解析出的接触点能偏 3cm
 * （实测手悬在大腿上方 4cm）。径向距离与坐标系无关 ✓，用它才对。
 *
 * @param percentile 取分位数而非最大值：网格在大腿根有向躯干/腿缝延伸的顶点，
 *        取最大值会把半径撑大（手放上去浮空）。85 分位贴近真实截面 ✓。
 */
export function measureSegmentRadiusProfile(
  positions: Float32Array,
  verts: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  bands = 8,
  percentile = 0.85,
): (t: number) => number {
  const axis = new THREE.Vector3().subVectors(b, a)
  const len = axis.length()
  if (len < 1e-9) return () => 0.05
  axis.divideScalar(len)
  const radii: number[] = []
  for (let i = 0; i < bands; i++) {
    const tLo = i / bands
    const tHi = (i + 1) / bands
    const ds: number[] = []
    for (const vi of verts) {
      const p = new THREE.Vector3(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2])
      const rel = p.sub(a)
      const t = rel.dot(axis)
      if (t < tLo * len || t > tHi * len) continue
      ds.push(Math.hypot(rel.dot(axis) / len * 0, 0) + rel.length() - Math.abs(rel.dot(axis)))
    }
    if (ds.length === 0) { radii.push(0.05); continue }
    ds.sort((x, y) => x - y)
    radii.push(Math.max(0.03, ds[Math.min(ds.length - 1, Math.floor(ds.length * percentile))]))
  }
  return (t: number): number => {
    const x = THREE.MathUtils.clamp(t, 0, 0.9999) * bands
    const i = Math.floor(x)
    const f = x - i
    const a0 = radii[i]
    const a1 = radii[Math.min(bands - 1, i + 1)]
    return a0 + (a1 - a0) * f
  }
}

export class CollisionSurface {
  private readonly pos: Float32Array
  private readonly idx: Uint32Array
  private readonly faceCount: number
  /** 每个面的外翻法线（xyz 连续）。 */
  private readonly faceN: Float32Array
  /** 每个顶点的角度加权伪法线（xyz 连续）。 */
  private readonly vertN: Float32Array
  /** 每条边的伪法线（相邻两面法线和）。 */
  private readonly edgeN: Map<number, THREE.Vector3>
  /** 每条边的相邻面片数（=1 → 目标区域的边界边）。 */
  private readonly edgeFaceCount = new Map<number, number>()
  /** 位于边界边上的顶点（符号无定义）。 */
  private readonly vertOnBoundary = new Set<number>()
  private readonly cellSize: number
  private readonly gridMin = new THREE.Vector3()
  private readonly gridDim = new THREE.Vector3()
  private readonly cells = new Map<number, number[]>()
  private readonly tmp = new THREE.Vector3()

  constructor(input: SurfaceInput) {
    this.pos = input.positions
    this.idx = input.indices
    this.faceCount = input.indices.length / 3
    this.faceN = new Float32Array(this.faceCount * 3)
    this.vertN = new Float32Array(input.positions.length / 3 * 3)
    this.edgeN = new Map()

    // ① 面法线：先算几何法线，再用**拓扑 BFS 统一朝向**
    //    为什么不能「按绑定法线逐面定向」：源网格里有**翻面三角形**（MakeHuman 底网格
    //    的已知怪癖），逐面按顶点法线定向会把这些翻面片的法线定成**朝内**，
    //    于是最近点落在它们附近时符号判反（实测：a-pose 报 6cm 假穿深）。
    //    正确做法：沿边邻接把朝向传播成一致的（翻面标记做 2-着色），
    //    再用「绑定法线多数表决」定全局朝外还是朝内。
    const geoN = new Float32Array(this.faceCount * 3)
    for (let f = 0; f < this.faceCount; f++) {
      const ia = this.idx[f * 3], ib = this.idx[f * 3 + 1], ic = this.idx[f * 3 + 2]
      const a = v3(this.pos, ia), b = v3(this.pos, ib), c = v3(this.pos, ic)
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
      if (n.lengthSq() < 1e-16) n.set(0, 0, 0); else n.normalize()
      geoN[f * 3] = n.x; geoN[f * 3 + 1] = n.y; geoN[f * 3 + 2] = n.z
    }
    const flip = this.orientFaces(geoN)
    // 全局朝向：多数面与绑定法线同向 → 朝外
    let vote = 0
    for (let f = 0; f < this.faceCount; f++) {
      const ia = this.idx[f * 3], ib = this.idx[f * 3 + 1], ic = this.idx[f * 3 + 2]
      const ref = v3(input.bindNormals, ia).add(v3(input.bindNormals, ib)).add(v3(input.bindNormals, ic))
      const s = flip[f] === 1 ? -1 : 1
      const d = ref.x * s * geoN[f * 3] + ref.y * s * geoN[f * 3 + 1] + ref.z * s * geoN[f * 3 + 2]
      vote += d
    }
    const globalFlip = vote < 0 ? -1 : 1
    for (let f = 0; f < this.faceCount; f++) {
      const s = (flip[f] === 1 ? -1 : 1) * globalFlip
      this.faceN[f * 3] = s * geoN[f * 3]
      this.faceN[f * 3 + 1] = s * geoN[f * 3 + 1]
      this.faceN[f * 3 + 2] = s * geoN[f * 3 + 2]
    }
    // 顶点/边伪法线（用定好朝向的面法线累加）
    for (let f = 0; f < this.faceCount; f++) {
      const ia = this.idx[f * 3], ib = this.idx[f * 3 + 1], ic = this.idx[f * 3 + 2]
      const n = v3(this.faceN, f)
      const pa = v3(this.pos, ia), pb = v3(this.pos, ib), pc = v3(this.pos, ic)
      const e0 = new THREE.Vector3().subVectors(pb, pa)
      const e1 = new THREE.Vector3().subVectors(pc, pa)
      const e2 = new THREE.Vector3().subVectors(pc, pb)
      const l0 = e0.length(), l1 = e1.length(), l2 = e2.length()
      const angA = Math.acos(THREE.MathUtils.clamp(e0.dot(e1) / Math.max(1e-12, l0 * l1), -1, 1))
      const angB = Math.acos(THREE.MathUtils.clamp(new THREE.Vector3().subVectors(pa, pb).dot(e2) / Math.max(1e-12, l0 * l2), -1, 1))
      const angC = Math.acos(THREE.MathUtils.clamp(new THREE.Vector3().subVectors(pa, pc).dot(e2) / Math.max(1e-12, l1 * l2), -1, 1))
      this.addVertNormal(ia, n, angA)
      this.addVertNormal(ib, n, angB)
      this.addVertNormal(ic, n, angC)
      this.addEdgeNormal(ia, ib, n)
      this.addEdgeNormal(ib, ic, n)
      this.addEdgeNormal(ic, ia, n)
    }
    // 顶点伪法线归一化
    for (let v = 0; v < this.vertN.length / 3; v++) {
      this.tmp.set(this.vertN[v * 3], this.vertN[v * 3 + 1], this.vertN[v * 3 + 2])
      if (this.tmp.lengthSq() > 1e-16) this.tmp.normalize()
      this.vertN[v * 3] = this.tmp.x; this.vertN[v * 3 + 1] = this.tmp.y; this.vertN[v * 3 + 2] = this.tmp.z
    }
    // 边界标记：目标区域是**开口面片**（躯干+腿，手臂接入处没有封口），
    // 落在边界边/边界顶点上的最近点，内外方向无定义 → 符号判不出来，
    // 这类点一律按「距离 0（贴面/不可判）」处理，绝不误报穿深。
    for (const [key, count] of this.edgeFaceCount) {
      if (count >= 2) continue
      const hi = key % 1e7
      const lo = Math.floor(key / 1e7)
      this.vertOnBoundary.add(hi)
      this.vertOnBoundary.add(lo)
    }
    // ② 空间网格
    this.cellSize = input.cellSize ?? 0.05
    const min = new THREE.Vector3(Infinity, Infinity, Infinity)
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
    for (let i = 0; i < this.pos.length; i += 3) {
      min.x = Math.min(min.x, this.pos[i]); min.y = Math.min(min.y, this.pos[i + 1]); min.z = Math.min(min.z, this.pos[i + 2])
      max.x = Math.max(max.x, this.pos[i]); max.y = Math.max(max.y, this.pos[i + 1]); max.z = Math.max(max.z, this.pos[i + 2])
    }
    this.gridMin.copy(min)
    this.gridDim.set(
      Math.max(1, Math.ceil((max.x - min.x) / this.cellSize) + 1),
      Math.max(1, Math.ceil((max.y - min.y) / this.cellSize) + 1),
      Math.max(1, Math.ceil((max.z - min.z) / this.cellSize) + 1),
    )
    const box = new THREE.Box3()
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    for (let f = 0; f < this.faceCount; f++) {
      a.copy(v3(this.pos, this.idx[f * 3]))
      b.copy(v3(this.pos, this.idx[f * 3 + 1]))
      c.copy(v3(this.pos, this.idx[f * 3 + 2]))
      box.setFromPoints([a, b, c])
      const i0 = this.cellIndex(box.min), i1 = this.cellIndex(box.max)
      for (let ix = i0.x; ix <= i1.x; ix++) {
        for (let iy = i0.y; iy <= i1.y; iy++) {
          for (let iz = i0.z; iz <= i1.z; iz++) {
            const key = this.cellKey(ix, iy, iz)
            const list = this.cells.get(key)
            if (list === undefined) this.cells.set(key, [f])
            else list.push(f)
          }
        }
      }
    }
  }

  /**
   * 沿边邻接把面朝向传播成一致的，返回每片的翻面标记（0/1）。
   *
   * 做法：共享一条边的两个面，其共边方向应当相反（定向一致的网格必然如此）。
   *   方向相同 → 两者朝向不一致 → 翻面标记异或为 1；否则异或为 0。
   *   以任一面为种子做 BFS 传播（本质是 2-着色）。网格若不可定向则忽略矛盾。
   */
  private orientFaces(geoN: Float32Array): Uint8Array {
    const state = new Int8Array(this.faceCount).fill(-1)
    const edgeMap = new Map<number, { face: number; dir: number }[]>()
    for (let f = 0; f < this.faceCount; f++) {
      const v = [this.idx[f * 3], this.idx[f * 3 + 1], this.idx[f * 3 + 2]]
      for (let k = 0; k < 3; k++) {
        const a = v[k], b = v[(k + 1) % 3]
        const lo = Math.min(a, b), hi = Math.max(a, b)
        const key = lo * 1e7 + hi
        const dir = a === lo ? 1 : -1
        const list = edgeMap.get(key)
        if (list === undefined) edgeMap.set(key, [{ face: f, dir }])
        else list.push({ face: f, dir })
      }
    }
    const adj: { face: number; same: boolean }[][] = Array.from({ length: this.faceCount }, () => [])
    for (const list of edgeMap.values()) {
      if (list.length !== 2) continue
      const [x, y] = list
      adj[x.face].push({ face: y.face, same: x.dir === y.dir })
      adj[y.face].push({ face: x.face, same: x.dir === y.dir })
    }
    const queue: number[] = []
    for (let f = 0; f < this.faceCount; f++) {
      if (state[f] !== -1) continue
      state[f] = 0
      queue.push(f)
      while (queue.length > 0) {
        const cur = queue.pop() as number
        for (const e of adj[cur]) {
          const want = state[cur] ^ (e.same ? 1 : 0)
          if (state[e.face] === -1) { state[e.face] = want; queue.push(e.face) }
        }
      }
    }
    const flip = new Uint8Array(this.faceCount)
    for (let f = 0; f < this.faceCount; f++) flip[f] = state[f] === 1 ? 1 : 0
    return flip
  }

  private addVertNormal(i: number, n: THREE.Vector3, w: number): void {
    this.vertN[i * 3] += n.x * w
    this.vertN[i * 3 + 1] += n.y * w
    this.vertN[i * 3 + 2] += n.z * w
  }

  private addEdgeNormal(a: number, b: number, n: THREE.Vector3): void {
    const lo = Math.min(a, b), hi = Math.max(a, b)
    const key = lo * 1e7 + hi
    const cur = this.edgeN.get(key)
    if (cur === undefined) { this.edgeN.set(key, n.clone()); this.edgeFaceCount.set(key, 1) } else { cur.add(n); this.edgeFaceCount.set(key, (this.edgeFaceCount.get(key) ?? 1) + 1) }
  }

  /** 该边是不是目标区域的**边界边**（只有一片相邻面）。 */
  private isBoundaryEdge(a: number, b: number): boolean {
    const key = Math.min(a, b) * 1e7 + Math.max(a, b)
    return (this.edgeFaceCount.get(key) ?? 0) < 2
  }

  private cellIndex(p: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(
      Math.floor((p.x - this.gridMin.x) / this.cellSize),
      Math.floor((p.y - this.gridMin.y) / this.cellSize),
      Math.floor((p.z - this.gridMin.z) / this.cellSize),
    )
  }

  private cellKey(ix: number, iy: number, iz: number): number {
    return (ix * 4096 + iy) * 4096 + iz
  }

  /**
   * 查询点到位移后网格表面的带符号距离。
   *
   * @param unsigned 只取绝对距离（符号由别的判据给，例如**闭合全身网格**的奇偶判定；
   *   目标区域（躯干+腿）本身是开口面片，法线定向在边界处不可靠，
   *   所以「符号」交给全身网格的奇偶判定，「大小」交给这里的距离 ✓）。
   */
  query(p: THREE.Vector3, unsigned = false): SignedDistance {
    const ci = this.cellIndex(p)
    // 超出网格范围太远 → 直接判「离表面无穷远」
    if (ci.x < -MAX_RING || ci.y < -MAX_RING || ci.z < -MAX_RING ||
        ci.x > this.gridDim.x + MAX_RING || ci.y > this.gridDim.y + MAX_RING || ci.z > this.gridDim.z + MAX_RING) {
      return { distance: Infinity, closest: p.clone(), face: -1, uncertain: false }
    }
    let bestD = Infinity
    let bestFace = -1
    let bestFeature: ClosestFeature = 'interior'
    const q = new THREE.Vector3()
    // ⚠ 必须**按环扩展**搜索：最近点 q 落在邻近格时，那片面的包围盒只覆盖 q 所在格，
    //   不覆盖 p 所在格 → 只查本格会漏掉真正的最近面（早先版本漏掉 19cm 外的近面，
    //   把陷进大腿的手报成「没穿模」）。
    //   环 r 的格子离 p 至少 (r−1)·格长，故 best < r·格长 即可停止。
    for (let ring = 0; ring <= MAX_RING; ring++) {
      for (const f of this.ringFaces(ci, ring)) {
        const r = this.closestOnFace(p, f, q)
        if (r.d < bestD) { bestD = r.d; bestFace = f; bestFeature = r.feature }
      }
      if (bestD < Infinity && ring * this.cellSize > bestD) break
    }
    if (bestFace < 0) return { distance: Infinity, closest: p.clone(), face: -1, uncertain: false }
    const delta = new THREE.Vector3().subVectors(p, q)
    const dist = delta.length()
    if (unsigned) return { distance: dist, closest: q.clone(), face: bestFace, uncertain: false }
    const uncertain = this.isBoundaryFeature(bestFace, bestFeature)
    if (uncertain) return { distance: dist, closest: q.clone(), face: bestFace, uncertain: true }
    const n = this.featureNormal(bestFace, bestFeature)
    const sign = Math.sign(delta.dot(n))
    return { distance: sign < 0 ? -dist : dist, closest: q.clone(), face: bestFace, uncertain: false }
  }

  /** 第 ring 环（切比雪夫距离 = ring）上的所有面片。 */
  private ringFaces(ci: THREE.Vector3, ring: number): number[] {
    const out: number[] = []
    const lo = [ci.x - ring, ci.y - ring, ci.z - ring]
    const hi = [ci.x + ring, ci.y + ring, ci.z + ring]
    for (let ix = lo[0]; ix <= hi[0]; ix++) {
      for (let iy = lo[1]; iy <= hi[1]; iy++) {
        for (let iz = lo[2]; iz <= hi[2]; iz++) {
          if (Math.max(Math.abs(ix - ci.x), Math.abs(iy - ci.y), Math.abs(iz - ci.z)) !== ring) continue
          const list = this.cells.get(this.cellKey(ix, iy, iz))
          if (list !== undefined) out.push(...list)
        }
      }
    }
    return out
  }

  /** 落点特征是否位于目标区域的边界（此处内外方向无定义）。 */
  private isBoundaryFeature(face: number, feature: ClosestFeature): boolean {
    const ia = this.idx[face * 3], ib = this.idx[face * 3 + 1], ic = this.idx[face * 3 + 2]
    switch (feature) {
      case 'vertex-a': return this.vertOnBoundary.has(ia)
      case 'vertex-b': return this.vertOnBoundary.has(ib)
      case 'vertex-c': return this.vertOnBoundary.has(ic)
      case 'edge-ab': return this.isBoundaryEdge(ia, ib)
      case 'edge-ac': return this.isBoundaryEdge(ia, ic)
      case 'edge-bc': return this.isBoundaryEdge(ib, ic)
      default: return false
    }
  }

  /** 目标区域的包围盒（世界坐标）。 */
  bounds(): THREE.Box3 {
    return new THREE.Box3(
      this.gridMin.clone(),
      this.gridMin.clone().add(this.gridDim.clone().multiplyScalar(this.cellSize)),
    )
  }

  /** 最近点落在哪个特征上，就取哪个特征的伪法线（这是符号正确的关键）。 */
  private featureNormal(face: number, feature: ClosestFeature): THREE.Vector3 {
    const ia = this.idx[face * 3], ib = this.idx[face * 3 + 1], ic = this.idx[face * 3 + 2]
    switch (feature) {
      case 'vertex-a': return v3(this.vertN, ia)
      case 'vertex-b': return v3(this.vertN, ib)
      case 'vertex-c': return v3(this.vertN, ic)
      case 'edge-ab': return this.edgeNormal(ia, ib)
      case 'edge-ac': return this.edgeNormal(ia, ic)
      case 'edge-bc': return this.edgeNormal(ib, ic)
      default: return v3(this.faceN, face)
    }
  }

  private edgeNormal(a: number, b: number): THREE.Vector3 {
    const lo = Math.min(a, b), hi = Math.max(a, b)
    const n = this.edgeN.get(lo * 1e7 + hi)
    if (n === undefined || n.lengthSq() < 1e-16) return v3(this.faceN, 0)
    return n.clone().normalize()
  }

  /**
   * 点到第 f 个面的最近点 + 落点特征。
   *
   * ⚠ 落点特征要**精确**（由分支直接给出），不能用重心坐标的 eps 去猜：
   *   早先版本用 eps=1e-6 判断「最近点是否落在边上」，数值上常判错，
   *   于是用了面法线判符号 → 方向与面法线近乎垂直时符号随机翻
   *   （a-pose 这种明显无穿模的姿势报出 6cm 穿深）。
   *   正确做法：最近点落在边/顶点就用对应的伪法线，这是伪法线方法的标准用法。
   */
  private closestOnFace(p: THREE.Vector3, f: number, out: THREE.Vector3): { d: number; feature: ClosestFeature } {
    const ia = this.idx[f * 3], ib = this.idx[f * 3 + 1], ic = this.idx[f * 3 + 2]
    const a = v3(this.pos, ia), b = v3(this.pos, ib), c = v3(this.pos, ic)
    const ab = new THREE.Vector3().subVectors(b, a)
    const ac = new THREE.Vector3().subVectors(c, a)
    const ap = new THREE.Vector3().subVectors(p, a)
    const d1 = ab.dot(ap), d2 = ac.dot(ap)
    let wa = 1, wb = 0, wc = 0
    let feature: ClosestFeature = 'vertex-a'
    if (d1 <= 0 && d2 <= 0) { wa = 1; wb = 0; wc = 0; feature = 'vertex-a' }
    else {
      const bp = new THREE.Vector3().subVectors(p, b)
      const d3 = ab.dot(bp), d4 = ac.dot(bp)
      if (d3 >= 0 && d4 <= d3) { wa = 0; wb = 1; wc = 0; feature = 'vertex-b' }
      else {
        const vc = d1 * d4 - d3 * d2
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          const t = d1 / (d1 - d3)
          wa = 1 - t; wb = t; wc = 0; feature = 'edge-ab'
        } else {
          const cp = new THREE.Vector3().subVectors(p, c)
          const d5 = ab.dot(cp), d6 = ac.dot(cp)
          if (d6 >= 0 && d5 <= d6) { wa = 0; wb = 0; wc = 1; feature = 'vertex-c' }
          else {
            const vb = d5 * d2 - d1 * d6
            if (vb <= 0 && d2 >= 0 && d6 <= 0) {
              const t = d2 / (d2 - d6)
              wa = 1 - t; wb = 0; wc = t; feature = 'edge-ac'
            } else {
              const va = d3 * d6 - d5 * d4
              if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
                const t = (d4 - d3) / ((d4 - d3) + (d5 - d6))
                wa = 0; wb = 1 - t; wc = t; feature = 'edge-bc'
              } else {
                const denom = 1 / (va + vb + vc)
                wb = vb * denom; wc = vc * denom; wa = 1 - wb - wc
                feature = 'interior'
              }
            }
          }
        }
      }
    }
    out.set(
      a.x * wa + b.x * wb + c.x * wc,
      a.y * wa + b.y * wb + c.y * wc,
      a.z * wa + b.z * wb + c.z * wc,
    )
    return { d: p.distanceTo(out), feature }
  }

  /**
   * 射线奇偶穿越计数：奇数 = 点在网格内部。
   *
   * 完全不看面朝向，是带符号距离的**独立交叉验证**：两个判据一致才算可信
   * （旧审计只有一套判据，自证自洽）。
   * 用 3D DDA 沿网格逐格推进，只测经过的格（早先版本只测起点所在格，
   * 穿越计数根本不对，等于没有验证）。
   * 局限：目标区域开口时，射线从开口穿出会误判。
   */
  insideByParity(p: THREE.Vector3, dir = new THREE.Vector3(1, 0.0137, 0.0211).normalize()): boolean {
    let crossings = 0
    for (const cell of this.rayCells(p, dir)) {
      const faces = this.cells.get(this.cellKey(cell[0], cell[1], cell[2]))
      if (faces === undefined) continue
      for (const f of faces) if (this.rayHitsFace(p, dir, f)) crossings++
    }
    return crossings % 2 === 1
  }

  /**
   * 射线命中的最近点（世界坐标 + 距离）。没命中返回 null。
   *
   * 用于「从肢体轴心向外打射线量表面距离」——这是内外判定里**没有符号歧义**
   * 的做法：轴心在体内，射线第一个命中必然是外表面。
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist = Infinity): { point: THREE.Vector3; distance: number; face: number } | null {
    let bestT = maxDist
    let bestFace = -1
    for (const cell of this.rayCells(origin, dir)) {
      const faces = this.cells.get(this.cellKey(cell[0], cell[1], cell[2]))
      if (faces === undefined) continue
      for (const f of faces) {
        const t = this.rayFaceT(origin, dir, f)
        if (t !== null && t < bestT) { bestT = t; bestFace = f }
      }
    }
    if (bestFace < 0) return null
    return { point: origin.clone().addScaledVector(dir, bestT), distance: bestT, face: bestFace }
  }

  /** 射线经过的格子（3D DDA，Amanatides–Woo）。 */
  private rayCells(p: THREE.Vector3, dir: THREE.Vector3): number[][] {
    const cs = this.cellSize
    const cell = this.cellIndex(p)
    // ⚠ THREE.Vector3 **不支持数字下标**（dir[0] 是 undefined，不是 dir.x），
    //   早先版本写 dir[a] 导致 tMax 全是 NaN，射线一步都没走、永远打不中任何面。
    //   所以先把三个分量取成普通数组再按下标用。
    const d = [dir.x, dir.y, dir.z]
    const step = [Math.sign(d[0]), Math.sign(d[1]), Math.sign(d[2])]
    const tDelta = [
      d[0] !== 0 ? Math.abs(cs / d[0]) : Infinity,
      d[1] !== 0 ? Math.abs(cs / d[1]) : Infinity,
      d[2] !== 0 ? Math.abs(cs / d[2]) : Infinity,
    ]
    const dim = [this.gridDim.x, this.gridDim.y, this.gridDim.z]
    const tMax: number[] = []
    for (let a = 0; a < 3; a++) {
      const axis = a === 0 ? 'x' : a === 1 ? 'y' : 'z'
      const o = p[axis] - this.gridMin[axis]
      const c = Math.floor(o / cs)
      const next = (c + (step[a] > 0 ? 1 : 0)) * cs + this.gridMin[axis]
      tMax.push(d[a] !== 0 ? (next - p[axis]) / d[a] : Infinity)
    }
    const ci = [cell.x, cell.y, cell.z]
    const out: number[][] = []
    for (let iter = 0; iter < 1024; iter++) {
      out.push([ci[0], ci[1], ci[2]])
      let axis = 0
      if (tMax[1] < tMax[0]) axis = 1
      if (tMax[2] < tMax[axis]) axis = 2
      if (!Number.isFinite(tMax[axis])) break
      tMax[axis] += tDelta[axis]
      ci[axis] += step[axis]
      if (ci[axis] < 0 || ci[axis] >= dim[axis]) break
    }
    return out
  }

  /** Möller–Trumbore：射线命中第 f 个面片的距离（未命中返回 null）。 */
  private rayFaceT(p: THREE.Vector3, dir: THREE.Vector3, f: number): number | null {
    const ia = this.idx[f * 3], ib = this.idx[f * 3 + 1], ic = this.idx[f * 3 + 2]
    const a = v3(this.pos, ia)
    const e1 = new THREE.Vector3().subVectors(v3(this.pos, ib), a)
    const e2 = new THREE.Vector3().subVectors(v3(this.pos, ic), a)
    const h = new THREE.Vector3().crossVectors(dir, e2)
    const det = e1.dot(h)
    if (Math.abs(det) < 1e-12) return null
    const inv = 1 / det
    const s = new THREE.Vector3().subVectors(a, p)
    const u = inv * s.dot(h)
    if (u < 0 || u > 1) return null
    const q = new THREE.Vector3().crossVectors(e1, s)
    const vv = inv * dir.dot(q)
    if (vv < 0 || u + vv > 1) return null
    const tt = inv * e2.dot(q)
    return tt > 1e-7 ? tt : null
  }

  /** Möller–Trumbore：射线是否命中第 f 个面片。 */
  private rayHitsFace(p: THREE.Vector3, dir: THREE.Vector3, f: number): boolean {
    return this.rayFaceT(p, dir, f) !== null
  }
}

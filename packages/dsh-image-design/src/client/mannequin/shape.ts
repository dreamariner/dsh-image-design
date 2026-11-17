// 体型形变：把「体型参数」落到真实网格上。
//
// 为什么必须做网格形变（而不是缩放骨骼）：躯干是**跨骨平滑蒙皮**的（胸腔同时受
// spine / spine1 / spine2 / 锁骨影响），缩放单根脊柱骨只会让那一小圈鼓起，围度
// 几乎看不出来 —— 这就是上一版「体型滑杆与实际效果不符」的根因。
//
// 做法：在**绑定姿态**上按蒙皮权重做一次线性混合形变（与骨骼缩放同构，但作用在
// 顶点上）：
//
//   v' = Σ_k w_k · ( M_{i_k} · (v − p_{i_k}) + p_{i_k} )
//
//   M_i：骨 i 的形变矩阵（绕骨心 p_i）
//     · axis    —— 世界轴向缩放（围度：胸 / 腰 / 臀 / 肩）
//     · radial  —— 垂直骨轴的均匀放大（四肢粗细，不挪关节）
//     · uniform —— 各向同性（头身比）
//
// 蒙皮权重是蒙皮自带的，所以形变与骨架天然连续，不会出现接缝。
//
// 胸围额外做「双峰」局部隆起（base 网格是中性体型，纯缩胸腔只会变成「肚子变厚」）。

import * as THREE from 'three'
import { shapeTunes, TORSO_BONES, type BodyParams } from './body.ts'

export interface ShapeContext {
  /** 绑定姿态原始顶点位置（每顶点 3 个 float，geometry 顺序）。 */
  base: Float32Array
  /** 蒙皮骨索引（每顶点 4 个）。 */
  joints: Uint16Array
  /** 蒙皮权重（每顶点 4 个）。 */
  weights: Float32Array
  /** 骨名 → 蒙皮索引。 */
  boneIndex: Map<string, number>
  /** 骨名 → 绑定姿态世界位置（形变枢轴）。 */
  boneWorld: Map<string, THREE.Vector3>
  /** 骨名 → 骨轴单位向量（指向子骨；radial 模式用）。 */
  boneAxis: Map<string, THREE.Vector3>
  /** 胸廓骨名（算双峰隆起的位置）。 */
  chestBone: string
  /** 躯干骨名集合（区域形变只作用于这些骨主导的顶点）。 */
  torsoBones?: readonly string[]
}

/** 形变矩阵（3×3，行主序）：绕骨心做线性变换。 */
interface Deform {
  /** 线性部分。 */
  m: Float64Array
  /** 枢轴（骨心）。 */
  p: THREE.Vector3
}

/** 轴向缩放矩阵。 */
function axisMatrix(sx: number, sy: number, sz: number): Float64Array {
  const m = new Float64Array(9)
  m[0] = sx; m[4] = sy; m[8] = sz
  return m
}

/** 各向同性矩阵。 */
function uniformMatrix(s: number): Float64Array {
  return axisMatrix(s, s, s)
}

/**
 * 垂直骨轴的放大：M = s·I − (s−1)·(a ⊗ a)。
 * 沿骨轴的分量保持 1（关节位置不动），垂直分量放大 s（肢体变粗）。
 */
function radialMatrix(s: number, axis: THREE.Vector3): Float64Array {
  const m = new Float64Array(9)
  const { x, y, z } = axis
  m[0] = s - (s - 1) * x * x
  m[1] = -(s - 1) * x * y
  m[2] = -(s - 1) * x * z
  m[3] = -(s - 1) * y * x
  m[4] = s - (s - 1) * y * y
  m[5] = -(s - 1) * y * z
  m[6] = -(s - 1) * z * x
  m[7] = -(s - 1) * z * y
  m[8] = s - (s - 1) * z * z
  return m
}

/** 胸廓双峰中心（绑定空间）：从网格数据推，不硬编码。 */
export function computeBustCenters(ctx: ShapeContext): THREE.Vector3[] {
  const chest = ctx.boneWorld.get(ctx.chestBone)
  if (chest === undefined) return []
  const y = chest.y + 0.04
  const zs: number[] = []
  for (let i = 0; i < ctx.base.length; i += 3) {
    const x = ctx.base[i], py = ctx.base[i + 1], z = ctx.base[i + 2]
    if (Math.abs(py - y) > 0.09) continue
    if (Math.abs(x) < 0.045 || Math.abs(x) > 0.16) continue
    zs.push(z)
  }
  if (zs.length === 0) return []
  zs.sort((a, b) => a - b)
  const z = zs[Math.floor(zs.length * 0.92)]
  return [new THREE.Vector3(-0.095, y, z), new THREE.Vector3(0.095, y, z)]
}

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

  // 1) 每根骨的形变矩阵（骨级：轴向 / 径向 / 各向同性）
  const tunes = shapeTunes(params)
  const defs: (Deform & { bone: string })[] = []
  const regions: { center: THREE.Vector3; scale: [number, number, number]; height: number }[] = []
  for (const tune of tunes) {
    const p = ctx.boneWorld.get(tune.bone)
    if (p === undefined) continue
    if (tune.mode === 'region') {
      regions.push({
        center: p.clone(),
        scale: tune.scale,
        height: tune.height ?? 0.12,
      })
      continue
    }
    let m: Float64Array
    if (tune.mode === 'axis') m = axisMatrix(tune.scale[0], tune.scale[1], tune.scale[2])
    else if (tune.mode === 'uniform') m = uniformMatrix(tune.scale[0])
    else {
      const axis = ctx.boneAxis.get(tune.bone)
      if (axis === undefined) continue
      m = radialMatrix(tune.scale[0], axis)
    }
    defs.push({ bone: tune.bone, m, p })
  }
  const defByBoneIndex = new Map<number, Deform>()
  for (const d of defs) {
    const bi = ctx.boneIndex.get(d.bone)
    if (bi !== undefined) defByBoneIndex.set(bi, d)
  }
  // 躯干骨集合（蒙皮索引）→ 区域形变只作用于这些骨主导的顶点
  const torsoSet = new Set<number>()
  for (const name of ctx.torsoBones ?? TORSO_BONES) {
    const bi = ctx.boneIndex.get(name)
    if (bi !== undefined) torsoSet.add(bi)
  }

  // 2) 顶点混合
  const out = new Float32Array(ctx.base.length)
  for (let vi = 0; vi < count; vi++) {
    const bx = ctx.base[vi * 3], by = ctx.base[vi * 3 + 1], bz = ctx.base[vi * 3 + 2]
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 4; k++) {
      const w = ctx.weights[vi * 4 + k]
      if (w <= 1e-6) continue
      const def = defByBoneIndex.get(ctx.joints[vi * 4 + k])
      if (def === undefined) { x += w * bx; y += w * by; z += w * bz; continue }
      const { m, p } = def
      const dx = bx - p.x, dy = by - p.y, dz = bz - p.z
      x += w * (m[0] * dx + m[1] * dy + m[2] * dz + p.x)
      y += w * (m[3] * dx + m[4] * dy + m[5] * dz + p.y)
      z += w * (m[6] * dx + m[7] * dy + m[8] * dz + p.z)
    }
    out[vi * 3] = x; out[vi * 3 + 1] = y; out[vi * 3 + 2] = z
  }

  // 2b) 区域场形变（围度类）：在躯干高度带上按平滑权重直接缩放顶点
  if (regions.length > 0) {
    for (let vi = 0; vi < count; vi++) {
      // 主导骨：权重最大的那根
      let dominant = 0
      let best = -1
      for (let k = 0; k < 4; k++) {
        const w = ctx.weights[vi * 4 + k]
        if (w > best) { best = w; dominant = ctx.joints[vi * 4 + k] }
      }
      if (!torsoSet.has(dominant)) continue
      const x0 = out[vi * 3], y = out[vi * 3 + 1], z0 = out[vi * 3 + 2]
      // 各区域的权重与缩放系数做**加权平均**（不是各自叠加）：胸/腰/臀的高度带
      // 有重叠，各自叠加会互相抵消（臀变宽把腰变细抵掉）。加权平均后重叠区是
      // 平滑过渡，边缘按总覆盖度淡出。
      let wSum = 0
      let sAccX = 0
      let sAccZ = 0
      let cx = 0
      let cz = 0
      for (const r of regions) {
        const u = Math.abs(y - r.center.y) / r.height
        if (u >= 1) continue
        const t = (1 - u * u) * (1 - u * u)
        wSum += t
        sAccX += t * r.scale[0]
        sAccZ += t * r.scale[2]
        cx += t * r.center.x
        cz += t * r.center.z
      }
      if (wSum > 1e-6) {
        const sx = sAccX / wSum
        const sz = sAccZ / wSum
        const cov = Math.min(1, wSum)
        const fx = cx / wSum
        const fz = cz / wSum
        out[vi * 3] = fx + (x0 - fx) * (1 + (sx - 1) * cov)
        out[vi * 3 + 2] = fz + (z0 - fz) * (1 + (sz - 1) * cov)
      }
    }
  }

  // 3) 胸围双峰隆起（局部，沿 +z 推出，随离中心的距离平滑衰减）
  const bustK = Math.min(1.6, Math.max(0.6, params.bust))
  if (Math.abs(bustK - 1) > 1e-3) {
    const centers = computeBustCenters(ctx)
    const radius = 0.11
    const amp = (bustK - 1) * 0.055
    for (let vi = 0; vi < count; vi++) {
      const bx = ctx.base[vi * 3], by = ctx.base[vi * 3 + 1], bz = ctx.base[vi * 3 + 2]
      for (const c of centers) {
        const dx = bx - c.x, dy = by - c.y
        const d2 = (dx * dx + dy * dy) / (radius * radius)
        if (d2 >= 1) continue
        // 平滑衰减（1 − d²)²，中心最大、边缘归零
        const w = (1 - d2) * (1 - d2)
        // 只对胸廓表面（z 在中心附近或更前）的顶点生效
        const front = Math.min(1, Math.max(0, (bz - c.z) / 0.05 + 1))
        out[vi * 3 + 2] += amp * w * front
      }
    }
  }

  posAttr.array.set(out)
  posAttr.needsUpdate = true
  geometry.computeVertexNormals()
}

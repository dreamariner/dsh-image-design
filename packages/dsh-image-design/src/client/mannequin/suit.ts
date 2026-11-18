// 紧身衣：**几何壳**（真布料层）——不是涂装。
//
// 三次实机迭代的教训链（勿回退）：
//   ① 逐顶点主导骨 AND 分段：肩胛边缘交错顶点把上背大片三角形拖成皮肤段（锯齿围裙）；
//   ② 三角形均值阈值双材质分段：上背修复，但边界锯齿 = 网格粒度；
//   ③ 顶点色渐变：无锯齿了，但本质是「染色」——没有材质感（无厚度/无独立材质），
//     且渐变带的半亮中间色穿过胸/裆就是审查漏点，女性形变下依旧明显。
// 几何壳一次解决两件事：
//   · 材质感：壳是独立 SkinnedMesh（法线外扩 6mm 的布料层）+ 独立织物材质
//     （roughness 0.95 深炭灰），有厚度轮廓与边缘收拢，看起来是「衣服」不是「涂色」；
//   · 合规遮盖：遮盖 = **几何遮挡**（壳三角形物理遮住身体表面），不存在颜色混合的
//     半亮像素。敏感带（裆底到锁骨下）内躯干表面 100% 被壳覆盖，tests/suit.spec.ts
//     穷尽断言。
//
// 壳构建（绑定姿态一次）：
//   · 权重场 suitWeight：躯干链+锁骨=1、大腿=裤摆 smoothstep、领口以上衰减（拦下巴泄漏）
//   · 壳三角形 = 三顶点权重均值过阈值（敏感带内放宽），min>0.05 防舔到纯手臂
//   · 壳顶点 = body 顶点 + 法线×offset；offset 随权重收拢（边缘贴身），敏感带内保底 1.5mm
//   · skinIndex/skinWeight 从 body 逐顶点复制，bind 同一 skeleton → 姿势天然跟随
// 形变同步（applyBody 每次调用 applySuitDeform）：
//   壳 position = body 形变后 position + 形变后法线×offset——性别/罩杯/胖瘦形变后
//   布料贴合新体形（maxcup 乳房前突时壳跟着凸起），覆盖区域永不漂移。
//
// 目的：HM08 是裸体网格，素体拍的参考图喂图片模型（H3 refImages）会被安全审查
// 拦截；壳覆盖后图像内容是「穿无袖运动上衣 + 骑行短裤的 CG 人偶」，可正常过审。

import * as THREE from 'three'
import { BONE } from './body.ts'

/** 紧身衣布料色（深炭灰，刻意非肤色）。 */
export const SUIT_COLOR = 0x2f3338
/** 布料粗糙度（比素体陶土 0.82 更糙，织物感）。 */
export const SUIT_ROUGHNESS = 0.95
/** 壳厚（法向外扩，米）。 */
export const SUIT_THICKNESS = 0.006
/** 壳边缘最小厚度（米）：防与身体共面 Z-fighting，同时保证遮挡。 */
export const SUIT_EDGE_MIN = 0.0008
/** 敏感带内壳的最小厚度（米）：敏感区遮挡的硬保底。 */
export const SUIT_SENSITIVE_MIN = 0.0015
/** 壳三角形权重阈值（带外）。 */
export const SUIT_THRESHOLD = 0.35
/** 壳三角形权重阈值（敏感带内放宽：交界三角形也盖，防女性形变后边缘漏点）。 */
export const SUIT_THRESHOLD_SENSITIVE = 0.25

/** 敏感覆盖带（米，绑定姿态）：裆底到锁骨下缘的躯干整圈（胸/乳/腹/骨盆/裆/臀）。
 *  上界 1.32：女性罩杯形变后乳房上缘/乳沟可到 y≈1.30，强制带必须罩住；
 *  领口衰减带（1.409 起）在其上，两带之间的锁骨区靠权重场（锁骨 factor=1）连续覆盖。 */
const SENSITIVE_Y_LO = 0.62
const SENSITIVE_Y_HI = 1.32
export { SENSITIVE_Y_LO, SENSITIVE_Y_HI }

/** 裤摆软化带（米）：下摆下方 5cm 处开始过渡，上方 2cm 处全覆盖。 */
const HEM_FADE_BELOW = 0.05
const HEM_FADE_ABOVE = 0.02

/** 领口带（米）：领口线下 2.5cm 开始淡出，线上 0.5cm 全裸。 */
const NECKLINE_BELOW = 0.025
const NECKLINE_ABOVE = 0.005

/** factor=1 的覆盖骨（躯干链 + 锁骨；锁骨不盖会在肩顶留洞）。 */
const FULL_WEIGHT_BONES: ReadonlySet<string> = new Set([
  BONE.hips, BONE.spine, BONE.spine1, BONE.spine2, BONE.spine3,
  BONE.clavicleL, BONE.clavicleR,
])
const UP_LEG_BONES: ReadonlySet<string> = new Set([BONE.upLegL, BONE.upLegR])

/** 素体输入：绑定姿态下的身体几何与骨架顺序。 */
export interface SuitParams {
  position: THREE.BufferAttribute
  normal: THREE.BufferAttribute
  skinIndex: THREE.BufferAttribute
  skinWeight: THREE.BufferAttribute
  /** skinIndex 值 → 骨对象（skeleton.bones 顺序，需有 name）。 */
  boneList: Array<{ name: string }>
  /** 身体三角形索引。 */
  index: ArrayLike<number>
  /** 短裤下摆（绑定位 y，米）：取髋/膝 rest 位置中点。 */
  shortsHemY: number
  /** 领口线（绑定位 y，米）：取颈骨 rest 位置，权重场在此以上整体淡出。 */
  necklineY: number
}

/** 壳构建结果：独立 SkinnedMesh 的几何与形变映射。 */
export interface SuitBuild {
  /** 壳几何（position/normal/skinIndex/skinWeight/index），bind 后可直接渲染。 */
  geometry: THREE.BufferGeometry
  /** 壳三角形数。 */
  triangleCount: number
  /** 壳顶点 → body 顶点索引（applySuitDeform 用）。 */
  bodyIndexMap: Uint16Array
  /** 每壳顶点法向偏移（米）。 */
  offsets: Float32Array
  /** 每壳顶点的**切向**位移（米）：边界环去锯齿用；内部顶点为 0。
   *  单独存一份是因为形变同步（applySuitDeform）会重算 body+normal×offset，
   *  切向位移必须一起搬过去，否则一改体型锯齿就回来了。 */
  tangent: Float32Array
}

function smoothstep(x: number, lo: number, hi: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

/** 单骨的覆盖权重因子（领口衰减全局生效，拦住权重向上巴/颈前的泄漏）。 */
function suitFactor(boneName: string | undefined, y: number, p: SuitParams): number {
  const neckFade = 1 - smoothstep(y, p.necklineY - NECKLINE_BELOW, p.necklineY + NECKLINE_ABOVE)
  if (neckFade <= 0) return 0
  if (boneName === undefined) return 0
  if (FULL_WEIGHT_BONES.has(boneName)) return neckFade
  if (UP_LEG_BONES.has(boneName)) return smoothstep(y, p.shortsHemY - HEM_FADE_BELOW, p.shortsHemY + HEM_FADE_ABOVE) * neckFade
  return 0
}

/** 顶点的覆盖权重场：覆盖骨权重的加权和（0=裸，1=全盖）。 */
export function suitWeightAt(v: number, p: SuitParams): number {
  let sum = 0
  for (let k = 0; k < 4; k++) {
    const w = p.skinWeight.getComponent(v, k)
    if (w <= 0) continue
    const name = p.boneList[p.skinIndex.getComponent(v, k)]?.name
    if (name === undefined) continue
    sum += w * suitFactor(name, p.position.getY(v), p)
  }
  return sum
}

/** 壳顶点偏移：厚度随权重收拢（边缘贴身），敏感带内保底。 */
function vertexOffset(sw: number, y: number): number {
  const base = SUIT_THICKNESS * smoothstep(sw, 0.25, 0.6)
  const inSensitive = y > SENSITIVE_Y_LO && y < SENSITIVE_Y_HI
  if (inSensitive) return Math.max(base, SUIT_SENSITIVE_MIN)
  return Math.max(base, SUIT_EDGE_MIN)
}

/**
 * 构建紧身衣壳（绑定姿态一次）：
 *   1) 每顶点权重场
 *   2) 逐三角形分类：均值过阈值（敏感带内放宽）且最小值 > 0.05（不舔纯手臂）
 *   3) 壳三角形顶点重映射成独立几何，复制蒙皮权重，position = body + 法线×offset
 * 返回的 geometry bind 到身体 skeleton 后即为可渲染的布料层。
 */
export function buildSuit(p: SuitParams): SuitBuild {
  const n = p.position.count
  const sw = new Float32Array(n)
  for (let v = 0; v < n; v++) sw[v] = suitWeightAt(v, p)

  // 1) 逐三角形分类
  const triCount = Math.floor(p.index.length / 3)
  const suitTris: number[] = []
  for (let t = 0; t < triCount; t++) {
    const a = p.index[t * 3]
    const b = p.index[t * 3 + 1]
    const c = p.index[t * 3 + 2]
    const cy = (p.position.getY(a) + p.position.getY(b) + p.position.getY(c)) / 3
    const threshold = cy > SENSITIVE_Y_LO && cy < SENSITIVE_Y_HI ? SUIT_THRESHOLD_SENSITIVE : SUIT_THRESHOLD
    const avg = (sw[a] + sw[b] + sw[c]) / 3
    const min = Math.min(sw[a], sw[b], sw[c])
    if (avg > threshold && min > 0.05) suitTris.push(a, b, c)
  }

  // 2) 壳顶点重映射（只收壳三角形引用的顶点）
  const bodyIndexOf = new Int32Array(n).fill(-1)
  const bodyIndexMap: number[] = []
  for (const v of suitTris) {
    if (bodyIndexOf[v] === -1) {
      bodyIndexOf[v] = bodyIndexMap.length
      bodyIndexMap.push(v)
    }
  }
  const vn = bodyIndexMap.length

  // 3) 壳几何属性
  const offsets = new Float32Array(vn)
  const position = new Float32Array(vn * 3)
  const normal = new Float32Array(vn * 3)
  const skinIndex = new Uint16Array(vn * 4)
  const skinWeight = new Float32Array(vn * 4)
  for (let i = 0; i < vn; i++) {
    const v = bodyIndexMap[i]
    offsets[i] = vertexOffset(sw[v], p.position.getY(v))
    for (let k = 0; k < 3; k++) {
      position[i * 3 + k] = p.position.getComponent(v, k) + p.normal.getComponent(v, k) * offsets[i]
      normal[i * 3 + k] = p.normal.getComponent(v, k)
    }
    for (let k = 0; k < 4; k++) {
      skinIndex[i * 4 + k] = p.skinIndex.getComponent(v, k)
      skinWeight[i * 4 + k] = p.skinWeight.getComponent(v, k)
    }
  }

  // 4) 壳 index（重映射后的三角形）
  const index = new Uint32Array(suitTris.length)
  for (let t = 0; t < suitTris.length / 3; t++) {
    index[t * 3] = bodyIndexOf[suitTris[t * 3]]
    index[t * 3 + 1] = bodyIndexOf[suitTris[t * 3 + 1]]
    index[t * 3 + 2] = bodyIndexOf[suitTris[t * 3 + 2]]
  }

  // 4.5) 边界环平滑（去锯齿）
  //   壳的边界是「按三角形阈值切」出来的 → 轮廓在网格粒度上是锯齿（实机：肩部与
  //   领口一圈像撕破的布，实机截图最扎眼的第二处缺陷）。做法：对边界环做拉普拉斯
  //   平滑，但**位移只投影到切平面**（沿体表滑，不穿体表），法线方向的高度
  //   （body + normal×offset）保持不变 → 轮廓变平滑、仍贴着体表，覆盖面积不变小。
  //   （不能直接做 3D 平滑：边界顶点会被拉到体表内侧 → 皮肤从破口钻出来。）
  const tangent = new Float32Array(vn * 3)
  const build_v = (i: number) => bodyIndexMap[i]
  {
    const edgeCount = new Map<string, number>()
    const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)
    const edgeVerts = new Map<string, [number, number]>()
    for (let t = 0; t < index.length; t += 3) {
      const tri = [index[t], index[t + 1], index[t + 2]]
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3]
        const k = edgeKey(a, b)
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1)
        edgeVerts.set(k, [a, b])
      }
    }
    const nb = new Map<number, number[]>()
    for (const [k, c] of edgeCount) {
      if (c !== 1) continue
      const [a, b] = edgeVerts.get(k)!
      if (!nb.has(a)) nb.set(a, [])
      if (!nb.has(b)) nb.set(b, [])
      nb.get(a)!.push(b)
      nb.get(b)!.push(a)
    }
    const SMOOTH_STEPS = 3
    const SMOOTH_RATE = 0.6
    const tmp = new Float32Array(3)
    for (let step = 0; step < SMOOTH_STEPS; step++) {
      const next = position.slice()
      for (const [v, neigh] of nb) {
        if (neigh.length < 2) continue
        let ax = 0, ay = 0, az = 0
        for (const n of neigh) { ax += position[n * 3]; ay += position[n * 3 + 1]; az += position[n * 3 + 2] }
        ax /= neigh.length; ay /= neigh.length; az /= neigh.length
        const dx = ax - position[v * 3], dy = ay - position[v * 3 + 1], dz = az - position[v * 3 + 2]
        const nx = normal[v * 3], ny = normal[v * 3 + 1], nz = normal[v * 3 + 2]
        const dn = dx * nx + dy * ny + dz * nz
        // 切平面分量（去掉法线方向 → 沿体表滑，不穿体表）
        tmp[0] = (dx - dn * nx) * SMOOTH_RATE
        tmp[1] = (dy - dn * ny) * SMOOTH_RATE
        tmp[2] = (dz - dn * nz) * SMOOTH_RATE
        next[v * 3] = position[v * 3] + tmp[0]
        next[v * 3 + 1] = position[v * 3 + 1] + tmp[1]
        next[v * 3 + 2] = position[v * 3 + 2] + tmp[2]
      }
      position.set(next)
    }
    // 把累计位移记成切向向量（相对原始 body+normal×offset）
    for (let i = 0; i < vn; i++) {
      const v = build_v(i)
      tangent[i * 3] = position[i * 3] - (p.position.getComponent(v, 0) + p.normal.getComponent(v, 0) * offsets[i])
      tangent[i * 3 + 1] = position[i * 3 + 1] - (p.position.getComponent(v, 1) + p.normal.getComponent(v, 1) * offsets[i])
      tangent[i * 3 + 2] = position[i * 3 + 2] - (p.position.getComponent(v, 2) + p.normal.getComponent(v, 2) * offsets[i])
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4))
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.computeBoundingSphere()
  return { geometry, triangleCount: suitTris.length / 3, bodyIndexMap: new Uint16Array(bodyIndexMap), offsets, tangent }
}

/**
 * 身体形变后重建壳顶点（applyBody 每次调用）：
 * 壳 position = body 形变后 position + 形变后法线×offset，法线直接沿用 body 的
 * （外扩仅数 mm，法线偏差可忽略）。布料贴合任意 morph 后的新体形。
 */
export function applySuitDeform(
  build: SuitBuild,
  bodyPos: Float32Array,
  bodyNor: Float32Array,
  suitPos: Float32Array,
  suitNor: Float32Array,
): void {
  const vn = build.bodyIndexMap.length
  const tangent = build.tangent
  for (let i = 0; i < vn; i++) {
    const bi = build.bodyIndexMap[i] * 3
    const o = i * 3
    const off = build.offsets[i]
    suitPos[o] = bodyPos[bi] + bodyNor[bi] * off + tangent[o]
    suitPos[o + 1] = bodyPos[bi + 1] + bodyNor[bi + 1] * off + tangent[o + 1]
    suitPos[o + 2] = bodyPos[bi + 2] + bodyNor[bi + 2] * off + tangent[o + 2]
    suitNor[o] = bodyNor[bi]
    suitNor[o + 1] = bodyNor[bi + 1]
    suitNor[o + 2] = bodyNor[bi + 2]
  }
}

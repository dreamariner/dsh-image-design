// 求解器的几何宿主：把「骨架 + 蒙皮网格」抽象成 SolverHost 能用的几件事。
//
// 为什么单独一层：求解器（物理 + 约束 + IK）不该关心几何从哪来 ——
// 运行时是 three 的 SkinnedMesh，离线测试是还原出来的夹具。两边**同一套**逻辑，
// 才谈得上「离线调好的姿势，运行时就是那个姿势」。
//
// 宿主提供的东西：
//   · 骨位 / 骨朝向（体段轴、锚点解析要用）
//   · 顶点的主导骨（碰撞探针、量半径要用）
//   · 蒙皮（把姿势落到网格上）
// 由这些派生出来的：
//   · 末端碰撞探针（掌心 / 指尖 / 脚底）
//   · 体段解析代理（碰撞用）与整段代理（语义锚点用）
//   · 手部静息系与尺寸（腕→掌心、掌厚）

import * as THREE from 'three'
import { JOINT_BONES, type RigBinding } from './rig.ts'
import { JOINT_NAMES, type JointName } from './body.ts'
import { makeHandFrame, type HandFrame } from './ik.ts'
import { EllipsoidSegment, measureSegmentRadii, measureRadialProfile, type RadialProfile } from './contact.ts'
import type { JointRotations } from './poses.ts'
import type { EndEffectorId, SolverHost, Vec3 } from './solver.ts'

/** 求解器需要的几何来源（运行时与测试夹具各实现一份）。 */
export interface MannequinGeometry {
  /** 骨名 → 当前世界位置（模型空间）。 */
  boneAt(name: string): THREE.Vector3
  /**
   * 骨名 → **父骨**的世界朝向（模型空间）。
   *
   * IK 求的是「骨自身的局部旋转」，必须以**父骨**朝向为基准 —— 用骨自己的朝向当基准
   * 会让链条越算越歪（实测小腿被甩到体侧 9cm，姿势完全跑偏）✓。
   */
  boneParentQuat(name: string): THREE.Quaternion
  /**
   * 骨名 → **绑定姿态**的世界位置（模型空间）。
   *
   * 手部尺寸、半轴半径这些量必须是静态的（骨长与姿势无关 ✓）——
   * 用当前骨位量会随姿势漂 → 同一目标两次求解结果不同（确定性破了）✓。
   */
  bindBoneAt(name: string): THREE.Vector3
  /** 骨名 → 世界朝向（模型空间）；没有就返回 undefined（横截面基退化为世界竖直）。 */
  boneQuat(name: string): THREE.Quaternion | undefined
  /** 顶点数。 */
  vertexCount: number
  /** 绑定姿态的顶点位置（模型空间，xyz 连续）。 */
  bindPositions: Float32Array
  /** 绑定姿态的顶点法线（xyz 连续）。 */
  bindNormals: Float32Array
  /** 顶点的主导骨名。 */
  dominantBone(i: number): string
  /** 顶点的主导骨权重（退化混合顶点接近 0，真皮肤顶点通常 ≥ 0.5）。 */
  dominantWeight(i: number): number
  /** 应用姿势（模型空间）并返回指定顶点的蒙皮后位置（xyz 连续）。 */
  applyPose(joints: JointRotations, root: Vec3, verts: number[]): Float32Array
}

/** 体段规格：碰撞代理（拆上下两半）与锚点代理（整段）。 */
interface SegmentSpec {
  name: string
  aBone: string
  bBone: string
  verts: string[]
  /** 段的终点参数（1 = 到末端骨；小腿收到 0.9：踝以下归脚管）。 */
  tHi?: number
}

/** 碰撞代理：躯干拆四段（髋宽胸窄，整段一个椭球太粗）、大腿拆上下两半。 */
const COLLISION_SEGMENTS: SegmentSpec[] = [
  { name: 'leftThighUpper', aBone: 'mixamorigLeftUpLeg', bBone: 'mixamorigLeftLeg', verts: ['mixamorigLeftUpLeg'] },
  { name: 'leftThighLower', aBone: 'mixamorigLeftUpLeg', bBone: 'mixamorigLeftLeg', verts: ['mixamorigLeftUpLeg'] },
  { name: 'rightThighUpper', aBone: 'mixamorigRightUpLeg', bBone: 'mixamorigRightLeg', verts: ['mixamorigRightUpLeg'] },
  { name: 'rightThighLower', aBone: 'mixamorigRightUpLeg', bBone: 'mixamorigRightLeg', verts: ['mixamorigRightUpLeg'] },
  { name: 'leftShin', aBone: 'mixamorigLeftLeg', bBone: 'mixamorigLeftFoot', verts: ['mixamorigLeftLeg'], tHi: 0.9 },
  { name: 'rightShin', aBone: 'mixamorigRightLeg', bBone: 'mixamorigRightFoot', verts: ['mixamorigRightLeg'], tHi: 0.9 },
  { name: 'torsoLower', aBone: 'mixamorigHips', bBone: 'mixamorigSpine', verts: ['mixamorigHips'] },
  { name: 'torsoMid', aBone: 'mixamorigSpine', bBone: 'mixamorigSpine2', verts: ['mixamorigSpine', 'mixamorigSpine1'] },
  { name: 'torsoUpper', aBone: 'mixamorigSpine2', bBone: 'mixamorigSpine3', verts: ['mixamorigSpine2', 'mixamorigSpine3'] },
  // 上胸到颈根（spine3 → neck）：2026-11-18 实测漏了这段 —— 手横穿胸口时腕点
  // 落在 y 1.28~1.43 的空档里，代理全说「体外」而网格审计说插进胸口 66~166mm。
  // 顶点集必须带上 neck：上胸/锁骨带的顶点大量挂在 neck 骨上（spine3 只有 189 个、
  // |x| p92=0.082，量出来的胸半宽只有 6.5cm，真胸 ~12cm → 代理细成一根棍，挡不住）✓。
  // 再带上**锁骨骨**（2026-11-19）：胸大肌与三角肌根部挂在 clavicle 上，
  // 漏了它腋下/胸前的代理薄一圈 → 手横穿胸口时上臂擦进腋下网格
  // （实测上臂入胸 17.6mm，代理判体外）✓。
  { name: 'torsoChest', aBone: 'mixamorigSpine3', bBone: 'mixamorigNeck', verts: ['mixamorigSpine3', 'mixamorigNeck', 'mixamorigLeftShoulder', 'mixamorigRightShoulder'] },
]

/** 语义锚点用的整段代理：「手搭在大腿中段」说的是整条腿。 */
const ANCHOR_SEGMENTS: SegmentSpec[] = [
  { name: 'leftThigh', aBone: 'mixamorigLeftUpLeg', bBone: 'mixamorigLeftLeg', verts: ['mixamorigLeftUpLeg'] },
  { name: 'rightThigh', aBone: 'mixamorigRightUpLeg', bBone: 'mixamorigRightLeg', verts: ['mixamorigRightUpLeg'] },
  { name: 'leftShin', aBone: 'mixamorigLeftLeg', bBone: 'mixamorigLeftFoot', verts: ['mixamorigLeftLeg'] },
  { name: 'rightShin', aBone: 'mixamorigRightLeg', bBone: 'mixamorigRightFoot', verts: ['mixamorigRightLeg'] },
  { name: 'torso', aBone: 'mixamorigHips', bBone: 'mixamorigSpine3', verts: ['mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigSpine3'] },
]

/** 半径剖面的分段数（沿解剖 t）。 */
const PROFILE_BANDS = 8

/** 末端所属侧。 */
export function effectorSide(id: EndEffectorId): 'Left' | 'Right' {
  return id === 'handL' || id === 'footL' ? 'Left' : 'Right'
}

/**
 * 由几何来源构造 SolverHost。
 *
 * @param geom 几何来源
 * @param binding 骨架绑定（求解器写回姿势要用）
 */
export function createSolverHost(geom: MannequinGeometry, binding: RigBinding): SolverHost {
  // 主导骨 → 顶点索引
  const vertsOfBone = new Map<string, number[]>()
  for (let i = 0; i < geom.vertexCount; i++) {
    const n = geom.dominantBone(i)
    const list = vertsOfBone.get(n)
    if (list === undefined) vertsOfBone.set(n, [i])
    else list.push(i)
  }

  const bindPositions = geom.bindPositions
  const bindBoneAt = (name: string): THREE.Vector3 => geom.bindBoneAt(name)

  // ── 末端碰撞探针 ─────────────────────────────────────────────────────
  // 约定：probes[0] = 掌心（脚则是脚底中段），其余是指尖 / 脚尖 / 脚跟。
  const probeCache = new Map<EndEffectorId, number[]>()
  const volumeCache = new Map<EndEffectorId, number[]>()
  const probes = (id: EndEffectorId): number[] => {
    const cached = probeCache.get(id)
    if (cached !== undefined) return cached
    const isHand = id === 'handL' || id === 'handR'
    const side = effectorSide(id)
    const bones = isHand
      ? [`mixamorig${side}Hand`, `mixamorig${side}HandEnd`]
      : [`mixamorig${side}Foot`, `mixamorig${side}ToeBase`]
    const verts: number[] = []
    for (const bn of bones) for (const vi of vertsOfBone.get(bn) ?? []) verts.push(vi)
    // 主导权重过滤：模型导出会在原点附近留少量**退化混合顶点**（权重摊到 4 根
    // 骨、每根 ~0.3，主导骨是「险胜」的假象），蒙皮位置也不可信（HM08 实测 6 个
    // 原点顶点混进脚部探针：y=0.000 必然当选「脚底」，且相对踝的偏移 ≈19cm 落在
    // 两脚中间 → 目标投影把左脚目标朝右腿推、右脚朝左腿推 → 双腿互相推成极限环，
    // 跪坐永不落定，2026-11-19）。权重不过半的顶点不配当探针 ✓。
    const strong = verts.filter((vi) => geom.dominantWeight(vi) >= 0.5)
    const pool = strong.length > 0 ? strong : verts
    const wrist = geom.boneAt(`mixamorig${side}${isHand ? 'Hand' : 'Foot'}`)
    const posOf = (vi: number) => new THREE.Vector3(
      bindPositions[vi * 3], bindPositions[vi * 3 + 1], bindPositions[vi * 3 + 2],
    )
    if (pool.length === 0) {
      probeCache.set(id, [])
      return []
    }
    const maxDist = Math.max(...pool.map((vi) => posOf(vi).distanceTo(wrist)))
    // 掌心：离腕 45% 处、离轴最近的顶点
    let palmIdx = pool[0]
    let palmBest = Infinity
    for (const vi of pool) {
      const d = posOf(vi).distanceTo(wrist)
      if (Math.abs(d - maxDist * 0.45) > maxDist * 0.12) continue
      const score = Math.abs(d - maxDist * 0.45)
      if (score < palmBest) { palmBest = score; palmIdx = vi }
    }
    if (!isHand) {
      // 脚底：取中段（离踝 25%~60%）里最低的顶点 = 脚掌着地处
      //   ⚠ 不能取脚背：脚背顶点落在小腿代理的半径里，会被判成「陷进小腿」
      //     → 接触求解把脚一次次甩出去 → 求解发散。
      let best = Infinity
      for (const vi of pool) {
        const p = posOf(vi)
        const d = p.distanceTo(wrist)
        if (d < maxDist * 0.25 || d > maxDist * 0.6) continue
        if (p.y < best) { best = p.y; palmIdx = vi }
      }
    }
    // 指尖 / 脚尖：远端顶点按粗格去重
    const tips: number[] = []
    const seenCells = new Set<string>()
    for (const vi of pool) {
      const p = posOf(vi)
      if (p.distanceTo(wrist) < maxDist * 0.82) continue
      const key = `${Math.round(p.x / 0.04)}:${Math.round(p.y / 0.04)}:${Math.round(p.z / 0.04)}`
      if (seenCells.has(key)) continue
      seenCells.add(key)
      tips.push(vi)
    }
    const out = [palmIdx, ...tips].slice(0, 12)
    if (!isHand) {
      // 脚跟：踝后方最低的顶点（脚跟离地也要算）
      let heelIdx = palmIdx
      let heelY = Infinity
      for (const vi of pool) {
        const p = posOf(vi)
        if (p.z >= wrist.z) continue
        if (p.y < heelY) { heelY = p.y; heelIdx = vi }
      }
      out.push(heelIdx)
      // 脚尖：最靠前的顶点
      let toeIdx = palmIdx
      let toeZ = -Infinity
      for (const vi of pool) {
        const p = posOf(vi)
        if (p.z > toeZ) { toeZ = p.z; toeIdx = vi }
      }
      out.push(toeIdx)
      // 脚背中段（跪坐时脚背朝下贴地）
      let dorsumIdx = palmIdx
      let dorsumY = -Infinity
      for (const vi of pool) {
        const p = posOf(vi)
        const d = p.distanceTo(wrist)
        if (d < maxDist * 0.15 || d > maxDist * 0.55) continue
        if (p.y > dorsumY) { dorsumY = p.y; dorsumIdx = vi }
      }
      out.push(dorsumIdx)
      // 脚掌最低的几个顶点（地面接触按脚掌最低点算）
      const lows = pool
        .map((vi) => ({ vi, y: bindPositions[vi * 3 + 1] }))
        .sort((a, b) => a.y - b.y)
        .slice(0, 3)
      for (const l of lows) out.push(l.vi)
    }
    probeCache.set(id, out)
    return out
  }

  /**
   * 末端的整块体积顶点（手 = 全部手掌/手指顶点）。
   *
   * 用途：算手的**外形包络**（支撑点 ≈ 凸包角点）。探针只有「掌心 + 指尖」
   * 几个点，会漏掉掌缘角点 —— walk 实测右手指尖入腿 53mm、探针只判 5mm ✓。
   * 主导权重不过半的退化顶点照样剔除（同 probes 的口径）✓。
   */
  const volumeVerts = (id: EndEffectorId): number[] => {
    const cached = volumeCache.get(id)
    if (cached !== undefined) return cached
    const isHand = id === 'handL' || id === 'handR'
    const side = effectorSide(id)
    const bones = isHand
      ? [`mixamorig${side}Hand`, `mixamorig${side}HandEnd`]
      : [`mixamorig${side}Foot`, `mixamorig${side}ToeBase`]
    const verts: number[] = []
    for (const bn of bones) for (const vi of vertsOfBone.get(bn) ?? []) verts.push(vi)
    const strong = verts.filter((vi) => geom.dominantWeight(vi) >= 0.5)
    const out = strong.length > 0 ? strong : verts
    volumeCache.set(id, out)
    return out
  }

  // ── 体段代理 ─────────────────────────────────────────────────────────
  const radiiOf = (spec: SegmentSpec, tLo: number, tHi: number): { radiusU: number; radiusV: number } => {
    const a = bindBoneAt(spec.aBone)
    const b = bindBoneAt(spec.bBone)
    const verts: number[] = []
    for (const bn of spec.verts) for (const vi of vertsOfBone.get(bn) ?? []) verts.push(vi)
    return measureSegmentRadii(bindPositions, verts, a, b, tLo, tHi, 0.92, geom.boneQuat(spec.aBone))
  }

  const collisionRadii = new Map<string, { radiusU: number; radiusV: number }>()
  const collisionRadial = new Map<string, RadialProfile>()
  for (const spec of COLLISION_SEGMENTS) {
    const isThigh = spec.name.includes('Thigh')
    const tLo = spec.name.endsWith('Upper') ? 0 : isThigh ? 0.5 : 0
    const tHi = spec.name.endsWith('Upper') ? 0.5 : isThigh ? 1 : (spec.tHi ?? 1)
    collisionRadii.set(spec.name, radiiOf(spec, tLo, tHi))
    // 角向半径剖面：截面不是圆（大腿外侧 ~6cm、内前 ~16cm），椭球拟合把外侧也
    // 撑到 11cm → 指尖贴腿面（网格审计 0.6mm）被判「体内 4.8cm」→ 指尖修正误
    // 触发大腕屈（2026-11-18 实测 stand 腕屈 7°→57°）。按截面角记真实表面半径 ✓。
    const verts: number[] = []
    for (const bn of spec.verts) for (const vi of vertsOfBone.get(bn) ?? []) verts.push(vi)
    collisionRadial.set(spec.name, measureRadialProfile(
      bindPositions, verts,
      bindBoneAt(spec.aBone), bindBoneAt(spec.bBone),
      tLo, tHi, geom.boneQuat(spec.aBone),
    ))
  }

  const segments = (): EllipsoidSegment[] => {
    const out: EllipsoidSegment[] = []
    for (const spec of COLLISION_SEGMENTS) {
      const a = geom.boneAt(spec.aBone)
      const full = geom.boneAt(spec.bBone)
      const r = collisionRadii.get(spec.name)!
      const b = (spec.tHi ?? 1) < 1 ? a.clone().lerp(full, spec.tHi!) : full
      const quat = geom.boneQuat(spec.aBone)
      // Upper/Lower 拆半的段：剖面参数要重新映射到半段（段的 t ∈ [0,1] 对应整段的
      // 前一半 / 后一半），否则半段拿到的是整段的剖面（半径错位）✓。
      const remap = (t: number): number =>
        spec.name.endsWith('Upper') ? t * 0.5
          : spec.name.endsWith('Lower') ? 0.5 + t * 0.5
          : (spec.tHi ?? 1) < 1 ? t * (spec.tHi ?? 1)
          : t
      const radial = collisionRadial.get(spec.name)
      const remappedRadial: RadialProfile | undefined = radial === undefined
        ? undefined
        : { at: (tf, ang) => radial.at(remap(tf), ang) }
      if (spec.name.endsWith('Upper')) {
        const mid = a.clone().lerp(b, 0.5)
        out.push(new EllipsoidSegment(spec.name, a, mid, r.radiusU, r.radiusV, quat, undefined, remappedRadial))
      } else if (spec.name.endsWith('Lower')) {
        const mid = a.clone().lerp(b, 0.5)
        out.push(new EllipsoidSegment(spec.name, mid, b, r.radiusU, r.radiusV, quat, undefined, remappedRadial))
      } else {
        out.push(new EllipsoidSegment(spec.name, a, b, r.radiusU, r.radiusV, quat, undefined, remappedRadial))
      }
    }
    return out
  }

  // ── 锚点代理（整段 + 半径剖面）───────────────────────────────────────
  const anchorRadii = new Map<string, { radiusU: number; radiusV: number }>()
  const anchorProfiles = new Map<string, (t: number) => { radiusU: number; radiusV: number }>()
  for (const spec of ANCHOR_SEGMENTS) {
    anchorRadii.set(spec.name, radiiOf(spec, 0, 1))
    // 剖面：按解剖 t 分段量「宽/深」两个半轴（用骨的局部朝向，方向明确 ✓），插值取用
    const bands: { radiusU: number; radiusV: number }[] = []
    for (let i = 0; i < PROFILE_BANDS; i++) {
      bands.push(radiiOf(spec, i / PROFILE_BANDS, (i + 1) / PROFILE_BANDS))
    }
    anchorProfiles.set(spec.name, (t: number) => {
      const x = THREE.MathUtils.clamp(t, 0, 0.9999) * PROFILE_BANDS
      const i = Math.floor(x)
      const f = x - i
      const a0 = bands[i]
      const a1 = bands[Math.min(PROFILE_BANDS - 1, i + 1)]
      return {
        radiusU: a0.radiusU + (a1.radiusU - a0.radiusU) * f,
        radiusV: a0.radiusV + (a1.radiusV - a0.radiusV) * f,
      }
    })
  }
  const anchorSegment = (name: string): EllipsoidSegment | undefined => {
    const spec = ANCHOR_SEGMENTS.find((s) => s.name === name)
    if (spec === undefined) return undefined
    const r = anchorRadii.get(name)!
    return new EllipsoidSegment(
      name, geom.boneAt(spec.aBone), geom.boneAt(spec.bBone), r.radiusU, r.radiusV,
      geom.boneQuat(spec.aBone), anchorProfiles.get(name),
    )
  }

  // ── 手部静息系与尺寸 ─────────────────────────────────────────────────
  /** 手部静息系（掌心法向 + 手轴）。 */
  const restHandFrame = (side: 'Left' | 'Right'): HandFrame => {
    const wrist = bindBoneAt(`mixamorig${side}Hand`)
    const handVerts: number[] = []
    for (const bn of [`mixamorig${side}Hand`, `mixamorig${side}HandEnd`]) {
      for (const vi of vertsOfBone.get(bn) ?? []) handVerts.push(vi)
    }
    const posOf = (vi: number) => new THREE.Vector3(
      bindPositions[vi * 3], bindPositions[vi * 3 + 1], bindPositions[vi * 3 + 2],
    )
    const distOf = (vi: number) => posOf(vi).distanceTo(wrist)
    const handLen = handVerts.length > 0 ? Math.max(...handVerts.map(distOf)) : 0.1
    const tipVerts = handVerts.filter((vi) => distOf(vi) > handLen * 0.8)
    const tips = new THREE.Vector3()
    for (const vi of tipVerts) tips.add(posOf(vi))
    tips.multiplyScalar(1 / Math.max(1, tipVerts.length))
    const forward = tips.clone().sub(wrist).normalize()
    // 掌心法向：取「法向指向身体中线」那半边的顶点法线均值。
    // ⚠ 过滤轴必须是 medial 本身（2026-11-19 实机修）：旧实现用
    // axisNormal = cross(forward, medial) 过滤 —— 这个轴垂直于手轴与朝内方向，
    // 实际选中的是**手背一侧**（HM08 绑定实测选中顶点法线均值 (0.99,0.08,−0.08)
    // 朝外）→ rest 帧的「掌法线」实为手背方向 → 求解器把「手背」映射到目标的
    // 「掌心」→ 所有姿势掌心整体翻 180°（手背贴腿、手指自然弯看着像反折）。
    const medial = new THREE.Vector3(-(Math.sign(wrist.x) || 1), 0, 0)
    const sideAxis = new THREE.Vector3().crossVectors(forward, medial).normalize()
    const axisNormal = new THREE.Vector3().crossVectors(forward, sideAxis).normalize()
    const acc = new THREE.Vector3()
    for (const vi of handVerts) {
      const p = posOf(vi)
      const along = p.clone().sub(wrist).dot(forward)
      if (along < handLen * 0.3 || along > handLen * 0.75) continue
      const off = p.clone().sub(wrist.clone().addScaledVector(forward, along))
      if (off.length() > 0.035) continue
      const nrm = new THREE.Vector3(
        geom.bindNormals[vi * 3], geom.bindNormals[vi * 3 + 1], geom.bindNormals[vi * 3 + 2],
      )
      // 掌侧 = 法线带朝内分量（身体中线方向）
      if (nrm.dot(medial) <= 0) continue
      acc.add(nrm)
    }
    const palmNormal = acc.lengthSq() > 1e-12 ? acc.normalize() : axisNormal.clone()
    return makeHandFrame(forward, palmNormal)
  }

  /**
   * 手部尺寸：腕→掌心沿手轴距离、掌面到手轴距离（≈掌厚）。
   *
   * 手掌区域取「沿手轴 20%~45%」的顶点（用投影而不是离腕距离：这个模型手指张开，
   * 最远顶点落在指尖，按距离取会把手掌算到手掌外 ✗）。
   */
  const handMetrics = (side: 'Left' | 'Right'): { along: number; offset: number } => {
    const wrist = bindBoneAt(`mixamorig${side}Hand`)
    const frame = restHandFrame(side)
    const handVerts: number[] = []
    for (const bn of [`mixamorig${side}Hand`, `mixamorig${side}HandEnd`]) {
      for (const vi of vertsOfBone.get(bn) ?? []) handVerts.push(vi)
    }
    if (handVerts.length === 0) return { along: 0.09, offset: 0.025 }
    const posOf = (vi: number) => new THREE.Vector3(
      bindPositions[vi * 3], bindPositions[vi * 3 + 1], bindPositions[vi * 3 + 2],
    )
    let maxAlong = 0
    for (const vi of handVerts) maxAlong = Math.max(maxAlong, posOf(vi).sub(wrist).dot(frame.forward))
    const palmVerts = handVerts.filter((vi) => {
      const a = posOf(vi).sub(wrist).dot(frame.forward)
      return a > maxAlong * 0.2 && a < maxAlong * 0.45
    })
    const use = palmVerts.length > 0 ? palmVerts : handVerts
    const centre = new THREE.Vector3()
    for (const vi of use) centre.add(posOf(vi))
    centre.multiplyScalar(1 / use.length)
    const along = centre.sub(wrist).dot(frame.forward)
    let offset = 0
    for (const vi of use) {
      offset = Math.max(offset, posOf(vi).sub(wrist).dot(frame.normal))
    }
    return { along, offset }
  }

  return {
    binding,
    applyPose: (joints, root, verts) => geom.applyPose(joints, root, verts),
    boneAt: (name) => geom.boneAt(name),
    boneParentQuat: (name) => geom.boneParentQuat(name),
    effectorProbes: probes,
    effectorVolumeVerts: volumeVerts,
    segments,
    anchorSegment,
    restHandFrame,
    handMetrics,
  }
}

/** 关节名 → 骨名（宿主实现里常用）。 */
export const BONE_OF = JOINT_BONES

/** 关节名列表（宿主实现里初始化 restLocal 用）。 */
export const JOINT_LIST = JOINT_NAMES

export type { JointName }

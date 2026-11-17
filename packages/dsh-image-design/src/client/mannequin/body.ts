// 体型参数面 + 参数 → 形变指令。
//
// 人偶是**真实人体网格 + 自建骨架**（MakeHuman base.obj → 骨架 → 蒙皮，见
// scripts/build-mannequin-body.mjs）。体型参数分两类落地方式：
//
//   1) 网格形变（绑定姿态 LBS 混合）：围度类（胸 / 腰 / 臀 / 肩宽 / 四肢粗细 / 头身比）
//      必须走网格形变 —— 只缩放脊柱那几根骨，躯干蒙皮权重是跨骨平滑过渡的，
//      肉眼看不出围度变化（这是上一版滑杆「形同虚设」的根因）。
//   2) 骨链长度（臂长 / 腿长）：缩放骨与子骨之间的位移，关节跟着走，长度真的变。
//
// 身高走外层整体缩放（holder.scale），与骨架无关。

export interface BodyParams {
  /** 身高（cm）。 */
  height: number
  /** 头身比（头高 ÷ 身高），越大头越小。 */
  headRatio: number
  /** 肩宽系数（1 = 默认）。 */
  shoulderWidth: number
  /** 胸围系数（1 = 默认）。 */
  bust: number
  /** 腰围系数。 */
  waist: number
  /** 臀围系数。 */
  hip: number
  /** 四肢粗细系数。 */
  limbThickness: number
  /** 臂长系数。 */
  armLength: number
  /** 腿长系数。 */
  legLength: number
}

export const DEFAULT_BODY: BodyParams = {
  height: 170,
  headRatio: 7.5,
  shoulderWidth: 1,
  bust: 1,
  waist: 1,
  hip: 1,
  limbThickness: 1,
  armLength: 1,
  legLength: 1,
}

/** 滑杆量程（UI 与校验共用）。 */
export const BODY_RANGES: Record<keyof BodyParams, { min: number; max: number; step: number }> = {
  height: { min: 130, max: 210, step: 1 },
  headRatio: { min: 6, max: 9, step: 0.1 },
  shoulderWidth: { min: 0.8, max: 1.3, step: 0.01 },
  bust: { min: 0.6, max: 1.6, step: 0.01 },
  waist: { min: 0.6, max: 1.6, step: 0.01 },
  hip: { min: 0.7, max: 1.5, step: 0.01 },
  limbThickness: { min: 0.6, max: 1.6, step: 0.01 },
  armLength: { min: 0.85, max: 1.15, step: 0.01 },
  legLength: { min: 0.85, max: 1.15, step: 0.01 },
}

/** 关节名（16 个可调关节；与 rig.ts 的骨映射一一对应）。 */
export const JOINT_NAMES = [
  'spine', 'chest', 'neck', 'head',
  'shoulderL', 'elbowL', 'wristL',
  'shoulderR', 'elbowR', 'wristR',
  'hipL', 'kneeL', 'ankleL',
  'hipR', 'kneeR', 'ankleR',
] as const

export type JointName = (typeof JOINT_NAMES)[number]

/** 骨名（与 build-mannequin-body.mjs 里建的骨架一一对应）。 */
export const BONE = {
  hips: 'mixamorigHips',
  spine: 'mixamorigSpine',
  spine1: 'mixamorigSpine1',
  spine2: 'mixamorigSpine2',
  spine3: 'mixamorigSpine3',
  neck: 'mixamorigNeck',
  head: 'mixamorigHead',
  clavicleL: 'mixamorigLeftShoulder',
  armL: 'mixamorigLeftArm',
  foreArmL: 'mixamorigLeftForeArm',
  handL: 'mixamorigLeftHand',
  clavicleR: 'mixamorigRightShoulder',
  armR: 'mixamorigRightArm',
  foreArmR: 'mixamorigRightForeArm',
  handR: 'mixamorigRightHand',
  upLegL: 'mixamorigLeftUpLeg',
  legL: 'mixamorigLeftLeg',
  footL: 'mixamorigLeftFoot',
  upLegR: 'mixamorigRightUpLeg',
  legR: 'mixamorigRightLeg',
  footR: 'mixamorigRightFoot',
} as const

/** 形变模式：
 *  · `region` —— **区域场形变**（围度类用它）：在骨心附近按高度做平滑权重，直接改
 *    顶点。只作用于「主导骨」是该骨的顶点（躯干骨），所以手臂腿不会被误改。
 *    为什么不用骨级缩放：躯干是跨骨平滑蒙皮的（胸腔同时吃 spine / spine1 / spine2），
 *    单根骨的缩放会被权重稀释，围度几乎看不出来（上一版「滑杆形同虚设」的根因）。
 *  · `radial` —— 垂直骨轴的均匀放大（四肢粗细用它，不挪关节位置）
 *  · `uniform`—— 各向同性（头身比用它）
 *  · `axis`   —— 绕骨心的世界轴向缩放（锁骨横向撑开用）
 */
export type ShapeMode = 'region' | 'axis' | 'radial' | 'uniform'

export interface ShapeTune {
  /** 提供形变中心（骨心）与作用范围（躯干骨集合）。 */
  bone: string
  mode: ShapeMode
  /** region：世界 x/z 缩放；axis：世界 x/y/z 缩放；radial / uniform：只用 [0]。 */
  scale: [number, number, number]
  /** region 模式的半高（m）：中心权重 1，向外平滑衰减到 0。 */
  height?: number
}

const clamp1 = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 围度类系数 → 缩放系数（1 = 不变；往 1.5 走是「更粗」）。 */
const girth = (k: number, depth: number): number => 1 + (clamp1(k, 0.5, 2) - 1) * depth

/** 躯干骨集合（区域形变只作用于这些骨主导的顶点，避免误改手臂腿）。 */
export const TORSO_BONES: readonly string[] = [
  BONE.hips, BONE.spine, BONE.spine1, BONE.spine2, BONE.spine3,
]

/**
 * 体型参数 → 网格形变指令表。
 *
 * 围度用「区域场」：在胸 / 腰 / 臀各自的高度带上做平滑缩放（绕身体中线），
 * 肩用锁骨横向撑开，四肢用垂直骨轴放大，头用各向同性。
 */
export function shapeTunes(params: BodyParams): ShapeTune[] {
  const headK = 7.5 / clamp1(params.headRatio, 5, 10)
  const limb = clamp1(params.limbThickness, 0.4, 2)
  const shoulder = clamp1(params.shoulderWidth, 0.6, 1.6)
  const bust = girth(params.bust, 1)
  const waist = girth(params.waist, 1)
  const hip = girth(params.hip, 1)
  return [
    { bone: BONE.head, mode: 'uniform', scale: [headK, headK, headK] },
    // 肩：锁骨横向撑开（肩部随之变宽）
    { bone: BONE.clavicleL, mode: 'axis', scale: [shoulder, 1, 1] },
    { bone: BONE.clavicleR, mode: 'axis', scale: [shoulder, 1, 1] },
    // 胸 / 腰 / 臀：躯干高度带上的区域场（绕身体中线缩放 x/z）
    // 胸：横向全强度、纵深半强度（纵深全强度会把肋骨推成「肚子」）
    { bone: BONE.spine2, mode: 'region', scale: [bust, 1, 1 + (bust - 1) * 0.45], height: 0.12 },
    { bone: BONE.spine1, mode: 'region', scale: [waist, 1, waist], height: 0.075 },
    { bone: BONE.hips, mode: 'region', scale: [hip, 1, hip], height: 0.1 },
    // 四肢：垂直骨轴均匀放大
    { bone: BONE.armL, mode: 'radial', scale: [limb, limb, limb] },
    { bone: BONE.foreArmL, mode: 'radial', scale: [limb, limb, limb] },
    { bone: BONE.armR, mode: 'radial', scale: [limb, limb, limb] },
    { bone: BONE.foreArmR, mode: 'radial', scale: [limb, limb, limb] },
    { bone: BONE.upLegL, mode: 'radial', scale: [limb, limb, limb] },
    { bone: BONE.legL, mode: 'radial', scale: [limb, limb, limb] },
    { bone: BONE.upLegR, mode: 'radial', scale: [limb, limb, limb] },
    { bone: BONE.legR, mode: 'radial', scale: [limb, limb, limb] },
  ]
}

/**
 * 肩宽 → 上臂关节的外移量（骨局部位移；手臂整条跟着外移）。
 * 返回「骨名 → 局部位移增量」。
 */
export function positionTunes(params: BodyParams): Record<string, [number, number, number]> {
  const shift = (clamp1(params.shoulderWidth, 0.6, 1.6) - 1) * 0.06
  return {
    [BONE.armL]: [shift, 0, 0],
    [BONE.armR]: [-shift, 0, 0],
  }
}

/**
 * 臂长 / 腿长 → 骨链长度系数。
 *
 * 返回「子骨名 → 局部位移缩放系数」：臂长作用于上臂与前臂两段，腿长作用于
 * 大腿与小腿两段（位移挂在子骨上，缩放它就等于拉长父骨）。
 */
export function lengthTunes(params: BodyParams): Record<string, number> {
  const arm = clamp1(params.armLength, 0.5, 2)
  const leg = clamp1(params.legLength, 0.5, 2)
  return {
    [BONE.foreArmL]: arm,
    [BONE.handL]: arm,
    [BONE.foreArmR]: arm,
    [BONE.handR]: arm,
    [BONE.legL]: leg,
    [BONE.footL]: leg,
    [BONE.legR]: leg,
    [BONE.footR]: leg,
  }
}

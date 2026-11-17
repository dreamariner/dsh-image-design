// 体型参数面 + 参数 → 形变指令。
//
// 人偶是**真实人体网格 + 自建骨架**（MakeHuman base.obj → 骨架 → 蒙皮，见
// scripts/build-mannequin-body.mjs）。体型参数分三类落地方式：
//
//   1) 躯干围度（胸 / 腰 / 臀 / 肩宽）→ **沿身体轴的 1D 剖面**（见 shape.ts）：
//      一串控制点（骨盆 / 腰 / 肋 / 胸 / 肩）各自被一个滑杆控制，点间平滑插值。
//      为什么不用「高度带区域场」：相邻区域带必然重叠，胸围一大就把腰围带跑
//      （上一版实测：胸围 0.6→1.6 腰宽从 0.341 涨到 0.387）；剖面是单值函数，
//      腰的控制点只由腰滑杆决定，互不干扰。
//   2) 四肢粗细 / 头身比 → **骨骼胶囊场 + 蒙皮权重软遮罩**（见 shape.ts）：
//      空间场决定「作用范围」，蒙皮权重决定「归属哪根骨」，两者相乘。
//      为什么不能用「主导骨」硬判定：跨过主导骨边界会出现硬边（实测：臀围调大
//      在髋部甩出一圈裙状法兰）。
//   3) 臂长 / 腿长 → 缩放骨与子骨之间的位移，关节跟着走，长度真的变。
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
  headTop: 'mixamorigHeadTop',
  clavicleL: 'mixamorigLeftShoulder',
  armL: 'mixamorigLeftArm',
  foreArmL: 'mixamorigLeftForeArm',
  handL: 'mixamorigLeftHand',
  handEndL: 'mixamorigLeftHandEnd',
  clavicleR: 'mixamorigRightShoulder',
  armR: 'mixamorigRightArm',
  foreArmR: 'mixamorigRightForeArm',
  handR: 'mixamorigRightHand',
  handEndR: 'mixamorigRightHandEnd',
  upLegL: 'mixamorigLeftUpLeg',
  legL: 'mixamorigLeftLeg',
  footL: 'mixamorigLeftFoot',
  toeL: 'mixamorigLeftToeBase',
  upLegR: 'mixamorigRightUpLeg',
  legR: 'mixamorigRightLeg',
  footR: 'mixamorigRightFoot',
  toeR: 'mixamorigRightToeBase',
} as const

/**
 * 形变组：每一组 = 「空间场 × 蒙皮权重遮罩」× 一个变换。
 * 组名即解剖部位，形状定义在 shape.ts 里（参数只给系数）。
 */
export type ShapeGroup =
  | 'torso'
  | 'bust'
  | 'head'
  | 'armL' | 'armR'
  | 'legL' | 'legR'

export interface ShapeTune {
  /** 形变组。 */
  group: ShapeGroup
  /** 组内缩放系数：torso = [臀, 腰, 胸, 肩]；其余 = [主系数]。 */
  scale: number[]
}

const clamp1 = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 躯干骨集合（躯干剖面只作用于这些骨主导的表面 + 大腿根，避免髋部断层）。 */
export const TORSO_BONES: readonly string[] = [
  BONE.hips, BONE.spine, BONE.spine1, BONE.spine2, BONE.spine3,
]

/**
 * 体型参数 → 形变指令表。
 *
 * · torso（躯干剖面）：[臀, 腰, 胸, 肩] 四个系数，控制剖面的四个控制点。
 * · bust（胸廓双峰）：胸围的局部隆起（底网格是中性体型，纯缩胸腔只是「变厚」）。
 * · head：头身比（各向同性缩放）。
 * · 四肢组：垂直骨轴的径向放大（不挪关节）。
 */
export function shapeTunes(params: BodyParams): ShapeTune[] {
  const headK = 7.5 / clamp1(params.headRatio, 5, 10)
  const limb = clamp1(params.limbThickness, 0.4, 2)
  const shoulder = clamp1(params.shoulderWidth, 0.6, 1.6)
  const bust = clamp1(params.bust, 0.5, 2)
  const waist = clamp1(params.waist, 0.5, 2)
  const hip = clamp1(params.hip, 0.5, 2)
  return [
    { group: 'torso', scale: [hip, waist, bust, shoulder] },
    { group: 'bust', scale: [bust] },
    { group: 'head', scale: [headK] },
    // 四肢：整条链一次径向放大（分骨做会在关节处叠加出「护膝」）
    { group: 'armL', scale: [limb] },
    { group: 'armR', scale: [limb] },
    { group: 'legL', scale: [limb] },
    { group: 'legR', scale: [limb] },
  ]
}

/**
 * 肩宽 → 上臂关节的外移量（骨局部位移；手臂整条跟着外移）。
 *
 * 上臂骨相对锁骨骨的横向偏移就是「半个肩宽」，按系数缩放它 = 肩膀真的变宽
 * （而不是把躯干横向拉宽）。
 */
export function positionTunes(params: BodyParams): Record<string, [number, number, number]> {
  const shoulder = clamp1(params.shoulderWidth, 0.6, 1.6)
  // 上臂骨的横向偏移（绑定姿态实测值 0.1411 m）
  const shift = SHOULDER_OFFSET_X * (shoulder - 1)
  return {
    [BONE.armL]: [shift, 0, 0],
    [BONE.armR]: [-shift, 0, 0],
  }
}

/** 上臂骨相对锁骨骨的横向偏移（m，绑定姿态实测）。 */
export const SHOULDER_OFFSET_X = 0.1411

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

// 素体体型参数与骨骼缩放映射（模型改为 Xbot 蒙皮人偶后的参数面）。
//
// 建模层已从「程序化几何拼装」换成「真实蒙皮人偶 + 骨骼缩放」（2026-11-17 二轮，
// 林老师裁定：原语拼装出不了仿真人样）。本模块只保留：
//   · BodyParams（滑杆参数面，与旧版一致，存档兼容）
//   · 体型参数 → 骨骼缩放/位移 的纯映射（boneTunes，可单测）
// 几何与姿势见 rig.ts / poses.ts / viewer.ts。

/** 素体体型参数（client 滑杆直接给这组值；含义与程序化版本一致）。 */
export interface BodyParams {
  /** 身高（cm），130..210 */
  height: number
  /** 头身比（身高 / 头长），6..9，默认 7.5（值越大头越小） */
  headRatio: number
  /** 肩宽系数 0.7..1.4（相对标准肩宽） */
  shoulderWidth: number
  /** 胸围系数 0.7..1.4 */
  bust: number
  /** 腰围系数 0.55..1.5 */
  waist: number
  /** 臀围系数 0.7..1.5 */
  hip: number
  /** 四肢粗细系数 0.6..1.5 */
  limbThickness: number
  /** 臂长系数 0.85..1.15 */
  armLength: number
  /** 腿长系数 0.85..1.15 */
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

/** 关节名全集（poses.ts 的姿势表必须覆盖；与 rig.ts 的骨骼映射一一对应）。 */
export const JOINT_NAMES = [
  'spine', 'chest', 'neck', 'head',
  'shoulderL', 'elbowL', 'wristL',
  'shoulderR', 'elbowR', 'wristR',
  'hipL', 'kneeL', 'ankleL',
  'hipR', 'kneeR', 'ankleR',
] as const

export type JointName = (typeof JOINT_NAMES)[number]

/** Mixamo 骨骼名（Xbot.glb 的骨架前缀 mixamorig）。 */
export const BONE = {
  hips: 'mixamorigHips',
  spine: 'mixamorigSpine',
  spine1: 'mixamorigSpine1',
  spine2: 'mixamorigSpine2',
  neck: 'mixamorigNeck',
  head: 'mixamorigHead',
  shoulderL: 'mixamorigLeftShoulder',
  shoulderR: 'mixamorigRightShoulder',
  armL: 'mixamorigLeftArm',
  armR: 'mixamorigRightArm',
  foreArmL: 'mixamorigLeftForeArm',
  foreArmR: 'mixamorigRightForeArm',
  handL: 'mixamorigLeftHand',
  handR: 'mixamorigRightHand',
  upLegL: 'mixamorigLeftUpLeg',
  upLegR: 'mixamorigRightUpLeg',
  legL: 'mixamorigLeftLeg',
  legR: 'mixamorigRightLeg',
  footL: 'mixamorigLeftFoot',
  footR: 'mixamorigRightFoot',
} as const

/** 单根骨骼的缩放/位移调整（相对该骨骼 rest 状态的倍率；position 为绝对偏移增量）。 */
export interface BoneTune {
  bone: string
  scale?: [number, number, number]
  /** 追加到 rest 位置的偏移（本地系），如肩宽外移。 */
  position?: [number, number, number]
}

const clamp1 = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * 体型参数 → 骨骼调整表（身高由 viewer 对模型根节点整体缩放，不在本表内）。
 *
 * 语义（x/z 级联有取舍：Spine1/Spine2 的 x 缩放会传导到肩线，故宽度只用 1/4 强度，
 * 深度用全强度；Hips 的 x 同时撑开双腿根距，读作臀宽）：
 *   · bust / waist / hip：Spine2 / Spine1 / Hips 的深（z）宽（x）缩放
 *   · shoulderWidth：锁骨沿 x 外移
 *   · limbThickness：四肢骨 x/z 加粗
 *   · armLength / legLength：四肢骨 y（骨轴）拉长
 *   · headRatio：Head 均匀缩放（头身比越大头越小），以 7.5 为基准 1.0
 */
export function boneTunes(params: BodyParams): BoneTune[] {
  const headK = 7.5 / clamp1(params.headRatio, 5, 10)
  const limb = clamp1(params.limbThickness, 0.4, 2)
  const thick = (len: number): [number, number, number] => [limb, len, limb]
  const shoulderShift = (clamp1(params.shoulderWidth, 0.5, 2) - 1) * 0.04
  const girth = (coeff: number): [number, number] => [0.75 + 0.25 * clamp1(coeff, 0.4, 2), clamp1(coeff, 0.4, 2)]

  const waist = girth(params.waist)
  const bust = girth(params.bust)
  const hip = clamp1(params.hip, 0.5, 2)

  return [
    { bone: BONE.hips, scale: [hip, 1, hip] },
    { bone: BONE.spine1, scale: [waist[0], 1, waist[1]] },
    { bone: BONE.spine2, scale: [bust[0], 1, bust[1]] },
    { bone: BONE.head, scale: [headK, headK, headK] },
    { bone: BONE.shoulderL, position: [shoulderShift, 0, 0] },
    { bone: BONE.shoulderR, position: [0 - shoulderShift, 0, 0] },
    { bone: BONE.armL, scale: thick(params.armLength) },
    { bone: BONE.armR, scale: thick(params.armLength) },
    { bone: BONE.foreArmL, scale: thick(params.armLength) },
    { bone: BONE.foreArmR, scale: thick(params.armLength) },
    { bone: BONE.upLegL, scale: thick(params.legLength) },
    { bone: BONE.upLegR, scale: thick(params.legLength) },
    { bone: BONE.legL, scale: thick(params.legLength) },
    { bone: BONE.legR, scale: thick(params.legLength) },
  ]
}

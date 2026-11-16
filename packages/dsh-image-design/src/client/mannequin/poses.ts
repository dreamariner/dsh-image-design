// 素体姿势库：每姿势 = 全关节欧拉表（弧度）。
//
// 旋转约定（模型面向 +z，相机默认在 +z 看正面）：
//   · 向下的肢体（臂 / 腿）：x 正 = 向后摆，x 负 = 向前抬；z 正 = 向模型左侧（+x）展开
//   · 肘 / 膝：x 负 = 前屈（弯向前），x 正 = 后弯（膝反向自然弯）
//   · spine / chest / neck：x 正 = 低头 / 弓背，y = 转体
//
// 每姿势存**全关节表**（缺省关节 = 零旋转）：拍参考图时整表钉进 ref.json，
// 姿势库后续增删改不影响旧参考图的可复现性。

import { JOINT_NAMES, type JointName } from './body.ts'

export interface JointRotations {
  [joint: string]: { x: number; y: number; z: number }
}

export interface PoseDef {
  id: string
  title: string
  joints: JointRotations
}

const zero = (): JointRotations => {
  const t: JointRotations = {}
  for (const j of JOINT_NAMES) t[j] = { x: 0, y: 0, z: 0 }
  return t
}

/** 补全姿势表：缺省关节补零，多余关节剔除（存档前调用）。 */
export function normalizePose(partial: JointRotations): JointRotations {
  const t = zero()
  for (const j of JOINT_NAMES) {
    const v = partial[j]
    if (v !== undefined) t[j] = { x: v.x, y: v.y, z: v.z }
  }
  return t
}

const mirror = (t: JointRotations): JointRotations => {
  const m = zero()
  for (const j of JOINT_NAMES) {
    const src = partialByName(j, t)
    if (src === undefined) continue
    // 左右镜像：x 反号（前后摆反向），y/z 反号（左右展开反向）
    m[j] = { x: -src.x, y: -src.y, z: -src.z }
  }
  return m
}

function partialByName(j: JointName, t: JointRotations): { x: number; y: number; z: number } | undefined {
  const flipped = j.endsWith('L') ? `${j.slice(0, -1)}R` : j.endsWith('R') ? `${j.slice(0, -1)}L` : undefined
  return t[j] ?? (flipped !== undefined ? t[flipped] : undefined)
}

const POSE_LIST: PoseDef[] = [
  { id: 't-pose', title: 'T-pose（基准）', joints: { ...zero(), shoulderL: { x: 0, y: 0, z: Math.PI / 2 }, shoulderR: { x: 0, y: 0, z: -Math.PI / 2 } } },
  {
    id: 'a-pose', title: 'A-pose（自然下垂基准）',
    joints: { ...zero(), shoulderL: { x: 0, y: 0.08, z: 0.95 }, shoulderR: { x: 0, y: -0.08, z: -0.95 }, elbowL: { x: -0.12, y: 0, z: 0.1 }, elbowR: { x: -0.12, y: 0, z: -0.1 } },
  },
  { id: 'stand', title: '自然站立', joints: mirror({ ...zero(), shoulderL: { x: 0.05, y: 0.06, z: 0.14 }, elbowL: { x: -0.18, y: 0, z: 0.05 } }) },
  {
    id: 'hands-on-hips', title: '叉腰',
    joints: {
      ...zero(),
      shoulderL: { x: 0.1, y: -0.55, z: 0.55 }, elbowL: { x: -1.15, y: 0.25, z: -0.25 }, wristL: { x: -0.3, y: 0, z: 0.2 },
      shoulderR: { x: 0.1, y: 0.55, z: -0.55 }, elbowR: { x: -1.15, y: -0.25, z: 0.25 }, wristR: { x: -0.3, y: 0, z: -0.2 },
      spine: { x: 0.03, y: 0, z: 0 },
    },
  },
  {
    id: 'walk', title: '行走',
    joints: {
      ...zero(),
      hipL: { x: -0.42, y: 0, z: 0.03 }, kneeL: { x: 0.25, y: 0, z: 0 }, ankleL: { x: 0.15, y: 0, z: 0 },
      hipR: { x: 0.38, y: 0, z: 0.03 }, kneeR: { x: 0.5, y: 0, z: 0 }, ankleR: { x: -0.2, y: 0, z: 0 },
      shoulderL: { x: 0.45, y: 0.06, z: 0.1 }, elbowL: { x: -0.35, y: 0, z: 0.05 },
      shoulderR: { x: -0.5, y: -0.06, z: -0.1 }, elbowR: { x: -0.6, y: 0, z: -0.05 },
      spine: { x: 0.04, y: 0, z: 0 },
    },
  },
  {
    id: 'run', title: '奔跑',
    joints: {
      ...zero(),
      hipL: { x: -0.95, y: 0, z: 0.05 }, kneeL: { x: 0.85, y: 0, z: 0 }, ankleL: { x: 0.35, y: 0, z: 0 },
      hipR: { x: 0.75, y: 0, z: 0.05 }, kneeR: { x: 1.35, y: 0, z: 0 }, ankleR: { x: -0.4, y: 0, z: 0 },
      shoulderL: { x: -0.85, y: 0.08, z: 0.18 }, elbowL: { x: -1.5, y: 0, z: 0.1 },
      shoulderR: { x: 0.75, y: -0.08, z: -0.18 }, elbowR: { x: -1.35, y: 0, z: -0.1 },
      spine: { x: 0.14, y: 0, z: 0 }, chest: { x: 0.05, y: 0, z: 0 },
    },
  },
  {
    id: 'sit', title: '坐姿（悬空）',
    joints: {
      ...zero(),
      hipL: { x: -1.45, y: 0.06, z: 0.08 }, kneeL: { x: 1.42, y: 0, z: 0 }, ankleL: { x: -0.25, y: 0, z: 0 },
      hipR: { x: -1.35, y: -0.06, z: 0.08 }, kneeR: { x: 1.32, y: 0, z: 0 }, ankleR: { x: -0.25, y: 0, z: 0 },
      spine: { x: 0.06, y: 0, z: 0 },
      shoulderL: { x: -0.35, y: 0.1, z: 0.1 }, elbowL: { x: -0.5, y: 0, z: 0.05 },
      shoulderR: { x: -0.35, y: -0.1, z: -0.1 }, elbowR: { x: -0.5, y: 0, z: -0.05 },
    },
  },
  {
    id: 'kneel', title: '跪坐',
    joints: {
      ...zero(),
      hipL: { x: 0.15, y: 0.05, z: 0.06 }, kneeL: { x: 2.3, y: 0, z: 0 }, ankleL: { x: 0.7, y: 0, z: 0 },
      hipR: { x: 0.15, y: -0.05, z: 0.06 }, kneeR: { x: 2.3, y: 0, z: 0 }, ankleR: { x: 0.7, y: 0, z: 0 },
      spine: { x: 0.02, y: 0, z: 0 },
    },
  },
]

/** 姿势库（id 稳定可作存档键；顺序即 UI 呈现顺序）。 */
export const POSES: readonly PoseDef[] = POSE_LIST

export function poseById(id: string): PoseDef | undefined {
  return POSES.find((p) => p.id === id)
}

/** 取姿势的规范化全关节表（姿势存在取库值；否则按 unknown 处理零表）。 */
export function poseJoints(id: string): JointRotations {
  const pose = poseById(id)
  return pose !== undefined ? normalizePose(pose.joints) : zero()
}

// 素体姿势库：每姿势 = 全关节欧拉表（弧度）。
//
// 骨架是自建的（局部旋转全是单位阵 → 骨的朝向就是世界朝向），所以姿势欧拉按
// **世界轴**书写，语义与 rig.ts 顶部的约定一致：
//   · x：绕世界 X 轴。躯干 x > 0 = 前倾；四肢 x > 0 = 向后摆、x < 0 = 向前抬；
//     肘 / 膝 x > 0 = 后屈（肘向后、膝向后，符合人体关节方向）。
//   · y：绕世界 Y 轴 = 水平扭转。
//   · z：绕世界 Z 轴 = 侧向（角色左 = +x，左侧 +z 为向外抬起）。
//
// 绑定姿态就是 A-pose（手臂自然下垂约 40°），所以 a-pose = 全零表。
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

/** 取姿势的规范化全关节表（姿势存在取库值；否则按 unknown 处理零表）。 */
export function poseJoints(id: string): JointRotations {
  const pose = POSES.find((p) => p.id === id)
  return pose !== undefined ? normalizePose(pose.joints) : zero()
}

const POSE_LIST: PoseDef[] = [
  {
    id: 'a-pose', title: 'A-pose（自然下垂基准）',
    joints: { ...zero() },
  },
  {
    id: 't-pose', title: 'T-pose（双臂水平）',
    joints: {
      ...zero(),
      shoulderL: { x: 0, y: 0, z: 0.88 }, shoulderR: { x: 0, y: 0, z: -0.88 },
      elbowL: { x: 0, y: 0, z: -0.16 }, elbowR: { x: 0, y: 0, z: 0.16 },
    },
  },
  {
    id: 'stand', title: '自然站立',
    joints: {
      ...zero(),
      shoulderL: { x: 0.02, y: 0.04, z: -0.1 }, shoulderR: { x: 0.02, y: -0.04, z: 0.1 },
      elbowL: { x: -0.12, y: 0, z: 0.06 }, elbowR: { x: -0.12, y: 0, z: -0.06 },
      hipL: { x: 0.02, y: 0.02, z: 0.02 }, hipR: { x: -0.02, y: -0.02, z: -0.02 },
    },
  },
  {
    id: 'hands-on-hips', title: '叉腰',
    joints: {
      ...zero(),
      shoulderL: { x: 0.12, y: -0.1, z: -0.18 }, shoulderR: { x: 0.12, y: 0.1, z: 0.18 },
      elbowL: { x: 1.0, y: 0, z: -1.5 }, elbowR: { x: 1.0, y: 0, z: 1.5 },
      wristL: { x: 0, y: 0, z: -0.3 }, wristR: { x: 0, y: 0, z: 0.3 },
      spine: { x: -0.02, y: 0, z: 0 },
    },
  },
  {
    id: 'walk', title: '行走',
    joints: {
      ...zero(),
      hipL: { x: -0.42, y: 0.04, z: 0.03 }, kneeL: { x: 0.3, y: 0, z: 0 }, ankleL: { x: 0.12, y: 0, z: 0 },
      hipR: { x: 0.38, y: -0.04, z: 0.03 }, kneeR: { x: 0.55, y: 0, z: 0 }, ankleR: { x: -0.18, y: 0, z: 0 },
      shoulderL: { x: 0.35, y: 0.05, z: -0.05 }, elbowL: { x: 0.15, y: 0, z: 0.05 },
      shoulderR: { x: -0.4, y: -0.05, z: 0.05 }, elbowR: { x: -0.3, y: 0, z: -0.05 },
      spine: { x: 0.03, y: 0.04, z: 0 },
    },
  },
  {
    id: 'run', title: '奔跑',
    joints: {
      ...zero(),
      hipL: { x: -0.95, y: 0.06, z: 0.05 }, kneeL: { x: 0.9, y: 0, z: 0 }, ankleL: { x: 0.3, y: 0, z: 0 },
      hipR: { x: 0.72, y: -0.06, z: 0.05 }, kneeR: { x: 1.3, y: 0, z: 0 }, ankleR: { x: -0.35, y: 0, z: 0 },
      shoulderL: { x: -0.45, y: 0.08, z: -0.05 }, elbowL: { x: -0.35, y: 0, z: 0.15 },
      shoulderR: { x: 0.45, y: -0.08, z: 0.05 }, elbowR: { x: 1.6, y: 0, z: -0.15 },
      spine: { x: 0.12, y: 0, z: 0 }, chest: { x: 0.04, y: 0, z: 0 },
    },
  },
  {
    id: 'sit', title: '坐姿（悬空）',
    joints: {
      ...zero(),
      hipL: { x: -1.45, y: 0.06, z: 0.08 }, kneeL: { x: 1.45, y: 0, z: 0 }, ankleL: { x: 0, y: 0, z: 0 },
      hipR: { x: -1.35, y: -0.06, z: 0.08 }, kneeR: { x: 1.35, y: 0, z: 0 }, ankleR: { x: 0, y: 0, z: 0 },
      spine: { x: -0.06, y: 0, z: 0 },
      shoulderL: { x: 0.0, y: 0.1, z: -0.05 }, elbowL: { x: 0.35, y: 0, z: -1.4 },
      shoulderR: { x: 0.0, y: -0.1, z: 0.05 }, elbowR: { x: 0.35, y: 0, z: 1.4 },
    },
  },
  {
    id: 'kneel', title: '跪坐',
    joints: {
      ...zero(),
      hipL: { x: 1.45, y: 0.05, z: 0.06 }, kneeL: { x: -1.45, y: 0, z: 0 }, ankleL: { x: 1.9, y: 0, z: 0 },
      hipR: { x: 1.45, y: -0.05, z: 0.06 }, kneeR: { x: -1.45, y: 0, z: 0 }, ankleR: { x: 1.9, y: 0, z: 0 },
      spine: { x: -0.04, y: 0, z: 0 },
    },
  },
]

/** 姿势库（id 稳定可作存档键；顺序即 UI 呈现顺序）。 */
export const POSES: readonly PoseDef[] = POSE_LIST

export function poseById(id: string): PoseDef | undefined {
  return POSES.find((p) => p.id === id)
}

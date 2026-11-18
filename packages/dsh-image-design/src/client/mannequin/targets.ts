// 姿势目标库：8 个预设的**高层意图**（不是关节角）。
//
// 为什么预设不用关节欧拉表：欧拉是「结果」不是「意图」。
// 「手搭在大腿上」该写成「腕落在腿面哪里 + 手掌朝哪 + 离面几毫米」，
// 由求解器（物理 + 碰撞 + IK）解成关节角 —— 换个腿长、换个体型、换个坐姿，
// 同一句意图依然成立。写死欧拉做不到：体型一变角度就不对（穿模）。
//
// 目标分两种：
//  · 固定位置 `pos`：模型空间坐标，用**身体尺寸**算出来的相对位置（体型的函数）；
//  · 语义锚点 `anchor`：贴在某体段上（手搭大腿 / 手扶髋），随体段一起动。
//
// 尺寸口径：米（模型空间），x=0 居中（角色左 = +x），y 向上，z 向前（面朝 +z）。
// 身体尺寸从骨架量（`computeBodyMetrics`），所以同一套规则适配所有体型。

import * as THREE from 'three'
import { BONE } from './body.ts'
import type { PoseTargets, Vec3 } from './solver.ts'

/** 脚底比脚趾骨低多少（m）：脚趾骨埋在脚掌里，地面比它更低。 */
const SOLE_DROP = 0.035

/** 跪坐时大腿与水平面的夹角（度）：大腿前下、小腿水平。 */
const KNEEL_THIGH_DEG = 33

export interface BodyMetrics {
  /** 地面（脚底）在模型空间的高度。 */
  groundY: number
  /** 髋（绑定姿态）在模型空间的高度。 */
  hipsY: number
  /** 站立时髋离地高度。 */
  hipHeight: number
  /** 站立时肩离地高度。 */
  shoulderHeight: number
  /** 肩关节离体侧的横向距离。 */
  shoulderHalf: number
  /** 髋关节离体侧的横向距离。 */
  hipHalf: number
  /** 肩→腕（臂长，两段骨长之和）。 */
  armLen: number
  /** 大腿长（髋→膝）。 */
  thighLen: number
  /** 小腿长（膝→踝）。 */
  shinLen: number
  /** 踝离脚底高度（站姿，脚掌平放）。 */
  ankleHeight: number
  /** 躯干长（髋→肩）。 */
  torsoLen: number
  /** 绑定姿态：手腕相对肩的偏移（复现 a-pose 用）。 */
  bindWristL: Vec3
  bindWristR: Vec3
  /** 绑定姿态：踝相对髋关节的偏移。 */
  bindAnkleL: Vec3
  bindAnkleR: Vec3
}

const v3 = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z })

/**
 * 从骨架量身体尺寸（绑定姿态，姿势无关 —— 骨长是常量）。
 *
 * @param boneAt 取骨的世界位置（模型空间）
 */
export function computeBodyMetrics(boneAt: (name: string) => THREE.Vector3): BodyMetrics {
  const hips = boneAt(BONE.hips)
  const shL = boneAt(BONE.armL)
  const shR = boneAt(BONE.armR)
  const elL = boneAt(BONE.foreArmL)
  const elR = boneAt(BONE.foreArmR)
  const wrL = boneAt(BONE.handL)
  const wrR = boneAt(BONE.handR)
  const hipL = boneAt(BONE.upLegL)
  const hipR = boneAt(BONE.upLegR)
  const kneeL = boneAt(BONE.legL)
  const kneeR = boneAt(BONE.legR)
  const ankL = boneAt(BONE.footL)
  const ankR = boneAt(BONE.footR)
  const toeL = boneAt(BONE.toeL)
  const toeR = boneAt(BONE.toeR)
  const groundY = Math.min(toeL.y, toeR.y) - SOLE_DROP
  const dist = (a: THREE.Vector3, b: THREE.Vector3) => a.distanceTo(b)
  return {
    groundY,
    hipsY: hips.y,
    hipHeight: hips.y - groundY,
    shoulderHeight: shL.y - groundY,
    shoulderHalf: Math.abs(shL.x),
    hipHalf: Math.abs(hipL.x),
    armLen: dist(shL, elL) + dist(elL, wrL),
    thighLen: dist(hipL, kneeL),
    shinLen: dist(kneeL, ankL),
    ankleHeight: ankL.y - groundY,
    torsoLen: dist(hips, shL),
    bindWristL: v3(wrL.clone().sub(shL)),
    bindWristR: v3(wrR.clone().sub(shR)),
    bindAnkleL: v3(ankL.clone().sub(hipL)),
    bindAnkleR: v3(ankR.clone().sub(hipR)),
  }
}

/** 站姿的双脚（踝在脚底上方「踝高」处，左右分开「髋半宽」）。 */
function standFeet(m: BodyMetrics): PoseTargets['effectors'] {
  return {
    footL: { pos: { x: m.hipHalf, y: m.groundY + m.ankleHeight, z: 0 } },
    footR: { pos: { x: -m.hipHalf, y: m.groundY + m.ankleHeight, z: 0 } },
  }
}

/** 手腕位置 + 手掌朝向（自然下垂：指尖朝下、掌心朝体侧）。 */
function hangingArm(m: BodyMetrics, side: 'L' | 'R', zOff = 0, drop = 0.94): Vec3 {
  const s = side === 'L' ? 1 : -1
  // 垂手要**清空大腿**：手臂垂直向下时指尖落在 x=肩半宽处，而大腿外缘在
  // y≈指尖高度处比肩半宽更靠外（HM08 网格实测指尖会插进大腿/骨盆 25~30mm，
  // 2026-11-18）→ 真实人站立时手臂略外张。外张量按「手半厚」给（指尖过腿面
  // 一个手厚），随体型无关的比例量 ✓。
  const OUTWARD = 0.032
  return {
    x: s * (m.shoulderHalf + OUTWARD),
    y: m.groundY + m.shoulderHeight - m.armLen * drop,
    z: zOff,
  }
}

/** 垂手/摆臂的掌心朝向：朝内偏后 ~30°。
 *
 * 为什么不朝正内侧（2026-11-19 实测）：HM08 手指张开且微卷（朝掌心侧），
 * 掌心朝正内时指腹正好戳进大腿（stand 穿插 30.7mm）—— 真人垂手时掌心天然
 * 朝内偏后（虎口朝前），指卷离腿面 ✓。 */
function hangingPalm(side: 'L' | 'R'): Vec3 {
  const s = side === 'L' ? 1 : -1
  return { x: s * 0.87, y: 0, z: -0.5 }
}

/** a-pose（绑定姿态）：肩宽下垂 43°、前倾 23°，其余零位。 */
function aPose(m: BodyMetrics): PoseTargets {
  const shY = m.groundY + m.shoulderHeight
  return {
    root: { x: 0, y: m.hipsY, z: 0 },
    effectors: {
      ...standFeet(m),
      handL: { pos: { x: m.shoulderHalf + m.bindWristL.x, y: shY + m.bindWristL.y, z: m.bindWristL.z } },
      handR: { pos: { x: -m.shoulderHalf + m.bindWristR.x, y: shY + m.bindWristR.y, z: m.bindWristR.z } },
    },
  }
}

/** t-pose：双臂水平，指尖朝外、掌心朝前。 */
function tPose(m: BodyMetrics): PoseTargets {
  const shY = m.groundY + m.shoulderHeight
  const x = m.shoulderHalf + m.armLen
  return {
    root: { x: 0, y: m.hipsY, z: 0 },
    effectors: {
      ...standFeet(m),
      handL: { pos: { x, y: shY, z: 0 }, forward: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      handR: { pos: { x: -x, y: shY, z: 0 }, forward: { x: -1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
    },
  }
}

/** 自然站立：手臂垂体侧、微微屈肘（目标离肩 0.94 倍臂长 → 肘弯自然）。 */
function stand(m: BodyMetrics): PoseTargets {
  return {
    root: { x: 0, y: m.hipsY, z: 0 },
    effectors: {
      ...standFeet(m),
      handL: {
        pos: hangingArm(m, 'L'),
        forward: { x: 0, y: -1, z: 0 },
        normal: hangingPalm('L'),
      },
      handR: {
        pos: hangingArm(m, 'R'),
        forward: { x: 0, y: -1, z: 0 },
        normal: hangingPalm('R'),
      },
    },
  }
}

/** 叉腰：手掌贴在髂嵴外侧（躯干锚点），肘由 IK 的 pole 甩到后外侧。 */
function handsOnHips(m: BodyMetrics): PoseTargets {
  return {
    root: { x: 0, y: m.hipsY, z: 0 },
    effectors: {
      ...standFeet(m),
      handL: { anchor: { part: 'torso', t: 0.06, radialDeg: 90, gapM: 0.02 }, forward: { x: 0, y: -1, z: 0 } },
      handR: { anchor: { part: 'torso', t: 0.06, radialDeg: 90, gapM: 0.02 }, forward: { x: 0, y: -1, z: 0 } },
    },
  }
}

/** 行走：左脚在前跟着地、右脚在后脚尖点地，双臂反相摆动。 */
function walk(m: BodyMetrics): PoseTargets {
  const legLen = m.thighLen + m.shinLen
  return {
    root: { x: 0, y: m.hipsY, z: 0 },
    effectors: {
      footL: { pos: { x: m.hipHalf, y: m.groundY + m.ankleHeight + 0.03, z: legLen * 0.3 }, pitchDeg: -9 },
      footR: { pos: { x: -m.hipHalf, y: m.groundY + m.ankleHeight + 0.13, z: -legLen * 0.26 }, pitchDeg: 29 },
      handL: {
        pos: hangingArm(m, 'L', -m.armLen * 0.06),
        forward: { x: 0, y: -1, z: 0 },
        normal: hangingPalm('L'),
      },
      handR: {
        pos: hangingArm(m, 'R', m.armLen * 0.06),
        forward: { x: 0, y: -1, z: 0 },
        normal: hangingPalm('R'),
      },
    },
  }
}

/** 奔跑（触地）：左脚支撑、右腿后摆折叠，双臂大幅摆动。 */
function run(m: BodyMetrics): PoseTargets {
  const legLen = m.thighLen + m.shinLen
  return {
    root: { x: 0, y: m.hipsY - 0.02, z: 0 },
    effectors: {
      footL: { pos: { x: m.hipHalf, y: m.groundY + m.ankleHeight, z: legLen * 0.22 }, pitchDeg: 0 },
      footR: { pos: { x: -m.hipHalf, y: m.groundY + m.ankleHeight + legLen * 0.42, z: -legLen * 0.2 }, pitchDeg: 40 },
      handL: {
        pos: hangingArm(m, 'L', -m.armLen * 0.12, 0.9),
        forward: { x: 0, y: -1, z: 0 },
        normal: hangingPalm('L'),
      },
      handR: {
        pos: hangingArm(m, 'R', m.armLen * 0.08, 0.77),
        forward: { x: 0, y: -1, z: 0 },
        normal: hangingPalm('R'),
      },
    },
  }
}

/**
 * 坐姿：大腿水平、小腿垂直，双脚平放地面；手搭大腿（语义锚点）。
 *
 * 规则全部用身体尺寸表达：髋高 = 小腿长 + 踝高；脚在髋前「大腿长」处。
 * 换个体型这套规则自动缩放 ✓。
 */
function sit(m: BodyMetrics): PoseTargets {
  const hipsY = m.groundY + m.shinLen + m.ankleHeight
  return {
    root: { x: 0, y: hipsY, z: 0 },
    effectors: {
      footL: { pos: { x: m.hipHalf, y: m.groundY + m.ankleHeight, z: m.thighLen } },
      footR: { pos: { x: -m.hipHalf, y: m.groundY + m.ankleHeight, z: m.thighLen } },
      // 掌向显式给（2026-11-19）：「搭覆在大腿上」—— 掌心朝下前（指卷顺腿面
      // 坡度滑向膝，不戳腿面）；掌朝正下会让卷指戳进腿 → 投影把整手抬起悬空
      //（实测 sit 手-腿间隙 37mm 悬空）✓
      handL: {
        anchor: { part: 'leftThigh', t: 0.48, radialDeg: 5, gapM: 0.002 },
        forward: { x: 0, y: -0.15, z: 0.99 },
        normal: { x: 0, y: -0.99, z: -0.15 },
      },
      handR: {
        anchor: { part: 'rightThigh', t: 0.48, radialDeg: 5, gapM: 0.002 },
        forward: { x: 0, y: -0.15, z: 0.99 },
        normal: { x: 0, y: -0.99, z: -0.15 },
      },
    },
    // 上身前倾 17°（手要够到大腿面，肩到大腿的距离超过臂长）
    head: { x: 0, y: hipsY + m.torsoLen * 0.95, z: m.torsoLen * 0.29 },
  }
}

/**
 * 跪坐（正坐）：小腿横在身后、脚背贴地，大腿前下；手搭大腿（语义锚点）。
 */
function kneel(m: BodyMetrics): PoseTargets {
  const rad = (KNEEL_THIGH_DEG * Math.PI) / 180
  const drop = m.thighLen * Math.sin(rad)
  const fwd = m.thighLen * Math.cos(rad)
  const hipsY = m.groundY + m.ankleHeight + drop
  return {
    root: { x: 0, y: hipsY, z: 0 },
    effectors: {
      footL: { pos: { x: m.hipHalf, y: m.groundY + 0.131, z: fwd - m.shinLen }, pitchDeg: 52 },
      footR: { pos: { x: -m.hipHalf, y: m.groundY + 0.131, z: fwd - m.shinLen }, pitchDeg: 52 },
      // 掌向显式给：掌心贴腿面（法向 = 大腿面朝上前，掌朝下前贴腿）；指尖同上交给前臂+旋出
      handL: {
        anchor: { part: 'leftThigh', t: 0.42, radialDeg: 8, gapM: 0.002 },
        forward: { x: 0, y: -0.54, z: 0.84 },
        normal: { x: 0, y: -0.84, z: -0.54 },
      },
      handR: {
        anchor: { part: 'rightThigh', t: 0.42, radialDeg: 8, gapM: 0.002 },
        forward: { x: 0, y: -0.54, z: 0.84 },
        normal: { x: 0, y: -0.84, z: -0.54 },
      },
    },
    head: { x: 0, y: hipsY + m.torsoLen * 0.95, z: m.torsoLen * 0.29 },
  }
}

/** 预设 id → 目标构造函数。 */
const BUILDERS: Record<string, (m: BodyMetrics) => PoseTargets> = {
  'a-pose': aPose,
  't-pose': tPose,
  stand,
  'hands-on-hips': handsOnHips,
  walk,
  run,
  sit,
  kneel,
}

/** 预设 id 顺序（与姿势库一致）。 */
export const TARGET_PRESET_IDS = Object.keys(BUILDERS)

/** 取某个预设的意图层目标（null = 没有这个预设）。 */
export function poseTargets(id: string, m: BodyMetrics): PoseTargets | null {
  const build = BUILDERS[id]
  return build === undefined ? null : build(m)
}

/** 语义动作（面板快捷按钮）：只改一条语义，其余意图原样保留。 */
export type SemanticActionId = 'hands-on-thigh' | 'feet-on-ground' | 'arms-at-side'

/** 语义动作的中文名（面板按钮）。 */
export const SEMANTIC_ACTION_LABELS: Record<SemanticActionId, string> = {
  'hands-on-thigh': '手贴大腿',
  'feet-on-ground': '双脚踩地',
  'arms-at-side': '手垂体侧',
}

/**
 * 在**当前意图**上打一个语义补丁（不换整套预设）。
 *
 * 为什么要打补丁：作者已经调好的其他意图（骨盆高度、头朝向、另一只手的位置）
 * 不该被一键动作抹掉 ✓ —— 一键动作只负责「这一条语义」，其余由作者决定。
 */
export function applySemanticAction(
  action: SemanticActionId,
  current: PoseTargets,
  m: BodyMetrics,
): PoseTargets {
  const effectors: PoseTargets['effectors'] = { ...current.effectors }
  switch (action) {
    case 'hands-on-thigh':
      // 语义锚点：贴在左/右大腿中段外侧（求解时按当前体段几何解析 → 换腿长也对）
      effectors.handL = { anchor: { part: 'leftThigh', t: 0.48, radialDeg: 5, gapM: 0.002 } }
      effectors.handR = { anchor: { part: 'rightThigh', t: 0.48, radialDeg: 5, gapM: 0.002 } }
      break
    case 'feet-on-ground': {
      // 脚落到地面高度（踝高），前后位置保留作者摆的站位
      const fl = current.effectors.footL?.pos
      const fr = current.effectors.footR?.pos
      effectors.footL = { pos: { x: fl?.x ?? m.hipHalf, y: m.groundY + m.ankleHeight, z: fl?.z ?? 0 } }
      effectors.footR = { pos: { x: fr?.x ?? -m.hipHalf, y: m.groundY + m.ankleHeight, z: fr?.z ?? 0 } }
      break
    }
    case 'arms-at-side':
      effectors.handL = {
        pos: hangingArm(m, 'L'),
        forward: { x: 0, y: -1, z: 0 },
        normal: hangingPalm('L'),
      }
      effectors.handR = {
        pos: hangingArm(m, 'R'),
        forward: { x: 0, y: -1, z: 0 },
        normal: hangingPalm('R'),
      }
      break
  }
  return {
    root: { ...current.root },
    effectors,
    ...(current.head === undefined ? {} : { head: { ...current.head } }),
  }
}

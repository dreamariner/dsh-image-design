// 姿势求解器：物理（重力 / 接触 / 摩擦 / 弹簧）+ 约束（关节限位 / 地面）+ IK。
//
// 三层架构（issue 005）：
//   ① 意图层 `PoseTargets` —— 作者只声明高层目标（末端落点 / 骨盆位置），不是关节角；
//   ② 物理 + 约束层 —— 定步长 PBD 子步：重力 + 弹簧回目标 + 阻尼 → 预测 → IK → 接触
//      投影（身体接触 / 地面）+ 摩擦 → 速度更新；
//   ③ 表现层 —— 输出仍是 `JointRotations`（16 关节欧拉表），与既有姿势表同构，
//      所以 viewer / ref.json / 现有门禁测试都不用改。
//
// 为什么物理作用在**末端目标层**而不是骨骼层：骨骼是运动学链（IK 负责链的形状，
// 肘的方向、腕的旋向都自然）；末端是「有质量的粒子」，受重力压向支撑面、受接触推离、
// 受摩擦不滑动，连回作者意图靠弹簧。于是「手搭在大腿上」是**压住**的而不是
// 「堆上去」的，拖动快还有惯性滞后。
//
// 确定性：定步长（DT）+ 固定子步上限 + 落定早退 → 同一目标两次求解结果一致，
// 参考图归档仍可逐字节复现。

import * as THREE from 'three'
import { JOINT_NAMES } from './body.ts'
import { JOINT_BONES, type RigBinding } from './rig.ts'
import type { JointRotations } from './poses.ts'
import {
  solveTwoBone, solveHandOrientation, makeHandFrame, localQuatToPoseEuler,
  type HandFrame, type TwoBoneSolution,
} from './ik.ts'
import type { EllipsoidSegment } from './contact.ts'

export type EndEffectorId = 'handL' | 'handR' | 'footL' | 'footR'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface EndEffectorTarget {
  /** 固定位置（模型空间，米）：腕（手）/ 踝（脚）的目标点。与 anchor 二选一。 */
  pos?: Vec3
  /**
   * 语义锚点：贴在某体段上（求解时按**当前几何**解析）。
   *
   * 锚点描述的是**接触点**（手掌的触点 / 脚掌的触点），不是腕或踝的位置 ——
   * 求解器会按身体尺寸（手长、掌厚、踝高）换算成腕/踝目标。
   * 这样「手搭在大腿上」与体型、腿长无关；写死坐标换个腿长就错位了。
   */
  anchor?: {
    /** 体段 id：leftThigh / rightThigh / leftShin / rightShin / torso。 */
    part: string
    /** 轴向参数 [0,1]（0 = 近根端，1 = 近远端）。 */
    t: number
    /** 径向偏角（度）：0 = 体段正上方，正 = 朝身体外侧。 */
    radialDeg: number
    /** 离面间隙（米，正 = 在表面外侧）。 */
    gapM: number
  }
  /** 指向前方（手：指尖方向；脚：脚尖方向）。缺省：锚点给出体段轴方向。 */
  forward?: Vec3
  /** 掌心 / 脚掌法向（缺省：锚点给出「贴向表面」的方向）。 */
  normal?: Vec3
  /** 踝的跖屈角（度，脚尖朝后用；跪坐 ≈52）。 */
  pitchDeg?: number
  /**
   * 肘的朝向提示（只给「倾向」，最终由物理在候选里挑一个不撞身体的）：
   *  · 'back'（默认）：肘朝后
   *  · 'out'：肘朝身体外侧（手搭大腿时用 —— 肘不外撇，前臂会插进肋骨）
   *  · 'up'：肘朝上（手举高时用）
   */
  poleHint?: 'back' | 'out' | 'up'
}

/** 目标解析结果：末端（腕/踝）的目标点 + 期望朝向。 */
interface ResolvedGoal {
  pos: THREE.Vector3
  forward: THREE.Vector3 | null
  normal: THREE.Vector3 | null
}

/**
 * 身体尺寸（从绑定姿态量出来，姿势无关）：
 *  · 腕→掌心沿手轴距离、手轴到掌心的垂距（掌厚）：手目标点要按它换算；
 *  · 踝离脚底的高度：脚目标点要按它换算。
 */
interface BodyMetrics {
  hand: { along: number; offset: number }
  foot: { height: number }
}

/** 意图层：一次姿势调整的全部高层输入（可序列化，进 ref.json）。 */
export interface PoseTargets {
  /** 根（骨盆）在模型空间的位置：x=0 居中，y=离地高度，z=前后。 */
  root: Vec3
  /** 各末端目标（模型空间，米）。缺省者不参与求解。 */
  effectors: Partial<Record<EndEffectorId, EndEffectorTarget>>
  /** 头部目标（模型空间，米）——驱动脊柱朝向。 */
  head?: Vec3
}

/** 求解器需要的宿主能力（viewer / 测试夹具各自实现一份）。 */
export interface SolverHost {
  /** 骨架绑定（骨、restLocal、zSign）。 */
  binding: RigBinding
  /**
   * 应用姿势（模型空间）并返回**指定顶点**的蒙皮后位置（xyz 连续）。
   *
   * 只蒙皮需要的顶点（碰撞探针，几十个）——全身蒙皮 1.9 万顶点 × 240 子步要好几秒，
   * 拖拽根本跟不动。
   */
  applyPose(joints: JointRotations, root: Vec3, verts: number[]): Float32Array
  /** 骨的世界位置（模型空间）。 */
  boneAt(name: string): THREE.Vector3
  /** 骨的父骨世界朝向（局部欧拉要用）。 */
  boneParentQuat(name: string): THREE.Quaternion
  /** 末端碰撞探针的顶点索引（少量：掌心 + 指尖 / 脚掌）。 */
  effectorProbes(id: EndEffectorId): number[]
  /**
   * 末端的**整块体积顶点**（手 = 全部手指/手掌顶点）。
   *
   * 与 effectorProbes 的区别：探针是「掌心 + 指尖」几个点，用于探接触；
   * 体积顶点用于算手的**外形包络**（凸包角点）—— 只用探针会漏掉掌缘角点
   * （walk 实测右手指尖入腿 53mm，探针只判 5mm）✓。
   */
  effectorVolumeVerts(id: EndEffectorId): number[]
  /** 体段的解析代理（按当前姿势重建：轴心随骨走，半轴半径固定）。 */
  segments(): EllipsoidSegment[]
  /**
   * 语义锚点用的**整段**代理（leftThigh / rightThigh / leftShin / rightShin / torso）。
   *
   * 与 segments() 的区别：碰撞代理把大腿拆成上下两半（半径按分位数量），
   * 锚点要的是「整条大腿」——「手搭在大腿中段」说的是整条腿的位置。
   */
  anchorSegment(name: string): EllipsoidSegment | undefined
  /** 手部静息系（掌心法向 + 手轴），用于把掌心摆到目标朝向上。 */
  restHandFrame(side: 'Left' | 'Right'): HandFrame
  /**
   * 手部尺寸：腕→掌心沿手轴的距离（along）、掌面到手轴的距离（offset ≈ 掌厚）。
   *
   * 语义锚点描述的是**接触点**（掌面触点），要换算成腕的位置就得知道这两个量 ✓。
   * 由宿主按网格量（手掌区域取沿手轴 25%~60% 的顶点）✓ —— 不能拿「离腕 45% 最远的
   * 顶点」当掌心：这个模型的手指是张开的，最远顶点落在指尖，掌心会被算到手掌外 ✗。
   */
  handMetrics(side: 'Left' | 'Right'): { along: number; offset: number }
}

export interface SolverConfig {
  /** 重力加速度（模型空间，m/s²，y 向下为负）。 */
  gravity: number
  /** 固定子步长（秒）。 */
  dt: number
  /** 单次 step() 的子步数上限。 */
  substepsPerStep: number
  /** settle() 的子步上限。 */
  maxSubsteps: number
  /** 落定判据：末速阈值（m/s）。1cm/s 肉眼已静止；再紧会被接触修正的微抖卡住。 */
  settleVelocity: number
  /** 落定判据：单子步关节变化上限（弧度）。0.01°/子步 ≈ 1.2°/s，肉眼静止。 */
  settleJointDelta: number
  /** 手部质量（kg）。 */
  handMass: number
  /** 脚部质量（kg）。 */
  footMass: number
  /** 手部弹簧刚度（N/m）。 */
  handStiffness: number
  /** 脚部弹簧刚度（N/m）。 */
  footStiffness: number
  /** 阻尼比（1 = 临界阻尼，不振荡）。 */
  dampingRatio: number
  /** 摩擦系数（切向速度每子步衰减比例）。 */
  friction: number
  /** 地面高度（模型空间，米）。 */
  groundY: number
}

export const DEFAULT_SOLVER_CONFIG: SolverConfig = {
  gravity: 9.81,
  dt: 1 / 120,
  substepsPerStep: 8,
  maxSubsteps: 240,
  settleVelocity: 0.01,
  settleJointDelta: (0.01 * Math.PI) / 180,
  handMass: 0.5,
  footMass: 0.8,
  handStiffness: 600,
  footStiffness: 900,
  dampingRatio: 1,
  friction: 0.25,
  groundY: 0,
}

/**
 * 肘的候选朝向（相对身体左侧为正的横向分量在下面按侧别取符号）。
 *
 * 为什么要有候选：肘在两骨 IK 里是**欠定**的自由度（手的位置定了，肘可以绕手臂轴转）。
 * 写死一个 pole 就会在某些姿势里把前臂插进肋骨（实测坐姿 12.6mm）——
 * 所以让物理来挑：候选逐个解 IK，看肘与前臂中点离躯干/腿多远，取最空的 ✓。
 */
/** 换肘朝向要领先多少（米）才换：防抖用。 */
const POLE_SWITCH_MARGIN = 0.03
/** 锚定手的「前臂同向」打分差多少才换肘（无量纲，防抖用）。 */
const POLE_ALIGN_MARGIN = 0.02

/**
 * 体段表面在某截面角处的**切向**（沿轴向）：手搭在上面时顺着它走。
 *
 * 取法：同一截面角上取 t±ε 两个表面点，差向即切向 ✓。肢体是锥形（大腿近膝更细），
 * 顶面沿长度下沉，切向自带坡度 → 手掌能平贴在面上、掌根不抬、指尖不扎 ✓。
 * 退化（代理没有表面点）时回退到段轴 ✓。
 */
function surfaceTangent(seg: EllipsoidSegment, t: number, dir: THREE.Vector3): THREE.Vector3 {
  const axis = seg.b.clone().sub(seg.a)
  const fallback = axis.lengthSq() > 1e-12 ? axis.normalize() : new THREE.Vector3(0, 0, 1)
  const eps = 0.02
  const p0 = seg.surfaceAlong(Math.max(0, t - eps), dir)
  const p1 = seg.surfaceAlong(Math.min(1, t + eps), dir)
  if (p0 === null || p1 === null) return fallback
  const tan = p1.point.clone().sub(p0.point)
  if (tan.lengthSq() < 1e-10) return fallback
  tan.normalize()
  // 方向朝段的远端（指尖朝膝 / 朝下）✓
  if (tan.dot(fallback) < 0) tan.negate()
  return tan
}

// pole 候选 ≈ **绑定姿态的上臂方向**（外下，z 分量小）：肘该在肩下是解剖事实
//（2026-11-19 实测 run 双肘 dy≈0、上臂水平外展 90°），但纯世界向下的 pole 会把
// 紧张臂（a-pose，链松弛仅 3cm）的肘也拉向后 → 前臂为够到原手位前折 44°，
// 手顺前臂 → 整条臂看着像腕折（用户多轮截图的真身）。近似绑定上臂方向时：
// 紧张臂肘 ≈ 绑定位 ✓，松弛臂（run）肘垂到肩下 ✓，'up' 保留（叉腰类）。
const POLE_CANDIDATES: readonly { key: string; dir: [number, number, number] }[] = [
  { key: 'back', dir: [0.5, -0.85, -0.15] },
  { key: 'out', dir: [1, -0.85, -0.1] },
  { key: 'backOut', dir: [0.6, -0.75, -0.6] },
  { key: 'up', dir: [0.3, 0.9, -0.4] },
]

/** 关节限位（解剖范围）：超限的目标被夹回可达域，而不是报错。 */
export const JOINT_LIMITS = {
  /** 肘屈曲上限（度）：过伸超过 5° 就是反关节。 */
  elbowFlexMaxDeg: 150,
  /**
   * 膝屈曲上限（度）。
   *
   * 跪坐（正坐）对 THIS 体型的实测需求是 ~158°：大腿前下 33° 时大腿-小腿
   * 内夹角只剩 22°（2026-11-19 实测：155° 的可达域夹取会把跪坐的踝目标沿
   * 髋→踝方向推低 20mm，脚底跟着沉进地里，调目标常数治不了 —— 夹取只保证
   * 距离下限、方向不变）。159° 给正坐留 7mm 距离余量，同时离反折（180°）
   * 还很远 ✓。深蹲/跪姿拖拽也被此上限兜住。
   */
  kneeFlexMaxDeg: 159,
  /** 踝跖屈上限（度）。 */
  anklePlantarMaxDeg: 60,
  /** 踝背屈上限（度）。 */
  ankleDorsiflexMaxDeg: 45,
}

/**
 * 腕的解剖区间：**掌屈/背伸**与**尺桡偏折**是两个独立自由度，要分开限。
 *
 * 人腕：掌屈 ~80°、背伸 ~70°、尺桡偏 ~30°。
 *
 * ⚠ 之前夹的是「前臂轴 ↔ 手轴」的**总夹角**（40°）：手掌平贴在面上时，
 * 前臂与手之间本来就有几十度的横向偏折，总夹角把偏折算成了腕屈 → 背伸被夹 →
 * 掌翘起来、指尖扎进腿面（实测 sit 指尖入腿 50mm、kneel 入腿 13mm）。
 * 分开夹之后：坐姿要的是背伸 33° + 偏折 21°，都在解剖范围内 ✓。
 */
export const WRIST_LIMITS = {
  /** 掌屈上限（度）：手向掌侧折（超过就摊成一把耙子，实机像折断）。 */
  flexionMaxDeg: 40,
  /** 背伸上限（度）：手向背侧折（手掌平贴在面上时需要的正是这个角度）。 */
  extensionMaxDeg: 70,
  /** 尺/桡偏折上限（度）：手在额状面内偏向小指侧/拇指侧。 */
  deviationMaxDeg: 40,
}

interface Particle {
  id: EndEffectorId
  pos: THREE.Vector3
  /** 上一子步的位置（速度反推用）。 */
  prev: THREE.Vector3
  vel: THREE.Vector3
  goal: THREE.Vector3
  /**
   * 上次投影时的**原始意图**位置（固定位置目标用；锚点目标恒为 null）。
   *
   * 固定位置意图没变就不重新投影（见 refreshGoals 的 2-周期注释）✓。
   */
  lastRawGoal: THREE.Vector3 | null
  /** 期望朝向（锚点推导或显式给出；null = 保持静息朝向）。 */
  forward: THREE.Vector3 | null
  normal: THREE.Vector3 | null
  /** 肘的朝向提示。 */
  poleHint: 'back' | 'out' | 'up'
  mass: number
  stiffness: number
  friction: number
}

const tmpA = new THREE.Vector3()
const tmpB = new THREE.Vector3()
const tmpC = new THREE.Vector3()
/** 未投影过目标的哨兵（新粒子的 goal 是哨兵，首轮必定重投影）。 */
const ZERO_GOAL = new THREE.Vector3(1e9, 1e9, 1e9)

/** 临界阻尼系数 c = 2ζ√(km)。 */
function dampingCoefficient(stiffness: number, mass: number, ratio: number): number {
  return 2 * ratio * Math.sqrt(stiffness * mass)
}

/**
 * 可达域夹取：把末端目标限制在两骨链的可达范围内（对应关节屈曲/伸展上限）。
 * 超限的意图不是报错，而是**被夹住**（够不到就够不到，但肘不会反折）。
 *
 * 链长公式（f = 屈曲角，0 = 伸直）：d² = L1² + L2² + 2·L1·L2·cos(f)。
 * ⚠ 上下限别搞反：最大距离是**伸直**时（L1+L2），最小距离才是**最大屈曲**时。
 *   写反的后果：肘/膝永远伸不直（实测膝角卡在 135°，站姿都是弯腿）。
 */
export function clampToReach(
  chainPos: THREE.Vector3,
  target: THREE.Vector3,
  upperLen: number,
  lowerLen: number,
  maxFlexDeg: number,
  maxExtendDeg = 0,
): THREE.Vector3 {
  const flex = (maxFlexDeg * Math.PI) / 180
  const extend = (maxExtendDeg * Math.PI) / 180
  const base = upperLen * upperLen + lowerLen * lowerLen
  const two = 2 * upperLen * lowerLen
  const maxDist = Math.sqrt(base + two * Math.cos(extend))
  const minDist = Math.sqrt(Math.max(1e-6, base + two * Math.cos(flex)))
  const dir = target.clone().sub(chainPos)
  const d = dir.length()
  if (d < 1e-9) return target.clone()
  dir.divideScalar(d)
  const clamped = Math.min(Math.max(d, minDist), maxDist)
  return chainPos.clone().addScaledVector(dir, clamped)
}

/**
 * 姿势求解器（状态化：速度跨帧保留 → 拖动有惯性）。
 */
export class PoseSolver {
  private readonly host: SolverHost
  private readonly cfg: SolverConfig
  private readonly particles = new Map<EndEffectorId, Particle>()
  private targets: PoseTargets = { root: { x: 0, y: 0, z: 0 }, effectors: {} }
  private currentJoints: JointRotations = {}
  private readonly restFrames: Record<'Left' | 'Right', HandFrame>
  private isSettled = false
  /** 上一子步的关节表（落定判据：关节变化量）。 */
  private prevJoints: JointRotations = {}
  /**
   * 手臂「收回」的施密特触发器（每侧）。
   *
   * 收回与否的判据在边缘情形（上臂贴着体表擦过、间隙在 −5mm 附近）会翻来翻去：
   * 收回 → 目标跳几 cm → 间隙变好 → 不收回 → 跳回去 → …… 2-周期震荡、永不落定
   * （2026-11-18 实测 kneel 落定=否，肩/肘/腕每子步 ±0.15 rad 打摆）。改成
   * 施密特触发器：间隙 < −8mm 才进入收回，间隙 ≥ 0 才退出 ✓（2026-11-19 从
   * −1.5cm 收紧：前臂斜切胸腹角时链间隙只有 −11mm，旧门槛放过了它）。
   */
  private armShrunk: Record<'Left' | 'Right', boolean> = { Left: false, Right: false }
  /** 是否已做过首次 setTargets（决定要不要规范复位）。 */
  private initialized = false
  /** 探针顶点的蒙皮后位置（按探针顺序，xyz 连续）。 */
  private probePositions: Float32Array | null = null
  /**
   * 探针相对**粒子位置**的偏移（蒙皮那一刻记录）。
   *
   * 为什么不能拿 probePositions 减当前粒子位置（旧实现的 bug）：probePositions 是
   * 上一子步蒙皮的，粒子那之后又被接触约束挪过 → 两个时刻相减 = 错位的「手体积」，
   * 目标投影推的是一团错位的点（实测跨中线场景怎么推都 107mm）✓。
   */
  private probeOffsets = new Map<EndEffectorId, Float32Array>()
  /**
   * 末端体积采样的**静态**偏移（绑定姿态下量一次，相对腕/踝骨）。
   *
   * 目标投影必须用它：投影用的采样若随姿势变（动态探针），姿势是解给上一帧
   * 目标的 → 采样跟着变 → 投影结果在两个吸引态之间 2-周期震荡（实测目标在
   * 相距 19cm 的两点间永久打摆）。绑定姿态的手形状近似刚体，静态偏移让投影
   * 变成 (意图, 体段) 的确定函数 → 平滑收敛 ✓。
   */
  private staticSamples = new Map<EndEffectorId, THREE.Vector3[]>()
  /** 手部体积采样的静息手系局部坐标（脚为 null）✓ */
  private localSamples = new Map<EndEffectorId, Float32Array | null>()
  /** 手部顶点在静息手系里的局部坐标（支撑点选取前）✓ */
  private localPoints = new Map<EndEffectorId, THREE.Vector3[]>()
  /** 各末端在自己的探针数组里的下标区间。 */
  private probeRanges = new Map<EndEffectorId, { start: number; count: number }>()
  /** 身体尺寸（首次复位时量一次）。 */
  private metrics: BodyMetrics = {
    hand: { along: 0.09, offset: 0.025 },
    foot: { height: 0.08 },
  }
  /** 是否已量过身体尺寸。 */
  private metricsReady = false
  /** 当前选定的肘朝向（按侧别；带迟滞，避免子步间抖动）。 */
  private poleChoice: Record<'Left' | 'Right', THREE.Vector3> = {
    Left: new THREE.Vector3(0.25, -0.15, -1).normalize(),
    Right: new THREE.Vector3(-0.25, -0.15, -1).normalize(),
  }

  constructor(host: SolverHost, config: Partial<SolverConfig> = {}) {
    this.host = host
    this.cfg = { ...DEFAULT_SOLVER_CONFIG, ...config }
    this.restFrames = {
      Left: host.restHandFrame('Left'),
      Right: host.restHandFrame('Right'),
    }
    this.currentJoints = this.zeroJoints()
  }

  private zeroJoints(): JointRotations {
    const t: JointRotations = {}
    for (const j of JOINT_NAMES) t[j] = { x: 0, y: 0, z: 0 }
    return t
  }

  /** 当前目标（意图层）。 */
  getTargets(): PoseTargets {
    const effectors: PoseTargets['effectors'] = {}
    for (const [k, v] of Object.entries(this.targets.effectors)) {
      effectors[k as EndEffectorId] = { ...v }
    }
    return {
      root: { ...this.targets.root },
      effectors,
      head: this.targets.head === undefined ? undefined : { ...this.targets.head },
    }
  }

  /**
   * 设置新目标。
   *
   * `reset = true`（或首次调用）→ **规范复位**：骨骼回到绑定姿态、粒子回到目标、
   * 速度清零。这样同一组目标的求解结果与历史无关 → 确定性（参考图可复现）。
   * `reset = false`（拖动过程中的连续微调）→ 保留速度 → 有惯性滞后 ✓。
   */
  setTargets(targets: PoseTargets, opts: { reset?: boolean } = {}): void {
    const reset = opts.reset ?? !this.initialized
    this.initialized = true
    this.targets = {
      root: { ...targets.root },
      effectors: Object.fromEntries(
        Object.entries(targets.effectors).map(([k, v]) => [k, { ...v }]),
      ),
      head: targets.head === undefined ? undefined : { ...targets.head },
    }
    for (const [id, p] of this.particles) {
      const t = this.targets.effectors[id]
      if (t === undefined) { this.particles.delete(id); continue }
      const g = this.resolveGoal(id, t)
      if (g === null) continue
      this.applyGoal(p, g, reset, t.poleHint)
    }
    for (const [id, t] of Object.entries(this.targets.effectors) as [EndEffectorId, EndEffectorTarget][]) {
      if (this.particles.has(id)) continue
      const g = this.resolveGoal(id, t)
      if (g === null) continue
      const isHand = id === 'handL' || id === 'handR'
      this.particles.set(id, {
        id,
        pos: g.pos.clone(),
        prev: g.pos.clone(),
        vel: new THREE.Vector3(),
        goal: ZERO_GOAL.clone(),
        lastRawGoal: null,
        forward: g.forward?.clone() ?? null,
        normal: g.normal?.clone() ?? null,
        poleHint: t.poleHint ?? 'back',
        mass: isHand ? this.cfg.handMass : this.cfg.footMass,
        stiffness: isHand ? this.cfg.handStiffness : this.cfg.footStiffness,
        friction: this.cfg.friction,
      })
    }
    this.isSettled = false
    if (reset) {
      // 规范复位：骨骼先回到绑定姿态（零关节表），再由粒子解算接管
      this.currentJoints = this.zeroJoints()
      for (const p of this.particles.values()) {
        p.pos.copy(p.goal)
        p.prev.copy(p.goal)
        p.vel.set(0, 0, 0)
      }
      this.host.applyPose(this.currentJoints, this.targets.root, [])
      // 身体尺寸要在绑定姿态下量（量完目标点要按尺寸重算一次）
      this.computeMetrics()
      for (const [id, p] of this.particles) {
        const t = this.targets.effectors[id]
        if (t === undefined) continue
        const g = this.resolveGoal(id, t)
        if (g === null) continue
        this.applyGoal(p, g, true, t.poleHint)
      }
    }
  }

  /** 目标落到粒子：位置变了就清速度（意图跳变不甩尾）。 */
  private applyGoal(p: Particle, g: ResolvedGoal, reset: boolean, hint?: 'back' | 'out' | 'up'): void {
    // 朝向无条件覆盖（含置空）：目标换了形态就该丢掉旧朝向 ✓
    p.forward = g.forward === null ? null : g.forward.clone()
    p.normal = g.normal === null ? null : g.normal.clone()
    if (hint !== undefined) p.poleHint = hint
    const moved = p.goal.distanceTo(g.pos) > 1e-4
    p.goal.copy(g.pos)
    if (moved || reset) p.vel.set(0, 0, 0)
    if (reset) p.pos.copy(p.goal)
  }

  /**
   * 目标解析：语义锚点 → 当前几何上的具体坐标。
   *
   * 锚点每子步重解析（体段的轴随姿势变）→ 预设可以写「手贴大腿」而不写死坐标 ✓。
   */
  private resolveGoal(id: EndEffectorId, t: EndEffectorTarget): ResolvedGoal | null {
    const isHand = id === 'handL' || id === 'handR'
    if (t.anchor !== undefined) {
      const seg = this.host.anchorSegment(t.anchor!.part)
      if (seg === undefined) return null
      const axis = seg.b.clone().sub(seg.a).normalize()
      // 「上」= 世界竖直在段轴的垂直分量；「外」= 远离身体中线
      const up = new THREE.Vector3(0, 1, 0).addScaledVector(axis, -axis.y)
      if (up.lengthSq() < 1e-9) up.set(0, 0, 1).addScaledVector(axis, -axis.z)
      up.normalize()
      // 「外」= 远离身体中线。⚠ 不能用段中点的 x 符号：躯干这种**居中**的段
      //   中点在 x=0，左右手会解析到同一侧（右臂穿到身体另一侧，实测 168mm 穿插）。
      //   方向必须由**末端自身在哪一侧**决定。
      const outward = new THREE.Vector3(id === 'handL' || id === 'footL' ? 1 : -1, 0, 0)
      outward.addScaledVector(axis, -outward.dot(axis))
      if (outward.lengthSq() < 1e-9) outward.copy(up)
      outward.normalize()
      const theta = (t.anchor.radialDeg * Math.PI) / 180
      const dir = up.multiplyScalar(Math.cos(theta)).addScaledVector(outward, Math.sin(theta)).normalize()
      const hit = seg.surfaceAlong(t.anchor.t, dir)
      if (hit === null) return null
      // 锚点描述的是**接触点**（手掌触点 / 脚掌触点）
      const contact = hit.point.clone().addScaledVector(dir, t.anchor.gapM)
      // 指尖方向：没给就顺着**体段的表面切向**（不是段轴）。
      //
      // 为什么不能直接用段轴：肢体是锥形的（大腿近膝更细），顶面沿长度下沉；
      // 手掌平贴在上面时，指尖要跟着坡度走，掌根（腕后那截）才不会被抬离面、
      // 指尖才不扎进面（实测：按段轴放 → 掌根入面 9mm、掌心离面 10mm ✗）。
      const forward = t.forward !== undefined
        ? new THREE.Vector3(t.forward.x, t.forward.y, t.forward.z).normalize()
        : surfaceTangent(seg, t.anchor.t, dir)
      const normal = t.normal !== undefined
        ? new THREE.Vector3(t.normal.x, t.normal.y, t.normal.z).normalize()
        : dir.clone().negate()
      if (isHand) {
        // 触点 → 腕：沿手轴回退「腕→掌心」，再沿掌心法向退「掌厚」
        const m = this.metrics.hand
        const pos = contact.clone().addScaledVector(forward, -m.along).addScaledVector(normal, -m.offset)
        return { pos, forward, normal }
      }
      // 脚：脚掌触点在地面 → 踝在触点上方「踝高」处
      const pos = contact.clone().addScaledVector(new THREE.Vector3(0, 1, 0), this.metrics.foot.height)
      return { pos, forward, normal }
    }
    if (t.pos === undefined) return null
    const forward = t.forward !== undefined
      ? new THREE.Vector3(t.forward.x, t.forward.y, t.forward.z).normalize()
      : null
    const normal = t.normal !== undefined
      ? new THREE.Vector3(t.normal.x, t.normal.y, t.normal.z).normalize()
      : null
    return { pos: new THREE.Vector3(t.pos.x, t.pos.y, t.pos.z), forward, normal }
  }

  /**
   * 量身体尺寸（绑定姿态下量一次，姿势无关）：
   *  · 腕→掌心沿手轴距离 + 掌厚（手目标点的换算依据）；
   *  · 踝离脚底的高度（脚目标点的换算依据）。
   *
   * 探针约定：`effectorProbes(id)[0]` = 掌心/脚掌中心的顶点索引。
   */
  private computeMetrics(): void {
    if (this.metricsReady) return
    const root = this.targets.root
    const zero = this.zeroJoints()
    for (const side of ['Left', 'Right'] as const) {
      const m = this.host.handMetrics(side)
      this.metrics.hand = { along: m.along, offset: m.offset }
    }
    for (const side of ['Left', 'Right'] as const) {
      const id: EndEffectorId = side === 'Left' ? 'footL' : 'footR'
      const probes = this.host.effectorProbes(id)
      if (probes.length === 0) continue
      const pos = this.host.applyPose(zero, root, probes)
      let minY = Infinity
      for (let i = 0; i < probes.length; i++) minY = Math.min(minY, pos[i * 3 + 1])
      const ankle = this.host.boneAt(`mixamorig${side}Foot`)
      this.metrics.foot = { height: Math.max(0.01, ankle.y - minY) }
    }
    this.metricsReady = true
  }

  /** 当前关节表（表现层输出）。 */
  joints(): JointRotations {
    return this.currentJoints
  }

  /** 调试：身体尺寸（手：腕→掌心沿手轴距离、掌厚；脚：踝高）。 */
  debugMetrics(): { hand: { along: number; offset: number }; foot: { height: number } } {
    return {
      hand: { ...this.metrics.hand },
      foot: { ...this.metrics.foot },
    }
  }

  /** 调试：各末端的粒子状态（位置 / 目标 / 速度）。 */
  debugState(): Record<string, { pos: THREE.Vector3; goal: THREE.Vector3; vel: THREE.Vector3 }> {
    const out: Record<string, { pos: THREE.Vector3; goal: THREE.Vector3; vel: THREE.Vector3 }> = {}
    for (const [id, p] of this.particles) {
      out[id] = { pos: p.pos.clone(), goal: p.goal.clone(), vel: p.vel.clone() }
    }
    return out
  }

  /** 是否已落定（速度低于阈值）。 */
  settled(): boolean {
    return this.isSettled
  }

  /**
   * 清空意图目标：求解器停摆（视口不再改姿势）。
   *
   * 用途：从归档回放「钉死的关节表」——旧档没有意图，只能直接钉关节角；
   * 这时求解器必须让位，否则下一帧又把它解回去 ✓。
   */
  clearTargets(): void {
    this.targets = { root: { x: 0, y: 0, z: 0 }, effectors: {} }
    this.isSettled = true
  }

  /** 推进 n 个子步（默认 substepsPerStep），返回当前关节表。 */
  step(substeps = this.cfg.substepsPerStep): JointRotations {
    for (let i = 0; i < substeps; i++) {
      this.substep()
      if (this.isSettled) break
    }
    return this.currentJoints
  }

  /** 推进到落定（固定子步上限 → 确定性）。 */
  settle(): JointRotationsResult {
    for (let i = 0; i < this.cfg.maxSubsteps; i++) {
      this.substep()
      if (this.isSettled) break
    }
    return { joints: this.currentJoints, settled: this.isSettled }
  }

  // ── 单个子步 ───────────────────────────────────────────────────────
  private substep(): void {
    this.refreshGoals()
    this.integrate()
    this.solveIk()
    this.applyContacts()
    this.updateVelocities()
  }

  /**
   * 挑肘的朝向：候选逐个解 IK，用「上臂中点 + 肘 + 前臂中点离躯干/腿的间隙」评分。
   *
   * ⚠ 必须把**上臂中点**也算进去（2026-11-18 实机事故）：只看肘与前臂时，
   * 目标在身体另一侧的场景会让 IK 把**上臂从躯干里穿过去** ——
   * 实测上臂插进胸口 112mm，手是好的但整条胳膊穿模 ✓。
   *
   * 提示（poleHint）只给偏好分，不强制 —— 提示与身体冲突时物理优先 ✓。
   */
  private chooseArmPole(
    side: 'Left' | 'Right',
    chain: { shoulderPos: THREE.Vector3; parentQuat: THREE.Quaternion; upperOffset: THREE.Vector3; foreOffset: THREE.Vector3 },
    target: THREE.Vector3,
    hint: 'back' | 'out' | 'up',
    align: THREE.Vector3 | null = null,
  ): THREE.Vector3 {
    const lateral = side === 'Left' ? 1 : -1
    const segments = this.host.segments()
    const current = this.poleChoice[side]
    const scoreOf = (pole: THREE.Vector3): number => {
      const ik = solveTwoBone(chain, target, pole)
      const upperMid = chain.shoulderPos.clone().add(ik.elbowPos).multiplyScalar(0.5)
      const foreMid = ik.elbowPos.clone().add(target).multiplyScalar(0.5)
      let clearance = Infinity
      for (const p of [upperMid, ik.elbowPos, foreMid]) {
        for (const seg of segments) {
          const d = seg.distance(p)
          if (d < clearance) clearance = d
        }
      }
      return clearance
    }
    // 锚定手：按「前臂与手掌同向」选肘位（腕伸直 = 手掌平贴面时的真人物理 ✓）
    //
    // 为什么需要这条规则：手掌平贴在面上时，真人的前臂与手是连成一条线的
    // （坐姿搭腿：前臂顺着腿面，腕不折）。只按「链离身体最空」挑肘 → 前臂朝下垂
    // → 要把掌放平得背伸 60°+ → 腕被夹限 → 掌翘起来、指尖扎进腿面
    // （实测 sit 指尖入腿 50mm、kneel 入腿 13mm）✓
    if (align !== null) {
      const alignOf = (pole: THREE.Vector3): number => {
        const ik = solveTwoBone(chain, target, pole)
        const fore = target.clone().sub(ik.elbowPos)
        if (fore.lengthSq() < 1e-12) return -Infinity
        return fore.normalize().dot(align)
      }
      // 候选分两档：离身体有安全余量的（代理 15mm）优先（代理比网格胖，
      // 余量不够时网格会陷进去（实测前臂入胸 11.8mm）✓
      const cands = POLE_CANDIDATES.map((cand) => {
        const pole = new THREE.Vector3(cand.dir[0] * lateral, cand.dir[1], cand.dir[2]).normalize()
        return { pole, clear: scoreOf(pole), key: cand.key }
      }).filter((c) => c.clear >= 0)
      const safe = cands.filter((c) => c.clear >= 0.015)
      const pool = safe.length > 0 ? safe : cands
      if (pool.length > 0) {
        let best = pool[0]
        let bestScore = alignOf(pool[0].pole) + (pool[0].key === hint ? 0.05 : 0)
        for (const c of pool) {
          const s = alignOf(c.pole) + (c.key === hint ? 0.05 : 0)
          if (s > bestScore) {
            bestScore = s
            best = c
          }
        }
        // 迟滞：同分不换（否则两个候选来回翻 → 肘抖 → 目标抖）✓
        if (best.pole === current || bestScore > alignOf(current) + POLE_ALIGN_MARGIN) {
          this.poleChoice[side] = best.pole
          return best.pole
        }
        return current
      }
    }
    // 解剖意图优先（2026-11-19 实机修复）：hint 的 pole 无身体冲突就直接用。
    // 纯按「链离身体最远」打分会把松垂摆臂的肘理性地举到肩高（上臂水平外展
    // 90°、实机「支架手」）—— 肘该在肩下方是解剖事实，不是间隙优化题 ✓。
    // 有冲突（hinted 肘/链穿进身体）才回退到按间隙选 ✓。
    const hinted = POLE_CANDIDATES.find((c) => c.key === hint)
    if (hinted !== undefined) {
      const pole = new THREE.Vector3(hinted.dir[0] * lateral, hinted.dir[1], hinted.dir[2]).normalize()
      if (scoreOf(pole) >= 0) {
        this.poleChoice[side] = pole
        return pole
      }
    }
    let best = current
    let bestScore = scoreOf(current)
    for (const cand of POLE_CANDIDATES) {
      const pole = new THREE.Vector3(cand.dir[0] * lateral, cand.dir[1], cand.dir[2]).normalize()
      // 提示只给一点偏好分：身体冲突时让物理赢
      const score = scoreOf(pole) + (cand.key === hint ? 0.02 : 0)
      if (score > bestScore) {
        bestScore = score
        best = pole
      }
    }
    // ⚠ 迟滞：新候选要比当前的好过一截才换。
    //   不加迟滞会「每个子步换来换去」→ IK 目标抖动 → 求解器发散（实测脚飘到 31cm 高）。
    if (best !== current && scoreOf(best) < scoreOf(current) + POLE_SWITCH_MARGIN) {
      return current
    }
    this.poleChoice[side] = best
    return best
  }

  /**
   * 前臂方向（肘→腕）的预算：按当前 pole 解一次两骨 IK。
   *
   * 用途：让体外投影用的手系与**实际姿势**一致（实际腕部朝向默认沿前臂）。
   * 用当前 pole（不重新挑）→ 便宜且与实际解出的肘一致 ✓。
   */
  private foreDirOf(id: EndEffectorId, goal: THREE.Vector3): THREE.Vector3 {
    const isHand = id === 'handL' || id === 'handR'
    if (!isHand) return goal.clone().sub(this.host.boneAt(JOINT_BONES[id === 'footL' ? 'hipL' : 'hipR'])).normalize()
    const side = id === 'handL' ? 'Left' : 'Right'
    const binding = this.host.binding
    const shoulderPos = this.host.boneAt(JOINT_BONES[side === 'Left' ? 'shoulderL' : 'shoulderR'])
    const parentQuat = this.host.boneParentQuat(JOINT_BONES[side === 'Left' ? 'shoulderL' : 'shoulderR'])
    const upperOffset = binding.restLocal.get(side === 'Left' ? 'elbowL' : 'elbowR') as THREE.Vector3
    const foreOffset = binding.restLocal.get(side === 'Left' ? 'wristL' : 'wristR') as THREE.Vector3
    const target = clampToReach(shoulderPos, goal, upperOffset.length(), foreOffset.length(), JOINT_LIMITS.elbowFlexMaxDeg)
    const pole = this.poleChoice[side]
    const ik = solveTwoBone({ shoulderPos, parentQuat, upperOffset, foreOffset }, target, pole)
    const dir = target.clone().sub(ik.elbowPos)
    if (dir.lengthSq() < 1e-12) return target.clone().sub(shoulderPos).normalize()
    return dir.normalize()
  }

  /**
   * 语义锚点随体段移动 → 每子步刷新一次目标（体段的轴随姿势变 ✓）。
   */
  private refreshGoals(): void {
    for (const [id, p] of this.particles) {
      const t = this.targets.effectors[id]
      if (t === undefined) continue
      const g = this.resolveGoal(id, t)
      if (g === null) continue
      // 目标 = **可达域 ∩ 体外**：两者的交集才算「手臂够得到且不穿身体」。
      // 只做体外投影 → 目标可能压根够不着 → 手臂被拉直横扫身体（实测上臂插进
      // 胸口 112mm）；只做可达域夹取 → 目标可能落在身体里 → 手插进身体 ✓。
      // 两步交替两轮 → 逼近交集（确定性：每子步同输入同结果 ✓）。
      // 采样用绑定姿态的静态手形状（volumeSamples）→ 投影是 (意图, 体段) 的
      // 确定函数，没有「姿势 → 采样 → 目标 → 姿势」的反馈环 → 平滑收敛 ✓。
      {
        const goal = g.pos.clone()
        // 锚点目标跳过体积投影（2026-11-19）：锚点语义 = 接触点**贴在面上**
        //（gapM 就是作者要的间隙），体积投影按整手采样往外推会和锚点打架 ——
        // 掌心朝腿的坐姿手被推得悬空 37mm（HM08 指卷朝掌侧，掌朝腿时采样必
        // 戳进腿面）。贴面 rests 由接触约束兜住 ✓；非锚点目标（裸位置拖拽）
        // 仍要投影（拖进身体的目标必须推出体外 ✓）。
        const anchored = this.targets.effectors[id]?.anchor !== undefined
        // 投影要按**意图手系**定向采样（2026-11-19）：绑定朝向的采样看不见
        // 「掌心朝内时指尖戳进大腿」→ 投影判体外、实际穿模 ✓。
        // 手系必须与**实际姿势**一致：实际指尖方向默认沿**前臂**（foreDir），
        // 所以这里用同一条 IK 预算前臂方向，不能用「肩→目标」糊弄
        // （run 实测：糊弄 → 投影判体外、实际入躯干 35mm）✓。
        const side = id === 'handL' || id === 'footL' ? 'Left' : 'Right'
        const isHand = id === 'handL' || id === 'handR'
        const shoulder = this.host.boneAt(JOINT_BONES[isHand
          ? (side === 'Left' ? 'shoulderL' : 'shoulderR')
          : (side === 'Left' ? 'hipL' : 'hipR')])
        const projNormal = g.normal !== null
          ? g.normal.clone()
          : this.inwardPalmDir(shoulder, side)
        for (let i = 0; i < 2; i++) {
          goal.copy(this.clampToReachOf(id, goal))
          const projForward = g.forward !== null
            ? g.forward.clone()
            : this.foreDirOf(id, goal)
          if (!anchored) this.projectOutOfBody(goal, id, projForward, projNormal)
        }
        p.goal.copy(goal)
      }
      // 朝向**无条件**刷新（含置空）：目标从「带朝向」换成「只有位置」时，
      // 必须把旧朝向丢掉，否则手会一直保持上一个姿势的手型（拧着）。
      p.forward = g.forward === null ? null : g.forward.clone()
      p.normal = g.normal === null ? null : g.normal.clone()
    }
  }

  /**
   * 方向扫掠：目标方向穿过身体时，绕竖直轴向**肩侧**拐，直到链路不穿。
   *
   * 物理含义：手被胸口挡住，沿胸面滑到最近的可及点（2026-11-18 实测「手拖过中线」
   * 上臂插进胸口 107mm —— 全伸时肘没有摆动自由度，pole 救不了，只能拐方向）。
   *
   * 拐的角度 = 从目标方向到「肩的正侧向」的有符号角的分位数（0.15 → 1.0 全拐到
   * 正侧向），取第一个不穿的角度 → 滑动距离最小 ✓。确定性：同样的输入同样的拐法 ✓。
   */
  private sweepTargetToSide(
    side: 'Left' | 'Right',
    shoulderPos: THREE.Vector3,
    target: THREE.Vector3,
    hint: 'back' | 'out' | 'up',
    chain: { shoulderPos: THREE.Vector3; parentQuat: THREE.Quaternion; upperOffset: THREE.Vector3; foreOffset: THREE.Vector3 },
  ): { target: THREE.Vector3; pole: THREE.Vector3; ik: TwoBoneSolution } | null {
    const dirFull = target.clone().sub(shoulderPos)
    const len = dirFull.length()
    if (len < 1e-6) return null
    const dirH = new THREE.Vector3(dirFull.x, 0, dirFull.z)
    const shoulderH = new THREE.Vector3(shoulderPos.x, 0, shoulderPos.z)
    if (dirH.lengthSq() < 1e-10 || shoulderH.lengthSq() < 1e-10) return null
    dirH.normalize()
    shoulderH.normalize()
    // 有符号角：dirH 绕 +Y 转 δ 后与 shoulderH 对齐（右手系，从上往下看逆时针为正）
    const sinD = dirH.x * shoulderH.z - dirH.z * shoulderH.x
    const cosD = dirH.dot(shoulderH)
    const delta = Math.atan2(sinD, cosD)
    for (const k of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0]) {
      const rotH = dirH.clone().applyAxisAngle(tmpA.set(0, 1, 0), delta * k)
      const candDir = new THREE.Vector3(rotH.x, dirFull.y / len, rotH.z).normalize()
      const cand = shoulderPos.clone().addScaledVector(candDir, len)
      const candPole = this.chooseArmPole(side, chain, cand, hint)
      const candIk = solveTwoBone(chain, cand, candPole)
      // 安全余量：代理比网格胖，判 0 时网格仍可能陷进去（实测 19mm）
      const clear = this.armClearance(candIk, cand, shoulderPos)
      if (clear >= 0.015) {
        return { target: cand, pole: candPole, ik: candIk }
      }
    }
    return null
  }

  /**
   * 末端目标的可达域夹取（与 IK 里同一套口径 ✓）。
   *
   * 为什么要对**目标**也夹：目标不可达时，IK 会把关节角推到极限，手臂被拉直，
   * 整条胳膊横扫身体（实测上臂插进胸口 112mm）—— 真实的手臂是「够不到就停在
   * 身前」，不是「穿过去」✓。
   */
  private clampToReachOf(id: EndEffectorId, p: THREE.Vector3): THREE.Vector3 {
    const binding = this.host.binding
    const isHand = id === 'handL' || id === 'handR'
    const rootJoint = isHand
      ? (id === 'handL' ? 'shoulderL' : 'shoulderR')
      : (id === 'footL' ? 'hipL' : 'hipR')
    const midJoint = isHand
      ? (id === 'handL' ? 'elbowL' : 'elbowR')
      : (id === 'footL' ? 'kneeL' : 'kneeR')
    const tipJoint = isHand
      ? (id === 'handL' ? 'wristL' : 'wristR')
      : (id === 'footL' ? 'ankleL' : 'ankleR')
    const rootPos = this.host.boneAt(JOINT_BONES[rootJoint])
    const L1 = (binding.restLocal.get(midJoint) as THREE.Vector3).length()
    const L2 = (binding.restLocal.get(tipJoint) as THREE.Vector3).length()
    const limit = isHand ? JOINT_LIMITS.elbowFlexMaxDeg : JOINT_LIMITS.kneeFlexMaxDeg
    return clampToReach(rootPos, p, L1, L2, limit)
  }

  /**
   * 掌心朝向的默认参考：朝体侧（手臂垂下时掌心贴大腿 ✓）。
   *
   * 取「肩→体中线」的水平方向：角色左 = +x，故左肩（x>0）的朝体内方向是 −x ✓。
   */
  private inwardPalmDir(shoulderPos: THREE.Vector3, side: 'Left' | 'Right'): THREE.Vector3 {
    const dir = new THREE.Vector3(-shoulderPos.x, 0, 0)
    if (dir.lengthSq() < 1e-9) dir.set(side === 'Left' ? -1 : 1, 0, 0)
    return dir.normalize()
  }

  /**
   * 手臂（肩→肘→腕）离身体的间隙（米）：负 = 穿进身体了。
   *
   * 取样：上臂中点、肘、前臂中点 —— 三处都要不穿才算手臂没穿模 ✓。
   */
  private armClearance(
    ik: TwoBoneSolution,
    target: THREE.Vector3,
    shoulderPos: THREE.Vector3,
  ): number {
    const samples = [
      shoulderPos.clone().add(ik.elbowPos).multiplyScalar(0.5),
      ik.elbowPos.clone(),
      ik.elbowPos.clone().add(target).multiplyScalar(0.5),
      // 前臂近腕 3/4 处：前臂斜切胸腹角时最深处在中点靠腕一侧（2026-11-19 实测
      // 手拖进腹部：中点 −11mm、3/4 处更深 → 网格 56mm），中点一个样本看不住 ✓
      ik.elbowPos.clone().lerp(target, 0.75),
      // ⚠ 腕点（= 收缩后的目标）本身也要查（2026-11-18 实测）：只查上臂/肘/前臂时，
      //   收缩候选会把腕塞进胸腔（肘与前臂都「贴着」体表、腕却在体内）→ 手插进躯干
      //   62mm。腕在体表之外 + 链上各点不穿，才算这条候选成立 ✓。
      target.clone(),
    ]
    let worst = Infinity
    for (const p of samples) {
      for (const seg of this.host.segments()) {
        const d = seg.distance(p)
        if (d < worst) worst = d
      }
    }
    return worst
  }

  /**
   * 把目标点投影到体外：意图落在身体内部（拖进大腿里）时，不是报错也不是硬塞 ——
   * 而是**投影到表面**（和可达域夹取同一套思路：越界的意图被夹住，不被拒绝）。
   *
   * 不做这一步的后果：弹簧每步往里拉、接触每步往外推，两股力顶着抖，
   * 速度永远不归零（求解器不落定，实测 |v|≈1.2m/s 的极限环）。
   *
   * ⚠ 按**末端的体积**投影，不是只推腕点（2026-11-18 实机事故）：
   * 手还有 19cm 的指节伸出腕外，腕在腿外 1cm 不代表手没插进腿。
   * 所以要把「掌心 + 指尖」几个采样点一起推到体外 ✓。
   */
  private projectOutOfBody(p: THREE.Vector3, id: EndEffectorId, forward: THREE.Vector3, normal: THREE.Vector3): void {
    const segments = this.host.segments()
    const samples = this.orientedOffsets(id, forward, normal)
    // 脚跳过**同侧**腿段（与 applyContacts 同规则）：脚的静置摆动就在自己的
    // 小腿/大腿代理旁，静态脚样本一伸进去就被往外推 → 目标漂移不落定
    //（实测 walk/run/kneel 落定=否）✓。
    const skipOwnLeg = id === 'footL' || id === 'footR'
    const ownSide = id === 'footL' || id === 'handL' ? 'left' : 'right'
    const segs = skipOwnLeg ? segments.filter((seg) => !seg.name.startsWith(ownSide)) : segments
    // 逐采样点迭代推出：每个采样点用它**自己**的外向。
    //
    // 为什么不能只按最深采样推一次（旧实现）：手横穿身体时（腕在一侧体内、指尖从
    // 另一侧穿出），腕点的外向指向侧面、指尖的外向指向前方 —— 按腕的外向推一次，
    // 手整体平移后指尖还是插在身体里（实测怎么推都 57~117mm）。
    // 迭代 4 轮：每轮处理当前最深的采样点，整条手的体积逐步挪出体外 ✓。
    for (let iter = 0; iter < 4; iter++) {
      let moved = false
      for (const s of samples) {
        for (const seg of segs) {
          const q = tmpB.copy(p).add(s)
          const d = seg.distance(q)
          if (d >= 0) continue
          const outward = seg.probe(q)?.outward ?? null
          if (outward === null) continue
          // 推到表面**外侧 5mm**：正好贴面的话接触每步都在临界触发，
          // 推出方向又随位置摆动 → 目标点乱抖 → 求解发散。
          p.addScaledVector(outward, -d + 0.005)
          moved = true
        }
      }
      if (!moved) break
    }
  }

  /**
   * 末端（手）的长度（米）：从上一子步蒙皮探针量「腕 → 最远探针」的距离。
   *
   * 指尖修正用：把「腕 + forward × 手长」查碰撞才知道指尖有没有戳进去。
   * 探针没算出来时退化为 0（不修正）。
   */
  private handLenOf(id: EndEffectorId): number {
    // 活体探针优先：指尖修正量的是**真实摆位**的手长（静态采样取绑定姿态的
    // 张开手指，手长多 ~4cm，在贴腿姿势会把指尖修正误触发成大腕屈 ✓ 实测）。
    const offsets = this.probeOffsets.get(id)
    if (offsets !== undefined) {
      let best = 0
      for (let k = 0; k < offsets.length / 3; k++) {
        const d = Math.hypot(offsets[k * 3], offsets[k * 3 + 1], offsets[k * 3 + 2])
        if (d > best) best = d
      }
      if (best > 0.01) return best
    }
    let best = 0
    for (const v of this.volumeSamples(id)) {
      const d = v.length()
      if (d > best) best = d
    }
    return best
  }

  /**
   * 指尖不戳进身体：把 forward 沿「朝外」方向旋出，直到指尖点在体外。
   *
   * 为什么必须做（2026-11-18 实测）：目标没给朝向时手沿前臂方向延伸，前臂指向
   * 身体（跨中线够东西、手按体表）时指尖插进躯干/腿 62~117mm。真实的手按在
   * 面上时腕背伸、指尖顺面滑 ✓。
   *
   * 判据用**意图手系定向的静态手形状**（orientedOffsets），不用上一子步的
   * 活体探针（2026-11-19 系统性修复）：活体探针是「上一子步姿势」的结果 ——
   * 腕转 → 探针动 → 判据翻转 → 腕反转 → 二值判断形成 2 周期震荡
   * （实机「手腕拧成那样」：实测腕关节每子步摆 9°，求解器永不落定）✓。
   * 静态定向采样是 (意图, 体段) 的纯函数 → 每子步同输入同结果 ✓ 收敛 ✓。
   *
   * 偏角封顶：腕背伸解剖极限 ~70°；封顶后仍有残余穿深就交给接触约束兜住
   *（腕折 90° 把手折断的观感更差）。
   */
  private keepFingersOut(
    wristPos: THREE.Vector3,
    forward: THREE.Vector3,
    normal: THREE.Vector3,
    id: EndEffectorId,
  ): THREE.Vector3 {
    const segments = this.host.segments()
    const offsets = this.orientedOffsets(id, forward, normal)
    if (offsets.length === 0) return forward.clone()
    // 同侧腿段用深触发（−4cm）：手贴着自己的腿路过是常态（stand 垂手），代理偏肥
    // 会把「擦边」误判体内 → 大腕屈（实测 stand 腕屈 7°→57°）；真把手戳进自己
    // 腿里的穿深在 4cm+。躯干与对侧肢体不豁免（跨中线/按胸口是真问题）✓。
    const ownPrefix = id === 'handL' ? 'left' : 'right'
    const isOwnLegSeg = (segName: string): boolean =>
      segName.startsWith(ownPrefix) && (segName.includes('Thigh') || segName.includes('Shin'))
    const deadbandFor = (segName: string): number => (isOwnLegSeg(segName) ? -0.04 : -0.015)
    let deepest = 0
    let outward: THREE.Vector3 | null = null
    let deepestOffset: THREE.Vector3 | null = null
    for (const off of offsets) {
      const q = tmpB.copy(wristPos).add(off)
      for (const seg of segments) {
        const d = seg.distance(q)
        if (d < deepest && d < deadbandFor(seg.name)) {
          deepest = d
          outward = seg.probe(q)?.outward ?? null
          deepestOffset = off.clone()
        }
      }
    }
    if (outward === null || deepestOffset === null) {
      return forward.clone()
    }
    // TS 收窄：闭包里的可变捕获要落成 const（deepestSeg possibly null ✗）
    const offset0 = deepestOffset
    const axis = new THREE.Vector3().crossVectors(forward, outward)
    if (axis.lengthSq() < 1e-10) return forward.clone()
    axis.normalize()
    const out = forward.clone()
    const rotated = new THREE.Vector3()
    // 「改善即收」：转一个小角度只要让指尖深度**变浅**就接受。
    //
    // 为什么不要求「完全转出体外」：边缘情形（手指贴着体表搭着）没有能把指尖
    // 完全转出去的角度，旧判据会一路转满 70°，下一子步探针又变、再转 ——
    // 两个状态之间 2-周期震荡、永不落定（2026-11-18 实测 kneel 落定=否）。
    // 改善即收让深度单调变浅 → 收敛 ✓；没有改善就不转（保持稳定）✓。
    for (const theta of [0.2, 0.4, 0.7, 1.0, 1.22]) {
      out.copy(forward).applyAxisAngle(axis, theta)
      // 手是刚体：手指偏移向量跟着手系一起转（绕同一轴、同一角）
      rotated.copy(offset0).applyAxisAngle(axis, theta)
      const tipQ = tmpB.copy(wristPos).add(rotated)
      let worst = 0
      for (const seg of segments) {
        const d = seg.distance(tipQ)
        if (d < worst) worst = d
      }
      if (worst > deepest + 0.002) return out
    }
    return forward.clone()
  }

  /**
   * 末端的体积采样偏移（相对腕/踝，模型空间）：掌心、指尖、掌根…
   *
   * 用上一子步蒙皮后的探针位置减去腕的位置得到 → 手长、掌厚自动跟着模型走
   *（换体型不用改常数）✓。探针没算出来时退化成「只有腕点」。
   */
  private volumeSamples(id: EndEffectorId): THREE.Vector3[] {
    const cached = this.staticSamples.get(id)
    if (cached !== undefined) return cached
    const probes = this.host.effectorProbes(id)
    if (probes.length === 0) return [new THREE.Vector3()]
    // 绑定姿态下量一次（零关节表）：手形状近似刚体，偏移与姿势无关 ✓
    const posed = this.host.applyPose(this.zeroJoints(), this.targets.root, probes)
    const side = id === 'handL' || id === 'footL' ? 'Left' : 'Right'
    const isHand = id === 'handL' || id === 'handR'
    const wrist = this.host.boneAt(`mixamorig${side}${isHand ? 'Hand' : 'Foot'}`)
    const all: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0)]
    for (let k = 0; k < probes.length; k++) {
      all.push(new THREE.Vector3(
        posed[k * 3] - wrist.x,
        posed[k * 3 + 1] - wrist.y,
        posed[k * 3 + 2] - wrist.z,
      ))
    }
    // 稀疏化：最多 8 个（零偏移 + 均匀 6 个 + 最远的指尖）
    const out: THREE.Vector3[] = [all[0]]
    const rest = all.slice(1)
    const step = Math.max(1, Math.ceil(rest.length / 6))
    for (let k = 0; k < rest.length; k += step) out.push(rest[k])
    let far = rest[0]
    let farD = -1
    for (const v of rest) {
      const d = v.lengthSq()
      if (d > farD) { farD = d; far = v }
    }
    out.push(far.clone())
    this.staticSamples.set(id, out)
    return out
  }

  /**
   * 手部体积采样的**静息手系局部坐标**（[forward 分量, normal 分量, side 分量]）。
   *
   * 为什么要有局部坐标（2026-11-19 系统性修复）：体积采样之前是「绑定姿态下的
   * 世界偏移」，于是**手一转就失真**：
   *   ① 体外投影按绑定朝向判穿模 → 手掌朝内时指尖其实戳进大腿，投影看不见；
   *   ② keepFingersOut 按**上一子步姿势**的探针判 → 腕转 → 探针动 → 再转 …
   *      二值判断形成 2 周期震荡（实机「手腕拧成那样」，实测腕关节每子步摆 9°，
   *      求解器永不落定）✓。
   * 存成局部坐标后，采样点可按**意图手系**实时定向 → 判据成为 (意图, 体段) 的
   * 纯函数，没有「姿势 → 采样 → 目标 → 姿势」反馈环 ✓。
   *
   * 采样点取**支撑点**（26 个方向上的极值顶点，≈ 手的凸包角点）：
   * 原来只取探针（掌心 + 指尖）会漏掉「掌缘角点」—— walk 实测右手指尖入腿
   * 53mm 而投影判 5mm（角点比指尖更靠内）✓。
   */
  private handVolumeLocal(id: EndEffectorId): Float32Array | null {
    const cached = this.localSamples.get(id)
    if (cached !== undefined) return cached
    const isHand = id === 'handL' || id === 'handR'
    if (!isHand) {
      this.localSamples.set(id, null)
      return null
    }
    const side = id === 'handL' ? 'Left' : 'Right'
    const rest = this.restFrames[side]
    const local: number[] = []
    for (const v of this.handLocalPoints(id)) {
      local.push(v.x, v.y, v.z)
    }
    const arr = new Float32Array(local)
    this.localSamples.set(id, arr)
    return arr
  }

  /**
   * 手部顶点在静息手系里的局部坐标（全部顶点，不稀疏化）。
   *
   * 支撑点选取：26 个方向（6 轴 + 12 棱 + 8 角）上投影最大的顶点 → 覆盖手的
   * 各个「极角」（掌缘、拇指根、指尖）✓。
   */
  private handLocalPoints(id: EndEffectorId): THREE.Vector3[] {
    const cached = this.localPoints.get(id)
    if (cached !== undefined) return cached
    const side = id === 'handL' ? 'Left' : 'Right'
    const rest = this.restFrames[side]
    const probes = this.host.effectorVolumeVerts(id)
    const posed = this.host.applyPose(this.zeroJoints(), this.targets.root, probes)
    const wrist = this.host.boneAt(`mixamorig${side}Hand`)
    const all: THREE.Vector3[] = []
    for (let k = 0; k < probes.length; k++) {
      const rel = new THREE.Vector3(
        posed[k * 3] - wrist.x,
        posed[k * 3 + 1] - wrist.y,
        posed[k * 3 + 2] - wrist.z,
      )
      all.push(new THREE.Vector3(rel.dot(rest.forward), rel.dot(rest.normal), rel.dot(rest.side)))
    }
    // 支撑点：26 个方向上的极值顶点（去重）
    const dirs: THREE.Vector3[] = []
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      dirs.push(new THREE.Vector3(x, y, z).normalize())
    }
    const picked = new Map<string, THREE.Vector3>()
    for (const d of dirs) {
      let best = all[0]
      let bestD = -Infinity
      for (const v of all) {
        const dot = v.dot(d)
        if (dot > bestD) { bestD = dot; best = v }
      }
      picked.set(`${best.x.toFixed(4)},${best.y.toFixed(4)},${best.z.toFixed(4)}`, best)
    }
    const out = Array.from(picked.values())
    this.localPoints.set(id, out)
    return out
  }

  /**
   * 按意图手系定向后的体积采样偏移（相对腕，世界方向）。
   *
   * @param forward 指尖方向（手轴）
   * @param normal 掌心法向
   */
  private orientedOffsets(
    id: EndEffectorId,
    forward: THREE.Vector3,
    normal: THREE.Vector3,
  ): THREE.Vector3[] {
    const local = this.handVolumeLocal(id)
    if (local === null) return this.volumeSamples(id)
    const f = forward.clone().normalize()
    const n = normal.clone().addScaledVector(f, -normal.dot(f))
    if (n.lengthSq() < 1e-12) return this.volumeSamples(id)
    n.normalize()
    const s = new THREE.Vector3().crossVectors(f, n).normalize()
    const out: THREE.Vector3[] = []
    for (let i = 0; i < local.length / 3; i++) {
      out.push(
        f.clone().multiplyScalar(local[i * 3])
          .addScaledVector(n, local[i * 3 + 1])
          .addScaledVector(s, local[i * 3 + 2]),
      )
    }
    return out
  }

  /** 外力积分 + 预测：重力 + 连回目标的弹簧 + 阻尼。 */
  private integrate(): void {
    for (const p of this.particles.values()) {
      p.prev.copy(p.pos)
      const c = dampingCoefficient(p.stiffness, p.mass, this.cfg.dampingRatio)
      const acc = tmpA.copy(p.goal).sub(p.pos).multiplyScalar(p.stiffness / p.mass)
      acc.addScaledVector(p.vel, -c / p.mass)
      acc.y -= this.cfg.gravity
      p.vel.addScaledVector(acc, this.cfg.dt)
      p.pos.addScaledVector(p.vel, this.cfg.dt)
    }
  }

  /**
   * 速度更新（PBD：位置修正后的速度反推）+ 落定判据。
   *
   * 落定看**关节**不看粒子（2026-11-18 改）：IK 跟踪的是已投影的目标（稳定），
   * 关节不再随粒子动；粒子仍被接触约束推挤（每子步恒定位移 → 恒定速度），
   * 拿粒子速度判落定会永远差一点。渲染的是关节 —— 关节稳定 = 视觉已稳定 ✓
   * （且关节冻结 → 探针/采样/锚点全部冻结 → 目标也冻结，全链路收敛 ✓）。
   */
  private updateVelocities(): void {
    let maxSpeed = 0
    for (const p of this.particles.values()) {
      p.vel.copy(p.pos).sub(p.prev).divideScalar(this.cfg.dt)
      maxSpeed = Math.max(maxSpeed, p.vel.length())
    }
    let maxJointDelta = 0
    for (const [j, r] of Object.entries(this.currentJoints)) {
      const prev = this.prevJoints[j]
      if (prev === undefined) { maxJointDelta = Infinity; break }
      const d = Math.max(Math.abs(r.x - prev.x), Math.abs(r.y - prev.y), Math.abs(r.z - prev.z))
      if (d > maxJointDelta) maxJointDelta = d
    }
    this.prevJoints = JSON.parse(JSON.stringify(this.currentJoints)) as JointRotations
    this.isSettled = maxJointDelta < this.cfg.settleJointDelta
  }

  /** 接触约束：身体接触（推离 + 摩擦）+ 地面接触。 */
  private applyContacts(): void {
    const positions = this.probePositions
    if (positions === null) return
    const segments = this.host.segments()
    for (const p of this.particles.values()) {
      const range = this.probeRanges.get(p.id)
      if (range === undefined) continue
      let deepest = 0
      let outward: THREE.Vector3 | null = null
      // 自碰撞排除：脚不与**同侧**腿的体段碰撞（脚跟探针就在踝附近，会被判成陷进小腿
      //   → 接触求解把脚持续往外推 → 脚漂走 8cm，实测）。
      //   异侧的腿与躯干照常参与 ✓（脚碰另一条腿要挡 ✓）。
      const side = p.id === 'footL' || p.id === 'handL' ? 'Left' : 'Right'
      const skipOwnLeg = p.id === 'footL' || p.id === 'footR'
      for (let k = range.start; k < range.start + range.count; k++) {
        const wp = tmpB.set(positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2])
        for (const seg of segments) {
          if (skipOwnLeg && seg.name.startsWith(side === 'Left' ? 'left' : 'right')) continue
          const d = seg.distance(wp)
          if (d < deepest) {
            deepest = d
            outward = seg.probe(wp)?.outward ?? null
          }
        }
      }
      if (deepest < 0 && outward !== null) {
        // 位置修正：沿外推方向补回陷入的量
        p.pos.addScaledVector(outward, -deepest)
        // 摩擦：切向**位移**衰减（PBD 的做法；速度由 updateVelocities 反推，
        // 直接改速度会被随后的速度更新覆盖掉）
        const disp = tmpA.copy(p.pos).sub(p.prev)
        const dn = disp.dot(outward)
        const tangential = disp.addScaledVector(outward, -dn)
        p.pos.addScaledVector(tangential, -p.friction)
        // 去掉朝身体方向的位移分量（只留切向）：否则弹簧每步把手往里拉、
        // 接触每步往外推，两股力顶着抖 → 速度永远不归零（求解器不落定）。
        // 做法：把上一子步的位置挪到「只保留切向位移」的地方，
        // 于是由位置反推出来的速度就没有朝内的分量了 ✓。
        const disp2 = tmpC.copy(p.pos).sub(p.prev)
        const inward = disp2.dot(outward)
        if (inward < 0) {
          disp2.addScaledVector(outward, -inward)
          p.prev.copy(p.pos).sub(disp2)
        }
      }
      if (p.id === 'footL' || p.id === 'footR') {
        // 地面接触按**脚掌探针的最低点**算：踝离地有高度（踝高），
        // 直接拿踝比地面会把脚踩进地里。
        let minY = Infinity
        for (let k = range.start; k < range.start + range.count; k++) {
          minY = Math.min(minY, positions[k * 3 + 1])
        }
        if (Number.isFinite(minY) && minY < this.cfg.groundY) {
          p.pos.y += this.cfg.groundY - minY
          if (p.vel.y < 0) p.vel.y = 0
        }
      }
    }
  }

  /** IK：粒子的落定位置 → 关节角（肩肘腕 / 髋膝踝 / 脊柱朝向）。 */
  private solveIk(): void {
    const joints = this.currentJoints
    const binding = this.host.binding
    const zSign = binding.zSign

    for (const side of ['Left', 'Right'] as const) {
      const p = this.particles.get(side === 'Left' ? 'handL' : 'handR')
      if (p === undefined) continue
      const sJoint = side === 'Left' ? 'shoulderL' : 'shoulderR'
      const eJoint = side === 'Left' ? 'elbowL' : 'elbowR'
      const wJoint = side === 'Left' ? 'wristL' : 'wristR'
      const upperOffset = binding.restLocal.get(eJoint) as THREE.Vector3
      const foreOffset = binding.restLocal.get(wJoint) as THREE.Vector3
      const shoulderPos = this.host.boneAt(JOINT_BONES[sJoint])
      const parentQuat = this.host.boneParentQuat(JOINT_BONES[sJoint])
      const chain = { shoulderPos, parentQuat, upperOffset, foreOffset }
      // IK 目标跟踪**已投影的目标**（p.goal），不跟踪粒子位置：
      // 粒子被接触约束推挤、每子步在跳，IK 跟它 = 与目标投影形成反馈环 → 震荡不落定
      // （实测腹部场景落定=否）。目标本身已做「可达 ∩ 体外」，跟踪它是稳定且合法的 ✓；
      // 粒子的惯性表现（拖动滞后）由物理层保留，关节走稳定的目标 ✓。
      let target = clampToReach(shoulderPos, p.goal, upperOffset.length(), foreOffset.length(), JOINT_LIMITS.elbowFlexMaxDeg)
      // 肘的朝向：候选里挑一个离躯干/腿最空的（提示只作偏好，不作命令 ✓）
      // ⚠ 锚定到体段的手另有一条物理规则：**前臂与手掌同向**（腕伸直）✓
      const anchored = this.targets.effectors[side === 'Left' ? 'handL' : 'handR']?.anchor !== undefined
      const align = anchored ? p.forward : null
      let pole = this.chooseArmPole(side, chain, target, p.poleHint, align)
      let ik: TwoBoneSolution = solveTwoBone(chain, target, pole)
      // 手臂要穿过身体时把目标收回来 / 拐到同侧：真实的手臂会「撞到胸口就滑不动」✓
      // （不处理的话 IK 只能让上臂从躯干里穿过去 —— 实测插进胸口 112mm）。
      // 两段兜底，先试哪个能解开：
      //   ① 收回（沿肩→目标方向缩短）：目标太远横跨身体时，缩短后肘有摆动空间，
      //      配合 pole 能绕开；
      //   ② 方向扫掠（绕竖直轴向肩侧转）：方向本身穿过胸腔时（跨中线够东西），
      //      缩短救不了（射线整条在体内），必须把方向拐回来 —— 这就是「手沿胸口
      //      滑到能滑到的最远处」的物理行为 ✓。
      // 触发用施密特触发器（见 armShrunk 的注释）：间隙 < −8mm 进入收回、
      // ≥ 0 退出；边缘擦碰不再每子步翻转 ✓。阈值从 −1.5cm 收紧到 −8mm
      // （2026-11-19 实测）：前臂斜切胸腹角时，链间隙只有 −11mm（代理口径），
      // −1.5cm 的门槛让纠正完全不触发 → 前臂 56mm 插进躯干网格。全部候选
      // 失败时保持原目标（goal 已是「可达 ∩ 体外」，擦碰比把腕塞进体内好 ✓）。
      const fullClear = this.armClearance(ik, target, shoulderPos)
      const shouldTry = this.armShrunk[side] ? fullClear < 0 : fullClear < -0.008
      if (shouldTry) {
        let resolved = false
        // 代理比网格胖：代理判「刚好不穿」时网格仍可能陷进去十几毫米
        // （实测手拖进腹部：上臂陷躯干网格 19mm，代理判 0）。
        // 所以候选要留**安全余量**（代理外 1.5cm），网格才真不穿 ✓。
        const SAFE = 0.015
        // 无解时退而求其次：取「最不穿」的候选，而不是原样保留（更少穿模 ✓）
        let bestTarget: THREE.Vector3 | null = null
        let bestPole: THREE.Vector3 | null = null
        let bestIk: TwoBoneSolution | null = null
        let bestClear = -Infinity
        const dir = target.clone().sub(shoulderPos)
        for (const t of [0.85, 0.7, 0.55, 0.4]) {
          const shrunk = shoulderPos.clone().addScaledVector(dir, t)
          const candPole = this.chooseArmPole(side, chain, shrunk, p.poleHint)
          const candIk = solveTwoBone(chain, shrunk, candPole)
          const clear = this.armClearance(candIk, shrunk, shoulderPos)
          if (clear > bestClear) {
            bestClear = clear
            bestTarget = shrunk
            bestPole = candPole
            bestIk = candIk
          }
          if (clear >= SAFE) {
            target = shrunk
            pole = candPole
            ik = candIk
            resolved = true
            break
          }
        }
        if (!resolved) {
          const swept = this.sweepTargetToSide(side, shoulderPos, target, p.poleHint, chain)
          if (swept !== null) {
            target = swept.target
            pole = swept.pole
            ik = swept.ik
            resolved = true
          }
        }
        if (!resolved && bestTarget !== null && bestPole !== null && bestIk !== null && bestClear > fullClear) {
          // 收回法解不开时至少退到「最不穿」的候选 ✓
          target = bestTarget
          pole = bestPole
          ik = bestIk
        }
        this.armShrunk[side] = resolved
      } else {
        this.armShrunk[side] = false
      }
      joints[sJoint] = localQuatToPoseEuler(ik.shoulderLocal, zSign)
      joints[eJoint] = localQuatToPoseEuler(ik.elbowLocal, zSign)
      // 腕：始终给一个**确定**的朝向。
      //
      // 为什么不能「没给朝向就摆零位」：腕关节零位 = 保持前臂的静息朝向，于是手
      // 只能跟着前臂乱转 —— 实机截图里手拧成耙子（2026-11-18），而且手指会转进
      // 身体里（实测「手拖过中线」穿插 112mm）。
      //
      // 缺省朝向推导「自然手」：指尖沿前臂方向延伸（腕不折）+ 掌心朝体侧
      //（手臂垂下时掌心贴大腿 ✓）。目标给了 forward/normal 就按它摆 ✓。
      const foreDir = tmpA.subVectors(target, ik.elbowPos).normalize()
      const forward = p.forward !== null ? p.forward.clone() : foreDir.clone()
      const normal = p.normal !== null ? p.normal.clone() : this.inwardPalmDir(shoulderPos, side)
      const flexClamped = clampWristPose(forward, foreDir, normal)
      // 指尖别戳进身体：前臂指向身体时（跨中线够东西 / 手按在体表），指尖沿前臂
      // 方向延伸会插进躯干/腿 —— 实测手插进胸口 62~117mm（2026-11-18）。
      // 修法：把指尖点查一遍碰撞，戳进去就把 forward 沿「朝外」方向旋出（腕背伸，
      // 真实的手按在面上时指尖是顺着面滑的）。总偏角封顶 70°（腕背伸的解剖极限），
      // 残余的穿深由接触约束兜住（比腕折 90° 好看）。
      const fingersOut = this.keepFingersOut(target, flexClamped, normal, side === 'Left' ? 'handL' : 'handR')
      // keepFingersOut 的旋出再夹一次腕屈（2026-11-19 实测 run 右腕 44° > 上限：
      // 旋出方向未必顺着眼前的屈曲面，叠加后能越过 40° 上限 → 视觉上又是耙子）
      const fingersClamped = clampWristPose(fingersOut, foreDir, normal)
      const desired = makeHandFrame(fingersClamped, normal)
      const elbowWorld = parentQuat.clone().multiply(ik.shoulderLocal).multiply(ik.elbowLocal)
      joints[wJoint] = localQuatToPoseEuler(solveHandOrientation(this.restFrames[side], desired, elbowWorld), zSign)
    }

    for (const side of ['Left', 'Right'] as const) {
      const p = this.particles.get(side === 'Left' ? 'footL' : 'footR')
      if (p === undefined) continue
      const hJoint = side === 'Left' ? 'hipL' : 'hipR'
      const kJoint = side === 'Left' ? 'kneeL' : 'kneeR'
      const aJoint = side === 'Left' ? 'ankleL' : 'ankleR'
      const upperOffset = binding.restLocal.get(kJoint) as THREE.Vector3
      const foreOffset = binding.restLocal.get(aJoint) as THREE.Vector3
      const hipPos = this.host.boneAt(JOINT_BONES[hJoint])
      const parentQuat = this.host.boneParentQuat(JOINT_BONES[hJoint])
      // 与手臂同理由：IK 跟踪已投影的目标（p.goal），不跟踪被接触推挤的粒子 ✓
      const target = clampToReach(hipPos, p.goal, upperOffset.length(), foreOffset.length(), JOINT_LIMITS.kneeFlexMaxDeg)
      // 膝的 pole：向前（膝盖永远朝前，不会反关节 ✓）
      const ik = solveTwoBone({ shoulderPos: hipPos, parentQuat, upperOffset, foreOffset }, target, tmpC.set(0, 0, 1).normalize())
      joints[hJoint] = localQuatToPoseEuler(ik.shoulderLocal, zSign)
      joints[kJoint] = localQuatToPoseEuler(ik.elbowLocal, zSign)
      const t = this.targets.effectors[side === 'Left' ? 'footL' : 'footR'] as EndEffectorTarget | undefined
      const pitch = THREE.MathUtils.clamp(
        t?.pitchDeg ?? 0,
        -JOINT_LIMITS.ankleDorsiflexMaxDeg,
        JOINT_LIMITS.anklePlantarMaxDeg,
      )
      joints[aJoint] = { x: (pitch * Math.PI) / 180, y: 0, z: 0 }
    }

    // 脊柱：头部目标 → 胸口朝向（按比例分配到 spine / chest / neck）
    if (this.targets.head !== undefined) {
      const pelvis = this.host.boneAt('mixamorigHips')
      const dir = tmpA.set(this.targets.head.x, this.targets.head.y, this.targets.head.z).sub(pelvis).normalize()
      // 与世界竖直的夹角 = 前倾角（正值 = 前倾 ✓，与 poses.ts 的 spine.x 语义一致）
      const pitch = Math.atan2(dir.z, Math.max(1e-6, dir.y))
      const share = 0.4
      joints.spine = { x: pitch * share, y: 0, z: 0 }
      joints.chest = { x: pitch * share, y: 0, z: 0 }
      joints.neck = { x: pitch * (1 - share * 2), y: 0, z: 0 }
    }

    // 应用姿势 → 只蒙皮碰撞探针（碰撞测量用）
    const allProbes: number[] = []
    this.probeRanges.clear()
    for (const [id, p] of this.particles) {
      const idxs = this.host.effectorProbes(id)
      this.probeRanges.set(id, { start: allProbes.length, count: idxs.length })
      allProbes.push(...idxs)
    }
    this.probePositions = this.host.applyPose(joints, this.targets.root, allProbes)
    // 记录「蒙皮那一刻」探针相对**腕/踝骨**的偏移（体积投影 / 指尖修正用）。
    // ⚠ 必须挂在骨上、不能挂在粒子上：IK 解出的腕骨不一定落在粒子位置
    //   （可达域夹取 / 接触推挤都会让两者分开），挂粒子上 offset 整体错位，
    //   采样点变成「上一帧的手的绝对位置」→ 投影判「全在体外」→ 目标回到
    //   体内（实测跨中线场景怎么推都 107mm）✓。
    for (const [id] of this.particles) {
      const range = this.probeRanges.get(id)
      if (range === undefined) continue
      const side = id === 'handL' || id === 'footL' ? 'Left' : 'Right'
      const isHand = id === 'handL' || id === 'handR'
      const anchor = this.host.boneAt(`mixamorig${side}${isHand ? 'Hand' : 'Foot'}`)
      const offsets = new Float32Array(range.count * 3)
      for (let k = 0; k < range.count; k++) {
        const idx = range.start + k
        offsets[k * 3] = this.probePositions[idx * 3] - anchor.x
        offsets[k * 3 + 1] = this.probePositions[idx * 3 + 1] - anchor.y
        offsets[k * 3 + 2] = this.probePositions[idx * 3 + 2] - anchor.z
      }
      this.probeOffsets.set(id, offsets)
    }
  }
}

/** settle() 的返回：关节表 + 是否落定。 */
export interface JointRotationsResult {
  joints: JointRotations
  settled: boolean
}

/**
 * 腕姿态夹回解剖区间：**屈伸**与**偏折**分开夹。
 *
 * 分解方式：把「手轴」在「前臂轴 + 掌心法向」张成的平面里拆成屈伸角
 * （掌屈为正、背伸为负）与偏折角（出平面的分量），各自夹回解剖上限，再重组 ✓。
 *
 * @param forward 手轴方向（期望）
 * @param foreDir 前臂轴方向（肘→腕）
 * @param palmNormal 掌心法向（定屈伸平面；缺省则退化成夹总夹角）
 */
export function clampWristPose(
  forward: THREE.Vector3,
  foreDir: THREE.Vector3,
  palmNormal: THREE.Vector3 | null,
): THREE.Vector3 {
  const f = forward.clone().normalize()
  const fd = foreDir.clone().normalize()
  if (palmNormal === null) {
    // 退化口径（没有掌法向）：夹总夹角
    const ang = Math.acos(THREE.MathUtils.clamp(f.dot(fd), -1, 1))
    const maxRad = (WRIST_LIMITS.flexionMaxDeg * Math.PI) / 180
    if (ang <= maxRad) return f
    const axis = new THREE.Vector3().crossVectors(fd, f)
    if (axis.lengthSq() < 1e-10) return f
    axis.normalize()
    return f.applyAxisAngle(axis, -(ang - maxRad))
  }
  // 屈伸方向 = 掌心法向在前臂轴的垂分量（掌屈 = 手轴转向掌心那一侧）
  const flexDir = palmNormal.clone().addScaledVector(fd, -palmNormal.dot(fd))
  if (flexDir.lengthSq() < 1e-10) return f
  flexDir.normalize()
  const planeN = new THREE.Vector3().crossVectors(fd, flexDir).normalize()
  const a = f.dot(fd)
  const b = f.dot(flexDir)
  const c = f.dot(planeN)
  const radial = Math.hypot(a, b)
  // 屈伸角：>0 掌屈、<0 背伸（在屈伸平面内的仰角）；偏折角：出手平面的分量
  const flex = THREE.MathUtils.clamp(
    Math.atan2(b, a),
    -(WRIST_LIMITS.extensionMaxDeg * Math.PI) / 180,
    (WRIST_LIMITS.flexionMaxDeg * Math.PI) / 180,
  )
  const dev = THREE.MathUtils.clamp(
    Math.atan2(c, radial),
    -(WRIST_LIMITS.deviationMaxDeg * Math.PI) / 180,
    (WRIST_LIMITS.deviationMaxDeg * Math.PI) / 180,
  )
  const cosFlex = Math.cos(flex)
  return new THREE.Vector3()
    .addScaledVector(fd, cosFlex * Math.cos(dev))
    .addScaledVector(flexDir, Math.sin(flex) * Math.cos(dev))
    .addScaledVector(planeN, Math.sin(dev))
    .normalize()
}

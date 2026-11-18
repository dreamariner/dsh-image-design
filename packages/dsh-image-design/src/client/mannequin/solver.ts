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

const POLE_CANDIDATES: readonly { key: string; dir: [number, number, number] }[] = [
  { key: 'back', dir: [0.25, -0.15, -1] },
  { key: 'out', dir: [1, -0.15, -0.3] },
  { key: 'backOut', dir: [0.75, -0.2, -0.75] },
  { key: 'up', dir: [0.3, 0.9, -0.4] },
]

/** 关节限位（解剖范围）：超限的目标被夹回可达域，而不是报错。 */
export const JOINT_LIMITS = {
  /** 肘屈曲上限（度）：过伸超过 5° 就是反关节。 */
  elbowFlexMaxDeg: 150,
  /** 膝屈曲上限（度）：跪坐要折到 147° 左右（脚跟贴臀），135° 会让小腿折不下去。 */
  kneeFlexMaxDeg: 155,
  /** 踝跖屈上限（度）。 */
  anklePlantarMaxDeg: 60,
  /** 踝背屈上限（度）。 */
  ankleDorsiflexMaxDeg: 45,
}

interface Particle {
  id: EndEffectorId
  pos: THREE.Vector3
  /** 上一子步的位置（速度反推用）。 */
  prev: THREE.Vector3
  vel: THREE.Vector3
  goal: THREE.Vector3
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
  /** 是否已做过首次 setTargets（决定要不要规范复位）。 */
  private initialized = false
  /** 探针顶点的蒙皮后位置（按探针顺序，xyz 连续）。 */
  private probePositions: Float32Array | null = null
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
        goal: g.pos.clone(),
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
    if (g.forward !== null) p.forward = g.forward.clone()
    if (g.normal !== null) p.normal = g.normal.clone()
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
      const forward = t.forward !== undefined
        ? new THREE.Vector3(t.forward.x, t.forward.y, t.forward.z).normalize()
        : axis.clone()
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
   * 挑肘的朝向：候选逐个解 IK，用「肘 + 前臂中点离躯干/腿的间隙」评分。
   *
   * 提示（poleHint）只给偏好分，不强制 —— 提示与身体冲突时物理优先 ✓。
   */
  private chooseArmPole(
    side: 'Left' | 'Right',
    chain: { shoulderPos: THREE.Vector3; parentQuat: THREE.Quaternion; upperOffset: THREE.Vector3; foreOffset: THREE.Vector3 },
    target: THREE.Vector3,
    hint: 'back' | 'out' | 'up',
  ): THREE.Vector3 {
    const lateral = side === 'Left' ? 1 : -1
    const segments = this.host.segments()
    const current = this.poleChoice[side]
    const scoreOf = (pole: THREE.Vector3): number => {
      const ik = solveTwoBone(chain, target, pole)
      const foreMid = ik.elbowPos.clone().add(target).multiplyScalar(0.5)
      let clearance = Infinity
      for (const p of [ik.elbowPos, foreMid]) {
        for (const seg of segments) {
          const d = seg.distance(p)
          if (d < clearance) clearance = d
        }
      }
      return clearance
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

  /** 语义锚点随体段移动 → 每子步刷新一次目标（体段的轴随姿势变 ✓）。 */
  private refreshGoals(): void {
    for (const [id, p] of this.particles) {
      const t = this.targets.effectors[id]
      if (t === undefined) continue
      const g = this.resolveGoal(id, t)
      if (g === null) continue
      const goal = g.pos.clone()
      this.projectOutOfBody(goal)
      p.goal.copy(goal)
      if (g.forward !== null) p.forward = g.forward.clone()
      if (g.normal !== null) p.normal = g.normal.clone()
    }
  }

  /**
   * 把目标点投影到体外：意图落在身体内部（拖进大腿里）时，不是报错也不是硬塞 ——
   * 而是**投影到表面**（和可达域夹取同一套思路：越界的意图被夹住，不被拒绝）。
   *
   * 不做这一步的后果：弹簧每步往里拉、接触每步往外推，两股力顶着抖，
   * 速度永远不归零（求解器不落定，实测 |v|≈1.2m/s 的极限环）。
   */
  private projectOutOfBody(p: THREE.Vector3): void {
    const segments = this.host.segments()
    for (const seg of segments) {
      const d = seg.distance(p)
      if (d >= 0) continue
      const pr = seg.probe(p)
      if (pr === null) continue
      // 推到表面**外侧 1cm**：正好贴面的话接触每步都在临界触发，
      // 推出方向又随位置摆动 → 目标点乱抖 → 求解发散。
      p.addScaledVector(pr.outward, -d + 0.01)
    }
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

  /** 速度更新（PBD：位置修正后的速度反推）。 */
  private updateVelocities(): void {
    let maxSpeed = 0
    for (const p of this.particles.values()) {
      p.vel.copy(p.pos).sub(p.prev).divideScalar(this.cfg.dt)
      maxSpeed = Math.max(maxSpeed, p.vel.length())
    }
    this.isSettled = maxSpeed < this.cfg.settleVelocity
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
      const target = clampToReach(shoulderPos, p.pos, upperOffset.length(), foreOffset.length(), JOINT_LIMITS.elbowFlexMaxDeg)
      // 肘的朝向：候选里挑一个离躯干/腿最空的（提示只作偏好，不作命令 ✓）
      const pole = this.chooseArmPole(
        side, { shoulderPos, parentQuat, upperOffset, foreOffset }, target, p.poleHint,
      )
      const ik: TwoBoneSolution = solveTwoBone(
        { shoulderPos, parentQuat, upperOffset, foreOffset },
        target,
        pole,
      )
      joints[sJoint] = localQuatToPoseEuler(ik.shoulderLocal, zSign)
      joints[eJoint] = localQuatToPoseEuler(ik.elbowLocal, zSign)
      // 腕：按目标朝向摆掌心（forward 指尖方向 + normal 掌心法向）
      // 朝向来自粒子（锚点推导或目标显式给出）；都没给 → 保持静息朝向 ✓
      if (p.forward !== null || p.normal !== null) {
        const forward = p.forward ?? this.restFrames[side].forward
        const normal = p.normal ?? this.restFrames[side].normal
        const desired = makeHandFrame(forward, normal)
        const elbowWorld = parentQuat.clone().multiply(ik.shoulderLocal).multiply(ik.elbowLocal)
        joints[wJoint] = localQuatToPoseEuler(solveHandOrientation(this.restFrames[side], desired, elbowWorld), zSign)
      } else {
        joints[wJoint] = { x: 0, y: 0, z: 0 }
      }
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
      const target = clampToReach(hipPos, p.pos, upperOffset.length(), foreOffset.length(), JOINT_LIMITS.kneeFlexMaxDeg)
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
  }
}

/** settle() 的返回：关节表 + 是否落定。 */
export interface JointRotationsResult {
  joints: JointRotations
  settled: boolean
}

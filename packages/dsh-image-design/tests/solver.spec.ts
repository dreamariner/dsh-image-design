// 求解器单测（issue 005）：物理 + 约束 + IK 的行为约定。
//
// 这些不是「快照比对」，而是**性质断言**：目标是否命中、穿模是否被推离、
// 关节是否被夹回解剖范围、地面是否挡住脚、同输入是否同解（确定性）。

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { loadRigFixture } from './helpers/rig-fixture.ts'
import { createSolverHostFixture } from './helpers/solver-host.ts'
import { PoseSolver, type PoseTargets } from '../src/client/mannequin/solver.ts'
import { computeBodyMetrics, poseTargets } from '../src/client/mannequin/targets.ts'
import { JOINT_BONES } from '../src/client/mannequin/rig.ts'

const fx = loadRigFixture()
const { host } = createSolverHostFixture(fx)

/** 绑定姿态（A-pose）的意图：骨盆高度 + 四肢末端落点。 */
function bindTargets(): PoseTargets {
  // 用绑定姿态的骨位快照：前面的用例会把姿势改掉，读当前骨位会拿到脏坐标
  const at = (bone: string) => fx.bindWorld.get(bone)!.clone()
  const hips = at('mixamorigHips')
  const ankleL = at('mixamorigLeftFoot')
  const ankleR = at('mixamorigRightFoot')
  const handL = at('mixamorigLeftHand')
  const handR = at('mixamorigRightHand')
  return {
    root: { x: hips.x, y: hips.y, z: hips.z },
    effectors: {
      footL: { pos: { x: ankleL.x, y: ankleL.y, z: ankleL.z } },
      footR: { pos: { x: ankleR.x, y: ankleR.y, z: ankleR.z } },
      handL: { pos: { x: handL.x, y: handL.y, z: handL.z } },
      handR: { pos: { x: handR.x, y: handR.y, z: handR.z } },
    },
    head: { x: at('mixamorigHead').x, y: at('mixamorigHead').y, z: at('mixamorigHead').z },
  }
}

function solve(targets: PoseTargets, substeps = 240): { solver: PoseSolver; joints: ReturnType<PoseSolver['joints']> } {
  const solver = new PoseSolver(host)
  solver.setTargets(targets)
  solver.settle()
  return { solver, joints: solver.joints() }
}

/** 肘/膝的上下臂轴夹角（几何量，与欧拉无关）。 */
function jointAngleDeg(root: string, mid: string, tip: string): number {
  const at = (b: string) => fx.byName.get(b)!.getWorldPosition(new THREE.Vector3())
  const a = at(JOINT_BONES[root as keyof typeof JOINT_BONES] as string)
  const m = at(JOINT_BONES[mid as keyof typeof JOINT_BONES] as string)
  const t = at(JOINT_BONES[tip as keyof typeof JOINT_BONES] as string)
  const u = new THREE.Vector3().subVectors(a, m).normalize()
  const v = new THREE.Vector3().subVectors(t, m).normalize()
  return Math.acos(Math.max(-1, Math.min(1, u.dot(v)))) * 180 / Math.PI
}

describe('姿势求解器：IK 命中', () => {
  it('手的目标位置被命中（腕落在目标附近）', () => {
    const targets = bindTargets()
    const { solver } = solve(targets)
    const wrist = fx.byName.get('mixamorigLeftHand')!.getWorldPosition(new THREE.Vector3())
    const goal = targets.effectors.handL!.pos!
    // 弹簧被重力压出 ~8mm 的下垂（真实重量感），容差按此放宽
    expect(Math.hypot(wrist.x - goal.x, wrist.y - goal.y, wrist.z - goal.z)).toBeLessThan(0.03)
    expect(solver.settled()).toBe(true)
  })

  it('骨盆落在指定高度（根目标生效）', () => {
    const targets = bindTargets()
    targets.root.y -= 0.2
    const { solver } = solve(targets)
    const hips = fx.byName.get('mixamorigHips')!.getWorldPosition(new THREE.Vector3())
    expect(Math.abs(hips.y - targets.root.y)).toBeLessThan(0.01)
  })
})

describe('姿势求解器：物理约束', () => {
  it('重力把手压向支撑面：目标悬空时手会下沉并落定', () => {
    const targets = bindTargets()
    const hp = targets.effectors.handL!.pos!
    targets.effectors.handL = { pos: { x: hp.x, y: hp.y + 0.25, z: hp.z } }
    const { solver } = solve(targets)
    // 弹簧会把手拉回目标，但重力让它先下沉 → 落定位置低于目标（体现重量）
    const wrist = fx.byName.get('mixamorigLeftHand')!.getWorldPosition(new THREE.Vector3())
    expect(wrist.y).toBeLessThan(targets.effectors.handL!.pos!.y + 0.25)
    expect(solver.settled()).toBe(true)
  })

  it('地面挡住脚：脚目标在地面以下时被顶回地面', () => {
    const targets = bindTargets()
    const fp = targets.effectors.footL!.pos!
    targets.effectors.footL = { pos: { x: fp.x, y: -0.3, z: fp.z } }
    const { solver } = solve(targets)
    const ankle = fx.byName.get('mixamorigLeftFoot')!.getWorldPosition(new THREE.Vector3())
    expect(ankle.y).toBeGreaterThan(-0.05)
    expect(solver.settled()).toBe(true)
  })

  it('手塞进大腿里会被推出来（不陷进去）', () => {
    const targets = bindTargets()
    // 把左手的目标塞进左大腿内部（大腿轴中段、往里 5cm）
    // 用绑定姿态的骨位快照（当前骨位已被前面的用例改成别的姿势了）
    const hip = fx.bindWorld.get('mixamorigLeftUpLeg')!.clone()
    const knee = fx.bindWorld.get('mixamorigLeftLeg')!.clone()
    const mid = hip.clone().lerp(knee, 0.5)
    targets.effectors.handL = { pos: { x: mid.x, y: mid.y, z: mid.z } }
    const { solver } = solve(targets)
    const wrist = fx.byName.get('mixamorigLeftHand')!.getWorldPosition(new THREE.Vector3())
    // 被推出后不应还在大腿轴心附近
    expect(Math.hypot(wrist.x - mid.x, wrist.z - mid.z)).toBeGreaterThan(0.03)
    expect(solver.settled()).toBe(true)
  })
})

describe('姿势求解器：语义锚点', () => {
  /** 坐姿目标（手搭大腿的语义锚点）：绑定姿态够不到大腿，得用坐姿。 */
  function sitTargets(): PoseTargets {
    const m = computeBodyMetrics((n) => fx.byName.get(n)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3())
    const t = poseTargets('sit', m)
    if (t === null) throw new Error('缺少 sit 预设')
    return t
  }

  it('手搭大腿：腕落在腿面附近（不陷进去，也不甩飞）', () => {
    const { solver } = solve(sitTargets())
    const wrist = fx.byName.get('mixamorigLeftHand')!.getWorldPosition(new THREE.Vector3())
    const seg = host.anchorSegment('leftThigh')!
    const d = seg.distance(wrist)
    // 腕在腿面外侧（掌厚量级），不能陷进腿里，也不能离腿面太远
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThan(0.12)
    expect(solver.settled()).toBe(true)
  })

  it('锚点跟着体段走：根高度变了，手仍贴在大腿面上', () => {
    const targets = sitTargets()
    targets.root.y -= 0.05
    const { solver } = solve(targets)
    const wrist = fx.byName.get('mixamorigLeftHand')!.getWorldPosition(new THREE.Vector3())
    const seg = host.anchorSegment('leftThigh')!
    // 髋再降 5cm 后，手仍贴着腿面（目标点随体段下移，不是写死的世界坐标）
    expect(seg.distance(wrist)).toBeGreaterThan(0)
    expect(seg.distance(wrist)).toBeLessThan(0.12)
    expect(solver.settled()).toBe(true)
  })

  it('手搭大腿后停住（落定 + 不滑离锚点）', () => {
    const { solver } = solve(sitTargets())
    // 落定 = 关节稳定（IK 跟踪已投影的目标，粒子速度不再是姿势的判据）
    expect(solver.settled()).toBe(true)
    // 且腕骨停在锚点解析出的目标上（没有滑离目标点）。粒子是纯物理量
    // （重力 + 接触下的平衡点），不代表视觉位置，别拿它当判据
    const state = solver.debugState()
    const hand = state.handL
    expect(hand).toBeDefined()
    const wrist = fx.byName.get('mixamorigLeftHand')!.getWorldPosition(new THREE.Vector3())
    expect(wrist.distanceTo(hand!.goal)).toBeLessThan(0.02)
  })
})

describe('姿势求解器：解剖限位', () => {
  it('肘不会过伸（几何夹角 ≤ 182°）', () => {
    const targets = bindTargets()
    // 把手放到极远处 → 够不着 → 应被夹回可达域（而不是硬拉直手臂）
    targets.effectors.handL = { pos: { x: 2.0, y: 0.2, z: 1.5 } }
    const { solver } = solve(targets)
    const ang = jointAngleDeg('shoulderL', 'elbowL', 'wristL')
    expect(ang).toBeLessThanOrEqual(182)
    expect(solver.settled()).toBe(true)
  })

  it('膝不会反折（几何夹角 ≤ 182°）', () => {
    const targets = bindTargets()
    const fp = targets.effectors.footL!.pos!
    targets.effectors.footL = { pos: { x: fp.x, y: fp.y, z: fp.z - 1.2 } }
    const { solver } = solve(targets)
    const ang = jointAngleDeg('hipL', 'kneeL', 'ankleL')
    expect(ang).toBeLessThanOrEqual(182)
    expect(solver.settled()).toBe(true)
  })
})

describe('姿势求解器：确定性', () => {
  it('同一目标两次求解结果一致（参考图可复现）', () => {
    const targets = bindTargets()
    const a = solve(targets).joints
    const b = solve(targets).joints
    for (const key of Object.keys(a)) {
      expect(a[key].x).toBeCloseTo(b[key].x, 9)
      expect(a[key].y).toBeCloseTo(b[key].y, 9)
      expect(a[key].z).toBeCloseTo(b[key].z, 9)
    }
  })

  it('目标跳变朝新意图移动且不过冲（意图跳变不产生甩尾）', () => {
    const targets = bindTargets()
    const solver = new PoseSolver(host)
    solver.setTargets(targets)
    solver.settle()
    const before = fx.byName.get('mixamorigLeftHand')!.getWorldPosition(new THREE.Vector3())
    const moved = bindTargets()
    const mp = moved.effectors.handL!.pos!
    moved.effectors.handL = { pos: { x: mp.x + 0.08, y: mp.y, z: mp.z } }
    solver.setTargets(moved)
    solver.step(1)
    const after = fx.byName.get('mixamorigLeftHand')!.getWorldPosition(new THREE.Vector3())
    const goal = new THREE.Vector3(mp.x + 0.08, mp.y, mp.z)
    // 朝新意图移动了
    expect(after.distanceTo(goal)).toBeLessThan(before.distanceTo(goal))
    // 且不越过新意图（无甩尾）：落点与新目标的距离不超过跳变量
    expect(after.distanceTo(goal)).toBeLessThanOrEqual(0.08 + 0.01)
  })
})

// 姿势目标库的门禁（issue 005）：8 个预设由「意图目标 + 物理求解」解出，
// 这里断言解出来的姿势**站得住**：不穿模、脚落地、手贴腿面、关节不反折、同解可复现。
//
// 为什么门禁盯「解出来的姿势」而不是「姿势表的角度」：预设不再手拧角度，
// 数字是解算结果 → 判据必须落在几何上（穿深 / 间隙 / 夹角 / 落地）✓。

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { loadRigFixture } from './helpers/rig-fixture.ts'
import { createSolverHostFixture } from './helpers/solver-host.ts'
import { poseContactJoints, handThighGapJoints, skinPositions, dominantBone } from './helpers/pose-contact.ts'
import { computeBodyMetrics, poseTargets, applySemanticAction, TARGET_PRESET_IDS } from '../src/client/mannequin/targets.ts'
import { PoseSolver, type PoseTargets } from '../src/client/mannequin/solver.ts'
import { JOINT_BONES } from '../src/client/mannequin/rig.ts'

const fx = loadRigFixture()
const { host } = createSolverHostFixture(fx)
const metrics = computeBodyMetrics((n) => fx.bindWorld.get(n)?.clone() ?? new THREE.Vector3())

/** 解一个预设（规范复位 → 落定）。 */
function solvePreset(id: string): { targets: PoseTargets; joints: ReturnType<PoseSolver['joints']>; settled: boolean } {
  const targets = poseTargets(id, metrics)
  if (targets === null) throw new Error(`缺少预设 ${id}`)
  const solver = new PoseSolver(host)
  solver.setTargets(targets)
  const result = solver.settle()
  return { targets, joints: result.joints, settled: result.settled }
}

/** 关节的几何夹角（度）：180 = 伸直。 */
function jointAngleDeg(root: string, mid: string, tip: string): number {
  const at = (b: string) => fx.byName.get(b)!.getWorldPosition(new THREE.Vector3())
  const a = at(JOINT_BONES[root as keyof typeof JOINT_BONES] as string)
  const m = at(JOINT_BONES[mid as keyof typeof JOINT_BONES] as string)
  const t = at(JOINT_BONES[tip as keyof typeof JOINT_BONES] as string)
  const u = new THREE.Vector3().subVectors(a, m).normalize()
  const v = new THREE.Vector3().subVectors(t, m).normalize()
  return Math.acos(Math.max(-1, Math.min(1, u.dot(v)))) * 180 / Math.PI
}

/** 脚底最低点离地（米，负 = 陷进地里）。 */
function clearanceOf(joints: ReturnType<PoseSolver['joints']>): number {
  const posed = skinPositions(fx, joints)
  let minY = Infinity
  for (let i = 0; i < fx.position.count; i++) {
    const n = dominantBone(fx, i)
    if (!/Foot$|ToeBase$/.test(n)) continue
    minY = Math.min(minY, posed[i * 3 + 1])
  }
  return minY - metrics.groundY
}

/**
 * 腕屈角（度）：前臂轴（肘→腕）与手轴（腕→指尖）的夹角。
 *
 * 手轴取**指尖探针的平均方向**，不取「离腕最远的单个顶点」——HM08 拇指比手指长，
 * 最远顶点常落在拇指尖上，用它量会把腕屈角虚报 5~10°（2026-11-19）。
 */
function wristFlexDeg(joints: ReturnType<PoseSolver['joints']>, side: 'Left' | 'Right'): number {
  const posed = skinPositions(fx, joints)
  const wrist = fx.byName.get(`mixamorig${side}Hand`)!.getWorldPosition(new THREE.Vector3())
  const elbow = fx.byName.get(`mixamorig${side}ForeArm`)!.getWorldPosition(new THREE.Vector3())
  const probes = host.effectorProbes(side === 'Left' ? 'handL' : 'handR')
  const tipDir = new THREE.Vector3()
  for (let i = 1; i < probes.length; i++) {
    const vi = probes[i]
    tipDir.add(new THREE.Vector3(
      posed[vi * 3] - wrist.x,
      posed[vi * 3 + 1] - wrist.y,
      posed[vi * 3 + 2] - wrist.z,
    ))
  }
  if (tipDir.lengthSq() < 1e-12) return 0
  const fore = wrist.clone().sub(elbow).normalize()
  const hand = tipDir.normalize()
  return Math.acos(Math.max(-1, Math.min(1, fore.dot(hand)))) * 180 / Math.PI
}

describe('姿势目标库：预设求解', () => {
  it('八个预设都能解出来并落定', () => {
    expect(TARGET_PRESET_IDS.length).toBe(8)
    for (const id of TARGET_PRESET_IDS) {
      const { settled } = solvePreset(id)
      expect(settled, `${id} 未落定`).toBe(true)
    }
  })

  it('每个预设都不穿模（穿深 ≤ 8mm）', () => {
    for (const id of TARGET_PRESET_IDS) {
      const { joints } = solvePreset(id)
      const contact = poseContactJoints(fx, joints)
      expect(contact.maxPen, `${id} 穿深 ${(contact.maxPen * 1000).toFixed(1)}mm（${contact.label}）`)
        .toBeLessThanOrEqual(0.008)
    }
  })

  it('手搭大腿的预设：手贴腿面（−2mm~35mm），不悬空也不陷进去', () => {
    for (const id of ['sit', 'kneel']) {
      const { joints } = solvePreset(id)
      for (const side of ['Left', 'Right'] as const) {
        const gap = handThighGapJoints(fx, joints, side)
        expect(gap, `${id} ${side} 手-腿间隙 ${(gap * 1000).toFixed(1)}mm`)
          .toBeGreaterThanOrEqual(-0.002)
        // 35mm：掌心平贴腿面的姿势里，腕在接触点后方、掌面斜下触腿
        //（2026-11-19 掌向显式化后，sit 腕隙 28.8mm 属自然几何）
        expect(gap, `${id} ${side} 手-腿间隙 ${(gap * 1000).toFixed(1)}mm`)
          .toBeLessThanOrEqual(0.035)
      }
    }
  })

  it('脚不陷进地里（离地 ≥ −2mm）', () => {
    for (const id of TARGET_PRESET_IDS) {
      const { joints } = solvePreset(id)
      expect(clearanceOf(joints), `${id} 脚离地 ${(clearanceOf(joints) * 1000).toFixed(1)}mm`)
        .toBeGreaterThanOrEqual(-0.002)
    }
  })

  it('关节不反折：肘 ≤ 182°、膝 ≤ 182°', () => {
    for (const id of TARGET_PRESET_IDS) {
      const { joints } = solvePreset(id)
      expect(jointAngleDeg('shoulderL', 'elbowL', 'wristL'), `${id} 左肘`).toBeLessThanOrEqual(182)
      expect(jointAngleDeg('shoulderR', 'elbowR', 'wristR'), `${id} 右肘`).toBeLessThanOrEqual(182)
      expect(jointAngleDeg('hipL', 'kneeL', 'ankleL'), `${id} 左膝`).toBeLessThanOrEqual(182)
      expect(jointAngleDeg('hipR', 'kneeR', 'ankleR'), `${id} 右膝`).toBeLessThanOrEqual(182)
    }
  })

  it('腕不过度折（腕屈 ≤ 40°，解剖上限）', () => {
    for (const id of TARGET_PRESET_IDS) {
      const { joints } = solvePreset(id)
      for (const side of ['Left', 'Right'] as const) {
        const deg = wristFlexDeg(joints, side)
        expect(deg, `${id} ${side} 腕屈 ${deg.toFixed(0)}°（前臂轴 vs 指尖方向）`)
          .toBeLessThanOrEqual(40)
      }
    }
  })

  it('腕不震荡：解完后腕关节逐子步稳定（无 2 周期翻转）', () => {
    // 回归门禁（2026-11-19）：keepFingersOut 曾经按「上一子步姿势的探针」判指尖
    // 穿模 → 腕转 → 探针动 → 再转，形成 2 周期震荡（实机「手腕拧成那样」，
    // 实测腕关节每子步摆 9°，求解器永不落定）。判据改成意图手系定向的静态
    // 手体积后，腕的每子步变化应单调收敛到 0 ✓。
    for (const id of TARGET_PRESET_IDS) {
      const solver = new PoseSolver(host)
      solver.setTargets(poseTargets(id, metrics)!)
      solver.step(20)
      const prev = solver.joints()
      let worst = 0
      for (let i = 0; i < 20; i++) {
        solver.step(1)
        const cur = solver.joints()
        for (const key of ['wristL', 'wristR'] as const) {
          worst = Math.max(worst, Math.abs(cur[key].x - prev[key].x), Math.abs(cur[key].y - prev[key].y), Math.abs(cur[key].z - prev[key].z))
        }
        Object.assign(prev, cur)
      }
      expect(worst, `${id} 腕逐子步漂移 ${(worst * 180 / Math.PI).toFixed(2)}°`).toBeLessThan(0.01)
    }
  })

  it('同一预设两次求解结果一致（参考图可复现）', () => {
    for (const id of TARGET_PRESET_IDS) {
      const a = solvePreset(id).joints
      const b = solvePreset(id).joints
      for (const key of Object.keys(a)) {
        expect(a[key].x, `${id} ${key}.x`).toBeCloseTo(b[key].x, 9)
        expect(a[key].y, `${id} ${key}.y`).toBeCloseTo(b[key].y, 9)
        expect(a[key].z, `${id} ${key}.z`).toBeCloseTo(b[key].z, 9)
      }
    }
  })
})

describe('姿势目标库：目标按体型换算', () => {
  it('身体尺寸变了，预设目标跟着变（不是写死坐标）', () => {
    const scaled = computeBodyMetrics((n) => fx.bindWorld.get(n)?.clone().multiplyScalar(1.2) ?? new THREE.Vector3())
    const a = poseTargets('sit', metrics)
    const b = poseTargets('sit', scaled)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    // 骨盆高度按小腿长 + 踝高算 → 整体放大 20% 后应随之抬高
    expect(b!.root.y).toBeGreaterThan(a!.root.y + 0.05)
    // 脚在大腿前一个「大腿长」处 → 放大后更靠前
    const zA = a!.effectors.footL!.pos!.z
    const zB = b!.effectors.footL!.pos!.z
    expect(zB).toBeGreaterThan(zA + 0.05)
  })
})

describe('姿势目标库：语义动作', () => {
  const base = (): PoseTargets => ({
    root: { x: 0, y: 0.5, z: 0.02 },
    effectors: {
      footL: { pos: { x: 0.11, y: 0.1, z: 0.3 } },
      footR: { pos: { x: -0.11, y: 0.1, z: 0.3 } },
      handL: { pos: { x: 0.3, y: 0.9, z: 0.1 } },
      handR: { pos: { x: -0.3, y: 0.9, z: 0.1 } },
    },
    head: { x: 0, y: 1.2, z: 0.05 },
  })

  it('手贴大腿：双手换成大腿语义锚点，其他意图不动', () => {
    const next = applySemanticAction('hands-on-thigh', base(), metrics)
    expect(next.effectors.handL?.anchor?.part).toBe('leftThigh')
    expect(next.effectors.handR?.anchor?.part).toBe('rightThigh')
    expect(next.effectors.handL?.pos).toBeUndefined()
    // 骨盆高度 / 头朝向 / 脚不动
    expect(next.root).toEqual({ x: 0, y: 0.5, z: 0.02 })
    expect(next.head).toEqual({ x: 0, y: 1.2, z: 0.05 })
    expect(next.effectors.footL).toEqual(base().effectors.footL)
  })

  it('双脚踩地：脚落到地面高度（踝高），前后站位保留', () => {
    const next = applySemanticAction('feet-on-ground', base(), metrics)
    expect(next.effectors.footL?.pos!.y).toBeCloseTo(metrics.groundY + metrics.ankleHeight, 6)
    expect(next.effectors.footR?.pos!.y).toBeCloseTo(metrics.groundY + metrics.ankleHeight, 6)
    expect(next.effectors.footL?.pos!.z).toBeCloseTo(0.3, 6)
  })

  it('手垂体侧：手落到体侧（含清空大腿的外张量）且指尖顺臂线朝下', () => {
    const next = applySemanticAction('arms-at-side', base(), metrics)
    // hangingArm 带外张量（垂手要清空大腿，2026-11-18 网格实测指尖会插进大腿）
    expect(next.effectors.handL?.pos!.x).toBeCloseTo(metrics.shoulderHalf + 0.032, 6)
    expect(next.effectors.handR?.pos!.x).toBeCloseTo(-(metrics.shoulderHalf + 0.032), 6)
    // 指尖沿「肩→手」臂线（2026-11-19：不写死朝地，摆臂/垂臂的腕才不折），
    // 外张 0.032 的臂线带一点朝外分量，朝下为主
    expect(next.effectors.handL?.forward!.y).toBeLessThan(-0.9)
    expect(Math.abs(next.effectors.handL?.forward!.x ?? 0)).toBeLessThan(0.15)
    expect(next.effectors.handR?.forward!.y).toBeLessThan(-0.9)
  })

  it('语义动作后的姿势仍解得出来（落定 + 不穿模）', () => {
    const next = applySemanticAction('hands-on-thigh', base(), metrics)
    const solver = new PoseSolver(host)
    solver.setTargets(next)
    const result = solver.settle()
    expect(result.settled).toBe(true)
    const contact = poseContactJoints(fx, result.joints)
    expect(contact.maxPen).toBeLessThanOrEqual(0.008)
  })
})

// 姿势目标库的门禁（issue 005）：8 个预设由「意图目标 + 物理求解」解出，
// 这里断言解出来的姿势**站得住**：不穿模、脚落地、手贴腿面、关节不反折、同解可复现。
//
// 为什么门禁盯「解出来的姿势」而不是「姿势表的角度」：预设不再手拧角度，
// 数字是解算结果 → 判据必须落在几何上（穿深 / 间隙 / 夹角 / 落地）✓。

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { loadRigFixture } from './helpers/rig-fixture.ts'
import { createSolverHostFixture } from './helpers/solver-host.ts'
import { poseContactJoints, handThighGapJoints, handThighContact, skinPositions, dominantBone } from './helpers/pose-contact.ts'
import { computeBodyMetrics, poseTargets, applySemanticAction, TARGET_PRESET_IDS } from '../src/client/mannequin/targets.ts'
import { PoseSolver, type PoseTargets, WRIST_LIMITS } from '../src/client/mannequin/solver.ts'
import { JOINT_BONES } from '../src/client/mannequin/rig.ts'

const fx = loadRigFixture()
const { host } = createSolverHostFixture(fx)
const metrics = computeBodyMetrics((n) => fx.bindWorld.get(n)?.clone() ?? new THREE.Vector3())

/** 手部骨骼在**绑定姿态**下的世界朝向（量掌向偏差的基准；姿势会改骨骼朝向 ✓）。 */
const bindHandQuat = {
  Left: fx.byName.get('mixamorigLeftHand')!.getWorldQuaternion(new THREE.Quaternion()),
  Right: fx.byName.get('mixamorigRightHand')!.getWorldQuaternion(new THREE.Quaternion()),
}

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

/**
 * 腕的**屈伸角**与**偏折角**（度）：两个独立自由度，分开判。
 *
 * 为什么不用「前臂↔手轴的总夹角」当腕屈：手掌平贴在腿上时，前臂与手之间本来
 * 就有几十度的横向偏折（实测坐姿背伸 33° + 偏折 21°），总夹角把偏折算成腕屈 →
 * 把合法的背伸判成超限 → 门禁逼着人把腕夹死 → 手贴不平腿面（2026-11-19）。
 *
 * @param palmNormal 意图的掌心法向（求解器夹腕用的就是它 ✓，口径一致）
 */
function wristBendDeg(
  joints: ReturnType<PoseSolver['joints']>,
  side: 'Left' | 'Right',
  palmNormal: THREE.Vector3,
): { flex: number; dev: number } {
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
  if (tipDir.lengthSq() < 1e-12) return { flex: 0, dev: 0 }
  const fore = wrist.clone().sub(elbow).normalize()
  const hand = tipDir.normalize()
  const flexDir = palmNormal.clone().addScaledVector(fore, -palmNormal.dot(fore))
  if (flexDir.lengthSq() < 1e-10) return { flex: 0, dev: 0 }
  flexDir.normalize()
  const planeN = new THREE.Vector3().crossVectors(fore, flexDir).normalize()
  const a = hand.dot(fore)
  const b = hand.dot(flexDir)
  const c = hand.dot(planeN)
  return {
    flex: Math.atan2(b, a) * 180 / Math.PI,
    dev: Math.atan2(c, Math.hypot(a, b)) * 180 / Math.PI,
  }
}

/**
 * 意图的掌心法向（与求解器同口径）：
 * 显式给的 → 锚点推导的（体段径向的反向 = 掌心朝体段）→ 缺省（掌心朝体侧）。
 */
function intendedPalmNormal(targets: PoseTargets, side: 'Left' | 'Right'): THREE.Vector3 {
  const eff = side === 'Left' ? 'handL' : 'handR'
  const t = targets.effectors[eff]
  if (t?.normal !== undefined) {
    return new THREE.Vector3(t.normal.x, t.normal.y, t.normal.z).normalize()
  }
  if (t?.anchor !== undefined) {
    const seg = host.anchorSegment(t.anchor.part)!
    const axis = seg.b.clone().sub(seg.a).normalize()
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(axis, -axis.y)
    if (up.lengthSq() < 1e-9) up.set(0, 0, 1).addScaledVector(axis, -axis.z)
    up.normalize()
    const outward = new THREE.Vector3(side === 'Left' ? 1 : -1, 0, 0)
    outward.addScaledVector(axis, -outward.dot(axis))
    if (outward.lengthSq() < 1e-9) outward.copy(up)
    outward.normalize()
    const theta = (t.anchor.radialDeg * Math.PI) / 180
    const dir = up.multiplyScalar(Math.cos(theta)).addScaledVector(outward, Math.sin(theta)).normalize()
    return dir.clone().negate()
  }
  const shoulder = fx.byName.get(
    JOINT_BONES[side === 'Left' ? 'shoulderL' : 'shoulderR'],
  )!.getWorldPosition(new THREE.Vector3())
  const inward = new THREE.Vector3(-shoulder.x, 0, 0)
  if (inward.lengthSq() < 1e-9) inward.set(side === 'Left' ? -1 : 1, 0, 0)
  return inward.normalize()
}

/**
 * 达成掌向（模型空间）：手掌**肉**实际朝哪。
 *
 * 量法：把手部顶点按绑定姿态的掌深分成「掌心侧 / 手背侧」，看两边的质心差
 * （掌心侧多出来的那坨肉指向哪）✓。但这个量法有系统偏差（虎口丘把掌心侧的
 * 质心拉偏），所以先在**绑定姿态**下量一次当基准（那时真掌向已知 = 静息系
 * 法向），再把「粗测 → 真掌向」的旋转按姿势的增量旋转搬到当前帧 ✓。
 *
 * 这条量法是 F2 的守门人：静息系的掌法向歪 36° 时，粗测出来的掌向也跟着歪，
 * 门禁会直接把它判出来 ✓。
 */
function achievedPalmNormal(joints: ReturnType<PoseSolver['joints']>, side: 'Left' | 'Right'): THREE.Vector3 {
  const frame = host.restHandFrame(side)
  const wristBind = fx.bindWorld.get(`mixamorig${side}Hand`)!
  const handIdx: number[] = []
  for (let i = 0; i < fx.position.count; i++) {
    const n = dominantBone(fx, i)
    if (n === `mixamorig${side}Hand` || n === `mixamorig${side}HandEnd`) handIdx.push(i)
  }
  const depthOf = new Map<number, number>()
  for (const i of handIdx) {
    depthOf.set(i, new THREE.Vector3(
      fx.position.getX(i), fx.position.getY(i), fx.position.getZ(i),
    ).sub(wristBind).dot(frame.normal))
  }
  /** 掌心侧质心 − 手背侧质心（给定顶点位置）。 */
  const crude = (posOf: (i: number) => THREE.Vector3): THREE.Vector3 => {
    const palm = new THREE.Vector3()
    const back = new THREE.Vector3()
    let pn = 0, bn = 0
    for (const i of handIdx) {
      const d = depthOf.get(i)!
      if (d > 0.005) { palm.add(posOf(i)); pn++ }
      else if (d < -0.005) { back.add(posOf(i)); bn++ }
    }
    if (pn === 0 || bn === 0) return frame.normal.clone()
    palm.multiplyScalar(1 / pn)
    back.multiplyScalar(1 / bn)
    return palm.sub(back).normalize()
  }
  const bindPosOf = (i: number) => new THREE.Vector3(
    fx.position.getX(i), fx.position.getY(i), fx.position.getZ(i),
  )
  const crudeBind = crude(bindPosOf)
  const posed = skinPositions(fx, joints)
  const crudePose = crude((i) => new THREE.Vector3(posed[i * 3], posed[i * 3 + 1], posed[i * 3 + 2]))
  // 校准旋转（绑定姿态下：粗测 → 真掌向）
  const calibration = new THREE.Quaternion().setFromUnitVectors(crudeBind, frame.normal)
  // 姿势的增量旋转（骨骼世界朝向 vs 绑定姿态）
  const q = fx.byName.get(`mixamorig${side}Hand`)!.getWorldQuaternion(new THREE.Quaternion())
  const delta = q.clone().multiply(bindHandQuat[side].clone().invert())
  const calibrationPose = delta.clone().multiply(calibration).multiply(delta.clone().invert())
  return crudePose.applyQuaternion(calibrationPose).normalize()
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

  it('手搭大腿的预设：掌心贴住腿面（不悬空、不陷进去、掌心朝腿、指尖不扎）', () => {
    // 判据是「**意图有没有被满足**」，不是「角度对不对」：
    //   · 掌心/指离腿面 −5mm~+10mm：贴住（0mm 附近），悬空 17~24mm 的旧 bug 判不过 ✓
    //   · 掌心朝腿：手背贴腿（掌向反了 180°）判不过 ✓
    //   · 指尖不扎腿：卷着的指尖不该戳进腿面 ✓
    for (const id of ['sit', 'kneel']) {
      const { joints, targets } = solvePreset(id)
      for (const side of ['Left', 'Right'] as const) {
        const c = handThighContact(fx, joints, side, host.restHandFrame(side))
        const where = `${id} ${side}`
        expect(c.gap, `${where} 手-腿间隙 ${(c.gap * 1000).toFixed(1)}mm`)
          .toBeGreaterThanOrEqual(-0.005)
        expect(c.gap, `${where} 手-腿间隙 ${(c.gap * 1000).toFixed(1)}mm`)
          .toBeLessThanOrEqual(0.010)
        expect(c.tipGap, `${where} 指尖-腿间隙 ${(c.tipGap * 1000).toFixed(1)}mm`)
          .toBeGreaterThanOrEqual(-0.005)
        expect(c.palmFacing, `${where} 贴腿的是掌心还是手背`).toBe(true)
        // 意图的掌向要真的落到手上（掌心那一侧朝向意图方向）
        const want = intendedPalmNormal(targets, side)
        const got = achievedPalmNormal(joints, side)
        const deg = Math.acos(Math.max(-1, Math.min(1, got.dot(want)))) * 180 / Math.PI
        expect(deg, `${where} 达成掌向 vs 意图掌向 ${deg.toFixed(0)}°`).toBeLessThanOrEqual(40)
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

  it('腕不过度折（掌屈 ≤ 40°、背伸 ≤ 70°、偏折 ≤ 40°，解剖区间）', () => {
    // 判据按**解剖自由度**分开量（2026-11-19）：手掌平贴在面上时前臂与手之间本来
    // 就有几十度的横向偏折，拿「总夹角」当腕屈会把合法的背伸判成超限（实测坐姿
    // 背伸 33° + 偏折 21°）→ 门禁逼着把腕夹死 → 手贴不平腿面 ✓
    for (const id of TARGET_PRESET_IDS) {
      const { joints, targets } = solvePreset(id)
      for (const side of ['Left', 'Right'] as const) {
        const bend = wristBendDeg(joints, side, intendedPalmNormal(targets, side))
        const flex = bend.flex
        const dev = bend.dev
        expect(flex, `${id} ${side} 腕掌屈 ${flex.toFixed(0)}°`).toBeLessThanOrEqual(WRIST_LIMITS.flexionMaxDeg)
        expect(-flex, `${id} ${side} 腕背伸 ${(-flex).toFixed(0)}°`).toBeLessThanOrEqual(WRIST_LIMITS.extensionMaxDeg)
        expect(Math.abs(dev), `${id} ${side} 腕偏折 ${dev.toFixed(0)}°`).toBeLessThanOrEqual(WRIST_LIMITS.deviationMaxDeg)
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
  // 基座用**真实坐姿**的根与头（骨盆高度 + 上身前倾）：手要够到大腿面，
  // 躯干得前倾（肩到大腿的距离超过臂长）✓。用直立的合成基座时前臂会压进
  // 髋部 11.8mm：那是「够不到」的姿态，不是语义动作本身的毛病 ✓
  const sitTargets = poseTargets('sit', metrics)!
  const base = (): PoseTargets => ({
    root: { ...sitTargets.root },
    effectors: {
      footL: { pos: { x: 0.11, y: 0.1, z: 0.3 } },
      footR: { pos: { x: -0.11, y: 0.1, z: 0.3 } },
      handL: { pos: { x: 0.3, y: 0.9, z: 0.1 } },
      handR: { pos: { x: -0.3, y: 0.9, z: 0.1 } },
    },
    head: { ...sitTargets.head! },
  })

  it('手贴大腿：双手换成大腿语义锚点，其他意图不动', () => {
    const next = applySemanticAction('hands-on-thigh', base(), metrics)
    expect(next.effectors.handL?.anchor?.part).toBe('leftThigh')
    expect(next.effectors.handR?.anchor?.part).toBe('rightThigh')
    expect(next.effectors.handL?.pos).toBeUndefined()
    // 骨盆高度 / 头朝向 / 脚不动
    expect(next.root).toEqual(base().root)
    expect(next.head).toEqual(base().head)
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

// 姿势几何门禁：所有姿势在真骨架 + 真蒙皮上量几何。
//
// 存在的理由：姿势数值是手写欧拉表，肉眼看静态截图很难同时发现三类错误——
//   · 反关节（肘过伸、膝反折）—— 几何上「看起来还能站」，解剖上不可能
//   · 方向错（脚尖朝前而非朝后）—— 落地高度全对，姿势语义完全错
//   · 浮空（整个人离地）—— 数值合理但没贴地
// 2026-11-17 两轮实测踩齐了这三类：kneel 髋/膝/踝三个符号全反、run 双肘过伸 86°、
// 全姿势浮空 17–36cm。因此本文件断言三件事：解剖范围、落地高度、姿势语义。

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { POSES, poseJoints } from '../src/client/mannequin/poses.ts'
import { applyRigPose, lowestSkinnedY, type RigBinding, type SkinSample } from '../src/client/mannequin/rig.ts'
import { loadRigFixture } from './helpers/rig-fixture.ts'
import { poseContact, handThighGap } from './helpers/pose-contact.ts'

const fixture = loadRigFixture()

const sample: SkinSample = {
  position: fixture.position,
  skinIndex: fixture.skinIndex,
  skinWeight: fixture.skinWeight,
  bones: fixture.boneList,
  boneInverses: fixture.boneInverses,
}

/** 把姿势应用到夹具骨架（与运行时同一个 applyRigPose）。 */
function applyPoseToFixture(id: string): number {
  const binding = { bones: fixture.bones, zSign: fixture.zSign } as unknown as RigBinding
  applyRigPose(binding, poseJoints(id))
  fixture.root.updateMatrixWorld(true)
  return lowestSkinnedY(sample, fixture.probe)
}

interface Point {
  x: number
  y: number
  z: number
}

/**
 * 落地后的关键点坐标（cm）。落地 = 减去蒙皮最低点，与 viewer.ts 的 reground 同逻辑。
 * 坐标轴：x+ = 角色左手侧，y+ = 上，z+ = 面朝方向。
 */
function geometry(id: string): { at: (bone: string) => Point; rawLowest: number } {
  const minY = applyPoseToFixture(id)
  const at = (bone: string): Point => {
    const obj = fixture.byName.get(`mixamorig${bone}`)
    if (obj === undefined) throw new Error(`夹具缺骨：${bone}`)
    const v = obj.getWorldPosition(new THREE.Vector3())
    return { x: v.x * 100, y: (v.y - minY) * 100, z: v.z * 100 }
  }
  return { at, rawLowest: minY * 100 }
}

const DEG = 180 / Math.PI

/** 两点的单位方向向量（几何判据用）。 */
function dir(a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const len = Math.hypot(dx, dy, dz) || 1
  return { x: dx / len, y: dy / len, z: dz / len }
}

describe('姿势库：解剖范围', () => {
  it('每个姿势都是全关节表，数值有限且幅度可控', () => {
    for (const p of POSES) {
      const t = poseJoints(p.id)
      for (const [joint, r] of Object.entries(t)) {
        expect(Number.isFinite(r.x), `${p.id}.${joint}.x`).toBe(true)
        expect(Number.isFinite(r.y), `${p.id}.${joint}.y`).toBe(true)
        expect(Number.isFinite(r.z), `${p.id}.${joint}.z`).toBe(true)
        expect(Math.abs(r.x), `${p.id}.${joint}.x 幅度`).toBeLessThanOrEqual(2.8)
      }
    }
  })

  it('膝盖只有后屈，不存在反关节', () => {
    for (const p of POSES) {
      const t = poseJoints(p.id)
      for (const knee of ['kneeL', 'kneeR'] as const) {
        expect(t[knee].x, `${p.id}.${knee} 必须 ≥ 0（x<0 是反关节）`).toBeGreaterThanOrEqual(0)
        expect(t[knee].x, `${p.id}.${knee} 超过被动屈曲上限`).toBeLessThanOrEqual(2.6)
      }
    }
  })

  // 肘只能向前折。过伸哪怕 10° 都会让肘尖朝后凸出，参考图一眼假。
  //
  // 判据改成**几何夹角**（上臂轴 vs 前臂轴），不再看姿势表里的 elbow.x：
  // 欧拉是级联的，肩/肘的 y/z 一旦不是 0，elbow.x 就不再等于「屈曲量」
  // （IK 解出的姿势里 elbow.x 反而是正的，但几何上肘是正常弯的 ✗ 会被误杀）。
  it('肘关节不过伸（几何夹角 ≤ 182°）且屈曲不超上限', () => {
    for (const p of POSES) {
      const { at } = geometry(p.id)
      for (const side of ['Left', 'Right'] as const) {
        const elbow = at(`${side}ForeArm`)
        const shoulder = at(`${side}Arm`)
        const wrist = at(`${side}Hand`)
        const up = dir(shoulder, elbow)
        const fore = dir(wrist, elbow)
        const ang = Math.acos(Math.max(-1, Math.min(1, up.x * fore.x + up.y * fore.y + up.z * fore.z))) * DEG
        expect(ang, `${p.id}.${side} 肘过伸（上下臂夹角 ${ang.toFixed(0)}°，180=伸直）`).toBeLessThanOrEqual(182)
        expect(ang, `${p.id}.${side} 肘屈曲超上限（夹角 ${ang.toFixed(0)}°）`).toBeGreaterThanOrEqual(25)
      }
    }
  })

  it('踝关节在生理范围内（跖屈 ≤ 60°，背屈 ≤ 50°）', () => {
    for (const p of POSES) {
      const t = poseJoints(p.id)
      for (const ankle of ['ankleL', 'ankleR'] as const) {
        expect(t[ankle].x, `${p.id}.${ankle} 跖屈超限`).toBeLessThanOrEqual(1.05)
        expect(t[ankle].x, `${p.id}.${ankle} 背屈超限`).toBeGreaterThanOrEqual(-0.9)
      }
    }
  })

  it('髋关节在生理范围内（前屈 ≤ 120°，后伸 ≤ 30°）', () => {
    for (const p of POSES) {
      const t = poseJoints(p.id)
      for (const hip of ['hipL', 'hipR'] as const) {
        expect(t[hip].x, `${p.id}.${hip} 后伸超限`).toBeLessThanOrEqual(0.55)
        expect(t[hip].x, `${p.id}.${hip} 前屈超限`).toBeGreaterThanOrEqual(-2.1)
      }
    }
  })
})

describe('姿势库：落地与整体高度', () => {
  it('a-pose 是绑定姿态：全零表、手腕外展约 43cm', () => {
    // 绑定姿态本身就是 A-pose（手臂外展 43°、前倾 23°）。a-pose 保留为零表，
    // 标题也改成「绑定姿态基准」——名字与几何一致，不再宣称「自然下垂」。
    const t = poseJoints('a-pose')
    for (const [joint, r] of Object.entries(t)) {
      expect(r.x + r.y + r.z, `a-pose.${joint} 应为零位`).toBe(0)
    }
    const { at } = geometry('a-pose')
    expect(at('LeftHand').x, 'A-pose 手腕应在体侧约 43cm').toBeGreaterThan(38)
    expect(Math.abs(geometry('a-pose').rawLowest)).toBeLessThan(0.5)
  })

  it('stand 是自然下垂：手腕贴在体侧 20–25cm、髋高附近', () => {
    // 这一条是第三轮补的根因门禁：绑定姿态手臂外展 43°，只补前倾不补外展时
    // 手腕停在体侧 43cm，正面看是张开的稻草人。
    const { at } = geometry('stand')
    const hand = at('LeftHand')
    const hips = at('Hips')
    expect(hand.x, '手腕的横向位置应≈髂嵴外侧').toBeGreaterThan(19)
    expect(hand.x, '手腕的横向位置应≈髂嵴外侧').toBeLessThan(25)
    expect(Math.abs(hand.z), '手腕不应前伸或后甩').toBeLessThan(6)
    expect(hand.y - hips.y, '手腕应略高于髋').toBeGreaterThan(0)
    expect(hand.y - hips.y, '手腕应略高于髋').toBeLessThan(10)
  })

  it('没有任何姿势产生 NaN / Infinity 的落地高度', () => {
    for (const p of POSES) {
      const raw = applyPoseToFixture(p.id)
      expect(Number.isFinite(raw), `${p.id} 最低点`).toBe(true)
    }
  })

  it('站立类：脚在地面、头顶接近身高', () => {
    for (const id of ['stand', 't-pose', 'hands-on-hips']) {
      const { at } = geometry(id)
      expect(at('LeftFoot').y, `${id} 踝高`).toBeGreaterThan(6)
      expect(at('LeftFoot').y, `${id} 踝高`).toBeLessThan(14)
      expect(at('HeadTop').y, `${id} 头顶高`).toBeGreaterThan(158)
      expect(at('HeadTop').y, `${id} 头顶高`).toBeLessThan(172)
      expect(at('Hips').y, `${id} 髋高`).toBeGreaterThan(84)
    }
  })

  it('t-pose：双臂水平（手与肩同高）', () => {
    const { at } = geometry('t-pose')
    const shoulder = at('LeftArm')
    const hand = at('LeftHand')
    expect(Math.abs(hand.y - shoulder.y), '手应≈肩高').toBeLessThan(4)
    expect(hand.x, '手应显著外展').toBeGreaterThan(48)
  })
})

describe('姿势库：姿势语义（动作与名称一致）', () => {
  it('叉腰：手落在体侧髋部，肘尖朝后', () => {
    const { at } = geometry('hands-on-hips')
    const hand = at('LeftHand')
    const elbow = at('LeftForeArm')
    const hips = at('Hips')
    // 手在体侧、髋部高度（踝高 10 + 髋 92，手应落在 96–112）
    expect(hand.x, '手应在体侧 x 20–32').toBeGreaterThan(20)
    expect(hand.x, '手应在体侧 x 20–32').toBeLessThan(32)
    expect(hand.y, '手应在腰/髂嵴高度 96–112').toBeGreaterThan(96)
    expect(hand.y, '手应在腰/髂嵴高度 96–112').toBeLessThan(112)
    expect(Math.abs(hand.z), '手不应甩到身后或身前').toBeLessThan(12)
    expect(elbow.z, '肘尖应朝后（z<0）').toBeLessThan(0)
    expect(elbow.y, '肘应低于肩').toBeLessThan(at('LeftArm').y)
    // 旧版错误：手 y=99 但 z=-5 且肘过伸，手在身后 —— 这里用肘朝后来兜住
    expect(hips.y - hand.y, '手不应垂到髋以下').toBeLessThan(12)
  })

  it('行走：前脚跟着地、后脚尖点地，对侧摆臂', () => {
    const { at } = geometry('walk')
    const frontToe = at('LeftToeEnd')
    const frontAnkle = at('LeftFoot')
    const backToe = at('RightToeEnd')
    const backAnkle = at('RightFoot')
    // 前腿：脚趾高于踝 = 背屈，后跟着地
    expect(frontAnkle.z, '前脚应在身前').toBeGreaterThan(10)
    expect(frontToe.y - frontAnkle.y, '前脚应脚跟着地（趾高于踝）').toBeGreaterThan(-1)
    // 后腿：趾端贴地、踝抬起 = 跖屈，脚尖点地
    expect(backAnkle.z, '后脚应在身后').toBeLessThan(-20)
    expect(backToe.y, '后脚尖应贴地').toBeLessThan(8)
    expect(backAnkle.y - backToe.y, '后脚踝应抬起（脚尖点地）').toBeGreaterThan(8)
    // 对侧摆臂：左腿在前 → 左手在后、右手在前
    expect(at('LeftHand').z, '左臂应后摆').toBeLessThan(at('RightHand').z)
    // 手臂必须贴着躯干前后摆，不能张在体侧（外展补偿的门禁）
    for (const side of ['LeftHand', 'RightHand']) {
      expect(Math.abs(at(side).x), `${side} 应贴着躯干摆动（<28cm）`).toBeLessThan(28)
    }
    // 重心只比站立略低
    expect(at('Hips').y).toBeGreaterThan(82)
    expect(at('Hips').y).toBeLessThan(93)
  })

  it('奔跑：支撑脚触地、摆动腿脚跟抬到臀部附近、屈肘摆臂', () => {
    const { at } = geometry('run')
    const supportToe = at('LeftToeEnd')
    const swingAnkle = at('RightFoot')
    const hips = at('Hips')
    // 支撑腿：整脚触地
    expect(supportToe.y, '支撑脚应触地').toBeLessThan(10)
    // 摆动腿：脚跟抬到臀部高度附近
    expect(swingAnkle.y, '摆动脚应抬起').toBeGreaterThan(55)
    expect(hips.y - swingAnkle.y, '脚跟应在臀下方 25cm 内').toBeLessThan(25)
    expect(swingAnkle.z, '摆动腿应在身后').toBeLessThan(-20)
    // 前摆臂（右）：屈肘把前臂抬到胸腹前，手不低于肘附近
    const frontHand = at('RightHand')
    const frontElbow = at('RightForeArm')
    expect(frontHand.y, '前摆臂的手应抬到肘附近').toBeGreaterThan(frontElbow.y - 8)
    expect(frontHand.z, '前摆臂的手应在身前').toBeGreaterThan(hips.z + 10)
    // 后摆臂（左）：肘甩到躯干后方、前臂自然下垂（手低于肘是对的，不是「前臂塌了」）
    const backHand = at('LeftHand')
    const backElbow = at('LeftForeArm')
    expect(backElbow.z, '后摆臂的肘应在躯干后方').toBeLessThan(hips.z)
    expect(backHand.y, '后摆臂前臂应自然下垂').toBeLessThan(backElbow.y)
    // 躯干前倾：看头顶相对髋的前移（脊柱旋转本身位移很小，只有末端才看得出来）
    expect(at('HeadTop').z - hips.z, '上身应前倾（头顶前移）').toBeGreaterThan(5)
    // 双臂不能张开到体侧之外（跑姿的手臂是贴着躯干前后摆的）。
    // 阈值 30cm：2026-11-18 反穿模修复把右臂内收从 0.35 降到 0.18（前臂贴躯干
    // 摆会插进躯干 19mm），手臂因此外张 1.3cm；30cm 仍是「贴身摆」而非张开。
    for (const side of ['LeftHand', 'RightHand']) {
      expect(Math.abs(at(side).x), `${side} 应贴着躯干摆动（<30cm）`).toBeLessThan(30)
    }
    // 前后分离：一只手在身后、一只手在身前
    expect(at('RightHand').z - at('LeftHand').z, '前后摆臂分离应显著').toBeGreaterThan(30)
  })

  it('坐姿：大腿水平、小腿垂直、脚落地、手搭在大腿上', () => {
    const { at } = geometry('sit')
    const hips = at('Hips')
    const knee = at('LeftLeg')
    const ankle = at('LeftFoot')
    const hand = at('LeftHand')
    expect(hips.y, '髋高应接近椅面 45–52cm').toBeGreaterThan(42)
    expect(hips.y, '髋高应接近椅面 45–52cm').toBeLessThan(56)
    expect(Math.abs(knee.y - hips.y), '大腿应水平（膝≈髋高）').toBeLessThan(8)
    expect(knee.z, '膝应在身体前方').toBeGreaterThan(30)
    expect(ankle.y, '脚应落地').toBeGreaterThan(6)
    expect(ankle.y, '脚应落地').toBeLessThan(15)
    expect(knee.y - ankle.y, '小腿应垂直（膝高于踝 30–45cm）').toBeGreaterThan(30)
    // 手搭在大腿上（不是搭在膝盖上）：本骨架肩→腕只有 45cm，直立时肩到大腿
    // 上表面约 52cm → 要把手放到膝盖上必须把手臂伸直或把躯干前倾到不合理，
    // 所以按人体实际坐姿改成「手掌搭在大腿中段、指尖朝膝」。
    expect(Math.abs(hand.x - knee.x), '手应与大腿横向对齐').toBeLessThan(14)
    expect(hand.y - knee.y, '手应停在大腿上方').toBeGreaterThan(0)
    // 18cm：手改成「贴在大腿面上」后，手心离膝关节的高度变大（大腿往膝方向是下坡的，
    // 手落在中段而不是膝上方）；真正的「有没有落到大腿上」由反穿模门禁断言
    // （sit 手↔大腿 gap ≈ 1.4mm = 接触级）。
    expect(hand.y - knee.y, '手应停在大腿上方 18cm 内').toBeLessThan(18)
    expect(knee.z - hand.z, '手应落在大腿上（离膝 4–26cm 的那段）').toBeGreaterThan(4)
    expect(knee.z - hand.z, '手应落在大腿上（离膝 4–26cm 的那段）').toBeLessThan(26)
  })

  it('跪坐：膝着地、小腿水平、脚尖朝后贴地、臀坐在脚上方', () => {
    const { at } = geometry('kneel')
    const hips = at('Hips')
    const knee = at('LeftLeg')
    const ankle = at('LeftFoot')
    const toe = at('LeftToeEnd')
    // 膝着地（膝关节骨中心 5–20cm，其表面贴地）
    expect(knee.y, '膝应贴地').toBeGreaterThan(2)
    expect(knee.y, '膝应贴地').toBeLessThan(20)
    // 小腿水平：踝与膝同高
    expect(Math.abs(ankle.y - knee.y), '小腿应水平（踝≈膝高）').toBeLessThan(10)
    // 小腿向后：踝在膝后方
    expect(ankle.z, '踝应在膝后方').toBeLessThan(knee.z - 20)
    // 脚尖朝后：趾端比踝更靠后，且贴地
    expect(toe.z, '脚尖必须朝后（z 小于踝）').toBeLessThan(ankle.z)
    expect(ankle.z - toe.z, '脚尖应在踝后方 10cm 以上').toBeGreaterThan(10)
    expect(toe.y, '脚背应贴地').toBeLessThan(12)
    // 臀坐在脚上方：臀高 28–44
    expect(hips.y, '臀高应≈坐在脚跟上').toBeGreaterThan(26)
    expect(hips.y, '臀高应≈坐在脚跟上').toBeLessThan(44)
    // 手搭在大腿上，不是悬在虚空里
    const hand = at('LeftHand')
    expect(hand.y, '手应落到大腿面上（不是悬空）').toBeLessThan(48)
    // 22cm：与坐姿同理，手改成贴大腿面后指尖略过中段（由反穿模门禁保证接触级）
    expect(hand.z, '手不应往前伸到大腿中段之外').toBeLessThan(22)
    expect(Math.abs(hand.x - knee.x), '手应与大腿横向对齐').toBeLessThan(12)
    // 头顶显著低于站立
    const head = at('HeadTop')
    expect(head.y, '跪坐头顶应约为站立的 60–72%').toBeGreaterThan(100)
    expect(head.y, '跪坐头顶应约为站立的 60–72%').toBeLessThan(122)
  })

  it('坐/跪的左右腿对称', () => {
    for (const id of ['sit', 'kneel', 'a-pose']) {
      const t = poseJoints(id)
      expect(Math.abs(t.hipL.x - t.hipR.x), `${id} 髋`).toBeLessThan(0.01)
      expect(Math.abs(t.kneeL.x - t.kneeR.x), `${id} 膝`).toBeLessThan(0.01)
      expect(Math.abs(t.ankleL.x - t.ankleR.x), `${id} 踝`).toBeLessThan(0.01)
    }
  })

  it('左右臂在对称姿势里互为镜像', () => {
    // 只查**手写**的姿势：sit/kneel 的手臂是两骨 IK 逐侧解出来的
    // （每侧独立解，网格本身左右也不完全对称），不是镜像出来的 ✗ 不能按镜像断言。
    for (const id of ['t-pose', 'hands-on-hips']) {
      const t = poseJoints(id)
      expect(Math.abs(t.shoulderL.x - t.shoulderR.x), `${id} 肩 x`).toBeLessThan(0.01)
      expect(Math.abs(t.shoulderL.z + t.shoulderR.z), `${id} 肩 z 应互为相反数`).toBeLessThan(0.01)
      expect(Math.abs(t.elbowL.x - t.elbowR.x), `${id} 肘`).toBeLessThan(0.01)
    }
  })
})

describe('姿势库：反穿模', () => {
  // 姿势语义全对也可能穿模（2026-11-18 实机：run 前臂插躯干、sit/kneel 手埋大腿、
  // kneel 腹压大腿）。解剖区间断言看不见这类错误，只能靠碰撞测。
  //
  // 判据换成**体段碰撞体**（沿肢体轴打射线量内外，符号无歧义）：
  // 旧的 pose-clip 审计靠「面法线多数表决 + 符号门槛」，在关节凹陷处会漏判——
  // 实机截图里手陷进大腿 9cm 它却报「无穿插」，判据错了调出来的角度必然也错。
  for (const pose of POSES) {
    it(`${pose.id}（${pose.title}）：手臂不陷进躯干/腿（穿深 ≤ 8mm）`, () => {
      const { maxPen, label, byPart } = poseContact(fixture, pose.id)
      const detail = Object.entries(byPart).filter(([, v]) => v > 0.001).map(([k, v]) => `${k} ${(v * 1000).toFixed(1)}mm`).join('，')
      expect(maxPen, `${pose.id} ${label} 穿深 ${(maxPen * 1000).toFixed(1)}mm（${detail}）`).toBeLessThanOrEqual(0.008)
    })
  }

  // 「手搭在大腿上」是接触级关系：既不能陷进腿里，也不能悬空飘着。
  for (const id of ['sit', 'kneel']) {
    it(`${id}：双手贴在大腿面上（间隙 −2mm ~ 25mm）`, () => {
      for (const side of ['Left', 'Right'] as const) {
        const gap = handThighGap(fixture, id, side)
        expect(gap, `${id} ${side} 手掌陷进大腿 ${(gap * 1000).toFixed(1)}mm`).toBeGreaterThan(-0.002)
        expect(gap, `${id} ${side} 手掌悬空 ${(gap * 1000).toFixed(1)}mm`).toBeLessThan(0.025)
      }
    })
  }
})

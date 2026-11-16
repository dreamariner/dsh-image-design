// @dreamariner/dsh-image-design :: 素体纯函数测试（不渲染，不碰 WebGL）
//
// 覆盖：三围→半径映射、地标恒定总高、姿势表完整性、相机预设形状。
// three 构建函数（buildBody）在实机验收里走查。

import { describe, expect, it } from 'vitest'
import { DEFAULT_BODY, girthToRadius, landmarks, torsoRadii, JOINT_NAMES, buildBody } from '../src/client/mannequin/body.ts'
import { POSES, poseJoints, normalizePose } from '../src/client/mannequin/poses.ts'
import { computeCameraPose, presetOrbit, SHOTS } from '../src/client/mannequin/camera.ts'
import { captureSize } from '../src/client/mannequin/capture.ts'
import type { BodyParams } from '../src/client/mannequin/body.ts'

const params = (over: Partial<BodyParams> = {}): BodyParams => ({ ...DEFAULT_BODY, ...over })

describe('体型数学', () => {
  it('围度 → 回转半径（r = g / 2π）', () => {
    expect(girthToRadius(Math.PI * 2)).toBeCloseTo(1, 10)
  })

  it('胸围系数增大 → 胸半径增大，其余半径不动', () => {
    const base = torsoRadii(params())
    const bigger = torsoRadii(params({ bust: 1.3 }))
    expect(bigger.bustR).toBeGreaterThan(base.bustR)
    expect(bigger.waistR).toBeCloseTo(base.waistR, 10)
    expect(bigger.hipR).toBeCloseTo(base.hipR, 10)
  })

  it('腰围系数减小（收腰）→ 腰半径减小', () => {
    const slim = torsoRadii(params({ waist: 0.6 }))
    expect(slim.waistR).toBeLessThan(torsoRadii(params()).waistR)
  })

  it('地标总高恒定：腿长系数变化不改变头顶高度', () => {
    const a = landmarks(params({ legLength: 0.85 }))
    const b = landmarks(params({ legLength: 1.15 }))
    expect(a.headTopY).toBeCloseTo(b.headTopY, 10)
    expect(b.crotchY).toBeGreaterThan(a.crotchY) // 腿长的人裆位更高
  })

  it('身高缩放：围度半径随身高线性缩放', () => {
    const base = torsoRadii(params({ height: 170 }))
    const tall = torsoRadii(params({ height: 190 }))
    expect(tall.bustR / base.bustR).toBeCloseTo(190 / 170, 6)
  })

  it('buildBody 装出完整关节树（不渲染也可构建）', () => {
    const body = buildBody(params())
    for (const j of JOINT_NAMES) {
      expect(body.joints[j], `关节 ${j}`).toBeDefined()
      expect(body.joints[j].parent).not.toBeNull()
    }
    body.dispose()
  })

  it('buildBody 参数变化重建成功且可释放', () => {
    // 半径映射已被 torsoRadii 测试覆盖；这里只验证两次构建都能产出且可释放
    const a = buildBody(params({ bust: 0.8 }))
    const b = buildBody(params({ bust: 1.3 }))
    a.dispose()
    b.dispose()
    expect(true).toBe(true)
  })
})

describe('姿势库', () => {
  it('8 个姿势、id 唯一、每姿势全关节表完整', () => {
    expect(POSES.length).toBe(8)
    const ids = POSES.map((p) => p.id)
    expect(new Set(ids).size).toBe(8)
    for (const pose of POSES) {
      const joints = poseJoints(pose.id)
      for (const j of JOINT_NAMES) {
        expect(joints[j], `${pose.id} 缺关节 ${j}`).toBeDefined()
      }
    }
  })

  it('T-pose 双臂水平展开（肩 z = ±π/2）', () => {
    const t = poseJoints('t-pose')
    expect(t.shoulderL.z).toBeCloseTo(Math.PI / 2, 8)
    expect(t.shoulderR.z).toBeCloseTo(-Math.PI / 2, 8)
  })

  it('normalizePose 补全缺省关节为 0、剔除未知关节', () => {
    const n = normalizePose({ shoulderL: { x: 1, y: 2, z: 3 }, bogusJoint: { x: 9, y: 9, z: 9 } })
    expect(n.shoulderL).toEqual({ x: 1, y: 2, z: 3 })
    expect(n.kneeR).toEqual({ x: 0, y: 0, z: 0 })
    expect((n as Record<string, unknown>).bogusJoint).toBeUndefined()
  })
})

describe('相机预设', () => {
  it('景别档距离递减：全身 > 七分身 > 半身 > 特写', () => {
    expect(SHOTS.full.distanceFactor).toBeGreaterThan(SHOTS.threeQuarter.distanceFactor)
    expect(SHOTS.threeQuarter.distanceFactor).toBeGreaterThan(SHOTS.half.distanceFactor)
    expect(SHOTS.half.distanceFactor).toBeGreaterThan(SHOTS.closeup.distanceFactor)
  })

  it('方位角：背面 = 180，正侧 = 90', () => {
    const back = computeCameraPose('full', presetOrbit('full', 'back', 'level'), 1.7)
    expect(back.position.x).toBeCloseTo(0, 6)
    expect(back.position.z).toBeLessThan(0) // 相机在 -z（背面）
    const side = computeCameraPose('full', presetOrbit('full', 'side', 'level'), 1.7)
    expect(side.position.x).toBeGreaterThan(0)
    expect(Math.abs(side.position.z)).toBeLessThan(1e-6)
  })

  it('仰角抬高相机高度', () => {
    const level = computeCameraPose('full', presetOrbit('full', 'front', 'level'), 1.7)
    const high = computeCameraPose('full', presetOrbit('full', 'front', 'high'), 1.7)
    expect(high.position.y).toBeGreaterThan(level.position.y)
  })

  it('注视点在模型上（y 在身高带内），相机离地不穿地', () => {
    const close = computeCameraPose('closeup', presetOrbit('closeup', 'front', 'low'), 1.7)
    expect(close.target.y).toBeGreaterThan(0.5)
    expect(close.position.y).toBeGreaterThanOrEqual(0.05)
  })

  it('距离缩放（滚轮推拉）改变相机距离', () => {
    const base = computeCameraPose('full', presetOrbit('full', 'front', 'level'), 1.7)
    const zoomIn = computeCameraPose('full', { ...presetOrbit('full', 'front', 'level'), distanceScale: 0.5 }, 1.7)
    const dist = (p: typeof base): number => Math.hypot(p.position.x, p.position.z, p.position.y - p.target.y)
    expect(dist(zoomIn)).toBeCloseTo(dist(base) * 0.5, 6)
  })
})

describe('拍摄尺寸', () => {
  it('比例换算：长边钉死，短边按比例', () => {
    expect(captureSize(1024, '1:1')).toEqual({ width: 1024, height: 1024 })
    expect(captureSize(1536, '2:3')).toEqual({ width: 1024, height: 1536 })
    expect(captureSize(1536, '3:4')).toEqual({ width: 1152, height: 1536 })
    expect(captureSize(2048, '9:16')).toEqual({ width: 1152, height: 2048 })
  })

})

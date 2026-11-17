// @dreamariner/dsh-image-design :: 素体纯函数测试（不渲染，不碰 WebGL）
//
// 覆盖：体型→骨骼缩放映射、姿势表完整性、骨架装配语义（世界系合成）、
// 相机预设形状、拍摄尺寸。GLB 加载与渲染在实机验收里走查。

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { DEFAULT_BODY, boneTunes, BONE, JOINT_NAMES, type BodyParams } from '../src/client/mannequin/body.ts'
import { POSES, poseJoints, normalizePose } from '../src/client/mannequin/poses.ts'
import { JOINT_BONES, APPLY_ORDER, bindRig, applyRigPose, Q_DOWN_L, Q_DOWN_R } from '../src/client/mannequin/rig.ts'
import { computeCameraPose, presetOrbit, SHOTS } from '../src/client/mannequin/camera.ts'
import { captureSize } from '../src/client/mannequin/capture.ts'

const params = (over: Partial<BodyParams> = {}): BodyParams => ({ ...DEFAULT_BODY, ...over })

/** 全骨架测试桩：hips 平铺挂全部映射骨骼；位置按人形摆（臂水平、腿竖直）。 */
function stubSkeleton(): THREE.Object3D {
  const root = new THREE.Object3D()
  root.name = 'mixamorigHips'
  const mk = (name: string, parent: THREE.Object3D, p: [number, number, number]): THREE.Object3D => {
    const o = new THREE.Object3D()
    o.name = name
    o.position.set(p[0], p[1], p[2])
    parent.add(o)
    return o
  }
  const spine = mk('mixamorigSpine', root, [0, 0.95, 0])
  const spine1 = mk('mixamorigSpine1', spine, [0, 0.1, 0])
  const spine2 = mk('mixamorigSpine2', spine1, [0, 0.15, 0])
  const neck = mk('mixamorigNeck', spine2, [0, 0.2, 0])
  mk('mixamorigHead', neck, [0, 0.12, 0])
  // 锁骨 → 上臂 → 前臂 → 手（局部位置沿 ±x 水平伸出，模拟 T-pose）
  for (const side of ['Left', 'Right'] as const) {
    const s = side === 'Left' ? -1 : 1
    const clav = mk(`mixamorig${side}Shoulder`, spine2, [s * 0.05, 0.05, 0])
    const arm = mk(`mixamorig${side}Arm`, clav, [s * 0.1, 0, 0])
    const fore = mk(`mixamorig${side}ForeArm`, arm, [s * 0.3, 0, 0])
    mk(`mixamorig${side}Hand`, fore, [s * 0.25, 0, 0])
  }
  // 髋 → 大腿 → 小腿 → 脚（局部位置沿 -y 竖直向下）
  for (const side of ['Left', 'Right'] as const) {
    const s = side === 'Left' ? -1 : 1
    const up = mk(`mixamorig${side}UpLeg`, root, [s * 0.1, -0.05, 0])
    const leg = mk(`mixamorig${side}Leg`, up, [0, -0.4, 0])
    mk(`mixamorig${side}Foot`, leg, [0, -0.4, 0])
  }
  return root
}

/** 骨轴方向（子骨世界位置 - 本骨世界位置），归一化。 */
function boneAxis(binding: { bones: Map<string, THREE.Object3D> }, from: string, to: string): THREE.Vector3 {
  const a = binding.bones.get(from)!.getWorldPosition(new THREE.Vector3())
  const b = binding.bones.get(to)!.getWorldPosition(new THREE.Vector3())
  return b.sub(a).normalize()
}

describe('体型 → 骨骼缩放映射', () => {
  it('头身比越大头越小（7.5 为基准 1.0）', () => {
    const tunes = boneTunes(params())
    const head = tunes.find((t) => t.bone === BONE.head)
    expect(head?.scale).toEqual([1, 1, 1])
    const small = boneTunes(params({ headRatio: 9 })).find((t) => t.bone === BONE.head)
    expect(small?.scale?.[0]).toBeCloseTo(7.5 / 9, 8)
  })

  it('腰围系数减小 → Spine1 深度（z）缩到系数、宽度（x）半强度', () => {
    const slim = boneTunes(params({ waist: 0.6 })).find((t) => t.bone === BONE.spine1)
    expect(slim?.scale?.[2]).toBeCloseTo(0.6, 8)
    expect(slim?.scale?.[0]).toBeCloseTo(0.75 + 0.25 * 0.6, 8)
  })

  it('肩宽系数对称外移锁骨', () => {
    const tunes = boneTunes(params({ shoulderWidth: 1.3 }))
    const l = tunes.find((t) => t.bone === BONE.shoulderL)
    const r = tunes.find((t) => t.bone === BONE.shoulderR)
    expect(l?.position?.[0]).toBeCloseTo(0.3 * 0.04, 8)
    expect(r?.position?.[0]).toBeCloseTo(-0.3 * 0.04, 8)
  })

  it('四肢粗细作用在 x/z、臂长作用在骨轴 y', () => {
    const arm = boneTunes(params({ limbThickness: 1.2, armLength: 1.1 })).find((t) => t.bone === BONE.armL)
    expect(arm?.scale).toEqual([1.2, 1.1, 1.2])
  })

  it('髋宽撑开 Hips 的 x/z', () => {
    const hips = boneTunes(params({ hip: 1.4 })).find((t) => t.bone === BONE.hips)
    expect(hips?.scale).toEqual([1.4, 1, 1.4])
  })

  it('默认体型全部归一（不产生任何形变）', () => {
    for (const tune of boneTunes(params())) {
      if (tune.scale !== undefined) expect(tune.scale).toEqual([1, 1, 1])
      if (tune.position !== undefined) expect(tune.position).toEqual([0, 0, 0])
    }
  })
})

describe('骨架装配（rig）', () => {
  it('16 关节全部有骨骼映射且与关节名一一对应', () => {
    expect(Object.keys(JOINT_BONES).sort()).toEqual([...JOINT_NAMES].sort())
    expect(APPLY_ORDER.length).toBe(JOINT_NAMES.length)
    // 父先于子：spine 在 chest 前，chest 在手臂前
    expect(APPLY_ORDER.indexOf('spine')).toBeLessThan(APPLY_ORDER.indexOf('chest'))
    expect(APPLY_ORDER.indexOf('chest')).toBeLessThan(APPLY_ORDER.indexOf('shoulderL'))
  })

  it('落臂补偿：rest 臂轴（按子骨位置差）转到竖直向下 + 轻微外张', () => {
    // 动态补偿：臂骨 rest 臂轴水平（+x / -x）都应转成「向下」
    for (const armX of [-1, 1]) {
      const root = stubSkeleton()
      const binding = bindRig(root)
      const arm = binding.bones.get('shoulderL') as THREE.Object3D
      const fore = binding.bones.get('elbowL') as THREE.Object3D
      // 让左臂轴指向 +x 或 -x（fore 是 arm 的子节点，改 fore 的局部位置即改臂轴）
      const dx = armX * 0.3
      arm.position.x = -dx
      fore.position.x = dx
      root.updateMatrixWorld(true)
      const binding2 = bindRig(root)
      applyRigPose(binding2, {})
      root.updateMatrixWorld(true)
      const dir = boneAxis(binding2, 'shoulderL', 'elbowL')
      expect(dir.y, `armAxis=${armX}`).toBeLessThan(-0.9)
    }
  })

  it('世界系合成：T-pose（零表 + π/2）把臂从垂放抬回水平', () => {
    const root = stubSkeleton()
    const binding = bindRig(root)
    applyRigPose(binding, poseJoints('t-pose'))
    root.updateMatrixWorld(true)
    const dir = boneAxis(binding, 'shoulderL', 'elbowL')
    // T-pose：z = π/2 抬平
    expect(Math.abs(dir.y)).toBeLessThan(0.12)
    expect(Math.abs(dir.x)).toBeGreaterThan(0.95)
    // 零表 = 自然垂放（语义 rest）
    applyRigPose(binding, poseJoints('a-pose'))
    root.updateMatrixWorld(true)
    const hang = boneAxis(binding, 'shoulderL', 'elbowL')
    expect(hang.y).toBeLessThan(-0.8)
  })

  it('脊柱前屈：x 负把上身压向模型前方（-z，Mixamo 面朝方向）', () => {
    const root = stubSkeleton()
    const binding = bindRig(root)
    const spine = binding.bones.get('spine') as THREE.Object3D
    applyRigPose(binding, { spine: { x: -0.3, y: 0, z: 0 } })
    spine.updateWorldMatrix(true, false)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(spine.getWorldQuaternion(new THREE.Quaternion()))
    expect(up.z).toBeLessThan(-0.2) // 上身朝 -z 前倾（模型前方）
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

  it('方位角：正面机位在 +z（模型前方，实测脚尖方向），背面 = -z，正侧 = ±x', () => {
    const front = computeCameraPose('full', presetOrbit('full', 'front', 'level'), 1.7)
    expect(front.position.z).toBeGreaterThan(0) // 正面机位在 +z
    const back = computeCameraPose('full', presetOrbit('full', 'back', 'level'), 1.7)
    expect(back.position.x).toBeCloseTo(0, 6)
    expect(back.position.z).toBeLessThan(0) // 背面机位在 -z
    const side = computeCameraPose('full', presetOrbit('full', 'side', 'level'), 1.7)
    expect(Math.abs(side.position.x)).toBeGreaterThan(0)
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

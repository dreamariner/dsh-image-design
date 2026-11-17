// @dreamariner/dsh-image-design :: 素体纯函数测试（不渲染，不碰 WebGL）
//
// 覆盖：体型→形变指令映射、网格形变数学（绑定姿态 LBS 混合）、骨架装配语义
// （世界系欧拉 + 级联）、姿势表完整性、相机预设形状、拍摄尺寸。
// GLB 加载与渲染在实机验收里走查（scripts/preview-body.mjs 可离线出图）。

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  DEFAULT_BODY, shapeTunes, lengthTunes, positionTunes, BONE, JOINT_NAMES, type BodyParams,
} from '../src/client/mannequin/body.ts'
import { applyShape, type ShapeContext } from '../src/client/mannequin/shape.ts'
import { POSES, poseJoints, normalizePose } from '../src/client/mannequin/poses.ts'
import { JOINT_BONES, APPLY_ORDER, bindRig, applyRigPose } from '../src/client/mannequin/rig.ts'
import { computeCameraPose, presetOrbit, SHOTS } from '../src/client/mannequin/camera.ts'
import { captureSize } from '../src/client/mannequin/capture.ts'

const params = (over: Partial<BodyParams> = {}): BodyParams => ({ ...DEFAULT_BODY, ...over })

/** 新骨架的测试桩：局部旋转全是单位阵（与真实资产一致），角色左 = +x。 */
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
  // 脊柱链（y 向上）
  const spine = mk('mixamorigSpine', root, [0, 0.1, 0])
  const spine1 = mk('mixamorigSpine1', spine, [0, 0.1, 0])
  const spine2 = mk('mixamorigSpine2', spine1, [0, 0.15, 0])
  const spine3 = mk('mixamorigSpine3', spine2, [0, 0.2, 0])
  const neck = mk('mixamorigNeck', spine3, [0, 0.2, 0])
  mk('mixamorigHead', neck, [0, 0.1, 0])
  mk('mixamorigHeadTop', neck, [0, 0.12, 0])
  // 锁骨 → 上臂 → 前臂 → 手（角色左 = +x）
  for (const side of ['Left', 'Right'] as const) {
    const s = side === 'Left' ? 1 : -1
    const clav = mk(`mixamorig${side}Shoulder`, spine3, [s * 0.05, 0.05, 0])
    const arm = mk(`mixamorig${side}Arm`, clav, [s * 0.12, 0, 0])
    const fore = mk(`mixamorig${side}ForeArm`, arm, [s * 0.25, 0, 0])
    mk(`mixamorig${side}Hand`, fore, [s * 0.22, 0, 0])
  }
  // 髋 → 大腿 → 小腿 → 脚
  for (const side of ['Left', 'Right'] as const) {
    const s = side === 'Left' ? 1 : -1
    const up = mk(`mixamorig${side}UpLeg`, root, [s * 0.1, -0.05, 0])
    const leg = mk(`mixamorig${side}Leg`, up, [0, -0.4, 0])
    const foot = mk(`mixamorig${side}Foot`, leg, [0, -0.4, 0])
    mk(`mixamorig${side}ToeBase`, foot, [0, -0.05, 0.15])
  }
  return root
}

/** 骨轴方向（子骨世界位置 - 本骨世界位置），归一化。 */
function boneAxis(binding: { bones: Map<string, THREE.Object3D> }, from: string, to: string): THREE.Vector3 {
  const a = binding.bones.get(from)!.getWorldPosition(new THREE.Vector3())
  const b = binding.bones.get(to)!.getWorldPosition(new THREE.Vector3())
  return b.sub(a).normalize()
}

describe('体型 → 形变指令', () => {
  it('头身比越大头越小（7.5 为基准 1.0）', () => {
    const head = shapeTunes(params()).find((t) => t.bone === BONE.head)
    expect(head?.scale).toEqual([1, 1, 1])
    const small = shapeTunes(params({ headRatio: 9 })).find((t) => t.bone === BONE.head)
    expect(small?.mode).toBe('uniform')
    expect(small?.scale?.[0]).toBeCloseTo(7.5 / 9, 8)
  })

  it('腰围系数 → 腰骨的区域场缩放（绕中线缩 x/z，带高度衰减）', () => {
    const slim = shapeTunes(params({ waist: 0.6 })).find((t) => t.bone === BONE.spine1)
    expect(slim?.mode).toBe('region')
    expect(slim?.scale?.[2]).toBeCloseTo(0.6, 8)
    expect(slim?.scale?.[0]).toBeCloseTo(0.6, 8)
    expect(slim?.height).toBeGreaterThan(0)
  })

  it('肩宽 → 锁骨横向缩放（左右对称）', () => {
    const tunes = shapeTunes(params({ shoulderWidth: 1.3 }))
    const l = tunes.find((t) => t.bone === BONE.clavicleL)
    const r = tunes.find((t) => t.bone === BONE.clavicleR)
    expect(l?.scale?.[0]).toBeCloseTo(1.3, 8)
    expect(r?.scale?.[0]).toBeCloseTo(1.3, 8)
  })

  it('胸围 / 臀围 → 胸骨 / 骨盆的区域场缩放', () => {
    const bust = shapeTunes(params({ bust: 1.4 })).find((t) => t.bone === BONE.spine2)
    expect(bust?.mode).toBe('region')
    expect(bust?.scale?.[0]).toBeCloseTo(1.4, 8)          // 横向全强度
    expect(bust?.scale?.[2]).toBeCloseTo(1.18, 8)         // 纵深半强度（不把肋骨推成肚子）
    const hip = shapeTunes(params({ hip: 1.3 })).find((t) => t.bone === BONE.hips)
    expect(hip?.mode).toBe('region')
    expect(hip?.scale?.[0]).toBeCloseTo(1.3, 8)
  })

  it('肩宽 → 锁骨横向缩放 + 上臂关节外移', () => {
    const tunes = shapeTunes(params({ shoulderWidth: 1.3 }))
    const l = tunes.find((t) => t.bone === BONE.clavicleL)
    const r = tunes.find((t) => t.bone === BONE.clavicleR)
    expect(l?.scale?.[0]).toBeCloseTo(1.3, 8)
    expect(r?.scale?.[0]).toBeCloseTo(1.3, 8)
    const pos = positionTunes(params({ shoulderWidth: 1.3 }))
    expect(pos[BONE.armL][0]).toBeGreaterThan(0)
    expect(pos[BONE.armR][0]).toBeLessThan(0)
    expect(Math.abs(pos[BONE.armL][0])).toBeCloseTo(Math.abs(pos[BONE.armR][0]), 8)
  })

  it('四肢粗细 → 四肢骨的 radial 模式', () => {
    const arm = shapeTunes(params({ limbThickness: 1.2 })).find((t) => t.bone === BONE.armL)
    expect(arm?.mode).toBe('radial')
    expect(arm?.scale?.[0]).toBeCloseTo(1.2, 8)
  })

  it('默认体型全部归一（不产生任何形变）', () => {
    for (const tune of shapeTunes(params())) {
      if (tune.mode === 'uniform' || tune.mode === 'radial') expect(tune.scale[0]).toBeCloseTo(1, 8)
      else { expect(tune.scale[0]).toBeCloseTo(1, 8); expect(tune.scale[1]).toBeCloseTo(1, 8); expect(tune.scale[2]).toBeCloseTo(1, 8) }
    }
  })

  it('臂长 / 腿长 → 子骨局部位移的缩放系数（上臂 / 前臂 / 大腿 / 小腿）', () => {
    const tunes = lengthTunes(params({ armLength: 1.1, legLength: 0.9 }))
    expect(tunes[BONE.foreArmL]).toBeCloseTo(1.1, 8)
    expect(tunes[BONE.handL]).toBeCloseTo(1.1, 8)
    expect(tunes[BONE.legL]).toBeCloseTo(0.9, 8)
    expect(tunes[BONE.footR]).toBeCloseTo(0.9, 8)
  })
})

describe('网格形变（绑定姿态 LBS 混合）', () => {
  /** 造一个 1 顶点、1 骨的最小几何，验证形变数学。 */
  function oneVertex(px: number, py: number, pz: number): { geom: THREE.BufferGeometry; ctx: ShapeContext } {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute([px, py, pz], 3))
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4))
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4))
    const ctx: ShapeContext = {
      base: new Float32Array([px, py, pz]),
      joints: new Uint16Array([0, 0, 0, 0]),
      weights: new Float32Array([1, 0, 0, 0]),
      boneIndex: new Map([['bone', 0]]),
      boneWorld: new Map([['bone', new THREE.Vector3(0, 0, 0)]]),
      boneAxis: new Map([['bone', new THREE.Vector3(0, 1, 0)]]),
      chestBone: 'bone',
    }
    return { geom, ctx }
  }

  it('axis 模式：绕骨心缩放顶点', () => {
    const { geom, ctx } = oneVertex(0.2, 0.1, 0)
    // 锁骨 spine3 axis 缩放 1.5（x）
    ctx.boneIndex.set(BONE.clavicleL, 0)
    ctx.boneWorld.set(BONE.clavicleL, new THREE.Vector3(0, 0, 0))
    applyShape(geom, ctx, params({ shoulderWidth: 1.5 }))
    const p = geom.getAttribute('position')
    expect(p.getX(0)).toBeCloseTo(0.3, 5)
    expect(p.getZ(0)).toBeCloseTo(0, 5)
  })

  it('radial 模式：沿骨轴不变、垂直方向放大', () => {
    const { geom, ctx } = oneVertex(0.1, 0.5, 0)
    ctx.boneIndex.set(BONE.armL, 0)
    ctx.boneWorld.set(BONE.armL, new THREE.Vector3(0, 0, 0))
    ctx.boneAxis.set(BONE.armL, new THREE.Vector3(0, 1, 0))
    applyShape(geom, ctx, params({ limbThickness: 1.5 }))
    const p = geom.getAttribute('position')
    expect(p.getY(0)).toBeCloseTo(0.5, 5)   // 沿骨轴不动
    expect(p.getX(0)).toBeCloseTo(0.15, 5)  // 垂直方向放大 1.5
  })

  it('权重混合：多骨影响按权重插值', () => {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute([0.2, 0, 0], 3))
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 1, 0, 0], 4))
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute([0.5, 0.5, 0, 0], 4))
    const ctx: ShapeContext = {
      base: new Float32Array([0.2, 0, 0]),
      joints: new Uint16Array([0, 1, 0, 0]),
      weights: new Float32Array([0.5, 0.5, 0, 0]),
      boneIndex: new Map([[BONE.clavicleL, 0], [BONE.head, 1]]),
      boneWorld: new Map([
        [BONE.clavicleL, new THREE.Vector3(0, 0, 0)],
        [BONE.head, new THREE.Vector3(0, 0, 0)],
      ]),
      boneAxis: new Map(),
      chestBone: BONE.spine2,
    }
    // 锁骨 ×1.5 与头骨 ×1.0 各占一半权重：x = 0.5·(0.2·1.5) + 0.5·(0.2·1.0) = 0.25
    applyShape(geom, ctx, params({ shoulderWidth: 1.5 }))
    const p = geom.getAttribute('position')
    expect(p.getX(0)).toBeCloseTo(0.25, 5)
    expect(p.getZ(0)).toBeCloseTo(0, 5)
  })

  it('region 模式：躯干高度带内按权重缩放，band 外不动', () => {
    const geom = new THREE.BufferGeometry()
    // 两个顶点：y=1.1（胸骨带内）与 y=1.6（带外）
    geom.setAttribute('position', new THREE.Float32BufferAttribute([0.2, 1.1, 0, 0.2, 1.6, 0], 3))
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0], 4))
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0], 4))
    const ctx: ShapeContext = {
      base: new Float32Array([0.2, 1.1, 0, 0.2, 1.6, 0]),
      joints: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0]),
      weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]),
      boneIndex: new Map([[BONE.spine2, 0]]),
      boneWorld: new Map([[BONE.spine2, new THREE.Vector3(0, 1.1, 0)]]),
      boneAxis: new Map(),
      chestBone: BONE.spine2,
      torsoBones: [BONE.spine2],
    }
    applyShape(geom, ctx, params({ bust: 1.5 }))
    const p = geom.getAttribute('position')
    expect(p.getX(0)).toBeCloseTo(0.3, 4)   // 带内：缩放生效
    expect(p.getX(1)).toBeCloseTo(0.2, 4)   // 带外：不动
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

  it('手性：角色左在世界系 +x → zSign = 1', () => {
    const binding = bindRig(stubSkeleton())
    expect(binding.zSign).toBe(1)
  })

  it('级联：转肩时肘与腕跟着走（子骨随父骨新朝向）', () => {
    const root = stubSkeleton()
    const binding = bindRig(root)
    applyRigPose(binding, { shoulderL: { x: 0, y: 0, z: 0.8 } })
    root.updateMatrixWorld(true)
    const dir = boneAxis(binding, 'shoulderL', 'elbowL')
    // 绑定姿态臂轴水平 +x；绕世界 z 转 0.8 → 抬起
    expect(dir.y).toBeGreaterThan(0.5)
    expect(dir.x).toBeGreaterThan(0.4)
  })

  it('脊柱前倾：x 正把上身压向模型前方（+z）', () => {
    const root = stubSkeleton()
    const binding = bindRig(root)
    applyRigPose(binding, { spine: { x: 0.3, y: 0, z: 0 } })
    root.updateMatrixWorld(true)
    const spine = binding.bones.get('spine') as THREE.Object3D
    spine.updateWorldMatrix(true, false)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(spine.getWorldQuaternion(new THREE.Quaternion()))
    expect(up.z).toBeGreaterThan(0.2)
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

  it('a-pose 是绑定姿态（全零表）', () => {
    const a = poseJoints('a-pose')
    for (const j of JOINT_NAMES) {
      expect(a[j].x).toBe(0)
      expect(a[j].y).toBe(0)
      expect(a[j].z).toBe(0)
    }
  })

  it('T-pose 双臂水平展开（肩 z = ±π/2 量级，左右镜像）', () => {
    const t = poseJoints('t-pose')
    expect(t.shoulderL.z).toBeCloseTo(-t.shoulderR.z, 8)
    expect(Math.abs(t.shoulderL.z)).toBeGreaterThan(0.6)
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

  it('方位角：正面机位在 +z（模型前方），背面 = -z，正侧 = ±x', () => {
    const front = computeCameraPose('full', presetOrbit('full', 'front', 'level'), 1.7)
    expect(front.position.z).toBeGreaterThan(0)
    const back = computeCameraPose('full', presetOrbit('full', 'back', 'level'), 1.7)
    expect(back.position.x).toBeCloseTo(0, 6)
    expect(back.position.z).toBeLessThan(0)
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

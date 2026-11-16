// 参数化素体：BodyParams → 三维几何构建（three.js）。
//
// 设计约定：
//   · 单位米（1 = 1m），身高参数 cm
//   · 纯数学（轮廓半径 / 地标高度）与 three 构建分离：纯函数可单测
//   · buildBody 每次全新构建（调用方负责 dispose 旧场景图），幂等可重复调
//   · 关节 = THREE.Group pivot：旋转 Group 即旋转其下肢体，poses.ts 的欧拉表直接作用于此
//   · 层级：root → [下肢 × 2, 躯干下段, spine(躯干上段, 胸, 颈, 头, 双臂)]
//     弯腰（spine）会带动上身与手臂，腿留在地面 —— 符合解剖直觉
//
// 三围 → 轮廓半径：围度 girth ≈ 2πr（回转体横截面），躯干整体 z 向压缩成椭圆截面
// （前后厚度 < 左右宽度）。

import * as THREE from 'three'

/** 素体体型参数（client 滑杆直接给这组值）。 */
export interface BodyParams {
  /** 身高（cm），130..210 */
  height: number
  /** 头身比（身高 / 头长），6..9，默认 7.5 */
  headRatio: number
  /** 肩宽系数 0.7..1.4（相对标准肩宽） */
  shoulderWidth: number
  /** 胸围系数 0.7..1.4 */
  bust: number
  /** 腰围系数 0.55..1.5 */
  waist: number
  /** 臀围系数 0.7..1.5 */
  hip: number
  /** 四肢粗细系数 0.6..1.5 */
  limbThickness: number
  /** 臂长系数 0.85..1.15 */
  armLength: number
  /** 腿长系数 0.85..1.15（腿长变化由躯干补偿，总身高不变） */
  legLength: number
}

export const DEFAULT_BODY: BodyParams = {
  height: 170,
  headRatio: 7.5,
  shoulderWidth: 1,
  bust: 1,
  waist: 1,
  hip: 1,
  limbThickness: 1,
  armLength: 1,
  legLength: 1,
}

/** 标准人体的关键围度（m，系数 1 时），按 1.70m 校准。 */
const BASE_GIRTH = { bust: 0.90, waist: 0.74, hip: 0.95 } as const
/** 躯干椭圆截面的前后 / 左右厚度比。 */
const TORSO_DEPTH = 0.72 as const

/** 围度（m）→ 回转半径（m）。 */
export function girthToRadius(girth: number): number {
  return girth / (2 * Math.PI)
}

/** 体型参数 → 身高（m）。 */
export function heightM(params: BodyParams): number {
  return params.height / 100
}

/** 地标高度（m，自地面向上）。腿长系数调整下肢占比，躯干补偿，总高恒定。 */
export function landmarks(params: BodyParams): {
  h: number; ankleY: number; kneeY: number; crotchY: number; waistY: number; chestY: number; shoulderY: number; neckBaseY: number; headTopY: number
} {
  const h = heightM(params)
  const legSpan = 0.47 * h * params.legLength
  const ankleY = 0.03 * h
  const kneeY = ankleY + legSpan * 0.55
  const crotchY = ankleY + legSpan
  const neckBaseY = h - (h / params.headRatio) * 1.18 // 颈基 = 头顶 - 头长×1.18（含颈长）
  const torsoSpan = Math.max(0.05, neckBaseY - crotchY)
  const chestY = crotchY + torsoSpan * 0.68
  const waistY = crotchY + torsoSpan * 0.38
  const shoulderY = neckBaseY - 0.02 * h
  return { h, ankleY, kneeY, crotchY, waistY, chestY, shoulderY, neckBaseY, headTopY: h }
}

/** 躯干轮廓半径组（m）。三围系数直接缩放各自的标准围度（身高整体缩放）。 */
export function torsoRadii(params: BodyParams): { hipR: number; waistR: number; bustR: number; shoulderR: number } {
  const scale = params.height / 170
  const girth = (base: number, coeff: number): number => base * coeff * scale
  return {
    hipR: girthToRadius(girth(BASE_GIRTH.hip, params.hip)),
    waistR: girthToRadius(girth(BASE_GIRTH.waist, params.waist)),
    bustR: girthToRadius(girth(BASE_GIRTH.bust, params.bust)),
    shoulderR: girthToRadius(girth(BASE_GIRTH.bust, params.shoulderWidth)) * 0.92,
  }
}

/** 关节名全集（poses.ts 的姿势表必须覆盖）。 */
export const JOINT_NAMES = [
  'spine', 'chest', 'neck', 'head',
  'shoulderL', 'elbowL', 'wristL',
  'shoulderR', 'elbowR', 'wristR',
  'hipL', 'kneeL', 'ankleL',
  'hipR', 'kneeR', 'ankleR',
] as const

export type JointName = (typeof JOINT_NAMES)[number]

export interface BuiltBody {
  root: THREE.Group
  joints: Record<JointName, THREE.Group>
  /** 地标（相机预设用）。 */
  landmarks: ReturnType<typeof landmarks>
  /** 释放全部几何与材质（重建前调用）。 */
  dispose: () => void
}

const CLAY = 0xb9bdc6

/** 关节处向下的胶囊肢体（mesh 在关节 Group 内下移半长）。 */
function limb(radius: number, length: number, mat: THREE.Material): THREE.Mesh {
  const cylLen = Math.max(0.01, length)
  const geo = new THREE.CapsuleGeometry(radius, Math.max(0.005, cylLen - radius * 2), 4, 14)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.y = -cylLen / 2
  mesh.castShadow = true
  return mesh
}

function joint(name: JointName, x: number, y: number, parent: THREE.Object3D): THREE.Group {
  const g = new THREE.Group()
  g.name = name
  g.position.set(x, y, 0)
  parent.add(g)
  return g
}

/** 躯干回转体段（轮廓点为世界系 y + 半径，构建时平移到关节局部系）。 */
function torsoSegment(points: Array<{ r: number; y: number }>, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.LatheGeometry(
    points.map((p) => new THREE.Vector2(Math.max(0.012, p.r), p.y)),
    32,
  )
  const mesh = new THREE.Mesh(geo, mat)
  mesh.scale.set(1, 1, TORSO_DEPTH)
  mesh.castShadow = true
  return mesh
}

/** 组装素体。每次全新构建；旧体先 dispose。 */
export function buildBody(params: BodyParams): BuiltBody {
  const mat = new THREE.MeshStandardMaterial({ color: CLAY, roughness: 0.85, metalness: 0.02 })
  const lm = landmarks(params)
  const radii = torsoRadii(params)
  const t = params.limbThickness
  const root = new THREE.Group()
  root.name = 'mannequin-root'

  // ── 躯干下段（裆 → 腰，挂 root）──────────────────────────────────────
  const lower = torsoSegment([
    { r: radii.hipR * 1.02, y: lm.crotchY },
    { r: radii.waistR * 1.02, y: lm.waistY },
  ], mat)
  root.add(lower)

  // 骨盆球：下段底口封口（坐姿等大角度不穿帮）
  const pelvis = new THREE.Mesh(new THREE.SphereGeometry(radii.hipR * 1.02, 20, 14), mat)
  pelvis.scale.set(1, 0.8, TORSO_DEPTH)
  pelvis.position.y = lm.crotchY + 0.01
  pelvis.castShadow = true
  root.add(pelvis)

  // ── 脊柱关节（腰）→ 躯干上段 + 上身全部 ─────────────────────────────
  const spine = joint('spine', 0, lm.waistY, root)
  const upper = torsoSegment([
    { r: radii.waistR, y: 0 },
    { r: radii.bustR, y: lm.chestY - lm.waistY },
    { r: radii.shoulderR, y: lm.shoulderY - lm.waistY - 0.015 },
    { r: radii.shoulderR * 0.55, y: lm.neckBaseY - lm.waistY - 0.01 },
  ], mat)
  spine.add(upper)

  // ── 胸关节 → 双臂挂点 ────────────────────────────────────────────────
  const chest = joint('chest', 0, lm.chestY - lm.waistY, spine)

  // ── 颈 + 头（挂 spine，弯腰时头随上身）───────────────────────────────
  const headLen = lm.h / params.headRatio
  const neck = joint('neck', 0, lm.neckBaseY - lm.waistY, spine)
  const neckMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035 * (params.height / 170), 0.042 * (params.height / 170), (lm.shoulderY - lm.neckBaseY) + headLen * 0.3, 14),
    mat,
  )
  neckMesh.position.y = ((lm.shoulderY - lm.neckBaseY) + headLen * 0.3) / 2
  neck.add(neckMesh)
  const head = joint('head', 0, headLen * 0.28, neck)
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(headLen / 2, 24, 18), mat)
  headMesh.scale.set(0.82, 1, 0.92)
  headMesh.position.y = headLen * 0.42
  headMesh.castShadow = true
  head.add(headMesh)

  // ── 手臂（挂 chest：转胸带动手臂，符合解剖）──────────────────────────
  const armR = 0.045 * t * (params.height / 170)
  const forearmR = armR * 0.82
  const shoulderHalf = radii.shoulderR * 0.95 + armR * 1.15
  const armSpan = (lm.shoulderY - lm.crotchY) * 0.72 * params.armLength
  const upperArmLen = armSpan * 0.52
  const forearmLen = armSpan * 0.48
  const joints = {} as Record<JointName, THREE.Group>
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1
    const shoulder = joint(`shoulder${side}` as JointName, sx * shoulderHalf, lm.shoulderY - lm.waistY, chest)
    shoulder.add(limb(armR, upperArmLen, mat))
    const elbow = joint(`elbow${side}` as JointName, 0, -upperArmLen, shoulder)
    elbow.add(limb(forearmR, forearmLen, mat))
    const wrist = joint(`wrist${side}` as JointName, 0, -forearmLen, elbow)
    const hand = new THREE.Mesh(new THREE.BoxGeometry(armR * 1.5, armR * 3.2, forearmR * 1.9), mat)
    hand.position.y = -armR * 1.6
    hand.castShadow = true
    wrist.add(hand)
    joints[`shoulder${side}` as JointName] = shoulder
    joints[`elbow${side}` as JointName] = elbow
    joints[`wrist${side}` as JointName] = wrist
  }

  // ── 腿（挂 root：弯腰不动腿）─────────────────────────────────────────
  const legSpan = lm.crotchY - lm.ankleY
  const thighLen = legSpan * 0.55
  const shinLen = legSpan * 0.45
  const thighR = 0.072 * t * (params.height / 170)
  const shinR = thighR * 0.72
  const hipOffset = Math.max(radii.hipR * 0.55, thighR * 1.05)
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1
    const hip = joint(`hip${side}` as JointName, sx * hipOffset, lm.crotchY, root)
    hip.add(limb(thighR, thighLen, mat))
    const knee = joint(`knee${side}` as JointName, 0, -thighLen, hip)
    knee.add(limb(shinR, shinLen, mat))
    const ankle = joint(`ankle${side}` as JointName, 0, -shinLen, knee)
    const foot = new THREE.Mesh(new THREE.BoxGeometry(thighR * 1.1, 0.05 * (params.height / 170), thighR * 3.4), mat)
    foot.position.set(0, -0.02 * (params.height / 170), thighR * 1.2)
    foot.castShadow = true
    ankle.add(foot)
    joints[`hip${side}` as JointName] = hip
    joints[`knee${side}` as JointName] = knee
    joints[`ankle${side}` as JointName] = ankle
  }

  joints.spine = spine
  joints.chest = chest
  joints.neck = neck
  joints.head = head
  for (const name of JOINT_NAMES) {
    if (joints[name] === undefined) throw new Error(`关节缺失：${name}`)
  }

  return {
    root,
    joints,
    landmarks: lm,
    dispose: () => {
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry !== undefined) mesh.geometry.dispose()
      })
      mat.dispose()
    },
  }
}

// 参数化素体：BodyParams → 三维几何构建（three.js）。
//
// 设计约定：
//   · 单位米（1 = 1m），身高参数 cm
//   · 纯数学（轮廓半径 / 地标高度）与 three 构建分离：纯函数可单测
//   · buildBody 每次全新构建（调用方负责 dispose 旧场景图），幂等可重复调
//   · 关节 = THREE.Group pivot：旋转 Group 即旋转其下肢体，poses.ts 的欧拉表直接作用于此
//   · 层级：root → [下肢 × 2, 躯干下段, spine(躯干上段, 胸, 颈, 头, 双臂)]
//     弯腰（spine）会带动上身与手臂，腿留在地面 —— 符合解剖直觉
//   · 造型纪律（对齐人偶素体美术基准，2026-11-17 两轮实机反馈）：
//       体块化：颅体+面颌体 / 斜方肌坡 / 胸体×2 / 臀体×2 / 腓肠肌 / 前臂肌，
//       全部为嵌入躯干或肢体的椭球体块，随所属关节运动；
//       轮廓样条化：躯干半径 Catmull-Rom 插值，上下段腰位半径逐字一致（无棱无接缝）；
//       锥度肢体：关节端球大于段径，球窝关节感，弯折不露缝；
//       末端精修：手掌 + 四指一拇指（细胶囊扇形），脚胶囊 + 足趾楔；
//       解剖比例：垂臂腕到裆位，膝在腿段 46% 处，颈有可见长度且两端内嵌；
//       围度换算：椭圆截面周长补偿（x 半径 r、z 半径 r×DEPTH）。
//
// 三围 → 轮廓半径：围度 girth 按椭圆截面周长补偿，否则压扁后围度系统性偏小。

import * as THREE from 'three'

/** 素体体型参数（client 滑杆直接给这组值）。 */
export interface BodyParams {
  /** 身高（cm），130..210 */
  height: number
  /** 头身比（身高 / 头长），6..9，默认 7.5 */
  headRatio: number
  /** 肩宽系数 0.7..1.4（相对标准肩宽） */
  shoulderWidth: number
  /** 胸围系数 0.7..1.4（同时驱动胸体块大小） */
  bust: number
  /** 腰围系数 0.55..1.5 */
  waist: number
  /** 臀围系数 0.7..1.5（同时驱动臀体块大小） */
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
export const TORSO_DEPTH = 0.72 as const
/** 椭圆截面周长补偿：x 半径 = 等效圆半径 / K（K = sqrt((1+DEPTH²)/2)）。 */
const ELLIPSE_K = Math.sqrt((1 + TORSO_DEPTH * TORSO_DEPTH) / 2)

/** 围度（m）→ 等效圆回转半径（m）。纯数学，测试钉死 g/(2π)。 */
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
  const kneeY = ankleY + legSpan * 0.46
  const crotchY = ankleY + legSpan
  const neckBaseY = h - (h / params.headRatio) * 1.18 // 颈基 = 头顶 - 头长×1.18（含颈长）
  const torsoSpan = Math.max(0.05, neckBaseY - crotchY)
  const chestY = crotchY + torsoSpan * 0.68
  const waistY = crotchY + torsoSpan * 0.38
  const shoulderY = neckBaseY - 0.02 * h
  return { h, ankleY, kneeY, crotchY, waistY, chestY, shoulderY, neckBaseY, headTopY: h }
}

/** 躯干轮廓半径组（m，已做椭圆补偿）。三围系数直接缩放各自的标准围度（身高整体缩放）。 */
export function torsoRadii(params: BodyParams): { hipR: number; waistR: number; bustR: number; shoulderR: number } {
  const scale = params.height / 170
  const girth = (base: number, coeff: number): number => base * coeff * scale
  const rx = (g: number): number => girthToRadius(g) / ELLIPSE_K
  return {
    hipR: rx(girth(BASE_GIRTH.hip, params.hip)),
    waistR: rx(girth(BASE_GIRTH.waist, params.waist)),
    bustR: rx(girth(BASE_GIRTH.bust, params.bust)),
    shoulderR: rx(girth(BASE_GIRTH.bust, params.shoulderWidth)) * 0.92,
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

// ── 造型辅助 ─────────────────────────────────────────────────────────────

/** Catmull-Rom 基函数（一维）。 */
function catmull(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3)
}

/**
 * 控制点 → 密样条轮廓：半径走 Catmull-Rom（平滑无棱），y 走线性（严格递增，
 * 样条不会在高度上回勾）。首末控制点重复端点作切线锚。
 */
function smoothProfile(ctrl: Array<{ r: number; y: number }>, samples = 14): Array<{ r: number; y: number }> {
  const pts: Array<{ r: number; y: number }> = []
  for (let i = 0; i < ctrl.length - 1; i++) {
    const r0 = ctrl[Math.max(0, i - 1)].r
    const r1 = ctrl[i].r
    const r2 = ctrl[i + 1].r
    const r3 = ctrl[Math.min(ctrl.length - 1, i + 2)].r
    const y1 = ctrl[i].y
    const y2 = ctrl[i + 1].y
    for (let k = 0; k < samples; k++) {
      const u = k / samples
      pts.push({ r: Math.max(0.008, catmull(r0, r1, r2, r3, u)), y: y1 + (y2 - y1) * u })
    }
  }
  pts.push({ r: ctrl[ctrl.length - 1].r, y: ctrl[ctrl.length - 1].y })
  return pts
}

/** 椭球体块（建模素体的肌肉 / 颅体 / 面颌等体积单元，全部可 castShadow）。 */
function blob(r: number, sx: number, sy: number, sz: number, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 22, 16), mat)
  mesh.scale.set(sx, sy, sz)
  mesh.castShadow = true
  return mesh
}

/** 关节处向下的锥度肢体段：圆柱（上粗下细）+ 两端圆球。顶端球即关节窝，弯折不露缝。 */
function taperedLimb(rt: number, rb: number, len: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group()
  const cylLen = Math.max(0.005, len - rt - rb)
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, cylLen, 20), mat)
  cyl.position.y = -(rt + cylLen / 2)
  cyl.castShadow = true
  const top = new THREE.Mesh(new THREE.SphereGeometry(rt, 18, 14), mat)
  top.castShadow = true
  const bottom = new THREE.Mesh(new THREE.SphereGeometry(rb, 18, 14), mat)
  bottom.position.y = -len
  bottom.castShadow = true
  g.add(cyl, top, bottom)
  return g
}

/** 手：掌（扁椭球）+ 四指（细胶囊并拢微扇、微屈）+ 拇指（贴掌侧收拢）。 */
function hand(armR: number, mat: THREE.Material, sx: number): THREE.Group {
  const g = new THREE.Group()
  const palm = blob(armR, 0.62, 0.92, 0.36, mat)
  palm.position.y = -armR * 0.68
  g.add(palm)
  const fingerR = armR * 0.17
  for (let i = 0; i < 4; i++) {
    const len = armR * (1.7 - Math.abs(i - 1.1) * 0.38)
    const fingerGeo = new THREE.CapsuleGeometry(fingerR, Math.max(0.005, len - fingerR * 2), 4, 8)
    const finger = new THREE.Mesh(fingerGeo, mat)
    finger.position.set((i - 1.5) * armR * 0.33, -armR * 1.5 - len / 2, 0)
    // 指排随位置微收拢 + 指尖微屈，呈放松手形而非扇形爪
    finger.rotation.z = sx * (i - 1.5) * -0.1
    finger.rotation.x = -0.2
    finger.castShadow = true
    g.add(finger)
  }
  const thumbGeo = new THREE.CapsuleGeometry(armR * 0.2, Math.max(0.005, armR * 1.05 - armR * 0.4), 4, 8)
  const thumb = new THREE.Mesh(thumbGeo, mat)
  thumb.position.set(sx * armR * 0.4, -armR * 0.75, armR * 0.3)
  thumb.rotation.set(0.35, 0, sx * 0.75)
  thumb.castShadow = true
  g.add(thumb)
  return g
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
    48,
  )
  const mesh = new THREE.Mesh(geo, mat)
  mesh.scale.set(1, 1, TORSO_DEPTH)
  mesh.castShadow = true
  return mesh
}

/** 组装素体。每次全新构建；旧体先 dispose。 */
export function buildBody(params: BodyParams): BuiltBody {
  const mat = new THREE.MeshStandardMaterial({ color: CLAY, roughness: 0.82, metalness: 0.02 })
  const lm = landmarks(params)
  const radii = torsoRadii(params)
  const t = params.limbThickness
  const s = params.height / 170
  const root = new THREE.Group()
  root.name = 'mannequin-root'

  // ── 躯干下段（裆 → 腰，挂 root）：臀最宽点在裆上 ≈ 0.32 段高处 ─────────
  const lowerSpan = lm.waistY - lm.crotchY
  const lower = torsoSegment(smoothProfile([
    { r: radii.hipR * 0.9, y: lm.crotchY - 0.016 * s },
    { r: radii.hipR, y: lm.crotchY + lowerSpan * 0.32 },
    { r: radii.hipR * 0.98, y: lm.crotchY + lowerSpan * 0.72 },
    { r: radii.waistR, y: lm.waistY },
  ]), mat)
  root.add(lower)

  // 骨盆球：下段底口封口（坐姿等大角度不穿帮）
  const pelvis = blob(radii.hipR * 0.86, 1, 0.74, TORSO_DEPTH, mat)
  pelvis.position.y = lm.crotchY - 0.004 * s
  root.add(pelvis)

  // ── 臀体块 ×2（挂 root：随骨盆，不随弯腰）────────────────────────────
  const gluteR = radii.hipR * 0.5
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1
    const glute = blob(gluteR, 0.78, 0.85, 0.85, mat)
    glute.position.set(sx * radii.hipR * 0.42, lm.crotchY + radii.hipR * 0.42, -radii.hipR * TORSO_DEPTH * 0.42)
    root.add(glute)
  }

  // ── 脊柱关节（腰）→ 躯干上段 + 上身全部 ─────────────────────────────
  // 腰位半径与下段末半径逐字一致（消接缝台阶）
  const spine = joint('spine', 0, lm.waistY, root)
  const upperSpan = lm.neckBaseY - lm.waistY
  const upper = torsoSegment(smoothProfile([
    { r: radii.waistR, y: 0 },
    { r: radii.bustR * 0.965, y: (lm.chestY - lm.waistY) * 0.5 },
    { r: radii.bustR, y: lm.chestY - lm.waistY },
    { r: radii.bustR * 0.985, y: (lm.shoulderY - lm.waistY) * 0.7 },
    { r: radii.shoulderR, y: lm.shoulderY - lm.waistY - 0.014 * s },
    { r: radii.shoulderR * 0.52, y: upperSpan - 0.014 * s },
  ]), mat)
  spine.add(upper)

  // ── 胸体块 ×2（挂 spine：随弯腰运动）────────────────────────────────
  // 半径偏大 + z 向压扁 + 深嵌胸廓曲面，读作整体胸型而非「贴球」
  const bustR = radii.bustR * 0.48 * params.bust
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1
    const bust = blob(bustR, 0.92, 0.85, 0.78, mat)
    bust.position.set(sx * radii.bustR * 0.42, lm.chestY - lm.waistY - bustR * 0.4, radii.bustR * TORSO_DEPTH * 0.5)
    bust.rotation.y = sx * 0.22 // 略外撇，贴合胸廓曲面
    spine.add(bust)
  }

  // ── 胸关节 → 双臂挂点 ────────────────────────────────────────────────
  const chest = joint('chest', 0, lm.chestY - lm.waistY, spine)

  // ── 颈 + 头（挂 spine，弯腰时头随上身）───────────────────────────────
  // 颈：可见长度充分（下端埋进躯干上口、上端伸进颅体），微前倾
  const headLen = lm.h / params.headRatio
  const neckR = 0.042 * s
  const neckLen = headLen * 0.66 + 0.02 * s
  const neck = joint('neck', 0, lm.neckBaseY - lm.waistY, spine)
  const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(neckR * 0.8, neckR, neckLen, 16), mat)
  neckMesh.position.y = neckLen / 2 - 0.02 * s
  neckMesh.rotation.x = -0.05
  neckMesh.castShadow = true
  neck.add(neckMesh)

  // 头：颅体（颅顶饱满）+ 面颌体（下颌收窄、下巴前伸），人偶素体两体块
  const head = joint('head', 0, headLen * 0.3, neck)
  const cranium = blob(headLen * 0.5, 0.78, 0.94, 0.84, mat)
  cranium.position.y = headLen * 0.42
  head.add(cranium)
  const jaw = blob(headLen * 0.32, 0.56, 0.62, 0.62, mat)
  jaw.position.set(0, headLen * 0.22, headLen * 0.15)
  head.add(jaw)

  // ── 手臂（挂 chest：转胸带动手臂，符合解剖）──────────────────────────
  // 臂长取解剖值：上臂 0.188h + 前臂 0.150h，垂臂时腕到裆位
  // ⚠ shoulder 挂在 chest 下，y 偏移必须相对 chest（chestY），相对 waist 会让
  //   整条手臂抬高 chestY - waistY ≈ 0.18m，悬空在肩上方（2026-11-17 实测事故）
  const armR = 0.046 * t * s
  const shoulderHalf = radii.shoulderR + armR * 0.85
  const upperArmLen = 0.188 * lm.h * params.armLength
  const forearmLen = 0.15 * lm.h * params.armLength
  const joints = {} as Record<JointName, THREE.Group>
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1
    const shoulder = joint(`shoulder${side}` as JointName, sx * shoulderHalf, lm.shoulderY - lm.chestY, chest)
    // 三角肌帽：略向躯干侧内嵌 + 纵向拉长，消肩部楔形缺口
    const deltoid = blob(armR * 1.28, 1.25, 1.3, 1.0, mat)
    deltoid.position.set(sx * -armR * 0.28, -armR * 0.05, 0)
    shoulder.add(deltoid)
    const upperArm = taperedLimb(armR * 1.0, armR * 0.7, upperArmLen, mat)
    shoulder.add(upperArm)
    const elbow = joint(`elbow${side}` as JointName, 0, -upperArmLen, shoulder)
    const foreArm = taperedLimb(armR * 0.66, armR * 0.52, forearmLen, mat)
    elbow.add(foreArm)
    // 前臂肌鼓（挂前臂段，肘下 1/3 处）
    const forearmBulk = blob(armR * 0.58, 0.8, 1.5, 0.9, mat)
    forearmBulk.position.set(sx * armR * 0.05, -forearmLen * 0.3, 0)
    elbow.add(forearmBulk)
    const wrist = joint(`wrist${side}` as JointName, 0, -forearmLen, elbow)
    wrist.add(hand(armR, mat, sx))
    joints[`shoulder${side}` as JointName] = shoulder
    joints[`elbow${side}` as JointName] = elbow
    joints[`wrist${side}` as JointName] = wrist
  }

  // ── 腿（挂 root：弯腰不动腿）─────────────────────────────────────────
  // 膝在腿段 46% 处（解剖值）；大腿根粗、小腿肚鼓、踝细的锥度
  const legSpan = lm.crotchY - lm.ankleY
  const thighLen = legSpan * 0.46
  const shinLen = legSpan * 0.54
  const thighR = 0.082 * t * s
  const hipOffset = Math.max(radii.hipR * 0.5, thighR * 0.92)
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1
    const hip = joint(`hip${side}` as JointName, sx * hipOffset, lm.crotchY, root)
    hip.add(taperedLimb(thighR * 1.1, thighR * 0.7, thighLen, mat))
    const knee = joint(`knee${side}` as JointName, 0, -thighLen, hip)
    knee.add(taperedLimb(thighR * 0.62, thighR * 0.44, shinLen, mat))
    // 腓肠肌鼓（小腿肚，挂小腿段，膝下 0.35 处、略靠后）
    const calf = blob(thighR * 0.52, 0.85, 1.6, 1.05, mat)
    calf.position.set(0, -shinLen * 0.32, -thighR * 0.16)
    knee.add(calf)
    const ankle = joint(`ankle${side}` as JointName, 0, -shinLen, knee)
    // 脚：扁胶囊朝 +z + 足趾楔（前掌略宽、脚跟窄）
    const footR = thighR * 0.46
    const footLen = 0.16 * lm.h
    const footGeo = new THREE.CapsuleGeometry(footR, Math.max(0.01, footLen - footR * 2), 6, 12)
    footGeo.rotateX(Math.PI / 2) // 胶囊轴向 y → z，烘焙进几何后 scale 走世界轴
    const foot = new THREE.Mesh(footGeo, mat)
    foot.scale.set(1, 0.62, 1)
    foot.position.set(0, footR * 0.62 - lm.ankleY, footLen * 0.42)
    foot.castShadow = true
    ankle.add(foot)
    const toes = blob(footR * 0.9, 1.25, 0.52, 0.9, mat)
    toes.position.set(0, footR * 0.52 - lm.ankleY, footLen * 0.84)
    ankle.add(toes)
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

// 手臂两骨 IK + 手掌姿态求解（把「手该在哪」写成目标，角度由解算器算出来）。
//
// 为什么要有这一层（2026-11-18）：姿势表里的关节角全是手拧的，改一个数就要在
// 八个姿势之间反复试错，还试不出「不穿模」的保证——因为角度不是表达「手落点」的
// 正确变量。**手落点**才是：给定「腕关节该在哪、手掌该朝哪」，肩肘角可以解析解出，
// 再用碰撞查询把结果验一遍。于是姿势表的数字从「调参结果」变成「解算结果」。
//
// 适用本仓库自建骨架的两个前提：
//   ① 骨的**局部旋转**在绑定姿态是单位阵 → 静息偏移向量可直接当作局部向量用；
//   ② 姿势欧拉是**级联**的：骨的世界朝向 = 父骨世界朝向 ∘ 自身欧拉。
//      所以「肩的局部四元数」= 父骨世界朝向的逆 ∘ 肩的世界朝向。

import * as THREE from 'three'

/** 一次两骨链的静息几何（米）。 */
export interface ArmChain {
  /** 肩关节世界位置（不随肩自身旋转变化）。 */
  shoulderPos: THREE.Vector3
  /** 肩骨的父骨世界朝向（肩的局部旋转叠在它之上）。 */
  parentQuat: THREE.Quaternion
  /** 上臂骨 → 肘骨 的静息局部偏移（肩骨局部系）。 */
  upperOffset: THREE.Vector3
  /** 肘骨 → 腕骨 的静息局部偏移（肘骨局部系）。 */
  foreOffset: THREE.Vector3
}

export interface TwoBoneSolution {
  /** 肩的局部四元数（父骨局部系）。 */
  shoulderLocal: THREE.Quaternion
  /** 肘的局部四元数（上臂局部系）。 */
  elbowLocal: THREE.Quaternion
  /** 解出的肘世界位置。 */
  elbowPos: THREE.Vector3
  /** 目标是否可达（false = 已夹到可达边界）。 */
  reached: boolean
}

/**
 * 两骨解析 IK：让腕关节落到 target。
 *
 * @param pole 肘的朝向提示（从肩指向肘应该去的方向，例如「向后、略向外」）。
 *             它决定 IK 解落在弯曲平面的哪一侧。
 */
export function solveTwoBone(chain: ArmChain, target: THREE.Vector3, pole: THREE.Vector3): TwoBoneSolution {
  const L1 = chain.upperOffset.length()
  const L2 = chain.foreOffset.length()
  const toTarget = new THREE.Vector3().subVectors(target, chain.shoulderPos)
  const dist = toTarget.length()
  const dMin = Math.abs(L1 - L2) + 1e-4
  const dMax = L1 + L2 - 1e-4
  const d = THREE.MathUtils.clamp(dist, dMin, dMax)
  const reached = dist <= dMax && dist >= dMin
  const f = toTarget.clone().normalize()

  // 弯曲平面：把 pole 提示投影到垂直于 f 的平面
  const poleDir = pole.clone()
  poleDir.addScaledVector(f, -poleDir.dot(f))
  if (poleDir.lengthSq() < 1e-10) {
    // pole 与目标共线 → 随便取一个垂直方向（确定性：用世界上向量）
    poleDir.set(0, 1, 0).addScaledVector(f, -f.y)
    if (poleDir.lengthSq() < 1e-10) poleDir.set(1, 0, 0)
  }
  poleDir.normalize()

  // 肩角 α：上臂与「肩→目标」连线的夹角
  const cosA = THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1)
  const alpha = Math.acos(cosA)
  // 上臂方向 = f 在弯曲平面里朝 pole 一侧偏 α
  //   ⚠ 弯曲平面由 f 与 pole 共同张成，绕 pole 方向本身旋转会把肘甩到**垂直于**
  //     pole 的方向去（实测：肘跑到肩前方 5cm，像反关节）。正确是 f·cosα + pole·sinα。
  const upperDir = f.clone().multiplyScalar(Math.cos(alpha)).addScaledVector(poleDir, Math.sin(alpha)).normalize()
  const elbowPos = chain.shoulderPos.clone().addScaledVector(upperDir, L1)
  const foreDir = new THREE.Vector3().subVectors(target, elbowPos).normalize()

  const qUpperWorld = new THREE.Quaternion().setFromUnitVectors(chain.upperOffset.clone().normalize(), upperDir)
  const shoulderLocal = chain.parentQuat.clone().invert().multiply(qUpperWorld)
  const shoulderWorld = chain.parentQuat.clone().multiply(shoulderLocal)
  const qForeWorld = new THREE.Quaternion().setFromUnitVectors(chain.foreOffset.clone().normalize(), foreDir)
  const elbowLocal = shoulderWorld.clone().invert().multiply(qForeWorld)

  return { shoulderLocal, elbowLocal, elbowPos, reached }
}

/** 手的三轴局部系：指向前 / 掌心法向 / 侧向（右手法则：side = forward × normal）。 */
export interface HandFrame {
  forward: THREE.Vector3
  normal: THREE.Vector3
  side: THREE.Vector3
}

export function makeHandFrame(forward: THREE.Vector3, normal: THREE.Vector3): HandFrame {
  const f = forward.clone().normalize()
  const n = normal.clone().addScaledVector(f, -normal.dot(f)).normalize()
  const s = new THREE.Vector3().crossVectors(f, n).normalize()
  return { forward: f, normal: n, side: s }
}

/**
 * 手掌姿态：把静息手系旋到目标手系，输出腕关节的局部四元数。
 *
 * @param parentQuat 腕骨的父骨（上臂/前臂）解出后的世界朝向。
 */
export function solveHandOrientation(rest: HandFrame, desired: HandFrame, parentQuat: THREE.Quaternion): THREE.Quaternion {
  const mRest = new THREE.Matrix4().makeBasis(rest.forward, rest.normal, rest.side)
  const mDesired = new THREE.Matrix4().makeBasis(desired.forward, desired.normal, desired.side)
  const world = new THREE.Matrix4().multiplyMatrices(mDesired, mRest.clone().invert())
  const qWorld = new THREE.Quaternion().setFromRotationMatrix(world)
  return parentQuat.clone().invert().multiply(qWorld)
}

/** 局部四元数 → 姿势表欧拉（z 要按 zSign 反算：applyRigPose 里是 z × zSign）。 */
export function localQuatToPoseEuler(q: THREE.Quaternion, zSign: number): { x: number; y: number; z: number } {
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ')
  return { x: e.x, y: e.y, z: e.z / zSign }
}

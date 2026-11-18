// 手部姿态体检：量「手轴 vs 大腿轴」「掌心法向 vs 大腿面法向」「腕/指尖位置」。
//
// 为什么要有这个脚本：姿势表里的角度是级联欧拉，单看数字读不出手到底朝哪；
// 之前「手穿模」「爪子」的争论全靠肉眼截图，既不准也慢。这里把判据变成数字。
//
// 用法：node --experimental-strip-types scripts/check-hand.ts <poseId> [L|R]

import * as THREE from 'three'
import { poseJoints, normalizePose } from '../src/client/mannequin/poses.ts'
import { applyRigPose } from '../src/client/mannequin/rig.ts'
import { loadRigFixture } from '../tests/helpers/rig-fixture.ts'

const fx = loadRigFixture()
const poseId = process.argv[2] ?? 'sit'
const side = (process.argv[3] ?? 'L') === 'R' ? 'Right' : 'Left'

const joints = normalizePose(poseJoints(poseId))
applyRigPose({ bones: fx.bones, zSign: fx.zSign } as never, joints)
fx.root.updateMatrixWorld(true)

const dominantOf = (i: number): string => {
  let bw = 0, bj = 0
  for (let k = 0; k < 4; k++) {
    const w = fx.skinWeight.getComponent(i, k)
    if (w > bw) { bw = w; bj = fx.skinIndex.getComponent(i, k) }
  }
  return fx.boneList[bj]?.name ?? ''
}
const vertsOf = (pred: (b: string) => boolean): number[] => {
  const out: number[] = []
  for (let i = 0; i < fx.position.count; i++) if (pred(dominantOf(i))) out.push(i)
  return out
}

// 蒙皮后的手部顶点
const m = new THREE.Matrix4()
const v = new THREE.Vector3()
const skinned = (indices: number[]): THREE.Vector3[] => {
  const out: THREE.Vector3[] = []
  for (const i of indices) {
    const px = fx.position.getX(i), py = fx.position.getY(i), pz = fx.position.getZ(i)
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 4; k++) {
      const w = fx.skinWeight.getComponent(i, k)
      if (w === 0) continue
      const b = fx.skinIndex.getComponent(i, k)
      const bone = fx.boneList[b]
      if (bone === undefined) continue
      m.multiplyMatrices(bone.matrixWorld, fx.boneInverses[b])
      v.set(px, py, pz).applyMatrix4(m)
      x += w * v.x; y += w * v.y; z += w * v.z
    }
    out.push(new THREE.Vector3(x, y, z))
  }
  return out
}

const wrist = fx.byName.get(`mixamorig${side}Hand`)!.getWorldPosition(new THREE.Vector3())
const elbow = fx.byName.get(`mixamorig${side}ForeArm`)!.getWorldPosition(new THREE.Vector3())
const shoulder = fx.byName.get(`mixamorig${side}Arm`)!.getWorldPosition(new THREE.Vector3())
const hip = fx.byName.get(`mixamorig${side}UpLeg`)!.getWorldPosition(new THREE.Vector3())
const knee = fx.byName.get(`mixamorig${side}Leg`)!.getWorldPosition(new THREE.Vector3())

// 指尖：**离腕最远的那批手部顶点**的质心。
// ⚠ 不能用 HandEnd 骨的顶点：实测它离腕只有 3.5cm（不是指尖），
//   拿它算手轴会把「手的方向」算成任意方向，掌心法向判定随之全废。
const handVertIdx = vertsOf((b) => b === `mixamorig${side}Hand` || b === `mixamorig${side}HandEnd`)
const handSkinned = skinned(handVertIdx)
const maxDist = Math.max(...handSkinned.map((p) => p.distanceTo(wrist)))
const tipCentroid = handSkinned.filter((p) => p.distanceTo(wrist) > maxDist * 0.8)
  .reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / handSkinned.filter((p) => p.distanceTo(wrist) > maxDist * 0.8).length)
const handAxis = tipCentroid.clone().sub(wrist).normalize()
const thighAxis = knee.clone().sub(hip).normalize()

// 掌心法向：手部中段顶点的法线均值（bind 法线，蒙皮后法线会变，这里用 bind 的近似）
const palmVerts = skinned(vertsOf((b) => b === `mixamorig${side}Hand` || b === `mixamorig${side}HandEnd`))
const handLen = Math.max(...palmVerts.map((p) => p.distanceTo(wrist)))
const handQuat = fx.byName.get(`mixamorig${side}Hand`)!.getWorldQuaternion(new THREE.Quaternion())
const palmNormal = new THREE.Vector3()
// 区域选择要用**蒙皮后**的坐标（拿绑定坐标算「沿手轴的位置」在姿势态是错的）
for (let k = 0; k < handVertIdx.length; k++) {
  const p = handSkinned[k]
  const along = p.clone().sub(wrist).dot(handAxis)
  if (along < handLen * 0.3 || along > handLen * 0.7) continue
  const i = handVertIdx[k]
  palmNormal.add(new THREE.Vector3(fx.normal.getX(i), fx.normal.getY(i), fx.normal.getZ(i)))
}
palmNormal.normalize()
// 绑定法向是绑定姿态的量，要跟着手骨的世界旋转转到当前姿态
palmNormal.applyQuaternion(handQuat)

// 大腿面法向：垂直于大腿轴、指向「上」
const thighUp = new THREE.Vector3(0, 1, 0).addScaledVector(thighAxis, -thighAxis.y).normalize()
const deg = (v: number) => (v * 180 / Math.PI).toFixed(1)
const angle = (a: THREE.Vector3, b: THREE.Vector3) => Math.acos(Math.max(-1, Math.min(1, a.dot(b))))

console.log(`[${poseId} ${side}]`)
console.log(`  肩 ${fmt(shoulder)}  肘 ${fmt(elbow)}  腕 ${fmt(wrist)}`)
console.log(`  髋 ${fmt(hip)}  膝 ${fmt(knee)}`)
console.log(`  指尖质心 ${fmt(tipCentroid)}  指尖离腕 ${(tipCentroid.distanceTo(wrist) * 100).toFixed(1)}cm`)
console.log(`  手轴 vs 大腿轴 = ${deg(angle(handAxis, thighAxis))}°（0 = 指尖顺着大腿朝膝）`)
console.log(`  掌心法向 vs 大腿上方 = ${deg(angle(palmNormal, thighUp))}°（180 = 掌心朝下贴腿面）`)
const foreAxis = wrist.clone().sub(elbow).normalize()
console.log(`  前臂轴 vs 手轴 = ${deg(angle(foreAxis, handAxis))}°（腕屈角）`)
console.log(`  前臂轴 vs 大腿轴 = ${deg(angle(foreAxis, thighAxis))}°`)
console.log(`  肘角（上下臂夹角）= ${deg(angle(shoulder.clone().sub(elbow).normalize(), foreAxis))}°（180 = 伸直）`)
console.log(`  腕相对大腿轴的高度 = ${((wrist.clone().sub(hip).addScaledVector(thighAxis, -wrist.clone().sub(hip).dot(thighAxis)).dot(thighUp)) * 100).toFixed(1)}cm`)

function fmt(p: THREE.Vector3): string {
  return `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`
}

// 关节塌陷门禁：LBS 在大角度屈曲时会把关节处的体积压掉（膝盖「压扁」）。
//
// 判据：关节邻域（膝上方 2cm 的一圈顶点）到「骨轴线」的半径，
// 姿势态 / 绑定姿态。纯刚性蒙皮时这个比值恒为 1（半径随骨刚性转动），
// 掉下来就是关节被两骨权重平均拉扁了（糖果纸效应）。
//
// 实测（修权重前 → 修权重后）：
//   坐姿膝 0.82 → 0.98、跪坐膝 0.76 → 0.90、跑步摆动腿膝 0.86 → 0.98。
//
// 2026-11-18：根因是「距离权重」在关节处忽略轴向位置（膝上方 3cm 的顶点到
// 大腿段与小腿段的距离几乎相等 → 两骨各 50%）。修法是链向互补分配（见
// scripts/build-mannequin-body.mjs 的 4c 段）+ 前后解剖偏置。

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { POSES, poseJoints } from '../src/client/mannequin/poses.ts'
import { applyRigPose, type RigBinding } from '../src/client/mannequin/rig.ts'
import { loadRigFixture } from './helpers/rig-fixture.ts'

const fixture = loadRigFixture()
const binding = { bones: fixture.bones, zSign: fixture.zSign } as unknown as RigBinding

/** 关节邻域顶点（绑定姿态下按主导骨 + 距关节的轴向距离筛）。 */
function bandVerts(centerBone: string, bones: string[], axisBone: string, lo: number, hi: number): number[] {
  const boneSet = new Set(bones)
  const obj = fixture.byName.get(centerBone)
  if (obj === undefined) return []
  const c = obj.getWorldPosition(new THREE.Vector3())
  // 轴线取**父骨**（大腿）方向：膝环上的顶点属于大腿，半径要相对大腿轴量。
  // （用小腿轴会量到「沿腿的轴向偏移」，姿势一变就假性变化。）
  const axis = fixture.byName.get(axisBone)!.getWorldPosition(new THREE.Vector3()).sub(c).normalize()
  const out: number[] = []
  const { position, skinIndex, skinWeight, boneList } = fixture
  for (let i = 0; i < position.count; i++) {
    let bw = 0, bj = 0
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k)
      if (w > bw) { bw = w; bj = skinIndex.getComponent(i, k) }
    }
    if (!boneSet.has(boneList[bj]?.name ?? '')) continue
    const p = new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i))
    const t = p.sub(c).dot(axis)
    if (t < lo || t > hi) continue
    out.push(i)
  }
  return out
}

/** 蒙皮后，band 顶点到「关节轴线」的平均半径（米）。 */
function ringRadius(band: number[], axis: THREE.Vector3, center: THREE.Vector3, skinned: Float32Array): number {
  let sum = 0
  for (const vi of band) {
    const p = new THREE.Vector3(skinned[vi * 3], skinned[vi * 3 + 1], skinned[vi * 3 + 2])
    const r = p.sub(center)
    const t = r.dot(axis)
    sum += Math.hypot(r.x - axis.x * t, r.y - axis.y * t, r.z - axis.z * t)
  }
  return sum / Math.max(1, band.length)
}

function skinAll(joints: ReturnType<typeof poseJoints>): Float32Array {
  applyRigPose(binding, joints)
  fixture.root.updateMatrixWorld(true)
  const { position, skinIndex, skinWeight, boneList, boneInverses } = fixture
  const out = new Float32Array(position.count * 3)
  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    const px = position.getX(i), py = position.getY(i), pz = position.getZ(i)
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k)
      if (w === 0) continue
      const b = skinIndex.getComponent(i, k)
      const bone = boneList[b]
      if (bone === undefined) continue
      m.multiplyMatrices(bone.matrixWorld, boneInverses[b])
      v.set(px, py, pz).applyMatrix4(m)
      x += w * v.x; y += w * v.y; z += w * v.z
    }
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z
  }
  return out
}

describe('关节不塌陷（膝盖压扁门禁）', () => {
  const KNEE_L = {
    center: 'mixamorigLeftLeg',
    bones: ['mixamorigLeftUpLeg', 'mixamorigLeftLeg'],
    axis: 'mixamorigLeftUpLeg',
  }
  // 取大腿上「膝上方 2–10cm」这一段（膝盖本体），而不是紧贴关节缝的 2cm：
  // 后者几乎全是过渡带顶点，量到的是混合权重本身，不是「膝盖看起来扁不扁」。
  const band = bandVerts(KNEE_L.center, KNEE_L.bones, KNEE_L.axis, -0.10, -0.02)
  const bindSkin = skinAll(poseJoints('a-pose'))
  const bindCenter = fixture.byName.get(KNEE_L.center)!.getWorldPosition(new THREE.Vector3())
  const bindAxis = fixture.byName.get(KNEE_L.axis)!.getWorldPosition(new THREE.Vector3()).sub(bindCenter).normalize()
  const base = ringRadius(band, bindAxis, bindCenter, bindSkin)

  it('膝邻域样本足够（别让门禁悄悄失效）', () => {
    expect(band.length, '膝环顶点样本').toBeGreaterThan(20)
  })

  for (const pose of POSES) {
    it(`${pose.id}（${pose.title}）：膝环半径不塌陷`, () => {
      const sk = skinAll(poseJoints(pose.id))
      const center = fixture.byName.get(KNEE_L.center)!.getWorldPosition(new THREE.Vector3())
      const axis = fixture.byName.get(KNEE_L.axis)!.getWorldPosition(new THREE.Vector3()).sub(center).normalize()
      const r = ringRadius(band, axis, center, sk)
      const ratio = r / base
      // 阈值随屈曲角放宽：LBS 的塌陷量随屈曲角单调上升（实测 80°→93%、
      // 100°→88%、143°→79%），跪坐要坐在脚跟上、膝必须折 140° 以上，
      // 这是 LBS 的固有极限（要彻底解决得换 DQS 蒙皮）。
      const kneeAngle = Math.abs(poseJoints(pose.id).kneeL?.x ?? 0)
      const floor = kneeAngle > 1.8 ? 0.76 : 0.88
      expect(ratio, `${pose.id} 膝环半径比 ${(ratio * 100).toFixed(1)}%（下限 ${(floor * 100).toFixed(0)}%）`)
        .toBeGreaterThanOrEqual(floor)
    })
  }
})

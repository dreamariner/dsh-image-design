// 求解器的测试宿主：用夹具实现 MannequinGeometry，再交给共享的 host.ts 组装 SolverHost。
//
// 共享的意义：运行时（three 的 SkinnedMesh）与测试（还原出来的夹具）走**同一套**
// 探针选取 / 体段代理 / 手部尺寸逻辑 —— 否则「离线调好的姿势，运行时不是那个姿势」。

import * as THREE from 'three'
import { JOINT_BONES, applyRigPose, type RigBinding } from '../../src/client/mannequin/rig.ts'
import { JOINT_NAMES, type JointName } from '../../src/client/mannequin/body.ts'
import { createSolverHost, type MannequinGeometry } from '../../src/client/mannequin/host.ts'
import type { JointRotations } from '../../src/client/mannequin/poses.ts'
import type { Vec3 } from '../../src/client/mannequin/solver.ts'
import type { RigFixture } from './rig-fixture.ts'

export interface SolverHostFixture {
  host: ReturnType<typeof createSolverHost>
  /** 绑定姿态的顶点位置（模型空间），用于测半径。 */
  bindPositions: Float32Array
}

/** 顶点的归属骨名（主导骨）。 */
export function hostDominant(fx: RigFixture, i: number): string {
  let bw = 0, bj = 0
  for (let k = 0; k < 4; k++) {
    const w = fx.skinWeight.getComponent(i, k)
    if (w > bw) { bw = w; bj = fx.skinIndex.getComponent(i, k) }
  }
  return fx.boneList[bj]?.name ?? ''
}

export function createSolverHostFixture(fx: RigFixture): SolverHostFixture {
  const zSign = fx.zSign
  const restLocal = new Map<JointName, THREE.Vector3>()
  for (const j of JOINT_NAMES) {
    const bone = fx.bones.get(j)
    if (bone !== undefined) restLocal.set(j, bone.position.clone())
  }
  const binding = { bones: fx.bones, zSign, restLocal } as unknown as RigBinding

  const bindPositions = new Float32Array(fx.position.count * 3)
  const bindNormals = new Float32Array(fx.normal.count * 3)
  for (let i = 0; i < fx.position.count; i++) {
    bindPositions[i * 3] = fx.position.getX(i)
    bindPositions[i * 3 + 1] = fx.position.getY(i)
    bindPositions[i * 3 + 2] = fx.position.getZ(i)
    bindNormals[i * 3] = fx.normal.getX(i)
    bindNormals[i * 3 + 1] = fx.normal.getY(i)
    bindNormals[i * 3 + 2] = fx.normal.getZ(i)
  }

  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()

  const geom: MannequinGeometry = {
    boneAt: (name: string) =>
      fx.byName.get(name)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(),
    bindBoneAt: (name: string) => fx.bindWorld.get(name)?.clone() ?? new THREE.Vector3(),
    boneParentQuat: (name: string) => {
      const bone = fx.byName.get(name)
      if (bone === undefined || bone.parent === null) return new THREE.Quaternion()
      bone.parent.updateWorldMatrix(true, false)
      return bone.parent.getWorldQuaternion(new THREE.Quaternion())
    },
    boneQuat: (name: string) => {
      const bone = fx.byName.get(name)
      if (bone === undefined) return undefined
      bone.updateWorldMatrix(true, false)
      return bone.getWorldQuaternion(new THREE.Quaternion())
    },
    vertexCount: fx.position.count,
    bindPositions,
    bindNormals,
    dominantBone: (i: number) => hostDominant(fx, i),
    applyPose: (joints: JointRotations, root: Vec3, verts: number[]): Float32Array => {
      const hips = fx.byName.get('mixamorigHips')
      if (hips !== undefined) hips.position.set(root.x, root.y, root.z)
      applyRigPose(binding, joints)
      fx.root.updateMatrixWorld(true)
      const out = new Float32Array(verts.length * 3)
      for (let k = 0; k < verts.length; k++) {
        const i = verts[k]
        const px = fx.position.getX(i), py = fx.position.getY(i), pz = fx.position.getZ(i)
        let x = 0, y = 0, z = 0
        for (let b = 0; b < 4; b++) {
          const w = fx.skinWeight.getComponent(i, b)
          if (w === 0) continue
          const bi = fx.skinIndex.getComponent(i, b)
          const bone = fx.boneList[bi]
          if (bone === undefined) continue
          m.multiplyMatrices(bone.matrixWorld, fx.boneInverses[bi])
          v.set(px, py, pz).applyMatrix4(m)
          x += w * v.x; y += w * v.y; z += w * v.z
        }
        out[k * 3] = x; out[k * 3 + 1] = y; out[k * 3 + 2] = z
      }
      return out
    },
  }

  const host = createSolverHost(geom, binding)
  return { host, bindPositions }
}

/** 便捷：关节名 → 骨名（测试里写起来方便）。 */
export const BONE_OF = JOINT_BONES

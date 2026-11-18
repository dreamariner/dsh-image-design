// 预设目标求解体检：8 个预设用「意图目标 + 物理求解」解一遍，报关键几何量。
//
// 为什么需要它：姿势库的数值不再是手拧的关节角，而是**意图**（手搭大腿、脚踩地面）。
// 意图对不对、够不够得着、有没有穿模，得靠数值体检说话 —— 这个脚本就是体检器。
//
// 用法：
//   node --experimental-strip-types scripts/solve-presets.ts [poseId...]
//       逐预设求解并打印：落定 / 末端坐标 / 肘膝角 / 穿深 / 手-腿间隙 / 脚离地

import * as THREE from 'three'
import { loadRigFixture } from '../tests/helpers/rig-fixture.ts'
import { createSolverHostFixture } from '../tests/helpers/solver-host.ts'
import { poseContactJoints, handThighGapJoints, skinPositions, dominantBone } from '../tests/helpers/pose-contact.ts'
import { computeBodyMetrics, poseTargets, TARGET_PRESET_IDS } from '../src/client/mannequin/targets.ts'
import { PoseSolver } from '../src/client/mannequin/solver.ts'
import { JOINT_BONES } from '../src/client/mannequin/rig.ts'

const args = process.argv.slice(2)
/** --json：只输出关节表（喂给 preview-mannequin.mjs 的 POSE_JSON ✓）。 */
const JSON_MODE = args.includes('--json')
const only = args.filter((a) => !a.startsWith('--'))

const fx = loadRigFixture()
const { host } = createSolverHostFixture(fx)

const metrics = computeBodyMetrics((name) =>
  fx.byName.get(name)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3())

const ids = only.length > 0 ? only : TARGET_PRESET_IDS
if (!JSON_MODE) {
console.log('── 身体尺寸 ──')
console.log(`  地面 y=${metrics.groundY.toFixed(3)}  髋高=${metrics.hipHeight.toFixed(3)}  肩高=${metrics.shoulderHeight.toFixed(3)}`)
console.log(`  大腿=${metrics.thighLen.toFixed(3)}  小腿=${metrics.shinLen.toFixed(3)}  踝高=${metrics.ankleHeight.toFixed(3)}  臂长=${metrics.armLen.toFixed(3)}`)
console.log(`  肩半宽=${metrics.shoulderHalf.toFixed(3)}  髋半宽=${metrics.hipHalf.toFixed(3)}`)
}

/** 关节的几何夹角（度）：root→mid 与 mid→tip 的夹角。 */
function jointAngleDeg(root: string, mid: string, tip: string): number {
  const at = (b: string) => fx.byName.get(b)!.getWorldPosition(new THREE.Vector3())
  const a = at(JOINT_BONES[root as keyof typeof JOINT_BONES] as string)
  const m = at(JOINT_BONES[mid as keyof typeof JOINT_BONES] as string)
  const t = at(JOINT_BONES[tip as keyof typeof JOINT_BONES] as string)
  const u = new THREE.Vector3().subVectors(a, m).normalize()
  const v = new THREE.Vector3().subVectors(t, m).normalize()
  return Math.acos(Math.max(-1, Math.min(1, u.dot(v)))) * 180 / Math.PI
}

/** 脚底最低点离地（米，正 = 悬空）。 */
function footClearance(joints: ReturnType<typeof solver.joints>): number {
  const posed = skinPositions(fx, joints)
  let minY = Infinity
  for (let i = 0; i < fx.position.count; i++) {
    const n = dominantBone(fx, i)
    if (!/Foot$|ToeBase$/.test(n)) continue
    minY = Math.min(minY, posed[i * 3 + 1])
  }
  return minY - metrics.groundY
}

const at = (b: string) => fx.byName.get(b)!.getWorldPosition(new THREE.Vector3())
const fmt = (v: THREE.Vector3) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`

for (const id of ids) {
  const targets = poseTargets(id, metrics)
  if (targets === null) {
    console.log(`\n[${id}] 没有这个预设`)
    continue
  }
  const solver = new PoseSolver(host)
  solver.setTargets(targets)
  const result = solver.settle()
  const joints = result.joints
  if (JSON_MODE) {
    // 附带骨盆位移（_root）：预览脚本据此把髋放到目标高度 ✓
    const out = { ...joints, _root: { x: targets.root.x, y: targets.root.y - metrics.hipsY, z: targets.root.z } }
    console.log(JSON.stringify(out))
    continue
  }
  const contact = poseContactJoints(fx, joints)
  const gapL = handThighGapJoints(fx, joints, 'Left')
  const gapR = handThighGapJoints(fx, joints, 'Right')
  console.log(`\n[${id}] ${result.settled ? '已落定' : '未落定（到子步上限）'}`)
  console.log(`  髋      ${fmt(at('mixamorigHips'))}`)
  console.log(`  腕 L/R  ${fmt(at('mixamorigLeftHand'))} / ${fmt(at('mixamorigRightHand'))}`)
  console.log(`  踝 L/R  ${fmt(at('mixamorigLeftFoot'))} / ${fmt(at('mixamorigRightFoot'))}`)
  console.log(`  肘角 L/R ${jointAngleDeg('shoulderL', 'elbowL', 'wristL').toFixed(0)}° / ${jointAngleDeg('shoulderR', 'elbowR', 'wristR').toFixed(0)}°（180=伸直）`)
  console.log(`  膝角 L/R ${jointAngleDeg('hipL', 'kneeL', 'ankleL').toFixed(0)}° / ${jointAngleDeg('hipR', 'kneeR', 'ankleR').toFixed(0)}°（180=伸直）`)
  console.log(`  穿深 ${(contact.maxPen * 1000).toFixed(1)}mm ${contact.label} @${contact.deepestPos?.map((x) => x.toFixed(3)).join(',') ?? '-'}  手-腿间隙 L/R ${(gapL * 1000).toFixed(1)} / ${(gapR * 1000).toFixed(1)}mm`)
  console.log(`  脚离地 L/R ${(footClearance(joints) * 1000).toFixed(1)}mm`)
}

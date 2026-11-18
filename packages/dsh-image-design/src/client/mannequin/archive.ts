// 意图目标 ↔ 归档 wire 形状的转换（ref.json 存意图，回放时按当前体型重解）。
//
// 为什么要有这一层：contract.ts 是 wire 单源（host 与 client 共用），solver.ts 是
// 客户端域模型；两者形状同构但归属不同 → 显式转换，别让 client 直接依赖 host
// 侧的运行时值（types 子路径只有类型转发）✓。

import type { RefPoseTarget, RefPoseTargets } from '@dreamariner/dsh-image-design/types'
import type { EndEffectorId, EndEffectorTarget, PoseTargets } from './solver.ts'

/** 四个末端（wire 形状的 key 就是这些）。 */
const END_IDS: EndEffectorId[] = ['handL', 'handR', 'footL', 'footR']

/** 单个末端目标 → 归档形状（只带实际有的字段，省得档里全是 null）。 */
function targetToRef(t: EndEffectorTarget): RefPoseTarget {
  return {
    ...(t.pos !== undefined ? { pos: { ...t.pos } } : {}),
    ...(t.anchor !== undefined ? { anchor: { ...t.anchor } } : {}),
    ...(t.forward !== undefined ? { forward: { ...t.forward } } : {}),
    ...(t.normal !== undefined ? { normal: { ...t.normal } } : {}),
    ...(t.pitchDeg !== undefined ? { pitchDeg: t.pitchDeg } : {}),
    ...(t.poleHint !== undefined ? { poleHint: t.poleHint } : {}),
  }
}

/** 客户端意图目标 → 归档 wire 形状（null = 没目标，不落档）。 */
export function toRefTargets(targets: PoseTargets | null | undefined): RefPoseTargets | undefined {
  if (targets === null || targets === undefined) return undefined
  const effectors: Record<string, RefPoseTarget> = {}
  for (const id of END_IDS) {
    const t = targets.effectors[id]
    if (t === undefined) continue
    effectors[id] = targetToRef(t)
  }
  return {
    root: { ...targets.root },
    effectors,
    ...(targets.head !== undefined ? { head: { ...targets.head } } : {}),
  }
}

/** 归档 wire 形状 → 客户端意图目标（回放用；undefined = 旧档，没意图）。 */
export function fromRefTargets(ref: RefPoseTargets | undefined): PoseTargets | null {
  if (ref === undefined) return null
  const effectors: Partial<Record<EndEffectorId, EndEffectorTarget>> = {}
  for (const id of END_IDS) {
    // 键可能缺（没这个末端的目标）→ 宽一点接住
    const t = ref.effectors[id] as RefPoseTarget | undefined
    if (t === undefined) continue
    effectors[id] = {
      ...(t.pos !== undefined ? { pos: { ...t.pos } } : {}),
      ...(t.anchor !== undefined ? { anchor: { ...t.anchor } } : {}),
      ...(t.forward !== undefined ? { forward: { ...t.forward } } : {}),
      ...(t.normal !== undefined ? { normal: { ...t.normal } } : {}),
      ...(t.pitchDeg !== undefined ? { pitchDeg: t.pitchDeg } : {}),
      ...(t.poleHint !== undefined ? { poleHint: t.poleHint as EndEffectorTarget['poleHint'] } : {}),
    }
  }
  return {
    root: { ...ref.root },
    effectors,
    ...(ref.head !== undefined ? { head: { ...ref.head } } : {}),
  }
}

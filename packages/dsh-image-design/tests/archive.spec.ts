// 归档回放：意图目标 ↔ wire 形状的转换（issue 005）。
//
// 为什么要有这一层测试：ref.json 存的是「作者意图」，回放时要还原成能解算的
// 意图对象；中间这一跳（客户端域类型 → JSON 形状 → 客户端域类型）最容易悄悄
// 丢字段（锚点、掌心法向、肘朝向提示），丢一个字段回放出来的姿势就不一样。

import { describe, expect, it } from 'vitest'
import { fromRefTargets, toRefTargets } from '../src/client/mannequin/archive.ts'
import type { PoseTargets } from '../src/client/mannequin/solver.ts'

const targets: PoseTargets = {
  root: { x: 0, y: 0.48, z: 0 },
  effectors: {
    handL: { anchor: { part: 'leftThigh', t: 0.48, radialDeg: 5, gapM: 0.002 }, poleHint: 'out' },
    handR: { pos: { x: 0.2, y: 0.5, z: 0.1 }, forward: { x: 0, y: 0, z: 1 }, normal: { x: 1, y: 0, z: 0 } },
    footL: { pos: { x: -0.1, y: 0.07, z: 0.3 }, pitchDeg: 52 },
  },
  head: { x: 0, y: 1.25, z: 0.05 },
}

describe('归档：意图目标往返', () => {
  it('往返不丢字段（锚点 / 法向 / 肘朝向 / 踝角）', () => {
    const wire = toRefTargets(targets)!
    const back = fromRefTargets(wire)!
    expect(back.root).toEqual(targets.root)
    expect(back.head).toEqual(targets.head)
    expect(back.effectors.handL).toEqual(targets.effectors.handL)
    expect(back.effectors.handR).toEqual(targets.effectors.handR)
    expect(back.effectors.footL).toEqual(targets.effectors.footL)
    expect(back.effectors.footR).toBeUndefined()
  })

  it('没目标返回 undefined（旧档不落 targets 字段）', () => {
    expect(toRefTargets(null)).toBeUndefined()
    expect(fromRefTargets(undefined)).toBeNull()
  })

  it('只带实际有的字段（不留一堆 null）', () => {
    const wire = toRefTargets(targets)!
    expect(Object.keys(wire.effectors).sort()).toEqual(['footL', 'handL', 'handR'])
    expect(wire.effectors.handL.pos).toBeUndefined()
    expect(wire.effectors.footL.anchor).toBeUndefined()
  })

  it('wire 形状是纯 JSON（没有 undefined 值，能过 typert 的边界闸）', () => {
    const wire = toRefTargets(targets)!
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire)
  })
})

// 精确素体三层叠加守卫：宏观 + 雕刻 morph 之后，测量求解仍命中目标 cm。
// 另守四项审计修正（2026-11-17）：负雕刻权重生效、l-/r- 镜像对称、身高缩放下
// 测量口径、GLB/OBJ 双基等价。
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMorphBin, toMeasurementDefs, type MorphAssets, type MorphManifest } from '../src/client/mannequin/morph.ts'
import { applyPreciseShape, DEFAULT_BREAST, DEFAULT_MACRO, type PreciseBodyParams } from '../src/client/mannequin/shape3.ts'
import { circumference } from '../src/client/mannequin/measure.ts'

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

describe('精确素体三层叠加', () => {
  let assets: MorphAssets
  let base: Float32Array
  let glbBase: Float32Array

  beforeAll(() => {
    const manifest = JSON.parse(readFileSync(join(ASSETS, 'mannequin-morphs.json'), 'utf8')) as MorphManifest
    const bytes = new Uint8Array(readFileSync(join(ASSETS, 'mannequin-morphs.bin')))
    assets = {
      manifest,
      data: parseMorphBin(bytes, manifest),
      measurements: toMeasurementDefs(manifest),
    }
    const obj = readFileSync(join(ASSETS, 'makehuman-base.obj'), 'utf8')
    const pts: number[] = []
    for (const line of obj.split('\n')) {
      if (line.startsWith('v ')) {
        const p = line.trim().split(/\s+/)
        pts.push(Number(p[1]), Number(p[2]), Number(p[3]))
      }
    }
    base = new Float32Array(pts.slice(0, 13380 * 3))

    // 实机 viewer 的 base 来自 GLB（不是 OBJ）：GLB = (OBJ − footBottom) × 0.1，
    // 即 GLB×10 与 OBJ 差一个 Y 常量平移。围度用相邻顶点距离，对平移不敏感；
    // 这里守卫「GLB base 与 OBJ base 形变后实测一致」，防止 GLB 生成脚本改了
    // 平移/顶点顺序后实机形变错位而单测仍绿。
    const glb = readFileSync(join(ASSETS, 'mannequin-body.glb'))
    const jsonLen = glb.readUInt32LE(12)
    const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'))
    const binOff = 20 + jsonLen + 8
    const prim = gltf.meshes[0].primitives[0]
    const acc = gltf.accessors[prim.attributes.POSITION]
    const view = gltf.bufferViews[acc.bufferView]
    const off = binOff + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    glbBase = new Float32Array(13380 * 3)
    for (let i = 0; i < 13380; i++) {
      const o = off + i * 12
      glbBase[i * 3] = glb.readFloatLE(o) * 10
      glbBase[i * 3 + 1] = glb.readFloatLE(o + 4) * 10
      glbBase[i * 3 + 2] = glb.readFloatLE(o + 8) * 10
    }
  })

  const params = (over: Partial<PreciseBodyParams> = {}): PreciseBodyParams => ({
    measurementsCm: {},
    sculpt: {},
    macro: { ...DEFAULT_MACRO },
    breast: { ...DEFAULT_BREAST },
    height: 170,
    ...over,
  })
  const diffSum = (a: Float32Array, b: Float32Array): number => {
    let d = 0
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i])
    return d
  }

  it('宏观 + 雕刻 + 测量叠加后，测量误差 < 1cm', () => {
    const p = params({
      measurementsCm: { 'bust-circ': 92, 'waist-circ': 74, 'hips-circ': 98 },
      sculpt: { 'buttocks/buttocks-volume-incr': 0.6, 'torso/torso-muscle-pectoral-incr': 0.3 },
      macro: { ...DEFAULT_MACRO, fat: 0.7, muscle: 0.6 },
    })
    const result = applyPreciseShape(base, assets, p)
    expect(result.position.length).toBe(base.length)
    for (const r of result.measured) {
      expect(Math.abs(r.measuredCm - r.targetCm), `${r.name} 实测 ${r.measuredCm} vs 目标 ${r.targetCm}`).toBeLessThan(1)
    }
  })

  it('雕刻权重生效：不同雕刻产生不同几何', () => {
    const r0 = applyPreciseShape(base, assets, params())
    const r1 = applyPreciseShape(base, assets, params({ sculpt: { 'buttocks/buttocks-volume-incr': 1 } }))
    expect(diffSum(r0.position, r1.position)).toBeGreaterThan(1)
  })

  it('雕刻负权重生效：−1 与 0 不同、与 +1 幅度对称（2026-11-17 审计：clamp 曾把负半轴打没）', () => {
    const zero = applyPreciseShape(base, assets, params({ sculpt: { 'buttocks/buttocks-volume-incr': 0 } })).position
    const neg = applyPreciseShape(base, assets, params({ sculpt: { 'buttocks/buttocks-volume-incr': -1 } })).position
    const pos = applyPreciseShape(base, assets, params({ sculpt: { 'buttocks/buttocks-volume-incr': 1 } })).position
    expect(diffSum(zero, neg)).toBeGreaterThan(1)
    expect(diffSum(zero, pos)).toBeGreaterThan(1)
    // 线性 morph：|−w| 与 |+w| 的位移总量应几乎相等
    expect(Math.abs(diffSum(zero, neg) - diffSum(zero, pos))).toBeLessThan(diffSum(zero, pos) * 0.05)
  })

  it('l-/r- 成对镜像：单侧雕刻滑杆两侧同步形变（2026-11-17 审计：此前只形变左半身）', () => {
    const lMorph = assets.data.get('armslegs/l-upperarm-muscle-incr')
    const rMorph = assets.data.get('armslegs/r-upperarm-muscle-incr')
    expect(lMorph, '资产缺 r-upperarm-muscle-incr').toBeDefined()
    expect(rMorph, '资产缺 r-upperarm-muscle-incr').toBeDefined()
    const { position } = applyPreciseShape(base, assets, params({ sculpt: { 'armslegs/l-upperarm-muscle-incr': 1 } }))
    const dispSum = (idx: Uint16Array): number => {
      let d = 0
      for (let i = 0; i < idx.length; i++) {
        const o = idx[i] * 3
        d += Math.abs(position[o] - base[o]) + Math.abs(position[o + 1] - base[o + 1]) + Math.abs(position[o + 2] - base[o + 2])
      }
      return d
    }
    const left = dispSum(lMorph!.indices)
    const right = dispSum(rMorph!.indices)
    expect(left).toBeGreaterThan(1)
    expect(right / left).toBeGreaterThan(0.5)
    expect(right / left).toBeLessThan(2)
  })

  it('身高缩放下测量口径保持：scale=1.1 时回显即世界 cm（2026-11-17 审计：身高曾游离在口径外）', () => {
    const p = params({ measurementsCm: { 'bust-circ': 92 } })
    const r = applyPreciseShape(base, assets, p, 1.1)
    const bust = r.measured.find((m) => m.name === 'bust-circ')
    expect(bust).toBeDefined()
    // 回显（世界口径）命中目标
    expect(Math.abs(bust?.measuredCm ?? 0)).toBeLessThan(93)
    expect(bust?.measuredCm ?? 0).toBeGreaterThan(91)
    // 求解空间坐标 × scale 后的实测（= holder 缩放后的真实围度）也命中目标
    const def = assets.measurements.find((d) => d.name === 'bust-circ')!
    const worldCm = circumference(def.ring, r.position) * 1.1
    expect(Math.abs(worldCm - 92)).toBeLessThan(1)
  })

  it('实机 GLB base 与 OBJ base 形变等价：cm 实测一致', () => {
    const p = params({ measurementsCm: { 'bust-circ': 92, 'waist-circ': 74, 'hips-circ': 98 } })
    const fromObj = applyPreciseShape(base, assets, p)
    const fromGlb = applyPreciseShape(glbBase, assets, p)
    // 两者只差 GLB 反推带来的浮点舍入，逐项容差 0.01cm
    for (let i = 0; i < fromGlb.measured.length; i++) {
      expect(Math.abs(fromGlb.measured[i].measuredCm - fromObj.measured[i].measuredCm), fromGlb.measured[i].name)
        .toBeLessThan(0.01)
    }
    for (const m of fromGlb.measured) {
      expect(Math.abs(m.measuredCm - m.targetCm), `${m.name} 实机 GLB base 实测 ${m.measuredCm}`).toBeLessThan(1)
    }
  })

  it('输出保持有限值（无 NaN/Infinity）', () => {
    const p = params({
      measurementsCm: { 'neck-circ': 36, 'thigh-circ': 58 },
      sculpt: { 'head/head-age-incr': 0.8 },
      macro: { ...DEFAULT_MACRO },
      height: 180,
    })
    const r = applyPreciseShape(base, assets, p)
    for (let i = 0; i < r.position.length; i++) {
      expect(Number.isFinite(r.position[i])).toBe(true)
    }
  })

  it('测量预览：21 项齐全、与测量目标无关、性别化后胸围漂移（2026-11-18 滑杆基准根因守卫）', () => {
    // 根因：滑杆基准曾用 manifest baseCm（HM08 无性别裸网格值），而默认渲染体已叠加
    // 性别 0.5 morph（胸围实测更大）。用户一动滑杆目标就被写成裸网格值，求解器把
    // 性别形变出来的胸压回去——「胸围极速坍塌且滑回原位无法恢复」。基准必须用
    // 「无测量 morph 的当前体形实测」（previews）。
    const plain = applyPreciseShape(base, assets, params())
    // 1) 全部测量项有预览且为正有限值
    expect(plain.previews.length).toBe(assets.measurements.length)
    for (const p of plain.previews) {
      expect(Number.isFinite(p.measuredCm), p.name).toBe(true)
      expect(p.measuredCm, p.name).toBeGreaterThan(0)
    }
    // 2) 预览与测量目标无关（设定目标不得影响基准）
    const withGoals = applyPreciseShape(base, assets, params({ measurementsCm: { 'bust-circ': 95, 'waist-circ': 70 } }))
    for (const p of withGoals.previews) {
      const q = plain.previews.find((x) => x.name === p.name)!
      expect(Math.abs(p.measuredCm - q.measuredCm), `${p.name} 预览被测量目标带偏`).toBeLessThan(0.01)
    }
    // 3) 性别 morph 让胸围预览大幅漂移（漂移量就是旧实现坍塌的量：默认 gender 0.5
    //    的预览 ≈92.5 vs 裸网格 baseCm 80.4，差 12cm——一动滑杆就压塌 12cm）
    const female = applyPreciseShape(base, assets, params({ macro: { ...DEFAULT_MACRO, gender: 1 } }))
    const male = applyPreciseShape(base, assets, params({ macro: { ...DEFAULT_MACRO, gender: 0 } }))
    const bustOf = (r: ReturnType<typeof applyPreciseShape>): number =>
      r.previews.find((x) => x.name === 'bust-circ')!.measuredCm
    expect(Math.abs(bustOf(female) - bustOf(male))).toBeGreaterThan(1)
    const baseCm = assets.measurements.find((d) => d.name === 'bust-circ')?.baseCm ?? 0
    expect(Math.abs(bustOf(plain) - baseCm), '默认形态胸围预览应显著偏离裸网格 baseCm（旧实现坍塌量）').toBeGreaterThan(1)
    // 4) 预览是世界口径（×scale）
    const scaled = applyPreciseShape(base, assets, params(), 1.1)
    for (const p of scaled.previews) {
      const q = plain.previews.find((x) => x.name === p.name)!
      expect(Math.abs(p.measuredCm - q.measuredCm * 1.1), `${p.name} 预览未随身高缩放`).toBeLessThan(0.05)
    }
  })
})

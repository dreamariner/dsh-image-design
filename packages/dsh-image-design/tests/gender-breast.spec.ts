// 性别维度与胸型维度守卫：
//   1) 同一套网格能连续切出男/女（性别是权重，不是两套模型）
//   2) 胸型（cup）改的是形状，胸围数值只校准尺寸 —— 二者不互相抹平
//   3) 男性体上胸型参数必须淡出（不长乳房）
//   4) 真肩宽 shoulder-breadth 能命中 40cm 量级目标（旧 shoulder-dist 只到 20cm）
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMorphBin, toMeasurementDefs, type MorphAssets, type MorphManifest } from '../src/client/mannequin/morph.ts'
import {
  applyPreciseShape,
  DEFAULT_BREAST,
  DEFAULT_MACRO,
  type BreastParams,
  type PreciseBodyParams,
} from '../src/client/mannequin/shape3.ts'
import { circumference } from '../src/client/mannequin/measure.ts'

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

describe('性别与胸型', () => {
  let assets: MorphAssets
  let base: Float32Array

  beforeAll(() => {
    const manifest = JSON.parse(readFileSync(join(ASSETS, 'mannequin-morphs.json'), 'utf8')) as MorphManifest
    const bytes = new Uint8Array(readFileSync(join(ASSETS, 'mannequin-morphs.bin')))
    assets = { manifest, data: parseMorphBin(bytes, manifest), measurements: toMeasurementDefs(manifest) }
    const pts: number[] = []
    for (const line of readFileSync(join(ASSETS, 'makehuman-base.obj'), 'utf8').split('\n')) {
      if (!line.startsWith('v ')) continue
      const p = line.trim().split(/\s+/)
      pts.push(Number(p[1]), Number(p[2]), Number(p[3]))
    }
    base = new Float32Array(pts.slice(0, 13380 * 3))
  })

  const ringOf = (name: string): number[] => {
    const def = assets.measurements.find((d) => d.name === name)
    if (def === undefined) throw new Error(`缺测量环：${name}`)
    return def.ring
  }

  /** 乳房峰点 z（分米坐标里 z 向前为正；越大越前突）。 */
  const bustProjection = (coord: Float32Array): number => {
    let max = -Infinity
    for (let i = 0; i < 13380; i++) {
      const x = coord[i * 3]
      const y = coord[i * 3 + 1]
      if (y > 3.2 && y < 4.5 && Math.abs(x) > 0.5 && Math.abs(x) < 1.5) {
        max = Math.max(max, coord[i * 3 + 2])
      }
    }
    return max * 10 // cm
  }

  const shape = (opts: {
    gender?: number
    cup?: number
    firmness?: number
    droop?: number
    measurementsCm?: Record<string, number>
  }): { coord: Float32Array; measured: Array<{ name: string; measuredCm: number }> } => {
    const breast: BreastParams = { ...DEFAULT_BREAST, cup: opts.cup ?? 0, firmness: opts.firmness ?? 0, droop: opts.droop ?? 0 }
    const params: PreciseBodyParams = {
      measurementsCm: opts.measurementsCm ?? {},
      sculpt: {},
      macro: { ...DEFAULT_MACRO, gender: opts.gender ?? 0.5 },
      breast,
      height: 170,
    }
    const r = applyPreciseShape(base, assets, params)
    return { coord: r.position, measured: r.measured }
  }

  it('性别在 0..1 连续切换：肩宽递减、腰臀比递减（女 < 男）', () => {
    const male = shape({ gender: 0 })
    const mid = shape({ gender: 0.5 })
    const female = shape({ gender: 1 })
    const shoulder = (c: Float32Array): number => circumference(ringOf('shoulder-breadth'), c)
    const whr = (c: Float32Array): number =>
      circumference(ringOf('waist-circ'), c) / circumference(ringOf('hips-circ'), c)

    // 肩宽：男 > 中 > 女（实测 38.1 / 36.3 / 34.5）
    expect(shoulder(male.coord)).toBeGreaterThan(shoulder(mid.coord))
    expect(shoulder(mid.coord)).toBeGreaterThan(shoulder(female.coord))
    // 腰臀比：男 > 中 > 女（女性骨盆更宽、腰更细）
    expect(whr(male.coord)).toBeGreaterThan(whr(mid.coord))
    expect(whr(mid.coord)).toBeGreaterThan(whr(female.coord))
    // 差异要有量级，不能是数值噪音
    expect(shoulder(male.coord) - shoulder(female.coord)).toBeGreaterThan(2)
    expect(whr(male.coord) - whr(female.coord)).toBeGreaterThan(0.05)
  })

  it('胸型改形状：同性别下 cup 从最小到最大，前突差 > 3cm', () => {
    const small = shape({ gender: 1, cup: -1 })
    const large = shape({ gender: 1, cup: 1 })
    const dProjection = bustProjection(large.coord) - bustProjection(small.coord)
    expect(dProjection).toBeGreaterThan(3)
    // 围度也要跟着涨（大罩杯 ≠ 只改形状不改尺寸）
    expect(circumference(ringOf('bust-circ'), large.coord)).toBeGreaterThan(
      circumference(ringOf('bust-circ'), small.coord) + 10,
    )
  })

  it('胸型与围度解耦：胸围锁到同一数值时，cup 仍能改变前突（不被求解抹平）', () => {
    const goals = { 'bust-circ': 92 }
    const small = shape({ gender: 1, cup: -1, measurementsCm: goals })
    const large = shape({ gender: 1, cup: 1, measurementsCm: goals })
    const bust = (c: Float32Array): number => circumference(ringOf('bust-circ'), c)
    // 两者胸围都收敛到 92
    expect(Math.abs(bust(small.coord) - 92)).toBeLessThan(0.5)
    expect(Math.abs(bust(large.coord) - 92)).toBeLessThan(0.5)
    // 但形状（前突）仍保持 cup 造成的差异
    expect(bustProjection(large.coord) - bustProjection(small.coord)).toBeGreaterThan(1.5)
  })

  it('男性体上胸型参数淡出：gender=0 时 cup 不产生形变', () => {
    const flat = shape({ gender: 0, cup: 0 })
    const maxed = shape({ gender: 0, cup: 1 })
    const bust = (c: Float32Array): number => circumference(ringOf('bust-circ'), c)
    expect(Math.abs(bust(maxed.coord) - bust(flat.coord))).toBeLessThan(0.01)
    expect(Math.abs(bustProjection(maxed.coord) - bustProjection(flat.coord))).toBeLessThan(0.01)
  })

  it('droop 方向：负=上提（乳房 y 更高），正=下垂（2026-11-17 审计：原实现两侧映射写反）', () => {
    // 乳房区域（y 3.2..4.5dm、|x| 0.5..1.5dm）平均高度：上提 > 下垂
    const breastY = (c: Float32Array): number => {
      let s = 0
      let n = 0
      for (let i = 0; i < 13380; i++) {
        const x = c[i * 3]
        const y = c[i * 3 + 1]
        if (y > 3.2 && y < 4.5 && Math.abs(x) > 0.5 && Math.abs(x) < 1.5) { s += y; n++ }
      }
      return s / n
    }
    const lifted = shape({ gender: 1, droop: -1 }).coord
    const sagged = shape({ gender: 1, droop: 1 }).coord
    expect(breastY(lifted)).toBeGreaterThan(breastY(sagged))
    // 方向差要有量级（trans-up 峰值位移 0.178dm，区域均值差实测 ≈0.11dm），不能是数值噪音
    expect(breastY(lifted) - breastY(sagged)).toBeGreaterThan(0.05)
  })

  it('真肩宽可求解：目标 40cm 命中（旧 shoulder-dist 定死在 20cm）', () => {
    const { coord, measured } = shape({ measurementsCm: { 'shoulder-breadth': 40 } })
    const actual = circumference(ringOf('shoulder-breadth'), coord)
    expect(Math.abs(actual - 40)).toBeLessThan(0.5)
    const echo = measured.find((m) => m.name === 'shoulder-breadth')
    expect(echo?.measuredCm).toBeCloseTo(actual, 1)
  })

  it('性别 + 胸型 + 测量三层叠加后仍命中 cm 目标', () => {
    const { measured } = shape({
      gender: 1,
      cup: 1,
      firmness: 1,
      measurementsCm: { 'bust-circ': 95, 'waist-circ': 68, 'hips-circ': 96 },
    })
    for (const name of ['bust-circ', 'waist-circ', 'hips-circ']) {
      const m = measured.find((x) => x.name === name)
      expect(m).toBeDefined()
      const goal = name === 'bust-circ' ? 95 : name === 'waist-circ' ? 68 : 96
      expect(Math.abs((m?.measuredCm ?? 0) - goal)).toBeLessThan(1)
    }
  })
})

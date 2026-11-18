// 精确素体的地基守卫：从正式产物（bin + manifest）读 morph，验证 cm 级求解闭环。
// 这是 004 方案的核心证明，任何数据管线改动都不能让精度退化。
// 求解直接用运行时 measure.ts（此前本地复刻 [-1,1]/12 迭代与运行时 [-1,2]/16 迭代
// 已经漂移，守的是假求解器，2026-11-17 审计改掉）。
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMorphBin, toMeasurementDefs, type MorphAssets, type MorphManifest } from '../src/client/mannequin/morph.ts'
import { circumference, solveMeasurement } from '../src/client/mannequin/measure.ts'

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

describe('精确素体 morph 精度守卫', () => {
  let bin: Buffer
  let manifest: MorphManifest
  let assets: MorphAssets
  let base: Float32Array // 前 13380 顶点的 xyz（分米）

  beforeAll(() => {
    bin = readFileSync(join(ASSETS, 'mannequin-morphs.bin'))
    manifest = JSON.parse(readFileSync(join(ASSETS, 'mannequin-morphs.json'), 'utf8')) as MorphManifest
    assets = {
      manifest,
      data: parseMorphBin(new Uint8Array(bin), manifest),
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
  })

  it('资产齐备：184 morph / 21 测量（含合成真肩宽）/ 21 环', () => {
    expect(Object.keys(manifest.morphs).length).toBeGreaterThanOrEqual(184)
    expect(manifest.measurements.length).toBe(21)
    expect(Object.keys(manifest.rings).length).toBe(21)
    // 性别与胸型的关键 morph 必须存在，否则「男女同一模型」和「胸型调节」静默失效
    for (const name of [
      'macrodetails/caucasian-female-young',
      'macrodetails/caucasian-male-young',
      'breast/female-young-averagemuscle-averageweight-maxcup-averagefirmness',
      'breast/breast-point-incr',
      'breast/breast-trans-up',
    ]) {
      expect(manifest.morphs[name]?.count ?? 0).toBeGreaterThan(0)
    }
  })

  it('l-/r- 成对齐备：每个 l- 雕刻 morph 都有同名 r-（缺侧会让滑杆只形变半边）', () => {
    const lNames = Object.keys(manifest.morphs).filter((n) => /\/l-/.test(n))
    expect(lNames.length).toBeGreaterThan(0)
    const missing = lNames.map((n) => n.replace('/l-', '/r-')).filter((r) => manifest.morphs[r] === undefined)
    expect(missing, `缺 r- 侧：${missing.join(', ')}`).toEqual([])
  })

  it('manifest baseCm 与资产实测一致（UI 滑杆基准的数据源）', () => {
    for (const def of assets.measurements) {
      expect(typeof def.baseCm, `${def.name} 缺 baseCm`).toBe('number')
      const actual = circumference(def.ring, base)
      expect(Math.abs((def.baseCm ?? 0) - actual), `${def.name} manifest=${def.baseCm} 实测=${actual.toFixed(2)}`)
        .toBeLessThan(0.05)
    }
  })

  it.each(['neck-circ', 'bust-circ', 'waist-circ', 'hips-circ', 'thigh-circ', 'calf-circ'])(
    '%s 输入目标 cm，运行时求解器实测误差 < 1cm', (name) => {
      const def = assets.measurements.find((d) => d.name === name)
      expect(def, `缺测量定义：${name}`).toBeDefined()
      const baseCm = circumference(def!.ring, base)
      const goal = baseCm + 5
      const incr = assets.data.get(`measure/measure-${name}-incr`)
      const decr = assets.data.get(`measure/measure-${name}-decr`)
      expect(incr).toBeDefined()
      expect(decr).toBeDefined()
      const { measuredCm } = solveMeasurement(def!, incr!, decr!, base, goal)
      expect(Math.abs(measuredCm - goal)).toBeLessThan(1)
    },
  )
})

// 紧身衣守卫：HM08 是裸体网格，素体参考图喂图片模型会被安全审查拦截。
// 方案 = **几何壳**（suit.ts）：独立 SkinnedMesh 布料层，遮盖 = 几何遮挡。
//
// 本文件穷尽断言三件事：
//   1) 敏感覆盖带（裆底到锁骨下缘 y≈0.62..1.32）内，所有符合条件的**渲染**三角形
//      都有壳遮挡——审查漏点在几何层面不存在；
//   2) 女性 + 罩杯最大形变后，壳跟随新体形且覆盖区域不漂移（applySuitDeform）；
//   3) 裸露部位（手/前臂/小腿/头颈）零误伤，领口以上（下巴斑块）不进壳。
//
// ⚠ GLB 里 13380..19157 是**死顶点**（build-mannequin-body 只导 body 组的面，
//   这些顶点无三角形引用、不渲染，但保留了 HM08 的权重数据）。所有窗口断言
//   必须先过滤「渲染顶点集」，否则死顶点（如 15737，位置在乳房区、权重 Spine2）
//   会造成假阳性（2026-11-18 审计教训）。
//
// 历史教训（勿回退到涂装类方案）：
//   ① 逐顶点主导骨 AND 分段 → 上背锯齿挖洞；② 三角形硬分段 → 边界锯齿；
//   ③ 顶点色渐变 → 「只是染色」无材质感 + 渐变半亮色穿过敏感区 = 审查漏点。
import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRigFixture, type RigFixture } from './helpers/rig-fixture.ts'
import {
  buildSuit, applySuitDeform, suitWeightAt,
  SUIT_THICKNESS, SUIT_EDGE_MIN, SUIT_SENSITIVE_MIN,
  SENSITIVE_Y_LO, SENSITIVE_Y_HI,
  type SuitParams,
} from '../src/client/mannequin/suit.ts'
import { applyPreciseShape, DEFAULT_BREAST, DEFAULT_MACRO, type PreciseBodyParams } from '../src/client/mannequin/shape3.ts'
import { parseMorphBin, toMeasurementDefs, type MorphAssets, type MorphManifest } from '../src/client/mannequin/morph.ts'
import { BONE } from '../src/client/mannequin/body.ts'

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

describe('紧身衣几何壳', () => {
  let fx: RigFixture
  let p: SuitParams
  let build: ReturnType<typeof buildSuit>
  let shellTris: Set<string>
  /** 渲染顶点集（被 body 三角形引用的顶点；13380+ 是死顶点不渲染）。 */
  let renderedVerts: Set<number>

  beforeAll(() => {
    fx = loadRigFixture()
    renderedVerts = new Set()
    for (let i = 0; i < fx.index.length; i++) renderedVerts.add(fx.index[i])

    const y = (bone: string): number => fx.byName.get(bone)!.getWorldPosition(new THREE.Vector3()).y
    p = {
      position: fx.position,
      normal: fx.normal,
      skinIndex: fx.skinIndex,
      skinWeight: fx.skinWeight,
      boneList: fx.boneList,
      index: fx.index,
      shortsHemY: (y(BONE.upLegL) + y(BONE.legL)) / 2,
      necklineY: y(BONE.neck),
    }
    build = buildSuit(p)
    shellTris = new Set()
    const shellIndex = build.geometry.getIndex()!
    for (let t = 0; t < shellIndex.count / 3; t++) {
      const a = build.bodyIndexMap[shellIndex.getX(t * 3)]
      const b = build.bodyIndexMap[shellIndex.getX(t * 3 + 1)]
      const c = build.bodyIndexMap[shellIndex.getX(t * 3 + 2)]
      shellTris.add(`${a},${b},${c}`)
    }
  })

  const sw = (v: number): number => suitWeightAt(v, p)

  it('壳三角形覆盖敏感带：裆底到锁骨下的躯干渲染表面 100% 有壳遮挡（审查红线穷尽断言）', () => {
    const triCount = fx.index.length / 3
    let checked = 0
    for (let t = 0; t < triCount; t++) {
      const a = fx.index[t * 3]
      const b = fx.index[t * 3 + 1]
      const c = fx.index[t * 3 + 2]
      const cy = (fx.position.getY(a) + fx.position.getY(b) + fx.position.getY(c)) / 3
      if (cy <= SENSITIVE_Y_LO + 0.02 || cy >= SENSITIVE_Y_HI - 0.02) continue
      const avg = (sw(a) + sw(b) + sw(c)) / 3
      const min = Math.min(sw(a), sw(b), sw(c))
      if (avg <= 0.25 || min <= 0.05) continue // 分类条件之外的（纯手臂等）
      checked++
      expect(shellTris.has(`${a},${b},${c}`), `敏感带三角形未被壳覆盖: ${a},${b},${c}`).toBe(true)
    }
    expect(checked).toBeGreaterThan(200)
  })

  it('女性 + 罩杯最大形变后：乳房区渲染顶点全部在壳内，壳位置贴合形变体形', () => {
    // 女性 + maxcup + firmness：乳房前突最大的体形（审查最严苛场景）。
    // base 用 GLB 顶点 ×10（viewer 同款分米坐标系，与 assets 形变等价——见 shape3.spec）。
    const manifest = JSON.parse(readFileSync(join(ASSETS, 'mannequin-morphs.json'), 'utf8')) as MorphManifest
    const binBytes = new Uint8Array(readFileSync(join(ASSETS, 'mannequin-morphs.bin')))
    const assets: MorphAssets = {
      manifest,
      data: parseMorphBin(binBytes, manifest),
      measurements: toMeasurementDefs(manifest),
    }
    const glbBaseDm = new Float32Array(fx.position.count * 3)
    for (let i = 0; i < glbBaseDm.length; i++) glbBaseDm[i] = (fx.position.array as Float32Array)[i] * 10
    const params: PreciseBodyParams = {
      measurementsCm: {},
      sculpt: {},
      macro: { ...DEFAULT_MACRO, gender: 1 },
      breast: { ...DEFAULT_BREAST, cup: 1, firmness: 1 },
      height: 170,
    }
    const deformed = applyPreciseShape(glbBaseDm, assets, params)
    const bodyPosM = new Float32Array(deformed.position.length)
    for (let i = 0; i < deformed.position.length; i++) bodyPosM[i] = deformed.position[i] * 0.1

    // 1) 覆盖不漂移：乳房区（形变后坐标）的渲染顶点全部在壳顶点集里。
    //    口径与壳三角形判定对齐（敏感带阈值 0.25）：sw≤0.25 的腋下交界顶点
    //    属于袖窿裸露区，不在覆盖承诺内。
    const shellVerts = new Set(build.bodyIndexMap)
    let checked = 0
    for (const v of renderedVerts) {
      const yy = bodyPosM[v * 3 + 1]
      const zz = bodyPosM[v * 3 + 2]
      const xx = Math.abs(bodyPosM[v * 3])
      if (yy > 0.95 && yy < 1.25 && zz > 0.05 && xx > 0.03 && xx < 0.2 && sw(v) > 0.25) {
        checked++
        expect(shellVerts.has(v), `形变后乳房区顶点 ${v} 不在壳内`).toBe(true)
      }
    }
    expect(checked).toBeGreaterThan(50)

    // 2) 壳位置贴合：抽样验证壳 pos = 形变后 body pos + 绑定法线×offset
    const bodyNor = fx.normal.array as Float32Array
    const suitPos = new Float32Array(build.bodyIndexMap.length * 3)
    const suitNor = new Float32Array(build.bodyIndexMap.length * 3)
    applySuitDeform(build, bodyPosM, bodyNor, suitPos, suitNor)
    for (let i = 0; i < Math.min(20, build.bodyIndexMap.length); i++) {
      const bi = build.bodyIndexMap[i] * 3
      const o = i * 3
      const off = build.offsets[i]
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(suitPos[o + k] - (bodyPosM[bi + k] + bodyNor[bi + k] * off + build.tangent[o + k]))).toBeLessThan(1e-5)
      }
    }
  })

  it('壳顶点集包含乳房区域（绑定姿态权重场判定，渲染顶点）', () => {
    const shellVerts = new Set(build.bodyIndexMap)
    let checked = 0
    for (const v of renderedVerts) {
      const yy = fx.position.getY(v)
      const zz = fx.position.getZ(v)
      const xx = Math.abs(fx.position.getX(v))
      if (yy > 0.95 && yy < 1.2 && zz > 0.07 && xx > 0.03 && xx < 0.2 && sw(v) > 0.5) {
        checked++
        expect(shellVerts.has(v), `胸部顶点 ${v} 不在壳内`).toBe(true)
      }
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('手/前臂/小腿不进壳（零误伤）', () => {
    for (let v = 0; v < fx.position.count; v++) {
      let b = -1
      let bw = 0
      for (let k = 0; k < 4; k++) {
        const w = fx.skinWeight.getComponent(v, k)
        if (w > bw) { bw = w; b = fx.skinIndex.getComponent(v, k) }
      }
      const name = fx.boneList[b]?.name ?? ''
      if (name === BONE.handL || name === BONE.handR || name === BONE.foreArmL || name === BONE.foreArmR || name === BONE.legL || name === BONE.legR) {
        expect(build.bodyIndexMap.includes(v), `${name} 顶点 ${v} 误入壳`).toBe(false)
      }
    }
  })

  it('领口以上不进壳（下巴斑块防线）', () => {
    for (let v = 0; v < fx.position.count; v++) {
      const yy = fx.position.getY(v)
      if (yy > p.necklineY + 0.01) {
        expect(build.bodyIndexMap.includes(v), `领口上顶点 ${v} 误入壳`).toBe(false)
      }
    }
  })

  it('offset 范围：边缘收拢不小于 EDGE_MIN，敏感带内不小于 SENSITIVE_MIN（含浮点容差）', () => {
    for (let i = 0; i < build.bodyIndexMap.length; i++) {
      const v = build.bodyIndexMap[i]
      const off = build.offsets[i]
      expect(off).toBeGreaterThanOrEqual(SUIT_EDGE_MIN - 1e-9)
      expect(off).toBeLessThanOrEqual(SUIT_THICKNESS + 1e-9)
      const yy = fx.position.getY(v)
      if (yy > SENSITIVE_Y_LO && yy < SENSITIVE_Y_HI) {
        expect(off, `敏感带顶点 ${v} 壳厚不足`).toBeGreaterThanOrEqual(SUIT_SENSITIVE_MIN)
      }
    }
  })

  it('壳蒙皮与身体一致：skinIndex/skinWeight 逐顶点复制', () => {
    for (let i = 0; i < Math.min(50, build.bodyIndexMap.length); i++) {
      const v = build.bodyIndexMap[i]
      for (let k = 0; k < 4; k++) {
        expect(build.geometry.getAttribute('skinIndex').getComponent(i, k)).toBe(fx.skinIndex.getComponent(v, k))
        expect(build.geometry.getAttribute('skinWeight').getComponent(i, k)).toBeCloseTo(fx.skinWeight.getComponent(v, k), 5)
      }
    }
  })

  it('壳 index 有效且三角形数合理（≈15%~40% 身体渲染三角形）', () => {
    const idx = build.geometry.getIndex()!
    for (let i = 0; i < idx.count; i++) {
      expect(idx.getX(i)).toBeLessThan(build.bodyIndexMap.length)
    }
    const ratio = build.triangleCount / (fx.index.length / 3)
    expect(ratio).toBeGreaterThan(0.12)
    expect(ratio).toBeLessThan(0.4)
  })

  it('绑定姿态壳位置 = body + 法线×offset（抽样）', () => {
    const pos = build.geometry.getAttribute('position')
    const nor = build.geometry.getAttribute('normal')
    for (let i = 0; i < Math.min(30, build.bodyIndexMap.length); i++) {
      const v = build.bodyIndexMap[i]
      const off = build.offsets[i]
      for (let k = 0; k < 3; k++) {
        // 边界顶点另有切向位移（去锯齿用），其余顶点切向为 0
        expect(pos.getComponent(i, k)).toBeCloseTo(fx.position.getComponent(v, k) + fx.normal.getComponent(v, k) * off + build.tangent[i * 3 + k], 5)
        expect(nor.getComponent(i, k)).toBeCloseTo(fx.normal.getComponent(v, k), 5)
      }
    }
  })

  it('壳顶点全部是渲染顶点（死顶点不进壳）', () => {
    for (const v of build.bodyIndexMap) {
      expect(renderedVerts.has(v), `死顶点 ${v} 进了壳`).toBe(true)
    }
  })
})

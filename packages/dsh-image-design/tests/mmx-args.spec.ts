// @dreamariner/dsh-image-design :: mmx argv 构造矩阵
//
// buildGenerateArgs 是计费接口前的最后一道闸：非法组合必须在 argv 期被拦下
// （请求没发出去 = 没花钱）。参数面与 mmx 1.0.29 的 image generate 对齐。

import { describe, expect, it } from 'vitest'
import { buildGenerateArgs, parseMmxJson, type GenerateParams } from '../src/mmx.ts'

const TARGET = { outDir: '/tmp/out', outPrefix: 'run-x' }

const base: GenerateParams = {
  model: 'image-01',
  prompt: '一只橘猫',
  aspectRatio: '16:9',
}

describe('buildGenerateArgs', () => {
  it('基本形态：模型与 prompt 必传，image-01 比例档不带面积档，尾挂落盘与 Agent 旗标', () => {
    const args = buildGenerateArgs(base, TARGET)
    expect(args.slice(0, 5)).toEqual(['image', 'generate', '--model', 'image-01', '--prompt'])
    expect(args).toContain('--aspect-ratio')
    expect(args).not.toContain('--area')
    expect(args.slice(-8)).toEqual(['--out-dir', '/tmp/out', '--out-prefix', 'run-x', '--output', 'json', '--quiet', '--non-interactive'])
  })

  it('H3 比例档必须带面积档', () => {
    expect(() => buildGenerateArgs({ ...base, model: 'MiniMax-H3-Image' }, TARGET))
      .toThrow(/面积档/)
    const args = buildGenerateArgs({ ...base, model: 'MiniMax-H3-Image', area: '2K' }, TARGET)
    expect(args).toContain('--area')
    expect(args[args.indexOf('--area') + 1]).toBe('2K')
  })

  it('H3 精确尺寸与比例档互斥；image-01 不认 --size', () => {
    expect(() => buildGenerateArgs({ ...base, size: '2720x1536' }, TARGET)).toThrow(/互斥|image-01/)
    expect(() => buildGenerateArgs({ ...base, aspectRatio: undefined, size: '2720x1536', model: 'image-01' }, TARGET)).toThrow(/image-01/)
    const args = buildGenerateArgs({ ...base, aspectRatio: undefined, size: '2720x1536', model: 'MiniMax-H3-Image' }, TARGET)
    expect(args).toContain('--size')
  })

  it('image-01 像素宽高必须是 512..2048 的 8 倍数；H3 不认', () => {
    expect(() => buildGenerateArgs({ ...base, aspectRatio: undefined, width: 1001, height: 1001 }, TARGET)).toThrow(/8 的倍数/)
    expect(() => buildGenerateArgs({ ...base, aspectRatio: undefined, width: 2056, height: 2056 }, TARGET)).toThrow(/512\.\.2048/)
    const ok = buildGenerateArgs({ ...base, aspectRatio: undefined, width: 1024, height: 768 }, TARGET)
    expect(ok).toEqual(expect.arrayContaining(['--width', '1024', '--height', '768']))
    expect(() => buildGenerateArgs({ ...base, aspectRatio: undefined, width: 1024, height: 768, model: 'MiniMax-H3-Image' }, TARGET))
      .toThrow(/像素宽高/)
  })

  it('尺寸三选一：同时给比例档与像素宽高直接拦', () => {
    expect(() => buildGenerateArgs({ ...base, width: 1024, height: 1024 }, TARGET)).toThrow(/只能选一种/)
  })

  it('张数越界拦截；n=1 不加 --n（省字节，语义等价）', () => {
    expect(() => buildGenerateArgs({ ...base, n: 11 }, TARGET)).toThrow(/1..10/)
    expect(() => buildGenerateArgs({ ...base, n: 0 }, TARGET)).toThrow(/1..10/)
    expect(buildGenerateArgs({ ...base, n: 1 }, TARGET)).not.toContain('--n')
    expect(buildGenerateArgs({ ...base, n: 4 }, TARGET)).toEqual(expect.arrayContaining(['--n', '4']))
  })

  it('seed / prompt-optimizer / aigc-watermark / subject-ref 是 image-01 专属，传给 H3 会被拦', () => {
    expect(() => buildGenerateArgs({ ...base, model: 'MiniMax-H3-Image', area: '2K', seed: 42 }, TARGET)).toThrow(/image-01/)
    expect(() => buildGenerateArgs({ ...base, model: 'MiniMax-H3-Image', area: '2K', promptOptimizer: true }, TARGET)).toThrow(/image-01/)
    expect(() => buildGenerateArgs({ ...base, model: 'MiniMax-H3-Image', area: '2K', aigcWatermark: true }, TARGET)).toThrow(/image-01/)
    expect(() => buildGenerateArgs({ ...base, model: 'MiniMax-H3-Image', area: '2K', subjectRefImage: '/a.png' }, TARGET)).toThrow(/image-01/)
    const args = buildGenerateArgs({ ...base, seed: 42, promptOptimizer: true, aigcWatermark: true, subjectRefImage: '/a.png' }, TARGET)
    expect(args).toEqual(expect.arrayContaining(['--seed', '42', '--prompt-optimizer', '--aigc-watermark', '--subject-ref', 'type=character,image=/a.png']))
  })

  it('H3 关闭提示词增强必须带显式尺寸；开启（默认）不传旗标', () => {
    // 没给任何尺寸：先被尺寸必填拦住（H3 的合法尺寸路径必带比例档或精确尺寸，增强校验是纵深防御）
    expect(() => buildGenerateArgs({ ...base, model: 'MiniMax-H3-Image', aspectRatio: undefined, size: undefined, promptEnhance: false }, TARGET))
      .toThrow()
    const withSize = buildGenerateArgs({ ...base, model: 'MiniMax-H3-Image', aspectRatio: undefined, size: '2720x1536', promptEnhance: false }, TARGET)
    expect(withSize).toContain('--no-prompt-enhance')
    const defaultOn = buildGenerateArgs({ ...base, model: 'MiniMax-H3-Image', area: '2K' }, TARGET)
    expect(defaultOn).not.toContain('--no-prompt-enhance')
  })

  it('H3 参考图逐张展开；超过 16 张拦截；image-01 不认参考图', () => {
    const one = buildGenerateArgs({ ...base, model: 'MiniMax-H3-Image', area: '2K', refImages: ['/a.png', '/b.jpg'] }, TARGET)
    expect(one.filter((a) => a === '--image')).toHaveLength(2)
    expect(one).toEqual(expect.arrayContaining(['--image', '/a.png', '--image', '/b.jpg']))
    expect(() => buildGenerateArgs({ ...base, refImages: ['/a.png'] }, TARGET)).toThrow(/H3/)
    const many = Array.from({ length: 17 }, (_, i) => `/r${i}.png`)
    expect(() => buildGenerateArgs({ ...base, model: 'MiniMax-H3-Image', area: '2K', refImages: many }, TARGET)).toThrow(/16/)
  })

  it('比例档格式校验', () => {
    expect(() => buildGenerateArgs({ ...base, aspectRatio: '169' }, TARGET)).toThrow(/比例档/)
    expect(() => buildGenerateArgs({ ...base, aspectRatio: '16:9' }, TARGET)).not.toThrow()
  })
})

describe('parseMmxJson', () => {
  it('解析 stdout 里的 JSON 对象（容忍前置日志行）', () => {
    expect(parseMmxJson('{"sizes":["1360x768"]}')).toEqual({ sizes: ['1360x768'] })
    expect(parseMmxJson('noise line\n{"a":1}')).toEqual({ a: 1 })
  })

  it('空与非 JSON 返回 null（调用方靠落盘文件兜底）', () => {
    expect(parseMmxJson('')).toBeNull()
    expect(parseMmxJson('not json')).toBeNull()
  })
})

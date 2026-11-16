// @dreamariner/dsh-image-design :: 图标美术单源守卫
//
// 清单（指南页）条目的图标与插件卡片的图标必须是同一份美术：
//   · 美术真源 = 包根 icon.svg
//   · 客户端用 = 构建期生成的 src/client/generated/icon-art.ts（icon.svg 原文）
// 本测试断言两者逐字节一致：改了 icon.svg 却没重生成（或手改了生成物）即红。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ICON_ART_SVG } from '../src/client/generated/icon-art.ts'

const PKG = join(process.cwd(), 'packages/dsh-image-design')

describe('图标美术单源', () => {
  it('生成物里的 SVG 原文与包根 icon.svg 逐字节一致', () => {
    const onDisk = readFileSync(join(PKG, 'icon.svg'), 'utf-8')
    expect(ICON_ART_SVG).toBe(onDisk)
  })

  it('生成物是内联的 SVG 原文（可直接做 data URI）', () => {
    expect(ICON_ART_SVG.trimStart().startsWith('<svg')).toBe(true)
    expect(ICON_ART_SVG).toContain('</svg>')
  })

  it('icon.svg 是透明底的 SVG 且体积在官方上限内（≤ 256 KiB）', () => {
    const onDisk = readFileSync(join(PKG, 'icon.svg'), 'utf-8')
    expect(onDisk).toContain('<svg')
    expect(onDisk).not.toContain('<image') // 不引外部位图
    expect(Buffer.byteLength(onDisk)).toBeLessThanOrEqual(256 * 1024)
  })
})

// @dreamariner/dsh-image-design :: 产出根目录解析
//
// 工作区分支用点开头的隐藏目录（.image-design）：产出是过程数据，不该和知识资产
// 混在同一层被扫进文档树或 git 跟踪范围。目录名一旦被改回 image-design，生成的
// 图片会静默进入知识库仓库的提交范围（这是 2026-11-15 实际发生的隐患），所以
// 在这里钉死。

import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultOutDir } from '../src/out-dir.ts'

describe('defaultOutDir', () => {
  it('有工作区：落在工作区根下的隐藏目录 .image-design', () => {
    expect(defaultOutDir('/ws')).toBe(join('/ws', '.image-design'))
  })

  it('目录名是点开头的隐藏目录（防止产出与知识资产混层、被扫进提交范围）', () => {
    expect(defaultOutDir('/ws').endsWith('/.image-design')).toBe(true)
  })

  it('取不到工作区：回落 DSH 存储区', () => {
    expect(defaultOutDir(null)).toBe(join(homedir(), '.dsh', 'storages', 'dsh-image-design', 'outputs'))
  })
})

// @dreamariner/dsh-image-design :: 历史归档与产物 allowlist
//
// run.json 是历史的唯一事实（先写 running 再写终态）；readImage 的 allowlist
// 是路径越界的最后防线。全部走临时目录，不碰真实输出区。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunId, deleteRun, listRuns, readRunImage, readRunRecord } from '../src/generate.ts'
import type { RunRecord } from '../src/contract.ts'

let outDir: string

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'dsh-image-design-hist-'))
})

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true })
})

function seedRun(id: string, createdAt: string, files: string[] = []): void {
  mkdirSync(join(outDir, id), { recursive: true })
  for (const f of files) writeFileSync(join(outDir, id, f), 'fake-image-bytes')
  const record: RunRecord = {
    id,
    createdAt,
    model: 'image-01',
    prompt: '测试',
    params: {},
    status: 'success',
    images: files.map((file) => ({ file })),
    successCount: files.length,
    failedCount: 0,
  }
  writeFileSync(join(outDir, id, 'run.json'), JSON.stringify(record), 'utf-8')
}

describe('历史归档', () => {
  it('createRunId 形如时间戳 + 随机尾，可作 mmx out-prefix', () => {
    expect(createRunId()).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/)
  })

  it('listRuns 只认有 run.json 的目录，按创建时间倒序', async () => {
    seedRun('20261115-100000-aaaa', '2026-11-15T10:00:00.000Z')
    seedRun('20261115-110000-bbbb', '2026-11-15T11:00:00.000Z')
    mkdirSync(join(outDir, '20261115-120000-cccc'), { recursive: true }) // 无清单：忽略
    const runs = await listRuns(outDir)
    expect(runs.map((r) => r.id)).toEqual(['20261115-110000-bbbb', '20261115-100000-aaaa'])
  })

  it('readRunRecord 对缺失与损坏清单返回 null', async () => {
    expect(await readRunRecord(outDir, 'missing')).toBeNull()
    mkdirSync(join(outDir, 'broken'), { recursive: true })
    writeFileSync(join(outDir, 'broken', 'run.json'), '{nope')
    expect(await readRunRecord(outDir, 'broken')).toBeNull()
  })

  it('readImage 走清单 allowlist：路径分隔符与未列文件都拒绝', async () => {
    seedRun('20261115-100000-aaaa', '2026-11-15T10:00:00.000Z', ['20261115-100000-aaaa_1.png'])
    const img = await readRunImage(outDir, '20261115-100000-aaaa', '20261115-100000-aaaa_1.png')
    expect(img.mime).toBe('image/png')
    expect(img.base64.length).toBeGreaterThan(0)
    await expect(readRunImage(outDir, '20261115-100000-aaaa', '../escape.png')).rejects.toThrow(/非法文件名/)
    await expect(readRunImage(outDir, '20261115-100000-aaaa', 'other.png')).rejects.toThrow(/清单/)
    await expect(readRunImage(outDir, '20261115-100000-aaaa', 'sub/inner.png')).rejects.toThrow(/非法文件名/)
  })

  it('jpg 与 webp 的 mime 推断', async () => {
    seedRun('20261115-100000-bbbb', '2026-11-15T10:00:00.000Z', ['x.jpg', 'y.webp'])
    expect((await readRunImage(outDir, '20261115-100000-bbbb', 'x.jpg')).mime).toBe('image/jpeg')
    expect((await readRunImage(outDir, '20261115-100000-bbbb', 'y.webp')).mime).toBe('image/webp')
  })

  it('deleteRun 移除整个运行目录；非法 runId 拒绝', async () => {
    seedRun('20261115-100000-aaaa', '2026-11-15T10:00:00.000Z', ['20261115-100000-aaaa_1.png'])
    expect(await deleteRun(outDir, '20261115-100000-aaaa')).toEqual({ ok: true })
    expect(await readRunRecord(outDir, '20261115-100000-aaaa')).toBeNull()
    await expect(deleteRun(outDir, '../escape')).rejects.toThrow(/非法运行号/)
  })
})

// @dreamariner/dsh-image-design :: 素体参考图存档测试
//
// refs/<refId>/ 目录结构、dataUrl 严格校验、清单 allowlist 防越界。
// 全部走临时目录，不碰真实输出区。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRefId, decodePngDataUrl, saveRefShot, listRefs, readRefImage, deleteRef,
  type RefShotInput,
} from '../src/mannequin-handlers.ts'

let outDir: string
let logLines: string[]

const deps = () => ({ resolveOutDir: () => outDir, mmxBin: 'mmx', timeoutMs: 660_000, log: (...a: unknown[]) => { logLines.push(a.join(' ')) } })

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** decodePngDataUrl 的错误分支窄化（返回值是非判别联合，in 窄化后取 error）。 */
function errOf(r: ReturnType<typeof decodePngDataUrl>): string {
  if (!('error' in r)) throw new Error('期望错误分支，实际返回了字节')
  return r.error
}

const body = { height: 170, shoulder: 1, bust: 1, waist: 1, hip: 1 }
const joints = { shoulderL: { x: 0, y: 0, z: 0 }, kneeL: { x: 0, y: 0, z: 0 } }
const shot = (over: Partial<RefShotInput> = {}): RefShotInput => ({
  dataUrl: PNG_1PX, body, poseId: 'a-pose', joints,
  camera: { shot: 'full', azimuth: 45 }, ...over,
})

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'dsh-image-design-refs-'))
  logLines = []
})

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true })
})

describe('createRefId', () => {
  it('形如 shot-时间戳-随机尾', () => {
    expect(createRefId()).toMatch(/^shot-\d{8}-\d{6}-[0-9a-f]{4}$/)
  })
})

describe('decodePngDataUrl', () => {
  it('合法 png dataUrl 返回字节', () => {
    const r = decodePngDataUrl(PNG_1PX)
    expect('error' in r).toBe(false)
    if (!('error' in r)) expect(r.bytes.length).toBeGreaterThan(0)
  })

  it('非 png 前缀拒绝', () => {
    expect(errOf(decodePngDataUrl('data:image/jpeg;base64,AAAA'))).toMatch(/png/)
    expect(errOf(decodePngDataUrl('not a url'))).toMatch(/png/)
  })

  it('空数据与非法 base64 拒绝', () => {
    expect(errOf(decodePngDataUrl('data:image/png;base64,'))).toMatch(/为空/)
    expect(errOf(decodePngDataUrl('data:image/png;base64,!!!='))).toMatch(/base64/)
  })

  it('超体积上限拒绝', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(11_000_001)
    expect(errOf(decodePngDataUrl(huge))).toMatch(/体积上限/)
  })
})

describe('参考图存档', () => {
  it('saveRefShot 落盘 png + ref.json（参数钉死），返回 absPath 存在', async () => {
    const r = await saveRefShot(deps(), shot())
    expect(r.refId).toMatch(/^shot-/)
    expect(r.file).toBe(`${r.refId}_001.png`)
    expect(existsSync(r.absPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(join(outDir, 'refs', r.refId, 'ref.json'), 'utf-8'))
    expect(manifest.poseId).toBe('a-pose')
    expect(manifest.joints.shoulderL).toEqual({ x: 0, y: 0, z: 0 })
    expect(manifest.camera).toEqual({ shot: 'full', azimuth: 45 })
    expect(logLines.some((l) => l.includes('素体参考图已保存'))).toBe(true)
  })

  it('listRefs 倒序列出瘦身摘要', async () => {
    await saveRefShot(deps(), shot())
    await new Promise((r) => setTimeout(r, 1100)) // createdAt 精度到毫秒，拉开排序
    const second = await saveRefShot(deps(), shot({ poseId: 'sit' }))
    const refs = await listRefs(outDir)
    expect(refs.map((r) => r.id)).toEqual([second.refId, refs[1].id])
    expect(refs[0].poseId).toBe('sit')
  })

  it('listRefs 带落盘绝对路径（历史参考图跨会话可直接当生成参考图）', async () => {
    const saved = await saveRefShot(deps(), shot())
    const refs = await listRefs(outDir)
    expect(refs[0].absPath).toBe(join(outDir, 'refs', saved.refId, saved.file))
    expect(existsSync(refs[0].absPath)).toBe(true)
  })

  it('readRefImage 走清单 allowlist，路径分隔符与未列文件拒绝', async () => {
    const r = await saveRefShot(deps(), shot())
    const img = await readRefImage(outDir, r.refId, r.file)
    expect(img.mime).toBe('image/png')
    await expect(readRefImage(outDir, r.refId, '../escape.png')).rejects.toThrow(/非法文件名/)
    await expect(readRefImage(outDir, r.refId, 'other.png')).rejects.toThrow(/清单/)
  })

  it('deleteRef 移除整个目录；非法 id 拒绝', async () => {
    const r = await saveRefShot(deps(), shot())
    expect(await deleteRef(outDir, r.refId)).toEqual({ ok: true })
    expect(existsSync(join(outDir, 'refs', r.refId))).toBe(false)
    await expect(deleteRef(outDir, '../escape')).rejects.toThrow(/非法参考图编号/)
  })

  it('listRefs 对空目录与坏目录返回可用项', async () => {
    expect(await listRefs(outDir)).toEqual([])
    await saveRefShot(deps(), shot())
    mkdirSync(join(outDir, 'refs', 'broken-dir'), { recursive: true }) // 没有 ref.json：忽略
    expect((await listRefs(outDir)).length).toBe(1)
  })
})

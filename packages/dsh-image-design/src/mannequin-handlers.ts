// 素体参考图存档：一轮拍摄 = refs/<refId>/ 目录（ref.json 清单 + PNG 产物）。
//
// 目录形态：<outDir>/refs/<refId>/ref_001.png
//          <outDir>/refs/<refId>/ref.json（体型参数 + 姿势关节表 + 相机，拍完即钉死，
//                                       防姿势库后续演进导致旧档不可复现）
//
// 纪律（照抄 generate.ts 的 runs 归档与 MPC saveAsset 的边界闸）：
//   · dataUrl 必须是 data:image/png;base64 前缀 + 合法 base64（清单白名单口径）
//   · 读图走清单 allowlist（ref.json images[].file），不接受任何路径分隔符
//   · 保存目标固定在本插件的输出区（resolveOutDir/refs），不落工作区文档树

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { GenerationDeps } from './generate.ts'
import type { BodyParamsSnapshot, CameraSnapshot, RefShotInput, RefShotRecord, RefSummary } from './contract.ts'

// wire 契约类型单源在 contract.ts（typert 生成器要求从公开类型子路径导出）；
// 这里转发导出保持本模块自洽（测试与 handlers 签名直接引用）。
export type { BodyParamsSnapshot, CameraSnapshot, RefShotInput, RefShotRecord, RefSummary }

const MAX_BASE64_LENGTH = 11_000_000 // ≈ 8MB 二进制（2048 长边 PNG 的宽松上限）
const PNG_DATAURL_PREFIX = 'data:image/png;base64,'
const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function refsDirOf(outDir: string): string {
  return join(outDir, 'refs')
}

function refDirOf(outDir: string, refId: string): string {
  return join(refsDirOf(outDir), refId)
}

/** 参考图编号：shot-20261117-104030-a1b2（前缀即产物文件名前缀）。 */
export function createRefId(now = new Date()): string {
  const stamp = [
    String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()),
    '-', pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()),
  ].join('')
  return `shot-${stamp}-${randomBytes(2).toString('hex')}`
}

/** dataUrl 的严格校验：png 前缀 + 合法 base64 + 体积上限。合法时返回字节。 */
export function decodePngDataUrl(dataUrl: string): { bytes: Buffer; base64Length: number } | { error: string } {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATAURL_PREFIX)) {
    return { error: '只接受 data:image/png;base64, 前缀的 dataUrl' }
  }
  const b64 = dataUrl.slice(PNG_DATAURL_PREFIX.length)
  if (b64.length === 0) return { error: '图片数据为空' }
  if (b64.length > MAX_BASE64_LENGTH) return { error: `图片超出体积上限（base64 ${b64.length} > ${MAX_BASE64_LENGTH}）` }
  if (b64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(b64)) return { error: '图片数据不是合法的 base64' }
  return { bytes: Buffer.from(b64, 'base64'), base64Length: b64.length }
}

export async function saveRefShot(deps: GenerationDeps, input: RefShotInput): Promise<{ refId: string; file: string; absPath: string }> {
  const outDir = deps.resolveOutDir()
  const decoded = decodePngDataUrl(input.dataUrl)
  if ('error' in decoded) throw new Error(decoded.error)
  const refId = createRefId()
  const dir = refDirOf(outDir, refId)
  await mkdir(dir, { recursive: true })

  const file = `${refId}_001.png`
  await writeFile(join(dir, file), decoded.bytes)

  const record: RefShotRecord = {
    id: refId,
    createdAt: new Date().toISOString(),
    body: input.body,
    poseId: input.poseId,
    joints: input.joints,
    camera: input.camera,
    images: [{ file }],
    ...(input.precise !== undefined ? { precise: input.precise } : {}),
    ...(input.measured !== undefined ? { measured: input.measured } : {}),
    ...(input.targets !== undefined ? { targets: input.targets } : {}),
    ...(input.note !== undefined && input.note !== '' ? { note: input.note } : {}),
  }
  await writeFile(join(dir, 'ref.json'), JSON.stringify(record, null, 2) + '\n', 'utf-8')
  deps.log(`素体参考图已保存：${refId}（${decoded.bytes.length} 字节）`)
  return { refId, file, absPath: join(dir, file) }
}

async function readRefRecord(outDir: string, refId: string): Promise<RefShotRecord | null> {
  try {
    const raw = await readFile(join(refDirOf(outDir, refId), 'ref.json'), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && 'id' in (parsed as object)) return parsed as RefShotRecord
    return null
  } catch {
    return null
  }
}

export async function listRefs(outDir: string, limit = 100): Promise<RefSummary[]> {
  let entries: string[] = []
  try {
    entries = await readdir(refsDirOf(outDir), { withFileTypes: true })
      .then((items) => items.filter((i) => i.isDirectory()).map((i) => i.name))
  } catch {
    return []
  }
  const records: RefShotRecord[] = []
  for (const id of entries) {
    const record = await readRefRecord(outDir, id)
    if (record !== null) records.push(record)
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return records.slice(0, limit).map((r) => {
    const file = r.images[0]?.file ?? ''
    return {
      id: r.id,
      createdAt: r.createdAt,
      poseId: r.poseId,
      file,
      // 落盘绝对路径：历史参考图跨会话也能直接当生成参考图用，不必重拍
      absPath: file === '' ? '' : join(refDirOf(outDir, r.id), file),
    }
  })
}

/** 读参考图字节（base64）。allowlist：file 必须在清单 images[].file 里。 */
export async function readRefImage(outDir: string, refId: string, file: string): Promise<{ base64: string; mime: string }> {
  if (file.includes('/') || file.includes('\\') || file.includes('..')) {
    throw new Error(`非法文件名：${file}`)
  }
  const record = await readRefRecord(outDir, refId)
  if (record === null) throw new Error(`参考图不存在：${refId}`)
  if (!record.images.some((img) => img.file === file)) {
    throw new Error(`文件不在该参考图清单里：${file}`)
  }
  const abs = join(refDirOf(outDir, refId), file)
  const buf = await readFile(abs)
  return { base64: buf.toString('base64'), mime: 'image/png' }
}

export async function deleteRef(outDir: string, refId: string): Promise<{ ok: true }> {
  if (refId.includes('/') || refId.includes('\\') || refId.includes('..')) {
    throw new Error(`非法参考图编号：${refId}`)
  }
  await rm(refDirOf(outDir, refId), { recursive: true, force: true })
  return { ok: true }
}

export interface MannequinHandlers {
  saveRefShot(args: RefShotInput): Promise<{ refId: string; file: string; absPath: string }>
  listRefs(): Promise<RefSummary[]>
  readRefImage(args: { refId: string; file: string }): Promise<{ base64: string; mime: string }>
  deleteRef(args: { refId: string }): Promise<{ ok: true }>
  readRefRecord(args: { refId: string }): Promise<RefShotRecord>
}

export function createMannequinHandlers(deps: GenerationDeps): MannequinHandlers {
  const outDir = (): string => deps.resolveOutDir()
  return {
    saveRefShot: (args) => saveRefShot(deps, args),
    listRefs: () => listRefs(outDir()),
    readRefImage: (args) => readRefImage(outDir(), args.refId, args.file),
    deleteRef: (args) => deleteRef(outDir(), args.refId),
    readRefRecord: async (args) => {
      const record = await readRefRecord(outDir(), args.refId)
      if (record === null) throw new Error(`参考图不存在：${args.refId}`)
      return record
    },
  }
}

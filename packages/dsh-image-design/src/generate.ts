// 生成编排与历史归档：一次生成 = 一个运行目录（runId 命名）+ 一份 run.json 清单。
//
// 目录形态：<outDir>/<runId>/<runId>_N.<ext>（图片，mmx 用 --out-prefix 落盘）
//          <outDir>/<runId>/run.json（清单，含参数与结果回告）
//
// 清单先写 running 再写终态：mmx 跑完之前客户端就可能关面板或重载，有 running
// 清单在，历史里能看到「进行中」的轮次；进程死在中途的轮次表现为清单停在 running。

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { buildGenerateArgs, parseMmxJson, runMmxBin } from './mmx.ts'
import type { GenerateParams, ImageModel, RunImage, RunRecord, RunSummary, RunUsage } from './contract.ts'

export type { RunImage, RunRecord, RunSummary, RunUsage } from './contract.ts'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** 运行号：20261115-104030-a1b2（时间排序 + 4 位随机尾，前缀即 mmx 的 out-prefix）。 */
export function createRunId(now = new Date()): string {
  const stamp = [
    String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()),
    '-', pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()),
  ].join('')
  return `${stamp}-${randomBytes(2).toString('hex')}`
}

export function runDirOf(outDir: string, runId: string): string {
  return join(outDir, runId)
}

function manifestPath(outDir: string, runId: string): string {
  return join(runDirOf(outDir, runId), 'run.json')
}

async function writeManifest(outDir: string, record: RunRecord): Promise<void> {
  await mkdir(runDirOf(outDir, record.id), { recursive: true })
  await writeFile(manifestPath(outDir, record.id), JSON.stringify(record, null, 2) + '\n', 'utf-8')
}

export async function readRunRecord(outDir: string, runId: string): Promise<RunRecord | null> {
  try {
    const raw = await readFile(manifestPath(outDir, runId), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && 'id' in (parsed as object)) {
      return parsed as RunRecord
    }
    return null
  } catch {
    return null
  }
}

/** 历史列表：只认有 run.json 的运行目录，按创建时间倒序。 */
export async function listRuns(outDir: string, limit = 100): Promise<RunSummary[]> {
  let entries: string[] = []
  try {
    entries = await readdir(outDir, { withFileTypes: true }).then((items) => items.filter((i) => i.isDirectory()).map((i) => i.name))
  } catch {
    return []
  }
  const records: RunRecord[] = []
  for (const id of entries) {
    const record = await readRunRecord(outDir, id)
    if (record !== null) records.push(record)
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return records.slice(0, limit).map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    model: r.model,
    prompt: r.prompt,
    status: r.status,
    successCount: r.successCount,
    failedCount: r.failedCount,
  }))
}

/**
 * 读单张产物的字节（base64）。防越界：file 必须出现在该轮清单里，
 * 不接受任何路径分隔符，读取动作只在运行目录内发生。
 */
export async function readRunImage(outDir: string, runId: string, file: string): Promise<{ base64: string; mime: string }> {
  if (file.includes('/') || file.includes('\\') || file.includes('..')) {
    throw new Error(`非法文件名：${file}`)
  }
  const record = await readRunRecord(outDir, runId)
  if (record === null) throw new Error(`运行不存在：${runId}`)
  if (!record.images.some((img) => img.file === file)) {
    throw new Error(`文件不在该轮清单里：${file}`)
  }
  const abs = join(runDirOf(outDir, runId), file)
  const buf = await readFile(abs)
  const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
  return { base64: buf.toString('base64'), mime }
}

export async function deleteRun(outDir: string, runId: string): Promise<{ ok: true }> {
  if (runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
    throw new Error(`非法运行号：${runId}`)
  }
  await rm(runDirOf(outDir, runId), { recursive: true, force: true })
  return { ok: true }
}

/** 从落盘目录收集本轮产物（按 mmx 的 out-prefix 过滤，不依赖 stdout 的文件清单）。 */
async function collectImages(outDir: string, runId: string): Promise<string[]> {
  try {
    const names = await readdir(runDirOf(outDir, runId))
    return names
      .filter((n) => n.startsWith(runId) && IMAGE_EXTS.has(n.slice(n.lastIndexOf('.')).toLowerCase()))
      .sort()
  } catch {
    return []
  }
}

/** mmx 回告的宽松提取：字段名对不上就忽略，落盘文件是最终事实。 */
function extractReport(payload: Record<string, unknown> | null): {
  saved: string[]
  sizes: string[]
  revisedPrompts: string[]
  usage: RunUsage | undefined
  successCount: number | undefined
  failedCount: number | undefined
} {
  // image-01 的 JSON 只有 saved（绝对路径）；H3 带 sizes / revised_prompts / 计数 / usage
  const saved = Array.isArray(payload?.saved)
    ? (payload?.saved as unknown[]).filter((s): s is string => typeof s === 'string' && s !== '').map((s) => s.slice(s.lastIndexOf('/') + 1))
    : []
  const sizes = Array.isArray(payload?.sizes) ? (payload?.sizes as unknown[]).filter((s): s is string => typeof s === 'string') : []
  const revisedPrompts = Array.isArray(payload?.revised_prompts)
    ? (payload?.revised_prompts as unknown[]).filter((s): s is string => typeof s === 'string')
    : []
  const rawUsage = payload?.usage
  const usage: RunUsage | undefined = rawUsage !== null && typeof rawUsage === 'object'
    ? {
        generatedImages: numOr((rawUsage as Record<string, unknown>).generated_images),
        totalTokens: numOr((rawUsage as Record<string, unknown>).total_tokens),
        inputTokens: numOr((rawUsage as Record<string, unknown>).input_tokens),
        outputTokens: numOr((rawUsage as Record<string, unknown>).output_tokens),
      }
    : undefined
  const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  return {
    saved,
    sizes,
    revisedPrompts,
    usage,
    successCount: count(payload?.success_count),
    failedCount: count(payload?.failed_count),
  }
}

function numOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** mmx 退出码的人类话术（1/2 之外的都是 skill 文档里的口径）。 */
function exitCodeMessage(code: number, timedOut: boolean): string {
  if (timedOut) return `mmx 超时被终止（客户端上限；服务端可能仍在完成，本次结果不进历史）`
  switch (code) {
    case 3: return 'mmx 认证失败（3）：先 mmx auth login --api-key <key>'
    case 4: return '配额不足（4）'
    case 5: return 'mmx 内部超时（5）'
    case 10: return '触发内容安全过滤（10）'
    case 2: return '参数用法错误（2）'
    default: return `mmx 失败，退出码 ${code}`
  }
}

/** 生成一图的 wire 参数 → GenerateParams（宿主内唯一入口，tool 与 Remote 共用）。 */
export function normalizeGenerateInput(raw: {
  model?: string
  prompt?: string
  aspectRatio?: string
  area?: string
  size?: string
  width?: number
  height?: number
  n?: number
  seed?: number
  promptOptimizer?: boolean
  promptEnhance?: boolean
  aigcWatermark?: boolean
  subjectRefImage?: string
  refImages?: string[]
}, defaultModel: ImageModel): GenerateParams {
  const prompt = (raw.prompt ?? '').trim()
  if (prompt === '') throw new Error('prompt 不能为空')
  const model: ImageModel = raw.model === 'MiniMax-H3-Image' || raw.model === 'image-01' ? raw.model : defaultModel
  const area = raw.area !== undefined && raw.area !== '' ? raw.area.toUpperCase() : undefined
  if (area !== undefined && area !== '1K' && area !== '2K' && area !== '4K') {
    throw new Error(`面积档只支持 1K/2K/4K，得到 ${raw.area}`)
  }
  const refs = (raw.refImages ?? []).map((s) => String(s).trim()).filter((s) => s !== '')
  return {
    model,
    prompt,
    ...(raw.aspectRatio !== undefined && raw.aspectRatio !== '' ? { aspectRatio: raw.aspectRatio } : {}),
    ...(area !== undefined ? { area } : {}),
    ...(raw.size !== undefined && raw.size !== '' ? { size: raw.size } : {}),
    ...(raw.width !== undefined ? { width: raw.width } : {}),
    ...(raw.height !== undefined ? { height: raw.height } : {}),
    ...(raw.n !== undefined ? { n: raw.n } : {}),
    ...(raw.seed !== undefined ? { seed: raw.seed } : {}),
    ...(raw.promptOptimizer !== undefined ? { promptOptimizer: raw.promptOptimizer } : {}),
    ...(raw.promptEnhance !== undefined ? { promptEnhance: raw.promptEnhance } : {}),
    ...(raw.aigcWatermark !== undefined ? { aigcWatermark: raw.aigcWatermark } : {}),
    ...(raw.subjectRefImage !== undefined && raw.subjectRefImage !== '' ? { subjectRefImage: raw.subjectRefImage } : {}),
    ...(refs.length > 0 ? { refImages: refs } : {}),
  }
}

export interface GenerationDeps {
  resolveOutDir: () => string
  mmxBin: string
  timeoutMs: number
  log: (...a: unknown[]) => void
}

/**
 * 跑一轮生成：建目录、写 running 清单、spawn mmx、收产物、写终态清单。
 *
 * ⚠ signal 只拦「尚未发出」这一段：mmx 一旦 spawn，请求已在路上，杀掉本地进程
 *   拿不回结果、服务端照样计费，所以发出后的等待**不响应取消**，结果照常进历史。
 */
export async function executeGeneration(deps: GenerationDeps, raw: Parameters<typeof normalizeGenerateInput>[0], signal?: AbortSignal): Promise<RunRecord> {
  const outDir = deps.resolveOutDir()
  const params = normalizeGenerateInput(raw, 'image-01')
  const { model: _m, prompt: _p, ...restParams } = params
  const runId = createRunId()
  const runDir = runDirOf(outDir, runId)
  await mkdir(runDir, { recursive: true })

  const base: RunRecord = {
    id: runId,
    createdAt: new Date().toISOString(),
    model: params.model,
    prompt: params.prompt,
    params: restParams,
    status: 'running',
    images: [],
    successCount: 0,
    failedCount: 0,
  }
  await writeManifest(outDir, base)
  deps.log(`生成开始：${runId}（model=${params.model}，outDir=${outDir}）`)

  const startedAt = Date.now()
  let argv: string[]
  try {
    argv = buildGenerateArgs(params, { outDir: runDir, outPrefix: runId })
  } catch (e) {
    const failed: RunRecord = {
      ...base,
      status: 'failed',
      message: `参数校验失败：${e instanceof Error ? e.message : String(e)}`,
      elapsedMs: Date.now() - startedAt,
    }
    await writeManifest(outDir, failed)
    throw e
  }

  const run = await runMmxBin(deps.mmxBin, argv, deps.timeoutMs, signal)
  const payload = parseMmxJson(run.stdout)
  const report = extractReport(payload)
  // 文件清单：mmx 的 saved 为权威（顺序即返回序）；prefix 扫描兜底（saved 缺失或漏记）
  const scanned = await collectImages(outDir, runId)
  const files = [...new Set([...report.saved.filter((f) => scanned.includes(f)), ...scanned])]
  const images: RunImage[] = files.map((file, i) => ({
    file,
    ...(report.sizes[i] !== undefined ? { size: report.sizes[i] } : {}),
    ...(report.revisedPrompts[i] !== undefined ? { revisedPrompt: report.revisedPrompts[i] } : {}),
  }))
  // 部分失败的差额：文件数与回告的成功数对不上时，把差额记成占位失败项
  const declaredSuccess = report.successCount ?? files.length
  const declaredFailed = report.failedCount ?? 0
  for (let i = images.length; i < declaredSuccess + declaredFailed; i++) {
    images.push({ file: '', ...(report.revisedPrompts[i] !== undefined ? { revisedPrompt: report.revisedPrompts[i] } : {}), error: '未产出文件（该张失败）' })
  }

  const ok = run.code === 0
  const elapsedMs = Date.now() - startedAt
  const record: RunRecord = {
    ...base,
    status: !ok && run.timedOut ? 'timeout'
      : !ok ? 'failed'
        : declaredFailed > 0 ? 'partial'
          : 'success',
    images,
    ...(report.usage !== undefined ? { usage: report.usage } : {}),
    successCount: Math.max(declaredSuccess, files.length),
    failedCount: declaredFailed,
    ...(!ok ? { message: `${exitCodeMessage(run.code, run.timedOut)}${run.stderr.trim() !== '' ? '：' + run.stderr.trim().split('\n').slice(0, 4).join(' / ') : ''}` } : {}),
    elapsedMs,
  }
  await writeManifest(outDir, record)
  deps.log(`生成结束：${runId}（status=${record.status}，files=${files.length}，耗时 ${elapsedMs}ms）`)
  return record
}

/** 轮次是否已结束（running 超过超时上限两倍视为中断遗留）。 */
export function isStaleRunning(record: RunRecord, timeoutMs: number): boolean {
  if (record.status !== 'running') return false
  const age = Date.now() - new Date(record.createdAt).getTime()
  return age > timeoutMs * 2
}

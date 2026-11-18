// 客户端侧的 Remote 最小面：形状与 Host 的 src/remote.ts 装饰器方法逐一对上
// （那侧由 typert 生成器做 codegen，本侧手写是为了信封解包）。
//
// 契约类型一律从公开类型子路径 ./types 取（contract.ts 的单源转发），不在客户端
// 手写副本：host 侧改字段，这里 typecheck 直接红。
//
// ⚠ 运行期命名空间返回的是信封（{ok, value, error}），不是裸值：直接把返回值当
//   数据用会在渲染时炸（例如把 {ok,value} 当数组 .map）。全部经 unwrap 走。

import type { GenerateWireArgs, ImageModel, RefShotInput, RefShotRecord, RefSummary, RunImage, RunRecord, RunSummary, RunUsage } from '@dreamariner/dsh-image-design/types'

export type ModelKey = ImageModel
export type RunView = RunRecord
export type RunImageView = RunImage
export type RunUsageView = RunUsage
export type RunSummaryView = RunSummary
export type RunStatus = RunView['status']
export type { GenerateWireArgs }
// 素体参考图的 wire 面（与 host 的 remote.ts 签名共用 contract 单源）
export type RefShotInputView = RefShotInput
export type RefSummaryView = RefSummary
export type RefView = RefShotRecord

export interface ImageDesignApi {
  ping(): Promise<{ pong: true; outDir: string; defaultModel: ModelKey }>
  generate(args: GenerateWireArgs): Promise<RunView>
  listRuns(): Promise<RunSummaryView[]>
  readRun(id: string): Promise<RunView>
  readImage(id: string, file: string): Promise<{ bytes: Uint8Array; mime: string }>
  deleteRun(id: string): Promise<void>
  // ── 素体参考图存档 ────────────────────────────────────────────────────
  saveRefShot(args: RefShotInputView): Promise<{ refId: string; file: string; absPath: string }>
  listRefs(): Promise<RefSummaryView[]>
  readRefImage(refId: string, file: string): Promise<{ bytes: Uint8Array; mime: string }>
  readRefRecord(refId: string): Promise<RefView>
  deleteRef(refId: string): Promise<void>
  // ── 精确素体资产（readAsset 白名单）────────────────────────────────────
  readAsset(name: string): Promise<{ bytes: Uint8Array; mime: string }>
}

/** Remote 信封：ok 取 value，!ok 抛错。 */
type Envelope<T> = { ok: boolean; value?: T; error?: { code: string; message: string } }

async function unwrap<T>(p: Promise<Envelope<unknown>>): Promise<T> {
  const r = await p
  if (r?.ok !== true) {
    throw new Error(`[${r?.error?.code ?? 'REMOTE_ERROR'}] ${r?.error?.message ?? '未知错误'}`)
  }
  return r.value as T
}

/** 从挂载好的 ctx.remote.imageDesign 命名空间建面板 api。 */
export function createImageDesignApi(ns: unknown): ImageDesignApi {
  const m = ns as Record<string, (args: unknown) => Promise<Envelope<unknown>>>
  return {
    ping: () => unwrap(m.ping({})),
    generate: (args) => unwrap(m.generate(args)),
    listRuns: () => unwrap(m.listRuns({})),
    readRun: (id) => unwrap(m.readRun({ id })),
    readImage: async (id, file) => {
      const v = await unwrap<{ base64: string; mime: string }>(m.readImage({ id, file }))
      return { bytes: base64ToBytes(v.base64), mime: v.mime }
    },
    deleteRun: async (id) => {
      await unwrap(m.deleteRun({ id }))
    },
    saveRefShot: (args) => unwrap(m.saveRefShot(args)),
    listRefs: () => unwrap(m.listRefs({})),
    readRefImage: async (refId, file) => {
      const v = await unwrap<{ base64: string; mime: string }>(m.readRefImage({ refId, file }))
      return { bytes: base64ToBytes(v.base64), mime: v.mime }
    },
    readRefRecord: (refId) => unwrap(m.readRefRecord({ refId })),
    deleteRef: async (refId) => {
      await unwrap(m.deleteRef({ refId }))
    },
    readAsset: async (name) => {
      const v = await unwrap<{ base64: string; mime: string }>(m.readAsset({ name }))
      return { bytes: base64ToBytes(v.base64), mime: v.mime }
    },
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// 业务处理器：Remote 与 Agent tool 共用同一套实现（防漂移），纯依赖注入、可单测。

import {
  deleteRun, executeGeneration, listRuns, readRunImage, readRunRecord,
  type GenerationDeps,
} from './generate.ts'
import type { GenerateWireArgs, ImageModel, RunRecord, RunSummary } from './contract.ts'

export type { GenerateWireArgs } from './contract.ts'

export interface ImageDesignDeps extends GenerationDeps {
  /** 默认模型（wire 未显式传 model 时用）。 */
  defaultModel: ImageModel
}

export interface ImageDesignHandlers {
  generate(args: GenerateWireArgs, signal?: AbortSignal): Promise<RunRecord>
  listRuns(): Promise<RunSummary[]>
  readRun(args: { id: string }): Promise<RunRecord>
  readImage(args: { id: string; file: string }): Promise<{ base64: string; mime: string }>
  deleteRun(args: { id: string }): Promise<{ ok: true }>
  ping(): Promise<{ pong: true; outDir: string; defaultModel: ImageModel }>
}

export function createImageDesignHandlers(deps: ImageDesignDeps): ImageDesignHandlers {
  return {
    generate: (args, signal) => executeGeneration(deps, args, signal),
    listRuns: () => listRuns(deps.resolveOutDir()),
    readRun: async (args) => {
      const record = await readRunRecord(deps.resolveOutDir(), args.id)
      if (record === null) throw new Error(`运行不存在：${args.id}`)
      return record
    },
    readImage: (args) => readRunImage(deps.resolveOutDir(), args.id, args.file),
    deleteRun: (args) => deleteRun(deps.resolveOutDir(), args.id),
    ping: () => Promise.resolve({ pong: true as const, outDir: deps.resolveOutDir(), defaultModel: deps.defaultModel }),
  }
}

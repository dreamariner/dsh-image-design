// @dreamariner/dsh-image-design 配置
// 校验语义：默认值填充 + 带路径的类型报错。schemastery 与宿主共享同一实例
// （peerDependencies 声明 + dev 精确钉版本），不要改成普通 dependency。

import z from '@deepseek-ai/schemastery'

export interface ImageDesignConfig {
  /** mmx 可执行文件（名字或绝对路径）。默认走 PATH 里的 mmx（npm i -g mmx-cli）。 */
  mmxBin: string
  /**
   * 产出根目录。留空 = 自动：有工作区用 `<工作区根>/image-design`，
   * 取不到工作区则回落 `~/.dsh/storages/dsh-image-design/outputs`。
   */
  outDir: string
  /**
   * mmx 子进程超时（毫秒）。MiniMax 图像接口服务端最长等待 600 秒，
   * 客户端超时必须不小于它，否则白花钱（接口非幂等：超时后服务端照样完成并计费）。
   */
  timeoutMs: number
  /** 默认模型：面板与 Agent tool 未显式指定时用它。 */
  defaultModel: string
}

export const Config: z<ImageDesignConfig> = z.object({
  mmxBin: z.string().default('mmx'),
  outDir: z.string().default(''),
  timeoutMs: z.number().default(660_000),
  defaultModel: z.string().default('image-01'),
})

/** 已知键（schemastery 的 Schema 类型不暴露 properties，故显式列出）。 */
export const KNOWN_KEYS = ['mmxBin', 'outDir', 'timeoutMs', 'defaultModel'] as const

/** schemastery 标准校验的同步封装：默认值填充 + 带路径报错；不支持异步校验。 */
export function resolveConfig<T>(schema: z<T>, raw: unknown, plugin: string): T {
  const result = (schema as unknown as { '~standard': { validate: (v: unknown) => unknown } })['~standard'].validate(raw) as
    | { issues?: Array<{ path?: string[]; message: string }>; value?: T }
    | undefined
  if (result === undefined || result === null) throw new Error(`[${plugin}] 配置校验无返回`)
  if (typeof (result as { then?: unknown }).then === 'function') {
    throw new TypeError(`[${plugin}] 不支持异步配置校验`)
  }
  if (result.issues !== undefined && result.issues.length > 0) {
    const detail = result.issues.map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message}`).join('；')
    throw new Error(`[${plugin}] 配置校验失败：${detail}`)
  }
  return result.value as T
}

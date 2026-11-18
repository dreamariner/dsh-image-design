// @dreamariner/dsh-image-design :: Node 半边入口
//
// cordis 插件接口三件套：export function apply(ctx, config) + 可选 export const inject
// + 可选 export const Config（声明了它，插件行的 config 就会在激活期被 schema 校验）。
//
// ⚠ inject 是白名单：只声明的 service 才会出现在 ctx 上，漏声明不报错，只是
//   ctx.tools 为 undefined；而 loader 静默吞掉插件异常，表现为「插件静默失效」。
//   所以对服务取用一律「取不到就明确抛错」，宁可装载失败也不要静默。
//
// 面：① Agent tool（dsh-image-design_generate，与面板 Remote 共用同一套 handlers）
//      ② Typert Remote（client 数据通道，契约见 src/remote.ts）

import { join, dirname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, KNOWN_KEYS, type ImageDesignConfig } from './config.ts'
import { defaultOutDir } from './out-dir.ts'
import { ImageDesignRemote } from './remote.ts'
import { createImageDesignHandlers, type ImageDesignDeps } from './remote-handlers.ts'
import type { ImageModel, RunRecord } from './contract.ts'

export const name = 'dsh-image-design'
export const inject = ['workspaceRegistry', 'tools']
export { Config }
// ⚠ 必须再导出：typert 生成器从包的 export 图收集 Remote 符号，漏 export = 生成器看不见
export { ImageDesignRemote }

/** 本插件用到的 tools 服务面（窄化：只声明用到的成员，cordis 的 Context 类型很宽）。 */
interface ToolsService {
  register(tool: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: { schema: { type: string }; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
    execute: (args: unknown) => Promise<string>
  }): void
}

/** 当前工作区根（单工作区部署取第一个；取不到返回 null）。 */
type WorkspaceRegistryFace = { list?: () => Array<{ path?: string }> }

function workspaceRootOf(ctx: Context): string | null {
  try {
    const registry = (ctx as unknown as { workspaceRegistry?: WorkspaceRegistryFace }).workspaceRegistry
    const list = registry?.list?.()
    const path = Array.isArray(list) ? list[0]?.path : undefined
    return typeof path === 'string' && path !== '' ? path : null
  } catch {
    return null
  }
}

/** 重导出：defaultOutDir 的实现拆到 out-dir.ts（纯函数零依赖，可单测），公开出口不变。 */
export { defaultOutDir }

function parseModel(v: string): ImageModel {
  return v === 'MiniMax-H3-Image' ? 'MiniMax-H3-Image' : 'image-01'
}

/** tool 的 JSON schema 参数面（snake_case，LLM 友好），与 GenerateWireArgs 一一对应。 */
const GENERATE_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: '图片描述（必填）。按「先任务后风格、先布局后细节」的规则写，效果差距很大' },
    model: { type: 'string', enum: ['image-01', 'MiniMax-H3-Image'], description: '模型。image-01=老接口（支持 seed/主体参考/像素宽高）；MiniMax-H3-Image=开源 SOTA 图像模型（支持参考图编辑与面积档），不传用默认' },
    aspect_ratio: { type: 'string', description: '比例档（W:H，如 16:9、3:4）' },
    area: { type: 'string', enum: ['1K', '2K', '4K'], description: 'H3 面积档，与 aspect_ratio 搭配。迭代用 2K，定稿才 4K' },
    size: { type: 'string', description: 'H3 精确尺寸（WxH，如 2720x1536），与 aspect_ratio/area 互斥' },
    width: { type: 'number', description: 'image-01 像素宽（512..2048，8 的倍数，与 height 成对）' },
    height: { type: 'number', description: 'image-01 像素高' },
    n: { type: 'number', description: '张数（1..10）。多张一次请求比多次请求省且快；档案卡类内容建议 n>=2 让人挑' },
    seed: { type: 'number', description: 'image-01 随机种子（可复现）' },
    prompt_optimizer: { type: 'boolean', description: 'image-01：生成前优化提示词' },
    prompt_enhance: { type: 'boolean', description: 'H3：提示词增强（默认开）。要完全控制模型读到的文字才关，关闭必须带显式尺寸' },
    aigc_watermark: { type: 'boolean', description: 'image-01：嵌入 AIGC 水印' },
    subject_ref_image: { type: 'string', description: 'image-01 主体参考图路径（type=character）' },
    ref_images: { type: 'array', items: { type: 'string' }, description: 'H3 参考图路径（1..16 张，带参考图自动走编辑接口）。多张时在 prompt 里写清各图分工' },
  },
  required: ['prompt'],
}

/** tool 入参（snake_case）→ wire 参数（camelCase）。 */
function toolArgsToWire(args: unknown): Record<string, unknown> {
  const a = (args ?? {}) as Record<string, unknown>
  return {
    prompt: a.prompt,
    model: a.model,
    aspectRatio: a.aspect_ratio,
    area: a.area,
    size: a.size,
    width: a.width,
    height: a.height,
    n: a.n,
    seed: a.seed,
    promptOptimizer: a.prompt_optimizer,
    promptEnhance: a.prompt_enhance,
    aigcWatermark: a.aigc_watermark,
    subjectRefImage: a.subject_ref_image,
    refImages: a.ref_images,
  }
}

/** RunRecord → 给模型看的纯文本摘要（文件路径逐行列出）。 */
function summarizeRun(record: RunRecord, outDir: string): string {
  const lines: string[] = [
    `run: ${record.id}（status=${record.status}，model=${record.model}，耗时 ${record.elapsedMs ?? '?'}ms）`,
    `目录: ${join(outDir, record.id)}`,
  ]
  for (const img of record.images) {
    lines.push(img.file === ''
      ? `失败: ${img.error ?? '未产出'}`
      : `文件: ${join(outDir, record.id, img.file)}${img.size !== undefined ? `（${img.size}）` : ''}`)
  }
  if (record.usage !== undefined) {
    lines.push(`用量: 生成 ${record.usage.generatedImages ?? '?'} 张 / tokens ${record.usage.totalTokens ?? '?'}（入 ${record.usage.inputTokens ?? '?'} / 出 ${record.usage.outputTokens ?? '?'}）`)
  }
  const revised = record.images.find((img) => img.revisedPrompt !== undefined)?.revisedPrompt
  if (revised !== undefined) lines.push(`revised_prompt: ${revised}`)
  if (record.message !== undefined) lines.push(`说明: ${record.message}`)
  return lines.join('\n')
}

export function apply(ctx: Context, rawConfig?: Partial<ImageDesignConfig> | null): void {
  // patch 里没有 config 时 YAML 会解析出 null，默认参数只对 undefined 生效，故显式兜底
  const config = resolveConfig(Config, rawConfig ?? {}, name)
  const log = (...args: unknown[]): void => { ctx.logger?.info?.(`[${name}]`, ...args) }

  // 包根目录：lib/index.js → 上两级到包根。import.meta.url 在 tsdown 打包后
  // 仍是本模块文件 URL，能稳定定位随包分发的 assets/（files 数组需含 assets）。
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  // 白名单：只允许精确素体需要的 3 个资产，杜绝路径穿越（照抄 readRefImage 纪律）
  const ASSET_ALLOWLIST = new Map([
    ['mannequin-body.glb', 'model/gltf-binary'],
    ['mannequin-morphs.bin', 'application/octet-stream'],
    ['mannequin-morphs.json', 'application/json'],
  ])
  const deps: ImageDesignDeps = {
    resolveOutDir: () => (config.outDir !== '' ? config.outDir : defaultOutDir(workspaceRootOf(ctx))),
    mmxBin: config.mmxBin,
    timeoutMs: config.timeoutMs,
    defaultModel: parseModel(config.defaultModel),
    log,
    readAsset: async (name) => {
      const mime = ASSET_ALLOWLIST.get(name)
      if (mime === undefined) throw new Error(`[${name}] asset 不在白名单：${name}`)
      const buf = await readFile(join(packageRoot, 'assets', name))
      return { base64: buf.toString('base64'), mime }
    },
  }

  // ── Typert Remote（client 数据通道）────────────────────────────────────
  ctx.plugin(ImageDesignRemote, deps)

  // ── Agent tool 面（与 Remote 共用 handlers，防漂移）─────────────────────
  const tools = (ctx as unknown as { tools?: ToolsService }).tools
  if (tools === undefined || typeof tools.register !== 'function') {
    throw new Error(`[${name}] ctx.tools 不可用:inject 白名单声明（['tools']）与服务实际名称不一致`)
  }
  const handlers = createImageDesignHandlers(deps)

  const toolName = 'dsh-image-design_generate'
  tools.register({
    name: toolName,
    description: '用 MiniMax 图片模型生成图片（image-01 或 MiniMax-H3-Image）。非幂等计费接口：一次调用就是一次真实生成，不要重试；结果自动落盘并进历史。传 ref_images 走图像编辑，可换背景/换风格/保持人物一致',
    parameters: GENERATE_TOOL_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: unknown) => {
      const record = await handlers.generate(toolArgsToWire(args))
      return summarizeRun(record, deps.resolveOutDir())
    },
  })
  log(`tool 已注册：${toolName}；Remote 已挂载（ctx.plugin(ImageDesignRemote, deps)）`)
}

// KNOWN_KEYS 导出给测试用（未知配置键守卫）；resolveConfig 的校验语义见 config.ts
export { KNOWN_KEYS }

// wire 契约类型（唯一事实源：host 的 remote.ts 签名、生成的 client 契约、
// Agent tool 参数面都从这里取）。
//
// ⚠ 只放类型，不放任何运行时代码：本模块经 src/types.ts 以公开类型子路径发布，
// typert 生成器要求 Remote 边界类型（方法参数/返回值引用的一切类型）从包的
// 公开非根类型子路径导出（"." 与 ./typert、./remote 均不计入），生成的
// lib/typert.remote-client.* 从这里 import 类型。
//
// 参数面与 mmx 1.0.29 的 image generate 旗标一一对齐；字段语义注释跟着旗标走。

/** 模型。image-01 = 老接口（seed / 主体参考 / 像素宽高）；MiniMax-H3-Image = 开源 SOTA（参考图编辑 / 面积档 / 精确尺寸）。 */
export type ImageModel = 'image-01' | 'MiniMax-H3-Image'

/** H3 面积档（面积由服务端按比例换算宽高，实际值看回告 sizes）。 */
export type ImageArea = '1K' | '2K' | '4K'

/** 单张产物（落盘文件 + 接口回告）。 */
export interface RunImage {
  /** 运行目录内的文件名（不是路径：readImage 走 allowlist 防越界；空串 = 该张失败）。 */
  file: string
  /** 接口回告的实际宽高（如 2720x1536）。 */
  size?: string
  /** 模型实际使用的提示词（最有价值的调试信息）。 */
  revisedPrompt?: string
  /** 部分失败时该张的报错。 */
  error?: string
}

/** 用量回告（token 计费口径）。 */
export interface RunUsage {
  generatedImages?: number
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
}

export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'timeout'

/** 一轮生成的完整清单（run.json 的内容，也是 generate 的 wire 返回形状）。 */
export interface RunRecord {
  id: string
  createdAt: string
  model: ImageModel
  prompt: string
  /** 原样存档的其余参数（无 prompt / model）。 */
  params: Omit<GenerateParams, 'model' | 'prompt'>
  status: RunStatus
  images: RunImage[]
  usage?: RunUsage
  successCount: number
  failedCount: number
  /** 失败 / 超时 / 部分失败时的补充说明。 */
  message?: string
  /** 端到端耗时（毫秒；running 清单没有）。 */
  elapsedMs?: number
}

/** 历史列表项（清单的瘦身版）。 */
export interface RunSummary {
  id: string
  createdAt: string
  model: ImageModel
  prompt: string
  status: RunStatus
  successCount: number
  failedCount: number
}

/**
 * 生成参数（对齐 mmx image generate 的旗标面）。非法组合在 argv 构造期抛错
 * （不发请求，不计费）。
 */
export interface GenerateParams {
  model: ImageModel
  prompt: string
  /** 比例档（W:H 形式，如 16:9）。 */
  aspectRatio?: string
  /** H3 面积档，与 aspectRatio 搭配使用。 */
  area?: ImageArea
  /** H3 精确尺寸 WxH（与 aspectRatio / area 互斥）。 */
  size?: string
  /** image-01 像素宽（512..2048，8 的倍数，与 height 成对）。 */
  width?: number
  /** image-01 像素高。 */
  height?: number
  /** 张数（1..10）。 */
  n?: number
  /** image-01 随机种子。 */
  seed?: number
  /** image-01：提示词优化开关。 */
  promptOptimizer?: boolean
  /** H3：提示词增强（默认开；false 时传 --no-prompt-enhance，必须带显式尺寸）。 */
  promptEnhance?: boolean
  /** image-01：AIGC 水印开关。 */
  aigcWatermark?: boolean
  /** image-01：主体参考（type=character 的单张参考图路径）。 */
  subjectRefImage?: string
  /** H3 参考图（1..16 张，带参考图自动走编辑接口）。 */
  refImages?: string[]
}

/** wire 参数的宽松形状（client 与 Agent tool 的入参都在这个面上）。 */
export interface GenerateWireArgs {
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
}

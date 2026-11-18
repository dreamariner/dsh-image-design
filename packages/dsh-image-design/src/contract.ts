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

// ── 素体参考图（refs/<refId>/ 存档的 wire 面）────────────────────────────

/** 素体体型参数快照（无单位约束，值域由 client 滑杆保证，存档原样保存）。 */
export interface BodyParamsSnapshot {
  [key: string]: number
}

/** 精确素体的宏观体型快照。 */
export interface PreciseMacroSnapshot {
  /** 性别 0=男性 1=女性。004 追加：HM08 中性网格上男女靠位移插值。 */
  gender?: number
  age: number
  fat: number
  muscle: number
  /**
   * @deprecated 004 早期字段（只有轮廓近似，无真性别维度）。
   * 仅为读旧档保留：gender = femaleShape>0 ? 1 : maleShape>0 ? 0 : 0.5。
   */
  femaleShape?: number
  /** @deprecated 同上。 */
  maleShape?: number
}

/**
 * 乳房形态快照（004 追加）。
 * 与 cm 围度解耦：cup/firmness 决定胸型，bust-circ 只校准尺寸。
 */
export interface PreciseBreastSnapshot {
  /** 罩杯 -1..1（mincup / averagecup / maxcup 三档插值）。 */
  cup: number
  /** 紧致度 -1..1（软塌下垂 ↔ 紧实上挺）。 */
  firmness: number
  /** 尖挺度 0..1。 */
  point: number
  /** 间距 0..1。 */
  gap: number
  /** 上提/下垂 -1..1。 */
  droop: number
  /** 乳头大小 0..1。 */
  nipple: number
}

/** 精确素体参数快照（cm 级测量 + 雕刻 + 宏观）。 */
export interface PreciseBodySnapshot {
  height: number
  /** 测量名 → 目标 cm（如 bust-circ: 92）。 */
  measurementsCm: Record<string, number>
  /** morph 名 → 雕刻权重。 */
  sculpt: Record<string, number>
  macro: PreciseMacroSnapshot
  /** 乳房形态（004 追加；旧档无此字段走默认中性）。 */
  breast?: PreciseBreastSnapshot
}

/** 测量回显快照（目标 vs 实测，拍参考图时钉死以证可复现）。 */
export interface MeasureEchoSnapshot {
  name: string
  targetCm: number
  measuredCm: number
}

/** 拍摄时钉死的相机参数快照。 */
export interface CameraSnapshot {
  [key: string]: string | number
}

/** 意图目标里的单个末端目标（issue 005 的 wire 形状；与客户端 PoseTargets 同构）。 */
export interface RefPoseTarget {
  /** 固定位置（模型空间，米）。 */
  pos?: { x: number; y: number; z: number }
  /** 语义锚点：贴在某体段上（求解时按当前几何解析）。 */
  anchor?: { part: string; t: number; radialDeg: number; gapM: number }
  forward?: { x: number; y: number; z: number }
  normal?: { x: number; y: number; z: number }
  pitchDeg?: number
  poleHint?: string
}

/**
 * 意图目标（issue 005）：高层姿势意图（末端该在哪），进 ref.json。
 *
 * 为什么存意图而不只存关节表：关节表是**解算结果**，换个体型就复现不出；
 * 意图是**作者意图**，回放时按当前体型重解，得到的仍是同一个姿势 ✓。
 */
export interface RefPoseTargets {
  /** 根（骨盆）在模型空间的位置。 */
  root: { x: number; y: number; z: number }
  /**
   * 各末端目标（缺省者不参与求解）。
   *
   * 值类型不带 undefined：wire 面必须全是 JSON 类型（typert 的边界闸会拒
   * `T | undefined` 的索引签名）；「这个末端没目标」用**缺这个键**表达 ✓。
   */
  effectors: Record<string, RefPoseTarget>
  /** 头部目标（模型空间，米）。 */
  head?: { x: number; y: number; z: number }
}

/** 参考图清单（ref.json 内容，也是 readRefRecord 的 wire 返回形状）。 */
export interface RefShotRecord {
  id: string
  createdAt: string
  body: BodyParamsSnapshot
  /** 姿势库条目 id（unknown = 手调关节非库内姿势）。 */
  poseId: string
  /** 拍摄时的完整关节旋转表（弧度），姿势库演进也不影响旧档复现。 */
  joints: Record<string, { x: number; y: number; z: number }>
  camera: CameraSnapshot
  images: Array<{ file: string }>
  /** 精确素体参数（004 新增；旧档无此字段，回放走 003 解析场）。 */
  precise?: PreciseBodySnapshot
  /** 精确测量的目标 vs 实测回显（004 新增）。 */
  measured?: MeasureEchoSnapshot[]
  /** 意图目标（issue 005 新增；旧档无此字段，回放走关节表）。 */
  targets?: RefPoseTargets
  note?: string
}

/** 参考图历史列表项（瘦身版；absPath 供客户端直接填进生成的参考图清单）。 */
export interface RefSummary {
  id: string
  createdAt: string
  poseId: string
  file: string
  /** 落盘绝对路径（客户端「用作生成参考图」直接用，不必依赖当次会话缓存）。 */
  absPath: string
}

/** 拍摄入参（wire 面；dataUrl 严格校验在宿主侧）。 */
export interface RefShotInput {
  dataUrl: string
  body: BodyParamsSnapshot
  poseId: string
  joints: Record<string, { x: number; y: number; z: number }>
  camera: CameraSnapshot
  precise?: PreciseBodySnapshot
  measured?: MeasureEchoSnapshot[]
  /** 意图目标（issue 005 新增；存了就能按当前体型重解回放）。 */
  targets?: RefPoseTargets
  note?: string
}

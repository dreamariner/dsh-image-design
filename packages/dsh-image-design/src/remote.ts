// @dreamariner/dsh-image-design :: Typert Remote 契约（codegen 的单一来源）
//
// 本文件用标准装饰器（TC39，TS 5.9 原生）声明 wire 契约；构建期 typertPlugin 会：
//   ① 把标准装饰器降级为可运行形态（rolldown/oxc 原生不降标准装饰器）；
//   ② 从装饰器方法生成 lib/typert.host.*（服务类型 + wire codec）与
//     lib/typert.remote-client.*（client 侧契约 + 类型化 RPC 客户端）。
//
// 契约约束（违反会在构建期或运行期踩坑）：
//   · 方法名 = wire 端点名；形参名必须与 wire 名逐字一致（统一 args，末位 signal）；
//   · super(ctx, '<key>') 的服务键必须是字符串字面量（标识符会报
//     "Gateway service key must be a string literal"），且与下方 Context 增强的
//     属性名一致；
//   · 本类必须在 src/index.ts 里 re-export：生成器从包的 export 图收集符号，
//     漏 export = 生成器看不见它。
//
// 实现全部委托 remote-handlers.ts（薄契约 + 可单测的实现）。方法只声明 wire 面，
// 取消语义在 generate 上有特殊说明：signal 只拦「尚未发出」这一段（接口非幂等，
// 发出后杀进程拿不回结果还照样计费）。

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createImageDesignHandlers, type ImageDesignDeps, type ImageDesignHandlers } from './remote-handlers.ts'
import type { GenerateWireArgs, ImageModel, RunRecord, RunSummary } from './contract.ts'

// 服务契约的 Context 增强：client 与宿主侧都能类型化地访问 ctx.remote.<key>。
declare module '@deepseek-ai/cordis' {
  interface Context {
    imageDesign: ImageDesignRemote
  }
}

export class ImageDesignRemote extends TypertRemoteService {
  private readonly handlers: ImageDesignHandlers

  constructor(ctx: any, deps?: ImageDesignDeps) {
    // ⚠ 必须字符串字面量：typert 生成器静态读取 service key；与 Context 增强属性名一致
    super(ctx, 'imageDesign')
    if (deps === undefined) {
      // apply 里必须传 deps（ctx.plugin(ImageDesignRemote, deps)）；漏传宁可装载失败
      throw new Error('[dsh-image-design] ImageDesignRemote 缺 deps：插件 apply 未注入（mmx / 输出目录配置）')
    }
    this.handlers = createImageDesignHandlers(deps)
    deps.log(`Remote 已注册：service=imageDesign（generate/listRuns/readRun/readImage/deleteRun/ping）`)
  }

  /** 探活：回显输出目录与默认模型，client 用它做连通性检查。 */
  @Remote('ping')
  ping(args: Record<string, never>, signal: AbortSignal): Promise<{ pong: true; outDir: string; defaultModel: ImageModel }> {
    signal.throwIfAborted()
    return this.handlers.ping()
  }

  /**
   * 跑一轮图片生成。⚠ 取消语义：signal 只在请求尚未发出前生效；mmx 已 spawn 后
   * 的等待不响应取消（接口非幂等，杀进程 = 白花钱且丢失产物），结果照常进历史。
   */
  @Remote('generate')
  generate(args: GenerateWireArgs, signal: AbortSignal): Promise<RunRecord> {
    signal.throwIfAborted()
    return this.handlers.generate(args, signal)
  }

  /** 历史轮次列表（创建时间倒序）。 */
  @Remote('listRuns')
  listRuns(args: Record<string, never>, signal: AbortSignal): Promise<RunSummary[]> {
    signal.throwIfAborted()
    return this.handlers.listRuns()
  }

  /** 读一轮的完整清单（含图片文件名 allowlist）。 */
  @Remote('readRun')
  readRun(args: { id: string }, signal: AbortSignal): Promise<RunRecord> {
    signal.throwIfAborted()
    return this.handlers.readRun(args)
  }

  /** 读单张产物的 base64（file 必须在该轮清单里，防路径越界）。 */
  @Remote('readImage')
  readImage(args: { id: string; file: string }, signal: AbortSignal): Promise<{ base64: string; mime: string }> {
    signal.throwIfAborted()
    return this.handlers.readImage(args)
  }

  /** 删除一轮（运行目录整体移除）。 */
  @Remote('deleteRun')
  deleteRun(args: { id: string }, signal: AbortSignal): Promise<{ ok: true }> {
    signal.throwIfAborted()
    return this.handlers.deleteRun(args)
  }
}

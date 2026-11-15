// mmx CLI 子进程封装：argv 构造（纯函数，可单测）与执行（绝不自动重试）。
//
// MiniMax 图像接口的硬规则（mmx-h3-image skill，违反会重复计费或丢失产物）：
//   · 接口非幂等：请求发出后即使超时或断开，服务端照样完成并对成功图片计费，
//     所以这里没有任何重试逻辑；
//   · 客户端超时 ≥ 600 秒（服务端最长等待），由 config.timeoutMs 保证；
//   · 模型必须显式传：老接口 image-01 与 MiniMax-H3-Image 的参数面完全不同；
//   · 结果必须立刻落盘：--out-dir 交给 mmx 下载（返回 URL 24 小时失效）。

import { spawn } from 'node:child_process'
import type { GenerateParams, ImageModel } from './contract.ts'

// 类型公开面在 contract.ts（types 子路径发布）；这里保留类型出口便于旧引用
export type { GenerateParams, ImageModel } from './contract.ts'

/** 产物落盘目标。 */
export interface GenerateTarget {
  outDir: string
  outPrefix: string
}

const ASPECT_RE = /^\d{1,2}:\d{1,2}$/
const SIZE_RE = /^\d{2,5}x\d{2,5}$/

/** 校验并构造 mmx argv；非法输入直接抛错（在发请求前拦住，不计费）。 */
export function buildGenerateArgs(p: GenerateParams, target: GenerateTarget): string[] {
  const args: string[] = ['image', 'generate', '--model', p.model, '--prompt', p.prompt]

  const hasAspect = p.aspectRatio !== undefined && p.aspectRatio !== ''
  const hasSize = p.size !== undefined && p.size !== ''
  const hasWH = p.width !== undefined && p.height !== undefined

  if ([hasAspect, hasSize, hasWH].filter(Boolean).length > 1) {
    throw new Error('尺寸只能选一种：比例档、精确尺寸（H3）或像素宽高（image-01）')
  }

  if (hasAspect) {
    if (!ASPECT_RE.test(p.aspectRatio!)) throw new Error(`比例档不合法：${p.aspectRatio}（应为 W:H 形式，如 16:9）`)
    args.push('--aspect-ratio', p.aspectRatio!)
    if (p.model === 'MiniMax-H3-Image') {
      if (p.area === undefined) throw new Error('H3 比例档必须带面积档（1K/2K/4K）')
      args.push('--area', p.area)
    } else if (p.area !== undefined) {
      throw new Error('--area 是 H3 的参数，image-01 不支持')
    }
  } else if (hasSize) {
    if (!SIZE_RE.test(p.size!)) throw new Error(`精确尺寸不合法：${p.size}（应为 WxH，如 2720x1536）`)
    if (p.model !== 'MiniMax-H3-Image') throw new Error('--size 是 H3 的参数；image-01 请用像素宽高')
    args.push('--size', p.size!)
  } else if (hasWH) {
    if (p.model === 'MiniMax-H3-Image') throw new Error('H3 不支持像素宽高；用比例档 + 面积档或精确尺寸')
    for (const [k, v] of [['width', p.width!], ['height', p.height!]] as const) {
      if (!Number.isInteger(v) || v < 512 || v > 2048 || v % 8 !== 0) {
        throw new Error(`${k} 必须是 512..2048 之间 8 的倍数，得到 ${v}`)
      }
    }
    args.push('--width', String(p.width), '--height', String(p.height))
  } else {
    throw new Error('必须提供尺寸：比例档（+面积档）、精确尺寸（H3）或像素宽高（image-01）')
  }

  if (p.n !== undefined) {
    if (!Number.isInteger(p.n) || p.n < 1 || p.n > 10) throw new Error(`张数必须是 1..10，得到 ${p.n}`)
    if (p.n > 1) args.push('--n', String(p.n))
  }

  if (p.seed !== undefined) {
    if (p.model !== 'image-01') throw new Error('--seed 是 image-01 的参数，H3 不支持')
    if (!Number.isInteger(p.seed)) throw new Error(`seed 必须是整数，得到 ${p.seed}`)
    args.push('--seed', String(p.seed))
  }

  if (p.promptOptimizer === true) {
    if (p.model !== 'image-01') throw new Error('--prompt-optimizer 是 image-01 的参数，H3 不支持')
    args.push('--prompt-optimizer')
  }

  if (p.model === 'MiniMax-H3-Image' && p.promptEnhance === false) {
    // H3 默认开增强；关闭必须已带显式尺寸（CLI 会拦，这里前置报错更省一轮排障）
    if (!hasAspect && !hasSize) throw new Error('关闭提示词增强需要显式尺寸（比例档或精确尺寸）')
    args.push('--no-prompt-enhance')
  }

  if (p.aigcWatermark === true) {
    if (p.model !== 'image-01') throw new Error('--aigc-watermark 是 image-01 的参数，H3 不支持')
    args.push('--aigc-watermark')
  }

  if (p.subjectRefImage !== undefined && p.subjectRefImage !== '') {
    if (p.model !== 'image-01') throw new Error('主体参考是 image-01 的参数；H3 用参考图（refImages）')
    args.push('--subject-ref', `type=character,image=${p.subjectRefImage}`)
  }

  if (p.refImages !== undefined && p.refImages.length > 0) {
    if (p.model !== 'MiniMax-H3-Image') throw new Error('参考图是 H3 的参数；image-01 用主体参考（subjectRefImage）')
    if (p.refImages.length > 16) throw new Error(`参考图最多 16 张，得到 ${p.refImages.length}`)
    for (const img of p.refImages) args.push('--image', img)
  }

  args.push('--out-dir', target.outDir, '--out-prefix', target.outPrefix)
  // Agent 旗标：stdout 纯数据、快速失败、不进交互
  args.push('--output', 'json', '--quiet', '--non-interactive')
  return args
}

export interface MmxRunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * 执行 mmx 子进程。无重试（接口非幂等）；超时 SIGTERM 杀进程后按失败归档。
 * 信号（signal）只在**尚未 spawn 前**生效：请求已发出的情况下杀进程拿不回任何
 * 结果还照样计费，所以调用方传来的取消语义只拦「还没发」这一段。
 */
export function runMmxBin(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<MmxRunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('生成已取消（请求尚未发出，未计费）'))
      return
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      reject(new Error(`无法启动 mmx（${bin}）：${e instanceof Error ? e.message : String(e)}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, Math.max(1_000, timeoutMs))

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => reject(new Error(
        err.code === 'ENOENT'
          ? `找不到 mmx 可执行文件（${bin}）：先 npm install -g mmx-cli，或在插件配置 mmxBin 里指定完整路径`
          : `mmx 启动失败（${bin}）：${err.message}`,
      )))
    })
    child.on('close', (code) => {
      finish(() => resolve({ code: code ?? -1, stdout, stderr, timedOut }))
    })
  })
}

/** 把 mmx 的 JSON stdout 解出来；解析失败返回 null（调用方靠落盘文件兜底）。 */
export function parseMmxJson(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim()
  if (text === '') return null
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

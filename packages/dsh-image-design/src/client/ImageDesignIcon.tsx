// 图片设计的清单图标（指南页条目用）。
//
// 美术**不另画**：包根 icon.svg 是唯一美术源（插件卡片用同一份），
// 构建期由 scripts/generate-icon-art.mjs 生成成字符串常量，这里以 data URI 渲染。
// 字节级同一份图形，不存在「插件卡片一个样、清单另一个样」的漂移。
//
// 为什么不用宿主 sprite：官方规范禁止第三方插件 require @deepseek-ai/dsh-client-* 包，
// sprite 表也在宿主手里；自带 SVG 是复制式插件的正当路径。

import { ICON_ART_SVG } from './generated/icon-art.ts'

/** SVG 原文 → data URI（encodeURIComponent 保结构，避免 base64 体积翻倍）。 */
const ICON_DATA_URI = `data:image/svg+xml;utf8,${encodeURIComponent(ICON_ART_SVG)}`

/** 图片设计图标：宿主传 size（22 / 26），className 透传。 */
export function ImageDesignIcon({ size = 22, className }: { size?: number; className?: string }): React.ReactElement {
  return (
    <img
      src={ICON_DATA_URI}
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}

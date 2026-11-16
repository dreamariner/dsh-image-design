// 图片设计的清单图标（指南页条目用）。
//
// 规范与 ui/icons.tsx 一致：currentColor 上色、aria-hidden、尺寸走 size prop。
// 画法与包内 icon.svg 同源（圆角画框 + 山形 + 太阳），但这里必须走 inline path：
// 指南页的条目图标是**宿主渲染的 React 组件**（host 传 size / className），
// 不读插件包的 icon.svg（那份是 Plugin Manager / Settings 的插件展示资源）。
//
// 为什么不用宿主 sprite：官方规范禁止第三方插件 require @deepseek-ai/dsh-client-* 包，
// sprite 表也在宿主手里；inline path 是复制式插件的正当路径。

import type { IconProps } from './ui/icons.tsx'

/** 图片设计：圆角画框 + 山形 + 太阳（图片语义），currentColor 描边。 */
export function ImageDesignIcon({ size = 22, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1.4}>
      <rect x="2.6" y="4.6" width="18.8" height="14.8" rx="3" stroke="currentColor" />
      <path d="M5.2 17.4l4.6-5.4 3 3.4 2.6-3 3.4 5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8.4" cy="9.4" r="1.7" stroke="currentColor" />
    </svg>
  )
}

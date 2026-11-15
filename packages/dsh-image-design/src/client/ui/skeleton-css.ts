// skeleton 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/skeleton.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'skeleton': 'duc-skeleton',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-skeleton {\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-skeleton);\n  animation: duc-skeleton-skeleton-pulse 1.6s ease-in-out infinite;\n}\n\n@keyframes duc-skeleton-skeleton-pulse {\n  0%, 100% { opacity: 1; }\n  50% { opacity: 0.45; }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .duc-skeleton { animation: none; }\n}\n"

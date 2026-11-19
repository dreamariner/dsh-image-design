// spinner 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/spinner.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'spinner': 'duc-spinner',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-spinner {\n  display: inline-block;\n  flex: none;\n  border: 1.5px solid var(--dsw-alias-border-l3);\n  border-top-color: var(--dsw-alias-brand-primary);\n  border-radius: 50%;\n  animation: duc-spinner-spinner-rotate 700ms linear infinite;\n}\n\n@keyframes duc-spinner-spinner-rotate {\n  to { transform: rotate(360deg); }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .duc-spinner { animation-duration: 2s; }\n}\n"

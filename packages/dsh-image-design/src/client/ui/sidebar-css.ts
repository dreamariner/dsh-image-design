// sidebar 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/sidebar.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'sidebar': 'duc-sidebar',
  'header': 'duc-sidebar-header',
  'content': 'duc-sidebar-content',
  'footer': 'duc-sidebar-footer',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-sidebar {\n  display: flex;\n  flex-direction: column;\n  flex: none;\n  height: 100%;\n  box-sizing: border-box;\n  border-right: 0.5px solid var(--dsw-alias-border-l4);\n  background: var(--dsw-alias-bg-layer-1);\n  transition: width var(--ds-transition-duration) var(--ds-ease-in-out);\n  overflow: hidden;\n}\n\n.duc-sidebar-header {\n  flex: none;\n  padding: var(--dsh-space-12);\n  border-bottom: 0.5px solid var(--dsw-alias-border-l4);\n}\n\n.duc-sidebar-content {\n  flex: 1 1 0;\n  min-height: 0;\n  overflow-y: auto;\n  padding: var(--dsh-space-8);\n  scrollbar-width: thin;\n  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;\n}\n\n.duc-sidebar-footer {\n  flex: none;\n  padding: var(--dsh-space-12);\n  border-top: 0.5px solid var(--dsw-alias-border-l4);\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .duc-sidebar { transition: none; }\n}\n"

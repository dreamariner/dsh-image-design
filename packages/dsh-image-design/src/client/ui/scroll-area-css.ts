// scroll-area 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/scroll-area.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'scrollArea': 'duc-scroll-area-scrollArea',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-scroll-area-scrollArea {\n  overflow: auto;\n  scrollbar-width: thin;\n  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent;\n}\n\n.duc-scroll-area-scrollArea::-webkit-scrollbar {\n  width: 8px;\n  height: 8px;\n}\n\n.duc-scroll-area-scrollArea::-webkit-scrollbar-thumb {\n  border-radius: var(--dsw-radius-sm);\n  background: var(--dsw-alias-scrollbar-bg-l2);\n}\n\n.duc-scroll-area-scrollArea::-webkit-scrollbar-thumb:hover {\n  background: var(--dsw-alias-scrollbar-hover-l2);\n}\n\n.duc-scroll-area-scrollArea::-webkit-scrollbar-track {\n  background: transparent;\n}\n"

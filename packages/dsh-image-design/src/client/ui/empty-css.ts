// empty 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/empty.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'empty': 'duc-empty',
  'media': 'duc-empty-media',
  'title': 'duc-empty-title',
  'description': 'duc-empty-description',
  'content': 'duc-empty-content',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-empty {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: var(--dsh-space-8);\n  padding: var(--dsh-space-32) var(--dsh-space-24);\n  text-align: center;\n}\n\n.duc-empty-media {\n  display: flex;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.duc-empty-title {\n  font: var(--dsw-font-m-18);\n  color: var(--dsw-alias-label-primary);\n}\n\n.duc-empty-description {\n  margin: 0;\n  max-width: 360px;\n  font: var(--dsw-font-s-14);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.duc-empty-content {\n  margin-top: var(--dsh-space-8);\n}\n"

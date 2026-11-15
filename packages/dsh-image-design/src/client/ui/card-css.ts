// card 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/card.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'card': 'duc-card',
  'header': 'duc-card-header',
  'title': 'duc-card-title',
  'description': 'duc-card-description',
  'content': 'duc-card-content',
  'footer': 'duc-card-footer',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-card {\n  display: flex;\n  flex-direction: column;\n  box-sizing: border-box;\n  border: 0.5px solid var(--dsw-alias-border-l4);\n  border-radius: var(--dsw-radius-panel);\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.duc-card-header {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  padding: 18px 20px 8px;\n}\n\n.duc-card-title {\n  margin: 0;\n  font: var(--dsw-font-m-18);\n  color: var(--dsw-alias-label-primary);\n}\n\n.duc-card-description {\n  margin: 0;\n  font: var(--dsw-font-s-14);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.duc-card-content {\n  padding: 12px 20px;\n}\n\n.duc-card-footer {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 8px 20px 18px;\n}\n"

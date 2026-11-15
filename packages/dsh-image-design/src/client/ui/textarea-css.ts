// textarea 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/textarea.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'textarea': 'duc-textarea',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = "/* Textarea: 多行输入的 token 化外衣（本仓自有，规格对齐 Input.module.css）。 */\n.duc-textarea {\n  box-sizing: border-box;\n  display: block;\n  width: 100%;\n  padding: 6px 8px;\n  border: 0.5px solid var(--dsw-alias-border-l4);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-layer-1);\n  outline: none;\n  font-family: inherit;\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-label-primary);\n  resize: vertical;\n}\n\n.duc-textarea:focus {\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n.duc-textarea::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n\n.duc-textarea:disabled {\n  cursor: not-allowed;\n  opacity: 0.4;\n}\n"

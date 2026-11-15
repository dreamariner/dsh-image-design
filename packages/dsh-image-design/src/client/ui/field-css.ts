// field 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/field.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'field': 'duc-field',
  'label': 'duc-field-label',
  'description': 'duc-field-description',
  'error': 'duc-field-error',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-field {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.duc-field-label {\n  font: var(--dsw-font-s-14);\n  color: var(--dsw-alias-label-primary);\n  user-select: none;\n}\n\n.duc-field-description {\n  margin: 0;\n  font: var(--dsw-font-xs-13);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.duc-field-error {\n  margin: 0;\n  font: var(--dsw-font-xs-13);\n  color: var(--dsw-alias-state-error-primary);\n}\n"

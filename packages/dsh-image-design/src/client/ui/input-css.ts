// input 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/input.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'wrap': 'duc-input-wrap',
  'icon': 'duc-input-icon',
  'input': 'duc-input',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-input-wrap {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  height: 32px;\n  padding: 0 8px;\n  border: 0.5px solid var(--dsw-alias-border-l4);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.duc-input-wrap:focus-within {\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n.duc-input-icon {\n  display: inline-flex;\n  width: 16px;\n  height: 16px;\n  align-items: center;\n  justify-content: center;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.duc-input {\n  flex: 1;\n  min-width: 0;\n  border: none;\n  outline: none;\n  background: transparent;\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.duc-input::placeholder {\n  color: var(--dsw-alias-label-dimmed);\n}\n"

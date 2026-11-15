// button 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/button.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'button': 'duc-button',
  'md': 'duc-button-md',
  'sm': 'duc-button-sm',
  'primary': 'duc-button-primary',
  'ghost': 'duc-button-ghost',
  'outline': 'duc-button-outline',
  'toolbar': 'duc-button-toolbar',
  'icon': 'duc-button-icon',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = "/* Button sizes share the global control-radius scale. */\n.duc-button {\n  box-sizing: border-box;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 4px;\n  border: none;\n  border-radius: var(--dsw-radius-md);\n  cursor: pointer;\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-label-primary);\n  background: transparent;\n  padding: 0 14px;\n}\n\n.duc-button:disabled {\n  cursor: not-allowed;\n  opacity: 0.4;\n}\n\n.duc-button-md {\n  height: 36px;\n}\n\n/* Compact controls retain their dimensions across filled and outlined variants. */\n.duc-button-sm {\n  height: 28px;\n  font-size: 12px;\n  line-height: 18px;\n  padding: 0 10px;\n  border-radius: var(--dsw-radius-sm);\n}\n\n.duc-button-primary {\n  background: var(--dsw-alias-button-primary-fill);\n  color: var(--dsw-alias-label-primary-foreground);\n}\n\n@media (hover: hover) {\n  .duc-button-primary:hover:not(:disabled) {\n    background: var(--dsw-alias-button-primary-hover);\n  }\n\n  .duc-button-ghost:hover:not(:disabled) {\n    background: var(--dsw-alias-interactive-bg-hover);\n  }\n}\n\n.duc-button-ghost:active:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-active);\n}\n\n/* The transparent border preserves layout; the inset stroke stays complete at fractional widths. */\n.duc-button-outline {\n  border: 0.5px solid transparent;\n  background: transparent;\n  box-shadow: inset 0 0 0 var(--dsh-hairline-width, 0.5px) var(--dsh-button-outline-color, var(--dsw-alias-border-l3));\n}\n\n@media (hover: hover) {\n  .duc-button-outline:hover:not(:disabled) {\n    background: var(--dsw-alias-interactive-bg-hover);\n  }\n}\n\n.duc-button-toolbar {\n  background: var(--dsw-alias-button-tool-bar-fill);\n}\n\n@media (hover: hover) {\n  .duc-button-toolbar:hover:not(:disabled) {\n    background: var(--dsw-alias-button-tool-bar-hover);\n  }\n}\n\n.duc-button-icon {\n  display: inline-flex;\n  width: 16px;\n  height: 16px;\n  align-items: center;\n  justify-content: center;\n}\n"

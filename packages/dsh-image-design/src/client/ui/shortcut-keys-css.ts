// shortcut-keys 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/shortcut-keys.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'keys': 'duc-shortcut-keys-keys',
  'key': 'duc-shortcut-keys-key',
  'tooltip': 'duc-shortcut-keys-tooltip',
  'separator': 'duc-shortcut-keys-separator',
  'joined': 'duc-shortcut-keys-joined',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-shortcut-keys-keys {\n  display: inline-flex;\n  flex: none;\n  align-items: center;\n  gap: 3px;\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n  line-height: 16px;\n  white-space: nowrap;\n}\n\n.duc-shortcut-keys-key {\n  box-sizing: border-box;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  font: inherit;\n}\n\n.duc-shortcut-keys-tooltip { color: inherit; font-size: 11px; line-height: 14px; gap: 2px; }\n.duc-shortcut-keys-tooltip .duc-shortcut-keys-key {\n  min-width: 16px;\n  height: 16px;\n  padding: 0 2px;\n  border-radius: 4px;\n  border: 0;\n  background: var(--dsw-alias-tooltip-key-bg);\n}\n\n.duc-shortcut-keys-separator { font: inherit; }\n\n.duc-shortcut-keys-joined { box-sizing: border-box; height: 16px; padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-tooltip-key-bg); }\n.duc-shortcut-keys-joined .duc-shortcut-keys-key { min-width: 0; height: auto; padding: 0; border: 0; background: transparent; }\n"

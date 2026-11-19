// switch 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/switch.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'switch': 'duc-switch',
  'thumb': 'duc-switch-thumb',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = "/* The on/off appearance keys off aria-checked rather than a parallel class, so\n * the visual state cannot disagree with the state assistive technology reads.\n *\n * The capsule track and circular thumb opt out of the global superellipse. */\n.duc-switch {\n  box-sizing: border-box;\n  position: relative;\n  flex: 0 0 auto;\n  width: 36px;\n  height: 20px;\n  padding: 2px;\n  border: 0;\n  border-radius: 999px;\n  corner-shape: round;\n  background: var(--dsw-alias-border-l3);\n  cursor: pointer;\n}\n\n.duc-switch[aria-checked='true'] {\n  background: var(--dsw-alias-brand-primary);\n}\n\n.duc-switch:disabled {\n  cursor: default;\n  opacity: 0.5;\n}\n\n.duc-switch:focus-visible {\n  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));\n  outline-offset: 2px;\n}\n\n.duc-switch-thumb {\n  display: block;\n  width: 16px;\n  height: 16px;\n  border-radius: 50%;\n  corner-shape: round;\n  background: var(--dsw-alias-label-primary-foreground);\n  transition: transform 120ms ease;\n}\n\n.duc-switch[aria-checked='false'] .duc-switch-thumb {\n  background: var(--dsw-alias-switch-thumb);\n}\n\n.duc-switch[aria-checked='true'] .duc-switch-thumb {\n  transform: translateX(16px);\n}\n"

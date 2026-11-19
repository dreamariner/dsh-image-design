// slider 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/slider.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'slider': 'duc-slider',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-slider {\n  appearance: none;\n  width: 100%;\n  height: 4px;\n  margin: 0;\n  border-radius: var(--dsw-radius-sm);\n  background: var(--dsw-alias-bg-skeleton);\n  outline: none;\n  cursor: pointer;\n}\n\n.duc-slider::-webkit-slider-thumb {\n  appearance: none;\n  width: 14px;\n  height: 14px;\n  border: none;\n  border-radius: 50%;\n  background: var(--dsw-alias-brand-primary);\n  cursor: grab;\n}\n\n.duc-slider::-webkit-slider-thumb:active {\n  cursor: grabbing;\n}\n\n.duc-slider::-moz-range-thumb {\n  width: 14px;\n  height: 14px;\n  border: none;\n  border-radius: 50%;\n  background: var(--dsw-alias-brand-primary);\n  cursor: grab;\n}\n\n.duc-slider:focus-visible {\n  outline: 2px solid var(--dsw-alias-state-business-primary);\n  outline-offset: 2px;\n}\n"

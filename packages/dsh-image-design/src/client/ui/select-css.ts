// select 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/select.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'wrap': 'duc-select-wrap',
  'select': 'duc-select',
  'chevron': 'duc-select-chevron',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = "/* Select: native <select> 的 token 化外衣（本仓自有，规格对齐 Input.module.css）。 */\n.duc-select-wrap {\n  position: relative;\n  display: inline-flex;\n  align-items: center;\n  box-sizing: border-box;\n  height: 32px;\n  border: 0.5px solid var(--dsw-alias-border-l4);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.duc-select-wrap:focus-within {\n  border-color: var(--dsw-alias-state-business-primary);\n}\n\n/* 原生 select 铺满包裹层并隐藏自身箭头（右侧改用宿主风格的 chevron）。 */\n.duc-select {\n  appearance: none;\n  box-sizing: border-box;\n  width: 100%;\n  height: 100%;\n  /* 右内边距是组合值：8（右偏移）+ 14（chevron 图标）+ 6（图标与文字的间隔），\n     不是节奏值，故不归一到刻度（issue 012 的组合值例外）。 */\n  padding: 0 28px 0 var(--dsh-space-8);\n  border: none;\n  outline: none;\n  background: transparent;\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n}\n\n.duc-select:disabled {\n  cursor: not-allowed;\n  opacity: 0.4;\n}\n\n.duc-select-chevron {\n  position: absolute;\n  right: 8px;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  color: var(--dsw-alias-label-tertiary);\n  pointer-events: none;\n}\n"

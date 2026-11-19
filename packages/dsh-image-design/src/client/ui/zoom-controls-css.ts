// zoom-controls 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/zoom-controls.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'panel': 'duc-zoom-controls-panel',
  'visible': 'duc-zoom-controls-visible',
  'controlAnchor': 'duc-zoom-controls-controlAnchor',
  'zoomButton': 'duc-zoom-controls-zoomButton',
  'percent': 'duc-zoom-controls-percent',
  'zoomMenu': 'duc-zoom-controls-zoomMenu',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = "/* Zero specificity lets an owner className move the toolbar regardless of stylesheet order. */\n:where(.duc-zoom-controls-panel) {\n  bottom: 14px;\n}\n\n.duc-zoom-controls-panel {\n  position: absolute;\n  z-index: 2;\n  inset-inline-start: 50%;\n  display: flex;\n  align-items: center;\n  gap: 2px;\n  box-sizing: border-box;\n  padding: 4px 6px;\n  /* TODO: replace this border and the literal shadow with `border: 0` and `--dsw-elevation-panel`\n   * (docs/web-styling.md#component-rules), with visual review of the document preview. */\n  border: 0.5px solid var(--dsw-alias-border-l3);\n  border-radius: var(--dsw-radius-lg);\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-layer-1);\n  box-shadow: 0 8px 24px light-dark(#0000001a, #00000060), 0 2px 5px light-dark(#00000009, #00000035);\n  font-size: 12px;\n  line-height: 18px;\n  opacity: 0;\n  pointer-events: none;\n  transform: translate(-50%, 16px) scale(0.98);\n  transition: opacity 160ms ease-in, transform 160ms cubic-bezier(0.4, 0, 1, 1);\n  will-change: opacity, transform;\n}\n\n.duc-zoom-controls-visible {\n  opacity: 1;\n  pointer-events: auto;\n  transform: translate(-50%, 0) scale(1);\n  transition: opacity 140ms ease-out, transform 180ms cubic-bezier(0.22, 1, 0.36, 1);\n}\n\n.duc-zoom-controls-controlAnchor { display: flex; }\n.duc-zoom-controls-zoomButton { width: 28px; padding: 0; flex: none; }\n.duc-zoom-controls-percent { display: inline-flex; align-items: center; justify-content: center; gap: 2px; min-width: 58px; padding-inline: 6px; font-variant-numeric: tabular-nums; }\n.duc-zoom-controls-zoomMenu { min-width: 112px; }\n\n@media (hover: none), (pointer: coarse) {\n  .duc-zoom-controls-panel {\n    opacity: 1;\n    pointer-events: auto;\n    transform: translate(-50%, 0) scale(1);\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .duc-zoom-controls-panel,\n  .duc-zoom-controls-visible { transition-duration: 0.01ms; }\n}\n"

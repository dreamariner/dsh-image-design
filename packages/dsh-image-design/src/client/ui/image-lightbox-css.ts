// image-lightbox 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/image-lightbox.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'backdrop': 'duc-image-lightbox-backdrop',
  'stage': 'duc-image-lightbox-stage',
  'mask': 'duc-image-lightbox-mask',
  'image': 'duc-image-lightbox-image',
  'close': 'duc-image-lightbox-close',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = "/* Full-viewport layer that blocks background clicks, including on the Windows caption. */\n.duc-image-lightbox-backdrop {\n  position: fixed;\n  inset: 0;\n  z-index: 1000;\n}\n\n/* Painted area below the Windows caption; like Modal, the caption stays unpainted. */\n.duc-image-lightbox-stage {\n  position: absolute;\n  inset: var(--dsh-frame-chrome-top, 0px) 0 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  padding: 40px;\n}\n\n/* Shared dimming mask below the preview and its controls. */\n.duc-image-lightbox-mask {\n  position: absolute;\n  inset: 0;\n  background: var(--dsw-alias-bg-mask-1);\n  backdrop-filter: var(--dsw-mask-blur);\n}\n\n.duc-image-lightbox-image {\n  position: relative;\n  max-width: min(100%, 1600px);\n  max-height: 100%;\n  object-fit: contain;\n  border-radius: var(--dsw-radius-lg);\n  background: var(--dsw-specific-input-major);\n  border: 0;\n  box-shadow: var(--dsw-elevation-prominent);\n}\n\n.duc-image-lightbox-close {\n  position: absolute;\n  top: 20px;\n  right: 20px;\n  z-index: 1;\n  display: grid;\n  place-items: center;\n  width: 36px;\n  height: 36px;\n  border: 0.5px solid var(--dsw-alias-border-l2-darkmode-thin);\n  border-radius: 999px;\n  corner-shape: round;\n  background: var(--dsw-specific-input-major);\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n}\n\n.duc-image-lightbox-close:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 3px; }\n"

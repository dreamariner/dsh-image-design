// image-preview 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/image-preview.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'frame': 'duc-image-preview-frame',
  'image': 'duc-image-preview-image',
  'status': 'duc-image-preview-status',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-image-preview-frame {\n  position: relative;\n  display: grid;\n  place-items: center;\n  width: 100%;\n  height: 180px;\n  overflow: hidden;\n  border-radius: var(--dsw-radius-sm);\n  background: var(--dsw-alias-bg-base);\n}\n.duc-image-preview-image { width: 100%; height: 100%; min-height: 0; object-fit: contain; opacity: 0; }\n.duc-image-preview-image[data-ready] { opacity: 1; }\n.duc-image-preview-status {\n  position: absolute;\n  inset: 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 8px;\n  padding: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n  line-height: 18px;\n}\n"

// card 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/card.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'card': 'duc-card',
  'header': 'duc-card-header',
  'title': 'duc-card-title',
  'description': 'duc-card-description',
  'content': 'duc-card-content',
  'footer': 'duc-card-footer',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-card {\n  display: flex;\n  flex-direction: column;\n  box-sizing: border-box;\n  border: 0.5px solid var(--dsw-alias-border-l4);\n  /* 圆角档位：卡片是「内容容器」，用 lg(16px) —— 与上游的卡片一致\n     （GenericCommandCard / MessageItem / PlanPreview 都是 lg），\n     也与本仓的浮层组件（hover-card / toast / menu-surface）同档。\n     panel(28px) 是留给模态框与浮层面板的（上游 Modal / 设置面板 / 输入栏），\n     卡片用这一档会显得突兀（issue 019）。 */\n  border-radius: var(--dsw-radius-lg);\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.duc-card-header {\n  display: flex;\n  flex-direction: column;\n  gap: var(--dsh-space-4);\n  padding: var(--dsh-space-16) var(--dsh-space-20) var(--dsh-space-8);\n}\n\n.duc-card-title {\n  margin: 0;\n  font: var(--dsw-font-m-18);\n  color: var(--dsw-alias-label-primary);\n}\n\n.duc-card-description {\n  margin: 0;\n  font: var(--dsw-font-s-14);\n  color: var(--dsw-alias-label-secondary);\n}\n\n.duc-card-content {\n  padding: var(--dsh-space-12) var(--dsh-space-20);\n}\n\n.duc-card-footer {\n  display: flex;\n  align-items: center;\n  gap: var(--dsh-space-8);\n  padding: var(--dsh-space-8) var(--dsh-space-20) var(--dsh-space-16);\n}\n"

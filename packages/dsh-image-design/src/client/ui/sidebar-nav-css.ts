// sidebar-nav 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/sidebar-nav.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'nav': 'duc-sidebar-nav-nav',
  'group': 'duc-sidebar-nav-group',
  'groupLabel': 'duc-sidebar-nav-groupLabel',
  'item': 'duc-sidebar-nav-item',
  'itemText': 'duc-sidebar-nav-itemText',
  'icon': 'duc-sidebar-nav-icon',
  'badge': 'duc-sidebar-nav-badge',
  'badgeDot': 'duc-sidebar-nav-badgeDot',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-sidebar-nav-nav {\n  display: flex;\n  flex-direction: column;\n  gap: var(--dsh-space-16);\n  min-width: 0;\n}\n\n.duc-sidebar-nav-group {\n  display: flex;\n  flex-direction: column;\n  gap: var(--dsh-space-2);\n}\n\n.duc-sidebar-nav-groupLabel {\n  padding: 0 var(--dsh-space-8);\n  font: var(--dsw-font-xs-13);\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.duc-sidebar-nav-item {\n  position: relative;\n  display: flex;\n  align-items: center;\n  gap: var(--dsh-space-8);\n  box-sizing: border-box;\n  width: 100%;\n  padding: var(--dsh-space-6) var(--dsh-space-8);\n  border: none;\n  border-radius: var(--dsw-radius-sm);\n  background: transparent;\n  cursor: pointer;\n  text-align: left;\n  font: var(--dsw-font-s-14);\n  color: var(--dsw-alias-label-secondary);\n  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),\n    color var(--ds-transition-duration-fast) var(--ds-ease-in-out);\n}\n\n@media (hover: hover) {\n  .duc-sidebar-nav-item:hover:not(:disabled) {\n    background: var(--dsw-alias-interactive-bg-hover);\n  }\n}\n\n.duc-sidebar-nav-item[aria-current] {\n  background: var(--dsw-alias-button-ghost-active-fill);\n  box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border);\n  color: var(--dsw-alias-label-primary);\n  font-weight: 500;\n}\n\n.duc-sidebar-nav-item:disabled {\n  cursor: not-allowed;\n  opacity: 0.4;\n}\n\n.duc-sidebar-nav-itemText {\n  flex: 1 1 auto;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.duc-sidebar-nav-icon {\n  flex: none;\n  display: inline-flex;\n  align-items: center;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.duc-sidebar-nav-item[aria-current] .duc-sidebar-nav-icon {\n  color: var(--dsw-alias-label-primary);\n}\n\n.duc-sidebar-nav-badge {\n  flex: none;\n  padding: 0 var(--dsh-space-6);\n  border-radius: 999px;\n  corner-shape: round;\n  background: var(--dsw-alias-bg-module-platform);\n  font: var(--dsw-font-xs-13);\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* 收起态：徽标缩成一个圆点，**叠在图标右上角**（绝对定位、不占布局位）——\n   圆点若占布局位会和图标并排居中，图标被挤偏、圆点悬成个「白圈」（issue 027）。\n   点色用 brand 实心（复审：module-platform 近白灰压白底几乎看不见，很难发现）。 */\n.duc-sidebar-nav-badgeDot {\n  position: absolute;\n  top: var(--dsh-space-4);\n  right: var(--dsh-space-4);\n  width: var(--dsh-space-6);\n  height: var(--dsh-space-6);\n  border-radius: 50%;\n  background: var(--dsw-alias-brand-primary);\n}\n\n/* 收起态：只显示图标，条目收成图标位（宽度由 Sidebar 的 collapsedWidth 决定）。 */\n.duc-sidebar-nav-nav[data-collapsed] .duc-sidebar-nav-item {\n  justify-content: center;\n  padding: var(--dsh-space-6);\n}\n\n.duc-sidebar-nav-nav[data-collapsed] .duc-sidebar-nav-icon {\n  color: var(--dsw-alias-label-secondary);\n}\n\n.duc-sidebar-nav-nav[data-collapsed] .duc-sidebar-nav-item[aria-current] .duc-sidebar-nav-icon {\n  color: var(--dsw-alias-label-primary);\n}\n\n/* 降级：减少动效时悬停/选中直接变色（issue 012） */\n@media (prefers-reduced-motion: reduce) {\n  .duc-sidebar-nav-item { transition: none; }\n}\n"

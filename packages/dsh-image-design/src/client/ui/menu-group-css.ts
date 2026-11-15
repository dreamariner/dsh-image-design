// menu-group 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/menu-group.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'group': 'duc-menu-group-group',
  'start': 'duc-menu-group-start',
  'heading': 'duc-menu-group-heading',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = "/*\n * menu-group.css：Menu 的行为依赖（官方 helper 保真复制）。\n * 上游来源：packages/client/ui-primitives/src/MenuGroup.module.css @ dsh v0.2.2-rc.1 (66491b05e3)\n */\n.duc-menu-group-group {\n  position: relative;\n}\n\n.duc-menu-group-start {\n  position: absolute;\n  top: 0;\n  left: 0;\n  width: 1px;\n  height: 1px;\n  opacity: 0;\n  pointer-events: none;\n}\n\n.duc-menu-group-group + .duc-menu-group-group {\n  margin-top: 3px;\n}\n\n.duc-menu-group-heading {\n  position: sticky;\n  top: 0;\n  z-index: 1;\n  padding: 4px 7px 2px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 11px;\n  line-height: 16px;\n  font-weight: 500;\n}\n\n.duc-menu-group-heading[data-stuck] {\n  background: var(--dsw-alias-menu-group-header-fill);\n}\n\n:global(html:not([data-platform='darwin'])) .duc-menu-group-heading {\n  border-radius: var(--dsw-radius-md);\n}\n"

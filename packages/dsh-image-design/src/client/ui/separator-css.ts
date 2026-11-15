// separator 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/separator.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {
  'separator': 'duc-separator',
  'horizontal': 'duc-separator-horizontal',
  'vertical': 'duc-separator-vertical',
}

/** 样式文本（注入 <style> 用）。 */
export const styles = ".duc-separator {\n  flex: none;\n  background: var(--dsw-alias-border-l3);\n}\n\n.duc-separator-horizontal {\n  width: 100%;\n  height: 0.5px;\n}\n\n.duc-separator-vertical {\n  width: 0.5px;\n  align-self: stretch;\n}\n"

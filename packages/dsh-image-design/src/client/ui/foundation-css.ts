// foundation 样式（由 dsh-ui-cell add 生成，勿手改）。
// 源：dsh-ui-cell/src/foundation.css @ duc- 前缀 + 组件名段（keyframes 同规则改名）。
// 第三方插件的 client 构建无 CSS 管线，样式走运行时 <style> 注入（见插件的 panel-css 约定）。
// 源里的 :global(...) 外壳已剥掉（运行期注入的纯 CSS 不认这个伪类，内层契约类名原样保留）。

/** 类名表：键是原类名，值是加前缀与组件名段后的最终类名。 */
export const css: Record<string, string> = {

}

/** 样式文本（注入 <style> 用）。 */
export const styles = "/*\n * foundation.css — 本仓实现层的基础变量（间距刻度）。\n *\n * 为什么有这一层（2026-11-18 起，issue 012）：\n *   官方 DSH 把设计 token 分工写得很清楚：\n *     · `docs/web-styling.md`：`ui-theme` owns the `--dsw-*` static scale, semantic\n *       aliases, typography, **motion**, gradients, shadows... Feature packages\n *       consume semantic aliases and **do not define another global theme**；\n *       shared colors, typography, elevation, and **motion belong to the theme package**。\n *     · `.agents/skills/dsh-client-ui-ux/references/spacing.md` 末句：\n *       **This skill defines no numeric scale**（官方给间距语义，不给数值）。\n *     · 同 skill 的 SKILL.md：numeric scales stay with their implementation owners\n *       （数值刻度归实现方）。\n *   所以：颜色 / 字体 / 层级 / 动效一律不碰官方的面，动效直接用官方 token\n *   （--ds-transition-duration{,-fast,-slow} / --ds-ease-in-out）；\n *   **间距刻度是官方明确留白的那块地，本仓作为第三方插件组件的实现方补齐**。\n *\n * 变量名前缀 `--dsh-space-*`（官方是 `--dsw-*`）：不与官方命名空间撞车，\n * 官方日后自己加 spacing token 也不会互相覆盖。\n *\n * 为什么定义在 `:root`：\n *   消费端把全部组件样式拼进**同一个 `<style>`** 注入宿主页面，`:root` 即 `<html>`，\n *   变量对整页生效，组件内任何位置都能取到（不依赖「必须在某个根类的子树里」这种\n *   隐含前提，避免 var() 解析失败导致的静默失效）。\n *   变量名带 `--dsh-` 前缀，多个插件同时注入同名变量时取值一致（刻度是规范定死的），\n *   互相覆盖不出问题。\n *\n * 刻度（4px 底座，2px 半步）：\n *   1 / 2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32\n * 语义角色、归一规则与例外见 `docs/wiki/04-间距与动效规范.md` 与 `docs/issues/012`。\n *   `0` 不进刻度（复位值不是节奏值，`margin: 0` 保持字面量）。\n *   `0.5px` 是发丝描边补偿（`margin-left: -0.5px`），不是间距，保持字面量。\n *\n * 改刻度是一次有意的决定：`tests/registry.spec.ts` 里有一张期望表钉住这里的取值，\n * 两处必须一起改（护栏会红）。\n */\n\n:root {\n  /* 发丝级缝隙（1px 分隔间隙） */\n  --dsh-space-1: 1px;\n  /* 图标与文字、极紧组内 */\n  --dsh-space-2: 2px;\n  /* 组内元素（紧） */\n  --dsh-space-4: 4px;\n  /* 组内元素（中）、控件内紧凑留白 */\n  --dsh-space-6: 6px;\n  /* 控件内边距、卡片内边距 */\n  --dsh-space-8: 8px;\n  /* 块内边距 */\n  --dsh-space-12: 12px;\n  /* 区块之间 */\n  --dsh-space-16: 16px;\n  /* 大块内边距 */\n  --dsh-space-20: 20px;\n  /* 区块分隔 */\n  --dsh-space-24: 24px;\n  /* 大留白 */\n  --dsh-space-32: 32px;\n}\n"

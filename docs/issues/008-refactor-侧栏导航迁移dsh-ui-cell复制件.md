---
id: 008
type: refactor
title: 侧栏导航迁移 dsh-ui-cell 复制件（sidebar + sidebar-nav）
status: done
priority: P2
labels: []
created: 2026-11-20
updated: 2026-11-20
assignee: jianan
related: [007]
---

# 008 · 侧栏导航迁移 dsh-ui-cell 复制件

## 背景

issue 007 把三视图入口从顶栏 Tab 改成左侧栏时，用的是手写 `idi-nav / idi-nav-item`
+ 原生 button。林老师指出本仓纪律是「控件一律走 dsh-ui-cell 复制件」，且 registry
里本就有现成的 `sidebar`（壳：三段 + 收起态 Context）与 `sidebar-nav`（分组导航：
图标 / 徽标 / 选中态，0.6.1 起），选型时漏查了 registry，属**选型偏离**。

## 目标

- 侧栏导航改用 dsh-ui-cell 复制件 `Sidebar` + `SidebarNav`，删掉手写 `idi-nav` 族
  样式与按钮渲染，行为（三视图切换、busy 指示在 footer）不变。

## 方案

- `npx @dreamariner/dsh-ui-cell@0.6.1 add sidebar sidebar-nav --to
  packages/dsh-image-design --prefix duc-`：4 个文件进 `src/client/ui/`
  （sidebar.tsx / sidebar-css.ts / sidebar-nav.tsx / sidebar-nav-css.ts），
  add note 依赖序 foundation → sidebar → sidebar-nav。
- `panel-css.ts`：CELL_STYLES 按依赖序插进 foundation 之后；删 `.idi-nav` /
  `.idi-nav-item` / `.idi-nav-spacer`，保留 `.idi-nav-busy`（只管 footer 槽内竖排布局）。
- `App.tsx`：`Sidebar width={96}` + `SidebarNav`（受控 `value={s.tab}`，`onSelect`
  回写 `PanelTab`，`NAV_ITEMS` 的 icon 改 ReactNode）；busy 指示移进 `footer` 槽。
- 宽度 68 → 96：复制件的条目是横排（icon + 文字同行，`--dsw-font-s-14`），
  96px 才容得下两字标签；旧手写版的竖排 icon 上文字下的形态是自造观感，弃。
- 收起/展开交互（用户复验后点名要的，初版曾判「面板无收起需求」而否决）：受控
  `navCollapsed` 进 ClientState，`Sidebar collapsed / onCollapsedChange` 接线；
  header 槽放收起钮，`collapsedWidth 48` 下条目自动图标化（label 转 title 悬浮
  提示，SidebarNav 收起态自理）；收起态 busy 只留 spinner（48px 容不下
  「生成中 · Ns」）。按钮图标按用户第二次反馈换**常规侧栏折叠图标**
  `panel-left-outline`（`IconPanelLeftOutlineRegular`，自官方 artwork.ts 提取；
  两态同一枚，状态由 `aria-expanded` 表达，不再用 chevron 翻转）。

## 影响面

- 仅 client 半边；host / wire / 落盘数据零改动。
- 新增 4 个复制件文件（源码归插件，升级走 add --force）；无新 npm 依赖
  （sidebar 族零依赖，react + clsx 已在闭包内）。

## 验收标准

- [x] `pnpm typecheck` / `pnpm test`（194 passed）/ `pnpm build` 全绿
- [x] 实机（内置浏览器连 DSH web 端）：复制件侧栏渲染正确，三视图切换、
      素体 3D 视口、历史载入全部复验通过（2026-11-20）
- [x] 实机：收起/展开交互复验通过（2026-11-20 迭代）：header 收起钮、48px 图标条、
      条目居中、内容区让宽、再展开还原

## 依赖

- 前置：issue 007（侧栏布局落地）。

## 进度日志

- 2026-11-20 08:22  jianan  创建；同轮完成迁移，typecheck / test / build 全绿 + 实机复验通过，直接关闭
- 2026-11-20 08:26  jianan  迭代（用户复验后要求）：补收起/展开交互，受控 navCollapsed + header 槽收起钮 + collapsedWidth 48；实机复验收起/展开通过
- 2026-11-20 08:35  jianan  迭代（用户反馈）：收起钮换常规侧栏折叠图标 panel-left-outline（两态同枚，aria-expanded 表达状态）；DSH 实例中途重启过一轮（地址变 64730），重连后 DOM 级复验收起/展开两态通过

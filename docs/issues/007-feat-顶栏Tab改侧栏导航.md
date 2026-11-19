---
id: 007
type: feat
title: 顶栏 Tab 改侧栏导航（面板布局重构）
status: doing
priority: P2
labels: []
created: 2026-11-20
updated: 2026-11-20
assignee: jianan
related: [001, 003]
---

# 007 · 顶栏 Tab 改侧栏导航

## 背景

面板三视图（生成 / 素体 / 历史）此前靠顶栏 `SegmentedControl`（`idi-bar`）切换，
切换控件与 busy 指示占用内容区一整行高度；顶栏横向排布在右栏面板里也不像
DSH 桌面端其他侧栏工具的导航习惯。林老师要求把顶部的 Tab 改成 sidebar 结构。

## 目标

- 面板改为「左侧栏 + 内容区」两栏布局：三视图入口进左栏竖排导航（图标 + 文字），
  顶栏整行取消，内容区多出整行可用高度。
- 生成中的 busy 指示（spinner + 耗时）保留，移入侧栏底部。
- 视图切换的状态字段不变（`PanelTab` / `s.tab` 语义照旧），历史/对比/灯箱行为不受影响。

## 方案

- client 半边 `src/client/App.tsx`：`ImageDesignPanel` 根节点从纵向改横向，
  新增 `idi-nav`（`nav[aria-label]` + 按钮，`aria-current` 标记当前视图）与
  `idi-content` 两层；`NAV_ITEMS` 常量声明三个导航项。
- 图标：`ui/icons.tsx` 按本仓复制规范自官方 `artwork.ts` 提取 inline path，
  新增 `IconSparkleOutlineRegular`（生成）/ `IconUserOutlineRegular`（素体）/
  `IconClockOutlineRegular`（历史）。
- 样式：`panel-css.ts` 的 `.idi-root` 改 `flex-direction: row`，删 `.idi-bar`，
  新增 `.idi-nav / .idi-nav-item / .idi-nav-spacer / .idi-nav-busy / .idi-content`；
  导航态只消费 `--dsw-alias-interactive-bg-hover/active` 与
  `--dsw-alias-state-business-primary` 语义 token；错误条移入内容区顶部（带边距）。
- 替代方案（否决）：抽屉式 / 图标-only 窄轨：面板宽度本就有限，再省文字会伤可读性。

## 影响面

- 仅 client 半边布局与样式，host / typert face / 落盘数据零改动，无迁移。
- 对比浮层 `.idi-compare` 仍 absolute 覆盖整个根（含侧栏），行为不变。
- 不触碰自守护栏：仍是复制件控件 + idi- 前缀自有类 + 语义 token。

## 验收标准

- [x] `pnpm typecheck` / `pnpm test`（194 passed）/ `pnpm build` 全绿
- [ ] 实机：三视图切换正常、素体视口在窄内容区不塌、busy 指示在侧栏底部走秒

## 依赖

- 无前置；复用 issue 001 的面板骨架与 issue 003/004 的素体视图布局。

## 进度日志

- 2026-11-20 07:44  jianan  创建；同轮完成代码改造，typecheck / test / build 全绿，实机验收待做

---
id: 006
type: chore
title: dsh-ui-cell 复制件全量升级到 0.6.1（rc.1 世代 → 最新，foundation 接线 + menu 拆件族 + skill 换 1.6.1）
status: done
priority: P1
labels: [client, dsh-ui-cell, 升级]
created: 2026-11-20
updated: 2026-11-20
assignee: lin
related: [001, 003]
---

# 006 · dsh-ui-cell 复制件升级到 0.6.1

## 背景

client 面板的 dsh-ui-cell 复制件（button / card / empty / field / image-lightbox /
image-preview / input / label / menu 族 / scroll-area / segmented-control / select /
separator / shortcut-keys / skeleton / slider / spinner / switch / tag / textarea /
toast / tooltip / zoom-controls 及闭包）是 rc.1 世代复制件。上游 dsh-ui-cell 已到
0.6.1：组件源基线 rc.1 → rc.5；**宿主下限 DSH ≥ 0.2.2-rc.2**（tooltip / toast 引用的
token rc.2 才有，低于则配色静默失效）；0.6.0 起组件间距走 `--dsh-space-*` 刻度，
新增 **foundation 基础层**（漏注入 = 间距声明被静默丢弃）；0.6.1 修复发射层 bug
（styles 文本里的 `:global(...)` 外壳剥掉，此前 tooltip 的 macOS no-drag 与 menu 的
键盘输入模态判定会被浏览器整条静默丢弃）。

## 做了什么

1. `npx @dreamariner/dsh-ui-cell@0.6.1 add ... --force` 全量重新复制（67 个文件；
   menu 族新增拆件 menu-row / submenu-panel / use-menu-submenu / menu-submenu-position）
2. `panel-css.ts` 的 `CELL_STYLES` 照 add note 依赖序重排并把 foundation 排第一
   （menu / menu-group / menu-surface / toast / card / scroll-area / skeleton /
   zoom-controls 是闭包带出的未用复制件，0 处引用，维持不接线，与升级前一致）
3. skill 拷贝从 v1.1.0 换成 **1.6.1**（宿主下限、两个版本辨析、注入顺序依赖、
   间距圆角动效取值这些坑位清单都是 1.1.0 之后才有的）

## diff 审查结论

- 变化形态统一：间距字面量 → `--dsh-space-*`、文件头用法块、button 头注记 rc.1 → rc.5
- tooltip / menu：`:global(...)` 剥壳（合法纯 CSS）、static 色 → alias token
- 类名表无变化：手写面板样式与覆盖规则不受影响；无本地手工改动被覆盖

## 验证

- `pnpm build` 全绿（icon 生成 + tsdown host/client + tsc types）
- `npx vitest run`（packages/dsh-image-design）188 用例全过
- 发射 styles 文本零 `:global(`

## 待办

- 实机开图片生成面板看一眼：参数区 / 画廊 / lightbox / 素体设计视图外观与升级前一致
  （间距刻度与 token 层面的变化只能实机看）

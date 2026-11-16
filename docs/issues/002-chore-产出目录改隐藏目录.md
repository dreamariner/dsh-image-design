---
id: 002
type: chore
title: 产出目录改隐藏目录 .image-design 并从工作区仓库忽略
status: done
priority: P2
labels: []
created: 2026-11-15
updated: 2026-11-15
assignee: jianan
related: [001]
---

# 002 · chore · 产出目录改隐藏目录 .image-design 并从工作区仓库忽略

## 背景

issue 001 落地后，生成产出默认落在 `<工作区根>/image-design`（实现见 issue 001 的方案节）。
在 zero 工作区实测时暴露两个问题：

1. **产出会被工作区仓库跟踪**：产出目录是 zero 仓根下的普通目录名，而 zero 仓
   `.gitignore` 没有对应条目，`git check-ignore` 实测未被忽略、`git status` 显示为
   `?? image-design/`。下一次 `git add -A` 会把生成的 jpg（实测两张共 438 KB）
   一并提交进知识库仓库，仓库随生成轮次膨胀。
2. **产出与知识资产同层**：产出目录与知识库目录平级，容易被文档树扫描、
   知识库工具的索引范围或 Obsidian 的目录视图扫进去，过程数据与正式笔记混层。

根因：`defaultOutDir` 的工作区分支用了普通目录名，且默认产出位置落在工作区内部
这一层没有配套的忽略规则。

## 目标

- 工作区默认产出目录改为点开头的隐藏目录 `.image-design`。
- 产出目录不进入 zero 仓的 git 跟踪范围。
- 已有产出不丢失（迁移到新目录）。
- 目录名不被将来悄悄改回（机械护栏钉死）。

## 方案

- `src/out-dir.ts`（新增）：`defaultOutDir` 从 `src/index.ts` 拆出，成为零依赖纯函数。
  **拆分的动机是可测性**：`src/index.ts` 引入 typert 协议包（标准装饰器），
  vitest 的 transform 加载不了，直接 import 会报 `SyntaxError: Invalid or unexpected
  token`。仓库既有做法同构（`buildGenerateArgs` 放 mmx.ts、`normalizeGenerateInput`
  放 generate.ts，都是为了让纯逻辑可单测）。`src/index.ts` 重导出该函数，公开出口不变。
- 目录名：`image-design` → `.image-design`（点开头）。
- `src/config.ts` 注释与 `README.md` 配置表同步新路径与理由。
- `tests/out-dir.spec.ts`（新增）：三条用例钉住行为，其中一条显式断言目录名以
  `/.image-design` 结尾，防回退。
- zero 仓 `.gitignore` 末尾加 `.image-design/`（带注释说明为何不入库）。
- 数据迁移：`image-design/` 整目录 `mv` 到 `.image-design/`（含 run.json 清单）。
- 附带：`pnpm dev:hmr` 把本仓 lib 注册进本机 hmr watch 根，之后改宿主半边代码
  重建即热重载，免重启。

## 影响面

- 宿主半边行为变化：默认产出根目录名改变。显式配置 `outDir` 的部署不受影响。
- 数据迁移：旧目录整目录平移，`run.json` 内容与图片字节不变，runId 不变，历史可继续回看。
- 旧目录名 `image-design/` 已不存在，无兼容期（插件尚未发布，无外部用户）。
- 触碰自守护栏：新增测试文件，测试总数 43 → 46（另 1 skipped 来自协议包自带用例）。

## 验收标准

- [x] 三门禁全绿（build / test 46 passed + 1 skipped / typecheck）
- [x] `tests/out-dir.spec.ts` 3 条用例通过（工作区分支 / 隐藏目录名断言 / 回落分支）
- [x] 产物 `lib/index.js` 内含 `.image-design` 且不含旧目录名
- [x] 旧产出目录迁移到 `.image-design/`，文件清单逐一致（3 个文件：2 jpg + run.json）
- [x] zero 仓 `git check-ignore -v .image-design/.../run.json` 命中 `.gitignore` 的 `.image-design/` 条目
- [x] zero 仓 `git status --porcelain` 中不再出现产出目录条目
- [x] `pnpm dev:hmr` 注册成功（packages/dsh-image-design/lib 进入 hmr watch 根）

## 部署

宿主半边改动需重启实例才装载（DSH 的 hmr watch 根在实例启动时读取，本次注册同样
要重启一次才生效）。重启命令：`pnpm dsh:restart`（脚本会先经 inspector 优雅退出，
再后台拉起，端口与地址不变）。重启后复核两点：`pnpm dsh:probe` 确认插件仍 active；
面板「历史」页应能读到迁移后的那一轮 `20261115-213905-6d55`（说明新路径 `.image-design`
已生效，旧路径 `image-design` 不再被读取）。

## 依赖

- 无前置 issue。承接 issue 001 的产出目录设计。
- 实机生效依赖一次宿主实例重启（`pnpm dsh:restart`）。

## 进度日志

- 2026-11-15  jianan  创建（林老师裁定：产出目录改 `.image-design` 并加入 .gitignore）
- 2026-11-15  jianan  实现完成：defaultOutDir 拆到 out-dir.ts（为可测性）、三处文档同步、
  补 3 条单测、zero 仓 .gitignore 加条目、存量产出整目录迁移、三门禁全绿
- 2026-11-15  jianan  hmr 接线补齐（packages/dsh-image-design/lib 进 watch 根），之后宿主半边
  改动免重启；本次改动本身仍需一次重启装载

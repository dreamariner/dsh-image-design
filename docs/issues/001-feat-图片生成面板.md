---
id: 001
type: feat
title: 图片生成面板（mmx image generate 全能力 + 结果查看对比）
status: done
priority: P1
labels: []
created: 2026-11-15
updated: 2026-11-15
assignee: jianan
related: []
---

# 001 · feat · 图片生成面板（mmx image generate 全能力 + 结果查看对比）

## 背景

zero 知识库的图片工作流（公众号配图、Luna 形象设计迭代）目前靠 mmx CLI 手敲命令，
参数面全靠记忆，结果散落在临时目录里没有归档与对比。需要一个带 UI 的 DSH 插件：
参数在面板上设置，结果可查看与对比，历史可回看。脚手架（create-dsh-plugin）与
组件库（dsh-ui-cell）当时未发最新版到 npm，构建期临时用本地最新版（2026-11-15）。

## 目标

- 面板生成：模型 / 比例 / 面积档 / 精确尺寸 / 像素宽高 / 张数 / seed / 提示词增强 /
  水印 / 主体参考 / 参考图（编辑）全参数可设。
- 结果查看：缩略图 + lightbox 放大 + 实际尺寸 + revised_prompt 展开。
- 对比：勾选 2..4 张并排对比（尺寸、文件、revised_prompt 同屏）。
- 历史：每轮落盘归档，倒序回看，可删除。
- Agent tool 同能力（`dsh-image-design_generate`），与面板共用 handlers。

## 方案

- 形态 full：host 走 mmx CLI 子进程（复用 ~/.mmx 认证与下载链路，不重造 API 客户端），
  client 用 dsh-ui-cell 复制件搭面板（duc- 前缀 + alias token）。
- 契约类型单源在 `src/contract.ts`，经 `src/types.ts` 公开类型子路径发布
  （typert 生成器要求边界类型从非根子路径导出），client 从 `@dreamariner/dsh-image-design/types` 取型。
- 归档模型：一轮 = `<outDir>/<runId>/`（图片 + `run.json` 清单）；清单先写 running 再写终态；
  `readImage` 走清单 allowlist 防路径越界。
- 计费纪律：无自动重试；客户端超时 660s ≥ 服务端 600s；取消只拦「尚未发出」段。
- 关键决策：RPC 返回信封 `{ok,value}` 在 client unwrap（media-platforms 同款）；
  协议包运行时与 media-platforms 一致随包内联（EXTERNALS 声明保留为意图锚）。

## 影响面

- 新插件包，无存量数据迁移。
- 触碰自守护栏：bundle 形态 / client 边界 / typert face 安装态测试全部保留并绿灯。

## 验收标准

- [x] 三门禁全绿（test 44 / typecheck / build）
- [x] argv 构造矩阵测试（双模型参数面、互斥、越界拦截）
- [x] 历史归档与 readImage allowlist 测试（临时目录）
- [x] `--dry-run` 对照真 mmx 1.0.29（image-01 与 H3 两条 argv 路径均被接受）
- [x] 真实端到端冒烟：image-01 512x512 x2（8.7s 出 2 张 jpg，落盘 / 清单 / allowlist 读图全通）
- [x] H3 回告解析实测（sizes / revised_prompts / success_count）
- [ ] 装进 DSH 实例实机验收（pnpm profile:add + 重启实例，待做）

## 依赖

- 外部：本机 mmx CLI（≥ 1.0.29）与 `mmx auth`；npm 发布后脚手架 / cell 库换回 npm 版。

## 进度日志

- 2026-11-15  jianan  创建（需求来自 zero 侧建仓指令，同日实现并完成冒烟）
- 2026-11-15  jianan  实机面板验收移到安装后进行，issue 保持 done（代码面验收全绿）

---
id: 003
type: feat
title: 素体设计参考图（3D 人物素体 → 姿势 → 机位 → 拍摄 → 生成参考图）
status: done
priority: P1
labels: []
created: 2026-11-17
updated: 2026-11-17
assignee: jianan
related: [001]
---

# 003 · 素体设计参考图

## 背景

图片生成模型在**人物体型、动作、相机视角**三个维度难以用文字稳定控制，同一人物多次生成体型 / 姿势 / 机位漂移，一致性差。文字 prompt 无法表达「七分身、1/3 侧、微俯、A-pose、肩宽 1.2」这类结构化约束。

思路：在插件内做**参数化 3D 人物素体**（程序化建模，零外部资产），调好体型 → 套姿势 → 选机位 → 拍出干净参考图 → 一键作为 H3 参考图（refImages 链路 issue 001 已有），让「体型 / 动作 / 视角」三个维度由素体参考图钉死。

## 目标

- 面板三视图：生成 / 素体 / 历史
- 素体可调：身高（130..210cm）、头身比（6..9）、肩宽 / 胸围 / 腰围 / 臀围 / 四肢粗细（0.55..1.5 系数）、臂长 / 腿长（0.85..1.15 系数）
- 姿势库 8 种（T-pose / A-pose / 自然站立 / 叉腰 / 行走 / 奔跑 / 坐姿 / 跪坐）
- 相机：景别（全身 / 七分身 / 半身 / 特写）× 方位（正面 / 1/3 侧 / 正侧 / 背面）× 俯仰（平视 / 微俯 / 微仰）预设，另支持视口拖拽轨道微调
- 拍摄导出干净 PNG（长边 1024/1536/2048 × 1:1/2:3/3:4/9:16），落盘归档
- 参考图一键进生成表单的 H3 refImages（闭环）

## 方案

### 技术决策

- **程序化参数素体**（three.js ^0.170，client 内联），不用外部模型资产 / 不引 glTF 加载：零资产分发、三围直接映射几何、参数即真源
  - 躯干 LatheGeometry 回转体（围度 girth ≈ 2πr），横截面 z 向压成椭圆（前后厚 < 左右宽）
  - 四肢 CapsuleGeometry，关节用 Group 作 pivot，姿势 = 关节欧拉角表
  - 层级：root → [双腿, 躯干下段, spine → 躯干上段, chest → 双臂, neck → head]，弯腰带动上身、腿留在地面
  - 腿长系数调整下肢占比、躯干补偿，总身高恒定
- **入口并入现有面板**（第三视图），不开新 tab：同一业务域，共用 error / api / 注入器
- **拍摄 = 离屏同上下文成像**：临时把 renderer 换到目标尺寸渲一帧（WYSIWYG），浅灰背景 + 三点柔光 + 地面接触阴影（干净参考图语义）
- **存档照抄 runs 归档模式**：`<outDir>/refs/<refId>/`（ref_001.png + ref.json）；ref.json 钉死体型 / 关节表 / 相机（防姿势库演进导致旧档不可复现）；读图走清单 allowlist 防越界；dataUrl 严格校验（png 前缀 + base64 合法 + ≈8MB 上限）
- **wire 契约类型单源**：RefShotInput / RefShotRecord / RefSummary / BodyParamsSnapshot / CameraSnapshot 进 contract.ts（typert 生成器要求 Remote 边界类型从公开类型子路径导出）

### 涉及模块

- host 半边：`src/mannequin-handlers.ts`（saveRefShot / listRefs / readRefImage / readRefRecord / deleteRef）+ `src/remote.ts` 5 个 @Remote 方法 + `src/contract.ts` 契约类型
- client 半边：`src/client/mannequin/`（body.ts 体型→几何、poses.ts 姿势库、camera.ts 机位预设、capture.ts 影棚与导出、viewer.ts 场景装配与轨道交互）+ `MannequinView.tsx` + App 三视图接线 + state.ts man 切片 + api.ts（契约别名）+ panel-css.ts
- 组件：dsh-ui-cell 复制 slider
- 测试：tests/mannequin.spec.ts（存档 10 例）、tests/mannequin-math.spec.ts（纯函数 16 例）

### 闭环接线

拍摄响应带 absPath（落盘绝对路径），client 缓存进 `man.refAbsPaths`；「用作参考图」把 absPath 追加进 `form.refImages`（H3）并切回生成视图。历史档只有相对文件名，跨会话复用待后续（如需可经 readRefRecord + outDir 拼接）。

## 影响面

- 新增 refs/ 存档目录（与 runs/ 并列），删除 / 读图互不影响
- client.js 体积 784KB → 1.63MB（three 内联；MPC 先例 2.09MB 生产可跑）
- 不触碰 bundle 形态护栏（client 边界测试仍绿）；typert 产物新增 5 端点

## 验收标准

- [x] 三门禁全绿（test 75 过 / typecheck 干净 / build 完成，client.js 1.63MB）
- [x] 实机：profile:add + 重启实例后素体视图可用（WebGL2 探针通过，canvas 623×300）
- [x] 实机：滑杆调形（肩宽 1.35 / 胸围 1.25 / 腰围 0.8）→ 奔跑姿势 → 1/3 侧机位 → 拍摄 → 参考图列表出现缩略图（shot-20261117-010449-e140，ref.json 参数钉死核对无误）
- [x] 实机：「用作参考图」→ 生成表单 H3 refImages 出现 absPath → 真实生成一张（12.3s 完成，2048×2048，奔跑动作 / 1/3 侧机位 / 体型比例均跟随参考图，浅灰背景无文字）

## 依赖

- 无前置阻塞；mmx H3 参考图链路（issue 001）已就绪

## 进度日志

- 2026-11-17  jianan  创建；方案经 ExitPlanMode 评审（程序化参数素体 + 并入现有面板）
- 2026-11-17  jianan  代码落地：host 存档 5 端点 + client 全部模块 + 三门禁全绿（75 测试 / typecheck 干净 / client.js 1.63MB）；实机验收进行中
- 2026-11-17  jianan  实机验收全绿，issue 关闭。已知小瑕疵：躯干上下段 lathe 接缝在侧面光下有一条浅色缝线（cosmetic，参考图语义无碍）；跨会话复用历史参考图（历史档无 absPath）留待后续需求

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

思路：在插件内做一个**可调的 3D 人物素体**，调好体型 → 套姿势 → 选机位 → 拍出干净参考图 → 一键作为 H3 参考图（refImages 链路 issue 001 已有），让「体型 / 动作 / 视角」三个维度由素体参考图钉死。

**模型来源的两次修正**（林老师两次反馈）：

1. 第一版是**程序化建模**（three.js 几何体拼装，零外部资产）。反馈：「这个人物模型太糟糕了，完全没有人样」（附专业人偶素体美术基准图）。
2. 二轮重修按基准图做了解剖块面改造（颅体+面颌、胸体/臀体/腓肠肌、连指手、足趾楔等）。反馈升级为决定性的一条：「还是不行啊，这根本就不是个人样，**这种模型生成的参考图对解决图片生成模型的问题没有意义。人物模型要仿真**」。
3. 结论：程序化几何这条路到不了「仿真」。改为**真实蒙皮人偶**（Mixamo X Bot，GLB 内联），程序化几何只保留「参数 → 骨骼缩放」的映射能力，体型仍然可调，姿势由骨架驱动。

## 目标

- 面板三视图：生成 / 素体 / 历史
- 素体可调：身高（130..210cm）、头身比（6..9）、肩宽 / 胸围 / 腰围 / 臀围 / 四肢粗细（0.55..1.5 系数）、臂长 / 腿长（0.85..1.15 系数）
- 姿势库 8 种（T-pose / A-pose / 自然站立 / 叉腰 / 行走 / 奔跑 / 坐姿 / 跪坐）
- 相机：景别（全身 / 七分身 / 半身 / 特写）× 方位（正面 / 1/3 侧 / 正侧 / 背面）× 俯仰（平视 / 微俯 / 微仰）预设，另支持视口拖拽轨道微调
- 拍摄导出干净 PNG（长边 1024/1536/2048 × 1:1/2:3/3:4/9:16），落盘归档
- 参考图一键进生成表单的 H3 refImages（闭环）

## 方案

### 技术决策

- **模型：真实蒙皮人偶**（Mixamo X Bot，three.js examples 分发），程序化几何作废
  - 资产流水线：`assets/xbot.glb` ← Mixamo 量化 GLB 经 `scripts/fix-quantized-glb.mjs` 反量化
    （解码顶点为 float32、去掉 `KHR_mesh_quantization`、几何清理）→ `scripts/generate-mannequin-glb.mjs`
    内联成 base64（`src/client/generated/mannequin-glb.ts`，构建期自动跑）
  - **反量化是必需项**：three 的 GLTFLoader 只按 `v / 32767` 解读量化属性、丢掉 accessor 的
    min/max，几何会被压成单位立方体。gltf-transform 的 `optimize()` 会重新量化，反量化之后禁用
  - **装配红线**：Mixamo 的网格几何是米级、骨架是厘米级，靠 Armature 节点的 0.01 与 skin 的
    inverseBindMatrices（厘米空间）配对，蒙皮时自动抵消。不改节点层级、不补 scale、不解挂网格
- **骨架驱动姿势**（`src/client/mannequin/rig.ts`）：16 关节 ↔ mixamorig 骨名映射；落臂补偿按模型
  实测的 rest 臂轴（子骨世界位置差）动态算，转到竖直向下 + 轻微外张；姿势按世界系级联合成
  （新本地旋转 = 姿势欧拉 ∘ 落臂补偿 ∘ rest 本地旋转，用 rest **本地**旋转才能让子骨跟随父骨）
- **体型参数作用在骨骼上**（`src/client/mannequin/body.ts` 只留参数面 + 骨缩放映射）：头身比 → 头骨
  缩放；三围 → Spine/Spine2/Hips 的 x/z 缩放；肩宽 → 锁骨位移；四肢粗细 → 四肢骨 x/z；臂长腿长 → 骨轴 y
- **入口并入现有面板**（第三视图），不开新 tab：同一业务域，共用 error / api / 注入器
- **拍摄 = 离屏同上下文成像**：临时把 renderer 换到目标尺寸渲一帧（WYSIWYG），浅灰背景 + 三点柔光 + 地面接触阴影（干净参考图语义）
- **存档照抄 runs 归档模式**：`<outDir>/refs/<refId>/`（ref_001.png + ref.json）；ref.json 钉死体型 / 关节表 / 相机（防姿势库演进导致旧档不可复现）；读图走清单 allowlist 防越界；dataUrl 严格校验（png 前缀 + base64 合法 + ≈8MB 上限）
- **wire 契约类型单源**：RefShotInput / RefShotRecord / RefSummary / BodyParamsSnapshot / CameraSnapshot 进 contract.ts（typert 生成器要求 Remote 边界类型从公开类型子路径导出）

### 实测得到的事实（改姿势或资产前当基准）

- 模型前方 = **+z**（脚尖方向 `LeftToeBase − LeftFoot = [0, −0.859, 0.512]`）→ 正面机位在 +z，影棚主光与补光在 +z 侧
- Mixamo 角色左在世界系的方向随模型朝向而变：姿势表 z 分量语义是「向外展开」（左 + / 右 −），按左肩世界 X 位置统一乘 `zSign`（手性判错会让右臂收进躯干）
- glTF 节点默认 `matrixAutoUpdate = false`：改骨骼 quaternion / scale 前必须改回 true 并 `updateMatrix()`，否则蒙皮纹丝不动
- JOINTS_0（骨骼索引）必须保持整型，不能按位置量纲反量化（否则 skeleton 索引越界、蒙皮抛错）

### 涉及模块

- host 半边：`src/mannequin-handlers.ts`（saveRefShot / listRefs / readRefImage / readRefRecord / deleteRef）+ `src/remote.ts` 5 个 @Remote 方法 + `src/contract.ts` 契约类型
- client 半边：`src/client/mannequin/`（body.ts 体型参数与骨缩放映射、rig.ts 骨架层、poses.ts 姿势库、camera.ts 机位预设、capture.ts 影棚与导出、viewer.ts GLB 加载与轨道交互）+ `MannequinView.tsx` + App 三视图接线 + state.ts man 切片 + api.ts（契约别名）+ panel-css.ts
- 资产与工具：`assets/xbot.glb`、`scripts/generate-mannequin-glb.mjs`、`scripts/fix-quantized-glb.mjs`、开发期探针 `scripts/glb-skeleton.mjs` / `scripts/glb-bone-axes.mjs` / `scripts/rig-repro.mjs`
- 组件：dsh-ui-cell 复制 slider
- 测试：tests/mannequin.spec.ts（存档 11 例）、tests/mannequin-math.spec.ts（纯函数 19 例）

### 闭环接线

拍摄响应带 absPath（落盘绝对路径），client 缓存进 `man.refAbsPaths`；`listRefs` 也带 absPath（历史参考图跨会话可直接复用，不必重拍）；「用作参考图」把 absPath 追加进 `form.refImages`（H3）并切回生成视图。

## 影响面

- 新增 refs/ 存档目录（与 runs/ 并列），删除 / 读图互不影响
- client.js 体积 784KB → 5.28MB（three 内联 + 素体 GLB base64 内联 3.5MB；MPC 先例 2.09MB 生产可跑）
- 不触碰 bundle 形态护栏（client 边界测试仍绿）；typert 产物新增 5 端点

## 验收标准

- [x] 三门禁全绿（test 78 过 / typecheck 干净 / build 完成，client.js 5.28MB）
- [x] 实机：profile:add + 重启实例后素体视图可用（WebGL2 探针通过，canvas 623×300）
- [x] 实机（程序化版）：滑杆调形 → 奔跑姿势 → 1/3 侧机位 → 拍摄 → 参考图列表出现缩略图，ref.json 参数钉死核对无误
- [x] 实机（程序化版）：「用作参考图」→ 生成表单 H3 refImages 出现 absPath → 真实生成一张（12.3s 完成，2048×2048）
- [x] 实机（蒙皮人偶版）：素体视图渲染出真实人偶（陶土色、A-pose 双臂自然垂放，实测上臂轴 ∓0.572/−0.82、前臂轴 ∓0.635/−0.771）
- [x] 实机（蒙皮人偶版）：体型滑杆有效（肩宽 ×1.30 / 胸围 ×1.25 / 腰围 ×0.90 / 身高 185cm 可见比例变化）
- [x] 实机（蒙皮人偶版）：奔跑姿势抬膝朝前（+z，与模型前方一致），1/3 侧机位拍摄出干净 2:3 影棚 PNG
- [x] 实机（蒙皮人偶版）：「用作参考图」→ H3 生成真实完成（14.4s，2048×2048，出图体型 / 动作 / 机位 / 浅灰背景均跟随参考图）
- [x] 历史参考图跨会话可用（`listRefs` 带 absPath）

## 依赖

- 无前置阻塞；mmx H3 参考图链路（issue 001）已就绪

## 进度日志

- 2026-11-17  jianan  创建；方案经 ExitPlanMode 评审（程序化参数素体 + 并入现有面板）
- 2026-11-17  jianan  代码落地：host 存档 5 端点 + client 全部模块 + 三门禁全绿（75 测试 / typecheck 干净 / client.js 1.63MB）；实机验收进行中
- 2026-11-17  jianan  实机验收全绿，issue 关闭。已知小瑕疵：躯干上下段 lathe 接缝在侧面光下有一条浅色缝线（cosmetic，参考图语义无碍）；跨会话复用历史参考图（历史档无 absPath）留待后续需求
- 2026-11-17  jianan  素体建模二轮重修（林老师反馈「没有人样」，对标人偶素体美术基准）：修肩关节挂点错位（shoulder 挂 chest 下误用相对 waist 的偏移，整臂抬高 0.18m 悬空）、修斜方肌 blob 传参错（缩放系数误传绝对长度）；重做造型层：颅体+面颌两体块头、锥度四肢（关节端球窝）、三围椭圆周长补偿、胸体/臀体/腓肠肌/前臂肌体块、连指手（掌+四指+拇指）、扁胶囊脚+足趾楔、解剖比例（垂臂腕到裆位、膝在腿段 46%）；新增几何探针 scripts/mannequin-probe.mjs（Node 跑 buildBody dump 世界包围盒定量验衔接）；斜方肌独立体块经验证穿模成「围巾」后移除，肩颈坡由躯干轮廓样条承担。出图复验：A-pose 正面与奔跑正侧均达素体基准
- 2026-11-17  jianan  第三轮：**换模型**（林老师反馈「根本就不是个人样，这种模型生成的参考图对解决图片生成模型的问题没有意义，人物模型要仿真」）。程序化几何整条路作废，改用 Mixamo X Bot 蒙皮人偶（GLB 内联）。过程中排掉的坑：① 量化属性 three 只按 v/32767 解读、几何塌成单位立方体（须反量化，且反量化后禁用 gltf-transform 的 optimize）② JOINTS_0 被误反量化成浮点、骨骼索引越界抛错 ③ 装配时给网格补 scale / 解挂网格破坏 Mixamo 的米级几何与厘米级骨架配对（躯干塌陷）④ three 的 GLTFLoader 把节点 matrixAutoUpdate 设 false，改骨骼前必须改回 ⑤ 手臂不动：骨轴取本地 +X/+Y 不靠谱，改用子骨世界位置差 ⑥ 落臂时前臂留在水平：姿势要按 rest 本地旋转级联，不能按 rest 世界旋转 ⑦ 右臂收进躯干：手性按左肩世界 X 位置统一 ⑧ 模型背朝镜头：实测脚尖方向确认前方为 +z，正面机位与主光一起搬到 +z 侧。新增 rig.ts（关节↔骨名映射、落臂补偿、世界系级联合成）与 body.ts 骨缩放映射，程序化几何代码删除。实机复验全绿，闭环成立
- 2026-11-17  jianan  收尾：`listRefs` 增带 absPath（历史参考图跨会话可复用）；删未用资产与过期探针（soldier.glb / mannequin-probe.mjs）；调试出口 `window.__mannequinDebug` 改为卸载时自动清；文档补齐（README 资产与骨架说明、AGENTS 素体纪律段、wiki 时间线）；client.js 5.28MB

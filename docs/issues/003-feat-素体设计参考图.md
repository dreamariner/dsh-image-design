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

**模型来源的三次修正**（林老师三次反馈）：

1. 第一版是**程序化建模**（three.js 几何体拼装，零外部资产）。反馈：「这个人物模型太糟糕了，完全没有人样」（附专业人偶素体美术基准图）。
2. 二轮重修按基准图做了解剖块面改造（颅体+面颌、胸体/臀体/腓肠肌、连指手、足趾楔等）。反馈升级为决定性的一条：「还是不行啊，这根本就不是个人样，**这种模型生成的参考图对解决图片生成模型的问题没有意义。人物模型要仿真**」。
3. 结论：程序化几何这条路到不了「仿真」。先换成 **Mixamo X Bot**（真实蒙皮人偶，机械分段风格）。
4. 第三次反馈（2026-11-17 下午）：「体型参数调节与实际效果不符合，并且我要的模型是这样**线条连贯
   的高保真人素体模型**，不是你这个像**竹节机器人**一样的模型」。Mixamo 全家都是机械分段风格
   （X Bot / Y Bot / Soldier 都一样），换骨架不解决风格问题；且体型滑杆只缩放骨骼，躯干跨骨蒙皮
   把围度变化稀释掉了，滑杆几乎看不出效果。

## 目标

- 面板三视图：生成 / 素体 / 历史
- 素体可调：身高（130..210cm）、头身比（6..9）、肩宽 / 胸围 / 腰围 / 臀围 / 四肢粗细（0.55..1.5 系数）、臂长 / 腿长（0.85..1.15 系数）
- 姿势库 8 种（T-pose / A-pose / 自然站立 / 叉腰 / 行走 / 奔跑 / 坐姿 / 跪坐）
- 相机：景别（全身 / 七分身 / 半身 / 特写）× 方位（正面 / 1/3 侧 / 正侧 / 背面）× 俯仰（平视 / 微俯 / 微仰）预设，另支持视口拖拽轨道微调
- 拍摄导出干净 PNG（长边 1024/1536/2048 × 1:1/2:3/3:4/9:16），落盘归档
- 参考图一键进生成表单的 H3 refImages（闭环）

## 方案

### 技术决策（第四轮修订后）

- **模型：MakeHuman 基础网格（CC0）+ 自建骨架**（替代 Mixamo X Bot，理由：用户要「线条连贯的
  高保真人素体」，Mixamo 全家都是机械分段风格）
  - 资产流水线三段：`fetch-makehuman-base.mjs`（钉 commit 拉源网格）→
    `build-mannequin-body.mjs`（取 body 组的面 + 用 joint-* 辅助球摆 28 根骨 + 距离权重蒙皮）→
    `generate-mannequin-glb.mjs`（base64 内联，构建期跑）
  - **顶点属性不许交错**：gltf-transform 默认 interleaved 把 JOINTS_0（UNSIGNED_SHORT）与
    POSITION/NORMAL/WEIGHTS_0（FLOAT）混进同一 bufferView（glTF 不允许），three.js 读出蒙皮
    索引全是顶点坐标 → 模型散架；构建用 `VertexLayout.SEPARATE`，有测试守着
- **体型参数落到网格**（第四轮重做，`src/client/mannequin/shape.ts`）：体型一律改**顶点 / 骨链**，
  不缩放骨骼（躯干跨骨平滑蒙皮，缩骨围度几乎看不出来）
  - **围度类（胸 / 腰 / 臀 / 肩宽）走沿身体轴的 1D 剖面**：控制点（骨盆 0.90 / 胯腰 0.98 /
    腰 1.05 / 肋 1.13 / 胸 1.21 / 肩 1.31）+ **PCHIP 单调三次插值**；每个滑杆只管自己的控制点，
    胸动不了腰（第三轮的高度带区域场会互串：胸围 0.6→1.6 腰宽跟着 0.341→0.387）
  - **区域限定用蒙皮权重软遮罩，且按顶点最大骨权重归一**：蒙皮权重很软（没有顶点在单骨上超过
    0.9，头骨顶点普遍 0.3~0.5），直接用权重和当遮罩会把力度打掉一半；「主导骨硬判定」则在边界
    留硬边（臀围调大在髋部甩出裙状法兰）
  - **四肢粗细整条链一次径向放大**：分骨做的话两段肢体在关节处各套一次，膝/肘叠出「护膝」；
    链用 Catmull-Rom 细分 + 逐点切向，关节处连续
  - **横向场半径卡在肢体截面与躯干之间**：太大时场边舔到躯干，顺带把胸围腰围带偏
  - **肩宽走上臂骨的横向偏移**（锁骨↔上臂，绑定实测 0.1411 m），不是缩锁骨（缩锁骨只会把躯干
    横向拉裂，手臂不动）
  - 胸廓另加**双峰隆起**（底网格是中性体型，纯缩胸腔只是变厚）
- **骨架驱动姿势**（`src/client/mannequin/rig.ts`）：16 关节 ↔ mixamorig 骨名映射；绑定姿态即 A-pose，
  **不需要落臂补偿**；姿势按世界系级联合成（局部旋转为单位阵 → 骨的朝向就是世界朝向）
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
- 资产与工具：`assets/makehuman-base.obj`（源网格）、`assets/mannequin-body.glb`（构建产物）、
  `scripts/fetch-makehuman-base.mjs`、`scripts/build-mannequin-body.mjs`、
  `scripts/generate-mannequin-glb.mjs`、`scripts/preview-body.mjs`
- 测试：tests/mannequin.spec.ts（存档 11 例）、tests/mannequin-math.spec.ts（纯函数 24 例）、
  tests/mannequin-asset.spec.ts（资产结构守卫 5 例）

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
- [x] 实机（第三轮）：真实人偶渲染（陶土色、连续线条、有五官与脚趾）；体型滑杆**可见生效**
  （胸围 ×1.5 胸深 +21%、腰围 ×0.7 腰宽 −11%、臀围 ×1.4 臀宽 +10%、身高 185cm 整体缩放正确）
- [x] 实机（第三轮）：8 个姿势在实机与离线预览里逐个核对（奔跑手臂重调后为标准跑姿）
- [x] 实机（第三轮）：拍摄出干净影棚 PNG（2:3），参考图列表与「用作参考图」链路通
- [x] 逐滑杆离线验收（第四轮）：`scripts/check-shape.mjs` 出最小/默认/最大对照图 + 量测，
  每个滑杆只动该动的围度（胸围 0.16→0.42 胸宽且腰宽不动；腰围 0.21→0.44 且胸宽不动；
  臀围 0.27→0.43；肩宽 0.56→0.70；头身比头宽 0.22→0.16），无硬边 / 无法兰 / 无护膝
- [x] 实机（第四轮）：素体视图渲染正常，逐滑杆调形（胸/腰/臀/肩宽/四肢/头身比）形态自然无畸变；
  8 姿势逐个切换正常；拍摄出图并进参考图列表（**全程未调用 H3 图片生成**）

## 依赖

- 无前置阻塞；mmx H3 参考图链路（issue 001）已就绪

## 进度日志

- 2026-11-17  jianan  创建；方案经 ExitPlanMode 评审（程序化参数素体 + 并入现有面板）
- 2026-11-17  jianan  代码落地：host 存档 5 端点 + client 全部模块 + 三门禁全绿（75 测试 / typecheck 干净 / client.js 1.63MB）；实机验收进行中
- 2026-11-17  jianan  实机验收全绿，issue 关闭。已知小瑕疵：躯干上下段 lathe 接缝在侧面光下有一条浅色缝线（cosmetic，参考图语义无碍）；跨会话复用历史参考图（历史档无 absPath）留待后续需求
- 2026-11-17  jianan  素体建模二轮重修（林老师反馈「没有人样」，对标人偶素体美术基准）：修肩关节挂点错位（shoulder 挂 chest 下误用相对 waist 的偏移，整臂抬高 0.18m 悬空）、修斜方肌 blob 传参错（缩放系数误传绝对长度）；重做造型层：颅体+面颌两体块头、锥度四肢（关节端球窝）、三围椭圆周长补偿、胸体/臀体/腓肠肌/前臂肌体块、连指手（掌+四指+拇指）、扁胶囊脚+足趾楔、解剖比例（垂臂腕到裆位、膝在腿段 46%）；新增几何探针 scripts/mannequin-probe.mjs（Node 跑 buildBody dump 世界包围盒定量验衔接）；斜方肌独立体块经验证穿模成「围巾」后移除，肩颈坡由躯干轮廓样条承担。出图复验：A-pose 正面与奔跑正侧均达素体基准
- 2026-11-17  jianan  第三轮：**换模型**（林老师反馈「根本就不是个人样，这种模型生成的参考图对解决图片生成模型的问题没有意义，人物模型要仿真」）。程序化几何整条路作废，改用 Mixamo X Bot 蒙皮人偶（GLB 内联）。过程中排掉的坑：① 量化属性 three 只按 v/32767 解读、几何塌成单位立方体（须反量化，且反量化后禁用 gltf-transform 的 optimize）② JOINTS_0 被误反量化成浮点、骨骼索引越界抛错 ③ 装配时给网格补 scale / 解挂网格破坏 Mixamo 的米级几何与厘米级骨架配对（躯干塌陷）④ three 的 GLTFLoader 把节点 matrixAutoUpdate 设 false，改骨骼前必须改回 ⑤ 手臂不动：骨轴取本地 +X/+Y 不靠谱，改用子骨世界位置差 ⑥ 落臂时前臂留在水平：姿势要按 rest 本地旋转级联，不能按 rest 世界旋转 ⑦ 右臂收进躯干：手性按左肩世界 X 位置统一 ⑧ 模型背朝镜头：实测脚尖方向确认前方为 +z，正面机位与主光一起搬到 +z 侧。新增 rig.ts（关节↔骨名映射、落臂补偿、世界系级联合成）与 body.ts 骨缩放映射，程序化几何代码删除。实机复验全绿，闭环成立
- 2026-11-17  jianan  收尾：`listRefs` 增带 absPath（历史参考图跨会话可复用）；删未用资产与过期探针（soldier.glb / mannequin-probe.mjs）；调试出口 `window.__mannequinDebug` 改为卸载时自动清；文档补齐（README 资产与骨架说明、AGENTS 素体纪律段、wiki 时间线）；client.js 5.28MB
- 2026-11-17  jianan  第五轮（林老师第四次反馈：「很多滑竿的调节效果怪异，人体变形，检查每个滑竿的实际控制效果」）：体型形变整条重写。根因三条：① 躯干「高度带区域场」相邻带重叠会互串（胸围一动腰围跟着动）；② 「主导骨硬判定」做区域限定会在边界留硬边（臀围调大在髋部甩出一圈裙状法兰）；③ 蒙皮权重很软，直接拿权重和当遮罩把每档力度都打掉一半（头身比只生效 40%）。改法：躯干围度改成**沿身体轴的 1D 剖面**（控制点 + PCHIP 单调插值，每个滑杆只管自己的控制点）；区域限定改成**蒙皮权重软遮罩并按顶点最大骨权重归一**；四肢粗细改成**整条肢体链一次径向放大**（Catmull-Rom 细分 + 逐点切向，膝肘不再叠出护膝护肘）；肩宽改走上臂骨横向偏移；胸廓双峰半径放大并改余弦剖面。新增 `scripts/check-shape.mjs`（逐滑杆出最小/默认/最大对照图 + 量测，`ZONE=torso|hip|chest|leg` 限定取景带）。身高归一从「骨的世界矩阵」改成「网格实测」（原来会随姿势忽大忽小）。三门禁全绿（93 测试），实机复验：滑杆形态自然、8 姿势正常、拍摄进参考图列表（未调用 H3）
- 2026-11-17  jianan  第四轮（林老师第三次反馈：「体型参数调节与实际效果不符合，并且我要的模型是这样线条连贯的高保真人素体模型，不是像竹节机器人一样的模型」）：模型再换源 —— Mixamo X Bot（机械分段风格）→ **MakeHuman 基础网格（CC0）+ 自建 28 骨骨架 + 蒙皮权重**；资产三段流水线（fetch 钉 commit → build 摆骨算权重 → base64 内联）；体型参数从「骨骼缩放」改成**区域场网格形变**（围度）+ 垂直骨轴放大（四肢粗细）+ 骨链位移缩放（臂长腿长），区域之间加权平均不互相抵消；姿势表按新骨架重写（世界系欧拉、绑定姿态即 A-pose、不再需要落臂补偿），新增离线预览器 `scripts/preview-body.mjs`（蒙皮 + 软件光栅 + 关节点坐标）逐个校对 8 姿势。踩坑记录：gltf-transform 默认 interleaved 把 JOINTS_0（UNSIGNED_SHORT）与 FLOAT 属性混进同一 bufferView，three.js 读出蒙皮索引全是顶点坐标（模型散架）→ 改 `VertexLayout.SEPARATE` 并加资产结构测试；gltf-transform v4 的 `skin.setJoints()` 不存在（用 `addJoint`）；Node 的 `node.getParent()` 不存在（用 `getParentNode()`）；预览器里子骨世界位置误用自身四元数（应取父骨）导致姿势全歪。实机复验：真实人偶渲染、体型滑杆可见生效（胸深 +21% / 腰宽 −11% / 臀宽 +10% / 身高缩放正确）、8 姿势逐个核对、拍摄出干净影棚 PNG

# AGENTS.md · dsh-image-design

> Agent 进仓先读本文：项目定位、目录结构、形态不变量、门禁与红线。人向的安装与使用说明在 [README.md](README.md)。

## 项目定位

@dreamariner/dsh-image-design：**图片设计**，用 MiniMax 图片模型（image-01 / MiniMax-H3-Image）生成图片的 DSH 插件，能力对齐 mmx CLI 的 `image generate`；另带**素体设计**（three.js 蒙皮人偶，调体型 / 姿势 / 机位拍参考图，一键进 H3 参考图闭环）。host 半边经 mmx 子进程生成并落盘归档；client 半边提供参数设置、结果画廊与对比、历史回看。由 create-dsh-plugin 生成，形态：**host + client 双端**。

## 文档机制

- 需求与迭代跟踪：[docs/issues/AGENTS.md](docs/issues/AGENTS.md)（唯一索引 / 状态真相源，新 issue 走其工作流）
- 系统现状：[docs/wiki/00-变更日志.md](docs/wiki/00-变更日志.md)（结构变化在此留时间线）

## 目录结构

```
├── packages/dsh-image-design/     # 插件包（src / tests / locale / assets / icon.svg / cordis.patch.yml）
├── packages/protocol/          # typert 协议声明源 submodule（pinned vendor，勿改内容）
├── scripts/                    # 项目共用：profile-add / dev-hmr / sync-pack-docs / lib/manifest-deps
│                               # （full 另有 ensure-protocol）
├── lib/                        # 各包构建产物（packages/*/lib/，不入库）
├── tsconfig.host.json          # host 面聚合 tsconfig（registration + paths 重定向）
└── package.json                # 根壳 manifest（private；pnpm -r 转发构建）
```

## 形态速记

- workspace 布局：根壳承载测试与类型检查，插件包在 `packages/dsh-image-design/`；`add` 子命令可继续追加插件，无需迁移结构。
- 双端：host 半边 `src/index.ts`（tool + Config + deps 三件套）承接数据与计算；client 半边 `src/client/index.tsx` 承接界面。
- typert face：client → host 的类型化 RPC，方法只声明在 `src/remote.ts`，构建期生成 `lib/typert.host.*`（宿主装配 wire codec）与 `lib/typert.remote-client.*`（client 侧类型化契约）。
- 协议声明源：`packages/protocol` submodule（pinned vendor，勿在本仓改它的内容）。

## 业务速览（改代码前先懂这三条链路）

1. **生成链路**（host）：`src/client`（表单）→ wire `generate` → `src/remote-handlers.ts` →
   `src/generate.ts` 的 `executeGeneration`：建 `<outDir>/<runId>/` → 写 running 清单 →
   `src/mmx.ts` 构造 argv 并 spawn `mmx image generate`（`--output json --quiet --non-interactive`）→
   解析回告（`saved` 是权威文件清单，H3 另有 sizes / revised_prompts / usage）→ 写终态清单。
   Agent tool `dsh-image-design_generate` 与 Remote 共用同一套 handlers（防漂移）。
2. **读图链路**（client 展示）：face `readImage(runId, file)` 只认该轮 `run.json`
   `images[].file` allowlist（防路径越界）→ base64 → client 转 blob URL（`urls` 缓存）。
3. **历史链路**：`listRuns` 只认有 `run.json` 的目录；删除 = 移除整个运行目录。
4. **素体参考图链路**（issue 003）：client `mannequin/`（body.ts 体型参数面 + 形变指令；
   shape.ts 绑定姿态网格形变；rig.ts 16 关节↔骨映射 + 世界系级联姿势合成；poses.ts 8 姿势 =
   关节欧拉角表；camera.ts 景别×方位×俯仰预设；capture.ts 影棚 + 离屏导出；viewer.ts GLB 加载
   + 骨架绑定 + 形变 + 轨道交互）→ wire `saveRefShot`（dataUrl 严格校验）→ `src/mannequin-handlers.ts`
   落盘 `<outDir>/refs/<refId>/`（ref_001.png + ref.json 钉死体型/关节表/相机）；读图
   `readRefImage` 只认该参考图清单 allowlist。`listRefs` 带 absPath（历史参考图跨会话可复用），
   「用作参考图」把 absPath 追加进生成表单的 H3 refImages 并切回生成视图。

## 素体资产与骨架纪律（改素体前先读）

- **模型是真人比例的蒙皮人偶**：MakeHuman 基础网格（CC0，`assets/makehuman-base.obj`，按钉死
  commit 拉取）+ 本仓自建 28 骨骨架 + 蒙皮权重 → `assets/mannequin-body.glb` → 构建期内联成
  base64（`src/client/generated/mannequin-glb.ts`）。三条脚本：
  `fetch-makehuman-base.mjs` → `build-mannequin-body.mjs` → `generate-mannequin-glb.mjs`。
- **顶点属性不许交错**（2026-11-17 实机事故）：gltf-transform 默认 interleaved 会把 JOINTS_0
  （UNSIGNED_SHORT）与 POSITION / NORMAL / WEIGHTS_0（FLOAT）混进同一 bufferView，glTF 不允许，
  three.js 读出来蒙皮索引全是顶点坐标 → 模型散架。构建脚本用 `VertexLayout.SEPARATE`，
  `tests/mannequin-asset.spec.ts` 守着。
- **体型参数必须落到网格上**：躯干是跨骨平滑蒙皮的，缩放脊柱骨围度几乎看不出来（「滑杆形同
  虚设」的根因）。围度类改**顶点**，四肢粗细改顶点，臂长腿长改骨链局部位移。改体型逻辑先读
  `src/client/mannequin/shape.ts`。
- **躯干围度走 1D 剖面，不走「高度带区域场」**（2026-11-17 实测）：相邻高度带必然重叠，
  各自加权平均也会互串（胸围 0.6→1.6，腰宽跟着 0.341→0.387）。剖面 = 一串控制点
  （骨盆 / 胯腰 / 腰 / 肋 / 胸 / 肩），点间**单调三次插值（PCHIP）**，每个滑杆只管自己的
  控制点，腰动不了胸。
- **区域限定用蒙皮权重软遮罩，且遮罩要按顶点最大骨权重归一化**：人偶的蒙皮权重很软
  （实测：没有任何顶点在单骨上权重超过 0.9，头骨顶点普遍只有 0.3~0.5），直接拿权重和当遮罩
  会把每档力度都打掉一半（头身比只生效 40%）。用「主导骨硬判定」则会在边界留硬边
  （臀围调大在髋部甩出一圈裙状法兰）。
- **四肢粗细整条链一次变换**（2026-11-17 实测）：分骨做的话两段肢体的径向变换在关节处各套
  一次，膝盖上套出个「护膝」。一条链（Catmull-Rom 细分 + 逐点切向）只做一次变换。
- **肢体横向场半径要卡在「肢体截面」和「躯干」之间**：太大时场的边缘会舔到躯干，顺带把胸围
  腰围带偏（实测四肢粗细会改腰围）。
- **肩宽走上臂骨的横向偏移**（锁骨 ↔ 上臂之间，绑定姿态实测 0.1411 m），不是缩放锁骨：
  缩锁骨只会让躯干横向裂开，手臂不动。
- **骨架语义**：28 根骨，局部旋转全是单位阵 → 骨的朝向就是世界朝向，姿势欧拉按世界轴书写；
  绑定姿态就是 A-pose，**不需要落臂补偿**。角色左 = +x，面朝 +z（与旧 Mixamo 资产同约定）。
- **glTF 节点默认 `matrixAutoUpdate = false`**：改骨骼的 quaternion / scale 前必须改回 true
  并 `updateMatrix()`，否则蒙皮纹丝不动。
- **改姿势或体型要定量验证**：`scripts/preview-body.mjs` 在 Node 里读 GLB 做蒙皮 + 软件光栅出
  PNG（`GRID=1` 出全部姿势拼图），并打印关节点世界坐标；**`scripts/check-shape.mjs` 逐滑杆出
  对照图 + 量测**（`ZONE=torso|hip|chest|leg` 限定取景带），体型改动先跑它看量测与形状；
  实机另有 `window.__mannequinDebug` 出口（卸载时自动清）。别靠截图猜。
- **身高按网格实测归一**（`check-shape` 与 viewer 一致）：用骨的世界矩阵量身高会随姿势变
  （弯腰时头顶变低，模型跟着忽大忽小）；骨链长度 / 肩宽位移要按「姿势无关的静止位姿」算。

计费红线（mmx-h3-image skill 实证）：接口非幂等，无任何自动重试；客户端超时 ≥ 600 秒；
`signal` 只拦「尚未发出」段，已发出的生成不响应取消，结果照常进历史。

UI 组件来自 **dsh-ui-cell 复制件**（`src/client/ui/`，源码归本插件）：改样式先读
`.agents/skills/dsh-ui-cell/`，类名一律 `css.xxx` 取、自有类用 `idi-` 前缀；
样式注入器 `panel-css.ts` 按依赖序拼复制件（被复用者先注入）。RPC 返回信封
`{ok, value, error}`，一律经 `src/client/api.ts` 的 unwrap。

## 常用命令

```sh
pnpm install        # 首次
pnpm build          # 构建（产物进 lib/，不入库）
pnpm test           # 自守护栏测试
pnpm typecheck
pnpm dev            # watch 重建
pnpm dev:hmr        # host 半边热重载接线（client 半边重建即热替换）
pnpm profile:add    # link: 安装进 ~/.dsh/profiles/desktop（缺依赖自动 install、装前自动构建、登记名单、自检）

# ── DSH 实例管理 ──
pnpm dsh:status     # 实例在跑与否 + 访问地址
pnpm dsh:start [前台|后台]   # 启动实例（打包版带 --inspect；启动前有构建门）
pnpm dsh:restart    # 优雅停止后重启（默认后台）
pnpm dsh:stop       # 优雅停止（inspector 自动应答退出；兜底属主圈定）
pnpm dsh:probe      # 连实例验证本插件装载且 active（pluginInventory/list）
```

## 红线

- **lib 不入库**：构建产物不进 git。gitignore 已按布局锚定（single = `/lib/`，workspace = `packages/*/lib/`）；勿改回裸 `lib/`，那会任意深度匹配误伤 `scripts/lib/` 共享模块，clone 出来的仓 build 直接挂。
- **发布面不含 src**：`files` 白名单与 `exports` 都不带源码；`./src/*` 是官方 client 包的 monorepo 内约定，独立发行插件无人消费。
- **DSH 版本锚 `0.2.2-rc.2`**：peerDependencies 范围与 `engines.dsh` 都锚在此，升级时同步 `package.json` 与注释。
- **依赖决策表**：peer = 外置（宿主供给同一实例，运行期共享）；dependencies = 内联自带；devDependencies = 只许 `import type`。唯一事实源是 `package.json`（`scripts/lib/manifest-deps.mjs` 派生 tsdown 三件套），源码导入纪律由 `tests/import-guard.spec.ts` 机械执行。
- **schemastery 双声明**：peer（与宿主共享实例）+ dev（精确钉本仓 typecheck），缺一会装出两份实例。
- **cordis 只许 `import type { Context }`**：dev 钉版仅服务 typecheck。值导入前必须先把 cordis 升进 peerDependencies，否则 alwaysBundle 会把它内联进产物，运行期出现第二份 cordis 实例（作用域与注册表不跨副本共享，插件静默失灵；教训源自早期插件仓的实测事故（2026-10-22）），导入护栏会拦。
- **typert 纪律**：face 方法只声明在 `src/remote.ts`；协议包 devDep 必须裸精确版本（放宽会让 vendor 副本成为合法候选）；zod 必须留在 dependencies（生成产物 import 它）。
- **实例固定经 `pnpm dsh:start` 启动**：打包版要带 `--inspect` 才有 inspector，Dock 直启的实例 stop / restart 管不了；启动前构建门失败会阻断（lib 不入库，没有旧产物可跑）。
- **行文不用破折号「——」**（zero 知识库行文规范，2026-11-01 起）。

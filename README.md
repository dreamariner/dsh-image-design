# dsh-image-design

@dreamariner/dsh-image-design：**图片设计**，用 MiniMax 图片模型（image-01 / MiniMax-H3-Image）生成图片的 DSH 插件，能力对齐 mmx CLI 的 `image generate`。host 半边经 mmx 子进程执行生成并落盘归档，client 半边提供参数设置、结果画廊与对比、历史回看。由 create-dsh-plugin 生成，形态：**host + client 双端**。

> 项目名与包名是两回事：项目名（本目录 / 根壳 manifest 名，缺省 = 首个插件 id，
> `--project-name` 自定义）标识这个仓；包名标识 `packages/` 下的插件包（发布与
> 安装都认它）。多插件项目里两者通常不同。

本仓是 workspace 布局：根壳承载测试与类型检查，插件包在 `packages/<id>/`（构建 / 发布 /
安装都以它为单位）。默认含一个插件，`add` 子命令可继续追加，结构无需迁移。

## 安装

**想用**（npm）：

- headless 环境：`dsh plugin --profile <name> add @dreamariner/dsh-image-design`（官方 reconcile 登记名单）
- desktop 应用：Plugin Manager 里直接装
- 或统一一条命令：`pnpm profile:add --npm`（同下，多一层自检）

**想改**（本地源码态）：

```sh
pnpm profile:add          # link: 本仓 packages/dsh-image-design 装进 ~/.dsh/profiles/desktop；缺依赖自动 install、装前自动构建
pnpm profile:add --remove # 反向卸载（含名单清理）
```

脚本依次做：缺依赖先 `pnpm install`；`pnpm --filter @dreamariner/dsh-image-design... build`
构建本包及其 workspace 依赖（lib/ 不入库，link: 安装不触发 pnpm lifecycle）；
`pnpm add link:<本仓>/packages/dsh-image-design --dir <profile>`；包名幂等追加进
profile `package.json` 的 `dsh.profile.bundles`（DSH 只认这份名单，裸 `pnpm add`
不登记 = 插件静默不挂载）并钉 packageManager；realpath 自检 manifest 带
`dsh.bundle`、包名一致、入口产物存在。装完**重启实例一次**生效。

> 手动等价：`pnpm add <spec> --dir <profile>` 后，把 `@dreamariner/dsh-image-design` 补进
> profile `package.json` 的 `dsh.profile.bundles` 数组。⚠ 手动 link 别指仓根：
> 根壳没有 `dsh.bundle`，loader 会静默跳过（不报错、插件不出现）。

> 从 git clone 本仓后先补协议声明源 submodule：`git submodule update --init packages/protocol`
> （根壳 preinstall 守卫会在缺失时给出同样指引）。

## 功能与使用

- **入口**：右栏「新标签页」首页的工具清单（指南页）里的「图片设计」条目，点条目即打开右栏 tab；面板分「生成 / 素体 / 历史」三视图。条目图标与插件卡片**共用同一份美术**：包根 `icon.svg` 是唯一真源，构建期由 `scripts/generate-icon-art.mjs` 生成客户端用的 `src/client/generated/icon-art.ts`（字节级同一份，测试守着漂移）；清单侧以 data URI 渲染，插件卡片侧直接用 `icon.svg` 文件。
- **生成**：模型（image-01 / H3-Image）、比例档（W:H）+ 面积档（1K/2K/4K，H3）、精确尺寸（H3，WxH）、
  像素宽高（image-01，512..2048 的 8 倍数）、张数（1..10）、seed / 提示词优化 / AIGC 水印（image-01）、
  提示词增强（H3，默认开）、主体参考（image-01，type=character）、参考图 1..16 张（H3，自动走编辑接口）。
- **素体设计**：真人比例的**蒙皮人偶**（MakeHuman 基础网格 + 自建骨架，three.js 渲染，GLB 内联），
  解决图片模型在 **体型 / 动作 / 相机视角**三个维度难控制、难保一致的问题。滑杆调体型（身高 /
  头身比 / 肩宽 / 胸围 / 腰围 / 臀围 / 四肢粗细 / 臂长 / 腿长，围度走**网格形变**、长度走
  **骨链缩放**，滑杆所见即所得）；姿势库 8 种（T-pose / A-pose / 站立 / 叉腰 / 行走 / 奔跑 /
  坐姿 / 跪坐，骨架驱动）；相机景别（全身 / 七分身 / 半身 / 特写）× 方位（正面 / 1/3 侧 /
  正侧 / 背面）× 俯仰（平视 / 微俯 / 微仰）预设，视口支持拖拽转方位、滚轮推拉。点「拍摄」离屏
  导出干净 PNG（三点柔光 + 接触阴影，长边 1024/1536/2048 × 比例 1:1/2:3/3:4/9:16）落盘归档
  （`<outDir>/refs/<refId>/`，ref.json 钉死当次体型 / 关节表 / 相机），参考图列表一键
  「用作参考图」进生成表单的 H3 参考图（历史档跨会话可直接复用）。
- **结果**：缩略图画廊（点开 lightbox 放大）、每张带实际尺寸与 `revised_prompt`（可展开），
  勾选 2..4 张进入并排对比视图。
- **历史**：每轮生成落一个运行目录（`<outDir>/<runId>/`，图片 + `run.json` 清单），
  面板按时间倒序列出，可回看、删除（连文件一起删）。素体参考图另存 `<outDir>/refs/<refId>/`。
- **Agent tool**：`dsh-image-design_generate`（参数面 snake_case，与面板共用同一套 handlers）。

产物落盘纪律（MiniMax 图像接口硬规则）：URL 24 小时失效，mmx 负责下载；接口非幂等，
**没有任何自动重试**；客户端超时 ≥ 600 秒；生成发出后取消只拦「尚未发出」段，
已发出的等待不响应取消（杀进程拿不回结果还照样计费），结果照常进历史。

### 素体模型（资产与骨架）

素体是**真人比例的蒙皮人偶**：MakeHuman 基础网格（CC0，文件头写明 2020 年以 CC0 释出）
+ 本仓自建的 28 骨骨架 + 蒙皮权重，构建期内联成 base64 进 client bundle。

- **资产流水线**（三步，都在 `packages/dsh-image-design/scripts/`）：
  1. `fetch-makehuman-base.mjs`：按**钉死的 commit** 拉源网格（上游随时可能改网格）
     → `assets/makehuman-base.obj`；
  2. `build-mannequin-body.mjs`：只取 `body` 组的面（丢掉 helper / 关节辅助球），用
     `joint-*` 辅助球的球心摆骨，按「顶点→骨段距离」算蒙皮权重（前 4 根归一 + 邻域平滑），
     写出带蒙皮的 `assets/mannequin-body.glb`（POSITION / NORMAL / JOINTS_0 / WEIGHTS_0 + skin）；
  3. `generate-mannequin-glb.mjs`：GLB → base64 模块（构建期自动跑）。
- **顶点属性不许交错**：gltf-transform 默认的 interleaved 布局会把 JOINTS_0（UNSIGNED_SHORT）
  与 POSITION / NORMAL / WEIGHTS_0（FLOAT）混进同一个 bufferView —— glTF 不允许（同一视图内
  componentType 必须一致），three.js 读出来蒙皮索引全是顶点坐标，模型直接散架。构建脚本用
  `VertexLayout.SEPARATE` 分视图，`tests/mannequin-asset.spec.ts` 守着这条。
- **体型参数怎么落地**：躯干是**跨骨平滑蒙皮**的，只缩放脊柱那几根骨围度几乎看不出来
  （「滑杆形同虚设」的根因）。所以围度类（胸 / 腰 / 臀 / 肩宽）走**区域场网格形变**：
  在躯干高度带上按平滑权重直接缩放顶点（只作用于主导骨是躯干骨的顶点，手臂腿不受影响）；
  四肢粗细走**垂直骨轴**放大（关节位置不动）；臂长 / 腿长走**骨链局部位移缩放**（关节跟着走）。
- **骨架语义**：28 根骨，局部旋转全是单位阵 → 骨的朝向就是世界朝向，姿势欧拉按世界轴书写；
  绑定姿态就是 A-pose（手臂自然下垂约 40°），所以不需要「落臂补偿」。角色左 = +x，面朝 +z。
- **开发期离线验姿势**：`scripts/preview-body.mjs` 在 Node 里读 GLB 做蒙皮 + 软件光栅出 PNG
  （`GRID=1` 出全部姿势拼图），并打印关节点世界坐标 —— 调姿势用数字对齐，不靠截图猜。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `mmxBin` | `mmx` | mmx 可执行文件（名字或绝对路径）；本机没有先 `npm i -g mmx-cli` 并 `mmx auth login` |
| `outDir` | 空 | 产出根目录；留空自动：有工作区用 `<工作区根>/.image-design`（点开头的隐藏目录，产出是过程数据），否则 `~/.dsh/storages/dsh-image-design/outputs` |
| `timeoutMs` | `660000` | mmx 子进程超时（毫秒），必须 ≥ 600000（服务端最长等待） |
| `defaultModel` | `image-01` | 面板与 tool 未显式指定模型时的默认值 |

## DSH 实例管理

```sh
pnpm dsh:status     # 实例在跑与否 + 访问地址
pnpm dsh:start      # 启动实例（启动前构建门：构建失败阻断启动）
pnpm dsh:restart    # 优雅停止后重启（默认后台）
pnpm dsh:stop       # 优雅停止
pnpm dsh:probe      # 连实例验证本插件装载且 active
```

纪律：实例固定经 `dsh:start` 启动（脚本给打包版带 `--inspect` 并等就绪）；Dock 直启的
实例没有 inspector，stop / restart 管不了。环境变量：`DSH_HOME` / `DSH_PROFILE` /
`DSH_LOG` / `DSH_DESKTOP_APP` / `DSH_DESKTOP_FORM`（=dev 需 `DSH_CHECKOUT`）。

## 开发

```sh
pnpm install
pnpm dev           # watch 构建全部插件包：保存即重建 lib/
pnpm dev:hmr       # host 半边热重载接线（见下）
pnpm test          # vitest run（根配置通配 packages/*/tests/）
pnpm typecheck     # tsc --noEmit（根 tsconfig 通配全部插件包）
pnpm build         # 单次构建（pnpm -r build）
```

- **pnpm dev**：watch 重建各包 `lib/index.js`（host 半边）与 `lib/client.js`（client 半边，若有）。
- **pnpm dev:hmr**：项目级接线（`scripts/dev-hmr.mjs` 一份），把**全部插件包**的
  `lib/` 注册进本机 home patch（`$DSH_HOME/cordis.patch.yml`）的 hmr watch 根；
  add 新插件后重跑一次即可。**注册后需重启实例一次**，之后的 host 半边改动随
  `pnpm dev` 重建即时热重载（免重启、PID 不变）。`--remove` 注销本仓全部注册。
- **client 半边免接线**：DSH 的 client-hmr 自动盯着 `lib/client.js`，重建即热替换，
  不需要（也不应该）把它加进 hmr root。

## 追加插件

在仓根执行（三形态同一种结构，加包不改根）：

```sh
npx @dreamariner/create-dsh-plugin add <包名> --type host|client|full
```

- 根壳脚本按 `pnpm -r` 递归转发，根 vitest / 根 tsconfig 按 `packages/*` 通配，
  新插件包自动被收编，无需改任何根文件
- 追加 `full` 形态会自动补协议声明源 submodule 与 `tsconfig.host.json` 的 face 引用
- 每个插件包独立发布：`pnpm --filter <包名> publish`

## 发布

```sh
pnpm --filter @dreamariner/dsh-image-design publish   # prepare 自动构建 lib/ 再打包；scoped 包已配 access=public
```

发布前检查：`packages/dsh-image-design/locale/*.json` 的 `meta.title` / `meta.description`
换成真实文案、`icon.svg` 换成原创图形（Plugin Manager 与 Settings 会展示它们）。

## 结构

```
scripts/             项目共用脚本（一仓一份，add 插件不复制）
  dev-hmr.mjs          项目级 hmr 接线（注册全部插件包 lib/）
        lib/manifest-deps.mjs  依赖策略单一来源（不变式 I1/I2，tsdown 配置引用）
                     sync-pack-docs.mjs   发布前把仓根 README / LICENSE 同步进包目录
      ensure-protocol.mjs  仓根 preinstall 硬守卫（协议声明源缺失即 fail）
packages/dsh-image-design/
src/index.ts        宿主半边入口（apply + inject + Config + Agent tool）
src/config.ts       配置 schema（schemastery，peer 共享宿主实例）
src/out-dir.ts      产出根目录解析（纯函数零依赖，单测直接引入）
src/contract.ts     wire 契约类型唯一事实源（ImageModel / GenerateParams / RunRecord 等）
src/types.ts        公开类型子路径（typert 生成器要求边界类型从非根子路径导出）
src/mmx.ts          mmx argv 构造（纯函数）与子进程执行（无重试）
src/generate.ts     生成编排与历史归档（runId 目录 + run.json 清单 + readImage allowlist）
src/remote-handlers.ts  业务处理器（Remote 与 Agent tool 共用，防漂移）
src/remote.ts      Typert Remote 契约（codegen 单一来源，标准装饰器）
src/client/index.tsx 浏览器半边入口（tab 类型 + guide 清单条目 + pane 槽位注册 + $mount）
src/client/ImageDesignIcon.tsx 清单条目图标（读生成的 icon-art，data URI 渲染）
src/client/generated/icon-art.ts 图标美术生成物（由 icon.svg 生成，勿手改）
src/client/App.tsx   面板本体（表单 / 画廊 / 对比浮层 / 历史视图）
src/client/MannequinView.tsx 素体视图（视口 + 体型滑杆 / 姿势 / 机位 / 拍摄 / 参考图列表）
src/client/mannequin/body.ts  体型参数面 + 参数→形变指令（区域场 / 骨轴 / 骨链长度）
src/client/mannequin/shape.ts 网格形变（绑定姿态 LBS 混合 + 区域场 + 胸廓双峰）
src/client/mannequin/rig.ts   骨架装配层（关节↔骨名映射、世界系级联姿势合成）
src/client/mannequin/poses.ts 姿势库（8 种，关节欧拉角表）
src/client/mannequin/camera.ts 景别 × 方位 × 俯仰机位预设
src/client/mannequin/capture.ts 影棚灯光与离屏导出
src/client/mannequin/viewer.ts 素体视口（GLB 加载、骨架绑定、轨道交互、拍摄）
src/client/generated/mannequin-glb.ts 素体资产内联生成物（由 assets/xbot.glb 生成，勿手改）
src/client/api.ts    Remote 信封解包（{ok,value} → 裸值，!ok 抛错）
src/client/state.ts  极小 observable store + useSyncExternalStore
src/client/panel-css.ts  样式注入器（idi- 自有类 + duc- 复制件按依赖序拼接）
src/client/ui/       dsh-ui-cell 复制件（源码归本插件，升级用 add --force 重新复制）
cordis.patch.yml    自挂载 bundle patch
locale/*.json       展示元数据（meta.title / meta.description）
icon.svg            插件图标（≤ 256 KiB）
tsconfig.typert.json  typert face program（生成器解析本包源码用）
tests/              bundle 形态守卫 / client 边界护栏 / 自身用例
assets/makehuman-base.obj 素体源网格（MakeHuman base，CC0，钉死 commit 拉取）
assets/mannequin-body.glb  素体资产（源网格 + 自建骨架 + 蒙皮权重的构建产物）
scripts/fetch-makehuman-base.mjs   拉源网格（钉 commit）
scripts/build-mannequin-body.mjs   源网格 → 骨架 + 蒙皮权重 → GLB
scripts/generate-mannequin-glb.mjs 资产 → 内联 base64 生成物（构建期跑）
scripts/preview-body.mjs           开发期离线预览（蒙皮 + 软件光栅 + 关节点坐标）
tsconfig.host.json    typert 生成器的 workspace 聚合配置（registration + paths 重定向）
packages/protocol/  协议声明源 submodule（dreamariner/dsh-typert-protocol）
```

## 依赖纪律（不变式，改动前必读）

名单只写在 `package.json` 一处，`tsdown.config.ts` 从它派生：

- `peerDependencies`（schemastery、dsh-typert-protocol）＝宿主供给同一实例 → 构建外置；
- `dependencies`（zod、若有）＝插件自带 → 构建内联；
- `devDependencies` ＝只许 `import type`（类型源，dev 精确钉版本）。

client 半边的模块表请求（react 系）由宿主渲染进程供给，清单在 `tsdown.config.ts`
的 `EXTERNALS`，**不能**从 manifest 派生（那是宿主契约不是依赖声明）。

## typert：client 与 host 的类型化 RPC

本模板已接好 typert codegen 全链路，四件接线缺一不可（护栏守着）：

1. **协议声明源**：`packages/protocol`（git submodule，共享仓
   `dreamariner/dsh-typert-protocol`），挂载路径不可挪（生成器结构性要求：
   workspace registration 必须位于 `<root>/packages/` 下，且它对路径做 realPath，
   软链会失效）。
2. **face 配置**：`tsconfig.host.json`（聚合：paths 把协议说明符重定向进声明源 +
   references 构成 registration；仓里每加一个 full 插件，`add` 会自动追加一条
   引用）+ `tsconfig.typert.json`（生成器解析本包源码）。
   两个文件只被生成器读，根 `tsconfig.json` 已 exclude 声明源目录（避免与 npm 包
   d.ts 的 Context 增强撞 TS2717）。
3. **构建接线**：`tsdown.config.ts` host 段的 `typertPlugin({ mode: 'workspace',
   faces: ['host'] })`，构建时生成 `lib/typert.host.*`（宿主侧 wire codec）与
   `lib/typert.remote-client.*`（client 侧类型化 RPC）。
4. **manifest**：协议包 peer（宿主供给同一实例）+ devDep **裸精确 pin**（放宽成
   范围会让 vendor 副本变成运行期候选）+ zod dependencies（生成产物 import 它）。

写法要点（都在 `src/remote.ts` 注释里）：服务键必须字符串字面量、类必须从
`src/index.ts` re-export、形参名与 wire 名逐字一致。

**升级协议声明源**（跟随 DSH 泳道）：

```sh
cd packages/protocol
DSH_CHECKOUT=<DSH 仓库 checkout 路径> node scripts/vendor-protocol.mjs --check   # 校验
DSH_CHECKOUT=<DSH 仓库 checkout 路径> node scripts/vendor-protocol.mjs           # 同步
cd ../.. && pnpm test                                  # 全部护栏（含共享仓自守与消费端守卫）
git -C packages/protocol add -A && git -C packages/protocol commit -m "chore: sync upstream" && git -C packages/protocol push
git add packages/protocol                              # 本仓记录新指针
```

**SSH 与 HTTPS**：`.gitmodules` 里记录的是 SSH 形态（协作者配一次 GitHub key 即可）。
本机想走 HTTPS（PAT 或凭据助手），用 git 的 URL 重写，不用改 `.gitmodules`：

```sh
git config --global url."https://github.com/".insteadOf "git@github.com:"
```

反向同理（`.gitmodules` 是 HTTPS 基线时，有 key 的人重写回 SSH）。git 没有
「多 URL 依次回退」，`insteadOf` 是官方机制；注意 npm 式的 `git+https://` 前缀
git 不认识，`.gitmodules` 里不能这么写。

**client 侧消费**（生成产物 `lib/typert.remote-client.js` 已就绪，接法三行）：

```ts
import { TYPERT_REMOTE } from '@dreamariner/dsh-image-design/remote'   // 生成产物（不要从 src/remote.ts 值导入:会把协议包拖进浏览器 bundle）
// client 半边的 apply 里：
ctx.effect(() => ctx.remote.$mount(TYPERT_REMOTE), 'mount remote')
// 之后 ctx.remote.imageDesign.ping() 全程类型化
```

接之前把 `'@deepseek-ai/dsh-typert-protocol'` 加进 `tsdown.config.ts` client 段的
`EXTERNALS`（它的运行时由宿主渲染进程模块表供给；清单外会被内联，protocol 包不在
你的 dependencies 里，内联解析不到）。

## 下一步

- host 能力扩展点：tools / systemPrompt / provider / listener，选最弱的够用机制
  （官方 practices：restrict < guard < waterfall < 整体替换）。
- client UI：槽位注册见 `src/client/index.tsx` 顶部注释；控件别 require 任何
  `@deepseek-ai/dsh-client-*` 包（官方 practices 明令），照宿主的样子自己写，
  样式只引用 `--dsw-alias-*` 主题 token。

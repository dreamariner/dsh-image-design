# AGENTS.md · dsh-image-design

> Agent 进仓先读本文：项目定位、目录结构、形态不变量、门禁与红线。人向的安装与使用说明在 [README.md](README.md)。

## 项目定位

@dreamariner/dsh-image-design：**图片设计**，用 MiniMax 图片模型（image-01 / MiniMax-H3-Image）生成图片的 DSH 插件，能力对齐 mmx CLI 的 `image generate`；另带**素体设计**（MakeHuman HM08 蒙皮素体：cm 级人体测量求解 + 性别 / 胸型 / 局部雕刻 morph + 姿势 / 机位拍参考图，一键进 H3 参考图闭环）。host 半边经 mmx 子进程生成并落盘归档；client 半边提供参数设置、结果画廊与对比、历史回看。由 create-dsh-plugin 生成，形态：**host + client 双端**。

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
4. **素体参考图链路**（issue 003 建，004 重做体型，005 姿势改求解）：client `mannequin/`
   （body.ts 关节名/骨架语义；poses.ts 8 姿势的静态关节表（005 起只作回归基准）；
   targets.ts 8 预设的**高层意图目标**（按体型换算）；solver.ts 意图 → 物理 + 约束 + IK →
   关节角；host.ts 运行时与测试共用的几何装配；ik.ts 两骨解析 IK；contact.ts 体段碰撞体；
   rig.ts 关节→骨映射 + 级联姿势合成 + lowestSkinnedY 落地；shape3.ts 三层 morph 引擎
   （性别基→胸型→雕刻→测量）；morph.ts 读 morph bin/manifest；measure.ts 1:1 复刻
   MakeHuman 测量求解器；camera.ts 景别×方位×俯仰预设；capture.ts 影棚 + 离屏导出；
   viewer.ts GLB/morph 装配 + reground 落地 + 物理推进 + 抓肢体拖 + 拍摄；
   archive.ts 意图 ↔ 归档 wire 形状的转换）→ wire `saveRefShot`（dataUrl 严格校验）→
   `src/mannequin-handlers.ts` 落盘 `<outDir>/refs/<refId>/`（ref_001.png + ref.json 钉死
   precise/measured/关节表/意图目标/相机）；读图 `readRefImage` 只认该参考图清单 allowlist。
   `listRefs` 带 absPath（历史参考图跨会话可复用），「用作参考图」把 absPath 追加进生成表单的
   H3 refImages 并切回生成视图；「回放姿势」按档里的意图重解（旧档无意图则钉关节表）。
   GLB/morph 资产经 `readAsset` Remote（白名单 3 文件防越界）从包目录下发，client.js
   不内嵌模型。`shape.ts`（003 解析场引擎）仅为旧档回放分支保留（尚未实现，无运行时消费者）。

## 素体资产与骨架纪律（改素体前先读）

- **模型是真人比例的蒙皮人偶**：MakeHuman HM08 基础网格（CC0，`assets/makehuman-base.obj`，
  按钉死 commit 拉取）+ 自建 28 骨骨架 + 蒙皮权重 → `assets/mannequin-body.glb`；
  morph 资产 = `assets/mannequin-morphs.bin`（稀疏位移：u32 count + (u16 顶点索引 + f32
  dx/dy/dz)×count，184 个 morph ≈3.45MB）+ `assets/mannequin-morphs.json`（manifest：morph 表
  / 21 项测量的顶点环 / baseCm 基准值）。**资产不内联**，运行期经 `readAsset` Remote 下发。
  脚本链：`fetch-makehuman-base.mjs` → `build-mannequin-body.mjs` →
  `fetch-makehuman-morphs.mjs` → `build-mannequin-morphs.mjs`（源 `.target` 在
  `assets/morphs-src/`，已 gitignore，钉死 commit 可重建）。
- **morph 数据口径**：`.target` 位移与 base 同为分米制；顶点索引只认 body 组前 13380；
  glTF 顶点 = (OBJ − footBottom) × 0.1，viewer 用 GLB×10 作 base，平移在形变闭环中抵消
  （`tests/shape3.spec.ts` 有 GLB/OBJ 双基等价守卫）。
- **l-/r- 成对纪律**：MakeHuman 的左右对称 modifier 是 l-/r- 两个 target 同权重。
  fetch 脚本对清单里每个 l- 自动补拉 r-；`applyPreciseShape` 对 l- 名自动补 r- 同权重
  （UI 无单侧控制）。**新增 l- target 必须确认同名 r- 存在**，缺侧会让滑杆只形变半边
  （2026-11-17 审计实测 l-upperarm 等全是单边顶点；`tests/morph-precision.spec.ts` 守成对性）。
- **测量求解**：`measure.ts` 1:1 复刻 MakeHuman `Ruler.getMeasure`（环上相邻顶点距离和 ×10，
  含首顶点自环、不补闭合段，与上游逐字节同语义）+ `displayToData` 二分（范围 [-1,2] 16 迭代）。
  测量环依赖 HM08 拓扑，**改 base mesh 会让环失效**，故钉死 commit 不动。20 项测量 morph
  互相耦合（叠加后偏差可达 4.5cm），`solveAllMeasurements` 多轮迭代精修；撤销上一轮权重
  必须用「同一 morph × 负权重」，不能走 applyMeasureModifier(-prev)（那会在 prev>0 时错用 decr）。
- **身高与测量口径**：viewer 按 `(身高cm/100)/localHeight` 整体缩放渲染（骨 rest 位置量
  localHeight，与姿势/体型无关）。`applyPreciseShape` 接收 scale：测量目标按 1/scale 换算
  进求解空间、回显乘回，**回显 = 渲染出来的世界 cm**（身高曾游离在口径外，210cm 时回显 92
  实际渲染 114.6，2026-11-17 审计修复并加测试）。
- **UI 测量基准 = 实时预览，勿手填也勿用 baseCm**：滑杆基准来自 viewer 的
  `previewMeasurements()`（当前体形在无测量 morph 下的实测，随性别/宏观/雕刻/胸型联动）；
  manifest `baseCm`（HM08 裸网格实测）只作资产未就绪时的兜底。基准若用裸网格值，一动
  滑杆就把目标写成裸网格值，求解器把性别形变出来的体形压回去（默认 gender 0.5 胸围
  预览 91.4 vs baseCm 80.4，差 12cm，实机「胸围极速坍塌且滑回原位无法恢复」，2026-11-18）。
  已设目标在非测量参数变化时按预览差值**重定基**（目标跟随体形，保持相对调节量），
  否则绝对目标钉死会跟性别/体脂滑杆打架。所有滑杆统一语义：初始位置=当前体形实测、
  微动=相对微调、回原位=复原（实机 7 参数族审计 backDiff ≤0.19mm）。
- **素体必须穿紧身衣（安全审查合规）**：HM08 是裸体网格（性别 morph 会形变出胸 / 裆
  特征），素体拍的参考图喂图片模型（H3 refImages）会被安全审查拦截。`suit.ts` 用
  **几何壳**（独立 SkinnedMesh 布料层）：绑定姿态一次构建——每顶点覆盖权重场（躯干链
  + 锁骨 factor=1，大腿 factor=裤摆 smoothstep，全局乘领口衰减）→ 逐三角形分类（均值过
  阈值：敏感带内 0.25 / 带外 0.35，min>0.05 防舔纯手臂）→ 壳顶点 = body 顶点 + 法线×offset
  （offset 0.8~6mm 随权重收拢，敏感带内保底 1.5mm）→ skinIndex/Weight 逐顶点复制、bind
  同一 skeleton。材质感来自独立织物材质（roughness 0.95 深炭灰）+ 厚度轮廓；遮盖 =
  **几何遮挡**（壳三角形物理盖住身体表面），不存在颜色混合的半亮像素。
  **三次实机教训勿回退**：① 逐顶点主导骨 AND 分段 → 上背锯齿洞；② 三角形硬分段 →
  边界锯齿；③ 顶点色渐变 → 「只是染色」无材质感 + 半亮色穿敏感区 = 审查漏点。
  敏感带 y 0.62~1.32（上界 1.32：女性罩杯形变后乳房上缘可达 1.30，必须罩住）；
  领口线取颈骨 rest 高度（拦下颌底泄漏）；裤摆 = 髋/膝 rest 中点。
  壳三角形判定与分类只在绑定姿态做一次；形变同步走 `applySuitDeform`（applyBody 每次
  调用：壳 pos = body 形变后 pos + 形变后法线×offset），布料贴合任意 morph 后体形。
  **测试窗口断言口径必须与三角形判定对齐**（sw>0.25）：sw 0.2~0.25 的腋下交界顶点属
  袖窿裸露区，不在覆盖承诺内（2026-11-18 修测试时对齐）。`tests/suit.spec.ts` 穷尽断言
  敏感带渲染三角形 100% 有壳、形变覆盖不漂移、手/颈零误伤、死顶点不进壳。改覆盖区域先跑它。
- **顶点属性不许交错**（2026-11-17 实机事故）：gltf-transform 默认 interleaved 会把 JOINTS_0
  （UNSIGNED_SHORT）与 POSITION / NORMAL / WEIGHTS_0（FLOAT）混进同一 bufferView，glTF 不允许，
  three.js 读出来蒙皮索引全是顶点坐标 → 模型散架。构建脚本用 `VertexLayout.SEPARATE`，
  `tests/mannequin-asset.spec.ts` 守着。
- **骨架语义**：28 根骨，局部旋转全是单位阵 → 骨的朝向就是世界朝向，姿势欧拉按世界轴书写；
  绑定姿态就是 A-pose（手臂外展 43° + 前倾 23°），自然下垂由 stand 姿势的 armL/armR 构造器
  补偿。踝关节 x>0=跖屈、膝 x>0=后折（反关节禁止）、肘 x<0=屈肘（过伸禁止），正负号见
  poses.ts 顶部标定。角色左 = +x，面朝 +z。
- **蒙皮权重必须按「链向坐标」互补分配（2026-11-18 定位的膝盖压扁根因）**：
  纯距离权重（顶点到骨段的距离）在关节处**忽略轴向位置** —— 膝上方 3cm 的顶点到大腿段
  与小腿段的距离几乎相等 → 两骨各 50% → 大角度屈曲时被两套变换平均，关节体积塌掉
  （LBS 的「糖果纸」效应），膝盖被压扁。实测（修前 → 修后，脚本 `scripts/measure-collapse.ts`）：
  坐姿膝半径比 0.82→0.98、跪坐 0.76→0.90、跑步摆动腿 0.86→0.98；截面比 0.90→0.97。
  修法（`scripts/build-mannequin-body.mjs` 的 4a/4b/4c 三段，别改回去）：
  ① 距离权重 → 多轮邻域平滑；② **链向互补分配**：沿肢体轴取关节的有符号偏移 x，
     子骨权重 = logistic(x/σ)（σ=1.5cm），父骨 = 1 − 子骨（两者互补，关节面各 50%），
     σ 控制过渡带宽（窄 → 不塌陷、宽 → 塌陷）；③ **前后解剖偏置**：关节前方
     （髌骨/鹰嘴）留父骨、后方（腘窝/肘窝）交给子骨（把过渡带沿轴向平移 x−0.6·s）。
  腕/踝同样要收窄过渡带：距离权重在这两处是 50/50 软过渡，屈肘/屈踝时手腕附近的顶点
  被抻长（实测手腕被拉到肘的高度 → 手臂看起来被抻长 + 审计出假的「手插进大腿」）。
- **关节处必须切断祖先骨（2026-11-18 定位的「爪形手」根因）**：
  链向互补分配只改「父骨 ↔ 子骨」这一对，**没管更上面的祖先骨**。实测指尖顶点
  带着 **23% 前臂骨权重**（Hand 38% + HandEnd 38% + ForeArm 23% + Arm 2%）——
  前臂骨不随手腕旋转，于是手腕一屈（坐姿腕屈 80°）那 23% 就把指尖往回拽，
  手指被撕成扇形尖刺（实机截图的「爪子」）。修法：hinge 的**作用范围从球改成圆柱**
  （垂直骨轴的半径，半径内的顶点都属于这条链），并把**祖先骨权重按同一条 logistic
  曲线退场**（不是硬切，关节面仍各 50%，σ 仍 1.5cm）。修后指尖权重 = Hand 62% +
  HandEnd 38%，前臂/上臂权重 **0**。肩（锁骨→上臂）只切父子不切祖先：腋窝离上臂轴
  只有 5cm，硬切祖先会把腋窝撕开。
  **判别口诀**：关节的子骨侧顶点不得带任何祖先骨权重 —— 一条链上「越远越不能被拽回去」。
- **基础网格的四指是张开的（2026-11-18 实测，未根治）**：
  HM08 的四指指间夹角 25~35°、指尖横距 7cm，侧视像耙子、摆臂时尤其扎眼。
  三种收拢都试过并留了记录（构建脚本 4d 段）：① 远端横坐标整体缩放 → 四指压成一片、
  指面翻成尖刺；② 按指聚类硬平移（目标间距 1.45cm）→ 指根蹼部被压出褶皱锯齿；
  ③ 按指聚类 + 高斯软归属（目标间距 1.9cm）→ 指尖横距 7→5.7cm、实机无破面，但
  改善有限。**顶点位移这条路已走到头**，要根治得走「整手重指」（重排手指骨架 + 重新
  蒙皮），别再在顶点上补 —— 顶点位移必然伤蹼部。
- **腕屈角有自然区间（姿势层的硬判据）**：
  静置手腕的屈曲是 **10°~30°**（人手上限约 70°）。腕屈 63° 配上张开的手指，
  正视就是一把耙子 = 用户判「不正常」的直接原因。`scripts/probe-hands.ts` 量
  「前臂轴 vs 手轴夹角」（腕屈角）、「手轴 vs 大腿轴夹角」（手搭腿时手指是否顺腿）、
  指尖张开度；`scripts/try-pose.ts <poseId> '<json>'` 单组评估（腕屈/手位/穿模），
  `... grid` 扫手部参数。**改姿势后必须先跑这两个量，再看渲染**。
- **姿势复查必须看侧视 + 近景（2026-11-18 实机教训）**：正视图会把「手悬在膝盖前方、
  手心朝上」这类**前后关系**的问题藏住（正视图里手看着像搭在腿上，侧视才看出它在空中）。
  坐/跪这类有前后关系的姿势，**只看正视图等于没看**。离线取景：`preview-mannequin.mjs`
  的 `CROP=hands`（只画手 + 大腿）+ `YAW=` 侧视；实机：拖视口转方位 + 滚轮推近。
- **手要落在大腿「面」上，不在大腿外缘**（2026-11-18 实机截图修正）：判据四条 ——
  ① 指尖横向 |x| ∈ 10~17cm（大腿骨轴在 ±12cm，落在大腿外缘会被大腿侧面挡住，
  侧视像插进腿里）；② 腕屈 10~35°；③ 手轴与大腿轴 3~35°（手指顺腿）；
  ④ 手心离大腿面 1~2cm（不是指尖高，是手心 —— 指尖高会被手的倾角骗）。
  量用 `scripts/probe-hands.ts` / `scripts/check-hand.ts`；改角度走 `solve-arm-contact.ts`
  （IK + 碰撞约束），别手改数值试。
- **本骨架里「加大肘屈」会把前臂甩向外侧**（2026-11-18 实测）：绑定姿态的前臂本就朝外前
  31°，肘屈（世界 x 轴）会把手甩得更靠外、更靠前；想让前臂朝前必须用**肘外展**补偿
  （−0.4~−0.65），单纯加肘屈只会让手离大腿越来越远。
- **紧身衣边界要平滑（锯齿=像撕破的布）**：壳的边界是按三角形阈值切的 → 轮廓在网格粒度
  上是锯齿。修法：边界环做**切平面内**的拉普拉斯平滑（位移投影到切平面 = 沿体表滑，
  不穿体表；法线方向高度不变）；切向位移**单独存** `SuitBuild.tangent` 并随
  `applySuitDeform` 一起搬运（否则一改体型锯齿就回来）。
- **离线看效果要带壳（安全 + 不用开浏览器）**：`scripts/preview-mannequin.mjs`
  复用运行时的 `buildSuit` 把紧身衣壳一起建出来再渲染（HM08 是裸体网格，直接渲染
  裸体会把不安全内容带进会话）；`GRID=1` 出 8 姿势 ×（正/侧）拼图，`HAND=1` 只出手，
  `POSE_JSON='{...}'` 临时覆盖关节试姿势，`YAW=` 侧视。
  **别再用旧 `preview-body.mjs` 的全身裸模渲染**。
- **姿势落地走 reground**：按蒙皮后的真实最低点归零（候选顶点集绑定姿态 y<0.45m 只算一次，
  换姿势 <5ms），不写死骨盆高度。**glTF 节点默认 `matrixAutoUpdate = false`**：改骨骼的
  quaternion / scale 前必须改回 true 并 `updateMatrix()`，否则蒙皮纹丝不动。
- **改姿势或体型要定量验证**：`tests/pose-geometry.spec.ts`（真骨架 + 真蒙皮断言解剖区间，
  夹具在 `tests/helpers/rig-fixture.ts`）；`tests/pose-collapse.spec.ts`（关节不塌陷门禁：
  大腿膝上方 2–10cm 一圈顶点的半径比，阈值随屈曲角放宽，跪坐要折 140° 以上是 LBS 极限）；
  `scripts/preview-body.mjs` Node 内蒙皮 + 软件光栅出 PNG；实机另有 `window.__mannequinDebug`
  出口（卸载时自动清）。别靠截图猜。
- **姿势必须反穿模，且判据本身必须可信**（2026-11-18 重做）：姿势语义全对也可能穿模，
  解剖区间断言看不见这类错，只能靠碰撞测。**但判据不可信时，「调到审计说 0 为止」是
  循环论证**：旧审计（面法线多数表决 + 符号门槛 + 缝区剔除）在关节凹陷处漏判——实机截图
  里手明显陷进大腿，它报「无穿插」，于是照它调出来的角度必然也错。
  新判据共享在 `src/client/mannequin/contact.ts`，spec 门禁用 `tests/helpers/pose-contact.ts`：
  · **体段碰撞体（`BodyPartCollider`）为主**：把一段肢体抽象成「轴 + 表面」，从**轴心**
    沿「轴心→查询点」打射线，第一个命中就是外表面；查询点比命中点更近 = 陷进去，差值即
    穿深。**符号无歧义**，也不要求网格闭合。命中面必须属于该段，否则射线是从别的部位/
    空洞穿出去的，不能拿来判内外（曾误报「手陷进小腿 34cm」）。
  · 网格带符号距离（`CollisionSurface.query`）只用来量尺寸，符号靠**伪法线**（面/边/顶点
    各备一份，最近点落在哪就用哪份）才可靠；用面法线判「最近点落在边上」的点会随机翻符号。
  · 目标区域（躯干+腿）是**开口面片**，面片收集门槛取「三个顶点里**至少两个**属于目标
    部位」——全部门槛会在主导骨切换处留一条空洞带，射线穿过去量到更远的表面。
- **四个把判据做废的坑（全踩过）**：
  ① **最近点的重心坐标约定必须与构造一致**（q = a·wa + b·wb + c·wc）：早先版本把 c 的权重
     写成 (c−b) 的系数 → 最近点落错位置、符号全反（a-pose 这种明显无穿模的姿势报 6cm）；
  ② **落点特征要精确**（由最近点算法的分支直接给出），别用重心坐标的 eps 去猜：特征猜错
     就用错伪法线 → 符号翻；
  ③ **THREE.Vector3 不支持数字下标**：`dir[0]` 是 undefined 而不是 dir.x。DDA 遍历里写
     `dir[a]` → tMax 全是 NaN → 射线一步没走、永远打不中任何面（现象是「射线完全失效」）；
  ④ **源网格有翻面三角形**（MakeHuman 底网格的已知怪癖）：逐面按顶点法线定向会把这些片
     定成朝内 → 要沿边邻接 BFS 传播朝向（翻面标记做 2-着色）再定全局正负。
- **手臂姿势用「目标 + IK」解，不要手拧角度**（2026-11-18 换思路）：姿势表里的肩肘腕角
  是手拧的，改一个数要在 8 个姿势之间反复试，还试不出「不穿模」的保证——**角度不是表达
  「手该落在哪」的正确变量**。改成声明「腕落在腿面哪里、手掌朝哪」，肩肘角由**两骨解析 IK**
  解出（`src/client/mannequin/ik.ts`），再用碰撞判据验收。求解器
  `scripts/solve-arm-contact.ts <poseId> <L|R>`（`check` 逐姿势体检、`solve` 出欧拉角）；
  量手部姿态用 `scripts/check-hand.ts <poseId> [L|R]`（手轴 vs 大腿轴 / 掌心法向 vs 大腿
  面上方 / 腕屈角 / 肘角）——**先看数字再看渲染**。IK 的两个坑：
  ① 弯曲平面由「目标方向 + pole 提示」共同张成，上臂方向 = f·cosα + pole·sinα；绕 pole
     方向本身旋转会把肘甩到肩前方 5cm（像反关节）；
  ② **指尖不是 `HandEnd` 骨的顶点**（它离腕只有 3.5cm，真实指尖离腕 15.7cm）——手轴要用
     「离腕最远的那批顶点」，拿错会把「手的方向」算成任意方向，掌心法向判定随之全废
     （旧 `scripts/solve-arm.ts` 就是栽在这）。
- **姿势系统三层：意图 → 物理 + 约束 + IK → 关节角**（issue 005，定稿纪律）：
  ① **意图层** `PoseTargets`（`src/client/mannequin/solver.ts`）：末端落点 / 骨盆根 / 头部朝向，
     坐标在**模型局部空间**（holder 的身高缩放与落地位移都被消掉 → 骨长、半轴半径、
     目标坐标都是体型无关的局部量）；语义锚点写「贴在 leftThigh 的 t=0.48 处、外偏 5°、
     离面 2mm」而不是写死世界坐标 → 换体型自动换算。
  ② **物理 + 约束层**：定步长 PBD 子步（重力 → 弹簧回目标 + 阻尼 → 预测 → 身体/地面接触
     投影 + 摩擦 → 速度更新 → 两骨解析 IK），固定 dt=1/120 + 固定子步上限 + 落定早退。
  ③ **表现层**：输出仍是 `JointRotations`（16 关节欧拉表）→ viewer / ref.json / 门禁测试同构。
  · **物理作用在末端目标层，不在骨骼层**：骨骼是运动学链（IK 负责链的形状，肘向与腕旋
    自然）；末端是有质量的粒子（重力压向支撑面、接触推离、摩擦不滑、弹簧连回意图）。
    真刚体引擎会把骨骼变成动力学 ragdoll，与 IK 意图对抗 → 不引入 rapier/cannon。
  · **锚点描述的是接触点，不是腕/踝位置**：求解器按宿主给的「腕→掌心沿手轴距离 / 掌厚 /
    踝高」换算（`host.ts` 的 `handMetrics`）；手部尺寸必须取**掌区顶点**（手轴 20%~45%
    投影段）—— 拿「离腕最远的顶点」会落在张开的指尖上（掌心被算到手掌外，实测坐姿
    手-腿间隙 −37mm → +8mm）。
  · **体段代理的截面用骨局部朝向定**：近竖直段的两条主轴要有意义 → `segmentFrame(dir,
    orientation)` 用骨局部系给半轴，半径按**分位**量（肢体中段细、两端粗），别用单一半径。
  · **可达域夹取的 min/max 别写反**（2026-11-18 修）：`d² = L1²+L2²+2L1L2·cos(f)`，
    maxDist = 伸直、minDist = 最大屈曲；写反则腿永远伸不直（膝卡 135°）。
  · **求解器宿主的骨朝向取父骨**：局部欧拉要用 `boneParentQuat`（父骨世界朝向）；
    取自己的朝向会让腿甩到体侧、整个求解崩掉（实测腿横飞 9cm）。
  · **确定性是硬纪律**：同目标两次求解逐位一致（`tests/targets.spec.ts` 守）→ 参考图归档
    才可复现；固定 dt + 固定子步上限 + 落定早退是前提。
  · **运行时与测试共用同一套几何逻辑**：`host.ts` 的 `createSolverHost(geom, binding)` 是
    唯一装配点（探针选取 / 体段代理 / 手部尺寸），viewer 与测试夹具都走它 → 否则
    「离线调好的姿势，运行时不是那个姿势」。
- **自由摆姿势的入口**：视口「转视角 / 摆姿势」两态；摆姿势下左键拖肢体 = 拖**意图目标**
  （拖动改固定位置并清掉语义锚点，否则会被锚点拉回），物理负责把手压到支撑面、拖快有
  惯性滞后；面板给末端选择 + 高度/前后/内外三个滑杆（局部空间 cm）。手动调过姿势后
  `poseId` 置 `unknown`，姿势下拉补一项「手动调整」占位（否则原生 select 会回退到第一项）。
- **归档要存意图，不只存关节表**：`ref.json` 的 `joints` 记**当前实际生效**的（求解器解出来
  的，不是姿势库那张静态表 —— 005 之前记错了：拍下来的是姿势表的数，渲染的是解算的姿势），
  并新增可选 `targets`（意图）。回放：有意图 → 按当前体型重解（同一个意图换个身高仍是
  站得住的姿势）；旧档没意图 → 钉关节表（逐字节复现），此时求解器要让位（`clearTargets`）。
- **欧拉不是解剖量**：姿势表里 `elbow.x` 看着像「屈曲」，但欧拉是级联的，肩/肘的 y/z 一旦
  不是 0，x 就不再等于屈曲量（IK 解出的姿势 `elbow.x` 反而是正的，几何上肘却正常弯）。
  解剖门禁要量**几何夹角**（上下臂轴夹角 / 前后臂轴夹角），别看表的 x。同理，IK 解出的
  左右臂**不是严格镜像**（每侧独立解 + 网格左右本就不完全对称），别按镜像断言。
- **手臂够不到的地方就别硬够**（2026-11-18 实测）：本骨架肩→腕只有 45cm，
  直立时肩到大腿上表面约 52cm → **手够不到膝盖**。坐姿的正确解是「手掌搭在大腿中段、
  指尖朝膝」（躯干前倾 17°），跪坐是「手掌搭在大腿根部」；硬把手放到膝盖上必然插进大腿。
- **实机页内碰撞测量的三个坑**（2026-11-18 实机复现，页内测量一度报出 300mm 假穿透）：
  ① **后台标签页 React 调度被节流**：切姿势后 React effect（viewer.setPose）不落地，
     骨 quaternion 没变，测的是上一姿势的几何；且 three 的渲染循环暂停 →
     骨 matrixWorld 也不自动更新。必须先真实点击激活页面（cua.click），切姿势后
     手动 `bone.updateWorldMatrix(true, true)` 再测。
  ② **别用绑定姿态法线给姿势后的面定向**：躯干前倾/髋大幅转后定向会反，
     带符号距离全变号 → 满屏假穿透。实机要么用蒙皮后法线定向，要么干脆不判定符号。
  ③ **实机判「有没有穿进去」用无符号间隙**（源点到目标三角形最近距离，稳健）：
     gap ≥ 几 mm 就没穿进去；带符号的平面距离在斜面/大倾角面上不可靠。
     实机 8 姿势用 gap 判据测出的数值与离线审计（scripts/audit-pose-clipping.mjs）
     完全一致，两边可互为校验。
- **003 解析场遗产（仅旧档回放用，暂无运行时消费者）**：`shape.ts` 的 PCHIP 剖面 / 蒙皮软遮罩
  / 四肢整链一次变换 / 肩宽走上臂横向偏移等纪律，等旧档回放分支落地时再生效；
  `scripts/check-shape.mjs` 是它的配套量测工具。

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

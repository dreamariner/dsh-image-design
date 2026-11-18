// 素体视口：真人素体（MakeHuman 基础网格 + 自建骨架的蒙皮人偶，GLB/morph 资产外置，
// 经 readAsset Remote 下发）+ 交互轨道 + 体型形变 + 姿势应用 + 拍摄导出。
//
// 生命周期：createViewer（挂载）→ ready（GLB 解码 + 骨架绑定 + 形变上下文）→
// setBody / setPose / setCamera（状态驱动）→ dispose（卸载）。
// ready 前的 setBody / setPose 调用缓存，加载完成后统一生效。
// 渲染按需（dirty 标记 + rAF），不做持续重绘。
//
// 交互：左键拖拽 = 方位/仰角，滚轮 = 推拉（写回 orbit 状态，经 onOrbit 回调
// 通知 React store —— 状态单源在 store，viewer 只做映射与渲染）。

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { BONE } from './body.ts'
import { bindRig, applyRigPose, lowestSkinnedY, type RigBinding } from './rig.ts'
import { buildStudio } from './capture.ts'
import { computeCameraPose, type OrbitState, type ShotKind } from './camera.ts'
import { poseJoints, type JointRotations } from './poses.ts'
import { parseMorphAssets, BODY_GLB_FILE, MORPH_BIN_FILE, MORPH_MANIFEST_FILE, type MorphAssets } from './morph.ts'
import { applyPreciseShape, writePositionToGeometry, type PreciseBodyParams } from './shape3.ts'
import { buildSuit, applySuitDeform, SUIT_COLOR, SUIT_ROUGHNESS, type SuitBuild } from './suit.ts'
import { PoseSolver, type EndEffectorId, type PoseTargets, type Vec3 } from './solver.ts'
import { createSolverHost, type MannequinGeometry } from './host.ts'
import { computeBodyMetrics, poseTargets as presetTargets, type BodyMetrics } from './targets.ts'

export interface Viewer {
  /** GLB 解码 + 骨架绑定 + morph 资产就绪（失败时 reject，UI 落错误态）。 */
  ready: Promise<void>
  /** 精确体型参数变化 → 重新求解 morph 并形变。 */
  setPreciseBody(params: PreciseBodyParams): void
  /** 当前测量实测回显（目标 vs 实测）。 */
  measured(): Array<{ name: string; targetCm: number; measuredCm: number }>
  /** 测量预览（世界 cm）：无测量 morph 的当前体形实测，UI 滑杆基准（性别/体型联动）。 */
  previewMeasurements(): Record<string, number>
  setPose(joints: JointRotations): void
  /**
   * 设置**意图目标**（高层：手该在哪 / 脚该在哪），由物理 + 约束 + IK 解成关节角。
   * 这是「自由摆动作」的入口：拖肢体改的就是这里的 pos。
   */
  setTargets(targets: PoseTargets, opts?: { reset?: boolean }): void
  /** 当前意图目标（没有则 null）。 */
  getTargets(): PoseTargets | null
  /** 应用一个预设（按当前体型换算目标）。 */
  applyPreset(id: string): boolean
  /** 当前**实际生效**的关节表（求解器解出的，或 setPose 钉的）—— 拍摄归档用。 */
  currentJoints(): JointRotations
  /**
   * 从归档回放姿势。
   *
   * 有意图 → 按当前体型重解（同一个意图，体型变了姿势也跟着合理地变 ✓）；
   * 无意图（旧档）→ 钉关节表（逐字节复现旧档）✓。
   */
  restorePose(joints: JointRotations, targets?: PoseTargets | null): void
  /** 摆姿势模式：抓肢体拖动。 */
  setMode(mode: ViewerMode): void
  /** 求解是否已落定（落定后物理不再推进，省电）。 */
  settled(): boolean
  setCamera(orbit: OrbitState, shot: ShotKind): void
  /** 模型实测身高（m，加载后可得），相机与构图的基准。 */
  bodyHeightM(): number
  /** 身体尺寸（按体型量出来的）：面板的语义动作按它换算目标。 */
  bodyMetrics(): BodyMetrics | null
  /** 离屏拍摄（独立于视口分辨率的干净成像）。 */
  capture(length: number, ratio: string): string
  dispose(): void
}

/** 视口交互模式：转视角 / 摆姿势。 */
export type ViewerMode = 'orbit' | 'pose'

export interface ViewerCallbacks {
  /** 拖拽 / 滚轮导致的 orbit 变化（组件写回 store）。 */
  onOrbit?: (orbit: OrbitState) => void
  /** 意图目标变化（拖完肢体 / 落定后回传，组件写回 store）。 */
  onTargets?: (targets: PoseTargets | null) => void
}

/** 预加载的资产字节（由 MannequinView 经 api.readAsset 拉取）。 */
export interface ViewerAssets {
  glb: Uint8Array
  morphJson: Uint8Array
  morphBin: Uint8Array
  /** 资产文件名（供校验署名，实际加载用字节）。 */
  names?: { glb?: string; json?: string; bin?: string }
}

export { BODY_GLB_FILE, MORPH_BIN_FILE, MORPH_MANIFEST_FILE }

/** 素体陶土色（素体语义：裸体、无服装无特征的灰模）。 */
const CLAY = 0xb9bdc6

/** 脚掌离脚趾骨的厚度（m）：只用于**身高口径**（头顶到脚底），不再用于落地。 */
const SOLE_DROP = 0.035

/** 落地候选顶点的绑定姿态高度上限（m）：脚、小腿下段、自然下垂的手。 */
const GROUND_PROBE_MAX_Y = 0.45

/** 相机状态（orbit 由交互/预设驱动，shot 由景别预设驱动）。 */
interface CamState {
  orbit: OrbitState
  shot: ShotKind
}

export function createViewer(
  container: HTMLDivElement,
  preciseParams: PreciseBodyParams,
  orbit: OrbitState,
  shot: ShotKind,
  assets: ViewerAssets,
  callbacks: ViewerCallbacks = {},
): Viewer {
  const studio = buildStudio()
  const scene = studio.scene

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
  const canvas = renderer.domElement
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  container.appendChild(canvas)

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 30)
  const camState: CamState = { orbit: { ...orbit }, shot }

  let dirty = true
  let disposed = false

  // ── 素体（异步加载）──────────────────────────────────────────────────
  let model: THREE.Group | null = null
  let holder: THREE.Group | null = null
  let binding: RigBinding | null = null
  let skinMesh: THREE.SkinnedMesh | null = null
  let morphAssets: MorphAssets | null = null
  /** 紧身衣壳（独立布料层 SkinnedMesh，见 suit.ts）。 */
  let suitBuild: SuitBuild | null = null
  let suitMesh: THREE.SkinnedMesh | null = null
  /** 绑定姿态的 base 顶点（米制，geometry 顺序；morph 形变基准）。 */
  let basePositionM: Float32Array | null = null
  /** MakeHuman source 顶点（分米制，前 13380），供 morph 求解。 */
  let basePositionDm: Float32Array | null = null
  let baseHeightM = 1.68
  /** 当前姿势的头顶高度（取景用；随姿势变化，站立时≈身高）。 */
  let poseHeightM = baseHeightM
  let currentBody: PreciseBodyParams = { ...preciseParams }
  let currentMeasured: Array<{ name: string; targetCm: number; measuredCm: number }> = []
  /** 测量预览（世界 cm）：无测量 morph 的当前体形实测，UI 滑杆基准（性别/体型联动）。 */
  let currentPreviews: Record<string, number> = {}
  let currentPose: JointRotations = {}
  /** 落地候选顶点（绑定姿态 y < GROUND_PROBE_MAX_Y 的索引），只算一次。 */
  let groundProbe: number[] = []
  // ── 物理求解（issue 005）：意图目标 → 关节角 ──
  /** 求解器（意图 → 物理 + 约束 + IK → 关节角）。 */
  let solver: PoseSolver | null = null
  /** 意图目标（拖肢体 / 切预设改它）。 */
  let currentTargets: PoseTargets | null = null
  /** 身体尺寸（按体型算目标用）。 */
  let metrics: BodyMetrics | null = null
  /** 交互模式：转视角 / 摆姿势。 */
  let mode: ViewerMode = 'orbit'
  /** 拖动中的末端（摆姿势模式）。 */
  let draggingEnd: EndEffectorId | null = null
  /** 顶点 → 主导骨名（拾取末端用）。 */
  let dominantBones: string[] = []
  /** 拖动平面（过拾取点、垂直视线）。 */
  const dragPlane = new THREE.Plane()
  const dragOffset = new THREE.Vector3()
  const raycaster = new THREE.Raycaster()
  const pointerNdc = new THREE.Vector2()

  /**
   * 蒙皮后的世界最低点（m）——落地判据。
   * 只遍历低位顶点子集（约 3k 个），换姿势时的开销在 5ms 内。
   */
  const lowestWorldY = (): number => {
    if (skinMesh === null) return 0
    const geom = skinMesh.geometry
    return lowestSkinnedY({
      position: geom.getAttribute('position') as THREE.BufferAttribute,
      skinIndex: geom.getAttribute('skinIndex') as THREE.BufferAttribute,
      skinWeight: geom.getAttribute('skinWeight') as THREE.BufferAttribute,
      bones: skinMesh.skeleton.bones,
      boneInverses: skinMesh.skeleton.boneInverses,
    }, groundProbe)
  }

  /** 让当前姿势下的最低点贴地（姿势/体型变化后都要调用）。 */
  const reground = (): void => {
    if (holder === null || skinMesh === null) return
    holder.updateMatrixWorld(true)
    holder.position.y -= lowestWorldY()
    holder.updateMatrixWorld(true)
  }

  /**
   * 当前姿势的视觉高度（m，头顶到地面）。
   *
   * 取景不能再用站立身高：跪坐头顶只有 1.09m、坐姿 1.25m，若仍按 1.7m 构图，
   * 人会在画面里缩成一小团且偏下（2026-11-17 实机发现）。
   */
  const refreshPoseHeight = (): void => {
    if (binding === null) return
    const headTop = binding.byName.get(BONE.headTop)
    if (headTop === undefined) return
    const y = headTop.getWorldPosition(new THREE.Vector3()).y
    // ×1.05：头顶骨在颅内，皮肤/发型还要高几厘米；不留这点余量时构图会顶框
    if (Number.isFinite(y) && y > 0.3) poseHeightM = y * 1.05
  }

  /**
   * 体型落地：精确 morph 形变（宏观+雕刻+21项cm测量）→ 写回 geometry。
   * 身高走 holder 整体缩放（姿势无关），落地走 reground（姿势相关）。
   * 测量口径：缩放系数先于求解算出并传入 applyPreciseShape，回显即世界 cm
   * （身高缩放曾游离在测量口径之外，210cm 时回显 92 实际渲染 114.6，审计修复）。
   */
  const applyBody = (): void => {
    if (model === null || holder === null || binding === null || skinMesh === null ||
        morphAssets === null || basePositionDm === null || basePositionM === null) return
    // 1) 缩放到目标身高：localHeight 用绑定姿态骨位量「头顶 − 脚底」，与姿势无关，
    //    也与体型形变无关（morph 只动顶点不动骨架），所以可以先算。
    holder.scale.setScalar(1)
    holder.position.set(0, 0, 0)
    const rest = binding.boneRest
    const toe = rest.get(BONE.toeL)
    const headTop = rest.get(BONE.headTop)
    const footY = toe !== undefined ? toe.y - SOLE_DROP : 0
    const headY = headTop?.y ?? baseHeightM
    const localHeight = Math.max(0.5, headY - footY)
    const scale = (currentBody.height / 100) / localHeight
    // 2) 精确 morph 形变（分米空间求解，测量目标按 1/scale 换算，回显已是世界 cm）
    const result = applyPreciseShape(basePositionDm, morphAssets, currentBody, scale)
    currentMeasured = result.measured.map((r) => ({ name: r.name, targetCm: r.targetCm, measuredCm: r.measuredCm }))
    currentPreviews = Object.fromEntries(result.previews.map((p) => [p.name, p.measuredCm]))
    // 3) 写回 geometry（dm → m，GLB 顶点是米制）
    writePositionToGeometry(skinMesh.geometry, result.position, 0.1)
    skinMesh.geometry.computeBoundingSphere()
    // 3.5) 紧身衣壳重建：布料贴合形变后的新体形（性别/罩杯/胖瘦 morph 后跟随）
    if (suitBuild !== null && suitMesh !== null) {
      const bodyPos = skinMesh.geometry.getAttribute('position').array as Float32Array
      const bodyNor = skinMesh.geometry.getAttribute('normal').array as Float32Array
      const suitPos = suitMesh.geometry.getAttribute('position').array as Float32Array
      const suitNor = suitMesh.geometry.getAttribute('normal').array as Float32Array
      applySuitDeform(suitBuild, bodyPos, bodyNor, suitPos, suitNor)
      suitMesh.geometry.getAttribute('position').needsUpdate = true
      suitMesh.geometry.getAttribute('normal').needsUpdate = true
      suitMesh.geometry.computeBoundingSphere()
    }
    // 4) 应用缩放
    holder.scale.setScalar(scale)
    holder.updateMatrixWorld(true)
    // 5) 落地：按当前姿势的真实最低点贴地
    reground()
    baseHeightM = currentBody.height / 100
    refreshPoseHeight()
    applyCamera()
    dirty = true
  }

  const applyPose = (joints: JointRotations, root?: Vec3): void => {
    currentPose = joints
    if (binding === null) return
    if (root !== undefined && binding.byName.get(BONE.hips) !== undefined) {
      binding.byName.get(BONE.hips)!.position.set(root.x, root.y, root.z)
    }
    applyRigPose(binding, joints)
    reground()
    refreshPoseHeight()
    applyCamera()
    dirty = true
  }

  /**
   * 设置意图目标（内部）：交给求解器，落定前由渲染循环推进 ✓。
   *
   * `reset: true` = 规范复位（切预设 / 大改）；`false` = 保留速度（拖动 → 有惯性 ✓）。
   */
  const applyTargets = (targets: PoseTargets, opts: { reset?: boolean } = {}): void => {
    currentTargets = {
      root: { ...targets.root },
      effectors: Object.fromEntries(
        Object.entries(targets.effectors).map(([k, v]) => [k, { ...v }]),
      ),
      head: targets.head === undefined ? undefined : { ...targets.head },
    }
    if (solver === null) return
    solver.setTargets(currentTargets, opts)
    dirty = true
  }

  const ready = new Promise<void>((resolve, reject) => {
    // 先解析 morph 资产（json + bin → base64），再解码 GLB
    try {
      morphAssets = parseMorphAssets(bytesToBase64(assets.morphJson), bytesToBase64(assets.morphBin))
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    const loader = new GLTFLoader()
    // 显式拷出真正的 ArrayBuffer：TypedArray.buffer 是 ArrayBufferLike（可能含
    // SharedArrayBuffer），而 GLTFLoader.parse 只接受 ArrayBuffer。
    const glbAb = new ArrayBuffer(assets.glb.byteLength)
    new Uint8Array(glbAb).set(assets.glb)
    loader.parse(glbAb, '', (gltf) => {
      try {
        model = gltf.scene
        model.updateMatrixWorld(true)
        // ⚠ 不解挂网格、不改 scale：网格与骨架在 glTF 里是同一空间，装配关系
        //   （蒙皮 inverseBindMatrices）靠这个配对，改层级会破坏蒙皮。
        holder = new THREE.Group()
        holder.name = 'mannequin-holder'
        scene.add(holder)
        holder.add(model)
        holder.updateMatrixWorld(true)
        // 找到蒙皮网格
        const meshes: THREE.Object3D[] = []
        model.traverse((o) => { if ((o as THREE.Mesh).isMesh === true) meshes.push(o) })
        const skinned = meshes.find((m) => (m as THREE.SkinnedMesh).isSkinnedMesh === true)
        if (skinned === undefined) throw new Error('模型里没有蒙皮网格')
        skinMesh = skinned as THREE.SkinnedMesh
        // 素体材质：统一陶土色（去掉可能的贴图）
        for (const m of meshes) {
          const mesh = m as THREE.Mesh
          const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
          if (mat === undefined) continue
          const list = Array.isArray(mat) ? mat : [mat]
          for (const mm of list) {
            const std = mm as THREE.MeshStandardMaterial
            if (std.map !== undefined) std.map = null
            std.color = new THREE.Color(CLAY)
            std.roughness = 0.82
            std.metalness = 0
            std.needsUpdate = true
          }
        }
        binding = bindRig(model)

        // ── 物理求解宿主（issue 005）──
        // 模型**局部空间**（holder 的缩放/落地位移都被 modelInv 消掉），
        // 于是「骨长 / 半轴半径 / 目标坐标」都是体型无关的局部量 ✓。
        {
          const built = createMeshGeometry(model, skinMesh, binding)
          dominantBones = built.dominant
          const host = createSolverHost(built.geom, binding)
          metrics = computeBodyMetrics((name) => built.geom.boneAt(name))
          solver = new PoseSolver(host, { groundY: metrics.groundY })
        }

        // 紧身衣：顶点色涂装（见 suit.ts）。HM08 是裸体网格，参考图喂图片模型
        // 会被安全审查拦截；权重场 + 顶点色渐变随 morph / 姿势天然同步。
        // 裤摆取大腿中点、领口取颈骨 rest 高度（骨架实测，不写死常数）。
        const hipY = binding.restWorld.get('hipL')?.y ?? 0
        const kneeY = binding.restWorld.get('kneeL')?.y ?? 0
        const neckY = binding.restWorld.get('neck')?.y ?? 1.4
        // 紧身衣壳：独立布料层 SkinnedMesh（见 suit.ts）。HM08 是裸体网格，参考图喂
        // 图片模型会被安全审查拦截；壳 = 几何遮挡（非涂装），敏感区无任何肤色像素。
        // 裤摆取大腿中点、领口取颈骨 rest 高度（骨架实测，不写死常数）。
        suitBuild = buildSuit({
          position: skinMesh.geometry.getAttribute('position') as THREE.BufferAttribute,
          normal: skinMesh.geometry.getAttribute('normal') as THREE.BufferAttribute,
          skinIndex: skinMesh.geometry.getAttribute('skinIndex') as THREE.BufferAttribute,
          skinWeight: skinMesh.geometry.getAttribute('skinWeight') as THREE.BufferAttribute,
          boneList: skinMesh.skeleton.bones,
          index: skinMesh.geometry.index?.array ?? [],
          shortsHemY: (hipY + kneeY) / 2,
          necklineY: neckY,
        })
        suitMesh = new THREE.SkinnedMesh(suitBuild.geometry, new THREE.MeshStandardMaterial({
          color: SUIT_COLOR, roughness: SUIT_ROUGHNESS, metalness: 0,
        }))
        suitMesh.name = 'suit'
        suitMesh.bind(skinMesh.skeleton, skinMesh.bindMatrix)
        model.add(suitMesh)

        // 形变基准：从 GLB 顶点反推 MakeHuman base（GLB 米制 ×10 = 分米制）。
        // morph 的顶点索引基于 body 组前 13380 顶点，与 GLB geometry 顺序一致。
        const geom = skinMesh.geometry
        const posAttr = geom.getAttribute('position') as THREE.BufferAttribute
        const skinIndex = geom.getAttribute('skinIndex') as THREE.BufferAttribute
        const skinWeight = geom.getAttribute('skinWeight') as THREE.BufferAttribute
        if (skinIndex === undefined || skinWeight === undefined) {
          throw new Error('模型缺少蒙皮权重属性')
        }
        basePositionM = new Float32Array(posAttr.array as Float32Array)
        basePositionDm = new Float32Array(basePositionM.length)
        for (let i = 0; i < basePositionM.length; i++) basePositionDm[i] = basePositionM[i] * 10

        // 落地候选集：绑定姿态就贴近地面的顶点（脚掌、小腿下段、垂下的手）。
        // 之后姿势怎么变，真正贴地的部位都在这批里；只算一次，换姿势时省 6 倍开销。
        const probePos = geom.getAttribute('position') as THREE.BufferAttribute
        for (let i = 0; i < probePos.count; i++) {
          if (probePos.getY(i) < GROUND_PROBE_MAX_Y) groundProbe.push(i)
        }

        applyBody()
        applyPose(currentPose)
        // 调试出口（实机排查骨架/蒙皮/姿势用；只读引用，无副作用）
        // 姿势相关的是**函数**出口：求解器与目标都是活的，要每次读当前值 ✓
        ;(window as unknown as Record<string, unknown>).__mannequinDebug = {
          model, binding, camera, scene, holder,
          targets: () => (currentTargets === null ? null : JSON.parse(JSON.stringify(currentTargets)) as PoseTargets),
          settled: () => solver?.settled() ?? true,
          mode: () => mode,
          metrics: () => metrics,
          // 实机诊断用：rAF 被节流时手动推求解（页面控制台/自动化探针调）
          forceStep: (substeps?: number) => (solver === null ? null : solver.step(substeps ?? 8)),
        }
        dirty = true
        resolve()
      } catch (e) {
        const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
        reject(new Error(msg))
      }
    }, (err) => reject(err instanceof Error ? err : new Error(String(err))))
  })

  // ── 相机 ─────────────────────────────────────────────────────────────
  const applyCamera = (): void => {
    const pose = computeCameraPose(camState.shot, camState.orbit, poseHeightM)
    camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    camera.fov = pose.fov
    camera.aspect = Math.max(0.1, container.clientWidth / Math.max(1, container.clientHeight))
    camera.updateProjectionMatrix()
    camera.lookAt(pose.target.x, pose.target.y, pose.target.z)
    dirty = true
  }

  const resize = (): void => {
    const w = Math.max(1, container.clientWidth)
    const h = Math.max(1, container.clientHeight)
    renderer.setSize(w, h, false)
    applyCamera()
  }
  const observer = new ResizeObserver(() => { resize() })
  observer.observe(container)
  resize()

  // 按需渲染循环
  let raf = 0
  let lastTickAt = 0
  const tickBody = (): void => {
    lastTickAt = performance.now()
    // 物理推进：没落定就继续走（定步长 → 确定性 ✓）；落定后零开销 ✓
    if (solver !== null && !solver.settled()) {
      const joints = solver.step(8)
      applyPose(joints, currentTargets?.root)
    }
    if (dirty) { renderer.render(scene, camera); dirty = false }
  }
  const tick = (): void => {
    if (disposed) return
    tickBody()
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  // RAF 停摆兜底（2026-11-19 实机）：窗口失焦/被遮挡时 Chromium 暂停 rAF，
  // 求解器跟着停摆，画布**冻在绑定姿态**（HM08 绑定手骨天生弯 ~38°，实机
  // 「弯手」截图即此帧）。定时器兜底接管：rAF 正常时只刷时间戳（零开销），
  // rAF 停了就推进求解 + 补渲染；页面隐藏时定时器被钳到 1s 也能收敛 ✓。
  const fallbackTimer = setInterval(() => {
    if (disposed || performance.now() - lastTickAt < 450) return
    tickBody()
  }, 250)

  // ── 摆姿势：抓肢体拖动 ──
  /** 骨名 → 末端（手臂归手、小腿归脚）。 */
  const BONE_TO_EFFECTOR: Record<string, EndEffectorId> = {
    mixamorigLeftArm: 'handL', mixamorigLeftForeArm: 'handL',
    mixamorigLeftHand: 'handL', mixamorigLeftHandEnd: 'handL',
    mixamorigRightArm: 'handR', mixamorigRightForeArm: 'handR',
    mixamorigRightHand: 'handR', mixamorigRightHandEnd: 'handR',
    mixamorigLeftLeg: 'footL', mixamorigLeftFoot: 'footL', mixamorigLeftToeBase: 'footL',
    mixamorigRightLeg: 'footR', mixamorigRightFoot: 'footR', mixamorigRightToeBase: 'footR',
  }
  /** 屏幕坐标 → NDC。 */
  const toNdc = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect()
    pointerNdc.set(
      ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    )
  }
  /** 拾取末端：射线打蒙皮网格 → 命中面的主导骨 → 最近的末端。 */
  const pickEffector = (e: PointerEvent): { id: EndEffectorId; point: THREE.Vector3 } | null => {
    if (skinMesh === null || model === null) return null
    toNdc(e)
    raycaster.setFromCamera(pointerNdc, camera)
    const hits = raycaster.intersectObject(skinMesh, false)
    if (hits.length === 0) return null
    const hit = hits[0]
    const index = skinMesh.geometry.index
    if (index === null || index === undefined) return null
    const face = Math.floor(hit.faceIndex ?? 0)
    for (let k = 0; k < 3; k++) {
      const vi = index.getX(face * 3 + k)
      const id = BONE_TO_EFFECTOR[dominantBones[vi] ?? '']
      if (id !== undefined) return { id, point: hit.point.clone() }
    }
    return null
  }
  /** 目标（局部空间）→ 世界坐标。 */
  const targetWorld = (id: EndEffectorId): THREE.Vector3 | null => {
    if (model === null || currentTargets === null) return null
    const t = currentTargets.effectors[id]
    if (t === undefined || t.pos === undefined) return null
    return model.localToWorld(new THREE.Vector3(t.pos.x, t.pos.y, t.pos.z))
  }

  // 轨道交互
  let dragging = false
  let lastX = 0
  let lastY = 0
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    if (mode === 'pose') {
      const picked = pickEffector(e)
      if (picked !== null) {
        draggingEnd = picked.id
        // 拖动平面：过拾取点、垂直视线
        const dir = camera.getWorldDirection(new THREE.Vector3())
        dragPlane.setFromNormalAndCoplanarPoint(dir, picked.point)
        // 抓取偏移：不让手在按下瞬间跳一下
        const target = targetWorld(picked.id)
        dragOffset.copy(target ?? picked.point).sub(picked.point)
        canvas.setPointerCapture(e.pointerId)
        dirty = true
        return
      }
    }
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    canvas.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (draggingEnd !== null && currentTargets !== null && model !== null) {
      toNdc(e)
      raycaster.setFromCamera(pointerNdc, camera)
      const hit = new THREE.Vector3()
      if (raycaster.ray.intersectPlane(dragPlane, hit)) {
        hit.add(dragOffset)
        const local = model.worldToLocal(hit.clone())
        const next: PoseTargets = {
          root: { ...currentTargets.root },
          effectors: { ...currentTargets.effectors },
          head: currentTargets.head === undefined ? undefined : { ...currentTargets.head },
        }
        const prev = next.effectors[draggingEnd] ?? {}
        // 拖动改的是「固定位置」：语义锚点让位给手动位置（否则会被锚点拉回）✓
        next.effectors[draggingEnd] = {
          ...prev,
          pos: { x: local.x, y: local.y, z: local.z },
          anchor: undefined,
        }
        applyTargets(next, { reset: false })
      }
      return
    }
    if (!dragging) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    camState.orbit = {
      azimuthDeg: wrapDeg(camState.orbit.azimuthDeg - dx * 0.4),
      elevationDeg: clamp(camState.orbit.elevationDeg + dy * 0.3, -32, 62),
      distanceScale: camState.orbit.distanceScale,
    }
    callbacks.onOrbit?.({ ...camState.orbit })
    applyCamera()
  }
  const onPointerUp = (e: PointerEvent): void => {
    const wasDraggingEnd = draggingEnd
    dragging = false
    draggingEnd = null
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    // 拖完把目标回传（面板滑杆要显示当前值 ✓）
    if (wasDraggingEnd !== null) callbacks.onTargets?.(currentTargets)
  }
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    camState.orbit = {
      azimuthDeg: camState.orbit.azimuthDeg,
      elevationDeg: camState.orbit.elevationDeg,
      distanceScale: clamp(camState.orbit.distanceScale * (1 + e.deltaY * 0.0012), 0.3, 3),
    }
    callbacks.onOrbit?.({ ...camState.orbit })
    applyCamera()
  }
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })

  applyPose(poseJoints('a-pose'))

  return {
    ready,
    setPreciseBody(params: PreciseBodyParams): void {
      currentBody = { ...params }
      applyBody()
    },
    measured(): Array<{ name: string; targetCm: number; measuredCm: number }> {
      return currentMeasured.map((r) => ({ ...r }))
    },
    previewMeasurements(): Record<string, number> {
      return { ...currentPreviews }
    },
    setPose(joints: JointRotations): void {
      applyPose(joints)
    },
    setTargets(targets: PoseTargets, opts?: { reset?: boolean }): void {
      applyTargets(targets, opts ?? {})
    },
    getTargets(): PoseTargets | null {
      return currentTargets === null ? null : JSON.parse(JSON.stringify(currentTargets)) as PoseTargets
    },
    applyPreset(id: string): boolean {
      if (metrics === null) return false
      const t = presetTargets(id, metrics)
      if (t === null) return false
      applyTargets(t, { reset: true })
      return true
    },
    currentJoints(): JointRotations {
      return JSON.parse(JSON.stringify(currentPose)) as JointRotations
    },
    restorePose(joints: JointRotations, targets?: PoseTargets | null): void {
      if (targets !== undefined && targets !== null) {
        // 有意图：按当前体型重解（同一个意图，体型变了姿势也合理地跟着变）
        applyTargets(targets, { reset: true })
        return
      }
      // 无意图（旧档）：钉关节表 —— 求解器要让位，否则下一帧又把它解回去
      currentTargets = null
      solver?.clearTargets()
      applyPose(joints)
    },
    setMode(next: ViewerMode): void {
      mode = next
    },
    settled(): boolean {
      return solver?.settled() ?? true
    },
    setCamera(nextOrbit: OrbitState, nextShot: ShotKind): void {
      camState.orbit = { ...nextOrbit }
      camState.shot = nextShot
      applyCamera()
    },
    bodyHeightM(): number { return baseHeightM },
    bodyMetrics(): BodyMetrics | null { return metrics },
    capture(length: number, ratio: string): string {
      // 离屏成像：临时把 renderer 换到目标尺寸渲一帧再还原（同一上下文，WYSIWYG）
      const viewW = Math.max(1, container.clientWidth)
      const viewH = Math.max(1, container.clientHeight)
      const [rw, rh] = ratio.split(':').map(Number)
      const w = rw >= rh ? length : Math.round((length * rw) / rh)
      const h = rw >= rh ? Math.round((length * rh) / rw) : length
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.render(scene, camera)
      const url = renderer.domElement.toDataURL('image/png')
      renderer.setSize(viewW, viewH, false)
      camera.aspect = viewW / viewH
      camera.updateProjectionMatrix()
      renderer.render(scene, camera)
      dirty = true
      return url
    },
    dispose(): void {
      disposed = true
      cancelAnimationFrame(raf)
      clearInterval(fallbackTimer)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      if (model !== null) {
        model.traverse((obj) => {
          const mesh = obj as THREE.Mesh
          if (mesh.geometry !== undefined) mesh.geometry.dispose()
          const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
          else mat?.dispose()
        })
        scene.remove(model)
        model = null
        binding = null
        skinMesh = null
        suitBuild = null
        suitMesh = null
        morphAssets = null
        basePositionM = null
        basePositionDm = null
      }
      // 调试出口随卸载一起清掉，避免全局引用挂着已释放的模型
      delete (window as unknown as Record<string, unknown>).__mannequinDebug
      studio.dispose()
      renderer.dispose()
      canvas.remove()
    },
  }
}

/**
 * 从蒙皮网格造出求解器要的几何（**模型局部空间**）。
 *
 * 为什么要局部空间：holder 上有身高缩放与落地位移，世界坐标会随体型/姿势漂；
 * 局部空间里「骨长、半轴半径、目标坐标」才是稳定的量 ✓（换体型自动换算 ✓）。
 */
function createMeshGeometry(
  model: THREE.Group,
  skin: THREE.SkinnedMesh,
  binding: RigBinding,
): { geom: MannequinGeometry; dominant: string[] } {
  const geom = skin.geometry
  const posAttr = geom.getAttribute('position') as THREE.BufferAttribute
  const norAttr = geom.getAttribute('normal') as THREE.BufferAttribute
  const skinIndex = geom.getAttribute('skinIndex') as THREE.BufferAttribute
  const skinWeight = geom.getAttribute('skinWeight') as THREE.BufferAttribute
  const boneList = skin.skeleton.bones
  const bindPositions = new Float32Array(posAttr.array as Float32Array)
  const bindNormals = new Float32Array(norAttr.array as Float32Array)
  const dominant: string[] = new Array(posAttr.count)
  const dominantW: number[] = new Array(posAttr.count)
  for (let i = 0; i < posAttr.count; i++) {
    let bw = 0
    let bj = 0
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k)
      if (w > bw) { bw = w; bj = skinIndex.getComponent(i, k) }
    }
    dominant[i] = boneList[bj]?.name ?? ''
    dominantW[i] = bw
  }
  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  const modelInv = new THREE.Matrix4()
  const boneMats: THREE.Matrix4[] = []
  const geom2: MannequinGeometry = {
    boneAt: (name: string) => {
      const bone = binding.byName.get(name)
      if (bone === undefined) return new THREE.Vector3()
      return model.worldToLocal(bone.getWorldPosition(new THREE.Vector3()))
    },
    boneQuat: (name: string) => {
      const bone = binding.byName.get(name)
      if (bone === undefined) return undefined
      bone.updateWorldMatrix(true, false)
      return bone.getWorldQuaternion(new THREE.Quaternion())
    },
    boneParentQuat: (name: string) => {
      const bone = binding.byName.get(name)
      if (bone === undefined || bone.parent === null) return new THREE.Quaternion()
      bone.parent.updateWorldMatrix(true, false)
      return bone.parent.getWorldQuaternion(new THREE.Quaternion())
    },
    bindBoneAt: (name: string) => {
      const bone = binding.byName.get(name)
      if (bone === undefined) return new THREE.Vector3()
      return model.worldToLocal(bone.getWorldPosition(new THREE.Vector3()))
    },
    vertexCount: posAttr.count,
    bindPositions,
    bindNormals,
    dominantBone: (i: number) => dominant[i] ?? '',
    dominantWeight: (i: number) => dominantW[i] ?? 0,
    applyPose: (joints, root, verts) => {
      const hips = binding.byName.get(BONE.hips)
      if (hips !== undefined) hips.position.set(root.x, root.y, root.z)
      applyRigPose(binding, joints)
      model.updateMatrixWorld(true)
      modelInv.copy(model.matrixWorld).invert()
      // 骨骼矩阵（模型局部空间）：modelInv · boneWorld · boneInverse
      boneMats.length = 0
      for (let b = 0; b < boneList.length; b++) {
        boneMats.push(new THREE.Matrix4()
          .multiplyMatrices(modelInv, boneList[b].matrixWorld)
          .multiply(skin.skeleton.boneInverses[b]))
      }
      const out = new Float32Array(verts.length * 3)
      for (let k = 0; k < verts.length; k++) {
        const i = verts[k]
        const px = bindPositions[i * 3], py = bindPositions[i * 3 + 1], pz = bindPositions[i * 3 + 2]
        let x = 0, y = 0, z = 0
        for (let b = 0; b < 4; b++) {
          const w = skinWeight.getComponent(i, b)
          if (w === 0) continue
          const bi = skinIndex.getComponent(i, b)
          const mat = boneMats[bi]
          if (mat === undefined) continue
          m.copy(mat)
          v.set(px, py, pz).applyMatrix4(m)
          x += w * v.x; y += w * v.y; z += w * v.z
        }
        out[k * 3] = x; out[k * 3 + 1] = y; out[k * 3 + 2] = z
      }
      return out
    },
  }
  return { geom: geom2, dominant }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function wrapDeg(d: number): number {
  return ((d % 360) + 360) % 360
}

/** 字节 → base64（浏览器 btoa，供 parseMorphAssets 复用）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

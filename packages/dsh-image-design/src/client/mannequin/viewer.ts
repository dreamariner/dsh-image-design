// 素体视口：真人素体（MakeHuman 基础网格 + 自建骨架的蒙皮人偶，GLB 内联）
// + 交互轨道 + 体型形变 + 姿势应用 + 拍摄导出。
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
import { MANNEQUIN_GLB_BASE64 } from '../generated/mannequin-glb.ts'
import { BONE, lengthTunes, positionTunes, type BodyParams } from './body.ts'
import { bindRig, applyRigPose, type RigBinding } from './rig.ts'
import { applyShape, type ShapeContext } from './shape.ts'
import { buildStudio } from './capture.ts'
import { computeCameraPose, type OrbitState, type ShotKind } from './camera.ts'
import { poseJoints, type JointRotations } from './poses.ts'

export interface Viewer {
  /** GLB 解码 + 骨架绑定完成（失败时 reject，UI 落错误态）。 */
  ready: Promise<void>
  setBody(params: BodyParams): void
  setPose(joints: JointRotations): void
  setCamera(orbit: OrbitState, shot: ShotKind): void
  /** 模型实测身高（m，加载后可得），相机与构图的基准。 */
  bodyHeightM(): number
  /** 离屏拍摄（独立于视口分辨率的干净成像）。 */
  capture(length: number, ratio: string): string
  dispose(): void
}

export interface ViewerCallbacks {
  /** 拖拽 / 滚轮导致的 orbit 变化（组件写回 store）。 */
  onOrbit?: (orbit: OrbitState) => void
}

/** 素体陶土色（素体语义：裸体、无服装无特征的灰模）。 */
const CLAY = 0xb9bdc6

/** 脚掌离脚趾骨的厚度（m）：脚底贴地时用它把模型垫到地面。 */
const SOLE_DROP = 0.035

/** glb base64 → 字节（浏览器全局 atob）。 */
function glbBytes(): ArrayBuffer {
  const bin = atob(MANNEQUIN_GLB_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

/** 相机状态（orbit 由交互/预设驱动，shot 由景别预设驱动）。 */
interface CamState {
  orbit: OrbitState
  shot: ShotKind
}

export function createViewer(
  container: HTMLDivElement,
  bodyParams: BodyParams,
  orbit: OrbitState,
  shot: ShotKind,
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
  let shapeCtx: ShapeContext | null = null
  let baseHeightM = 1.68
  let currentBody: BodyParams = { ...bodyParams }
  let currentPose: JointRotations = {}

  /** 体型落地：网格形变（围度）+ 骨链长度（臂长腿长）+ 落地与整体缩放。 */
  const applyBody = (): void => {
    if (model === null || holder === null || binding === null || skinMesh === null || shapeCtx === null) return
    // 1) 围度类：绑定姿态网格形变（蒙皮权重混合，接缝自然）
    applyShape(skinMesh.geometry, shapeCtx, currentBody)
    skinMesh.geometry.computeBoundingSphere()
    // 2) 肩宽：上臂关节横向外移（手臂整条跟着外移）
    for (const [boneName, delta] of Object.entries(positionTunes(currentBody))) {
      const bone = binding.byName.get(boneName)
      const rest = binding.boneRestLocal.get(boneName)
      if (bone === undefined || rest === undefined) continue
      bone.position.set(rest.x + delta[0], rest.y + delta[1], rest.z + delta[2])
      bone.updateMatrix()
    }
    // 3) 臂长 / 腿长：缩放子骨的局部位移（关节跟着走，长度真的变）
    for (const [boneName, k] of Object.entries(lengthTunes(currentBody))) {
      const bone = binding.byName.get(boneName)
      const rest = binding.boneRestLocal.get(boneName)
      if (bone === undefined || rest === undefined) continue
      if (rest.lengthSq() < 1e-10) continue
      bone.position.copy(rest).multiplyScalar(k)
      bone.updateMatrix()
    }
    binding.bones.forEach((bone) => { bone.updateWorldMatrix(true, false) })
    // 4) 落地 + 整体缩放到目标身高
    //    ⚠ 身高要按**姿势无关**的静止位姿量：直接用骨的世界矩阵的话，弯腰时
    //    头顶会变低，模型会跟着姿势忽大忽小。
    holder.scale.setScalar(1)
    holder.position.set(0, 0, 0)
    const rest = tunedRestWorld(binding, currentBody)
    const toe = rest.get(BONE.toeL)
    const headTop = rest.get(BONE.headTop)
    const head = rest.get(BONE.head)
    const footY = toe !== undefined ? toe.y - SOLE_DROP : 0
    let headY = headTop?.y ?? baseHeightM
    if (head !== undefined && headTop !== undefined) {
      // 头身比会等比放大头骨，颅顶也跟着长
      const headK = 7.5 / clamp(currentBody.headRatio, 5, 10)
      headY = head.y + (headTop.y - head.y) * headK
    }
    const localHeight = Math.max(0.5, headY - footY)
    const scale = (currentBody.height / 100) / localHeight
    holder.scale.setScalar(scale)
    holder.position.y = -scale * footY
    holder.updateMatrixWorld(true)
    baseHeightM = currentBody.height / 100
    dirty = true
  }

  const applyPose = (joints: JointRotations): void => {
    currentPose = joints
    if (binding === null) return
    applyRigPose(binding, joints)
    dirty = true
  }

  const ready = new Promise<void>((resolve, reject) => {
    const loader = new GLTFLoader()
    loader.parse(glbBytes(), '', (gltf) => {
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

        // 形变上下文：绑定姿态顶点 + 蒙皮权重 + 骨心
        const geom = skinMesh.geometry
        const posAttr = geom.getAttribute('position') as THREE.BufferAttribute
        const skinIndex = geom.getAttribute('skinIndex') as THREE.BufferAttribute
        const skinWeight = geom.getAttribute('skinWeight') as THREE.BufferAttribute
        if (skinIndex === undefined || skinWeight === undefined) {
          throw new Error('模型缺少蒙皮权重属性')
        }
        const boneIndex = new Map<string, number>()
        skinMesh.skeleton.bones.forEach((b, i) => { boneIndex.set(b.name.replace(/:/g, ''), i) })
        shapeCtx = {
          base: new Float32Array(posAttr.array as Float32Array),
          joints: new Uint16Array(skinIndex.array as Uint16Array),
          weights: new Float32Array(skinWeight.array as Float32Array),
          boneIndex,
          boneWorld: binding.boneRest,
        }

        applyBody()
        applyPose(currentPose)
        // 调试出口（实机排查骨架/蒙皮用；只读引用，无副作用）
        ;(window as unknown as Record<string, unknown>).__mannequinDebug = { model, binding, camera, scene, holder }
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
    const pose = computeCameraPose(camState.shot, camState.orbit, baseHeightM)
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
  const tick = (): void => {
    if (disposed) return
    if (dirty) { renderer.render(scene, camera); dirty = false }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  // 轨道交互
  let dragging = false
  let lastX = 0
  let lastY = 0
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    canvas.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent): void => {
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
    dragging = false
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
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
    setBody(params: BodyParams): void {
      currentBody = { ...params }
      applyBody()
    },
    setPose(joints: JointRotations): void {
      applyPose(joints)
    },
    setCamera(nextOrbit: OrbitState, nextShot: ShotKind): void {
      camState.orbit = { ...nextOrbit }
      camState.shot = nextShot
      applyCamera()
    },
    bodyHeightM(): number { return baseHeightM },
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
        shapeCtx = null
      }
      // 调试出口随卸载一起清掉，避免全局引用挂着已释放的模型
      delete (window as unknown as Record<string, unknown>).__mannequinDebug
      studio.dispose()
      renderer.dispose()
      canvas.remove()
    },
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function wrapDeg(d: number): number {
  return ((d % 360) + 360) % 360
}

/**
 * 姿势无关的「调型后静止位姿」世界坐标（骨名 → 世界位置）。
 *
 * 为什么不能直接用骨的世界矩阵：那是**当前姿势**下的位置（弯腰时头顶会低），
 * 拿来量身高会让模型随姿势忽大忽小。这里按「绑定姿态 + 骨链长度 / 肩宽位移」
 * 自己算一遍。
 */
function tunedRestWorld(binding: RigBinding, params: BodyParams): Map<string, THREE.Vector3> {
  const posTunes = positionTunes(params)
  const lenTunes = lengthTunes(params)
  const out = new Map<string, THREE.Vector3>()
  const worldOf = (bone: THREE.Object3D): THREE.Vector3 => {
    const cached = out.get(bone.name)
    if (cached !== undefined) return cached
    const rest = binding.boneRestLocal.get(bone.name) ?? bone.position.clone()
    const local = rest.clone()
    const delta = posTunes[bone.name]
    if (delta !== undefined) local.set(local.x + delta[0], local.y + delta[1], local.z + delta[2])
    const k = lenTunes[bone.name]
    if (k !== undefined && local.lengthSq() > 1e-10) local.multiplyScalar(k)
    const parent = bone.parent
    const parentBone = parent !== null && binding.byName.has(parent.name) ? parent : null
    const world = parentBone === null ? local.clone() : worldOf(parentBone).clone().add(local)
    out.set(bone.name, world)
    return world
  }
  for (const bone of binding.byName.values()) worldOf(bone)
  return out
}

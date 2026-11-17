// 素体视口：Xbot 蒙皮人偶（GLB 内联）装配 + 交互轨道 + 参数热更新 + 拍摄导出。
//
// 生命周期：createViewer（挂载）→ ready（GLB 解码 + 骨架绑定）→
// setBody / setPose / setCamera（状态驱动）→ dispose（卸载）。
// ready 前的 setBody / setPose 调用缓存，加载完成后统一生效。
// 渲染按需（dirty 标记 + rAF），不做持续重绘。
//
// 交互：左键拖拽 = 方位/仰角，滚轮 = 推拉（写回 orbit 状态，经 onOrbit 回调
// 通知 React store —— 状态单源在 store，viewer 只做映射与渲染）。

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MANNEQUIN_GLB_BASE64 } from '../generated/mannequin-glb.ts'
import { boneTunes, BONE, type BodyParams } from './body.ts'
import { bindRig, applyRigPose, type RigBinding } from './rig.ts'
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

/** 素体陶土色（与旧程序化版一致，语义=无服装无特征的裸体素体）。 */
const CLAY = 0xb9bdc6

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
  let baseHeightM = 1.8
  let currentBody: BodyParams = { ...bodyParams }
  let currentPose: JointRotations = {}

  const applyBodyTunes = (): void => {
    if (model === null || holder === null) return
    holder.scale.setScalar((currentBody.height / 100) / baseHeightM)
    // ⚠ glTF 节点默认 matrixAutoUpdate = false：改 scale 不重算 matrix 就不会生效
    holder.matrixAutoUpdate = true
    holder.updateMatrix()
    const byName = new Map<string, THREE.Object3D>()
    model.traverse((obj) => { if (obj.name !== '') byName.set(obj.name.replace(/:/g, ''), obj) })
    for (const tune of boneTunes(currentBody)) {
      const bone = byName.get(tune.bone)
      if (bone === undefined) continue
      bone.matrixAutoUpdate = true
      if (tune.scale !== undefined) bone.scale.set(...tune.scale)
      if (tune.position !== undefined) {
        bone.userData.restX ??= bone.position.x
        bone.userData.restY ??= bone.position.y
        bone.userData.restZ ??= bone.position.z
        bone.position.x = (bone.userData.restX as number) + tune.position[0]
        bone.position.y = (bone.userData.restY as number) + tune.position[1]
        bone.position.z = (bone.userData.restZ as number) + tune.position[2]
      }
      bone.updateMatrix()
    }
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
        // ⚠ 不解挂网格、不改 scale：Mixamo 的网格几何是米级、骨架是厘米级，
        //   靠 Armature 的 0.01 与 skin 的 inverseBindMatrices（厘米空间）配对，
        //   蒙皮时自动抵消。任何「给网格补 scale / 换父节点」的操作都会破坏配对
        //   （2026-11-17 实测事故）。
        holder = new THREE.Group()
        holder.name = 'mannequin-holder'
        scene.add(holder)
        holder.add(model)
        holder.updateMatrixWorld(true)
        const meshes: THREE.Object3D[] = []
        model.traverse((o) => { if ((o as THREE.Mesh).isMesh === true) meshes.push(o) })
        // 素体材质：去掉原模型贴图（带服装色块），统一陶土色（素体语义）
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
        // 身高基准：用骨架地标（骨骼在 Armature 0.01 下已是米级）；
        // 网格的 CPU 侧坐标是未蒙皮的 bind 姿态，量不出真实身高。
        const headBone = model.getObjectByName('mixamorigHead')
        const footBone = model.getObjectByName('mixamorigLeftFoot')
        if (headBone !== undefined && footBone !== undefined) {
          const hy = headBone.getWorldPosition(new THREE.Vector3()).y
          const fy = footBone.getWorldPosition(new THREE.Vector3()).y
          baseHeightM = Math.max(0.5, (hy - fy) * 1.14 + 0.06)
        } else {
          const box = new THREE.Box3().setFromObject(holder)
          baseHeightM = Math.max(0.5, box.max.y - box.min.y)
        }
        binding = bindRig(model)
        applyBodyTunes()
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
      applyBodyTunes()
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

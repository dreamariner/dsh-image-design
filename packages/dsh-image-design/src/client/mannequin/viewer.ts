// 素体视口：three.js 场景装配 + 交互轨道 + 参数热更新 + 拍摄导出。
//
// 生命周期：createViewer（挂载）→ setBody / setPose / setCamera（状态驱动）
// → dispose（卸载）。渲染按需（dirty 标记 + rAF），不做持续重绘。
//
// 交互：左键拖拽 = 方位/仰角，滚轮 = 推拉（写回 orbit 状态，经 onOrbit 回调
// 通知 React store —— 状态单源在 store，viewer 只做映射与渲染）。

import * as THREE from 'three'
import { buildBody, type BodyParams, type JointName } from './body.ts'
import { buildStudio } from './capture.ts'
import { computeCameraPose, type OrbitState, type ShotKind } from './camera.ts'
import type { JointRotations } from './poses.ts'

export interface Viewer {
  setBody(params: BodyParams): void
  setPose(joints: JointRotations): void
  setCamera(orbit: OrbitState, shot: ShotKind): void
  /** 当前素体身高（m），相机与构图的基准。 */
  bodyHeightM(): number
  /** 离屏拍摄（独立于视口分辨率的干净成像）。 */
  capture(length: number, ratio: string): string
  dispose(): void
}

export interface ViewerCallbacks {
  /** 拖拽 / 滚轮导致的 orbit 变化（组件写回 store）。 */
  onOrbit?: (orbit: OrbitState) => void
}

export function createViewer(
  container: HTMLDivElement,
  bodyParams: BodyParams,
  orbit: OrbitState,
  shot: ShotKind,
  callbacks: ViewerCallbacks = {},
): Viewer {
  const studio = buildStudio()
  let body = buildBody(bodyParams)
  studio.scene.add(body.root)

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

  let dirty = true
  let disposed = false
  let currentOrbit: OrbitState = { ...orbit }
  let currentShot: ShotKind = shot

  const applyCamera = (): void => {
    const pose = computeCameraPose(currentShot, currentOrbit, body.landmarks.h)
    camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    camera.fov = pose.fov
    camera.aspect = Math.max(0.1, container.clientWidth / Math.max(1, container.clientHeight))
    camera.updateProjectionMatrix()
    camera.lookAt(pose.target.x, pose.target.y, pose.target.z)
    dirty = true
  }

  const applyPose = (joints: JointRotations): void => {
    for (const [name, group] of Object.entries(body.joints)) {
      const r = joints[name] ?? { x: 0, y: 0, z: 0 }
      group.rotation.set(r.x, r.y, r.z)
    }
    dirty = true
  }

  // 尺寸跟随容器
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
    if (dirty) { renderer.render(studio.scene, camera); dirty = false }
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
    currentOrbit = {
      ...currentOrbit,
      azimuthDeg: wrapDeg(currentOrbit.azimuthDeg - dx * 0.4),
      elevationDeg: clamp(currentOrbit.elevationDeg + dy * 0.3, -32, 62),
    }
    callbacks.onOrbit?.({ ...currentOrbit })
    applyCamera()
  }
  const onPointerUp = (e: PointerEvent): void => {
    dragging = false
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
  }
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    currentOrbit = { ...currentOrbit, distanceScale: clamp(currentOrbit.distanceScale * (1 + e.deltaY * 0.0012), 0.3, 3) }
    callbacks.onOrbit?.({ ...currentOrbit })
    applyCamera()
  }
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })

  applyPose({})

  return {
    setBody(params: BodyParams): void {
      studio.scene.remove(body.root)
      body.dispose()
      body = buildBody(params)
      studio.scene.add(body.root)
      applyPose({})
      applyCamera()
    },
    setPose(joints: JointRotations): void { applyPose(joints) },
    setCamera(nextOrbit: OrbitState, nextShot: ShotKind): void {
      currentOrbit = { ...nextOrbit }
      currentShot = nextShot
      applyCamera()
    },
    bodyHeightM(): number { return body.landmarks.h },
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
      renderer.render(studio.scene, camera)
      const url = renderer.domElement.toDataURL('image/png')
      renderer.setSize(viewW, viewH, false)
      camera.aspect = viewW / viewH
      camera.updateProjectionMatrix()
      renderer.render(studio.scene, camera)
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
      body.dispose()
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

// 保留类型引用（poses 的关节表以名字寻址，类型侧只依赖 JointName 存在）
export type { JointName }

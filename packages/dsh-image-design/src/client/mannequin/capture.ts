// 素体棚拍场景：灯位 / 地面 / 背景的一次性构建 + 离屏导出。
//
// 「干净参考图」语义：浅中性灰背景、三点柔光、地面接触阴影，无任何陈设。
// 视口与导出共用同一个 scene（所见即所得）；导出走独立的离屏 renderer
// （preserveDrawingBuffer 保证 toDataURL 拿得到帧）。

import * as THREE from 'three'

export interface Studio {
  scene: THREE.Scene
  ground: THREE.Mesh
  dispose: () => void
}

const BG = 0xe8eaee
const GROUND_COLOR = 0xd6d9de

export function buildStudio(): Studio {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BG)

  // 三点柔光：主光（右前上）+ 补光（左前，弱）+ 逆光（背后，勾轮廓）
  const key = new THREE.DirectionalLight(0xffffff, 2.4)
  key.position.set(2.2, 3.2, 2.6)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.near = 0.5
  key.shadow.camera.far = 12
  key.shadow.camera.left = -2.5
  key.shadow.camera.right = 2.5
  key.shadow.camera.top = 3
  key.shadow.camera.bottom = -1
  key.shadow.bias = -0.0005
  scene.add(key)

  const fill = new THREE.DirectionalLight(0xffffff, 0.9)
  fill.position.set(-2.6, 2.0, 1.8)
  scene.add(fill)

  const rim = new THREE.DirectionalLight(0xffffff, 1.1)
  rim.position.set(0.4, 2.4, -3.0)
  scene.add(rim)

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8f939b, 0.65)
  scene.add(hemi)

  // 地面：浅灰圆盘（receiveShadow）+ 极淡网格环，仅给构图一个地平参照
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2.6, 48),
    new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 0.95, metalness: 0 }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 0.735, 64),
    new THREE.MeshBasicMaterial({ color: 0xc0c4cb, side: THREE.DoubleSide }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.002
  scene.add(ring)

  return {
    scene,
    ground,
    dispose: () => {
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry !== undefined) mesh.geometry.dispose()
        const m = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else if (m !== undefined) m.dispose()
      })
    },
  }
}

/** 拍摄分辨率档：长边 px。 */
export const CAPTURE_LENGTHS = [1024, 1536, 2048] as const
/** 拍摄比例档（宽:高）。 */
export const CAPTURE_RATIOS = ['1:1', '2:3', '3:4', '9:16'] as const

export type CaptureLength = (typeof CAPTURE_LENGTHS)[number]
export type CaptureRatio = (typeof CAPTURE_RATIOS)[number]

export function captureSize(length: CaptureLength, ratio: CaptureRatio): { width: number; height: number } {
  const [rw, rh] = ratio.split(':').map(Number)
  if (rw >= rh) return { width: length, height: Math.round((length * rh) / rw) }
  return { width: Math.round((length * rw) / rh), height: length }
}

let captureRenderer: THREE.WebGLRenderer | null = null

/**
 * 离屏渲染一帧 PNG dataUrl。复用同一个离屏 renderer（多次拍摄不重建上下文），
 * 渲完立刻读帧（preserveDrawingBuffer: true）。
 */
export function capturePngDataUrl(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  size: { width: number; height: number },
): string {
  if (captureRenderer === null) {
    captureRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false })
    captureRenderer.shadowMap.enabled = true
    captureRenderer.shadowMap.type = THREE.PCFSoftShadowMap
  }
  captureRenderer.setSize(size.width, size.height, false)
  captureRenderer.render(scene, camera)
  return captureRenderer.domElement.toDataURL('image/png')
}

/** 释放离屏 renderer（面板卸载时调用；不调也只占一个闲置上下文）。 */
export function disposeCaptureRenderer(): void {
  captureRenderer?.dispose()
  captureRenderer = null
}

// 素体拍摄相机：景别 × 方位 × 俯仰 预设 + 最小轨道状态。
//
// 纯函数给位姿（可单测）；组件把位姿套到 THREE.PerspectiveCamera 上，
// 拖拽 / 滚轮改 orbit 状态后重算（预设只是 orbit 状态的初始值，拍完钉进 ref.json）。

export type ShotKind = 'full' | 'threeQuarter' | 'half' | 'closeup'
export type AzimuthKind = 'front' | 'quarter' | 'side' | 'back'
export type ElevationKind = 'level' | 'high' | 'low'

export interface ShotPreset {
  /** 相机距离 = 距离系数 × 身高（m）。 */
  distanceFactor: number
  /** 注视点高度 = 系数 × 身高。 */
  targetYFactor: number
}

export const SHOTS: Record<ShotKind, ShotPreset> = {
  full: { distanceFactor: 1.9, targetYFactor: 0.5 },
  threeQuarter: { distanceFactor: 1.25, targetYFactor: 0.72 },
  half: { distanceFactor: 0.82, targetYFactor: 0.76 },
  closeup: { distanceFactor: 0.46, targetYFactor: 0.9 },
}

export const AZIMUTHS: Record<AzimuthKind, number> = {
  front: 0, quarter: 32, side: 90, back: 180,
}

export const ELEVATIONS: Record<ElevationKind, number> = {
  level: 0, high: 14, low: -10,
}

/** 轨道状态（预设写入，拖拽 / 滚轮修改；拍参考图时原样钉进 ref.json）。 */
export interface OrbitState {
  /** 方位角（度，0 = 正面）。 */
  azimuthDeg: number
  /** 仰角（度，正 = 相机高于注视点向下看）。 */
  elevationDeg: number
  /** 距离缩放（1 = 预设距离）。 */
  distanceScale: number
}

export const DEFAULT_ORBIT: OrbitState = { azimuthDeg: 0, elevationDeg: 0, distanceScale: 1 }

export interface CameraPose {
  position: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
  fov: number
}

const deg2rad = (d: number): number => (d * Math.PI) / 180

/**
 * 位姿计算：景别给基准距离与注视点，orbit 覆盖角度与距离缩放。
 * 球坐标绕注视点转：方位角绕 y 轴（0 = 正面），仰角抬相机高度。
 *
 * ⚠ 正面方位 = 相机在 **+z**：Xbot 角色的前方是 +z（实测脚尖方向 +z、跑姿膝盖
 *   前伸 +z），正面机位必须站到角色面朝的一侧，否则拍到背面（2026-11-17 实机事故）。
 */
export function computeCameraPose(shot: ShotKind, orbit: OrbitState, bodyHeightM: number): CameraPose {
  const preset = SHOTS[shot]
  const targetY = preset.targetYFactor * bodyHeightM
  const distance = preset.distanceFactor * bodyHeightM * orbit.distanceScale
  const az = deg2rad(orbit.azimuthDeg)
  const el = deg2rad(orbit.elevationDeg)
  // 球坐标：方位绕 y 轴（0 = +z 正面），仰角抬相机
  const x = distance * Math.sin(az) * Math.cos(el)
  const z = distance * Math.cos(az) * Math.cos(el)
  const y = targetY + distance * Math.sin(el)
  return {
    position: { x, y: Math.max(0.05, y), z },
    target: { x: 0, y: targetY, z: 0 },
    fov: 32,
  }
}

/** 预设一键复位（景别 + 方位 + 俯仰 → orbit 状态）。 */
export function presetOrbit(shot: ShotKind, azimuth: AzimuthKind, elevation: ElevationKind): OrbitState {
  return { azimuthDeg: AZIMUTHS[azimuth], elevationDeg: ELEVATIONS[elevation], distanceScale: 1 }
}

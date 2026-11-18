// 客户端共享状态：手写的极小 observable store + useSyncExternalStore（React 18 内置），
// 不引第三方状态库（media-platforms 同款范式）。
//
// 刻意不做持久化：表单与视图是会话内的编辑态；生成结果已在宿主侧落盘归档，
// 历史经 Remote 随取随回。

import { useSyncExternalStore } from 'react'
import type { RefSummaryView, RunSummaryView, RunView } from './api.ts'
import { DEFAULT_BREAST, DEFAULT_MACRO, type PreciseBodyParams } from './mannequin/shape3.ts'
import type { OrbitState, ShotKind } from './mannequin/camera.ts'
import type { CaptureLength, CaptureRatio } from './mannequin/capture.ts'
import type { EndEffectorId, PoseTargets } from './mannequin/solver.ts'

export type PanelTab = 'generate' | 'mannequin' | 'history'

/** 表单态（字符串留给输入框的自由度，发送时才转数值并校验）。 */
export interface FormState {
  model: 'image-01' | 'MiniMax-H3-Image'
  prompt: string
  /** 尺寸模式：比例档 / H3 精确尺寸 / image-01 像素宽高。 */
  sizeMode: 'aspect' | 'exact' | 'pixels'
  aspectRatio: string
  area: '1K' | '2K' | '4K'
  /** H3 精确尺寸（WxH 文本）。 */
  size: string
  /** image-01 像素宽高（文本）。 */
  width: string
  height: string
  n: number
  /** image-01 随机种子（空 = 不传）。 */
  seed: string
  promptOptimizer: boolean
  /** H3 提示词增强（默认开）。 */
  promptEnhance: boolean
  aigcWatermark: boolean
  /** image-01 主体参考图路径。 */
  subjectRefImage: string
  /** H3 参考图路径列表。 */
  refImages: string[]
}

export interface LightboxState {
  url: string
  alt: string
}

/** 测量回显（目标 vs 实测）。 */
export interface MeasureEcho {
  name: string
  targetCm: number
  measuredCm: number
}

/** 素体视图状态（精确体型 / 姿势 / 相机 / 拍摄档位 / 参考图列表）。 */
export interface MannequinState {
  /** 精确素体参数（20 项 cm + 雕刻 + 宏观 + 身高）。 */
  precise: PreciseBodyParams
  /** 最近一次求解的测量实测回显。 */
  measured: MeasureEcho[]
  poseId: string
  /** 视口交互模式：转视角 / 摆姿势（issue 005）。 */
  mode: 'orbit' | 'pose'
  /** 意图目标（物理求解器的输入）：手/脚该在哪。手调后 poseId 置 'unknown'。 */
  targets: PoseTargets | null
  /** 面板里当前选中的末端（调目标用）。 */
  selectedEnd: EndEffectorId
  shot: ShotKind
  orbit: OrbitState
  length: CaptureLength
  ratio: CaptureRatio
  capturing: boolean
  /** 素体 GLB 异步加载完成（加载中禁拍）。 */
  modelReady: boolean
  refs: RefSummaryView[]
  refsLoading: boolean
  /** `${refId}/${file}` → blob URL。 */
  refUrls: Record<string, string>
  /** refId → 落盘绝对路径（拍摄时 saveRefShot 返回，给「用作生成参考图」用）。 */
  refAbsPaths: Record<string, string>
}

export interface ClientState {
  tab: PanelTab
  form: FormState
  /** 生成进行中（一次只允许一轮在面板上等待）。 */
  busy: boolean
  startedAt: number | null
  /** 走过整轮的错误信息（表单校验失败、RPC 失败等）。 */
  error: string
  /** 当前展示的一轮。 */
  run: RunView | null
  history: RunSummaryView[]
  /** `${runId}/${file}` → blob URL（本轮会话内缓存）。 */
  urls: Record<string, string>
  /** 读图失败的键集合（`${runId}/${file}`），显示占位而不是反复重试。 */
  broken: Record<string, true>
  /** 待对比的图片键（`${runId}/${file}`，2..4 张）。 */
  selection: string[]
  compareOpen: boolean
  lightbox: LightboxState | null
  /** 历史加载中。 */
  historyLoading: boolean
  /** 秒级心跳（busy 时驱动耗时显示）。 */
  now: number
  /** 素体视图切片。 */
  man: MannequinState
}

export function initialForm(): FormState {
  return {
    model: 'image-01',
    prompt: '',
    sizeMode: 'aspect',
    aspectRatio: '1:1',
    area: '2K',
    size: '',
    width: '1024',
    height: '1024',
    n: 1,
    seed: '',
    promptOptimizer: false,
    promptEnhance: true,
    aigcWatermark: false,
    subjectRefImage: '',
    refImages: [],
  }
}

function initialState(): ClientState {
  return {
    tab: 'generate',
    form: initialForm(),
    busy: false,
    startedAt: null,
    error: '',
    run: null,
    history: [],
    urls: {},
    broken: {},
    selection: [],
    compareOpen: false,
    lightbox: null,
    historyLoading: false,
    now: Date.now(),
    man: {
      precise: {
        height: 170,
        measurementsCm: {},
        sculpt: {},
        macro: { ...DEFAULT_MACRO },
        breast: { ...DEFAULT_BREAST },
      },
      measured: [],
      poseId: 'a-pose',
      mode: 'orbit',
      targets: null,
      selectedEnd: 'handL',
      shot: 'full',
      orbit: { azimuthDeg: 0, elevationDeg: 0, distanceScale: 1 },
      length: 1024,
      ratio: '2:3',
      capturing: false,
      modelReady: false,
      refs: [],
      refsLoading: false,
      refUrls: {},
      refAbsPaths: {},
    },
  }
}

let state: ClientState = initialState()
const listeners = new Set<() => void>()

export function getState(): ClientState {
  return state
}

export function setState(patch: Partial<ClientState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

export function patchForm(patch: Partial<FormState>): void {
  setState({ form: { ...getState().form, ...patch } })
}

/** 素体切片的定向更新（浅合并）。 */
export function patchMan(patch: Partial<MannequinState>): void {
  setState({ man: { ...getState().man, ...patch } })
}

export function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** React Hook：只在渲染期可调（事件处理器里读状态用 getState()）。 */
export function useClientState(): ClientState {
  return useSyncExternalStore(subscribe, getState)
}

export function resetState(): void {
  state = initialState()
  for (const l of listeners) l()
}

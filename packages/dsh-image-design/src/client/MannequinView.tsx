// 精确素体视图：cm 测量 + 局部雕刻 + 脸/手 + 姿势 + 机位 + 拍摄 + 参考图列表。
//
// 004 重做：体型从 003 的 9 滑杆解析场换成 MakeHuman morph + 人体测量求解。
// 资产走 host 的 readAsset Remote（client 单文件 bundle 无相对资源 URL）。
// 闭环沿用 003：拍摄 → saveRefShot 钉死参数 → 「用作参考图」进 H3 refImages。

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './ui/button.tsx'
import { Select } from './ui/select.tsx'
import { SegmentedControl } from './ui/segmented-control.tsx'
import { Slider } from './ui/slider.tsx'
import { Spinner } from './ui/spinner.tsx'
import { Tag } from './ui/tag.tsx'
import { Empty, EmptyDescription, EmptyTitle } from './ui/empty.tsx'
import { IconCloseOutlineRegular } from './ui/icons.tsx'
import { getState, patchForm, patchMan, setState, useClientState } from './state.ts'
import { POSES } from './mannequin/poses.ts'
import { type ShotKind } from './mannequin/camera.ts'
import { CAPTURE_LENGTHS, CAPTURE_RATIOS, type CaptureLength, type CaptureRatio } from './mannequin/capture.ts'
import { createViewer, type Viewer, type ViewerAssets, BODY_GLB_FILE, MORPH_BIN_FILE, MORPH_MANIFEST_FILE } from './mannequin/viewer.ts'
import { fromRefTargets, toRefTargets } from './mannequin/archive.ts'
import { applySemanticAction, SEMANTIC_ACTION_LABELS, type SemanticActionId } from './mannequin/targets.ts'
import type { MorphManifest } from './mannequin/morph.ts'
import type { PreciseBodyParams } from './mannequin/shape3.ts'
import type { EndEffectorId, PoseTargets } from './mannequin/solver.ts'
import type { ImageDesignApi, RefSummaryView } from './api.ts'

const REF_KEY = (refId: string, file: string): string => `${refId}/${file}`

/** 21 项测量分组（key = manifest measure 名）。基准 cm 不手填：构建期实测写进
 *  manifest 的 baseCm，运行时经 readAsset 读到（2026-11-17 审计：手填 21 项有
 *  13 项与资产实测不符，最大 frontchest 18 vs 27.2，滑杆量程随之错位）。 */
const MEASURE_GROUPS: Array<{ title: string; items: Array<{ key: string; label: string }> }> = [
  {
    title: '躯干',
    items: [
      { key: 'bust-circ', label: '胸围' },
      { key: 'underbust-circ', label: '下胸围' },
      { key: 'waist-circ', label: '腰围' },
      { key: 'hips-circ', label: '臀围' },
      { key: 'frontchest-dist', label: '前胸宽' },
      // MakeHuman 的 shoulder-dist 实测是「颈根→肩峰」单侧斜距（≈14.7cm），不是肩宽；
      // 真肩宽另立 shoulder-breadth（左右肩峰两点，≈37.3cm）。
      { key: 'shoulder-breadth', label: '肩宽' },
      { key: 'shoulder-dist', label: '肩颈距' },
      { key: 'napetowaist-dist', label: '颈至腰' },
      { key: 'waisttohip-dist', label: '腰至髋' },
    ],
  },
  {
    title: '四肢',
    items: [
      { key: 'upperarm-circ', label: '上臂围' },
      { key: 'wrist-circ', label: '腕围' },
      { key: 'upperarm-length', label: '上臂长' },
      { key: 'lowerarm-length', label: '前臂长' },
      { key: 'thigh-circ', label: '大腿围' },
      { key: 'knee-circ', label: '膝围' },
      { key: 'calf-circ', label: '小腿围' },
      { key: 'ankle-circ', label: '踝围' },
      { key: 'upperleg-height', label: '大腿长' },
      { key: 'lowerleg-height', label: '小腿长' },
    ],
  },
  {
    title: '头颈',
    items: [
      { key: 'neck-circ', label: '颈围' },
      { key: 'neck-height', label: '颈高' },
    ],
  },
]

/** 精选雕刻滑杆（morph 名 + 中文标签），按部位分组。
 *  胸型相关的 morph 不在这里——它们由「胸型」段的 cup/firmness/point/gap/droop 驱动，
 *  同一 morph 两处驱动会重复叠加。 */
const SCULPT_GROUPS: Array<{ title: string; items: Array<{ key: string; label: string }> }> = [
  {
    title: '臀/背',
    items: [
      { key: 'buttocks/buttocks-volume-incr', label: '臀容积' },
      { key: 'torso/torso-vshape-incr', label: 'V 形背' },
      { key: 'hip/hip-scale-horiz-incr', label: '髋宽' },
    ],
  },
  {
    title: '脸型',
    items: [
      { key: 'head/head-age-incr', label: '年龄感' },
      { key: 'head/head-scale-horiz-incr', label: '脸宽' },
      { key: 'head/head-scale-vert-incr', label: '脸长' },
      { key: 'chin/chin-width-incr', label: '下颌宽' },
      { key: 'cheek/l-cheek-bones-incr', label: '颧骨' },
    ],
  },
  {
    title: '五官',
    items: [
      { key: 'nose/nose-hump-incr', label: '鼻梁' },
      { key: 'nose/nose-flaring-incr', label: '鼻翼' },
      { key: 'eyes/l-eye-scale-incr', label: '眼大' },
      { key: 'mouth/mouth-scale-horiz-incr', label: '嘴宽' },
      { key: 'ears/l-ear-scale-incr', label: '耳大' },
    ],
  },
  {
    title: '手/四肢',
    items: [
      { key: 'armslegs/l-hand-fingers-length-incr', label: '手指长' },
      { key: 'armslegs/l-hand-scale-incr', label: '手尺寸' },
      { key: 'armslegs/l-upperarm-muscle-incr', label: '上臂肌' },
      { key: 'armslegs/l-upperleg-muscle-incr', label: '大腿肌' },
    ],
  },
]

/** 胸型滑杆：cup/firmness/droop 双向（−1..1），point/gap/nipple 单向（0..1）。 */
const BREAST_SLIDERS: Array<{ key: keyof PreciseBodyParams['breast']; label: string; min: number; max: number }> = [
  { key: 'cup', label: '罩杯', min: -1, max: 1 },
  { key: 'firmness', label: '紧致', min: -1, max: 1 },
  { key: 'droop', label: '上提/下垂', min: -1, max: 1 },
  { key: 'point', label: '尖挺', min: 0, max: 1 },
  { key: 'gap', label: '间距', min: 0, max: 1 },
  { key: 'nipple', label: '乳头', min: 0, max: 1 },
]

/** 性别滑杆读数（0=男 1=女，中间为混合态）。 */
function genderLabel(g: number): string {
  if (g < 0.2) return '男'
  if (g > 0.8) return '女'
  return `中性 ${Math.round(g * 100)}%`
}

export function MannequinView({ api }: { api: ImageDesignApi }): ReactNode {
  const s = useClientState()
  const man = s.man
  const containerRef = useRef<HTMLDivElement | null>(null)
  const paramsRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Viewer | null>(null)
  /** 上一轮测量预览（重定基差值的参照；空表 = 首轮不重定基）。 */
  const previewsRef = useRef<Record<string, number>>({})
  const [assetsLoading, setAssetsLoading] = useState(true)
  /** 测量基准 cm（来自 manifest.baseCm，构建期实测），资产到位前为空表；
   *  仅作 viewer 未就绪时的兜底，就绪后滑杆基准用 previewMeasurements（随性别/体型联动）。 */
  const [measureBases, setMeasureBases] = useState<Record<string, number>>({})
  /** 测量预览（viewer 实测：性别/宏观/雕刻/胸型已应用、无测量 morph 的体形）。
   *  基准若用裸网格 baseCm，一动滑杆就把目标写成裸网格值，求解器把性别形变
   *  出来的胸压回去——2026-11-18 实机「胸围极速坍塌且滑回原位无法恢复」根因。 */
  const [measurePreviews, setMeasurePreviews] = useState<Record<string, number>>({})

  // 懒挂载：拉资产 → 建 viewer → GLB 解码 + morph 就绪
  useEffect(() => {
    if (containerRef.current === null || viewerRef.current !== null) return
    let cancelled = false
    const cur = getState().man
    void (async () => {
      try {
        const [glb, json, bin] = await Promise.all([
          api.readAsset(BODY_GLB_FILE),
          api.readAsset(MORPH_MANIFEST_FILE),
          api.readAsset(MORPH_BIN_FILE),
        ])
        if (cancelled) return
        // 测量基准先于 viewer 建立就绪（轻量 JSON.parse），滑杆量程不等 3D 加载
        const manifest = JSON.parse(new TextDecoder().decode(json.bytes)) as MorphManifest
        const bases: Record<string, number> = {}
        for (const m of manifest.measurements) {
          if (typeof m.baseCm === 'number' && Number.isFinite(m.baseCm) && m.baseCm > 0) bases[m.name] = m.baseCm
        }
        setMeasureBases(bases)
        const assets: ViewerAssets = { glb: glb.bytes, morphJson: json.bytes, morphBin: bin.bytes }
        const viewer = createViewer(containerRef.current!, cur.precise, cur.orbit, cur.shot, assets, {
          onOrbit: (orbit) => { patchMan({ orbit }) },
          // 拖完肢体 = 手调过姿势：姿势标签置 unknown（不再是任何库内预设）✓
          onTargets: (targets) => { patchMan({ targets, poseId: 'unknown' }) },
        })
        if (cancelled) { viewer.dispose(); return }
        viewerRef.current = viewer
        viewer.setPose(POSES.find((p) => p.id === cur.poseId)?.joints ?? {})
        viewer.ready
          .then(() => {
            patchMan({ modelReady: true, measured: viewer.measured() })
            // 预设走求解器（意图目标 → 物理 + IK → 关节角）；失败才退回姿势表 ✓
            if (cur.poseId !== 'unknown' && !viewer.applyPreset(cur.poseId)) {
              viewer.setPose(POSES.find((p) => p.id === cur.poseId)?.joints ?? {})
            }
            patchMan({ targets: viewer.getTargets() })
            const previews = viewer.previewMeasurements()
            previewsRef.current = previews
            setMeasurePreviews(previews)
            setAssetsLoading(false)
          })
          .catch((e) => { setState({ error: e instanceof Error ? e.message : String(e) }); setAssetsLoading(false) })
      } catch (e) {
        if (!cancelled) {
          setState({ error: `素体资产加载失败：${e instanceof Error ? e.message : String(e)}` })
          setAssetsLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
      viewerRef.current?.dispose()
      viewerRef.current = null
    }
  }, [api])

  // 精确体位变化 → 重新求解 morph + 刷新测量预览（滑杆基准随性别/体型联动）
  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer === null) return
    viewer.setPreciseBody(man.precise)
    const previews = viewer.previewMeasurements()
    // 已设测量目标按预览差值重定基：性别/体脂/雕刻等变化时目标跟随体形平移，
    // 保持用户的相对调节量。否则目标是绝对值钉死，求解器会把体形往旧目标上压
    // （实机表现：动性别滑杆后胸被旧目标拽住，「滑回原位也无法恢复」的最后一类）。
    // 重定基只动 measurementsCm（不碰权重），二次进入时差值为零，不会循环。
    const last = previewsRef.current
    const goals = man.precise.measurementsCm
    const rebased: Record<string, number> = {}
    let changed = false
    const hasPrev = Object.keys(last).length > 0
    for (const [k, g] of Object.entries(goals)) {
      const d = hasPrev ? (previews[k] ?? 0) - (last[k] ?? 0) : 0
      if (Math.abs(d) > 1e-9) { rebased[k] = g + d; changed = true } else rebased[k] = g
    }
    previewsRef.current = previews
    setMeasurePreviews(previews)
    patchMan({ measured: viewer.measured() })
    if (changed) patchPrecise({ measurementsCm: rebased })
  }, [man.precise])

  // 姿势选择 → 意图目标（求解器版预设）；「unknown」= 手动调过，不再回放预设
  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer === null || man.poseId === 'unknown') return
    if (viewer.applyPreset(man.poseId)) {
      patchMan({ targets: viewer.getTargets() })
    } else {
      viewer.setPose(POSES.find((p) => p.id === man.poseId)?.joints ?? {})
    }
  }, [man.poseId])

  // 视口模式：转视角 / 摆姿势
  useEffect(() => {
    viewerRef.current?.setMode(man.mode)
  }, [man.mode])

  useEffect(() => {
    viewerRef.current?.setCamera(man.orbit, man.shot)
  }, [man.orbit, man.shot])

  // 滑杆防轨道跳值（2026-11-18）：原生 range 点轨道任意处会把值直接跳到点击处，
  // 素体 cm 滑杆误触一下就是十几 cm 形变、性别滑杆一下切到端点，滑回原位也难复原。
  // CSS pointer-events 方案在 Chromium 里连 thumb 伪元素一起禁死（实机验证拖 thumb
  // 失效），改 mousedown 命中测试：点在 thumb（含 ±4px 容差）上放行原生拖拽，
  // 点在轨道上 preventDefault 拦掉跳值，键盘微调不受影响。
  useEffect(() => {
    const el = paramsRef.current
    if (el === null) return
    const THUMB_W = 14
    const SLACK = 4
    const onMouseDown = (e: MouseEvent): void => {
      const input = e.target
      if (!(input instanceof HTMLInputElement) || !input.classList.contains('duc-slider')) return
      const r = input.getBoundingClientRect()
      const min = parseFloat(input.min)
      const max = parseFloat(input.max)
      const t = (parseFloat(input.value) - min) / (max - min)
      const thumbX = r.left + THUMB_W / 2 + t * (r.width - THUMB_W)
      const dx = Math.abs(e.clientX - thumbX)
      const dy = Math.abs(e.clientY - (r.top + r.height / 2))
      if (dx > THUMB_W / 2 + SLACK || dy > 10) e.preventDefault()
    }
    el.addEventListener('mousedown', onMouseDown, true)
    return () => { el.removeEventListener('mousedown', onMouseDown, true) }
  }, [])

  useEffect(() => { void reloadRefs(api) }, [api])

  // 参考图字节 → blob URL
  useEffect(() => {
    const missing = man.refs.filter((r) => getState().man.refUrls[REF_KEY(r.id, r.file)] === undefined && r.file !== '')
    if (missing.length === 0) return
    let cancelled = false
    void (async () => {
      for (const r of missing) {
        try {
          const { bytes, mime } = await api.readRefImage(r.id, r.file)
          if (cancelled) return
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
          patchMan({ refUrls: { ...getState().man.refUrls, [REF_KEY(r.id, r.file)]: url } })
        } catch {
          if (cancelled) return
          patchMan({ refUrls: { ...getState().man.refUrls, [REF_KEY(r.id, r.file)]: 'broken' } })
        }
      }
    })()
    return () => { cancelled = true }
  }, [api, man.refs])

  const patchPrecise = (next: Partial<PreciseBodyParams>): void => {
    patchMan({ precise: { ...getState().man.precise, ...next } })
  }
  const setMeasure = (key: string, cm: number): void => {
    const p = getState().man.precise
    patchPrecise({ measurementsCm: { ...p.measurementsCm, [key]: cm } })
  }
  const setSculpt = (key: string, w: number): void => {
    const p = getState().man.precise
    patchPrecise({ sculpt: { ...p.sculpt, [key]: w } })
  }
  const setMacro = (key: keyof PreciseBodyParams['macro'], v: number): void => {
    const p = getState().man.precise
    patchPrecise({ macro: { ...p.macro, [key]: v } })
  }
  const setBreast = (key: keyof PreciseBodyParams['breast'], v: number): void => {
    const p = getState().man.precise
    patchPrecise({ breast: { ...p.breast, [key]: v } })
  }

  /** 面板调末端目标（局部坐标，cm → m）。 */
  const setTargetAxis = (axis: 'x' | 'y' | 'z', valueCm: number): void => {
    const viewer = viewerRef.current
    const targets = getState().man.targets
    if (viewer === null || targets === null) return
    const selected = getState().man.selectedEnd
    const next: PoseTargets = { root: { ...targets.root }, effectors: { ...targets.effectors } }
    const prev = next.effectors[selected] ?? {}
    const pos = { x: prev.pos?.x ?? 0, y: prev.pos?.y ?? 0, z: prev.pos?.z ?? 0 }
    pos[axis] = valueCm / 100
    // 手动位置取代语义锚点（否则锚点会把目标拉回腿面）✓
    next.effectors[selected] = { ...prev, pos, anchor: undefined }
    viewer.setTargets(next, { reset: false })
    patchMan({ targets: next, poseId: 'unknown' })
  }

  const measuredMap = new Map(man.measured.map((m) => [m.name, m]))
  /** 滑杆基准：优先 viewer 实时预览（性别/体型联动），资产未就绪时退 manifest baseCm。 */
  const measurementBase = (key: string): number | undefined => measurePreviews[key] ?? measureBases[key]

  /**
   * 语义动作：在当前意图上打一个补丁（只动这一条语义，其余作者调好的意图保留）。
   */
  const applySemantic = (action: SemanticActionId): void => {
    const viewer = viewerRef.current
    const cur = getState().man
    if (viewer === null || cur.targets === null) return
    const bodyMetrics = viewer.bodyMetrics()
    if (bodyMetrics === null) return
    const next = applySemanticAction(action, cur.targets, bodyMetrics)
    viewer.setTargets(next, { reset: false })
    patchMan({ targets: next, poseId: 'unknown' })
  }

  const doCapture = async (): Promise<void> => {
    const viewer = viewerRef.current
    if (viewer === null || getState().man.capturing) return
    const cur = getState().man
    patchMan({ capturing: true })
    try {
      const dataUrl = viewer.capture(cur.length, cur.ratio)
      const saved = await api.saveRefShot({
        dataUrl,
        body: { height: cur.precise.height },
        poseId: cur.poseId,
        // 关节表记**当前实际生效**的（求解器解出来的），不是姿势库的静态表 ——
        // 姿势库那张表跟渲染出来的姿势已经不是一回事了（005 起姿势由物理解算）✓
        joints: viewer.currentJoints(),
        camera: { shot: cur.shot, azimuthDeg: cur.orbit.azimuthDeg, elevationDeg: cur.orbit.elevationDeg, distanceScale: cur.orbit.distanceScale, length: cur.length, ratio: cur.ratio },
        precise: {
          height: cur.precise.height,
          measurementsCm: { ...cur.precise.measurementsCm },
          sculpt: { ...cur.precise.sculpt },
          macro: { ...cur.precise.macro },
          breast: { ...cur.precise.breast },
        },
        measured: cur.measured.map((m) => ({ ...m })),
        // 意图目标也存进档：回放时按当前体型重解，同一个意图换个身高也是对的姿势 ✓
        targets: toRefTargets(cur.targets),
      })
      patchMan({ capturing: false, refAbsPaths: { ...getState().man.refAbsPaths, [saved.refId]: saved.absPath } })
      await reloadRefs(api)
      setState({ error: '' })
    } catch (e) {
      patchMan({ capturing: false })
      setState({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  const useAsReference = (r: RefSummaryView): void => {
    try {
      const cached = getState().man.refAbsPaths[r.id]
      const absPath = r.absPath !== '' ? r.absPath : cached
      if (absPath === undefined || absPath === '') throw new Error('该参考图缺少落盘路径，请重新拍摄后使用')
      const form = getState().form
      const refs = form.refImages.includes(absPath) ? form.refImages : [...form.refImages, absPath].slice(0, 16)
      patchForm({ model: 'MiniMax-H3-Image', refImages: refs })
      setState({ tab: 'generate', error: '' })
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  const removeRef = (r: RefSummaryView): void => {
    void (async () => {
      try {
        await api.deleteRef(r.id)
        const urls = { ...getState().man.refUrls }
        delete urls[REF_KEY(r.id, r.file)]
        patchMan({ refUrls: urls })
        await reloadRefs(api)
      } catch (e) {
        setState({ error: e instanceof Error ? e.message : String(e) })
      }
    })()
  }

  /**
   * 从归档回放姿势。
   *
   * 档里有**意图**（005 之后拍的都有）→ 按当前体型重解：同一个意图，换个身高
   * 仍然是站得住的姿势 ✓；旧档只有关节表 → 直接钉关节表（逐字节复现）✓。
   */
  const replayRefPose = (r: RefSummaryView): void => {
    void (async () => {
      try {
        const viewer = viewerRef.current
        if (viewer === null) throw new Error('素体还没加载好')
        const record = await api.readRefRecord(r.id)
        const targets = fromRefTargets(record.targets)
        viewer.restorePose(record.joints, targets)
        // 旧档没意图：钉关节表，姿势标签置 unknown（否则姿势下拉会把它当预设重解覆盖掉）
        patchMan({ targets: viewer.getTargets(), poseId: targets === null ? 'unknown' : record.poseId })
        setState({ error: '' })
      } catch (e) {
        setState({ error: e instanceof Error ? e.message : String(e) })
      }
    })()
  }

  return (
    <div className="idi-man-root">
      <div className="idi-man-viewport" ref={containerRef} data-testid="mannequin-viewport">
        {assetsLoading && <div className="idi-man-loading"><Spinner /><span>加载精确素体…</span></div>}
        <div className="idi-man-overlay">
          <span className="idi-man-hint">
            {man.mode === 'pose' ? '拖动肢体摆姿势 · 右侧面板调目标' : '拖拽转方位 / 俯仰 · 滚轮推拉'}
          </span>
          <div className="idi-man-cambar">
            <SegmentedControl id="idi-man-mode" label="操作" value={man.mode}
              options={[{ value: 'orbit', label: '转视角' }, { value: 'pose', label: '摆姿势' }]}
              onChange={(v: 'orbit' | 'pose') => { patchMan({ mode: v }) }} />
            <Select aria-label="姿势" value={man.poseId} onChange={(e) => { patchMan({ poseId: e.target.value }) }}
              options={[
                // 手调过（poseId='unknown'）时补一项占位，否则下拉会显示成空白
                ...(POSES.some((p) => p.id === man.poseId) ? [] : [{ value: 'unknown', label: '手动调整' }]),
                ...POSES.map((p) => ({ value: p.id, label: p.title })),
              ]} />
            <SegmentedControl id="idi-shot" label="景别" value={man.shot}
              options={[{ value: 'full', label: '全身' }, { value: 'threeQuarter', label: '七分身' }, { value: 'half', label: '半身' }, { value: 'closeup', label: '特写' }]}
              onChange={(v: ShotKind) => { patchMan({ shot: v, orbit: { ...getState().man.orbit, distanceScale: 1 } }) }} />
          </div>
          <Button variant="primary" className="idi-man-shutter" disabled={man.capturing || !man.modelReady} onClick={() => { void doCapture() }}>
            {man.capturing ? '拍摄中…' : man.modelReady ? '拍摄' : '加载素体…'}
          </Button>
        </div>
      </div>
      <div className="idi-man-params" ref={paramsRef}>
        <div className="idi-sec">
          <div className="idi-row"><span className="idi-meta">身高</span><span className="idi-spacer" /><span className="idi-meta">{Math.round(man.precise.height)}cm</span></div>
          <Slider aria-label="身高" min={130} max={210} step={1} value={man.precise.height}
            onValueChange={(v) => patchPrecise({ height: v })} />
        </div>

        <div className="idi-sec">
          <span className="idi-meta">测量（cm · 基准随性别/体型联动 · 括号内为实测）</span>
          {Object.keys(measurePreviews).length === 0 && Object.keys(measureBases).length === 0 &&
            <span className="idi-hint">测量基准加载中…</span>}
          {(Object.keys(measurePreviews).length > 0 || Object.keys(measureBases).length > 0) && MEASURE_GROUPS.map((g) => (
            <details key={g.title} className="idi-fold">
              <summary>{g.title}</summary>
              {g.items.map((it) => {
                const base = measurementBase(it.key)
                const echo = measuredMap.get(it.key)
                const target = man.precise.measurementsCm[it.key] ?? base ?? 0
                return (
                  <div className="idi-slider-row" key={it.key}>
                    <span className="idi-slider-label">{it.label}</span>
                    <div className="idi-grow">
                      <Slider aria-label={it.label} min={(base ?? 0) * 0.6} max={(base ?? 1) * 1.6} step={0.5}
                        value={target} onValueChange={(v) => setMeasure(it.key, v)} />
                    </div>
                    <span className="idi-slider-val">{target.toFixed(1)}{echo !== undefined ? ` (${echo.measuredCm.toFixed(1)})` : ''}</span>
                  </div>
                )
              })}
            </details>
          ))}
          <Button variant="ghost" onClick={() => patchPrecise({ measurementsCm: {} })}>重置测量</Button>
        </div>

        <div className="idi-sec">
          <span className="idi-meta">性别与胸型</span>
          <div className="idi-slider-row">
            <span className="idi-slider-label">性别</span>
            <div className="idi-grow">
              <Slider aria-label="性别" min={0} max={1} step={0.02} value={man.precise.macro.gender}
                onValueChange={(v) => setMacro('gender', v)} />
            </div>
            <span className="idi-slider-val">{genderLabel(man.precise.macro.gender)}</span>
          </div>
          {man.precise.macro.gender > 0.02 && (
            <>
              <span className="idi-hint">胸型决定形状（罩杯/紧致/尖挺），胸围数值只校准尺寸。上提/下垂：左=上提，右=下垂。男性体上自动淡出。</span>
              {BREAST_SLIDERS.map((it) => (
                <div className="idi-slider-row" key={it.key}>
                  <span className="idi-slider-label">{it.label}</span>
                  <div className="idi-grow">
                    <Slider aria-label={it.label} min={it.min} max={it.max} step={0.05}
                      value={man.precise.breast[it.key]} onValueChange={(v) => setBreast(it.key, v)} />
                  </div>
                  <span className="idi-slider-val">{man.precise.breast[it.key].toFixed(2)}</span>
                </div>
              ))}
              <Button variant="ghost" onClick={() => patchPrecise({ breast: { cup: 0, firmness: 0, point: 0, gap: 0, droop: 0, nipple: 0 } })}>重置胸型</Button>
            </>
          )}
        </div>

        <div className="idi-sec">
          <span className="idi-meta">宏观</span>
          {([['age', '年龄'], ['fat', '体脂'], ['muscle', '肌肉']] as const).map(([k, label]) => (
            <div className="idi-slider-row" key={k}>
              <span className="idi-slider-label">{label}</span>
              <div className="idi-grow">
                <Slider aria-label={label} min={0} max={1} step={0.05} value={man.precise.macro[k]}
                  onValueChange={(v) => setMacro(k, v)} />
              </div>
              <span className="idi-slider-val">{man.precise.macro[k].toFixed(2)}</span>
            </div>
          ))}
        </div>

        <div className="idi-sec">
          <span className="idi-meta">局部雕刻（−1..1）</span>
          {SCULPT_GROUPS.map((g) => (
            <details key={g.title} className="idi-fold">
              <summary>{g.title}</summary>
              {g.items.map((it) => (
                <div className="idi-slider-row" key={it.key}>
                  <span className="idi-slider-label">{it.label}</span>
                  <div className="idi-grow">
                    <Slider aria-label={it.label} min={-1} max={1} step={0.05} value={man.precise.sculpt[it.key] ?? 0}
                      onValueChange={(v) => setSculpt(it.key, v)} />
                  </div>
                  <span className="idi-slider-val">{(man.precise.sculpt[it.key] ?? 0).toFixed(2)}</span>
                </div>
              ))}
            </details>
          ))}
          <Button variant="ghost" onClick={() => patchPrecise({ sculpt: {} })}>重置雕刻</Button>
        </div>

        <div className="idi-sec">
          <span className="idi-meta">摆姿势（物理求解）</span>
          <div className="idi-row-wrap">
            <Select aria-label="末端" value={man.selectedEnd} disabled={man.targets === null}
              onChange={(e) => { patchMan({ selectedEnd: e.target.value as EndEffectorId }) }}
              options={[
                { value: 'handL', label: '左手' },
                { value: 'handR', label: '右手' },
                { value: 'footL', label: '左脚' },
                { value: 'footR', label: '右脚' },
              ]} />
          </div>
          {(['y', 'z', 'x'] as const).map((axis) => {
            const pos = man.targets?.effectors[man.selectedEnd]?.pos
            const value = Math.round((pos?.[axis] ?? 0) * 100)
            const label = axis === 'y' ? '高度' : axis === 'z' ? '前后' : '内外'
            return (
              <div className="idi-slider-row" key={axis}>
                <span className="idi-slider-label">{label}</span>
                <div className="idi-grow">
                  <Slider aria-label={`${label}（cm）`} min={axis === 'y' ? -20 : -90} max={axis === 'y' ? 160 : 90}
                    step={1} value={value} disabled={pos === undefined}
                    onValueChange={(v) => setTargetAxis(axis, v)} />
                </div>
                {/* 语义锚点（贴腿面）没有固定坐标 → 显示「锚点」而不是 0cm */}
                <span className="idi-slider-val">{pos === undefined ? '锚点' : `${value}cm`}</span>
              </div>
            )
          })}
          <span className="idi-meta">
            {man.poseId === 'unknown' ? '已手动调整（不再是预设）' : '预设解算中：重力 + 接触 + IK'}
          </span>
          <div className="idi-row-wrap">
            {(Object.keys(SEMANTIC_ACTION_LABELS) as SemanticActionId[]).map((id) => (
              <Button key={id} variant="ghost" disabled={man.targets === null} onClick={() => { applySemantic(id) }}>
                {SEMANTIC_ACTION_LABELS[id]}
              </Button>
            ))}
          </div>
          <span className="idi-hint">语义动作只改这一条意图，其余（骨盆高度、头朝向）保留。</span>
        </div>

        <div className="idi-sec">
          <span className="idi-meta">拍摄规格</span>
          <div className="idi-row-wrap">
            <Select aria-label="拍摄长边" value={String(man.length)} onChange={(e) => { patchMan({ length: Number(e.target.value) as CaptureLength }) }}
              options={CAPTURE_LENGTHS.map((l) => ({ value: String(l), label: `${l}px` }))} />
            <Select aria-label="拍摄比例" value={man.ratio} onChange={(e) => { patchMan({ ratio: e.target.value as CaptureRatio }) }}
              options={CAPTURE_RATIOS.map((r) => ({ value: r, label: r }))} />
          </div>
        </div>

        <RefList onUse={useAsReference} onRemove={removeRef} onReplay={replayRefPose} />
      </div>
    </div>
  )
}

function reloadRefs(api: ImageDesignApi): Promise<void> {
  patchMan({ refsLoading: true })
  return api.listRefs()
    .then((refs) => { patchMan({ refs, refsLoading: false }) })
    .catch((e: unknown) => { patchMan({ refsLoading: false }); setState({ error: e instanceof Error ? e.message : String(e) }) })
}

function RefList({ onUse, onRemove, onReplay }: {
  onUse: (r: RefSummaryView) => void
  onRemove: (r: RefSummaryView) => void
  onReplay: (r: RefSummaryView) => void
}): ReactNode {
  const s = useClientState()
  const man = s.man
  if (man.refsLoading && man.refs.length === 0) {
    return <div className="idi-row"><Spinner /><span className="idi-meta">加载参考图…</span></div>
  }
  if (man.refs.length === 0) {
    return (
      <Empty>
        <EmptyTitle>还没有参考图</EmptyTitle>
        <EmptyDescription>调好体型、姿势与机位后点「拍摄」。参考图可一键作为生成的参考图片。</EmptyDescription>
      </Empty>
    )
  }
  return (
    <div className="idi-sec">
      <span className="idi-meta">参考图（{man.refs.length}）</span>
      <div className="idi-hist">
        {man.refs.map((r) => {
          const url = man.refUrls[REF_KEY(r.id, r.file)]
          const poseTitle = POSES.find((p) => p.id === r.poseId)?.title ?? r.poseId
          return (
            <div className="idi-ref-row" key={r.id}>
              {url !== undefined && url !== 'broken'
                ? <img className="idi-ref-thumb" src={url} alt={r.file} />
                : <div className="idi-ref-thumb" />}
              <div className="idi-ref-meta">
                <div className="idi-row"><Tag tone="neutral">{poseTitle}</Tag><span className="idi-meta">{formatTime(r.createdAt)}</span></div>
                <span className="idi-meta">{r.file}</span>
              </div>
              <Button variant="outline" onClick={() => { onUse(r) }}>用作参考图</Button>
              <Button variant="ghost" aria-label={`回放 ${r.id} 的姿势`} onClick={() => { onReplay(r) }}>回放姿势</Button>
              <Button variant="ghost" aria-label={`删除 ${r.id}`} onClick={() => { onRemove(r) }}>
                <IconCloseOutlineRegular size={12} />
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

// 素体设计视图：3D 视口（体型滑杆 / 姿势库 / 相机预设）+ 拍摄 + 参考图列表。
//
// 闭环：拍摄 → saveRefShot 落盘归档 → 「用作生成参考图」把 absPath 填进
// 生成表单的 H3 refImages 并切回生成视图 —— 素体参考图直接驱动一致性生成。
//
// 纪律（与本面板其他视图一致）：
//   · 事件处理器读状态用 getState()（useClientState 只在渲染期）
//   · async 异常必须接住，不能让被拒 promise 静默丢弃
//   · WebGL 资源在卸载 effect 里 dispose（懒挂载：切到本视图才建上下文）

import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './ui/button.tsx'
import { Select } from './ui/select.tsx'
import { SegmentedControl } from './ui/segmented-control.tsx'
import { Slider } from './ui/slider.tsx'
import { Spinner } from './ui/spinner.tsx'
import { Tag } from './ui/tag.tsx'
import { Empty, EmptyDescription, EmptyTitle } from './ui/empty.tsx'
import { IconCloseOutlineRegular } from './ui/icons.tsx'
import { getState, patchForm, patchMan, setState, useClientState } from './state.ts'
import type { BodyParams } from './mannequin/body.ts'
import { POSES } from './mannequin/poses.ts'
import { AZIMUTHS, ELEVATIONS, type AzimuthKind, type ElevationKind, type ShotKind } from './mannequin/camera.ts'
import { CAPTURE_LENGTHS, CAPTURE_RATIOS, type CaptureLength, type CaptureRatio } from './mannequin/capture.ts'
import { createViewer, type Viewer } from './mannequin/viewer.ts'
import type { ImageDesignApi, RefSummaryView } from './api.ts'

const REF_KEY = (refId: string, file: string): string => `${refId}/${file}`

/** 滑杆行定义（label / 键 / 值域 / 步长 / 显示格式）。 */
const BODY_SLIDERS: Array<{ key: keyof BodyParams; label: string; min: number; max: number; step: number; fmt?: (v: number) => string }> = [
  { key: 'height', label: '身高', min: 130, max: 210, step: 1, fmt: (v) => `${Math.round(v)}cm` },
  { key: 'headRatio', label: '头身比', min: 6, max: 9, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: 'shoulderWidth', label: '肩宽', min: 0.7, max: 1.4, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
  { key: 'bust', label: '胸围', min: 0.7, max: 1.4, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
  { key: 'waist', label: '腰围', min: 0.55, max: 1.5, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
  { key: 'hip', label: '臀围', min: 0.7, max: 1.5, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
  { key: 'limbThickness', label: '四肢粗细', min: 0.6, max: 1.5, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
  { key: 'armLength', label: '臂长', min: 0.85, max: 1.15, step: 0.01, fmt: (v) => `×${v.toFixed(2)}` },
  { key: 'legLength', label: '腿长', min: 0.85, max: 1.15, step: 0.01, fmt: (v) => `×${v.toFixed(2)}` },
]

export function MannequinView({ api }: { api: ImageDesignApi }): ReactNode {
  const s = useClientState()
  const man = s.man
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const orbitRef = useRef(man.orbit)
  orbitRef.current = man.orbit

  // 懒挂载：本视图挂载即建 WebGL 上下文，卸载即释放
  useEffect(() => {
    if (containerRef.current === null || viewerRef.current !== null) return
    const cur = getState().man
    const viewer = createViewer(containerRef.current, cur.body, cur.orbit, cur.shot, {
      onOrbit: (orbit) => { patchMan({ orbit }) },
    })
    viewerRef.current = viewer
    viewer.setPose(POSES.find((p) => p.id === cur.poseId)?.joints ?? {})
    return () => {
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  // 体型变化 → 重建素体
  useEffect(() => {
    viewerRef.current?.setBody(man.body)
  }, [man.body])

  // 姿势变化 → 关节旋转
  useEffect(() => {
    viewerRef.current?.setPose(POSES.find((p) => p.id === man.poseId)?.joints ?? {})
  }, [man.poseId])

  // 相机预设 / 轨道变化 → 相机
  useEffect(() => {
    viewerRef.current?.setCamera(man.orbit, man.shot)
  }, [man.orbit, man.shot])

  // 进入视图拉一次参考图列表
  useEffect(() => {
    void reloadRefs(api)
  }, [api])

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

  const doCapture = async (): Promise<void> => {
    const viewer = viewerRef.current
    if (viewer === null || getState().man.capturing) return
    const cur = getState().man
    patchMan({ capturing: true })
    try {
      const dataUrl = viewer.capture(cur.length, cur.ratio)
      const saved = await api.saveRefShot({
        dataUrl,
        body: { ...cur.body },
        poseId: cur.poseId,
        joints: POSES.find((p) => p.id === cur.poseId)?.joints ?? {},
        camera: { shot: cur.shot, azimuthDeg: cur.orbit.azimuthDeg, elevationDeg: cur.orbit.elevationDeg, distanceScale: cur.orbit.distanceScale, length: cur.length, ratio: cur.ratio },
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
    // 闭环：拍摄时缓存的落盘绝对路径 → 生成表单的 H3 参考图列表，并切回生成视图。
    // 只限本会话内拍摄的参考图（absPath 在拍摄响应里；历史档只有相对名）。
    try {
      const absPath = getState().man.refAbsPaths[r.id]
      if (absPath === undefined) throw new Error('该参考图不是本会话拍摄的，请重新拍摄后使用')
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

  return (
    <div className="idi-man-root">
      <div className="idi-man-viewport" ref={containerRef} data-testid="mannequin-viewport" />
      <div className="idi-man-params">
        <div className="idi-sec">
          <div className="idi-row">
            <span className="idi-meta">体型</span>
            <span className="idi-spacer" />
            <Button variant="ghost" onClick={() => { patchMan({ body: { height: 170, headRatio: 7.5, shoulderWidth: 1, bust: 1, waist: 1, hip: 1, limbThickness: 1, armLength: 1, legLength: 1 } }) }}>
              重置
            </Button>
          </div>
          {BODY_SLIDERS.map((def) => (
            <div className="idi-slider-row" key={def.key}>
              <span className="idi-slider-label">{def.label}</span>
              <div className="idi-grow">
                <Slider
                  aria-label={def.label}
                  min={def.min}
                  max={def.max}
                  step={def.step}
                  value={man.body[def.key]}
                  onValueChange={(v) => { patchMan({ body: { ...man.body, [def.key]: v } }) }}
                />
              </div>
              <span className="idi-slider-val">{def.fmt !== undefined ? def.fmt(man.body[def.key]) : String(man.body[def.key])}</span>
            </div>
          ))}
        </div>

        <div className="idi-row-wrap">
          <Select
            aria-label="姿势"
            value={man.poseId}
            onChange={(e) => { patchMan({ poseId: e.target.value }) }}
            options={POSES.map((p) => ({ value: p.id, label: p.title }))}
          />
        </div>

        <div className="idi-sec">
          <span className="idi-meta">相机</span>
          <div className="idi-row-wrap">
            <SegmentedControl
              id="idi-shot"
              label="景别"
              value={man.shot}
              options={[
                { value: 'full', label: '全身' },
                { value: 'threeQuarter', label: '七分身' },
                { value: 'half', label: '半身' },
                { value: 'closeup', label: '特写' },
              ]}
              onChange={(v: ShotKind) => { patchMan({ shot: v, orbit: { ...getState().man.orbit, distanceScale: 1 } }) }}
            />
            <SegmentedControl
              id="idi-azimuth"
              label="方位"
              value={man.azimuth}
              options={[
                { value: 'front', label: '正面' },
                { value: 'quarter', label: '1/3侧' },
                { value: 'side', label: '正侧' },
                { value: 'back', label: '背面' },
              ]}
              onChange={(v: AzimuthKind) => { patchMan({ azimuth: v, orbit: { ...getState().man.orbit, azimuthDeg: AZIMUTHS[v] } }) }}
            />
            <SegmentedControl
              id="idi-elevation"
              label="俯仰"
              value={man.elevation}
              options={[
                { value: 'level', label: '平视' },
                { value: 'high', label: '微俯' },
                { value: 'low', label: '微仰' },
              ]}
              onChange={(v: ElevationKind) => { patchMan({ elevation: v, orbit: { ...getState().man.orbit, elevationDeg: ELEVATIONS[v] } }) }}
            />
          </div>
          <span className="idi-hint">视口可拖拽转方位、滚轮推拉；拍摄按当前视角成像。</span>
        </div>

        <div className="idi-row-wrap">
          <Select
            aria-label="拍摄长边"
            value={String(man.length)}
            onChange={(e) => { patchMan({ length: Number(e.target.value) as CaptureLength }) }}
            options={CAPTURE_LENGTHS.map((l) => ({ value: String(l), label: `${l}px` }))}
          />
          <Select
            aria-label="拍摄比例"
            value={man.ratio}
            onChange={(e) => { patchMan({ ratio: e.target.value as CaptureRatio }) }}
            options={CAPTURE_RATIOS.map((r) => ({ value: r, label: r }))}
          />
          <Button variant="primary" disabled={man.capturing} onClick={() => { void doCapture() }}>
            {man.capturing ? '拍摄中…' : '拍摄'}
          </Button>
        </div>

        <RefList onUse={useAsReference} onRemove={removeRef} />
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

function RefList({ onUse, onRemove }: {
  onUse: (r: RefSummaryView) => void
  onRemove: (r: RefSummaryView) => void
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

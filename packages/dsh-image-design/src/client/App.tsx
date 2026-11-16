// 图片设计面板：参数表单 + 结果画廊 + 对比浮层 + 历史列表。
//
// 纪律（media-platforms 实证过的坑）：
//   · 事件处理器里读状态用 getState()（useClientState 是 Hook，只能在渲染期调）；
//   · async 异常必须接住，不能让被拒 promise 静默丢弃；
//   · 控件一律走 dsh-ui-cell 复制件（duc-*），插件自有类用 idi- 前缀。

import { useEffect, useState, type ReactNode } from 'react'
import { Button } from './ui/button.tsx'
import { Textarea } from './ui/textarea.tsx'
import { Input } from './ui/input.tsx'
import { Select } from './ui/select.tsx'
import { SegmentedControl } from './ui/segmented-control.tsx'
import { Switch } from './ui/switch.tsx'
import { Tag } from './ui/tag.tsx'
import { Tooltip } from './ui/tooltip.tsx'
import { Spinner } from './ui/spinner.tsx'
import { Empty, EmptyDescription, EmptyTitle } from './ui/empty.tsx'
import { ImageLightbox } from './ui/image-lightbox.tsx'
import { Separator } from './ui/separator.tsx'
import { IconCloseOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconWarningOutlineRegular } from './ui/icons.tsx'
import type { GenerateWireArgs, ImageDesignApi, ModelKey, RunStatus, RunView } from './api.ts'
import { getState, patchForm, setState, useClientState, type FormState } from './state.ts'
import { MannequinView } from './MannequinView.tsx'

const IMAGE_KEY = (runId: string, file: string): string => `${runId}/${file}`

const ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:1', '1:3']

const STATUS_TONE: Record<RunStatus, 'success' | 'info' | 'warning' | 'danger' | 'outline'> = {
  running: 'info',
  success: 'success',
  partial: 'warning',
  failed: 'danger',
  timeout: 'danger',
}

const STATUS_TEXT: Record<RunStatus, string> = {
  running: '进行中',
  success: '完成',
  partial: '部分失败',
  failed: '失败',
  timeout: '超时',
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** 表单 → wire 参数（客户端先验一轮，报错话术与宿主校验对齐）。 */
export function buildWireArgs(f: FormState): GenerateWireArgs {
  const prompt = f.prompt.trim()
  if (prompt === '') throw new Error('请先填写图片描述')
  const args: GenerateWireArgs = { model: f.model, prompt, n: f.n }
  if (f.sizeMode === 'aspect') {
    args.aspectRatio = f.aspectRatio
    if (f.model === 'MiniMax-H3-Image') args.area = f.area
  } else if (f.sizeMode === 'exact') {
    const size = f.size.trim()
    if (!/^\d{2,5}x\d{2,5}$/.test(size)) throw new Error('精确尺寸应为 WxH 形式（如 2720x1536），宽高比在 1:3 到 3:1 之间')
    args.size = size
  } else {
    const width = Number(f.width)
    const height = Number(f.height)
    if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('像素宽高必须是整数')
    args.width = width
    args.height = height
  }
  if (f.model === 'image-01') {
    const seedText = f.seed.trim()
    if (seedText !== '') {
      const seed = Number(seedText)
      if (!Number.isInteger(seed)) throw new Error('seed 必须是整数')
      args.seed = seed
    }
    if (f.promptOptimizer) args.promptOptimizer = true
    if (f.aigcWatermark) args.aigcWatermark = true
    const subject = f.subjectRefImage.trim()
    if (subject !== '') args.subjectRefImage = subject
  } else {
    if (!f.promptEnhance) args.promptEnhance = false
    const refs = f.refImages.map((s) => s.trim()).filter((s) => s !== '')
    if (refs.length > 0) args.refImages = refs
  }
  return args
}

// ── 主面板 ───────────────────────────────────────────────────────────────

export function ImageDesignPanel({ api }: { api: ImageDesignApi }): ReactNode {
  const s = useClientState()
  useRunImages(api)
  // busy 时的秒级心跳：驱动「生成中 · Ns」的耗时显示
  useEffect(() => {
    if (!s.busy) return
    const timer = setInterval(() => { setState({ now: Date.now() }) }, 1000)
    return () => { clearInterval(timer) }
  }, [s.busy])

  const elapsed = s.busy && s.startedAt !== null ? Math.max(0, Math.round((s.now - s.startedAt) / 1000)) : null

  const doGenerate = async (): Promise<void> => {
    if (getState().busy) return
    let args: GenerateWireArgs
    try {
      args = buildWireArgs(getState().form)
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) })
      return
    }
    setState({ busy: true, startedAt: Date.now(), error: '', tab: 'generate', selection: [], compareOpen: false })
    try {
      const run = await api.generate(args)
      setState({
        busy: false,
        startedAt: null,
        run,
        selection: [],
        compareOpen: false,
        error: run.status === 'partial'
          ? `部分失败：成功 ${run.successCount} 张，失败 ${run.failedCount} 张${run.message !== undefined ? '；' + run.message : ''}`
          : run.status === 'failed' || run.status === 'timeout'
            ? (run.message ?? '生成失败')
            : '',
      })
    } catch (e) {
      setState({ busy: false, startedAt: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="idi-root">
      <div className="idi-bar">
        <SegmentedControl
          id="idi-tab"
          label="视图"
          value={s.tab}
          options={[
            { value: 'generate', label: '生成' },
            { value: 'mannequin', label: '素体' },
            { value: 'history', label: '历史' },
          ]}
          onChange={(v) => { setState({ tab: v }); }}
        />
        <span className="idi-spacer" />
        {s.busy && (
          <span className="idi-row">
            <Spinner />
            {elapsed !== null && <span className="idi-meta">生成中 · {elapsed}s</span>}
          </span>
        )}
      </div>
      {s.error !== '' && (
        <div className="idi-error" role="alert">
          <IconWarningOutlineRegular size={14} />
          <span className="idi-grow">{s.error}</span>
          <button type="button" className="idi-error-dismiss" aria-label="关闭错误提示"
            onClick={() => { setState({ error: '' }) }}>
            <IconCloseOutlineRegular size={12} />
          </button>
        </div>
      )}
      {s.tab === 'generate'
        ? <GenerateView api={api} onGenerate={() => { void doGenerate() }} />
        : s.tab === 'mannequin'
          ? <MannequinView api={api} />
          : <HistoryView api={api} />}
      {s.lightbox !== null && (
        <ImageLightbox
          src={s.lightbox.url}
          alt={s.lightbox.alt}
          labels={{ dialog: '图片预览', close: '关闭' }}
          onClose={() => { setState({ lightbox: null }) }}
        />
      )}
      {s.compareOpen && <CompareOverlay />}
    </div>
  )
}

// ── 生成视图（表单 + 当前轮结果）─────────────────────────────────────────

function GenerateView({ api, onGenerate }: { api: ImageDesignApi; onGenerate: () => void }): ReactNode {
  const s = useClientState()
  const f = s.form
  const isH3 = f.model === 'MiniMax-H3-Image'
  const canGenerate = !s.busy && f.prompt.trim() !== ''

  return (
    <div className="idi-body">
      <section className="idi-sec">
        <Textarea
          aria-label="图片描述"
          placeholder="描述要生成的图片。先写任务与主体，再补风格与细节；不想出现文字就明说「画面中不添加任何文字」"
          value={f.prompt}
          onChange={(e) => { patchForm({ prompt: e.target.value }) }}
          rows={4}
        />
        <div className="idi-row-wrap">
          <SegmentedControl
            id="idi-model"
            label="模型"
            value={f.model}
            options={[
              { value: 'image-01', label: 'image-01' },
              { value: 'MiniMax-H3-Image', label: 'H3-Image' },
            ]}
            onChange={(v: ModelKey) => { patchForm({ model: v, sizeMode: v === 'MiniMax-H3-Image' && f.sizeMode === 'pixels' ? 'exact' : f.sizeMode }) }}
          />
          <Tooltip label="image-01：标准接口，支持种子与主体参考；H3-Image：开源 SOTA，支持参考图编辑（1..16 张）与面积档" maxWidth={240}>
            <span className="idi-meta">模型说明</span>
          </Tooltip>
        </div>

        <div className="idi-row-wrap">
          <SegmentedControl
            id="idi-sizemode"
            label="尺寸"
            value={f.sizeMode}
            options={isH3
              ? [
                  { value: 'aspect', label: '比例' },
                  { value: 'exact', label: '精确' },
                ]
              : [
                  { value: 'aspect', label: '比例' },
                  { value: 'pixels', label: '像素' },
                ]}
            onChange={(v) => { patchForm({ sizeMode: v }) }}
          />
          {f.sizeMode === 'aspect' && (
            <>
              <Select
                aria-label="比例档"
                value={f.aspectRatio}
                onChange={(e) => { patchForm({ aspectRatio: e.target.value }) }}
                options={ASPECTS.map((a) => ({ value: a, label: a }))}
              />
              {isH3 && (
                <SegmentedControl
                  id="idi-area"
                  label="面积档"
                  value={f.area}
                  options={[
                    { value: '1K', label: '1K' },
                    { value: '2K', label: '2K' },
                    { value: '4K', label: '4K' },
                  ]}
                  onChange={(v) => { patchForm({ area: v }) }}
                />
              )}
            </>
          )}
          {f.sizeMode === 'exact' && (
            <Input
              aria-label="精确尺寸"
              placeholder="2720x1536"
              value={f.size}
              onChange={(e) => { patchForm({ size: e.target.value }) }}
              className="idi-w96"
            />
          )}
          {f.sizeMode === 'pixels' && (
            <>
              <Input
                aria-label="像素宽"
                placeholder="宽 512..2048"
                value={f.width}
                onChange={(e) => { patchForm({ width: e.target.value }) }}
                className="idi-w80"
              />
              <Input
                aria-label="像素高"
                placeholder="高 512..2048"
                value={f.height}
                onChange={(e) => { patchForm({ height: e.target.value }) }}
                className="idi-w80"
              />
            </>
          )}
        </div>

        <div className="idi-row-wrap">
          <Select
            aria-label="张数"
            value={String(f.n)}
            onChange={(e) => { patchForm({ n: Number(e.target.value) }) }}
            options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 张` }))}
          />
          {!isH3 && (
            <Input
              aria-label="随机种子"
              placeholder="seed（可复现）"
              value={f.seed}
              onChange={(e) => { patchForm({ seed: e.target.value }) }}
              className="idi-w96"
            />
          )}
        </div>

        {isH3 ? (
          <RefImagesSection />
        ) : (
          <SubjectRefSection />
        )}

        <div className="idi-row-wrap">
          {isH3 ? (
            <Switch
              label="提示词增强"
              checked={f.promptEnhance}
              onChange={(v) => { patchForm({ promptEnhance: v }) }}
              title="默认开。要完全控制模型读到的文字才关；关闭必须带显式尺寸"
            />
          ) : (
            <Switch
              label="提示词优化"
              checked={f.promptOptimizer}
              onChange={(v) => { patchForm({ promptOptimizer: v }) }}
            />
          )}
          {!isH3 && (
            <Switch
              label="AIGC 水印"
              checked={f.aigcWatermark}
              onChange={(v) => { patchForm({ aigcWatermark: v }) }}
            />
          )}
        </div>

        <div className="idi-row">
          <Button variant="primary" disabled={!canGenerate} onClick={onGenerate}>
            {s.busy ? '生成中…' : '生成'}
          </Button>
          <span className="idi-hint">
            接口非幂等：发出后即使关掉面板也会完成并计费，结果照常进历史。H3 最长可等 600 秒。
          </span>
        </div>
      </section>

      <RunSection />
    </div>
  )
}

function RefImagesSection(): ReactNode {
  const f = getState().form
  const addRef = (): void => {
    const cur = getState().form.refImages
    if (cur.length >= 16) return
    patchForm({ refImages: [...cur, ''] })
  }
  const setRef = (i: number, v: string): void => {
    const cur = getState().form.refImages
    patchForm({ refImages: cur.map((p, idx) => (idx === i ? v : p)) })
  }
  const removeRef = (i: number): void => {
    const cur = getState().form.refImages
    patchForm({ refImages: cur.filter((_, idx) => idx !== i) })
  }
  return (
    <div className="idi-sec">
      <div className="idi-row">
        <span className="idi-meta">参考图（H3 编辑模式，1..16 张）</span>
        <Button variant="ghost" onClick={addRef} disabled={f.refImages.length >= 16}>
          <IconPlusOutlineRegular size={12} /> 添加
        </Button>
      </div>
      <div className="idi-reflist">
        {f.refImages.map((p, i) => (
          <div className="idi-refrow" key={i}>
            <Input
              aria-label={`参考图 ${i + 1} 路径`}
              placeholder={i === 0 ? '底图路径（保留构图）' : '参考路径（风格 / 配色 / 人物）'}
              value={p}
              onChange={(e) => { setRef(i, e.target.value) }}
            />
            <Button variant="ghost" aria-label={`移除参考图 ${i + 1}`} onClick={() => { removeRef(i) }}>
              <IconCloseOutlineRegular size={12} />
            </Button>
          </div>
        ))}
      </div>
      {f.refImages.length >= 2 && (
        <span className="idi-hint">多张参考图请在 prompt 里写清分工（如「图1保留构图，图2参考配色」）。</span>
      )}
    </div>
  )
}

function SubjectRefSection(): ReactNode {
  const f = getState().form
  return (
    <Input
      aria-label="主体参考图"
      placeholder="主体参考图路径（type=character，可留空）"
      value={f.subjectRefImage}
      onChange={(e) => { patchForm({ subjectRefImage: e.target.value }) }}
    />
  )
}

// ── 当前轮结果 ───────────────────────────────────────────────────────────

function RunSection(): ReactNode {
  const s = useClientState()
  const run = s.run
  if (run === null) {
    return (
      <Empty>
        <EmptyTitle>还没有生成记录</EmptyTitle>
        <EmptyDescription>填好描述与参数后点「生成」。生成的图片会自动落盘归档，可在历史里回看。</EmptyDescription>
      </Empty>
    )
  }
  const images = run.images
  const selectable = images.filter((img) => img.file !== '')
  return (
    <section className="idi-sec">
      <div className="idi-runmeta">
        <Tag tone={STATUS_TONE[run.status]}>{STATUS_TEXT[run.status]}</Tag>
        <span>{run.model}</span>
        <span>{formatTime(run.createdAt)}</span>
        {run.elapsedMs !== undefined && <span>{(run.elapsedMs / 1000).toFixed(1)}s</span>}
        {run.usage !== undefined && (
          <span>tokens {run.usage.totalTokens ?? '?'}（出 {run.usage.outputTokens ?? '?'}）</span>
        )}
        <span className="idi-spacer" />
        {selectable.length >= 2 && (
          <Button
            variant="outline"
            disabled={s.selection.length < 2}
            onClick={() => { setState({ compareOpen: true }) }}
          >
            对比（{s.selection.length}）
          </Button>
        )}
      </div>
      {run.prompt !== '' && <div className="idi-meta">prompt：{run.prompt}</div>}
      {images.length === 0 && <div className="idi-meta">本轮没有产出文件。</div>}
      <div className="idi-grid">
        {images.map((img, i) => (
          <ImageCell key={img.file === '' ? `fail-${i}` : img.file} run={run} img={img} />
        ))}
      </div>
      {run.message !== undefined && <div className="idi-meta">{run.message}</div>}
    </section>
  )
}

function ImageCell({ run, img }: { run: RunView; img: { file: string; size?: string; revisedPrompt?: string; error?: string } }): ReactNode {
  const s = useClientState()
  if (img.file === '') {
    return (
      <div className="idi-cell">
        <div className="idi-cell-fail">{img.error ?? '该张未产出'}</div>
      </div>
    )
  }
  const k = IMAGE_KEY(run.id, img.file)
  const url = s.urls[k]
  const broken = s.broken[k] === true
  const selected = s.selection.includes(k)
  return (
    <div className="idi-cell" data-selected={selected}>
      <div className="idi-cell-head">
        <input
          type="checkbox"
          className="idi-check"
          aria-label="选中以对比"
          checked={selected}
          onChange={() => { toggleSelect(k) }}
        />
        {img.size !== undefined && <Tag tone="neutral">{img.size}</Tag>}
        {broken && <Tag tone="danger">读图失败</Tag>}
      </div>
      {url !== undefined ? (
        <button
          type="button"
          className="idi-thumb"
          aria-label="放大查看"
          onClick={() => { setState({ lightbox: { url, alt: img.file } }) }}
        >
          <img src={url} alt={img.file} style={{ width: '100%', borderRadius: 'var(--dsw-radius-sm)', display: 'block' }} />
        </button>
      ) : (
        <div className="idi-cell-fail">{broken ? '读取失败' : <Spinner />}</div>
      )}
      <RevisedFold text={img.revisedPrompt} />
    </div>
  )
}

function RevisedFold({ text }: { text?: string }): ReactNode {
  const [open, setOpen] = useState(false)
  if (text === undefined) return null
  return (
    <>
      <button type="button" className="idi-revised-toggle" onClick={() => { setOpen(!open) }}>
        {open ? '收起 revised_prompt' : '展开 revised_prompt'}
      </button>
      {open && <div className="idi-revised">{text}</div>}
    </>
  )
}

function toggleSelect(k: string): void {
  const cur = getState().selection
  const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]
  setState({ selection: next.slice(-4) })
}

// ── 对比浮层 ─────────────────────────────────────────────────────────────

function CompareOverlay(): ReactNode {
  const s = useClientState()
  const run = s.run
  if (run === null) return null
  const picked: Array<{ img: RunView['images'][number]; url: string }> = []
  for (const k of s.selection) {
    const file = k.slice(k.indexOf('/') + 1)
    const img = run.images.find((i) => i.file === file)
    const url = s.urls[k]
    if (img !== undefined && url !== undefined) picked.push({ img, url })
  }
  if (picked.length < 2) return null
  return (
    <div className="idi-compare" role="dialog" aria-label="结果对比">
      <div className="idi-compare-head">
        <span>对比 {picked.length} 张</span>
        <span className="idi-hint">点击缩略图可放大单张</span>
        <span className="idi-spacer" />
        <Button variant="ghost" onClick={() => { setState({ compareOpen: false }) }}>
          <IconCloseOutlineRegular size={12} /> 关闭
        </Button>
      </div>
      <div className="idi-compare-body">
        {picked.map(({ img, url }) => (
          <div className="idi-compare-col" key={img.file}>
            <div className="idi-compare-img">
              {url !== undefined && (
                <button type="button" className="idi-thumb" aria-label="放大查看"
                  onClick={() => { setState({ lightbox: { url, alt: img.file } }) }}>
                  <img src={url} alt={img.file} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                </button>
              )}
            </div>
            <div className="idi-row-wrap">
              {img.size !== undefined && <Tag tone="neutral">{img.size}</Tag>}
              <span className="idi-meta">{img.file}</span>
            </div>
            {img.revisedPrompt !== undefined && <div className="idi-revised">{img.revisedPrompt}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 历史视图 ─────────────────────────────────────────────────────────────

function HistoryView({ api }: { api: ImageDesignApi }): ReactNode {
  const s = useClientState()
  useEffect(() => {
    void reloadHistory(api)
  }, [api])

  const openRun = async (id: string): Promise<void> => {
    try {
      const run = await api.readRun(id)
      setState({ run, tab: 'generate', selection: [], compareOpen: false, error: '' })
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  const removeRun = async (id: string): Promise<void> => {
    try {
      await api.deleteRun(id)
      if (getState().run?.id === id) setState({ run: null })
      await reloadHistory(api)
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  if (s.historyLoading && s.history.length === 0) {
    return (
      <div className="idi-body">
        <div className="idi-row"><Spinner /><span className="idi-meta">加载历史…</span></div>
      </div>
    )
  }
  if (s.history.length === 0) {
    return (
      <div className="idi-body">
        <Empty>
          <EmptyTitle>历史为空</EmptyTitle>
          <EmptyDescription>生成过的轮次会按时间倒序出现在这里。</EmptyDescription>
        </Empty>
      </div>
    )
  }
  return (
    <div className="idi-body">
      <div className="idi-row">
        <span className="idi-meta">{s.history.length} 轮</span>
        <span className="idi-spacer" />
        <Button variant="ghost" onClick={() => { void reloadHistory(api) }}>
          <IconRefreshOutlineRegular size={12} /> 刷新
        </Button>
      </div>
      <div className="idi-hist">
        {s.history.map((r) => (
          <div key={r.id}>
            <button type="button" className="idi-hist-row" onClick={() => { void openRun(r.id) }}>
              <div className="idi-hist-main">
                <Tag tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Tag>
                <Tag tone="neutral">{r.model === 'MiniMax-H3-Image' ? 'H3' : 'image-01'}</Tag>
                <span className="idi-meta">{formatTime(r.createdAt)}</span>
                <span className="idi-spacer" />
                <span className="idi-meta">
                  {r.successCount > 0 ? `${r.successCount} 张` : ''}{r.failedCount > 0 ? ` · 失败 ${r.failedCount}` : ''}
                </span>
                <span
                  role="button"
                  aria-label={`删除 ${r.id}`}
                  className="idi-error-dismiss"
                  onClick={(e) => { e.stopPropagation(); void removeRun(r.id) }}
                >
                  <IconCloseOutlineRegular size={12} />
                </span>
              </div>
              <span className="idi-hist-prompt">{r.prompt}</span>
            </button>
          </div>
        ))}
      </div>
      <Separator />
      <span className="idi-hint">点一轮载入「生成」页查看大图与对比；删除会连同落盘文件一起移除。</span>
    </div>
  )
}

async function reloadHistory(api: ImageDesignApi): Promise<void> {
  setState({ historyLoading: true })
  try {
    const runs = await api.listRuns()
    setState({ history: runs, historyLoading: false })
  } catch (e) {
    setState({ historyLoading: false, error: e instanceof Error ? e.message : String(e) })
  }
}

// ── 图片字节加载（run 变化后把缺失的产物读成 blob URL）─────────────────────

function useRunImages(api: ImageDesignApi): void {
  const s = useClientState()
  const run = s.run
  useEffect(() => {
    if (run === null) return
    const runId = run.id
    const missing = run.images.filter((img) => img.file !== ''
      && getState().urls[IMAGE_KEY(runId, img.file)] === undefined
      && getState().broken[IMAGE_KEY(runId, img.file)] === undefined)
    if (missing.length === 0) return
    let cancelled = false
    void (async () => {
      for (const img of missing) {
        try {
          const { bytes, mime } = await api.readImage(runId, img.file)
          if (cancelled) return
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
          setState({ urls: { ...getState().urls, [IMAGE_KEY(runId, img.file)]: url } })
        } catch {
          if (cancelled) return
          setState({ broken: { ...getState().broken, [IMAGE_KEY(runId, img.file)]: true } })
        }
      }
    })()
    return () => { cancelled = true }
  }, [api, run])
}

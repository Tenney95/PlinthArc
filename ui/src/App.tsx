import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowDownToLine, ArrowRight, CircleAlert, Clock3, Compass, Dice5, FolderOpen,
  Image as ImageIcon, Layers3, Plus, RefreshCw, Settings2, Sparkles, X,
} from 'lucide-react'
import { chooseDirectory, isDesktop } from './desktop'
import { ResultCanvas, type CanvasItem } from './ResultCanvas'
import './styles.css'

type SettingsInput = { model_dir: string; output_dir: string; backend: string }
type Settings = SettingsInput & { engine: string; model_ready?: boolean; engine_ready?: boolean }
type Generation = { prompt: string; width: number; height: number; steps: number; seed: number; offload_to_cpu: boolean }
type Run = {
  id: string
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  error?: string | null
  request?: Generation
  report?: { generation?: Omit<Generation, 'offload_to_cpu'>; offload_to_cpu?: boolean; engine_ms?: number } | null
}
type Draft = { prompt: string; width: string; height: string; steps: string; seed: string; offload_to_cpu: boolean }
type View = 'create' | 'history'
type Submission = { body: string; key: string }

const API = '/api/v1'
const draftKey = 'plintharc-draft'
const submissionKey = 'plintharc-submission'
const defaultDraft: Draft = { prompt: '', width: '512', height: '512', steps: '8', seed: '42', offload_to_cpu: false }
const defaultSettings: Settings = { model_dir: '', output_dir: '', engine: '', backend: 'cpu' }
const statuses: Record<Run['status'], string> = {
  running: '生成中', succeeded: '已完成', failed: '失败', interrupted: '已中断',
}
const statusTones: Record<Run['status'], string> = {
  running: 'primary', succeeded: 'success', failed: 'danger', interrupted: 'warning',
}

function readLocal<T>(key: string): T | null {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}

function writeLocal(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 禁用本地存储时，当前页面里的草稿仍可使用。
  }
}

function initialDraft(): Draft {
  const saved = readLocal<Partial<Draft>>(draftKey)
  return {
    prompt: typeof saved?.prompt === 'string' ? saved.prompt : defaultDraft.prompt,
    width: typeof saved?.width === 'string' ? saved.width : defaultDraft.width,
    height: typeof saved?.height === 'string' ? saved.height : defaultDraft.height,
    steps: typeof saved?.steps === 'string' ? saved.steps : defaultDraft.steps,
    seed: typeof saved?.seed === 'string' ? saved.seed : defaultDraft.seed,
    offload_to_cpu: saved?.offload_to_cpu === true,
  }
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${route}`, { cache: 'no-store', ...init })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined
    throw new RequestError(response.status, typeof error === 'string' && error ? error : `请求失败（HTTP ${response.status}）`)
  }
  if (data === null) throw new Error('服务返回了无效的数据')
  return data as T
}

function errorText(error: unknown): string {
  if (error instanceof TypeError) return '无法连接本地服务，请确认服务正在运行。'
  return error instanceof Error ? error.message : '发生未知错误'
}

function runRoute(id: string): string {
  return `/runs/${encodeURIComponent(id)}`
}

function runTitle(run: Run): string {
  return (run.request ?? run.report?.generation)?.prompt || '图像生成'
}

function runSize(run: Run): string {
  const generation = run.report?.generation ?? run.request
  return generation ? `${generation.width} × ${generation.height}` : ''
}

function runImage(run: Run): string {
  return `${API}${runRoute(run.id)}/image`
}

function Notice({ children, tone = 'danger' }: { children: ReactNode; tone?: 'danger' | 'warning' }) {
  return <div className={`notice ui-alert ui-alert--${tone}`} role="alert">
    <CircleAlert className="ui-alert__icon" size={15} /><div className="ui-alert__body">{children}</div>
  </div>
}

function Status({ value }: { value: Run['status'] }) {
  return <span className={`run-status ui-badge ui-badge--${statusTones[value]}`} data-status={value}>
    <i className="ui-badge__dot" />{statuses[value]}
  </span>
}

function SettingsDialog({ initial, onClose, onSaved }: { initial: Settings; onClose(): void; onSaved(value: Settings): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<SettingsInput>({ model_dir: initial.model_dir, output_dir: initial.output_dir, backend: initial.backend })
  const [saving, setSaving] = useState(false)
  const [selecting, setSelecting] = useState<keyof SettingsInput | null>(null)
  const [error, setError] = useState('')
  const desktop = isDesktop()

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal()
  }, [])

  async function browse(key: 'model_dir' | 'output_dir') {
    setError('')
    setSelecting(key)
    try {
      const path = await chooseDirectory()
      if (path) setDraft((current) => ({ ...current, [key]: path }))
    } catch (error) {
      setError(errorText(error))
    } finally {
      setSelecting(null)
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const saved = await request<Settings>('/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      })
      onSaved(saved)
      onClose()
    } catch (error) {
      setError(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  return <dialog className="settings-dialog ui-dialog-surface" ref={dialog} aria-labelledby="settings-title" onCancel={(event) => {
    event.preventDefault()
    if (!saving && !selecting) onClose()
  }}>
    <div className="dialog-heading ui-card__header"><div className="heading-icon"><Settings2 size={18} /></div><h2 id="settings-title" className="ui-card__title">本地设置</h2>
      <button className="icon-button ui-icon-btn" type="button" onClick={onClose} disabled={saving || Boolean(selecting)} aria-label="关闭设置"><X size={17} /></button>
    </div>
    <form className="settings-form" onSubmit={save}>
      {([['model_dir', '模型目录', '包含 model.json 的绝对路径'], ['output_dir', '输出目录', '用于保存图片的绝对路径']] as const).map(([key, label, placeholder]) =>
        <div className="field ui-field" key={key}>
          <label className="ui-label" htmlFor={key}>{label}</label>
          <div className="path-field">
            <input className="ui-input" id={key} placeholder={placeholder} value={draft[key]} required spellCheck={false}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
            {desktop && <button type="button" className="quiet-button ui-btn ui-btn--secondary" onClick={() => void browse(key)} disabled={saving || Boolean(selecting)}>
              {selecting === key ? <span className="ui-spinner" aria-hidden="true" /> : <FolderOpen size={15} />}选择
            </button>}
          </div>
        </div>)}
      <div className="field ui-field"><label className="ui-label" htmlFor="engine">推理引擎</label>
        <input className="ui-input" id="engine" readOnly value={initial.engine} placeholder="未配置 sd-cli" spellCheck={false} />
        <p className="field-hint ui-hint">{desktop ? '通过启动环境的 PLINTHARC_ENGINE 设置。' : '通过服务启动参数 --engine 设置。'}</p>
      </div>
      <div className="field ui-field"><label className="ui-label" htmlFor="backend">计算设备</label>
        <input className="ui-input" id="backend" value={draft.backend} required spellCheck={false} placeholder="如 cpu、MTL0 或 CUDA0"
          onChange={(event) => setDraft({ ...draft, backend: event.target.value })} />
        <p className="field-hint ui-hint">设备名称以 sd-cli --list-devices 输出为准。</p>
      </div>
      {error && <Notice>{error}</Notice>}
      <div className="dialog-actions"><button type="button" className="quiet-button ui-btn ui-btn--secondary" onClick={onClose} disabled={saving || Boolean(selecting)}>取消</button>
        <button type="submit" className="primary-button ui-btn ui-btn--primary" disabled={saving || Boolean(selecting)}>{saving && <span className="ui-spinner" aria-hidden="true" />}保存设置</button></div>
    </form>
  </dialog>
}

function RunList({ runs, selectedId, onSelect, refreshing, onRefresh }: {
  runs: Run[]; selectedId: string | null; onSelect(id: string): void; refreshing: boolean; onRefresh(): void
}) {
  return <>
    <div className="panel-heading ui-card__header"><Clock3 size={17} /><h2 className="ui-card__title">运行历史</h2>
      <button type="button" className="icon-button ui-icon-btn" onClick={onRefresh} disabled={refreshing} aria-label="刷新历史" title="刷新历史">{refreshing ? <span className="ui-spinner" aria-hidden="true" /> : <RefreshCw size={15} />}</button></div>
    {runs.length ? <ul className="run-list">
      {runs.map((run) => <li key={run.id}>
        <button type="button" className={`run-row ui-card ui-card--interactive${run.id === selectedId ? ' is-selected' : ''}`} aria-pressed={run.id === selectedId} onClick={() => onSelect(run.id)}>
          <div className="run-thumb">{run.status === 'succeeded' ? <img src={runImage(run)} alt="" loading="lazy" /> : <ImageIcon size={17} />}</div>
          <div className="run-row-body"><strong title={runTitle(run)}>{runTitle(run)}</strong><span>{runSize(run) || '单张图片'}</span></div>
          <Status value={run.status} />
        </button>
      </li>)}
    </ul> : <div className="panel-empty ui-empty"><p className="ui-empty__desc">暂无运行记录</p></div>}
  </>
}

function SelectedRun({ run, onReuse }: { run: Run; onReuse(): void }) {
  const generation = run.report?.generation ?? run.request
  return <section className="run-inspector" aria-labelledby="run-inspector-title">
    <div className="run-inspector-heading"><h3 id="run-inspector-title" className="ui-card__title">运行详情</h3><Status value={run.status} /></div>
    {generation && <dl className="run-data">
      <div><dt>尺寸</dt><dd>{runSize(run)}</dd></div>
      <div><dt>种子</dt><dd>{generation.seed}</dd></div>
      {typeof run.report?.engine_ms === 'number' && <div><dt>推理耗时</dt><dd>{(run.report.engine_ms / 1000).toFixed(1)} 秒</dd></div>}
    </dl>}
    {run.error && <Notice>{run.error}</Notice>}
    {generation && <div className="run-inspector-actions">
      <button type="button" className="quiet-button ui-btn ui-btn--secondary" onClick={onReuse}><ArrowRight size={14} />用这些设置</button>
      {run.status === 'succeeded' && <a className="quiet-button ui-btn ui-btn--secondary" href={runImage(run)} download="PlinthArc.png"><ArrowDownToLine size={14} />下载图片</a>}
    </div>}
  </section>
}

export default function App() {
  const [view, setView] = useState<View>('create')
  const [draft, setDraft] = useState(initialDraft)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [runs, setRuns] = useState<Run[]>([])
  const [historyReady, setHistoryReady] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [pollError, setPollError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [pending, setPending] = useState(() => readLocal<Submission>(submissionKey))
  const promptInput = useRef<HTMLTextAreaElement>(null)

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await request<Settings>('/settings', { signal })
      if (!signal?.aborted) {
        setSettings(next)
        setSettingsError('')
      }
    } catch (error) {
      if (!signal?.aborted) setSettingsError(errorText(error))
    }
  }, [])

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true)
    try {
      const next = await request<Run[]>('/runs', { signal })
      if (!signal?.aborted) {
        setRuns((current) => next.map((run) => {
          const existing = current.find((item) => item.id === run.id)
          return run.status === 'running' && existing && existing.status !== 'running' ? existing : run
        }))
        setHistoryError('')
        setHistoryReady(true)
        setSelectedId((current) => current && next.some((run) => run.id === current) ? current : next[0]?.id ?? null)
      }
    } catch (error) {
      if (!signal?.aborted) {
        setHistoryReady(false)
        setHistoryError(errorText(error))
      }
    } finally {
      if (!signal?.aborted) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadSettings(controller.signal)
    void loadRuns(controller.signal)
    return () => controller.abort()
  }, [loadSettings, loadRuns])

  useEffect(() => { writeLocal(draftKey, draft) }, [draft])

  const runningIds = runs.filter((run) => run.status === 'running').map((run) => run.id).join(',')
  useEffect(() => {
    if (!runningIds) return
    const controller = new AbortController()
    const ids = runningIds.split(',')
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const results = await Promise.allSettled(ids.map((id) => request<Run>(runRoute(id), { signal: controller.signal })))
      if (controller.signal.aborted) return
      const updated = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
      setRuns((current) => current.map((run) => run.status === 'running'
        ? updated.find((next) => next.id === run.id) ?? run
        : run))
      setPollError(updated.length === ids.length ? '' : '运行状态读取中断，正在重试。')
      timer = setTimeout(() => void poll(), 1200)
    }
    timer = setTimeout(() => void poll(), 1200)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [runningIds])

  const selected = runs.find((run) => run.id === selectedId)
  const modelReady = Boolean(settings?.model_dir) && settings?.model_ready !== false
  const engineReady = Boolean(settings?.engine) && settings?.engine_ready !== false
  const configured = modelReady && engineReady && Boolean(settings?.output_dir && settings.backend)
  const busy = submitting || Boolean(runningIds)
  const generation: Generation = {
    prompt: draft.prompt, width: Number(draft.width), height: Number(draft.height),
    steps: Number(draft.steps), seed: Number(draft.seed), offload_to_cpu: draft.offload_to_cpu,
  }
  const body = JSON.stringify(generation)
  const confirming = pending?.body === body
  const canSubmit = !settingsError && historyReady && !refreshing && !submitting && Boolean(draft.prompt.trim())
    && (confirming || (configured && !runningIds))
  const connection = settingsError || historyError ? 'offline' : settings && historyReady ? 'online' : 'connecting'
  const items: CanvasItem[] = runs.map((run) => ({
    id: run.id,
    title: runTitle(run),
    status: statuses[run.status],
    detail: runSize(run),
    imageUrl: run.status === 'succeeded' ? runImage(run) : undefined,
  }))

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    const key = confirming && pending.key ? pending.key : crypto.randomUUID()
    const submission = { body, key }
    setPending(submission)
    writeLocal(submissionKey, submission)
    setSubmitting(true)
    setSubmitError('')
    try {
      const run = await request<Run>('/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body,
      })
      setPending(null)
      writeLocal(submissionKey, null)
      setRuns((current) => {
        const known = current.find((item) => item.id === run.id)
        const latest = known && known.status !== 'running' && run.status === 'running' ? known : run
        return [latest, ...current.filter((item) => item.id !== run.id)]
      })
      setSelectedId(run.id)
    } catch (error) {
      if (error instanceof RequestError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        setPending(null)
        writeLocal(submissionKey, null)
        setSubmitError(errorText(error))
      } else {
        setSubmitError('未收到提交回执。再次确认会沿用同一次提交。')
      }
      await loadRuns()
    } finally {
      setSubmitting(false)
    }
  }

  function reuse(run: Run) {
    const generation = run.report?.generation ?? run.request
    if (!generation) return
    setDraft({
      prompt: generation.prompt, width: String(generation.width), height: String(generation.height),
      steps: String(generation.steps), seed: String(generation.seed),
      offload_to_cpu: run.report?.offload_to_cpu ?? run.request?.offload_to_cpu ?? false,
    })
    setSubmitError('')
    setView('create')
  }

  function retryConnection() {
    void loadSettings()
    void loadRuns()
  }

  return <div className="app-shell">
    <header className="app-bar">
      <div className="wordmark"><span className="brand-mark"><Layers3 size={17} /></span><h1>PlinthArc</h1></div>
      <nav className="view-switch ui-segmented" aria-label="工作区">
        <button className={`ui-segmented__item${view === 'create' ? ' is-active' : ''}`} type="button" aria-pressed={view === 'create'} onClick={() => setView('create')}><Compass size={15} />创作</button>
        <button className={`ui-segmented__item${view === 'history' ? ' is-active' : ''}`} type="button" aria-pressed={view === 'history'} onClick={() => setView('history')}><Clock3 size={15} />历史</button>
      </nav>
      <div className="app-actions">
        <span className={`connection ui-badge ui-badge--${connection === 'online' ? 'success' : connection === 'offline' ? 'danger' : 'outline'}`} data-state={connection}><i className="ui-badge__dot" />{connection === 'online' ? '本地服务' : connection === 'offline' ? '未连接' : '连接中'}</span>
        <button className="icon-button ui-icon-btn" type="button" title="打开设置" aria-label="打开设置" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /></button>
      </div>
    </header>
    <main className="workspace">
      <section className="canvas-panel" aria-label="结果画布">
        <div className="canvas-heading ui-card"><ImageIcon size={15} />结果画布</div>
        <ResultCanvas items={items} selectedId={selectedId} onSelect={setSelectedId} busy={busy} empty={
          <div className="canvas-empty ui-empty">
            <ImageIcon className="ui-empty__icon" size={25} strokeWidth={1.55} />
            <h2 className="ui-empty__title">{busy ? '正在生成图片' : '开始创作'}</h2>
            <p className="ui-empty__desc">{busy ? '完成后，图片会出现在画布中。' : configured ? '输入提示词，生成你的第一张图片。' : '设置模型和输出目录后即可生成图片。'}</p>
            {!busy && <button type="button" className="quiet-button ui-btn ui-btn--secondary" onClick={() => {
              if (!configured) setSettingsOpen(true)
              else { setView('create'); requestAnimationFrame(() => promptInput.current?.focus()) }
            }}>{configured ? <Plus size={15} /> : <Settings2 size={15} />}{configured ? '输入提示词' : '打开设置'}</button>}
          </div>
        } />
      </section>
      <aside className="side-panel" data-view={view} aria-label={view === 'create' ? '图像生成' : '运行历史'}>
        {view === 'create' ? <>
          <div className="panel-heading ui-card__header"><Sparkles size={17} /><h2 className="ui-card__title">图像生成</h2></div>
          <form className="generation-form" onSubmit={submit} onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (canSubmit) event.currentTarget.requestSubmit()
            }
          }}>
            <div className="model-field ui-card">
              <span className="model-icon"><ImageIcon size={17} /></span>
              <span><strong className="ui-card__title">Z-Image-Turbo</strong><small className="ui-card__desc">{settings?.backend ? `计算设备 · ${settings.backend}` : '本地图像模型'}</small></span>
              {modelReady && <span className="model-ready ui-badge ui-badge--success" title="模型已就绪"><i className="ui-badge__dot" />就绪</span>}
            </div>
            <div className="field prompt-field ui-field"><label className="ui-label" htmlFor="prompt">提示词</label>
              <textarea className="ui-textarea" ref={promptInput} id="prompt" rows={6} placeholder="描述画面中的主体、构图和风格…" value={draft.prompt}
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} required />
            </div>
            <div className="field-grid">
              {([['width', '宽度', 64, 2048, 32], ['height', '高度', 64, 2048, 32], ['steps', '步数', 1, 50, 1], ['seed', '种子', 0, 4294967295, 1]] as const).map(([key, label, min, max, step]) =>
                <div className="field ui-field" key={key}>
                  <label className="ui-label" htmlFor={key}>{label}</label>
                  <div className={key === 'seed' ? 'number-field ui-input-group' : 'number-field'}><input className="ui-input" id={key} type="number" required min={min} max={max} step={step} value={draft[key]}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
                    {key === 'seed' && <button type="button" className="icon-button ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" title="随机种子" aria-label="随机种子"
                      onClick={() => setDraft({ ...draft, seed: String(crypto.getRandomValues(new Uint32Array(1))[0]) })}><Dice5 size={16} /></button>}
                  </div>
                </div>)}
            </div>
            <label className="toggle-label ui-label" htmlFor="offload-switch"><span id="offload-label">权重卸载到 CPU</span>
              <button type="button" id="offload-switch" className="ui-switch" role="switch" aria-labelledby="offload-label" aria-checked={draft.offload_to_cpu}
                onClick={() => setDraft({ ...draft, offload_to_cpu: !draft.offload_to_cpu })} />
            </label>
            {settings && !configured && <Notice tone="warning">
              {!engineReady ? '推理引擎尚未就绪。' : !modelReady ? '模型目录缺少可用的 model.json。' : '请设置计算设备与输出目录。'}
              <button className="link-button ui-btn ui-btn--link" type="button" onClick={() => setSettingsOpen(true)}>查看设置</button>
            </Notice>}
            {submitError && <Notice>{submitError}</Notice>}
            <button className="primary-button generate-button ui-btn ui-btn--primary ui-btn--lg ui-btn--block" type="submit" disabled={!canSubmit}>
              {busy ? <span className="ui-spinner" aria-hidden="true" /> : <Sparkles size={17} />}
              {submitting ? '提交中' : confirming ? '确认上次提交' : runningIds ? '生成中' : '生成图片'}
            </button>
          </form>
        </> : <RunList runs={runs} selectedId={selectedId} onSelect={setSelectedId} refreshing={refreshing || submitting} onRefresh={() => void loadRuns()} />}
        {(settingsError || historyError) && <div className="panel-notice"><Notice>{settingsError || historyError}
          <button type="button" className="link-button ui-btn ui-btn--link" onClick={retryConnection} disabled={refreshing}>重试连接</button>
        </Notice></div>}
        {Boolean(runningIds) && pollError && <div className="panel-notice"><Notice>{pollError}</Notice></div>}
        {selected && <SelectedRun run={selected} onReuse={() => reuse(selected)} />}
      </aside>
    </main>
    {settingsOpen && <SettingsDialog initial={settings ?? defaultSettings} onClose={() => setSettingsOpen(false)} onSaved={(saved) => {
      setSettings(saved); setSettingsError(''); setSubmitError('')
    }} />}
  </div>
}

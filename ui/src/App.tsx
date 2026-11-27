import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowDownToLine, ArrowRight, CircleAlert, Clock3, Dice5, FolderOpen,
  Image as ImageIcon, Layers3, Plus, RefreshCw, Settings2, Sparkles, X,
} from 'lucide-react'
import { chooseDirectory, isDesktop } from './desktop'
import { WorkflowCanvas, type WorkflowEndpoint } from './WorkflowCanvas'
import { WorkflowToolbar, type WorkflowView } from './WorkflowToolbar'
import { WorkspaceSelect } from './WorkspaceSelect'
import {
  asDraft, connect, initialImageId, loadWorkflow, makeNode, modelId, modelName, removeNode,
  updateImage, workflowKey, type Draft, type ImageNode, type WorkflowKind, type WorkflowNode,
} from './workflow'
import './styles.css'
import './WorkflowApp.css'

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
type Submission = { body: string; key: string; nodeId: string }

const API = '/api/v1'
const submissionKey = 'plintharc-submission'
const defaultSettings: Settings = { model_dir: '', output_dir: '', engine: '', backend: 'cpu' }
const modelOptions = [{ value: modelId, label: modelName }]
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

function initialSubmission(): Submission | null {
  const saved = readLocal<Partial<Submission>>(submissionKey)
  return typeof saved?.body === 'string' && typeof saved.key === 'string'
    ? { body: saved.body, key: saved.key, nodeId: saved.nodeId ?? initialImageId } : null
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
          <div className={desktop ? 'path-field ui-input-group' : 'path-field'}>
            <input className="ui-input" id={key} placeholder={placeholder} value={draft[key]} required spellCheck={false}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
            {desktop && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => void browse(key)} disabled={saving || Boolean(selecting)}>
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

const numberFields = [
  ['width', '宽度', 64, 2048, 32], ['height', '高度', 64, 2048, 32],
  ['steps', '步数', 1, 50, 1], ['seed', '种子', 0, 4294967295, 1],
] as const

function ImageNodePanel({
  node, run, canSubmit, confirming, submitting, issue, onDraft, onSubmit, onResult,
}: {
  node: ImageNode; run?: Run; canSubmit: boolean; confirming: boolean; submitting: boolean; issue: string
  onDraft(draft: Draft): void; onSubmit(event: FormEvent<HTMLFormElement>): void; onResult(run: Run): void
}) {
  const { draft } = node
  const working = submitting || run?.status === 'running'
  return <article className="workflow-node-content workflow-image-node">
    <div className="workflow-node__heading ui-card__header" data-workflow-drag-handle>
      <ImageIcon size={17} aria-hidden="true" />
      <h2 className="ui-card__title">图像生成</h2>
      {run && <Status value={run.status} />}
    </div>
    <div className="workflow-node__scroll" data-workflow-interactive>
      <form className="workflow-node__form" onSubmit={onSubmit}>
        <div className="ui-field">
          <label className="ui-label" htmlFor={`${node.id}-prompt`}>提示词</label>
          <textarea className="ui-textarea" id={`${node.id}-prompt`} placeholder="描述你想生成的画面"
            aria-label="提示词" value={draft.prompt} required={!confirming}
            onChange={(event) => onDraft({ ...draft, prompt: event.target.value })} />
        </div>
        <div className="field-grid">
          {numberFields.map(([key, label, min, max, step]) =>
            <div className="ui-field" key={key}>
              <label className="ui-label" htmlFor={`${node.id}-${key}`}>{label}</label>
              <div className={key === 'seed' ? 'number-field ui-input-group' : 'number-field'}>
                <input className="ui-input" id={`${node.id}-${key}`} type="number" required={!confirming}
                  min={min} max={max} step={step} value={draft[key]}
                  onChange={(event) => onDraft({ ...draft, [key]: event.target.value })} />
                {key === 'seed' && <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost"
                  title="随机种子" aria-label="随机种子"
                  onClick={() => onDraft({ ...draft, seed: String(crypto.getRandomValues(new Uint32Array(1))[0]) })}><Dice5 size={15} /></button>}
              </div>
            </div>)}
        </div>
        <div className="toggle-label ui-label">
          <span id={`${node.id}-offload-label`}>权重卸载到 CPU</span>
          <button type="button" className="ui-switch" role="switch" aria-labelledby={`${node.id}-offload-label`}
            aria-checked={draft.offload_to_cpu} onClick={() => onDraft({ ...draft, offload_to_cpu: !draft.offload_to_cpu })} />
        </div>
        <button className="ui-btn ui-btn--primary ui-btn--block" type="submit" formNoValidate={confirming} disabled={!canSubmit}>
          {working ? <span className="ui-spinner" aria-hidden="true" /> : <Sparkles size={15} />}
          {submitting ? '提交中' : confirming ? '确认上次提交' : working ? '生成中' : '生成图片'}
        </button>
        {issue && <Notice tone="warning">{issue}</Notice>}
      </form>
      {run?.status === 'succeeded' && <button type="button" className="workflow-node__result ui-btn ui-btn--secondary"
        onClick={() => onResult(run)} aria-label="查看生成结果">
        <img src={runImage(run)} alt="" loading="lazy" decoding="async" draggable={false} />
        <span>查看生成结果</span><ArrowRight size={14} aria-hidden="true" />
      </button>}
      {run?.error && <div className="workflow-node__error"><Notice>{run.error}</Notice></div>}
    </div>
  </article>
}

export default function App() {
  const [view, setView] = useState<WorkflowView>('create')
  const [graph, setGraph] = useState(() => loadWorkflow(readLocal(workflowKey), readLocal('plintharc-draft')))
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [runs, setRuns] = useState<Run[]>([])
  const [historyReady, setHistoryReady] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [pollError, setPollError] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [submittingNode, setSubmittingNode] = useState<string | null>(null)
  const submissionLock = useRef(false)
  const [submitError, setSubmitError] = useState<{ nodeId: string; message: string } | null>(null)
  const [pending, setPending] = useState(initialSubmission)
  const viewportCenter = useRef({ x: 445, y: 290 })

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
        setSelectedRunId((current) => current && next.some((run) => run.id === current) ? current : next[0]?.id ?? null)
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

  useEffect(() => { writeLocal(workflowKey, graph) }, [graph])

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

  const busy = Boolean(submittingNode || runningIds)
  const modelReady = Boolean(settings?.model_dir) && settings?.model_ready !== false
  const engineReady = Boolean(settings?.engine) && settings?.engine_ready !== false
  const configured = modelReady && engineReady && Boolean(settings?.output_dir && settings.backend)
  const connection = settingsError || historyError ? 'offline' : settings && historyReady ? 'online' : 'connecting'
  const savedRun = runs.find((run) => run.id === selectedRunId)
  const connectionMessage = settingsError || historyError || (runningIds && pollError)

  function hasModel(node: ImageNode) {
    return graph.edges.some((edge) => edge.target.nodeId === node.id)
  }

  function allowed(node: ImageNode) {
    if (settingsError || !historyReady || refreshing || submittingNode || !configured || !hasModel(node)) return false
    if (pending) return pending.nodeId === node.id
    return !runningIds && Boolean(node.draft.prompt.trim())
  }

  async function submit(event: FormEvent<HTMLFormElement>, node: ImageNode) {
    event.preventDefault()
    if (!allowed(node) || submissionLock.current) return
    const draft = node.draft
    const generation: Generation = {
      prompt: draft.prompt, width: Number(draft.width), height: Number(draft.height),
      steps: Number(draft.steps), seed: Number(draft.seed), offload_to_cpu: draft.offload_to_cpu,
    }
    const submission = pending ?? { body: JSON.stringify(generation), key: crypto.randomUUID(), nodeId: node.id }
    submissionLock.current = true
    setPending(submission)
    writeLocal(submissionKey, submission)
    setSubmittingNode(node.id)
    setSubmitError(null)
    try {
      const run = await request<Run>('/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission.key }, body: submission.body,
      })
      setPending(null)
      writeLocal(submissionKey, null)
      setRuns((current) => {
        const known = current.find((item) => item.id === run.id)
        const latest = known && known.status !== 'running' && run.status === 'running' ? known : run
        return [latest, ...current.filter((item) => item.id !== run.id)]
      })
      setGraph((current) => updateImage(current, node.id, { runId: run.id }))
      setSelectedRunId(run.id)
    } catch (error) {
      if (error instanceof RequestError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        setPending(null)
        writeLocal(submissionKey, null)
        setSubmitError({ nodeId: node.id, message: errorText(error) })
      } else {
        setSubmitError({ nodeId: node.id, message: '未收到提交回执。再次确认会沿用同一次提交。' })
      }
      await loadRuns()
    } finally {
      submissionLock.current = false
      setSubmittingNode(null)
    }
  }

  function addNode(kind: WorkflowKind, draft?: Draft) {
    const { x, y } = viewportCenter.current
    const offset = ((graph.nodes.length % 4) - 1) * 26
    const node = makeNode(kind, crypto.randomUUID(), { x: x - 130 + offset, y: y - 90 + offset }, draft)
    setGraph((current) => ({ ...current, nodes: [...current.nodes, node] }))
    setSelectedNodeId(node.id)
    setView('create')
  }

  function reuse(run: Run) {
    const generation = run.report?.generation ?? run.request
    if (!generation) return
    const draft = asDraft({
      ...generation, width: String(generation.width), height: String(generation.height),
      steps: String(generation.steps), seed: String(generation.seed),
      offload_to_cpu: run.report?.offload_to_cpu ?? run.request?.offload_to_cpu,
    })
    const image = graph.nodes.find((node) => node.kind === 'image' && node.id === selectedNodeId)
      ?? graph.nodes.find((node) => node.kind === 'image')
    if (image) {
      setGraph((current) => updateImage(current, image.id, { draft }))
      setSelectedNodeId(image.id)
      setView('create')
    } else addNode('image', draft)
    setSubmitError(null)
  }

  const onViewportChange = useCallback((center: { x: number; y: number }) => {
    viewportCenter.current = center
  }, [])

  function onConnect(source: WorkflowEndpoint, target: WorkflowEndpoint) {
    setGraph((current) => connect(current, source, target))
  }

  function deleteSelected() {
    if (!selectedNodeId || pending?.nodeId === selectedNodeId || submittingNode === selectedNodeId) return
    setGraph((current) => removeNode(current, selectedNodeId))
    setSelectedNodeId(null)
  }

  function renderNode(node: WorkflowNode) {
    if (node.kind === 'model') return <article className="workflow-node-content workflow-model-node">
      <div className="workflow-node__heading ui-card__header" data-workflow-drag-handle>
        <Layers3 size={17} aria-hidden="true" /><h2 className="ui-card__title">模型</h2>
      </div>
      <div className="workflow-model-node__body">
        <div className="ui-field">
          <label className="ui-label" htmlFor={`model-${node.id}`}>选择模型</label>
          <WorkspaceSelect id={`model-${node.id}`} label="选择模型" value={node.model} options={modelOptions} />
        </div>
        {modelReady
          ? <span className="ui-badge ui-badge--success"><i className="ui-badge__dot" />模型已就绪</span>
          : <button type="button" className="ui-btn ui-btn--link" onClick={() => setSettingsOpen(true)}>设置模型目录</button>}
      </div>
    </article>
    const run = runs.find((item) => item.id === node.runId)
    const issue = !hasModel(node) ? '将模型节点的输出连到此节点。'
      : settings && !configured ? '请检查模型、引擎和产物目录设置。'
        : submitError?.nodeId === node.id ? submitError.message : ''
    return <ImageNodePanel node={node} run={run} canSubmit={allowed(node)} issue={issue}
      submitting={submittingNode === node.id} confirming={pending?.nodeId === node.id}
      onDraft={(draft) => setGraph((current) => updateImage(current, node.id, { draft }))}
      onSubmit={(event) => void submit(event, node)}
      onResult={(result) => { setSelectedRunId(result.id); setView('history') }} />
  }

  return <main className="workflow-app">
    <WorkflowCanvas
      nodes={graph.nodes} edges={graph.edges} selectedId={selectedNodeId} renderNode={renderNode}
      busy={busy} onSelect={setSelectedNodeId} onViewportChange={onViewportChange}
      onMove={(id, point) => setGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...point } : node) }))}
      onConnect={onConnect}
      onRemoveEdge={(id) => setGraph((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== id) }))}
      empty={<div className="ui-empty"><p className="ui-empty__desc">从左侧添加模型或图像生成节点。</p></div>}
    />
    <header className="workflow-brand ui-card">
      <div className="wordmark"><span className="brand-mark"><Layers3 size={17} aria-hidden="true" /></span><h1>PlinthArc</h1></div>
      <span className={`connection ui-badge ui-badge--${connection === 'online' ? 'success' : connection === 'offline' ? 'danger' : 'outline'}`} data-state={connection}>
        <i className="ui-badge__dot" />{connection === 'online' ? '本地服务' : connection === 'offline' ? '未连接' : '连接中'}
      </span>
    </header>
    <WorkflowToolbar view={view} onChangeView={setView} onOpenSettings={() => setSettingsOpen(true)}
      onAddNode={(kind) => addNode(kind)} onDeleteSelected={deleteSelected}
      canDelete={Boolean(selectedNodeId && pending?.nodeId !== selectedNodeId && submittingNode !== selectedNodeId)} />
    {view === 'history' && <aside className="workflow-history side-panel ui-card" data-view="history" aria-label="运行历史">
      <button className="workflow-history__close ui-icon-btn ui-icon-btn--sm" type="button"
        onClick={() => setView('create')} aria-label="关闭历史"><X size={16} /></button>
      <RunList runs={runs} selectedId={selectedRunId} onSelect={setSelectedRunId} refreshing={refreshing}
        onRefresh={() => void loadRuns()} />
      {savedRun?.status === 'succeeded' && <img className="workflow-history__preview" src={runImage(savedRun)} alt="生成结果" loading="lazy" />}
      {savedRun && <SelectedRun run={savedRun} onReuse={() => reuse(savedRun)} />}
    </aside>}
    {connectionMessage && <div className="workflow-connection-notice"><Notice>{connectionMessage}
      <button type="button" className="link-button ui-btn ui-btn--link" disabled={refreshing}
        onClick={() => { void loadSettings(); void loadRuns() }}>重试连接</button>
    </Notice></div>}
    {settingsOpen && <SettingsDialog initial={settings ?? defaultSettings} onClose={() => setSettingsOpen(false)}
      onSaved={(saved) => { setSettings(saved); setSettingsError(''); setSubmitError(null) }} />}
  </main>
}

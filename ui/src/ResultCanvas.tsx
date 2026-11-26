import { zoomAt, type Camera, type GpuCanvas as CanvasInstance } from 'gpucanvas'
import { CanvasNode, GpuCanvas } from 'gpucanvas/react'
import { ChevronDown, Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import './ResultCanvas.css'

export type CanvasItem = {
  id: string
  title: string
  status: string
  imageUrl?: string
  detail?: string
}

type Props = {
  items: readonly CanvasItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  busy?: boolean
  empty?: ReactNode
}

const CAMERA_KEY = 'plintharc.result-camera'
const RENDERER_KEY = 'plintharc.result-renderer'
const START_CAMERA = { x: 0, y: 0, zoom: 1 }
const CARD_WIDTH = 212
const CARD_HEIGHT = 218
const CARD_GAP = 16

function readStored(key: string) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The canvas still works when storage is unavailable.
  }
}

function readCamera(): Camera {
  try {
    const saved = readStored(CAMERA_KEY)
    if (saved) {
      const { x, y, zoom } = JSON.parse(saved)
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zoom) && zoom >= 0.02 && zoom <= 16) {
        return { x, y, zoom }
      }
    }
  } catch {
    // A damaged view can be replaced with the default.
  }
  return START_CAMERA
}

export function ResultCanvas({ items, selectedId, onSelect, busy = false, empty }: Props) {
  const [initialCamera] = useState(readCamera)
  const [zoom, setZoom] = useState(() => Math.round(initialCamera.zoom * 100))
  const [renderer, setRenderer] = useState(() => readStored(RENDERER_KEY) === 'dom' ? 'dom' : 'auto')
  const [canvas, setCanvas] = useState<CanvasInstance | null>(null)
  const workspace = useRef<HTMLElement>(null)
  const camera = useRef(initialCamera)
  const saveTimer = useRef<number | undefined>(undefined)
  const mode = busy || renderer === 'dom' ? 'dom' : 'auto'

  useEffect(() => {
    function flushCamera() {
      window.clearTimeout(saveTimer.current)
      writeStored(CAMERA_KEY, JSON.stringify(camera.current))
    }

    window.addEventListener('pagehide', flushCamera)
    return () => {
      window.removeEventListener('pagehide', flushCamera)
      flushCamera()
    }
  }, [])

  function handleCamera(next: Camera) {
    camera.current = next
    setZoom(Math.round(next.zoom * 100))
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => writeStored(CAMERA_KEY, JSON.stringify(next)), 180)
  }

  function handleReady(instance: CanvasInstance) {
    if (instance.mode === 'gpu' && workspace.current) {
      instance.setBackground(getComputedStyle(workspace.current).backgroundColor)
    }
    instance.setCamera(camera.current)
    setCanvas(instance)
  }

  function zoomBy(factor: number) {
    if (canvas?.surface.isConnected) {
      const { clientWidth, clientHeight } = canvas.surface
      canvas.setCamera(zoomAt(canvas.getCamera(), clientWidth / 2, clientHeight / 2, factor))
    }
  }

  return (
    <section ref={workspace} className="result-canvas" aria-label="画布视口">
      <div className="result-canvas__stage">
        {items.length > 0 && (
          <GpuCanvas
            key={mode}
            className="result-canvas__host"
            mode={mode}
            background="transparent"
            atlasSize={2048}
            atlasLayers={3}
            onReady={handleReady}
            onCameraChange={handleCamera}
          >
            {items.map((item, index) => (
              <CanvasNode
                key={item.id}
                x={28 + (index % 3) * (CARD_WIDTH + CARD_GAP)}
                y={68 + Math.floor(index / 3) * (CARD_HEIGHT + CARD_GAP)}
                width={CARD_WIDTH}
                height={CARD_HEIGHT}
              >
                <button
                  type="button"
                  className={`ui-card ui-card--interactive result-canvas__card${item.id === selectedId ? ' is-selected' : ''}`}
                  aria-pressed={item.id === selectedId}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="result-canvas__thumbnail">
                    {item.imageUrl && <img src={item.imageUrl} alt="" loading="lazy" decoding="async" draggable={false} />}
                  </span>
                  <span className="result-canvas__card-text">
                    <span className="ui-card__title result-canvas__title" title={item.title}>{item.title}</span>
                    <span className="ui-text-muted result-canvas__status" title={item.detail}>
                      {item.status}{item.detail && ` · ${item.detail}`}
                    </span>
                  </span>
                </button>
              </CanvasNode>
            ))}
          </GpuCanvas>
        )}
      </div>

      {items.length === 0 && (
        <div className="ui-text-muted result-canvas__empty">
          {empty ?? <p>生成的图片会出现在这里。</p>}
        </div>
      )}

      <div className="ui-card result-canvas__renderer">
        {items.length > 0 && canvas && <span className="ui-text-muted" title={busy ? '生成期间使用 DOM 渲染' : '当前渲染方式'}>
          {mode === 'dom' ? 'DOM' : canvas.mode.toUpperCase()}
        </span>}
        <div className="ui-select ui-select--sm">
          <select
            className="ui-select__control ui-select__control--sm"
            aria-label="画布渲染方式"
            value={renderer}
            onChange={(event) => {
              const value = event.target.value === 'dom' ? 'dom' : 'auto'
              setRenderer(value)
              writeStored(RENDERER_KEY, value)
            }}
          >
            <option value="auto">自动</option>
            <option value="dom">DOM</option>
          </select>
          <ChevronDown className="ui-select__chevron" size={12} aria-hidden="true" />
        </div>
      </div>

      {items.length > 0 && (
        <div className="ui-card result-canvas__controls" role="group" aria-label="画布缩放">
          <button type="button" className="ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm" aria-label="缩小画布" onClick={() => zoomBy(1 / 1.2)}>
            <Minus size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ui-btn ui-btn--ghost ui-btn--sm result-canvas__zoom-value"
            aria-label={`复位视图，当前 ${zoom}%`}
            title="复位视图"
            onClick={() => canvas?.surface.isConnected && canvas.setCamera(START_CAMERA)}
          >
            {zoom}%
          </button>
          <button type="button" className="ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm" aria-label="放大画布" onClick={() => zoomBy(1.2)}>
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  )
}

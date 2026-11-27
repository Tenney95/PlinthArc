import { fitCamera, zoomAt, type Camera, type GpuCanvas as CanvasInstance } from 'gpucanvas'
import { CanvasNode, GpuCanvas } from 'gpucanvas/react'
import { Minus, Plus, Scan, Trash2 } from 'lucide-react'
import { useEffect, useEffectEvent, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { WorkspaceSelect } from './WorkspaceSelect'
import './WorkflowCanvas.css'

type Point = { x: number; y: number }
type Box = Point & { width: number; height: number }
type Direction = 'input' | 'output'
type TrackpadGesture = Event & { scale?: number; clientX?: number; clientY?: number }

export type WorkflowPort = { id: string; type: string; label?: string }
export type WorkflowCanvasNode = Box & {
  id: string
  kind: string
  inputs?: readonly WorkflowPort[]
  outputs?: readonly WorkflowPort[]
}
export type WorkflowEndpoint = { nodeId: string; portId: string }
export type WorkflowCanvasEdge = { id: string; source: WorkflowEndpoint; target: WorkflowEndpoint }

type Props<T extends WorkflowCanvasNode> = {
  nodes: readonly T[]
  edges: readonly WorkflowCanvasEdge[]
  renderNode: (node: T) => ReactNode
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMove: (id: string, position: Point) => void
  onConnect: (source: WorkflowEndpoint, target: WorkflowEndpoint) => void
  onRemoveEdge: (id: string) => void
  onViewportChange?: (center: Point) => void
  busy?: boolean
  empty?: ReactNode
}

type PortPosition = { endpoint: WorkflowEndpoint; direction: Direction; port: WorkflowPort; point: Point }
type MapFrame = { x: number; y: number; scale: number }

const START_CAMERA = { x: 0, y: 0, zoom: 1 }
const CAMERA_KEY = 'plintharc.workflow-camera'
const RENDERER_KEY = 'plintharc.result-renderer'
const MAP_WIDTH = 178
const MAP_HEIGHT = 118
const ZOOM_PRESETS = [10, 25, 35, 50, 75, 100, 150, 200, 300, 500]
const RENDERERS = [{ value: 'auto', label: '自动' }, { value: 'dom', label: 'DOM' }] as const
const PORT_SIZE = 24
const PORT_TOP = 62
const PORT_GAP = 24

function readStored(key: string) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function readCamera(): Camera | null {
  try {
    const saved = JSON.parse(readStored(CAMERA_KEY) ?? 'null') as Camera | null
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.zoom)
      && saved.zoom >= 0.02 && saved.zoom <= 16) return saved
  } catch {
    // Use the initial view if the saved camera is damaged.
  }
  return null
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The working view stays usable without storage.
  }
}

function scrollableNodeArea(target: EventTarget | null, horizontal: boolean) {
  if (!(target instanceof Element)) return false
  const boundary = target.closest('[data-workflow-interactive]')
  if (!boundary) return false
  for (let element: Element | null = target; element && boundary.contains(element); element = element.parentElement) {
    const style = getComputedStyle(element)
    const size = horizontal ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight
    if (size > 1 && /auto|scroll|overlay/.test(horizontal ? style.overflowX : style.overflowY)) return true
  }
  return false
}

function wheelFactor(event: WheelEvent) {
  return Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.006))
}

function boundsOf(boxes: readonly Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function portPoint(node: WorkflowCanvasNode, direction: Direction, index: number): Point {
  const count = (direction === 'input' ? node.inputs : node.outputs)?.length ?? 1
  const first = Math.min(PORT_TOP, node.height / 2)
  const gap = Math.min(PORT_GAP, (node.height - PORT_SIZE / 2 - first) / Math.max(1, count - 1))
  return {
    x: node.x + (direction === 'input' ? PORT_SIZE / 2 : node.width - PORT_SIZE / 2),
    y: node.y + first + index * gap,
  }
}

function sameEndpoint(left: WorkflowEndpoint, right: WorkflowEndpoint) {
  return left.nodeId === right.nodeId && left.portId === right.portId
}

function compatible(left: PortPosition, right: PortPosition) {
  return left.direction !== right.direction && left.endpoint.nodeId !== right.endpoint.nodeId && left.port.type === right.port.type
}

function cable(from: Point, to: Point) {
  const curve = Math.max(42, Math.min(156, Math.abs(to.x - from.x) * 0.45))
  return `M ${from.x} ${from.y} C ${from.x + curve} ${from.y}, ${to.x - curve} ${to.y}, ${to.x} ${to.y}`
}

function edgeHitArea(view: Box, ports: readonly PortPosition[]) {
  const bounds = `M ${view.x} ${view.y} h ${view.width} v ${view.height} h ${-view.width} Z`
  const holes = ports.map(({ point: { x, y } }) => {
    const r = PORT_SIZE / 2
    return `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`
  })
  return `${bounds} ${holes.join(' ')}`
}

function mapOf(bounds: Box): MapFrame {
  const scale = Math.min((MAP_WIDTH - 12) / Math.max(bounds.width, 1), (MAP_HEIGHT - 12) / Math.max(bounds.height, 1))
  return {
    scale,
    x: bounds.x - (MAP_WIDTH / scale - bounds.width) / 2,
    y: bounds.y - (MAP_HEIGHT / scale - bounds.height) / 2,
  }
}

function inMap(box: Box, frame: MapFrame): Box {
  return {
    x: (box.x - frame.x) * frame.scale,
    y: (box.y - frame.y) * frame.scale,
    width: box.width * frame.scale,
    height: box.height * frame.scale,
  }
}

export function WorkflowCanvas<T extends WorkflowCanvasNode>({
  nodes, edges, renderNode, selectedId, onSelect, onMove, onConnect, onRemoveEdge, onViewportChange, busy = false, empty,
}: Props<T>) {
  const edgeHitClip = useId()
  const minimapMask = useId()
  const stage = useRef<HTMLDivElement>(null)
  const minimap = useRef<SVGSVGElement>(null)
  const canvas = useRef<CanvasInstance | null>(null)
  const [savedCamera] = useState(readCamera)
  const initialFit = useRef(savedCamera !== null)
  const currentCamera = useRef(savedCamera ?? START_CAMERA)
  const writeTimer = useRef<number | undefined>(undefined)
  const pointerSession = useRef<AbortController | null>(null)
  const suppressPortClick = useRef(false)
  const suppressCanvasClick = useRef(false)
  const spaceHeld = useRef(false)
  const [camera, setCamera] = useState<Camera>(savedCamera ?? START_CAMERA)
  const [renderer, setRenderer] = useState<'auto' | 'dom'>(() => readStored(RENDERER_KEY) === 'dom' ? 'dom' : 'auto')
  const [size, setSize] = useState({ width: 1, height: 1 })
  const [moving, setMoving] = useState<{ id: string; point: Point } | null>(null)
  const [armed, setArmed] = useState<{ endpoint: WorkflowEndpoint; direction: Direction } | null>(null)
  const [wire, setWire] = useState<{ endpoint: WorkflowEndpoint; direction: Direction; point: Point } | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [handMode, setHandMode] = useState(false)
  const [panning, setPanning] = useState(false)
  const [frozenMap, setFrozenMap] = useState<MapFrame | null>(null)
  const minimapDrag = useRef<{ pointerId: number; frame: MapFrame; offset: Point; moved: boolean } | null>(null)
  const mode = busy || renderer === 'dom' ? 'dom' : 'auto'

  const displayedNodes = nodes.map((node) => moving?.id === node.id ? { ...node, ...moving.point } : node)
  const ports = displayedNodes.flatMap((node) => [
    ...node.inputs?.map((port, index) => ({ port, index, direction: 'input' as const })) ?? [],
    ...node.outputs?.map((port, index) => ({ port, index, direction: 'output' as const })) ?? [],
  ].map(({ port, direction, index }): PortPosition => ({
    endpoint: { nodeId: node.id, portId: port.id }, direction, port, point: portPoint(node, direction, index),
  })))
  const findPort = (endpoint: WorkflowEndpoint, direction: Direction) =>
    ports.find((port) => port.direction === direction && sameEndpoint(port.endpoint, endpoint))
  const activePort = wire ?? armed
  const origin = activePort && findPort(activePort.endpoint, activePort.direction)
  const selectedConnection = edges.find((edge) => edge.id === selectedEdge)
  const view = { x: camera.x, y: camera.y, width: size.width / camera.zoom, height: size.height / camera.zoom }
  const mapFrame = frozenMap ?? mapOf(boundsOf([view, ...displayedNodes]))
  const mapView = inMap(view, mapFrame)
  const zoomPercent = Math.round(camera.zoom * 100)
  const zoomLevels = ZOOM_PRESETS.includes(zoomPercent)
    ? ZOOM_PRESETS : [...ZOOM_PRESETS, zoomPercent].sort((a, b) => a - b)

  const reportViewport = useEffectEvent((center: Point) => onViewportChange?.(center))
  useEffect(() => {
    reportViewport({ x: camera.x + size.width / (2 * camera.zoom), y: camera.y + size.height / (2 * camera.zoom) })
  }, [camera, size])

  useEffect(() => {
    function flush() {
      window.clearTimeout(writeTimer.current)
      writeStored(CAMERA_KEY, JSON.stringify(currentCamera.current))
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  useEffect(() => {
    const host = stage.current
    const map = minimap.current
    if (!host) return
    let gestureScale: number | null = null

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      setSize({ width: Math.max(1, width), height: Math.max(1, height) })
    })
    observer.observe(host)

    function zoomCanvas(factor: number, pointer?: { clientX?: number; clientY?: number }) {
      const instance = canvas.current
      if (!instance?.surface.isConnected) return
      const { left, top, width, height } = instance.surface.getBoundingClientRect()
      const { clientX = NaN, clientY = NaN } = pointer ?? {}
      const x = Number.isFinite(clientX) ? clientX - left : width / 2
      const y = Number.isFinite(clientY) ? clientY - top : height / 2
      instance.setCamera(zoomAt(instance.getCamera(), x, y, factor))
    }

    function moveWithWheel(event: WheelEvent) {
      const instance = canvas.current
      if (!instance?.surface.isConnected) return
      event.stopPropagation()
      const zooming = event.ctrlKey || event.metaKey
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      if (!zooming && gestureScale === null && !pointerSession.current && scrollableNodeArea(event.target, horizontal)) return
      event.preventDefault()
      if (pointerSession.current || gestureScale !== null) return
      if (zooming) {
        zoomCanvas(wheelFactor(event), event)
        return
      }
      const view = instance.getCamera()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? instance.surface.clientHeight : 1
      const shifted = event.shiftKey && !event.deltaX
      instance.setCamera({
        ...view,
        x: view.x + (shifted ? event.deltaY : event.deltaX) * unit / view.zoom,
        y: view.y + (shifted ? 0 : event.deltaY) * unit / view.zoom,
      })
    }

    function zoomFromMap(event: WheelEvent) {
      event.preventDefault()
      if (!pointerSession.current && gestureScale === null) zoomCanvas(wheelFactor(event))
    }

    function beginPinch(event: Event) {
      if (!canvas.current?.surface.isConnected) return
      event.preventDefault()
      gestureScale = 1
    }

    function updatePinch(event: TrackpadGesture) {
      if (gestureScale === null) return
      event.preventDefault()
      const { scale } = event
      if (scale === undefined || !Number.isFinite(scale) || scale <= 0) return
      const factor = scale / gestureScale
      gestureScale = scale
      if (!pointerSession.current) zoomCanvas(factor, event.currentTarget === map ? undefined : event)
    }

    function finishPinch(event: Event) {
      if (gestureScale === null) return
      event.preventDefault()
      gestureScale = null
    }

    function pressSpace(event: globalThis.KeyboardEvent) {
      if (event.code !== 'Space' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.target instanceof Element
        && event.target.closest('input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), dialog[open]')) return
      event.preventDefault()
      spaceHeld.current = true
      setHandMode(true)
    }

    function resetHand() {
      spaceHeld.current = false
      setHandMode(false)
    }

    function releaseSpace(event: globalThis.KeyboardEvent) {
      if (event.code === 'Space') resetHand()
    }

    function resetInput() {
      gestureScale = null
      resetHand()
    }

    const listeners = new AbortController()
    const signal = listeners.signal
    const cancelable = { passive: false, signal }
    host.addEventListener('wheel', moveWithWheel, { ...cancelable, capture: true })
    map?.addEventListener('wheel', zoomFromMap, cancelable)
    // Safari and WKWebView can send native gestures instead of Ctrl+Wheel.
    for (const target of [host, map]) {
      target?.addEventListener('gesturestart', beginPinch, cancelable)
      target?.addEventListener('gesturechange', updatePinch, cancelable)
      target?.addEventListener('gestureend', finishPinch, cancelable)
    }
    window.addEventListener('keydown', pressSpace, { signal })
    window.addEventListener('keyup', releaseSpace, { signal })
    window.addEventListener('blur', resetInput, { signal })
    return () => {
      listeners.abort()
      observer.disconnect()
      pointerSession.current?.abort()
    }
  }, [])

  function handleCamera(next: Camera) {
    currentCamera.current = next
    setCamera(next)
    window.clearTimeout(writeTimer.current)
    writeTimer.current = window.setTimeout(() => writeStored(CAMERA_KEY, JSON.stringify(next)), 180)
  }

  function startHandPan(event: PointerEvent<HTMLDivElement>) {
    const target = event.target
    if (!(target instanceof Element) || !event.currentTarget.contains(target)
      || !event.isPrimary || event.pointerType === 'touch') return
    suppressCanvasClick.current = false
    if (event.button !== 1 && (event.button !== 0 || !spaceHeld.current)) {
      // Keep ordinary clicks for selection without starting the library's background drag.
      if (event.button === 0 && target.matches('[data-gpucanvas-surface]')) event.stopPropagation()
      return
    }
    const instance = canvas.current
    if (!instance?.surface.isConnected || pointerSession.current) return
    event.stopPropagation()
    event.preventDefault()
    suppressCanvasClick.current = event.button === 0
    setPanning(true)
    const { clientX, clientY } = event
    const view = instance.getCamera()
    trackPointer(event, (move) => {
      if (!instance.surface.isConnected) return
      instance.setCamera({
        ...view,
        x: view.x - (move.clientX - clientX) / view.zoom,
        y: view.y - (move.clientY - clientY) / view.zoom,
      })
    }, () => setPanning(false))
  }

  function fit(instance: CanvasInstance, bounds = nodes.length ? boundsOf(nodes) : null) {
    if (!bounds) {
      instance.setCamera(START_CAMERA)
      return
    }
    const { clientWidth: width, clientHeight: height } = instance.surface
    const padding = Math.min(64, width / 5, height / 5)
    const fitted = fitCamera(bounds, width, height, padding)
    instance.setCamera(fitted.zoom <= 1 ? fitted : {
      x: bounds.x + (bounds.width - width) / 2,
      y: bounds.y + (bounds.height - height) / 2,
      zoom: 1,
    })
  }

  function handleReady(instance: CanvasInstance) {
    canvas.current = instance
    if (instance.mode === 'gpu' && stage.current) {
      instance.setBackground(getComputedStyle(stage.current).backgroundColor)
    }
    if (!initialFit.current) {
      initialFit.current = true
      const bounds = nodes.length ? boundsOf(nodes) : null
      const { clientWidth, clientHeight } = instance.surface
      if (bounds && (bounds.x < 72 || bounds.y < 0 || bounds.x + bounds.width + 32 > clientWidth || bounds.y + bounds.height + 24 > clientHeight)) {
        fit(instance, bounds)
        return
      }
    }
    instance.setCamera(currentCamera.current)
  }

  function worldAt(event: { clientX: number; clientY: number }): Point | undefined {
    const instance = canvas.current
    if (!instance?.surface.isConnected) return
    const { left, top } = instance.surface.getBoundingClientRect()
    return instance.screenToWorld({ x: event.clientX - left, y: event.clientY - top })
  }

  function trackPointer(
    start: PointerEvent<HTMLElement>,
    move: (event: globalThis.PointerEvent) => void,
    finish: (event: globalThis.PointerEvent, moved: boolean) => void,
  ) {
    pointerSession.current?.abort()
    const controller = new AbortController()
    pointerSession.current = controller
    const { pointerId, clientX, clientY } = start
    let moved = false
    const options = { signal: controller.signal }
    window.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return
      moved ||= Math.hypot(event.clientX - clientX, event.clientY - clientY) >= 4
      if (moved) move(event)
    }, options)
    function end(event: globalThis.PointerEvent) {
      if (event.pointerId !== pointerId) return
      controller.abort()
      pointerSession.current = null
      finish(event, moved && event.type === 'pointerup')
    }
    window.addEventListener('pointerup', end, options)
    window.addEventListener('pointercancel', end, options)
    window.addEventListener('blur', () => {
      controller.abort()
      pointerSession.current = null
      finish(start.nativeEvent, false)
    }, options)
  }

  function chooseNode(node: WorkflowCanvasNode) {
    setSelectedEdge(null)
    onSelect(node.id)
  }

  function startNode(event: PointerEvent<HTMLDivElement>, node: WorkflowCanvasNode) {
    if (event.button !== 0 || !event.isPrimary) return
    const target = event.target as Element
    if (target.closest('.workflow-port')) return
    chooseNode(node)
    const control = target.closest('button, input, select, textarea, a, label, [contenteditable], [data-workflow-interactive]')
    if (control && !target.closest('[data-workflow-drag-handle]')) return
    const start = worldAt(event)
    if (!start) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    const position = (point: Point) => ({ x: node.x + point.x - start.x, y: node.y + point.y - start.y })
    trackPointer(event, (move) => {
      const point = worldAt(move)
      if (point) setMoving({ id: node.id, point: position(point) })
    }, (end, moved) => {
      const point = moved && worldAt(end)
      if (point) onMove(node.id, position(point))
      setMoving(null)
    })
  }

  function moveNodeWithKeys(event: KeyboardEvent<HTMLDivElement>, node: WorkflowCanvasNode) {
    if (event.target !== event.currentTarget) return
    const direction = arrowDirection(event.key)
    if (direction) {
      event.preventDefault()
      const distance = event.shiftKey ? 36 : 12
      chooseNode(node)
      onMove(node.id, { x: node.x + direction.x * distance, y: node.y + direction.y * distance })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      chooseNode(node)
    }
  }

  function join(first: PortPosition, second: PortPosition) {
    if (!compatible(first, second)) return false
    const [source, target] = first.direction === 'output' ? [first.endpoint, second.endpoint] : [second.endpoint, first.endpoint]
    onConnect(source, target)
    setArmed(null)
    return true
  }

  function pressPort(port: PortPosition, detail: number) {
    if (detail > 0 && suppressPortClick.current) {
      suppressPortClick.current = false
      return
    }
    if (origin && join(origin, port)) return
    setSelectedEdge(null)
    setArmed(origin?.direction === port.direction && sameEndpoint(origin.endpoint, port.endpoint) ? null : port)
  }

  function startPort(event: PointerEvent<HTMLButtonElement>, port: PortPosition) {
    if (event.button !== 0 || !event.isPrimary) return
    suppressPortClick.current = false
    event.stopPropagation()
    trackPointer(event, (move) => {
      const point = worldAt(move)
      if (point) setWire({ endpoint: port.endpoint, direction: port.direction, point })
    }, (end, moved) => {
      setWire(null)
      if (!moved) return
      suppressPortClick.current = true
      setArmed(null)
      const point = worldAt(end)
      if (!point) return
      let nearest: PortPosition | undefined
      let distance = Math.max(PORT_SIZE / 2, 14 / (canvas.current?.getCamera().zoom ?? 1))
      for (const candidate of ports) {
        if (!compatible(port, candidate)) continue
        const delta = Math.hypot(candidate.point.x - point.x, candidate.point.y - point.y)
        if (delta < distance) {
          nearest = candidate
          distance = delta
        }
      }
      if (nearest) join(port, nearest)
    })
  }

  function chooseEdge(id: string) {
    setSelectedEdge(id)
    setArmed(null)
    onSelect(null)
  }

  function removeEdge(id: string) {
    onRemoveEdge(id)
    setSelectedEdge(null)
  }

  function zoom(value: number, kind: 'relative' | 'absolute' = 'relative') {
    const instance = canvas.current
    if (instance?.surface.isConnected) {
      const current = instance.getCamera()
      const factor = kind === 'absolute' ? value / current.zoom : value
      instance.setCamera(zoomAt(current, size.width / 2, size.height / 2, factor))
    }
  }

  function panTo(center: Point) {
    const instance = canvas.current
    if (!instance?.surface.isConnected) return
    const { zoom } = instance.getCamera()
    instance.setCamera({ x: center.x - size.width / (2 * zoom), y: center.y - size.height / (2 * zoom), zoom })
  }

  function mapLocation(event: PointerEvent<SVGSVGElement>, frame: MapFrame) {
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect()
    return {
      x: frame.x + (event.clientX - left) * MAP_WIDTH / width / frame.scale,
      y: frame.y + (event.clientY - top) * MAP_HEIGHT / height / frame.scale,
    }
  }

  function startMinimap(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || !event.isPrimary) return
    const point = mapLocation(event, mapFrame)
    const inside = point.x >= view.x && point.x <= view.x + view.width && point.y >= view.y && point.y <= view.y + view.height
    const offset = inside ? { x: point.x - view.x - view.width / 2, y: point.y - view.y - view.height / 2 } : { x: 0, y: 0 }
    minimapDrag.current = { pointerId: event.pointerId, frame: mapFrame, offset, moved: !inside }
    setFrozenMap(mapFrame)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus({ preventScroll: true })
    if (!inside) panTo(point)
  }

  function moveMinimap(event: PointerEvent<SVGSVGElement>) {
    const drag = minimapDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.moved = true
    const point = mapLocation(event, drag.frame)
    panTo({ x: point.x - drag.offset.x, y: point.y - drag.offset.y })
  }

  function endMinimap(event: PointerEvent<SVGSVGElement>) {
    const drag = minimapDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.moved && event.type === 'pointerup') panTo(mapLocation(event, drag.frame))
    minimapDrag.current = null
    setFrozenMap(null)
  }

  return (
    <section className="workflow-canvas" aria-label="工作流画布" onKeyDown={(event) => {
      if (event.key === 'Escape' && (armed || selectedEdge)) {
        setArmed(null)
        setSelectedEdge(null)
      }
    }}>
      <div className={`workflow-canvas__stage${panning ? ' is-panning' : handMode ? ' is-hand-mode' : ''}`}
        ref={stage} onPointerDownCapture={startHandPan} onClickCapture={(event) => {
          if (event.detail === 0 || !suppressCanvasClick.current || !event.currentTarget.contains(event.target as Node)) return
          suppressCanvasClick.current = false
          event.preventDefault()
          event.stopPropagation()
        }} onClick={(event) => {
        if (!(event.target as Element).closest('.workflow-node, .workflow-edge__hit')) {
          setArmed(null)
          setSelectedEdge(null)
          onSelect(null)
        }
      }}>
        <GpuCanvas key={mode} className="workflow-canvas__host" mode={mode} background="transparent" atlasSize={2048}
          atlasLayers={3} onCameraChange={handleCamera} onReady={handleReady}>
          {displayedNodes.map((node, index) => (
            <CanvasNode key={node.id} x={node.x} y={node.y} width={node.width} height={node.height}>
              <div className={`ui-card workflow-node${selectedId === node.id ? ' is-selected' : ''}${moving?.id === node.id ? ' is-moving' : ''}`}
                data-node-id={node.id} data-kind={node.kind} role="group" tabIndex={0}
                aria-label={node.kind === 'model' ? '模型节点' : node.kind === 'image' ? '图像生成节点' : '工作流节点'}
                onPointerDown={(event) => startNode(event, node)} onKeyDown={(event) => moveNodeWithKeys(event, node)}>
                {renderNode(nodes[index])}
                {ports.filter((port) => port.endpoint.nodeId === node.id).map((port) => (
                  <button key={`${port.direction}:${port.port.id}`} type="button"
                    className={`workflow-port${origin && compatible(origin, port) ? ' is-compatible' : ''}`}
                    data-direction={port.direction} data-port-id={port.port.id}
                    style={{ top: port.point.y - node.y - PORT_SIZE / 2 - 1 }}
                    aria-label={`${port.port.label ?? port.port.id}${port.direction === 'input' ? '输入' : '输出'}`}
                    aria-pressed={origin?.direction === port.direction && sameEndpoint(origin.endpoint, port.endpoint)}
                    title={`${port.port.label ?? port.port.id} · ${port.direction === 'input' ? '输入' : '输出'}`}
                    onPointerDown={(event) => startPort(event, port)} onClick={(event) => pressPort(port, event.detail)} />
                ))}
              </div>
            </CanvasNode>
          ))}
        </GpuCanvas>

        <svg className="workflow-canvas__wires" width="100%" height="100%" aria-label="工作流连线">
          <defs><clipPath id={edgeHitClip}><path d={edgeHitArea(view, ports)} clipRule="evenodd" /></clipPath></defs>
          <g transform={`translate(${-camera.x * camera.zoom} ${-camera.y * camera.zoom}) scale(${camera.zoom})`}>
            {edges.map((edge) => {
              const source = findPort(edge.source, 'output')
              const target = findPort(edge.target, 'input')
              if (!source || !target) return null
              const path = cable(source.point, target.point)
              return <g key={edge.id} className={`workflow-edge${selectedEdge === edge.id ? ' is-selected' : ''}`}>
                <path className="workflow-edge__line" d={path} vectorEffect="non-scaling-stroke" />
                <path className="workflow-edge__hit" d={path} vectorEffect="non-scaling-stroke" role="button" tabIndex={0}
                  clipPath={`url(#${edgeHitClip})`}
                  aria-label={`${source.port.label ?? source.port.id}输出到${target.port.label ?? target.port.id}输入的连线`}
                  aria-pressed={selectedEdge === edge.id}
                  onClick={(event) => { event.currentTarget.focus(); chooseEdge(edge.id) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseEdge(edge.id) }
                    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeEdge(edge.id) }
                  }} />
              </g>
            })}
            {wire && origin && <path className="workflow-edge__preview" vectorEffect="non-scaling-stroke"
              d={origin.direction === 'output' ? cable(origin.point, wire.point) : cable(wire.point, origin.point)} />}
          </g>
        </svg>
      </div>

      {nodes.length === 0 && <div className="workflow-canvas__empty ui-text-muted">{empty ?? '添加节点以开始编排'}</div>}
      {selectedConnection && <button className="ui-btn ui-btn--secondary ui-btn--sm workflow-canvas__remove"
        type="button" aria-label="删除连线" onClick={() => removeEdge(selectedConnection.id)}><Trash2 size={13} aria-hidden="true" />删除连线</button>}

      <div className="workflow-canvas__navigation">
        <svg ref={minimap} className="workflow-canvas__minimap" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
          role="group" aria-label="小地图" tabIndex={0}
          onPointerDown={startMinimap} onPointerMove={moveMinimap} onPointerUp={endMinimap}
          onPointerCancel={endMinimap} onLostPointerCapture={endMinimap}
          onKeyDown={(event) => {
            const direction = arrowDirection(event.key)
            if (direction) {
              event.preventDefault()
              panTo({ x: view.x + view.width * (0.5 + direction.x / 5), y: view.y + view.height * (0.5 + direction.y / 5) })
            }
          }}>
          <defs>
            <mask id={minimapMask} maskUnits="userSpaceOnUse" x={0} y={0} width={MAP_WIDTH} height={MAP_HEIGHT}>
              <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="white" />
              <rect {...mapView} rx={6} fill="black" />
            </mask>
          </defs>
          {displayedNodes.map((node) => <rect key={node.id} {...inMap(node, mapFrame)} rx={3} data-kind={node.kind} />)}
          <rect className="workflow-canvas__minimap-mask" width={MAP_WIDTH} height={MAP_HEIGHT} mask={`url(#${minimapMask})`} />
          <rect className="workflow-canvas__minimap-view" {...mapView} rx={6} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="workflow-canvas__zoom" role="group" aria-label="画布缩放">
          <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" aria-label="适配工作流" title="适配工作流"
            onClick={() => { if (canvas.current?.surface.isConnected) fit(canvas.current) }}><Scan size={14} aria-hidden="true" /></button>
          <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" aria-label="缩小画布"
            onClick={() => zoom(1 / 1.2)}><Minus size={14} aria-hidden="true" /></button>
          <div className="workflow-canvas__zoom-level">
            <WorkspaceSelect label="画布缩放比例" value={`${zoomPercent}%`} placement="top" compact
              options={zoomLevels.map((level) => ({ value: `${level}%`, label: `${level}%` }))}
              onChange={(value) => zoom(Number.parseInt(value, 10) / 100, 'absolute')} />
          </div>
          <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" aria-label="放大画布"
            onClick={() => zoom(1.2)}><Plus size={14} aria-hidden="true" /></button>
          <span className="workflow-canvas__zoom-separator" aria-hidden="true" />
          <div className="workflow-canvas__renderer" title={busy ? '生成期间使用 DOM 渲染' : undefined}>
            <WorkspaceSelect label="画布渲染方式" value={renderer} options={RENDERERS} placement="top" compact
              onChange={(value) => {
                setRenderer(value)
                writeStored(RENDERER_KEY, value)
              }} />
          </div>
        </div>
      </div>
    </section>
  )
}

function arrowDirection(key: string): Point | undefined {
  if (key === 'ArrowLeft') return { x: -1, y: 0 }
  if (key === 'ArrowRight') return { x: 1, y: 0 }
  if (key === 'ArrowUp') return { x: 0, y: -1 }
  if (key === 'ArrowDown') return { x: 0, y: 1 }
}

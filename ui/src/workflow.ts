import type { WorkflowCanvasEdge, WorkflowCanvasNode, WorkflowEndpoint } from './WorkflowCanvas'

export const modelId = 'Tongyi-MAI/Z-Image-Turbo'
export const modelName = 'Z-Image-Turbo'
export const workflowKey = 'plintharc.workflow.v1'
export const initialImageId = 'image-1'

export type Draft = {
  prompt: string
  width: string
  height: string
  steps: string
  seed: string
  offload_to_cpu: boolean
}
export type WorkflowKind = 'model' | 'image'
type Position = { x: number; y: number }
type ModelNode = WorkflowCanvasNode & { kind: 'model'; model: typeof modelId }
export type ImageNode = WorkflowCanvasNode & { kind: 'image'; draft: Draft; runId?: string }
export type WorkflowNode = ModelNode | ImageNode
export type Workflow = { version: 1; nodes: WorkflowNode[]; edges: WorkflowCanvasEdge[] }

const modelPort = { id: 'model', type: 'model-package', label: '模型' }
const defaultDraft: Draft = {
  prompt: '', width: '512', height: '512', steps: '8', seed: '42', offload_to_cpu: false,
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function asDraft(value?: unknown): Draft {
  const saved = record(value)
  return {
    prompt: typeof saved?.prompt === 'string' ? saved.prompt : defaultDraft.prompt,
    width: typeof saved?.width === 'string' ? saved.width : defaultDraft.width,
    height: typeof saved?.height === 'string' ? saved.height : defaultDraft.height,
    steps: typeof saved?.steps === 'string' ? saved.steps : defaultDraft.steps,
    seed: typeof saved?.seed === 'string' ? saved.seed : defaultDraft.seed,
    offload_to_cpu: saved?.offload_to_cpu === true,
  }
}

export function makeNode(kind: WorkflowKind, id: string, position: Position, draft = asDraft()): WorkflowNode {
  return kind === 'model'
    ? { id, ...position, kind, model: modelId, width: 258, height: 144, outputs: [modelPort] }
    : { id, ...position, kind, draft, width: 298, height: 382, inputs: [modelPort] }
}

function endpoint(value: unknown): WorkflowEndpoint | undefined {
  const point = record(value)
  if (typeof point?.nodeId === 'string' && point.portId === modelPort.id) {
    return { nodeId: point.nodeId, portId: point.portId }
  }
}

export function connect(
  graph: Workflow, source: WorkflowEndpoint, target: WorkflowEndpoint,
): Workflow {
  if (source.portId !== modelPort.id || target.portId !== modelPort.id
    || !graph.nodes.some((node) => node.id === source.nodeId && node.kind === 'model')
    || !graph.nodes.some((node) => node.id === target.nodeId && node.kind === 'image')) return graph
  const id = `model-${source.nodeId}-${target.nodeId}`
  if (graph.edges.some((edge) => edge.id === id)) return graph
  return {
    ...graph,
    edges: [...graph.edges.filter((edge) => edge.target.nodeId !== target.nodeId), { id, source, target }],
  }
}

export function removeNode(graph: Workflow, id: string): Workflow {
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== id),
    edges: graph.edges.filter((edge) => edge.source.nodeId !== id && edge.target.nodeId !== id),
  }
}

export function updateImage(graph: Workflow, id: string, change: Partial<Pick<ImageNode, 'draft' | 'runId'>>): Workflow {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.kind === 'image' && node.id === id ? { ...node, ...change } : node),
  }
}

export function loadWorkflow(value: unknown, legacyDraft: unknown): Workflow {
  const saved = record(value)
  if (saved?.version !== 1 || !Array.isArray(saved.nodes) || !Array.isArray(saved.edges)) {
    const model = makeNode('model', 'model-1', { x: 126, y: 166 })
    const image = makeNode('image', initialImageId, { x: 468, y: 122 }, asDraft(legacyDraft))
    return connect(
      { version: 1, nodes: [model, image], edges: [] },
      { nodeId: model.id, portId: modelPort.id }, { nodeId: image.id, portId: modelPort.id },
    )
  }
  const graph: Workflow = { version: 1, nodes: [], edges: [] }
  const ids = new Set<string>()
  for (const entry of saved.nodes) {
    const node = record(entry)
    if (typeof node?.id !== 'string' || !node.id || ids.has(node.id)
      || (node.kind !== 'model' && node.kind !== 'image')
      || typeof node.x !== 'number' || !Number.isFinite(node.x)
      || typeof node.y !== 'number' || !Number.isFinite(node.y)) continue
    const restored = makeNode(node.kind, node.id, { x: node.x, y: node.y }, asDraft(node.draft))
    if (restored.kind === 'image' && typeof node.runId === 'string') restored.runId = node.runId
    ids.add(node.id)
    graph.nodes.push(restored)
  }
  return saved.edges.reduce((current, entry) => {
    const edge = record(entry)
    const source = endpoint(edge?.source)
    const target = endpoint(edge?.target)
    return source && target ? connect(current, source, target) : current
  }, graph)
}

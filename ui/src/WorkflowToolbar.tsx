import { useEffect, useId, useRef, useState } from 'react'
import { Box, Clock3, Image as ImageIcon, MousePointer2, Plus, Settings2, Trash2 } from 'lucide-react'
import './workspace-theme.css'
import './WorkflowToolbar.css'

export type WorkflowView = 'create' | 'history'
export type WorkflowNodeKind = 'model' | 'image'

type WorkflowToolbarProps = {
  view: WorkflowView
  onChangeView(view: WorkflowView): void
  onOpenSettings(): void
  onAddNode(kind: WorkflowNodeKind): void
  onDeleteSelected?(): void
  canDelete?: boolean
}

export function WorkflowToolbar({
  view, onChangeView, onOpenSettings, onAddNode, onDeleteSelected, canDelete = false,
}: WorkflowToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const toolbar = useRef<HTMLElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const firstItem = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!menuOpen) return
    firstItem.current?.focus()

    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !toolbar.current?.contains(event.target)) setMenuOpen(false)
    }

    document.addEventListener('pointerdown', dismissOutside)
    return () => document.removeEventListener('pointerdown', dismissOutside)
  }, [menuOpen])

  function addNode(kind: WorkflowNodeKind) {
    setMenuOpen(false)
    addButton.current?.focus()
    onAddNode(kind)
  }

  function changeView(next: WorkflowView) {
    setMenuOpen(false)
    onChangeView(next)
  }

  return <nav
    ref={toolbar}
    className="workflow-toolbar"
    aria-label="画布工具"
    onPointerDown={(event) => event.stopPropagation()}
    onBlur={(event) => {
      if (menuOpen && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
        setMenuOpen(false)
      }
    }}
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || !menuOpen) return
      event.preventDefault()
      event.stopPropagation()
      setMenuOpen(false)
      addButton.current?.focus()
    }}
  >
    <div className="workflow-toolbar__rail ui-card">
      <button type="button" className="ui-icon-btn ui-icon-btn--ghost" aria-label="创作" title="创作"
        aria-pressed={view === 'create'} onClick={() => changeView('create')}>
        <MousePointer2 size={17} />
      </button>
      <button type="button" ref={addButton} className="workflow-toolbar__add ui-icon-btn ui-icon-btn--ghost"
        aria-label="添加节点" title="添加节点" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined}
        onClick={() => setMenuOpen((open) => !open)}>
        <Plus size={21} />
      </button>
      <span className="workflow-toolbar__separator" aria-hidden="true" />
      <button type="button" className="ui-icon-btn ui-icon-btn--ghost" aria-label="历史" title="历史"
        aria-pressed={view === 'history'} onClick={() => changeView('history')}>
        <Clock3 size={17} />
      </button>
      {onDeleteSelected && <button type="button" className="workflow-toolbar__delete ui-icon-btn ui-icon-btn--ghost"
        aria-label="删除所选节点" title="删除所选节点" disabled={!canDelete} onClick={() => {
          setMenuOpen(false)
          onDeleteSelected()
        }}>
        <Trash2 size={17} />
      </button>}
      <button type="button" className="ui-icon-btn ui-icon-btn--ghost" aria-label="打开设置" title="设置"
        onClick={() => { setMenuOpen(false); onOpenSettings() }}>
        <Settings2 size={17} />
      </button>
    </div>
    {menuOpen && <section className="workflow-toolbar__menu ui-menu" id={menuId} aria-labelledby={`${menuId}-title`}>
      <h2 id={`${menuId}-title`} className="workflow-toolbar__menu-title">添加节点</h2>
      <button type="button" ref={firstItem} className="workflow-toolbar__item ui-menu__item" onClick={() => addNode('model')}>
        <span className="workflow-toolbar__node-icon"><Box size={16} /></span>模型
      </button>
      <button type="button" className="workflow-toolbar__item ui-menu__item" onClick={() => addNode('image')}>
        <span className="workflow-toolbar__node-icon workflow-toolbar__node-icon--image"><ImageIcon size={16} /></span>图像生成
      </button>
    </section>}
  </nav>
}

import React from 'react'

export const name = 'dsh-session-manager-client'
export const inject = ['slots', 'workspaces', 'sessions'] as const

interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe?(listener: () => void): () => void
}

interface SessionSummary {
  id: string
  title?: string
  displayTitle?: string
  cwd?: string
}

interface SessionListState {
  ids: string[]
  byId: Record<string, SessionSummary>
  current?: string
}

interface WorkspaceListState {
  items: readonly Record<string, unknown>[]
}

interface DshSlotReg {
  inject: (key: string, factory: () => unknown) => () => void
  register: (
    opts: { name: string; id: string; order?: number; label?: string; inject?: (sid: string) => Record<string, unknown>; locale?: string },
    comp: (props: Record<string, unknown>) => React.ReactElement,
  ) => () => void
}

interface DshWorkspaces {
  readonly list: ObservableSnapshot<WorkspaceListState>
  archiveSession(sessionId: string): Promise<void>
  connectWorkspace(workspaceId: string): Promise<string>
}

interface SessionFace extends ObservableSnapshot<ConversationSnapshot> {
  prompt(parts: unknown[], mode: 'queue' | 'steer', signal?: AbortSignal): Promise<unknown>
}

interface DshSessions {
  readonly list: ObservableSnapshot<SessionListState>
  binding(id: string): { session: SessionFace } | undefined
  fork(opts: { sessionId: string; atSeq?: number; increaseTitle?: boolean }): Promise<string>
  open(id: string): void
}

interface ConversationNode {
  kind: string
  seq: number
  messageId?: string
  turn?: number
  content?: unknown[]
}

interface ConversationSnapshot {
  nodes?: readonly ConversationNode[]
  turnEnds?: ReadonlyMap<number, number>
}

interface ClientContext {
  slots: DshSlotReg
  workspaces: DshWorkspaces
  sessions: DshSessions
  on?: (name: 'dispose', callback: () => void) => void
}

export function apply(ctx: ClientContext): void {
  const { slots, workspaces, sessions } = ctx

  // DSH 当前没有“会话行菜单项”扩展 Slot。这里仅做菜单兼容层，
  // 将“删除会话”插到内置“归档会话”之后，而不再占用会话详情头部。
  const disposeSessionMenu = installSessionMenuDelete(workspaces, sessions)
  ctx.on?.('dispose', disposeSessionMenu)

  slots.inject('conversation.chat.assistant-actions', () => {
    return slots.register(
      { name: 'conversation.chat.assistant-actions', id: 'retry-message', order: -10, label: '重新生成' },
      function RetryAction(props: Record<string, unknown>) {
        const sessionId = String(props.sessionId ?? '')
        const messageId = String(props.messageId ?? '')
        return React.createElement(RetryButton, {
          key: messageId,
          sessionId,
          messageId,
          sessions,
          workspaces,
          useSession: props.useSession as (<T>(selector: (snapshot: ConversationSnapshot) => T) => T) | undefined,
        })
      },
    )
  })
}

function installSessionMenuDelete(workspaces: DshWorkspaces, sessions: DshSessions): () => void {
  if (typeof document === 'undefined') return () => undefined

  let selectedSessionId: string | undefined
  let disposed = false

  const inferSessionIdFromFiber = (element: Element | null): string | undefined => {
    let current: Element | null = element
    while (current) {
      const fiberKey = Object.keys(current).find((key) => key.startsWith('__reactFiber$'))
      let fiber = fiberKey ? (current as unknown as Record<string, unknown>)[fiberKey] as Record<string, unknown> | undefined : undefined
      let depth = 0
      while (fiber && depth++ < 24) {
        const props = fiber.memoizedProps as Record<string, unknown> | undefined
        const node = props?.node as Record<string, unknown> | undefined
        const candidate = node?.id ?? props?.sessionId ?? props?.id
        if (typeof candidate === 'string' && sessions.list.getSnapshot().byId[candidate]) return candidate
        fiber = fiber.return as Record<string, unknown> | undefined
      }
      current = current.parentElement
    }
    return undefined
  }

  const inferSessionIdFromRow = (row: Element | null): string | undefined => {
    const fromFiber = inferSessionIdFromFiber(row)
    if (fromFiber) return fromFiber

    const text = row?.textContent?.trim() ?? ''
    const state = sessions.list.getSnapshot()
    const matches = state.ids.filter((id) => {
      const item = state.byId[id]
      const title = item?.displayTitle ?? item?.title ?? ''
      return Boolean(title) && text.includes(title)
    })
    return matches.length === 1 ? matches[0] : undefined
  }

  const onDocumentPointerDown = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest('button')
    const row = button?.closest('[role="treeitem"]') ?? button?.closest('[data-session-id]')
    if (!button || !row) return
    selectedSessionId = row.getAttribute('data-session-id') ?? inferSessionIdFromRow(row)
    queueMicrotask(syncDeleteMenuItem)
  }

  const syncDeleteMenuItem = () => {
    if (disposed || !selectedSessionId) return
    const menuItems = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menu"] button'))
    const archiveItem = menuItems.find((item) => {
      const text = item.textContent?.trim().toLocaleLowerCase() ?? ''
      return text.includes('归档会话') || text.includes('archive session')
    })
    if (!archiveItem || archiveItem.parentElement?.querySelector('[data-dsh-session-delete="true"]')) return

    const deleteItem = archiveItem.cloneNode(true) as HTMLElement
    deleteItem.setAttribute('data-dsh-session-delete', 'true')
    deleteItem.setAttribute('aria-label', '删除会话')
    deleteItem.removeAttribute('aria-current')
    replaceMenuLabel(deleteItem, '删除会话')
    replaceMenuIcon(deleteItem)
    deleteItem.style.color = 'var(--dsw-alias-state-error-primary, #d92d20)'

    deleteItem.addEventListener('click', async (event) => {
      event.preventDefault()
      event.stopPropagation()
      const sessionId = selectedSessionId
      if (!sessionId) return
      if (!window.confirm('确定删除这个会话吗？')) return
      try {
        await workspaces.archiveSession(sessionId)
      } catch (error) {
        window.alert(`删除会话失败：${toErrorMessage(error)}`)
      }
    }, true)

    archiveItem.insertAdjacentElement('afterend', deleteItem)
  }

  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  const observer = new MutationObserver(syncDeleteMenuItem)
  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    disposed = true
    observer.disconnect()
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)
    document.querySelectorAll('[data-dsh-session-delete="true"]').forEach((element) => element.remove())
  }
}

/** 只替换菜单文字，保留宿主菜单原有的布局、class、快捷键和图标容器。 */
function replaceMenuLabel(item: HTMLElement, label: string): void {
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    if (node.parentElement?.closest('svg')) continue
    if (node.nodeValue?.trim()) {
      node.nodeValue = label
      return
    }
  }
  item.append(document.createTextNode(label))
}

/** 复用宿主菜单图标的尺寸和样式，只替换为删除图标。 */
function replaceMenuIcon(item: HTMLElement): void {
  const source = item.querySelector('svg')
  if (!source) return

  const icon = source.cloneNode(false) as SVGSVGElement
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('fill', 'none')
  icon.setAttribute('stroke', 'currentColor')
  icon.setAttribute('stroke-width', '1.8')
  icon.setAttribute('stroke-linecap', 'round')
  icon.setAttribute('stroke-linejoin', 'round')
  icon.replaceChildren(
    createSvgElement('path', { d: 'M4 6h16' }),
    createSvgElement('path', { d: 'M10 6V4h4v2' }),
    createSvgElement('path', { d: 'M6 8v12h12V8' }),
    createSvgElement('path', { d: 'M10 11v6M14 11v6' }),
  )
  source.replaceWith(icon)
}

function createSvgElement(name: string, attributes: Record<string, string>): SVGElement {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
  return element
}

function RetryButton({
  sessionId,
  messageId,
  sessions,
  workspaces,
  useSession,
}: {
  sessionId: string
  messageId: string
  sessions: DshSessions
  workspaces: DshWorkspaces
  useSession?: <T>(selector: (snapshot: ConversationSnapshot) => T) => T
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const retryContext = useSession?.((snapshot) => {
    const nodes = snapshot.nodes ?? []
    const assistantIndex = nodes.findIndex((node) => node.kind === 'assistant' && node.messageId === messageId)
    if (assistantIndex < 0) return undefined

    const assistant = nodes[assistantIndex]
    let user: ConversationNode | undefined
    for (let index = assistantIndex - 1; index >= 0; index--) {
      if (nodes[index].kind === 'user') {
        user = nodes[index]
        break
      }
    }
    if (!user?.content?.length) return undefined

    let previousTurnEnd: number | undefined
    if (typeof assistant.turn === 'number' && snapshot.turnEnds) {
      for (const [turn, endSeq] of snapshot.turnEnds) {
        if (turn < assistant.turn && (previousTurnEnd === undefined || endSeq > previousTurnEnd)) {
          previousTurnEnd = endSeq
        }
      }
    }

    return { content: [...user.content], previousTurnEnd }
  })

  const handle = async () => {
    if (!retryContext || busy) return
    setBusy(true)
    setError(null)
    let replacementSessionId: string | undefined
    let replacementOpened = false

    try {
      if (retryContext.previousTurnEnd !== undefined) {
        replacementSessionId = await sessions.fork({
          sessionId,
          atSeq: retryContext.previousTurnEnd,
          increaseTitle: false,
        })
      } else {
        const workspaceId = findWorkspaceId(sessionId, sessions, workspaces)
        if (!workspaceId) throw new Error('无法确定该会话所属工作区')
        replacementSessionId = await workspaces.connectWorkspace(workspaceId)
      }

      const replacement = sessions.binding(replacementSessionId)
      if (!replacement) throw new Error('重建会话失败')

      // 在截断后的会话上重新提交原始用户内容；旧回复不会出现在新分支中。
      await replacement.session.prompt(retryContext.content, 'queue')

      // 必须等新回复真正出现后再切换当前会话。只等待用户消息会在
      // 模型还未返回时切换到半初始化会话，导致详情页短暂白屏。
      await waitUntilReplacementHasAssistantContent(replacement.session)
      replacementOpened = true
      sessions.open(replacementSessionId)
      await workspaces.archiveSession(sessionId)
    } catch (cause) {
      // 如果已经打开替代会话，就不能再把它归档，否则旧会话归档失败时
      // 会误删用户当前正在查看的新会话。
      if (replacementSessionId && replacementSessionId !== sessionId && !replacementOpened) {
        try { await workspaces.archiveSession(replacementSessionId) } catch { /* 清理失败不覆盖原始错误 */ }
      }
      setError(toErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const onMouseEnter = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.color = 'var(--dsw-alias-label-primary)'
  }
  const onMouseLeave = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.color = error
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : 'var(--dsw-alias-label-tertiary)'
  }

  const title = error ? `重新生成失败：${error}` : retryContext ? '重新生成此回复' : '无法定位此回复对应的用户消息'

  return React.createElement('button', {
    type: 'button',
    'aria-label': title,
    title,
    disabled: busy || !retryContext,
    onClick: handle,
    style: {
      width: 28,
      height: 28,
      display: 'inline-flex',
      justifyContent: 'center',
      alignItems: 'center',
      cursor: busy || !retryContext ? 'default' : 'pointer',
      background: 'transparent',
      border: 'none',
      borderRadius: '50%',
      color: error ? 'var(--dsw-alias-state-error-primary, #d92d20)' : 'var(--dsw-alias-label-tertiary)',
      padding: 0,
      opacity: busy ? 0.5 : undefined,
    },
    onMouseEnter,
    onMouseLeave,
  },
    React.createElement('svg', {
      width: 16,
      height: 16,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
      React.createElement('path', { d: 'M13.5 8a5.5 5.5 0 0 1-9.5 3.5' }),
      React.createElement('path', { d: 'M2.5 8a5.5 5.5 0 0 1 9.5-3.5' }),
      React.createElement('polyline', { points: '6,4 2,4 2,8' }),
      React.createElement('polyline', { points: '10,12 14,12 14,8' }),
    ),
  )
}

async function waitUntilReplacementHasAssistantContent(session: SessionFace): Promise<void> {
  const hasContent = () => {
    const snapshot = session.getSnapshot()
    return (snapshot.nodes ?? []).some((node) => {
      if (node.kind !== 'assistant') return false
      return Array.isArray(node.content) && node.content.length > 0
    })
  }

  if (hasContent()) return

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | undefined
    let timeout: ReturnType<typeof setTimeout>
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      unsubscribe?.()
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }
    const check = () => { if (hasContent()) finish() }
    timeout = setTimeout(() => finish(new Error('等待新回复超时')), 30_000)
    unsubscribe = session.subscribe?.(check)
    check()
  })
}

function findWorkspaceId(sessionId: string, sessions: DshSessions, workspaces: DshWorkspaces): string | undefined {
  const session = sessions.list.getSnapshot().byId[sessionId]
  const items = workspaces.list.getSnapshot().items

  const samePath = items.find((item) => {
    const path = item.path ?? item.cwd ?? item.root
    return typeof path === 'string' && Boolean(session?.cwd) && path === session.cwd
  })
  const pathId = samePath?.id
  if (typeof pathId === 'string') return pathId

  const containingSession = items.find((item) => containsString(item, sessionId, 0))
  const containingId = containingSession?.id
  return typeof containingId === 'string' ? containingId : undefined
}

function containsString(value: unknown, expected: string, depth: number): boolean {
  if (value === expected) return true
  if (depth >= 4 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((item) => containsString(item, expected, depth + 1))
  return Object.values(value as Record<string, unknown>).some((item) => containsString(item, expected, depth + 1))
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

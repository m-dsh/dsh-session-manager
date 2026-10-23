import React from 'react'
import type { ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import { applyStickyPrompt } from './stickyPrompt'
import { ENGINE_COMMAND, hiddenSeqsOf, isExecutedRewindCommand, messageTextAt, type ChatOf, type ChatWatch, type HiddenChat } from './hidden'
import { closePopover, knownCommandSeqs, openPopover, prewarmPreview, registerComposerFocuser, registerPreviewCall, waitForCommand } from './popover'
import { previewOverRpc, type ConnectionLike } from './host-rpc'
import { EDIT_ICON_SVG, REWIND_ICON_SVG, REWIND_STYLE } from './styles'
import {
  SETTINGS_NAMESPACE,
  SessionManagerSection,
  injectSettingsCss,
  readSettings,
  type SessionManagerSettings,
} from './settings'

export const name = 'dsh-session-manager-client'
export const inject = ['slots', 'workspaces', 'sessions', 'configForms'] as const

interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe?(listener: () => void): () => void
}

interface SessionSummary {
  id: string
  title?: string
  displayTitle?: string
  cwd?: string
  /** 0.2.x：本地引用计数（mainView>0 即主视图正在展示的会话）。 */
  retainedBy?: Record<string, number>
}

interface SessionListState {
  ids: string[]
  byId: Record<string, SessionSummary>
  /** 老版本字段；0.2.1 起移除，改用 byId[id].retainedBy.mainView。 */
  current?: string
}

/**
 * 当前主视图会话 id：优先老版本的 current 字段；0.2.1 起取
 * retainedBy.mainView > 0 的会话（对齐 dsh-rewind 的 isMainViewSession）。
 */
function currentSessionId(sessions: DshSessions): string | undefined {
  const state = sessions.list.getSnapshot()
  if (typeof state.current === 'string' && state.current !== '') return state.current
  const byId = state.byId ?? {}
  for (const [id, row] of Object.entries(byId)) {
    if ((row.retainedBy?.mainView ?? 0) > 0) return id
  }
  return undefined
}

interface WorkspaceListState {
  items: readonly Record<string, unknown>[]
}

interface DshSlotReg {
  inject: (key: string, factory: () => unknown) => () => void
  register: (
    opts: Record<string, unknown>,
    comp: (props: Record<string, unknown>) => React.ReactElement,
  ) => () => void
}

interface DshWorkspaces {
  readonly list: ObservableSnapshot<WorkspaceListState>
  archiveSession(sessionId: string): Promise<void>
  connectWorkspace(workspaceId: string): Promise<string>
}

/** 0.1.2：Session.getSnapshot() 只有 queue/running 等控制字段，没有消息节点；
 *  消息上下文必须读 uiConversation 的 chat 视图（其 legacy 切片含 flat nodes + turnEnds）。 */
interface RemoteCommandResult {
  ok: boolean
  value?: { matched?: boolean }
  error?: { code?: string; message?: string }
}

interface SessionFace {
  prompt(parts: unknown[], mode: 'queue' | 'steer', signal?: AbortSignal): Promise<unknown>
  /** 执行一条斜杠命令（纯接纳语义；结局以 chat 视图的 CommandNode 落定）。 */
  command(line: string): Promise<RemoteCommandResult>
}

interface DshSessions {
  readonly list: ObservableSnapshot<SessionListState>
  binding(id: string): { session: SessionFace } | undefined
  fork(opts: { sessionId: string; atSeq?: number; increaseTitle?: boolean }): Promise<string>
  open(id: string): void
  /** 会话输入 shell 的作用域键（composer draft 写入需要）。 */
  scope?(id: string): unknown
}

interface ConversationNode {
  kind: string
  seq: number
  messageId?: string
  turn?: number
  content?: unknown[]
}

interface ChatLegacySliceView {
  turnEnds?: ReadonlyMap<number, number>
  nodes?: readonly ConversationNode[]
}

interface ChatViewNode {
  key?: string
  id?: string
  kind?: string
  anchorSeq?: number
  visibility?: string
  location?: { kind?: string; turn?: { turn?: number } }
  data?: { seq?: number; content?: unknown[]; finalNode?: { messageId?: string; id?: string }; status?: string } | null
}

/** 0.1.2 里助手的 chat 节点 kind 实际是 "assistant-step"（不是 "assistant"）。 */
function isAssistantNode(node: ChatViewNode): boolean {
  return node.kind === 'assistant-step' || node.kind === 'assistant'
}

interface ChatNodeStoreView {
  values(): readonly ChatViewNode[]
}

interface ChatSnapshotView {
  order?: readonly string[]
  nodes?: ChatNodeStoreView
  /** 按 turn 聚合的节点索引(0.2.x 快照携带;缺席时 chrome 判定容忍降级)。 */
  locations?: { getTurn(turn: number): readonly string[] }
  legacy?: ChatLegacySliceView
}

/** 0.1.2 ConversationSnapshot：入口是 views store，chat 只是其中一个 target。 */
interface ConversationSnapshot {
  views?: { get(target: string): ChatSnapshotView | undefined }
}

interface ChatSource {
  getSnapshot(): ChatSnapshotView | undefined
  subscribe(listener: () => void): () => void
}

interface ConversationStore {
  snapshot: ObservableSnapshot<ConversationSnapshot>
  target(target: string): ChatSource
}

interface DshUiConversation {
  binding(sessionId: string): ConversationStore | undefined
}

/**
 * Client 侧连接句柄（RPC 调用面）。
 * 仅列出本插件使用的业务成员；设置控制器类型使用公开的 ConfigForm 契约。
 */
interface ClientContext {
  slots: DshSlotReg
  workspaces: DshWorkspaces
  sessions: DshSessions
  configForms: Pick<ConfigForms, 'get'>
  get(name: 'uiConversation'): DshUiConversation | undefined
  get(name: 'connection'): unknown
  get(name: 'conversation'): unknown
  on?: (name: 'dispose', callback: () => void) => void
}

/** 上下文解析器：安装早于宿主服务启动时，一次性捕获会拿到 undefined，必须按需取。 */
type Resolver<T> = () => T | undefined

export function apply(ctx: ClientContext): void {
  const { slots, workspaces, sessions } = ctx
  // 不在 install 期捕获 uiConversation / connection：宿主服务可能晚于插件启动，
  // 捕获到 undefined 会让回合同步永久拿不到 chat 快照，按钮就再也不出现。
  const getUiConversation: Resolver<DshUiConversation> = () => {
    try {
      return ctx.get('uiConversation')
    } catch {
      return undefined
    }
  }
  // ── 设置开关：sticky prompt 与"删除会话"受设置面板控制，切换时实时安装/卸载 ──
  const scope = ctx.configForms.get<SessionManagerSettings>(SETTINGS_NAMESPACE)
  const disposeSettingsCss = injectSettingsCss()

  let disposeSticky: (() => void) | undefined
  let disposeSessionMenu: (() => void) | undefined

  // 注入时复核用的实时读取器：每个实例都从同一个宿主设置镜像取值，
  // 所以即使页面上残留着旧 bundle 的实例，开关关闭后也不会再注入。
  const stickyEnabledNow = (): boolean => readSettings(scope.getSnapshot()).stickyPrompt
  const sessionDeleteEnabledNow = (): boolean => readSettings(scope.getSnapshot()).sessionDelete

  const syncFeatureGates = (): void => {
    const { stickyPrompt, sessionDelete } = readSettings(scope.getSnapshot())

    if (stickyPrompt && disposeSticky === undefined) {
      disposeSticky = applyStickyPrompt(stickyEnabledNow, () => {
        try {
          return currentSessionId(sessions)
        } catch {
          return undefined
        }
      })
    }
    else if (!stickyPrompt && disposeSticky !== undefined) {
      disposeSticky()
      disposeSticky = undefined
    }

    // DSH 当前没有"会话行菜单项"扩展 Slot。这里仅做菜单兼容层，
    // 将"删除会话"追加到会话菜单末尾（内置“复制 Session ID”之后），而不再占用会话详情头部。
    if (sessionDelete && disposeSessionMenu === undefined) {
      disposeSessionMenu = installSessionMenuDelete(workspaces, sessions, sessionDeleteEnabledNow)
    } else if (!sessionDelete && disposeSessionMenu !== undefined) {
      disposeSessionMenu()
      disposeSessionMenu = undefined
    }
  }

  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: SETTINGS_NAMESPACE,
        order: 710,
        label: '会话管理',
        inject: () => ({ scope }),
      },
      SessionManagerSection as (props: Record<string, unknown>) => React.ReactElement,
    ),
  )

  const unsubscribeSettings = scope.subscribe(syncFeatureGates)
  syncFeatureGates()

  // ── 助手消息"重新生成"（常驻；不属于设置开关） ──
  slots.inject('conversation.chat.assistant-actions', () => {
    return slots.register(
      { name: 'conversation.chat.assistant-actions', id: 'retry-message', order: -10, label: '重新生成' },
      function RetryAction(props: Record<string, unknown>) {
        // 0.1.2：assistant-actions 为 session 作用域 slot，标准注入里带 sessionId；
        // useSession 的快照无消息节点，上下文改由 getUiConversation 的 chat 视图读取。
        const sessionId = String(props.sessionId ?? '')
        const messageId = String(props.messageId ?? '')
        return React.createElement(RetryButton, {
          key: messageId,
          sessionId,
          messageId,
          sessions,
          getUiConversation,
        })
      },
    )
  })

  // ── 回退入口（常驻在每条用户消息 actions 行，DOM 注入 + 模式浮层）──
  const getConversation: Resolver<unknown> = () => {
    try {
      return ctx.get('conversation')
    } catch {
      return undefined
    }
  }
  const getConnection: Resolver<unknown> = () => {
    try {
      return ctx.get('connection')
    } catch {
      return undefined
    }
  }
  const disposeRewind = installRewindEntries(sessions, getUiConversation, getConversation, getConnection)
  ctx.on?.('dispose', disposeRewind)
  ctx.on?.('dispose', () => closePopover())

  ctx.on?.('dispose', () => {
    unsubscribeSettings()
    disposeSticky?.()
    disposeSessionMenu?.()
    disposeSettingsCss()
  })
}

// ═══════════════════════════════════════════════════════════
//  Checkpoint 回滚入口（DOM 注入到每条用户消息上方，悬浮显示）
// ═══════════════════════════════════════════════════════════

/** 取用户消息首个文本块(前 80 字)。 */
function extractUserText(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>
      // 原始 ContentBlock 用 `type: 'text'`；UI 分类块用 `kind: 'text'`，两者都兼容
      if ((b.type === 'text' || b.kind === 'text') && typeof b.text === 'string') {
        return b.text.slice(0, 80)
      }
    }
  }
  return ''
}

/** 一条可回退的用户消息：按钮与浮层的目标。 */
interface RewindCandidate {
  /** 用户消息节点在 chat 视图中的稳定 key，用于匹配 DOM 行 */
  key: string
  /** 目标 user/message 事件 seq（= 节点 anchorSeq；@seq 回退目标） */
  seq: number
  /** 该条用户文本预览 */
  preview: string
}

/**
 * 把本仓的 ChatSnapshotView 适配成 hidden 模块的 HiddenChat 读取器：
 * hidden 的算法按 order+get(key) 消费快照，本仓节点存储只有 values()。
 */
function hiddenChatOf(chat: ChatSnapshotView | undefined): HiddenChat | undefined {
  if (!chat?.nodes) return undefined
  const byKey = new Map<string, ChatViewNode>()
  const orderKeys: string[] = []
  for (const node of chat.nodes.values()) {
    if (typeof node.key === 'string' && node.key !== '') {
      byKey.set(node.key, node)
      orderKeys.push(node.key)
    }
  }
  // order 缺席时以 values() 的 key 序合成（老版快照没有 order 字段）。
  const order = chat.order ?? orderKeys
  return {
    order,
    nodes: {
      get: (key: string) => {
        const node = byKey.get(key)
        if (node === undefined) return undefined
        return node as never
      },
    },
    // locations 必须透传：turn 摘要行（终止/用时提示）的锚点序号在回退
    // 目标之前，区间裁剪够不到，只能按「整轮成员全部被撤」判定。
    ...(chat.locations !== undefined ? { locations: chat.locations } : {}),
  }
}

/** key → 节点索引（隐藏判定按行 key 找 anchorSeq）。 */
function nodeKeyIndex(chat: ChatSnapshotView | undefined): Map<string, ChatViewNode> {
  const byKey = new Map<string, ChatViewNode>()
  if (!chat?.nodes) return byKey
  for (const node of chat.nodes.values()) {
    if (typeof node.key === 'string' && node.key !== '') byKey.set(node.key, node)
  }
  return byKey
}

/**
 * 从 chat 视图精确计算每条可回退的用户消息：in-place 方案的目标就是消息
 * 自身的 seq（不再需要 turnEnds 推 fork 边界）。用户气泡与 steering 插话
 * 都算（插话尚未被模型读取，同样可撤回）。
 */
function computeRewindCandidates(chat: ChatSnapshotView | undefined): RewindCandidate[] {
  if (!chat?.nodes) return []
  const byKey = nodeKeyIndex(chat)
  // order 缺席时以 values() 的 key 序兜底（老版快照没有 order 字段）。
  const keys = chat.order ?? [...byKey.keys()]
  const result: RewindCandidate[] = []
  for (const key of keys) {
    const node = byKey.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
    // 目标 seq：优先 anchorSeq；老视图缺该字段时回落 data.seq（同为事件 seq）。
    const seq = typeof node.anchorSeq === 'number' ? node.anchorSeq : node.data?.seq
    if (typeof seq !== 'number') continue
    result.push({
      key,
      seq,
      preview: extractUserText(node.data?.content),
    })
  }
  return result
}

// ── 用户消息「刷新」目标：定位每条用户消息的内容与 fork 边界，用于重新回答该提示词 ──

interface UserRefreshTarget {
  key: string
  /** 目标 user/message 事件 seq（就地回退的 @seq）。 */
  seq: number
  turn: number
  content: unknown[]
  previousTurnEnd: number | undefined
  /** 该回合是否仍在生成回复（生成中禁止再刷新）。 */
  generating: boolean
  /** 同回合所有助手节点的 seat key：点击刷新瞬间降暗+占位，避免 fork 期间的“卡住”观感。 */
  assistantKeys: string[]
}

function computeUserRefreshTargets(chat: ChatSnapshotView | undefined): Map<string, UserRefreshTarget> {
  const map = new Map<string, UserRefreshTarget>()
  if (!chat?.nodes) return map

  const generatingTurns = new Set<number>()
  const assistantKeysByTurn = new Map<number, string[]>()
  for (const node of chat.nodes.values()) {
    const turn = node.location?.turn?.turn
    if (!isAssistantNode(node)) continue
    if (typeof turn === 'number') {
      if (typeof node.key === 'string' && node.key !== '') {
        const keys = assistantKeysByTurn.get(turn) ?? []
        keys.push(node.key)
        assistantKeysByTurn.set(turn, keys)
      }
      const status = (node.data as { status?: unknown } | null | undefined)?.status
      if (status === 'running') generatingTurns.add(turn)
    }
  }

  const turnEnds = chat.legacy?.turnEnds
  for (const node of chat.nodes.values()) {
    // 0.2.1 视图节点不再携带 visibility 字段：仅显式 hidden 才跳过，
    // 缺席(undefined)视为可见（老版本取值 'visible' 同样通过）。
    if (node.kind !== 'user' || node.visibility === 'hidden') continue
    if (typeof node.key !== 'string' || node.key === '') continue
    const turn = node.location?.turn?.turn
    if (typeof turn !== 'number') continue
    const content = node.data?.content
    if (!Array.isArray(content) || content.length === 0) continue
    // 就地重发需要目标 seq（anchorSeq 优先，老快照回退 data.seq）。
    const seq = typeof node.anchorSeq === 'number' ? node.anchorSeq : node.data?.seq
    if (typeof seq !== 'number') continue

    let previousTurnEnd: number | undefined
    if (turnEnds) {
      for (const [completedTurn, endSeq] of turnEnds) {
        if (completedTurn < turn && (previousTurnEnd === undefined || endSeq > previousTurnEnd)) {
          previousTurnEnd = endSeq
        }
      }
    }
    map.set(node.key, {
      key: node.key,
      seq,
      turn,
      content: [...content],
      previousTurnEnd,
      generating: generatingTurns.has(turn),
      assistantKeys: assistantKeysByTurn.get(turn) ?? [],
    })
  }
  return map
}

function refreshIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.append(
    createSvgElement('path', { d: 'M13.5 8a5.5 5.5 0 0 1-9.5 3.5' }),
    createSvgElement('path', { d: 'M2.5 8a5.5 5.5 0 0 1 9.5-3.5' }),
    createSvgElement('polyline', { points: '6,4 2,4 2,8' }),
    createSvgElement('polyline', { points: '10,12 14,12 14,8' }),
  )
  return svg
}

/** 把刷新按钮放到「时间」之后（复制/回滚之前）；无时间元素时退回最前。 */
function placeRefreshButton(actions: HTMLElement, button: HTMLElement): void {
  const time = actions.querySelector<HTMLElement>('[class*="timeStart"], [class*="timeEnd"]')
  if (time) {
    if (time.nextSibling !== button) actions.insertBefore(button, time.nextSibling)
    return
  }
  if (actions.firstChild !== button) actions.insertBefore(button, actions.firstChild)
}

function escapeSelector(value: string): string {
  try {
    const escape = (window as unknown as { CSS?: { escape(value: string): string } }).CSS?.escape
    if (escape) return escape(value)
  } catch {
    // 读取 CSS.escape 失败则走手动转义。
  }
  return value.replace(/["\\]/g, '\\$&')
}

/**
 * 点击刷新/重新生成后的即时反馈：把该回合的助手 seat 降暗并追加“正在回复中…”占位，
 * 让 fork 在后台跑时不显得卡住。返回的 restore 在成功切换或失败后调用（幂等）。
 * 优先按 seat key 精确命中；key 缺失/查不到时退回按 data-chat-turn 整轮（排除用户行）。
 */
function showRegeneratingPlaceholder(seatKeys: readonly string[], turn?: number): () => void {
  if (typeof document === 'undefined') return () => undefined
  const seats: HTMLElement[] = []
  for (const key of seatKeys) {
    if (!key) continue
    const seat = document.querySelector<HTMLElement>(`[data-chat-flow-key="${escapeSelector(key)}"]`)
    if (seat) seats.push(seat)
  }
  if (seats.length === 0 && typeof turn === 'number') {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[data-chat-turn="${turn}"]`))) {
      const kind = el.getAttribute('data-chat-flow-kind') ?? ''
      if (kind !== 'user' && kind !== 'steering') seats.push(el)
    }
  }
  if (seats.length === 0) return () => undefined

  for (const seat of seats) {
    seat.style.opacity = '0.5'
    seat.style.filter = 'saturate(0.55)'
  }
  // 占位只挂在最后一个助手节点上，避免同回合多步重复出现。
  const badge = document.createElement('div')
  badge.className = 'dsh-regen-placeholder'
  badge.textContent = '正在回复中…'
  seats[seats.length - 1].appendChild(badge)

  return () => {
    for (const seat of seats) {
      seat.style.opacity = ''
      seat.style.filter = ''
    }
    badge.remove()
  }
}

/** 在 actions 行里维护「刷新」按钮（位于时间之后）。 */
function ensureRefreshButton(
  actions: HTMLElement,
  target: UserRefreshTarget,
  run: (target: UserRefreshTarget, button: HTMLButtonElement) => void,
): void {
  const existing = actions.querySelector<HTMLButtonElement>('[data-dsh-refresh="true"]')
  if (existing) {
    // 每次 sync 重新确认位置，避免被宿主渲染/复制按钮重置。
    placeRefreshButton(actions, existing)
    return
  }

  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.dshRefresh = 'true'
  button.dataset.dshRefreshKey = target.key
  button.setAttribute('aria-label', `刷新第 ${target.turn} 条提示词`)
  button.title = `重新回答第 ${target.turn} 条提示词`
  button.style.cssText = [
    'background:transparent', 'border:none', 'border-radius:28px', 'cursor:pointer', 'padding:6px',
    'display:inline-flex', 'justify-content:center', 'align-items:center',
    'color:var(--dsw-alias-label-tertiary)', 'width:28px', 'height:28px',
  ].join(';')
  // 与复制按钮一致的 hover 高亮（宿主是 CSS 类 hover，这里用内联态等价实现）。
  button.addEventListener('mouseenter', () => {
    button.style.background = 'var(--dsw-alias-interactive-bg-hover)'
    button.style.color = 'var(--dsw-alias-label-secondary)'
  })
  button.addEventListener('mouseleave', () => {
    button.style.background = 'transparent'
    button.style.color = 'var(--dsw-alias-label-tertiary)'
  })
  button.appendChild(refreshIcon())
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    run(target, button)
  })
  placeRefreshButton(actions, button)
}

const CHECKPOINT_PILL = '[data-dsh-checkpoint-pill="true"]'

/** actions 容器必须真实持有按钮；空装饰壳（可能匹配 actions 前缀类名）不能当宿主。 */
/**
 * 行 → chat 节点：按 0.2.1 的行身份解析——`data-chat-anchor-key`（FLOW key，
 * step 部件是复合 `["<nodeKey>","<part>"]`）优先，`data-chat-node-key`（纯
 * 节点 key）兜底，旧版 `data-chat-flow-key` 再兜底。对齐 dsh-rewind 的
 * resolveSeatAnchorSeq 与官方 viewport 自己的身份读取。
 */
function resolveSeatNode(
  row: HTMLElement,
  nodesByKey: Map<string, ChatViewNode>,
): ChatViewNode | undefined {
  const anchorKey = row.dataset.chatAnchorKey
  const nodeKey = row.dataset.chatNodeKey
  const legacyKey = row.getAttribute('data-chat-flow-key')
  return (anchorKey !== undefined && anchorKey !== '' ? nodesByKey.get(anchorKey) : undefined)
    ?? (nodeKey !== undefined && nodeKey !== '' ? nodesByKey.get(nodeKey) : undefined)
    ?? (legacyKey !== null && legacyKey !== '' ? nodesByKey.get(legacyKey) : undefined)
}

/**
 * 定位用户行的 actions 容器（复制/分支按钮所在的 IconActions 行）。
 * 结构性定位：actions 行总是排在行内最后（图片缩略图也是 button 且在前
 * 面），取「最后一个非本插件按钮」的父元素；失败回落 class 扫描
 * （老版 DOM）。对齐 dsh-rewind 的 actionsContainerOf。
 */
function actionsContainerOf(row: HTMLElement): HTMLElement | undefined {
  const own = (button: HTMLButtonElement): boolean =>
    button.dataset.dshCheckpointButton === 'true'
    || button.dataset.dshCheckpointActionButton === 'true'
    || button.dataset.dshRefresh === 'true'
    || button.closest(CHECKPOINT_PILL) !== null
  const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>('button'))
  const lastButton = buttons.filter(button => !own(button)).at(-1)
  const structural = lastButton?.parentElement
  if (structural instanceof HTMLElement && structural.querySelector('button') !== null) return structural
  return findActionsRow(row)
}

function findActionsRow(row: HTMLElement): HTMLElement | undefined {
  const candidates = Array.from(row.querySelectorAll<HTMLElement>('[class*="_actions"], [class*="actions"]'))
  return candidates.find((element) => element.querySelector('button') !== null) ?? candidates[0]
}

function ensureRewindStyle(): void {
  // HMR/重启可能已经留下旧版 style；必须更新它，而不是只检查后直接返回。
  const style = document.querySelector<HTMLStyleElement>('style[data-dsh-checkpoint-style]') ?? document.createElement('style')
  style.dataset.dshCheckpointStyle = 'true'
  style.textContent = [
    REWIND_STYLE,
    // 直接作为用户消息 actions 行中的一个按钮，和复制按钮水平对齐并常驻显示。
    `${CHECKPOINT_PILL}{display:contents!important;opacity:1!important;visibility:visible!important;pointer-events:auto!important}`,
    `${CHECKPOINT_PILL}>button{flex:none!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;cursor:pointer!important}`,
    // 刷新/重新生成的即时占位（点击瞬间出现，fork 完成切走后自然消失）。
    `.dsh-regen-placeholder{display:inline-flex!important;align-items:center!important;gap:6px!important;margin-top:8px!important;padding:4px 10px!important;border-radius:12px!important;font-size:12px!important;line-height:18px!important;color:var(--dsw-alias-label-secondary,#666)!important;background:var(--dsw-alias-interactive-bg-default,rgba(127,127,127,0.12))!important}`,
    `.dsh-regen-placeholder::before{content:""!important;width:6px!important;height:6px!important;border-radius:50%!important;background:currentColor!important;animation:dsh-regen-pulse 1.1s ease-in-out infinite!important}`,
    `@keyframes dsh-regen-pulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}`,
  ].join('\n')
  if (!style.parentElement) document.head.appendChild(style)
}

function currentSessionSnapshot(
  sessions: DshSessions,
  getUiConversation: Resolver<DshUiConversation>,
): { sessionId: string; chat?: ChatSnapshotView } | undefined {
  const sessionId = currentSessionId(sessions)
  if (!sessionId) return undefined
  let chat: ChatSnapshotView | undefined
  try {
    const binding = getUiConversation()?.binding(sessionId)
    // 0.2.1：chat 视图经 binding(id).target('chat') 读取（dsh-rewind 的方式）；
    // 老版本回落 snapshot.getSnapshot().views.get('chat')。
    chat = binding?.target?.('chat')?.getSnapshot()
      ?? binding?.snapshot?.getSnapshot()?.views?.get('chat')
      ?? undefined
  } catch {
    chat = undefined
  }
  return { sessionId, chat }
}

function removeAllCheckpointPills(): void {
  for (const element of Array.from(document.querySelectorAll(CHECKPOINT_PILL))) element.remove()
}


/** ✎ 编辑图标（与 ↶ 同一套视觉参数）。 */
function editIcon(): Element {
  const template = document.createElement('template')
  template.innerHTML = EDIT_ICON_SVG.trim()
  const icon = template.content.firstElementChild
  if (icon === null) throw new Error('edit icon svg is empty')
  return icon
}

/** dsh-rewind 的 ↶ 图标（内联 SVG，描边 1.25 与相邻操作按钮对齐）。 */
function rewindIcon(): Element {
  const template = document.createElement('template')
  template.innerHTML = REWIND_ICON_SVG.trim()
  const icon = template.content.firstElementChild
  if (icon === null) throw new Error('rewind icon svg is empty')
  return icon
}

/**
 * 绑定按钮的回退动作：pointerdown 捕获点击意图（避免宿主在 click 前重绘
 * 吞掉事件），并顺带预取 preview——按下到弹起的窗口足够覆盖探测往返，
 * 浮层打开时直接以落定态渲染。
 */
function attachCheckpointAction(button: HTMLButtonElement, onOpen: () => void, onPrewarm?: () => void): void {
  const prewarm = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    try {
      onPrewarm?.()
    } catch {
      // 预取失败留给 open 时的正常路径。
    }
  }
  const activate = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    onOpen()
  }
  button.addEventListener('pointerdown', prewarm, true)
  button.addEventListener('click', activate, true)
}

function createRewindPill(cp: RewindCandidate, key: string, onOpen: () => void, onPrewarm?: () => void, onEdit?: () => void): HTMLElement {
  const pill = document.createElement('div')
  pill.dataset.dshCheckpointPill = 'true'
  pill.dataset.dshCheckpointKey = key

  // 回退按钮（首个;复制模板克隆只认它）
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', '回退到这条消息')
  button.title = cp.preview ? `回退到这条消息：${cp.preview}` : '回退到这条消息'
  button.dataset.dshCheckpointButton = 'true'
  button.replaceChildren(rewindIcon())
  attachCheckpointAction(button, onOpen, onPrewarm)
  pill.appendChild(button)

  // 编辑按钮：回退到这条消息并把文本回填输入框，改完手动重发。
  // 不参与复制模板克隆（克隆只替换首个按钮），用与刷新按钮一致的静态样式。
  if (onEdit !== undefined) {
    const editButton = document.createElement('button')
    editButton.type = 'button'
    editButton.dataset.dshEditButton = 'true'
    editButton.setAttribute('aria-label', '编辑这条消息')
    editButton.title = '编辑这条消息并重发（撤回它及其后的对话）'
    editButton.style.cssText = [
      'background:transparent', 'border:none', 'border-radius:28px', 'cursor:pointer', 'padding:6px',
      'display:inline-flex', 'justify-content:center', 'align-items:center',
      'color:var(--dsw-alias-label-tertiary)', 'width:28px', 'height:28px',
    ].join(';')
    editButton.addEventListener('mouseenter', () => {
      editButton.style.background = 'var(--dsw-alias-interactive-bg-hover)'
      editButton.style.color = 'var(--dsw-alias-label-secondary)'
    })
    editButton.addEventListener('mouseleave', () => {
      editButton.style.background = 'transparent'
      editButton.style.color = 'var(--dsw-alias-label-tertiary)'
    })
    editButton.replaceChildren(editIcon())
    attachCheckpointAction(editButton, onEdit)
    pill.appendChild(editButton)
  }
  return pill
}

function adoptCopyButtonStyle(
  pill: HTMLElement,
  actions: HTMLElement,
  cp: RewindCandidate,
  onOpen: () => void,
  onPrewarm?: () => void,
): void {
  const current = pill.querySelector('button') as HTMLButtonElement | null
  if (!current || current.dataset.dshCopyStyle === 'true') return
  const template = Array.from(actions.querySelectorAll('button')).find((button) => {
    const label = button.getAttribute('aria-label')?.toLowerCase() ?? ''
    return label === '复制' || label === 'copy'
  }) as HTMLButtonElement | undefined
  if (!template) return

  const replacement = template.cloneNode(true) as HTMLButtonElement
  replacement.dataset.dshCopyStyle = 'true'
  replacement.dataset.dshCheckpointActionButton = 'true'
  replacement.setAttribute('aria-label', '回退到这条消息')
  replacement.title = cp.preview ? `回退到这条消息：${cp.preview}` : '回退到这条消息'
  // 复用复制按钮的尺寸、间距和 class，但用回退图标避免误认为复制。
  replacement.replaceChildren(rewindIcon())
  current.replaceWith(replacement)
  attachCheckpointAction(replacement, onOpen, onPrewarm)
}

/** 就地重发钩子：installRewindEntries 装配时写入,卸载时清除;RetryButton 经它复用同一管线。 */
let regenerateHook: ((sessionId: string, seq: number) => Promise<void>) | undefined

/**
 * 回退入口安装（常驻在每条用户消息 actions 行，DOM 注入）：
 * - ↶ 按钮 + 模式浮层（chat / both+影响清单）
 * - 被撤回行的隐藏（data-dsh-rewind-hidden，观测性标记）
 * - 回退成功后把目标消息文本回填 composer
 * 保留本仓原有的 MutationObserver + actions 行适配骨架（不引 React portal）。
 */
function installRewindEntries(
  sessions: DshSessions,
  getUiConversation: Resolver<DshUiConversation>,
  getConversation: () => unknown,
  getConnection: Resolver<unknown>,
): () => void {
  if (typeof document === 'undefined') return () => undefined

  ensureRewindStyle()

  // 影响预览走 Connection RPC（不产生会话日志事件）；连接缺席时预览报错，
  // 回退执行不受影响（走会话命令通道）。
  registerPreviewCall((sessionId, seq) =>
    previewOverRpc(getConnection() as ConnectionLike | undefined, sessionId, seq))

  let disposed = false
  let syncing = false
  let lastDebugSignature = ''

  // 排查用：浏览器控制台执行
  // localStorage.setItem('dshSessionManagerDebug', '1')
  const debugEnabled = (): boolean => {
    try {
      return window.localStorage.getItem('dshSessionManagerDebug') === '1'
    } catch {
      return false
    }
  }

  // 每次 sync 更新的最新 refresh 目标：click 闭包可能绑定较旧 target，运行时按 key 取最新。
  let latestRefreshTargets = new Map<string, UserRefreshTarget>()

  /** 用户消息「刷新」：共用重新生成核心；成功即替换原回答（原会话归档）。 */
  const runRefresh = (target: UserRefreshTarget, button: HTMLButtonElement): void => {
    const sessionId = currentSessionId(sessions)
    if (!sessionId) return
    // 取最新 target（闭包里的可能较旧），保证 seq 与当前视图一致。
    const current = latestRefreshTargets.get(target.key) ?? target
    button.disabled = true
    button.style.opacity = '0.5'
    // 点击瞬间降暗该轮回答并占位“正在回复中…”，覆盖回退往返的短窗口。
    const restore = showRegeneratingPlaceholder(current.assistantKeys, current.turn)
    void regenerateInPlace(sessionId, current.seq)
      .catch((error) => {
        button.title = `刷新失败：${toErrorMessage(error)}`
      })
      .finally(() => {
        restore()
        button.disabled = false
        button.style.opacity = ''
      })
  }

  /** 某会话的 chat 视图快照（读取失败降级 undefined）。 */
  const chatViewOf = (sessionId: string): ChatSnapshotView | undefined => {
    try {
      const binding = getUiConversation()?.binding(sessionId)
      return binding?.target?.('chat')?.getSnapshot()
        ?? binding?.snapshot?.getSnapshot()?.views?.get('chat')
        ?? undefined
    } catch {
      return undefined
    }
  }

  /** hidden 模块的 chat 读取器（order + get(key)）。 */
  const chatOf: ChatOf = (session) => hiddenChatOf(session === undefined ? undefined : chatViewOf(session.sessionId))

  /** chat 快照更新信号：等待命令结局时被唤醒。 */
  const watchChat: ChatWatch = (sessionId, cb) => {
    try {
      return getUiConversation()?.binding(sessionId)?.target?.('chat')?.subscribe?.(cb) ?? (() => {})
    } catch {
      return () => {}
    }
  }

  /** composer 的 DOM 兜底：直接写 contenteditable（Lexical 经 input 事件接管）。 */
  const fillComposerEditable = (text: string): boolean => {
    const editable = document.querySelector<HTMLElement>('[data-composer-input]')
    if (editable === null) return false
    editable.focus()
    const selection = document.getSelection()
    if (selection !== null) {
      const range = document.createRange()
      range.selectNodeContents(editable)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    let ok = false
    try {
      ok = document.execCommand('insertText', false, text)
    } catch {
      ok = false
    }
    if (ok) return true
    editable.textContent = text
    editable.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  /**
   * composer 写入：优先宿主 conversation.input 的 setDraft（整稿替换），
   * 失败降级 DOM contenteditable。绝不抛错。
   */
  const writeComposer = (sessionId: string, text: string): boolean => {
    try {
      const conversation = getConversation() as {
        input?: { for(actx: unknown): { setDraft(text: string): void; focus?(): void } }
      } | undefined
      const scope = sessions.scope?.(sessionId)
      const facade = conversation?.input !== undefined && scope !== undefined
        ? conversation.input.for(scope)
        : undefined
      if (facade !== undefined) {
        try {
          facade.setDraft(text)
          try {
            facade.focus?.()
          } catch {
            // 聚焦是表现层；回填的草稿才是重点。
          }
          return true
        } catch {
          // facade 抛错（会话拆除窗口）视作缺席，走 DOM 通道。
        }
      }
    } catch {
      // 读取失败走 DOM 通道。
    }
    return fillComposerEditable(text)
  }

  /** 用 Enter 提交 composer（就地重发的最后一步）。 */
  const submitComposer = (): boolean => {
    const editable = document.querySelector<HTMLElement>('[data-composer-input]')
    if (editable === null) return false
    editable.focus()
    editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return true
  }

  // ── 行内编辑器:点 ✎ 时消息原位变输入框,确定时才回退并发送改后文本 ──
  let editingRow: HTMLElement | null = null

  /** 关闭编辑器并还原消息原样(取消/成功后/开新编辑器时调用)。 */
  const closeEditor = (): void => {
    if (editingRow === null) return
    editingRow.removeAttribute('data-dsh-editing')
    editingRow.querySelector('[data-dsh-edit-editor]')?.remove()
    editingRow = null
  }

  /** 在目标用户行打开行内编辑器(同一时刻仅一个)。 */
  const openEditor = (row: HTMLElement, cp: RewindCandidate): void => {
    closePopover()
    closeEditor()
    const sessionId = currentSessionId(sessions)
    if (sessionId === undefined) return
    // 原文优先取快照全文;读不到时退 pill 预览(截断)。
    const original = messageTextAt(chatOf({ sessionId }), cp.seq) ?? cp.preview

    row.dataset.dshEditing = 'true'
    editingRow = row

    const editor = document.createElement('div')
    editor.dataset.dshEditEditor = 'true'
    editor.style.cssText = [
      'display:flex', 'flex-direction:column', 'gap:8px', 'width:100%',
      'padding:10px', 'border:1px solid var(--dsw-alias-border-l2,#e4e7ec)',
      'border-radius:12px', 'background:var(--dsw-alias-bg-primary,#fff)',
    ].join(';')

    const textarea = document.createElement('textarea')
    textarea.value = original
    textarea.setAttribute('aria-label', '编辑用户提示词')
    // 字号对齐 composer（基础 UI 字号 + 内容字号增量），不要继承转录区的
    // 内容字号（更大）；高度封顶 + 内滚——长文在编辑器内滚动，不把行撑出
    // 可视区导致外层无法滚动查看。
    const MAX_EDITOR_HEIGHT = 320
    textarea.style.cssText = [
      'box-sizing:border-box', 'width:100%', 'min-height:64px', `max-height:${MAX_EDITOR_HEIGHT}px`,
      'resize:none', 'border:none', 'outline:none', 'overflow-y:auto',
      'background:transparent', 'color:var(--dsw-alias-label-primary,#101828)',
      'font-family:inherit',
      'font-size:calc(14px + var(--dsh-content-font-delta, 0px))',
      'line-height:20px', 'white-space:pre-wrap',
    ].join(';')
    const autoSize = (): void => {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_EDITOR_HEIGHT)}px`
    }
    textarea.addEventListener('input', autoSize)

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'.split(';').join(';')

    const hint = document.createElement('span')
    hint.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-tertiary,#667085);align-self:center;margin-right:auto'

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = '取消'
    cancel.style.cssText = [
      'padding:5px 12px', 'border:none', 'border-radius:8px', 'cursor:pointer',
      'background:transparent', 'color:var(--dsw-alias-label-secondary,#475467)', 'font-size:13px',
    ].join(';')
    cancel.addEventListener('click', closeEditor)

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.textContent = '确定'
    confirm.style.cssText = [
      'padding:5px 12px', 'border:none', 'border-radius:8px', 'cursor:pointer',
      'background:var(--dsw-alias-button-primary-fill,#13715b)',
      'color:var(--dsw-alias-label-primary-foreground,#fff)', 'font-size:13px',
    ].join(';')

    const runConfirm = (): void => {
      const text = textarea.value
      if (text.trim() === '') {
        // 空文本无法作为提示词发送,视为放弃编辑。
        closeEditor()
        return
      }
      confirm.disabled = true
      confirm.textContent = '正在回退…'
      hint.textContent = ''
      void (async () => {
        // 确认时才回退:撤回该消息及其后,回填改后文本并自动发送。
        const ok = await rewindAndRefillSession(sessionId, cp.seq, 'chat', undefined, text)
        if (ok) {
          closeEditor()
          submitComposer()
        } else {
          confirm.disabled = false
          confirm.textContent = '确定'
          hint.textContent = '回退失败，请重试'
        }
      })().catch(() => {
        confirm.disabled = false
        confirm.textContent = '确定'
        hint.textContent = '回退失败，请重试'
      })
    }
    confirm.addEventListener('click', runConfirm)

    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeEditor()
        return
      }
      // Enter 换行(提示词常多行);Cmd/Ctrl+Enter 确认。
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        event.stopPropagation()
        runConfirm()
      }
    })

    actions.append(hint, cancel, confirm)
    editor.append(textarea, actions)
    row.prepend(editor)
    autoSize()
    textarea.focus()
    // 消息原本很高时，编辑器可能落在视口外：滚到可见。
    editor.scrollIntoView({ block: 'nearest' })
  }

  // 浮层关闭后把键盘还给当前会话的 composer（只聚焦，绝不写草稿）。
  registerComposerFocuser((sessionId) => {
    try {
      const conversation = getConversation() as {
        input?: { for(actx: unknown): { focus?(): void } }
      } | undefined
      const scope = sessions.scope?.(sessionId)
      const facade = conversation?.input !== undefined && scope !== undefined
        ? conversation.input.for(scope)
        : undefined
      facade?.focus?.()
    } catch {
      // 聚焦兜底失败无妨。
    }
    document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
  })

  /**
   * 执行回退并回填：引擎通道发命令 → 等 marker-carrying 成功结局 → 把目标
   * 消息文本回填 composer。浮层已自行关闭；这里的失败只进控制台。
   */
  /**
   * 就地回退并回填（浮层确认后的执行体）：引擎命令 → 等 marker 结局 → 把
   * 目标消息文本回填 composer。返回是否成功回填。
   */
  const rewindAndRefillSession = async (sessionId: string, seq: number, mode: 'chat' | 'both', planId?: string, textOverride?: string): Promise<boolean> => {
    const binding = sessions.binding(sessionId)
    if (binding === undefined) return false
    const engineFace = { sessionId, command: (line: string) => binding.session.command(line) }
    // 排除已存在的执行节点：重复回退同一消息必须等本次命令的节点。
    const known = knownCommandSeqs(engineFace, chatOf, node => isExecutedRewindCommand(node, seq))
    let result: Awaited<ReturnType<SessionFace['command']>>
    try {
      const line = mode === 'both' && planId !== undefined
        ? `/${ENGINE_COMMAND} @${seq} both ${planId}`
        : `/${ENGINE_COMMAND} @${seq} ${mode}`
      result = await binding.session.command(line)
    } catch (error) {
      console.warn('[dsh-session-manager] 回退命令抛错，跳过回填', error)
      return false
    }
    if (!result.ok) {
      console.warn('[dsh-session-manager] 回退命令被拒绝', result.error)
      return false
    }
    if (result.value?.matched !== true) {
      console.warn('[dsh-session-manager] 回退命令未匹配（宿主可能未注册）')
      return false
    }
    // 执行回退会先停运行中的回合，等待窗口比 preview 长。
    let outcome: Awaited<ReturnType<typeof waitForCommand>>
    try {
      outcome = await waitForCommand(
        engineFace,
        chatOf,
        node => isExecutedRewindCommand(node, seq) && !known.has(node.seq),
        20_000,
        cb => watchChat(sessionId, cb),
      )
    } catch (error) {
      console.warn('[dsh-session-manager] 等待回退结局抛错', error)
      return false
    }
    if (outcome === null) {
      console.warn('[dsh-session-manager] 回退在超时内未落定，跳过回填')
      return false
    }
    if (outcome.kind !== 'success') {
      // 宿主拒绝（如目标已被压缩遮蔽）：原因进控制台，不打断用户。
      console.warn('[dsh-session-manager] 回退被拒绝：', outcome.text)
      throw new Error(outcome.text ?? '回退被拒绝')
    }
    // 用户可能在回退期间切换会话：只回填回退发生的会话。
    if (currentSessionId(sessions) !== sessionId) return false
    // 编辑确认后回填改后文本;常规回退回填原文。
    const text = textOverride ?? messageTextAt(chatOf({ sessionId }), seq)
    if (text === undefined) return false
    return writeComposer(sessionId, text)
  }

  const runRewindAndFill = async (sessionId: string, seq: number, mode: 'chat' | 'both', planId?: string): Promise<void> => {
    try {
      await rewindAndRefillSession(sessionId, seq, mode, planId)
    } catch {
      // 浮层路径的失败已进控制台;这里不再上抛。
    }
  }

  /**
   * 就地重发（刷新/重新生成的新实现）：回退到目标消息 → 文本回填 →
   * 自动 Enter 重发。不再 fork：会话 id 不变、无切换/归档/模型同步。
   */
  const regenerateInPlace = async (sessionId: string, seq: number): Promise<void> => {
    if (await rewindAndRefillSession(sessionId, seq, 'chat')) {
      submitComposer()
    }
  }
  regenerateHook = regenerateInPlace

  /** pointerdown 预取（RPC）：浮层打开时直接以落定态渲染，消除「检查中」闪烁。 */
  const prewarmRewind = (seq: number): void => {
    const sessionId = currentSessionId(sessions)
    if (sessionId === undefined) return
    prewarmPreview(sessionId, seq)
  }

  /** 点击按钮：打开模式浮层（影响清单经 RPC，执行经引擎命令通道）。 */
  const openRewindPopover = (cp: RewindCandidate, anchor: HTMLElement): void => {
    const sessionId = currentSessionId(sessions)
    if (sessionId === undefined) return
    openPopover({
      sessionId,
      seq: cp.seq,
      preview: cp.preview,
      anchor,
      onRewind: (mode, planId) => {
        void runRewindAndFill(sessionId, cp.seq, mode, planId)
      },
    })
  }

  const sync = () => {
    if (disposed || syncing) return
    syncing = true
    try {
      const current = currentSessionSnapshot(sessions, getUiConversation)
      const chat = current?.chat
      const nodesByKey = nodeKeyIndex(chat)
      const candidates = computeRewindCandidates(chat)
      const byKey = new Map(candidates.map((cp) => [cp.key, cp]))
      const refreshTargets = computeUserRefreshTargets(chat)
      latestRefreshTargets = refreshTargets

      // 被撤回的行隐藏（hiddenSeqsOf：区间合并 + 命令探测节点）。
      const hiddenChat = hiddenChatOf(chat)
      const hiddenSeqs = hiddenChat === undefined ? undefined : hiddenSeqsOf(hiddenChat)
      if (hiddenSeqs !== undefined) {
        const setHidden = (row: HTMLElement, hide: boolean): void => {
          if (hide && row.dataset.dshRewindHidden !== 'true') {
            row.style.display = 'none'
            row.dataset.dshRewindHidden = 'true'
          } else if (!hide && row.dataset.dshRewindHidden === 'true') {
            row.style.display = ''
            delete row.dataset.dshRewindHidden
          }
        }
        for (const row of Array.from(document.querySelectorAll<HTMLElement>('[data-chat-anchor-key], [data-chat-node-key], [data-chat-flow-key]'))) {
          const node = resolveSeatNode(row, nodesByKey)
          const anchorSeq = typeof node?.anchorSeq === 'number'
            ? node.anchorSeq
            : (typeof node?.data?.seq === 'number' ? node.data.seq : undefined)
          setHidden(row, typeof anchorSeq === 'number' && hiddenSeqs.has(anchorSeq))
        }
        // 分组外壳（group: 锚点）解析不到 chat 节点——纯视图构造：成员行
        // 全部被撤才隐藏外壳，绝不明撤半空的组（对齐 dsh-rewind）。
        for (const shell of Array.from(document.querySelectorAll<HTMLElement>('[data-chat-anchor-key^="group:"]'))) {
          const members = Array.from(shell.querySelectorAll<HTMLElement>('[data-chat-anchor-key], [data-chat-node-key], [data-chat-flow-key]'))
          if (members.length === 0) continue
          setHidden(shell, members.every(member => member.dataset.dshRewindHidden === 'true'))
        }
      }

      // 索引现有 pill（按 key 去重），重复或缺 key 的直接移除
      const pillByKey = new Map<string, HTMLElement>()
      for (const element of Array.from(document.querySelectorAll(CHECKPOINT_PILL))) {
        const pill = element as HTMLElement
        const key = pill.dataset.dshCheckpointKey
        if (key && !pillByKey.has(key)) pillByKey.set(key, pill)
        else pill.remove()
      }

      const seen = new Set<string>()
      const seenRefresh = new Set<string>()
      // 0.2.1 的行身份是 anchor-key/node-key（见 resolveSeatNode）；
      // 候选按 node.key 匹配（computeRewindCandidates 的 key 即 node.key）。
      const rows = Array.from(document.querySelectorAll<HTMLElement>(
        '[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]',
      ))
      let rowsWithActions = 0
      let copyTemplates = 0
      for (const row of rows) {
        const node = resolveSeatNode(row, nodesByKey)
        const key = typeof node?.key === 'string' ? node.key : ''
        const cp = key === '' ? undefined : byKey.get(key)

        let pill = key === '' ? undefined : pillByKey.get(key)
        if (!cp || row.dataset.dshRewindHidden === 'true') {
          // 无候选或已被回退撤回：不留按钮。
          pill?.remove()
          if (cp === undefined) continue
          // 行被隐藏但仍有候选：刷新按钮也不留。
          const actions = actionsContainerOf(row)
          actions?.querySelector<HTMLElement>('[data-dsh-refresh="true"]')?.remove()
          continue
        }
        seen.add(key)
        if (pill === undefined) {
          pill = createRewindPill(
            cp,
            key,
            () => {
              const button = pill!.querySelector('button')
              if (button !== null) openRewindPopover(cp, button)
            },
            () => prewarmRewind(cp.seq),
            () => {
              // 编辑：消息原位变输入框，确定时才回退并发送改后文本。
              openEditor(row, cp)
            },
          )
          pillByKey.set(key, pill)
        }
        const actions = actionsContainerOf(row)
        if (actions) {
          // 复制按钮的 actions 行作为唯一宿主；复制其真实 class/style，确保两者视觉一致。
          if (!actions.contains(pill)) actions.appendChild(pill)
          // 注意：adopt 会把按钮 replaceWith 成克隆节点，锚点必须点击时实时取，
          // 闭包捕获旧引用会拿到已脱离 DOM 的节点（rect 全零 → 弹层飞左上角）。
          adoptCopyButtonStyle(
            pill,
            actions,
            cp,
            () => {
              const liveButton = pill.querySelector('button')
              if (liveButton !== null) openRewindPopover(cp, liveButton)
            },
            () => prewarmRewind(cp.seq),
          )
          rowsWithActions += 1
          if (actions.querySelector('button[aria-label="复制"], button[aria-label="copy"]')) copyTemplates += 1
        } else if (row.nextElementSibling !== pill) {
          // 兼容宿主版本没有 actions 标记的情况：先紧邻消息后插入，保持常驻可见。
          row.insertAdjacentElement('afterend', pill)
        }

        // 刷新按钮：固定在 actions 行第一位（复制/回退之前）。
        const refreshTarget = key === '' ? undefined : refreshTargets.get(key)
        if (actions) {
          const refreshButton = actions.querySelector<HTMLElement>('[data-dsh-refresh="true"]')
          if (refreshTarget && !refreshTarget.generating) {
            seenRefresh.add(key)
            ensureRefreshButton(actions, refreshTarget, runRefresh)
          } else {
            refreshButton?.remove()
          }
        }

        const button = pill.querySelector('button')
        if (button) {
          // 图标常驻：无 SVG 时补上（React 重建行后 pill 重挂的场景）。
          if (button.querySelector('svg') === null) button.replaceChildren(rewindIcon())
          button.title = cp.preview ? `回退到这条消息：${cp.preview}` : '回退到这条消息'
        }
        const editButton = pill.querySelector<HTMLButtonElement>('[data-dsh-edit-button="true"]')
        if (editButton !== null) {
          if (editButton.querySelector('svg') === null) editButton.replaceChildren(editIcon())
          editButton.title = cp.preview ? `编辑这条消息并重发：${cp.preview}` : '编辑这条消息并重发'
        }
      }

      for (const pill of pillByKey.values()) {
        if (!seen.has(pill.dataset.dshCheckpointKey ?? '')) pill.remove()
      }

      for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-dsh-refresh="true"]'))) {
        if (!seenRefresh.has(element.dataset.dshRefreshKey ?? '')) element.remove()
      }

      if (debugEnabled()) {
        const signature = JSON.stringify({
          sessionId: current?.sessionId,
          hasChat: Boolean(chat),
          hasOrder: Array.isArray(chat?.order),
          rows: rows.length,
          resolved: rows.filter((row) => resolveSeatNode(row, nodesByKey) !== undefined).length,
          candidates: candidates.length,
          hidden: hiddenSeqs?.size ?? 0,
          rowsWithActions,
          copyTemplates,
          pills: document.querySelectorAll(CHECKPOINT_PILL).length,
        })
        if (signature !== lastDebugSignature) {
          lastDebugSignature = signature
          console.debug('[dsh-session-manager] rewind sync:', signature)
        }
      }
    } finally {
      syncing = false
    }
  }

  // 这些子树的变更不可能改变回退的目标集合（对齐 dsh-rewind 的
  // IGNORED_PORTAL_SCOPE）：composer、右侧栏、插件页。忽略它们避免每次
  // 击键都排一轮全转录扫描。
  const IGNORED_SCOPE = [
    '[data-composer-seat]',
    '[data-composer-input]',
    '[data-sidebar-right-panel]',
    '[data-sidebar-chat]',
    '[data-plugin-panel]',
  ].join(', ')

  // 微任务合批（对齐 dsh-rewind 的刷新机制）：preview 命令行插入后必须在
  // 绘制之前隐藏——setTimeout 是宏任务、跑在 paint 之后，会产生一帧可见的
  // 布局弹跳（transcript 先长高 24px 顶动滚动、再隐藏弹回）。
  let scheduled = false
  const schedule = () => {
    if (disposed || syncing || scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!disposed) sync()
    })
  }

  const onMutations = (mutations: MutationRecord[]): void => {
    // 全部落在忽略域内的变更直接跳过。
    if (mutations.length > 0) {
      let ignored = 0
      for (const mutation of mutations) {
        const target = mutation.target
        if (target instanceof Element && target.closest(IGNORED_SCOPE) !== null) ignored += 1
      }
      if (ignored === mutations.length) return
    }
    schedule()
  }

  const unsubscribe = sessions.list.subscribe?.(schedule)
  const observer = new MutationObserver(onMutations)
  observer.observe(document.body, { childList: true, subtree: true })
  schedule()

  return () => {
    disposed = true
    observer.disconnect()
    unsubscribe?.()
    closePopover()
    closeEditor()
    registerPreviewCall(null)
    removeAllCheckpointPills()
    document.querySelectorAll('[data-dsh-refresh="true"]').forEach((element) => element.remove())
  }
}

// ═══════════════════════════════════════════════════════════
//  现有功能：会话菜单删除
// ═══════════════════════════════════════════════════════════

function installSessionMenuDelete(
  workspaces: DshWorkspaces,
  sessions: DshSessions,
  isEnabled: () => boolean = () => true,
): () => void {
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
    // 注入前按当前设置复核：关掉开关后，残留实例也会停止注入并清掉已插入的项。
    if (!isEnabled()) {
      document.querySelectorAll('[data-dsh-session-delete="true"]').forEach((element) => element.remove())
      return
    }
    const menuItems = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menu"] button'))
    const archiveItem = menuItems.find((item) => {
      const text = item.textContent?.trim().toLocaleLowerCase() ?? ''
      return text.includes('归档会话') || text.includes('archive session')
    })
    const menu = archiveItem?.closest<HTMLElement>('[role="menu"]') ?? null
    if (!archiveItem || !menu) return

    // MenuItemButton 把每个按钮包在 itemWrap 里，真正的列表是 menu 内带
    // role="presentation" 的视口容器（footer 在视口之外）。
    const viewport = archiveItem.closest<HTMLElement>('[role="presentation"]')
    const list = viewport !== null && menu.contains(viewport) ? viewport : menu

    // 删除项固定在菜单最末位。内置项按 order 排序（“复制 Session ID”在“归档会话”
    // 之后），其他插件也可能追加菜单项，所以每次同步都把已存在的删除项挪回末尾。
    const existing = Array.from(list.children).find(
      (child) => child instanceof HTMLElement && child.getAttribute('data-dsh-session-delete') === 'true',
    ) as HTMLElement | undefined
    if (existing) {
      if (list.lastElementChild !== existing) list.append(existing)
      return
    }

    // 菜单重挂后旧容器里的残留项先清掉，避免页面上同时出现多个“删除会话”。
    document.querySelectorAll('[data-dsh-session-delete="true"]').forEach((element) => element.remove())

    // 连同 itemWrap 一起克隆，保持与内置菜单项完全一致的布局结构；只在父节点
    // 确实只包着这一个菜单项时这样做，避免误克隆整个列表容器。
    const archiveWrapper = archiveItem.parentElement
    const cloneWrapper = archiveWrapper !== null && archiveWrapper.querySelectorAll('[role="menuitem"]').length === 1
    const deleteNode = (cloneWrapper ? archiveWrapper : archiveItem).cloneNode(true) as HTMLElement
    const deleteItem = deleteNode.getAttribute('role') === 'menuitem'
      ? deleteNode
      : deleteNode.querySelector<HTMLElement>('[role="menuitem"]')
    if (!deleteItem) return
    deleteNode.setAttribute('data-dsh-session-delete', 'true')
    deleteItem.setAttribute('aria-label', '删除会话')
    deleteItem.removeAttribute('aria-current')
    // 归档项的 ⌥⌘A 快捷键不属于删除，连同 aria-keyshortcuts 一起去掉，避免误导
    deleteItem.removeAttribute('aria-keyshortcuts')
    for (const key of deleteItem.querySelectorAll('kbd')) {
      key.closest('span[aria-hidden="true"]')?.remove()
    }
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

    list.append(deleteNode)
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

// ═══════════════════════════════════════════════════════════
//  重新生成（助手消息）+ 刷新（用户消息）：共用一套安全核心
//  fork → 记基线 → prompt → 等"本次新增 assistant 达到 settled"
// ═══════════════════════════════════════════════════════════

/** 重新生成的模块级幂等锁：跨组件实例/重挂载生效。key = `${sessionId}:${sourceKey}`。 */


const subscribeNoop = (): (() => void) => () => undefined

interface RetryContext {
  content: unknown[]
  /** 所属用户消息的 user/message 事件 seq（就地回退的 @seq）。 */
  userSeq: number | undefined
  previousTurnEnd: number | undefined
  turn: number | undefined
  assistantStatus: string | undefined
  /** 被打此消息的助手节点 seat key：点击后立即降暗+占位，消除 fork 期间卡顿观感。 */
  assistantKey: string | undefined
}

/** 0.1.2 会话快照没有消息节点；上下文从 chat 视图读取。
 *  chat.legacy.turnEnds 与 legacy turn 语义一致（completedTurn → end.seq）。 */
function computeRetryContext(chat: ChatSnapshotView | undefined, messageId: string): RetryContext | undefined {
  if (!chat?.nodes) return undefined
  const ordering = chat.order ?? []
  const orderIndex = new Map<string, number>()
  ordering.forEach((key, index) => orderIndex.set(key, index))
  // order 缺失的 key（刚落到视图末尾的最新节点）排最后：排最前会误判"该回复之前"为空。
  const sorted = [...chat.nodes.values()].sort(
    (a, b) =>
      (orderIndex.get(a.key ?? '') ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(b.key ?? '') ?? Number.MAX_SAFE_INTEGER),
  )

  const assistantIndex = sorted.findIndex((node) => isAssistantNode(node) && assistantMessageId(node) === messageId)
  if (assistantIndex < 0) return undefined
  const assistant = sorted[assistantIndex]
  if (!assistant) return undefined

  const turn = assistant.location?.turn?.turn
  const before = sorted.slice(0, assistantIndex)
  // 优先取同回合的 user 节点；缺 turn 信息时退回"最近的前置 user"。
  let user = before.find((node) => node.kind === 'user' && node.location?.turn?.turn === turn)
  if (!user) user = [...before].reverse().find((node) => node.kind === 'user')
  const content = user?.data?.content
  if (!Array.isArray(content) || content.length === 0) return undefined

  let previousTurnEnd: number | undefined
  const turnEnds = chat.legacy?.turnEnds
  if (typeof turn === 'number' && turnEnds) {
    for (const [completedTurn, endSeq] of turnEnds) {
      if (completedTurn < turn && (previousTurnEnd === undefined || endSeq > previousTurnEnd)) {
        previousTurnEnd = endSeq
      }
    }
  }

  const assistantStatus = (assistant.data as { status?: unknown } | null | undefined)?.status
  const userSeq = typeof user?.anchorSeq === 'number' ? user.anchorSeq : user?.data?.seq
  return {
    content: [...content],
    userSeq,
    previousTurnEnd,
    turn: typeof turn === 'number' ? turn : undefined,
    assistantStatus: typeof assistantStatus === 'string' ? assistantStatus : undefined,
    assistantKey: assistant.key,
  }
}

function RetryButton({
  sessionId,
  messageId,
  sessions,
  getUiConversation,
}: {
  sessionId: string
  messageId: string
  sessions: DshSessions
  getUiConversation: Resolver<DshUiConversation>
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const controllerRef = React.useRef<AbortController | null>(null)

  // 0.1.2：chat 视图（含 legacy 切片）是消息上下文唯一可靠来源。
  const chatSource = React.useMemo(() => {
    if (!sessionId) return undefined
    try {
      return getUiConversation()?.binding(sessionId)?.target('chat') ?? undefined
    } catch {
      return undefined
    }
  }, [getUiConversation, sessionId])
  const chat = React.useSyncExternalStore(
    chatSource?.subscribe ?? subscribeNoop,
    () => chatSource?.getSnapshot(),
  )
  const retryContext = React.useMemo(() => computeRetryContext(chat, messageId), [chat, messageId])

  // 卸载时取消未完成的重新生成。
  React.useEffect(() => () => {
    controllerRef.current?.abort(new Error('组件已卸载'))
  }, [])

  // 定位不到所属用户消息时不渲染，避免 dead disabled 按钮。
  if (!retryContext) return null

  const handle = async () => {
    if (busy || !sessionId) return
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setError(null)
    // 点击瞬间就降暗原回复+占位“正在回复中…”，fork 在后台跑，不显卡顿。
    const restore = showRegeneratingPlaceholder(
      retryContext.assistantKey ? [retryContext.assistantKey] : [],
      retryContext.turn,
    )
    if (retryContext.userSeq === undefined) {
      setError('定位不到所属用户消息')
      return
    }
    try {
      // 就地重发：回退到该回合的用户消息并自动重发——会话不变，无切换/归档。
      await (regenerateHook?.(sessionId, retryContext.userSeq)
        ?? Promise.reject(new Error('回退管线未就绪')))
    } catch (cause) {
      setError(toErrorMessage(cause))
    } finally {
      restore()
      setBusy(false)
      controllerRef.current = null
    }
  }

  const generating = retryContext.assistantStatus === 'running'
  const errorColor = 'var(--dsw-alias-state-error-primary, #d92d20)'
  const onMouseEnter = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
    event.currentTarget.style.color = error ? errorColor : 'var(--dsw-alias-label-secondary)'
  }
  const onMouseLeave = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = 'transparent'
    event.currentTarget.style.color = error ? errorColor : 'var(--dsw-alias-label-tertiary)'
  }

  const title = error ? `重新生成失败：${error}` : '重新生成此回复'

  return React.createElement('button', {
    type: 'button',
    'aria-label': title,
    title,
    disabled: busy || generating,
    onClick: handle,
    style: {
      width: 28,
      height: 28,
      display: 'inline-flex',
      justifyContent: 'center',
      alignItems: 'center',
      cursor: busy || generating ? 'default' : 'pointer',
      background: 'transparent',
      border: 'none',
      borderRadius: 28,
      color: error ? errorColor : 'var(--dsw-alias-label-tertiary)',
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

/** assistant 节点的 messageId：优先 finalNode。 */
function assistantMessageId(node: ChatViewNode): string | undefined {
  const data = node.data as { finalNode?: { messageId?: unknown; id?: unknown }; messageId?: unknown } | null | undefined
  const finalId = data?.finalNode?.messageId ?? data?.finalNode?.id ?? data?.messageId
  return typeof finalId === 'string' ? finalId : undefined
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

// 纯逻辑导出：供测试验证同回合定位与刷新目标计算，不影响运行时注入。
export { assistantMessageId, computeRetryContext, computeUserRefreshTargets }

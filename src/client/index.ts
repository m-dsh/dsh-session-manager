import React from 'react'
import { CHECKPOINT_CHANNEL } from '../core'
import { applyStickyPrompt } from './stickyPrompt'
import {
  SETTINGS_NAMESPACE,
  SessionManagerSection,
  injectSettingsCss,
  readSettings,
  type SessionManagerSettings,
  type SettingsScope,
} from './settings'

export const name = 'dsh-session-manager-client'
export const inject = ['slots', 'workspaces', 'sessions', 'settingsScope'] as const

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
interface SessionFace {
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
 * 只声明用到的成员，避免依赖 @deepseek-ai/dsh-client-connection 的包内类型路径；
 * 该平台模块由宿主 ModuleLoader 注入（见 package.json dsh.client.inject）。
 */
interface ConnectionHandle {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
  }
}

interface ClientContext {
  slots: DshSlotReg
  workspaces: DshWorkspaces
  sessions: DshSessions
  settingsScope: {
    bind<T>(spec: { namespace: string }): SettingsScope<T>
  }
  get(name: 'connection'): ConnectionHandle | undefined
  get(name: 'uiConversation'): DshUiConversation | undefined
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
  const getConnection: Resolver<ConnectionHandle> = () => {
    try {
      return ctx.get('connection')
    } catch {
      return undefined
    }
  }

  // ── 设置开关：sticky prompt 与"删除会话"受设置面板控制，切换时实时安装/卸载 ──
  const scope = ctx.settingsScope.bind<SessionManagerSettings>({ namespace: SETTINGS_NAMESPACE })
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
          return sessions.list.getSnapshot().current
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
    // 将"删除会话"插到内置"归档会话"之后，而不再占用会话详情头部。
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
          workspaces,
          getUiConversation,
        })
      },
    )
  })

  // ── Checkpoint 回滚入口（常驻在每条用户消息 actions 行，DOM 注入）──
  const disposeCheckpoints = installCheckpointEntries(sessions, workspaces, getUiConversation, getConnection)
  ctx.on?.('dispose', disposeCheckpoints)

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

interface UserCheckpoint {
  /** 用户消息节点在 chat 视图中的稳定 key，用于匹配 DOM 行 */
  key: string
  /** 该条用户消息所属的回合号 */
  turn: number
  /** 该回合的用户文本预览 */
  preview: string
  /** 回滚边界：上一轮 turn/end 事件 seq（fork 到这里，清除本轮及之后） */
  forkSeq: number
}

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

// 从 chat 视图精确计算每条用户消息对应的回滚边界。
function computeUserCheckpoints(chat: ChatSnapshotView | undefined): UserCheckpoint[] {
  if (!chat) return []
  const turnEnds = chat.legacy?.turnEnds
  if (!chat.nodes || !turnEnds) return []

  const result: UserCheckpoint[] = []
  for (const node of chat.nodes.values()) {
    if (node.kind !== 'user' || node.visibility !== 'visible') continue
    if (typeof node.key !== 'string' || node.key === '') continue
    // turn 与 step 两类定位都携带 owningTurn；直接读取保证兼容
    const turn = node.location?.turn?.turn
    if (typeof turn !== 'number') continue
    const forkSeq = turnEnds.get(turn - 1)
    if (typeof forkSeq !== 'number') continue // 第一条用户消息之前没有检查点
    result.push({
      key: node.key,
      turn,
      preview: extractUserText(node.data?.content),
      forkSeq,
    })
  }

  // 按 chat.order 排序，与 DOM 中行的顺序保持一致
  const order = chat.order
  if (order && order.length > 0) {
    const indexByKey = new Map<string, number>()
    order.forEach((key, index) => indexByKey.set(key, index))
    result.sort((a, b) => (indexByKey.get(a.key) ?? 0) - (indexByKey.get(b.key) ?? 0))
  }
  return result
}

// ── 用户消息「刷新」目标：定位每条用户消息的内容与 fork 边界，用于重新回答该提示词 ──

interface UserRefreshTarget {
  key: string
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
    if (node.kind !== 'user' || node.visibility !== 'visible') continue
    if (typeof node.key !== 'string' || node.key === '') continue
    const turn = node.location?.turn?.turn
    if (typeof turn !== 'number') continue
    const content = node.data?.content
    if (!Array.isArray(content) || content.length === 0) continue

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
const CHECKPOINT_DIALOG = '[data-dsh-checkpoint-dialog="true"]'

/** actions 容器必须真实持有按钮；空装饰壳（可能匹配 actions 前缀类名）不能当宿主。 */
function findActionsRow(row: HTMLElement): HTMLElement | undefined {
  const candidates = Array.from(row.querySelectorAll<HTMLElement>('[class*="_actions"], [class*="actions"]'))
  return candidates.find((element) => element.querySelector('button') !== null) ?? candidates[0]
}

function ensureCheckpointStyle(): void {
  // HMR/重启可能已经留下旧版 style；必须更新它，而不是只检查后直接返回。
  const style = document.querySelector<HTMLStyleElement>('style[data-dsh-checkpoint-style]') ?? document.createElement('style')
  style.dataset.dshCheckpointStyle = 'true'
  style.textContent = [
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
  const state = sessions.list.getSnapshot()
  const sessionId = state.current
  if (!sessionId) return undefined
  let chat: ChatSnapshotView | undefined
  try {
    // 0.1.2：会话绑定不再挂 ConversationSnapshot，改从 uiConversation 的 views 取 chat target。
    const binding = getUiConversation()?.binding(sessionId)
    chat = binding?.snapshot?.getSnapshot()?.views?.get('chat') ?? undefined
  } catch {
    chat = undefined
  }
  return { sessionId, chat }
}

function removeAllCheckpointPills(): void {
  for (const element of Array.from(document.querySelectorAll(CHECKPOINT_PILL))) element.remove()
}


function createCheckpointPill(cp: UserCheckpoint, key: string, onOpen: () => void): HTMLElement {
  const pill = document.createElement('div')
  pill.dataset.dshCheckpointPill = 'true'
  pill.dataset.dshCheckpointKey = key

  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = `↩ 回滚 #${cp.turn}`
  button.title = cp.preview ? `回滚到第 ${cp.turn} 轮之前：${cp.preview}` : `回滚到第 ${cp.turn} 轮之前`
  button.dataset.dshCheckpointButton = 'true'
  attachCheckpointAction(button, onOpen)
  pill.appendChild(button)
  return pill
}

function attachCheckpointAction(button: HTMLButtonElement, onOpen: () => void): void {
  const activate = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    onOpen()
  }
  // 使用 pointerdown 捕获点击意图，避免宿主消息层在 click 前重绘/吞掉事件。
  button.addEventListener('pointerdown', activate, true)
  button.addEventListener('click', activate, true)
}

function adoptCopyButtonStyle(
  pill: HTMLElement,
  actions: HTMLElement,
  cp: UserCheckpoint,
  onOpen: () => void,
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
  replacement.setAttribute('aria-label', `回滚到第 ${cp.turn} 轮之前`)
  replacement.title = cp.preview ? `回滚到第 ${cp.turn} 轮之前：${cp.preview}` : `回滚到第 ${cp.turn} 轮之前`
  // 复用复制按钮的尺寸、间距和 class，但使用回滚符号避免误认为复制。
  replacement.replaceChildren(document.createTextNode('↩'))
  current.replaceWith(replacement)
  attachCheckpointAction(replacement, onOpen)
}

/** 宿主 preview-rollback 返回的回滚计划（只读预演，未改任何文件）。 */
interface RollbackPreview {
  /** 宿主托管的执行计划 id：apply-rollback 时只提交它，不能自行传文件路径。 */
  planId: string
  /** 将被写回的文件。 */
  restore: string[]
  /** 快照里记录的文件总数（诊断用，界面不展示）。 */
  snapshotFiles: number
  /** 将被删除的文件。 */
  remove: string[]
  /** 因"不是本次对话改动的文件"而跳过的文件（最多 50 条）。 */
  skipped: string[]
  skippedCount: number
  /** 是否成功限定为"本次对话动过的文件"。 */
  scoped: boolean
  unknownSnapshots: number
  /** exact=精确快照可用；missing=禁止文件回滚。 */
  snapshotStatus: 'exact' | 'missing'
  /** 精确快照是否已持久化（false=重启后丢失，仅本进程可用）。 */
  persisted: boolean
  hasSnapshot: boolean
  snapshotSeq?: number
  isGit: boolean
  /** 无法安全恢复的文件；非空时禁止文件回滚。 */
  unsupported: Array<{ path: string; reason: string }>
}

/** 对话框 UI 句柄：DOM 操作收在一处，回滚流程只调用这些方法。 */
interface RollbackUi {
  /** 进入工作态：显示进度条与步骤提示，隐藏两个动作按钮。 */
  begin(): void
  /** 更新进度（0-100）与步骤提示；step 为空表示清空提示。 */
  progress(percent: number, step: string): void
  /** 明细列表（逐行、自动滚到底）。 */
  detail(items: string[]): void
  /** 出错：红色提示 + 还原动作按钮，允许重试。 */
  fail(text: string): void
  /** 终态：汇总 + 明细 + 关闭按钮，进度条保持满格。 */
  done(summary: string, isError: boolean, items?: string[]): void
}

/** 调一次 checkpoint RPC，失败时抛出带宿主错误信息的 Error。 */
async function callCheckpoint<T>(
  connection: ConnectionHandle,
  endpoint: string,
  payload: unknown,
): Promise<T> {
  const result = await connection.rpc.call(CHECKPOINT_CHANNEL, endpoint, payload)
  if (!result.ok) {
    throw new Error(((result.error as { message?: string } | undefined)?.message) ?? `${endpoint} 失败`)
  }
  return result.value as T
}

function openRollbackDialog(
  cp: UserCheckpoint,
  sessions: DshSessions,
  workspaces: DshWorkspaces,
  getConnection: Resolver<ConnectionHandle>,
): void {
  document.querySelector(CHECKPOINT_DIALOG)?.remove()

  const overlay = document.createElement('div')
  overlay.dataset.dshCheckpointDialog = 'true'
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.3)'

  const card = document.createElement('div')
  // position:relative + overflow:hidden：顶部进度条正好贴住卡片上边框与圆角。
  card.style.cssText = 'position:relative;overflow:hidden;background:var(--dsw-alias-bg-primary,#fff);border-radius:12px;padding:24px;min-width:360px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,0.18);color:var(--dsw-alias-label-primary,#101828)'

  // ── 顶部进度条（贴在边框上）──
  const progressTrack = document.createElement('div')
  progressTrack.style.cssText = 'display:none;position:absolute;left:0;right:0;top:0;height:4px;background:var(--dsw-alias-bg-tertiary,#eaecf0)'
  const progressFill = document.createElement('div')
  progressFill.style.cssText = 'height:100%;width:0;background:var(--dsw-alias-state-success-primary,#12b76a);transition:width 200ms ease'
  progressTrack.appendChild(progressFill)
  card.appendChild(progressTrack)

  const title = document.createElement('div')
  title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center'
  const titleText = document.createElement('span')
  titleText.textContent = `撤销第 ${cp.turn} 轮及之后`
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', '关闭')
  close.style.cssText = 'background:none;border:none;font-size:18px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#98a2b3);padding:0 4px;line-height:1'
  close.addEventListener('click', () => overlay.remove())
  title.append(titleText, close)
  card.appendChild(title)

  if (cp.preview) {
    const preview = document.createElement('div')
    preview.textContent = cp.preview
    preview.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-tertiary,#98a2b3);margin-bottom:16px;padding:8px 10px;background:var(--dsw-alias-bg-secondary,#f9fafb);border-radius:6px;max-height:48px;overflow:hidden;line-height:1.4'
    card.appendChild(preview)
  }

  // ── 步骤提示（进度条下方的文字）──
  const status = document.createElement('div')
  status.dataset.dshCheckpointStatus = 'true'
  status.style.cssText = 'display:none;font-size:12px;margin-top:10px;color:var(--dsw-alias-label-secondary,#475467);line-height:1.5'
  card.appendChild(status)

  const message = document.createElement('div')
  message.style.cssText = 'font-size:12px;margin-top:10px;display:none;line-height:1.5'
  card.appendChild(message)

  // 明细列表：恢复/撤销/失败的文件名逐行显示在可滚动区域。
  const details = document.createElement('div')
  details.dataset.dshCheckpointDetails = 'true'
  details.style.cssText = 'display:none;margin-top:8px;max-height:150px;overflow:auto;font-size:11px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#475467);background:var(--dsw-alias-bg-secondary,#f9fafb);border-radius:6px;padding:8px 10px;white-space:pre-wrap;word-break:break-all'
  card.appendChild(details)

  const footer = document.createElement('div')
  footer.style.cssText = 'display:none;margin-top:12px;justify-content:flex-end'
  const doneButton = document.createElement('button')
  doneButton.type = 'button'
  doneButton.dataset.dshCheckpointDone = 'true'
  doneButton.textContent = '关闭'
  doneButton.style.cssText = 'padding:6px 16px;font-size:12px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-secondary,#d0d5dd);background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#101828)'
  doneButton.addEventListener('click', () => overlay.remove())
  footer.appendChild(doneButton)
  card.appendChild(footer)

  const showMessage = (text: string, isError: boolean) => {
    message.textContent = text
    message.style.display = text ? 'block' : 'none'
    message.style.color = isError
      ? 'var(--dsw-alias-state-error-primary,#d92d20)'
      : 'var(--dsw-alias-state-success-primary,#12b76a)'
  }

  const actionButtons = (): HTMLButtonElement[] =>
    Array.from(card.querySelectorAll<HTMLButtonElement>('button[data-dsh-checkpoint-action]'))

  // 工作态计时：慢步骤（git restore / 大快照）时让用户看到"还在动"。
  let startedAt = 0
  let stepText = ''
  let ticker: ReturnType<typeof setInterval> | undefined
  const stopTicker = () => {
    if (ticker !== undefined) clearInterval(ticker)
    ticker = undefined
  }
  const renderStatus = () => {
    if (!stepText) {
      status.textContent = ''
      return
    }
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    status.textContent = seconds >= 2 ? `${stepText}（已用 ${seconds} 秒）` : stepText
  }

  const ui: RollbackUi = {
    begin() {
      startedAt = Date.now()
      progressTrack.style.display = 'block'
      status.style.display = 'block'
      progressFill.style.background = 'var(--dsw-alias-state-success-primary,#12b76a)'
      showMessage('', false)
      details.style.display = 'none'
      for (const action of actionButtons()) action.style.display = 'none'
      if (ticker === undefined) ticker = setInterval(renderStatus, 500)
    },
    progress(percent, step) {
      progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`
      stepText = step
      renderStatus()
    },
    detail(items) {
      details.textContent = items.join('\n')
      details.style.display = items.length > 0 ? 'block' : 'none'
      details.scrollTop = details.scrollHeight
    },
    fail(text) {
      stopTicker()
      stepText = ''
      progressFill.style.background = 'var(--dsw-alias-state-error-primary,#d92d20)'
      progressFill.style.width = '100%'
      renderStatus()
      showMessage(text, true)
      footer.style.display = 'flex'
      // 失败可重试：动作按钮放回来。
      for (const action of actionButtons()) {
        action.style.display = ''
        action.disabled = false
      }
      progressTrack.style.display = 'none'
    },
    done(summary, isError, items = []) {
      stopTicker()
      stepText = ''
      progressFill.style.background = isError
        ? 'var(--dsw-alias-state-error-primary,#d92d20)'
        : 'var(--dsw-alias-state-success-primary,#12b76a)'
      progressFill.style.width = '100%'
      renderStatus()
      showMessage(summary, isError)
      ui.detail(items)
      footer.style.display = 'flex'
    },
  }

  // ── 打开即预演：先把"将要回滚什么"填到选项提示里 ──
  let planState: 'loading' | 'ready' | 'error' = 'loading'
  let plan: RollbackPreview | undefined
  const fileOptionHint = (): string => {
    const tail = `清除第 ${cp.turn} 轮及之后的所有对话记录，并回滚工作区文件`
    if (planState === 'loading') return `${tail}（正在读取检查点快照…）`
    if (planState === 'error' || !plan) return `${tail}（预演失败：无法确认文件变更范围，不会执行文件回滚）`
    if (plan.snapshotStatus === 'missing') {
      return `${tail}：该检查点没有精确的文件快照，无法回滚文件（可改用「仅回滚对话」）`
    }
    if (!plan.hasSnapshot) return `${tail}：该检查点没有文件快照，只能恢复 git 跟踪文件`
    if (plan.unsupported.length > 0) {
      return `${tail}：${plan.unsupported.length} 个文件无法安全恢复，已禁止文件回滚`
    }
    const parts = [`清除第 ${cp.turn} 轮及之后的对话`]
    parts.push(plan.restore.length > 0 ? `只回滚本次对话改动的 ${plan.restore.length} 个文件` : '文件无需改动')
    if (plan.remove.length > 0) parts.push(`撤销 ${plan.remove.length} 个新增文件`)
    if (!plan.scoped) parts.push('（归属信息不完整，将按全工作区回滚）')
    else if (plan.skippedCount > 0) parts.push(`（跳过 ${plan.skippedCount} 个非本次对话的改动）`)
    if (plan.persisted === false) parts.push('（快照未持久化，重启后不可用）')
    return parts.join('，')
  }

  /**
   * 点击前就把"将回滚什么"摊开给用户看，避免回滚完才发现多撤了东西。
   * 只列会被回滚的内容：与检查点一致的文件、非本次对话改动的文件都不展示，
   * 只有"没有活可干"时才用一句话说明原因（否则纯属噪声）。
   */
  const renderPlan = (value: RollbackPreview): void => {
    const lines: string[] = []
    if (value.restore.length > 0) {
      lines.push(`将回滚（本次对话改动，${value.restore.length}）`)
      for (const file of value.restore.slice(0, 30)) lines.push(`  ${file}`)
      if (value.restore.length > 30) lines.push(`  …另有 ${value.restore.length - 30} 个`)
    }
    if (value.remove.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push(`将删除（检查点后新增，${value.remove.length}）`)
      for (const file of value.remove.slice(0, 30)) lines.push(`  ${file}`)
      if (value.remove.length > 30) lines.push(`  …另有 ${value.remove.length - 30} 个`)
    }
    if (lines.length === 0) {
      lines.push(value.snapshotStatus === 'missing' ? '该检查点没有精确文件快照，无法回滚文件'
        : value.hasSnapshot ? '文件与检查点一致，无需改动'
        : '该检查点没有文件快照，只能恢复 git 跟踪的文件')
    }
    for (const item of value.unsupported) {
      lines.push('', `无法安全恢复：${item.path}（${item.reason}）`)
    }
    if (value.snapshotStatus === 'exact' && value.persisted === false) {
      lines.push('', '注意：该快照未成功持久化，重启后不可用。')
    }
    if (!value.scoped && value.unknownSnapshots > 0) {
      lines.push(
        '',
        `注意：窗口内 ${value.unknownSnapshots} 个检查点缺少文件归属信息，本次按全工作区回滚（会把上表之外的其他改动一并撤销）。`,
      )
    }
    ui.detail(lines)
  }

  const makeAction = (label: string, hintOf: () => string, withFiles: boolean) => {
    const action = document.createElement('button')
    action.type = 'button'
    action.dataset.dshCheckpointAction = 'true'
    // 两个选项保持完全一致的普通按钮样式，不表示默认选中状态。
    action.style.cssText = 'width:100%;padding:10px 14px;font-size:13px;border-radius:8px;cursor:pointer;text-align:left;line-height:1.4;border:1px solid var(--dsw-alias-border-secondary,#d0d5dd);background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#101828)'
    const labelDiv = document.createElement('div')
    labelDiv.textContent = label
    const hintDiv = document.createElement('div')
    hintDiv.style.cssText = 'font-size:11px;margin-top:2px;color:var(--dsw-alias-label-tertiary,#98a2b3)'
    action.append(labelDiv, hintDiv)
    const refreshHint = () => {
      hintDiv.textContent = hintOf()
    }
    refreshHint()
    hintRefreshers.push(refreshHint)
    action.addEventListener('click', () => {
      void performRollback(cp, withFiles, sessions, workspaces, getConnection, ui, () => plan)
    })
    return action
  }

  const hintRefreshers: Array<() => void> = []
  const group = document.createElement('div')
  group.style.cssText = 'display:flex;flex-direction:column;gap:8px'
  group.appendChild(
    makeAction('仅回滚对话', () => `清除第 ${cp.turn} 轮及之后的所有对话记录，不恢复文件变更`, false),
  )
  group.appendChild(makeAction('回滚对话 + 文件', fileOptionHint, true))
  card.appendChild(group)

  overlay.appendChild(card)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove()
  })
  document.body.appendChild(overlay)

  // 预演请求（只读）：失败就退回静态提示，不影响回滚本身。
  const connection = getConnection()
  if (!connection) {
    planState = 'error'
    for (const refresh of hintRefreshers) refresh()
    return
  }
  void callCheckpoint<RollbackPreview>(connection, 'preview-rollback', {
    sessionId: sessions.list.getSnapshot().current,
    checkpointSeq: cp.forkSeq,
  })
    .then((value) => {
      plan = value
      planState = 'ready'
      renderPlan(value)
    })
    .catch(() => {
      planState = 'error'
    })
    .finally(() => {
      for (const refresh of hintRefreshers) refresh()
    })
}

/** 防止双击 / 连续点击触发两次回滚。 */
let rollbackInFlight = false

async function performRollback(
  cp: UserCheckpoint,
  withFiles: boolean,
  sessions: DshSessions,
  workspaces: DshWorkspaces,
  getConnection: Resolver<ConnectionHandle>,
  ui: RollbackUi,
  getPlan: () => RollbackPreview | undefined,
): Promise<void> {
  if (rollbackInFlight) {
    ui.fail('正在执行回滚，请稍候')
    return
  }
  rollbackInFlight = true
  try {
    const sessionId = sessions.list.getSnapshot().current
    if (!sessionId) {
      ui.fail('无法确定当前会话')
      return
    }
    const connection = getConnection()
    if (!connection) {
      ui.fail('连接服务不可用')
      return
    }

    ui.begin()

    // ── 1) 预演：文件回滚必须有精确的、Host 校验过的计划，否则直接短路 ──
    let preview = getPlan()
    if (withFiles && !preview) {
      ui.progress(6, '正在读取检查点快照…')
      preview = await callCheckpoint<RollbackPreview>(connection, 'preview-rollback', {
        sessionId,
        checkpointSeq: cp.forkSeq,
      })
    }
    if (withFiles) {
      if (!preview || preview.snapshotStatus !== 'exact' || !preview.planId) {
        ui.fail('该检查点没有精确的文件快照，无法回滚文件。可改用「仅回滚对话」。')
        return
      }
      if (preview.unsupported.length > 0) {
        ui.fail(
          `以下文件无法安全恢复，已取消文件回滚（可改用「仅回滚对话」）：\n${preview.unsupported
            .map((item) => `  ${item.path}（${item.reason}）`)
            .join('\n')}`,
        )
        return
      }
    }

    // ── 2) 文件先执行：Host 按计划复核哈希后写回/删除；有问题就到此为止，不 fork ──
    let applyResult: { restored: string[]; removed: string[]; conflicts: string[]; errors: string[] } | undefined
    if (withFiles && preview) {
      const plan = preview
      const workCount = plan.restore.length + plan.remove.length
      ui.progress(30, `正在校验并按计划回滚 ${workCount} 个文件…`)
      ui.detail([])
      applyResult = await callCheckpoint<{ restored: string[]; removed: string[]; conflicts: string[]; errors: string[] }>(
        connection,
        'apply-rollback',
        { planId: plan.planId },
      )
      const conflicts = applyResult.conflicts ?? []
      const errors = applyResult.errors ?? []
      if (conflicts.length > 0 || errors.length > 0) {
        const detail = [
          ...(conflicts.length > 0 ? ['', `以下文件预演后被改动，已按安全规则跳过（${conflicts.length}）：`, ...conflicts] : []),
          ...(errors.length > 0 ? ['', `以下文件处理失败（${errors.length}）：`, ...errors] : []),
        ]
        ui.done('文件回滚未完全成功，已取消对话回滚（原会话保持不变）。', true, detail)
        return
      }
    }

    // ── 3) 文件 OK，再回滚对话：fork 到检查点之前 ──
    ui.progress(78, `正在清除第 ${cp.turn} 轮及之后的对话…`)
    const convData = await callCheckpoint<{ newSessionId: string }>(connection, 'rollback-conversation', {
      sessionId,
      checkpointSeq: cp.forkSeq,
    })
    sessions.open(convData.newSessionId)

    if (!withFiles) {
      // 回滚成功即删除被回滚掉的原会话，避免列表里积累多份重复记录。
      await archiveQuietly(workspaces, sessionId)
      ui.done(`已回滚对话：已清除第 ${cp.turn} 轮及之后的记录，并切换到新会话`, false)
      return
    }

    const restored = applyResult?.restored ?? []
    const removed = applyResult?.removed ?? []
    await archiveQuietly(workspaces, sessionId)

    const parts = [`已回滚对话和文件：清除第 ${cp.turn} 轮及之后的对话`]
    if (restored.length > 0) parts.push(`写回 ${restored.length} 个有改动的文件`)
    if (removed.length > 0) parts.push(`撤销 ${removed.length} 个新增文件`)
    if (restored.length === 0 && removed.length === 0) {
      parts.push(preview?.hasSnapshot ? '文件与检查点一致，无需改动' : '该检查点没有文件快照，未改动文件')
    }
    const scopeNote =
      preview && !preview.scoped && preview.unknownSnapshots > 0
        ? '注意：窗口内存在缺少归属信息的检查点，本次按全工作区回滚。'
        : ''
    ui.done(`${parts.join('，')}。${scopeNote}`, false, [
      ...restored.map((file) => `写回 ${file}`),
      ...removed.map((file) => `撤销新增 ${file}`),
    ])
  } catch (err) {
    ui.fail(toErrorMessage(err))
  } finally {
    rollbackInFlight = false
  }
}

async function archiveQuietly(workspaces: DshWorkspaces, sessionId: string): Promise<void> {
  try {
    await workspaces.archiveSession(sessionId)
  } catch {
    // 清理原会话失败不覆盖回滚结果。
  }
}

function installCheckpointEntries(
  sessions: DshSessions,
  workspaces: DshWorkspaces,
  getUiConversation: Resolver<DshUiConversation>,
  getConnection: Resolver<ConnectionHandle>,
): () => void {
  if (typeof document === 'undefined') return () => undefined

  ensureCheckpointStyle()

  let disposed = false
  let syncing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastDebugSignature = ''
  // 每次 sync 更新的最新 refresh 目标：click 闭包可能绑定较旧 target，运行时按 key 取最新。
  let latestRefreshTargets = new Map<string, UserRefreshTarget>()

  // 排查用：浏览器控制台执行
  // localStorage.setItem('dshSessionManagerDebug', '1')
  // 打开诊断；签名变化时输出一行状态，方便定位卡在数据层还是 DOM 适配层。
  const debugEnabled = (): boolean => {
    try {
      return window.localStorage.getItem('dshSessionManagerDebug') === '1'
    } catch {
      return false
    }
  }

  /** 用户消息「刷新」：共用重新生成核心；成功即替换原回答（原会话归档）。 */
  const runRefresh = (target: UserRefreshTarget, button: HTMLButtonElement): void => {
    const sessionId = sessions.list.getSnapshot().current
    if (!sessionId) return
    // 取最新 target（闭包里的可能较旧），保证即时占位与 fork 边界一致。
    const current = latestRefreshTargets.get(target.key) ?? target
    button.disabled = true
    button.style.opacity = '0.5'
    // 点击瞬间降暗该轮回答并占位“正在回复中…”，消除 fork 等待期的卡顿感。
    const restore = showRegeneratingPlaceholder(current.assistantKeys, current.turn)
    void regenerateTurn(
      {
        sessionId,
        sourceKey: `user:${current.key}`,
        content: current.content,
        previousTurnEnd: current.previousTurnEnd,
        turn: current.turn,
      },
      { sessions, workspaces, getUiConversation },
    )
      .then(async (replacementSessionId) => {
        // 先切到新会话再归档原会话（正在查看的会话不能先删）。
        if (sessions.list.getSnapshot().current === sessionId) sessions.open(replacementSessionId)
        await archiveQuietly(workspaces, sessionId)
      })
      .catch((error) => {
        button.title = `刷新失败：${toErrorMessage(error)}`
      })
      .finally(() => {
        restore()
        button.disabled = false
        button.style.opacity = ''
      })
  }

  const sync = () => {
    if (disposed || syncing) return
    syncing = true
    try {
      const current = currentSessionSnapshot(sessions, getUiConversation)
      const checkpoints = computeUserCheckpoints(current?.chat)
      const byKey = new Map(checkpoints.map((cp) => [cp.key, cp]))
      const refreshTargets = computeUserRefreshTargets(current?.chat)
      latestRefreshTargets = refreshTargets

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
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="user"]'))
      let rowsWithActions = 0
      let copyTemplates = 0
      for (const row of rows) {
        const key = row.getAttribute('data-chat-flow-key') ?? ''
        seen.add(key)
        const cp = key ? byKey.get(key) : undefined

        let pill = key ? pillByKey.get(key) : undefined
        if (!cp) {
          pill?.remove()
          continue
        }
        if (!pill) {
          pill = createCheckpointPill(cp, key, () => openRollbackDialog(cp, sessions, workspaces, getConnection))
          pillByKey.set(key, pill)
        }
        const actions = findActionsRow(row)
        if (actions) {
          // 复制按钮的 actions 行作为唯一宿主；复制其真实 class/style，确保两者视觉一致。
          if (!actions.contains(pill)) actions.appendChild(pill)
          adoptCopyButtonStyle(pill, actions, cp, () => openRollbackDialog(cp, sessions, workspaces, getConnection))
          rowsWithActions += 1
          if (actions.querySelector('button[aria-label="复制"], button[aria-label="copy"]')) copyTemplates += 1
        } else if (row.nextElementSibling !== pill) {
          // 兼容宿主版本没有 actions 标记的情况：先紧邻消息后插入，保持常驻可见。
          row.insertAdjacentElement('afterend', pill)
        }

        // 刷新按钮：固定在 actions 行第一位（复制/回滚之前）。
        const refreshTarget = key ? refreshTargets.get(key) : undefined
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
          // 常驻 actions 按钮不清空文本；未找到复制模板时仍显示清晰的回滚入口。
          if (button.dataset.dshCopyStyle !== 'true') button.textContent = `↩ 回滚 #${cp.turn}`
          button.title = cp.preview ? `回滚到第 ${cp.turn} 轮之前：${cp.preview}` : `回滚到第 ${cp.turn} 轮之前`
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
          hasChat: Boolean(current?.chat),
          rows: rows.length,
          checkpoints: checkpoints.length,
          rowsWithActions,
          copyTemplates,
          pills: document.querySelectorAll(CHECKPOINT_PILL).length,
        })
        if (signature !== lastDebugSignature) {
          lastDebugSignature = signature
          console.debug('[dsh-session-manager] rollback sync:', signature)
        }
      }
    } finally {
      syncing = false
    }
  }

  const schedule = () => {
    if (disposed || syncing || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (!disposed) sync()
    }, 50)
  }

  const unsubscribe = sessions.list.subscribe?.(schedule)
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  schedule()

  return () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    observer.disconnect()
    unsubscribe?.()
    removeAllCheckpointPills()
    document.querySelector(CHECKPOINT_DIALOG)?.remove()
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
const activeRegenerations = new Set<string>()
/** 等待新回复的硬上限（足够覆盖长答案；显式取消走 AbortController）。 */
const REGENERATE_TIMEOUT_MS = 10 * 60 * 1000

interface RegenerateRequest {
  sessionId: string
  /** 幂等键：助手消息用 messageId，用户消息用 user node key。 */
  sourceKey: string
  content: unknown[]
  /** fork 边界：上一轮 turn/end seq；第一轮为 undefined（改用 atSeq=0 fork）。 */
  previousTurnEnd: number | undefined
  turn: number | undefined
}

interface RegenerateDeps {
  sessions: DshSessions
  workspaces: DshWorkspaces
  getUiConversation?: Resolver<DshUiConversation>
  signal?: AbortSignal
}

/** 读取某会话的 chat 视图快照。 */
function readChatView(getUiConversation: Resolver<DshUiConversation>, sessionId: string): ChatSnapshotView | undefined {
  try {
    return getUiConversation()?.binding(sessionId)?.snapshot?.getSnapshot()?.views?.get('chat')
  } catch {
    return undefined
  }
}

/** 提交 prompt 前，收集重建会话里已有 assistant 的 messageId 基线。 */
function collectBaselineAssistantIds(getUiConversation: Resolver<DshUiConversation>, sessionId: string): Set<string> {
  const ids = new Set<string>()
  const chat = readChatView(getUiConversation, sessionId)
  for (const node of chat?.nodes?.values() ?? []) {
    if (!isAssistantNode(node)) continue
    const id = assistantMessageId(node)
    if (id !== undefined) ids.add(id)
  }
  return ids
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 等待"本次新生成"的 assistant 进入终态：仅 `status === 'settled'` 算成功，
 * `status === 'interrupted'` 算失败/被中断。基线之外的 assistant（含 streaming 中
 * 尚未拿到 messageId 的节点）一律视为"新回复"，不再拿历史回复顶包。
 */
async function waitForNewAssistant(
  getUiConversation: Resolver<DshUiConversation>,
  sessionId: string,
  baselineIds: Set<string>,
  signal: AbortSignal | undefined,
  timeoutMs: number = REGENERATE_TIMEOUT_MS,
): Promise<void> {
  const scanFresh = (): ChatViewNode | undefined => {
    const chat = readChatView(getUiConversation, sessionId)
    const fresh: ChatViewNode[] = []
    for (const node of chat?.nodes?.values() ?? []) {
      if (!isAssistantNode(node)) continue
      const id = assistantMessageId(node)
      if (id === undefined || !baselineIds.has(id)) fresh.push(node)
    }
    return fresh.at(-1)
  }

  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('已取消')
    const target = scanFresh()
    if (target) {
      const status = (target.data as { status?: unknown } | null | undefined)?.status
      if (status === 'settled') return
      if (status === 'interrupted') throw new Error('重新生成已被中断')
    }
    if (Date.now() >= deadline) throw new Error('等待新回复超时')
    await sleep(150)
  }
}

/** 会话的模型选择（session/selectModel 的投影与 RPC 载荷形状）。 */
interface SessionModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Session 对象上插件用到的内部面：projections（读当前模型投影）与 remote（selectModel RPC）。 */
interface SessionInternals {
  projections?: { faceOf?(key: string): { getSnapshot(): unknown } | undefined }
  remote?: {
    session?: {
      selectModel?(request: {
        sessionId: string
        provider: string
        model: string
        reasoningEffort?: string
      }): Promise<{ ok: boolean; error?: { message?: string } }>
    }
  }
}

/** 读源会话当前生效的模型选择（投影 view 的 next = pending ?? lastUsed）。 */
function readModelSelection(sessions: DshSessions, sessionId: string): SessionModelSelection | undefined {
  try {
    const face = sessions.binding(sessionId)?.session as (SessionFace & SessionInternals) | undefined
    const snapshot = face?.projections?.faceOf?.('modelSelection')?.getSnapshot() as
      | { next?: SessionModelSelection | null }
      | undefined
    const next = snapshot?.next
    if (next && typeof next.provider === 'string' && typeof next.model === 'string') {
      return {
        provider: next.provider,
        model: next.model,
        ...(typeof next.reasoningEffort === 'string' ? { reasoningEffort: next.reasoningEffort } : {}),
      }
    }
  } catch {
    // 投影缺失（未运行过/旧宿主）按“无选择”处理，fork 继承默认行为。
  }
  return undefined
}

/** 把选择补设到重建出的会话（selectForNextRequest 生效于下一次请求）；失败不阻塞重新生成。 */
async function restoreModelSelection(
  sessions: DshSessions,
  sessionId: string,
  selection: SessionModelSelection,
): Promise<void> {
  try {
    const face = sessions.binding(sessionId)?.session as (SessionFace & SessionInternals) | undefined
    const result = await face?.remote?.session?.selectModel?.({
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    })
    if (result && result.ok === false) {
      console.warn(`[dsh-session-manager] 恢复模型选择失败：${result.error?.message ?? 'unknown'}`)
    }
  } catch (error) {
    console.warn('[dsh-session-manager] 恢复模型选择失败：', error)
  }
}

/** 第一轮也尽量 fork（atSeq=0 截取到仅 header，继承配置）；失败才退化为 connectWorkspace。 */
async function forkFirstTurn(deps: RegenerateDeps, req: RegenerateRequest): Promise<string> {
  try {
    return await deps.sessions.fork({ sessionId: req.sessionId, atSeq: 0, increaseTitle: false })
  } catch {
    const workspaceId = findWorkspaceId(req.sessionId, deps.sessions, deps.workspaces)
    if (!workspaceId) throw new Error('无法确定该会话所属工作区')
    return await deps.workspaces.connectWorkspace(workspaceId)
  }
}

/** 刷新/重新生成主流程：fork → prompt（宿主接纳即返回）→ 返回新会话 id。
 *  答案随后在新会话里流式生成；由调用方立刻 switch + 归档原会话，做到「原地替换」
 *  的手感：fork 已完整保留原历史，旧会话只是归档隐藏、可恢复。 */
async function regenerateTurn(req: RegenerateRequest, deps: RegenerateDeps): Promise<string> {
  const lockKey = `${req.sessionId}:${req.sourceKey}`
  if (activeRegenerations.has(lockKey)) throw new Error('正在重新生成，请稍候')
  activeRegenerations.add(lockKey)

  const controller = new AbortController()
  const onExternalAbort = (): void => controller.abort()
  deps.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('重新生成超时')), REGENERATE_TIMEOUT_MS)

  let replacementSessionId: string | undefined
  try {
    replacementSessionId =
      req.previousTurnEnd !== undefined
        ? await deps.sessions.fork({ sessionId: req.sessionId, atSeq: req.previousTurnEnd, increaseTitle: false })
        : await forkFirstTurn(deps, req)

    const replacement = deps.sessions.binding(replacementSessionId)
    if (!replacement) throw new Error('重建会话失败')

    // fork 截断在旧边界，边界之后「切换模型」的 model/selection 事件不会被子会话继承，
    // 投影会回退到旧模型。这里把源会话当前的模型选择补设到新会话，再提交 prompt。
    const selection = readModelSelection(deps.sessions, req.sessionId)
    if (selection) await restoreModelSelection(deps.sessions, replacementSessionId, selection)

    // prompt('queue') 在宿主接纳后立刻返回；此后调用方尽快切走并归档原会话，
    // 不滞留等待——滞留期是「fork 残留多条会话」的根源。
    await replacement.session.prompt(req.content, 'queue', controller.signal)
    return replacementSessionId
  } catch (error) {
    // 失败：原会话保持可用；清理被放弃的重建分支，避免残留空会话。
    if (replacementSessionId !== undefined) {
      try {
        await deps.workspaces.archiveSession(replacementSessionId)
      } catch {
        // 清理失败不覆盖原始错误。
      }
    }
    throw error
  } finally {
    clearTimeout(timeout)
    deps.signal?.removeEventListener('abort', onExternalAbort)
    activeRegenerations.delete(lockKey)
  }
}

const subscribeNoop = (): (() => void) => () => undefined

interface RetryContext {
  content: unknown[]
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
  return {
    content: [...content],
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
  workspaces,
  getUiConversation,
}: {
  sessionId: string
  messageId: string
  sessions: DshSessions
  workspaces: DshWorkspaces
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
    try {
      const replacementSessionId = await regenerateTurn(
        {
          sessionId,
          sourceKey: messageId,
          content: retryContext.content,
          previousTurnEnd: retryContext.previousTurnEnd,
          turn: retryContext.turn,
        },
        { sessions, workspaces, getUiConversation, signal: controller.signal },
      )
      // 替换原回答：先切到新会话，再归档原会话。
      if (sessions.list.getSnapshot().current === sessionId) sessions.open(replacementSessionId)
      await archiveQuietly(workspaces, sessionId)
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

// 纯逻辑导出：供测试验证同回合定位、基线过滤与终态等待，不影响运行时注入。
export { assistantMessageId, collectBaselineAssistantIds, computeRetryContext, computeUserRefreshTargets, waitForNewAssistant }
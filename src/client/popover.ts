/**
 * 回退模式选择浮层（纯 DOM，无 React）。交互的第二步：目标已固定（被点
 * 的消息）；浮层提供两种模式。选「回退对话和代码」时先经 Connection RPC
 * 取影响清单并展示，确认后才执行。
 *
 * 键盘：↑/↓ 只在当前步的动作按钮间移动，Enter 原生激活焦点按钮，Esc 是
 * 浮层各步 ghost 按钮（取消/返回）的键盘孪生；监听在 document 捕获阶段，
 * 浮层打开期间从 composer 抢走按键。
 *
 * 影响预览走 RPC（dsh-rewind v0.18.0 方案）：不占命令通道、不往会话日志
 * 追加 command/run 事件；执行仍走命令通道（onRewind 回调持有）。
 *
 * Ported from SiriLee/dsh-rewind (MIT), src/client/popover.ts。
 */

import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PreviewOutcome } from './host-rpc'
import { CLASS } from './styles'
import type { ChatOf } from './hidden'

export interface PopoverOptions {
  /** 回退目标消息所在会话 id（RPC 预览用）。 */
  readonly sessionId: string
  /** 目标消息 seq。 */
  readonly seq: number
  /** 目标消息时间（展示用；快照未携带时省略）。 */
  readonly time?: number
  /** 目标消息预览文本。 */
  readonly preview: string
  /** 打开浮层的按钮（外部点击忽略目标）。 */
  readonly anchor: HTMLElement
  /**
   * 执行一次回退。浮层先自行关闭；回调持有命令 + composer 回填的完整
   * 生命周期（见 client/index.ts 的 runRewindAndFill）。
   */
  readonly onRewind: (mode: 'chat' | 'both', planId?: string) => void
}

/** 单例浮层元素；null 表示关闭。 */
let popoverEl: HTMLElement | null = null

/**
 * pointerdown 预取槽：按钮按下的瞬间就发起 preview（人手按下到弹起约
 * 80-150ms，足够覆盖探测往返），浮层打开时若已落定则直接以最终态首渲染
 * ——多数情况下「正在检查文件变更…」根本不会出现。打开即消费（一次性）。
 */
let prewarmSlot: { seq: number; promise: Promise<PreviewOutcome>; settled?: PreviewOutcome } | null = null

/** 在按钮 pointerdown 时预取某目标的 preview（无副作用，失败静默）。 */
export function prewarmPreview(sessionId: string, seq: number): void {
  try {
    const slot: { seq: number; promise: Promise<PreviewOutcome>; settled?: PreviewOutcome } = {
      seq,
      promise: previewImpact(sessionId, seq),
    }
    slot.promise.then(outcome => { slot.settled = outcome }).catch(() => {})
    prewarmSlot = slot
  } catch {
    // 预取纯属优化：任何失败都留给 open 时的正常路径。
  }
}

let disposeOutside: (() => void) | null = null

/** 浮层持有键盘的会话 id；null 表示无。 */
let liveSessionId: string | null = null

/** 插件的 composer 聚焦通道（把键盘还给某会话的 composer）。 */
let composerFocuser: ((sessionId: string) => void) | null = null

/** 注册 composer 聚焦通道（client 插件装配时调用一次）。 */
export function registerComposerFocuser(focus: (sessionId: string) => void): void {
  composerFocuser = focus
}

/** 在途的延迟开门回调；closePopover 取消它（关门后再开门=幽灵浮层）。 */
let pendingMount: (() => void) | null = null

/** 关闭当前浮层（如有），并把键盘还给其 composer。 */
export function closePopover(): void {
  pendingMount = null
  if (popoverEl !== null) {
    popoverEl.remove()
    popoverEl = null
  }
  if (disposeOutside !== null) {
    disposeOutside()
    disposeOutside = null
  }
  const sessionId = liveSessionId
  liveSessionId = null
  if (sessionId !== null) {
    try {
      composerFocuser?.(sessionId)
    } catch {
      // 聚焦是表现层；浮层已经消失。
    }
  }
}

/** 目标行格式（seq · [HH:MM ·] 预览）。 */
function formatTarget(seq: number, time: number | undefined, preview: string): string {
  if (time === undefined) return `seq ${seq} · ${preview || '(无文本)'}`
  const d = new Date(time)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `seq ${seq} · ${hh}:${mm} · ${preview || '(无文本)'}`
}

/** 等待执行结局时读取 chat 的会话面（sessionId 即可）。 */
type SessionRef = { readonly sessionId: string }

/** 找最新的匹配谓词的回退命令节点。 */
function findCommand(chat: ReturnType<ChatOf>, match: (node: CommandNode) => boolean): CommandNode | undefined {
  if (chat === undefined) return undefined
  let found: CommandNode | undefined
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node !== undefined && node.kind === 'command') {
      const command = node.data as CommandNode
      if (match(command)) found = command
    }
  }
  return found
}

/**
 * 当前匹配 `match` 的命令节点 seq 集合。在发出同形状新命令前采样，供随后
 * 的等待排除：同一目标的重复 preview/回退必须等本次命令的节点，而不是
 * 落在上一条命令的陈旧结局上。
 */
export function knownCommandSeqs(session: SessionRef, chatOf: ChatOf, match: (node: CommandNode) => boolean): Set<number> {
  const known = new Set<number>()
  const chat = chatOf(session)
  if (chat === undefined) return known
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node !== undefined && node.kind === 'command') {
      const command = node.data as CommandNode
      if (match(command)) known.add(command.seq)
    }
  }
  return known
}

/**
 * 监听会话快照解析最新匹配回退命令的结局（command/run + command/done 落
 * 成一个 CommandNode）。
 * @returns 带结局文本的节点，超时返回 null。
 */
export function waitForCommand(
  session: SessionRef,
  chatOf: ChatOf,
  match: (node: CommandNode) => boolean,
  timeoutMs = 8000,
  watch: (cb: () => void) => () => void,
): Promise<{ kind: 'success' | 'error'; text?: string } | null> {
  return new Promise(resolve => {
    let settled = false
    const settle = (value: { kind: 'success' | 'error'; text?: string } | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(value)
    }
    const check = (): void => {
      const node = findCommand(chatOf(session), match)
      if (node?.outcome !== null && node?.outcome !== undefined) {
        settle({ kind: node.outcome.kind, text: node.outcome.text })
      }
    }
    // chat 快照变了会话面自身的 subscribe 不触发（chat 在 uiConversation
    // 视图里），所以等待方传入绑定到该视图的 watch。
    const unsubscribe = watch(check)
    const timer = setTimeout(() => settle(null), timeoutMs)
    check()
  })
}

/** 预览调用通道：由 client 入口装配时注入（Connection RPC）。 */
let previewCall: ((sessionId: string, seq: number) => Promise<PreviewOutcome>) | null = null

/** 注册/注销预览通道（插件装配与卸载时调用）。 */
export function registerPreviewCall(call: ((sessionId: string, seq: number) => Promise<PreviewOutcome>) | null): void {
  previewCall = call
}

/** 发起一次影响预览（通道未就绪时返回错误结局）。 */
function previewImpact(sessionId: string, seq: number): Promise<PreviewOutcome> {
  if (previewCall === null) return Promise.resolve({ kind: 'error', text: '预览通道未就绪' })
  return previewCall(sessionId, seq)
}

/** 元素工厂（本地实现，不引框架）。 */
function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function modeOption(label: string, hint: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = CLASS.popoverOption
  const labelEl = el('span', CLASS.popoverOptionLabel, label)
  const hintEl = el('span', CLASS.popoverOptionHint, hint)
  button.append(labelEl, hintEl)
  button.addEventListener('click', onClick)
  return button
}

/**
 * 当前浮层步里启用、可聚焦的按钮（DOM 序）。ghost 返回/取消按钮刻意排除：
 * 它们是 Esc 专属（不进 ↑/↓ 循环）。
 */
function focusableButtons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .filter(button => !button.disabled && !button.classList.contains(CLASS.popoverGhost))
}

/** 聚焦当前步第一个启用按钮（无则 no-op）。 */
function focusFirst(root: HTMLElement): void {
  focusableButtons(root)[0]?.focus()
}

/** 在步内按钮间移动焦点，两端环绕。 */
function moveFocus(root: HTMLElement, dir: 1 | -1): void {
  const buttons = focusableButtons(root)
  if (buttons.length === 0) return
  const active = document.activeElement
  const index = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1
  const next = index === -1 ? (dir === 1 ? 0 : buttons.length - 1) : (index + dir + buttons.length) % buttons.length
  buttons[next]?.focus()
}

/**
 * 渲染影响清单步：展示影响结局，然后确认/返回。
 * 打开浮层时已取的结局复用——这里再跑一次 preview 会重复探测并留下第二
 * 条（会被隐藏的）命令行。
 */
function renderImpactStep(
  root: HTMLElement,
  opts: PopoverOptions,
  back: () => void,
  cached?: PreviewOutcome,
): void {
  const { sessionId, seq, onRewind } = opts
  const impact = el(CLASS.popoverImpact, CLASS.popoverImpact)
  impact.textContent = '正在检查文件变更…'
  const actions = el('div', CLASS.popoverActions)
  const backButton = document.createElement('button')
  backButton.type = 'button'
  backButton.className = CLASS.popoverGhost
  backButton.textContent = '返回'
  backButton.addEventListener('click', back)
  actions.append(backButton)

  const confirm = document.createElement('button')
  confirm.type = 'button'
  confirm.className = CLASS.popoverPrimary
  confirm.textContent = '确认回退'
  confirm.disabled = true
  actions.append(confirm)
  root.replaceChildren(impact, actions)
  focusFirst(root)

  void (async () => {
    const outcome = cached ?? await previewImpact(sessionId, seq)
    if (outcome === null) {
      impact.textContent = '获取文件变更失败：请求超时'
      return
    }
    if (outcome.kind === 'error') {
      impact.textContent = `获取文件变更失败：${outcome.text}`
      return
    }
    const restores = outcome.files.filter(f => f.action === 'restore').map(f => f.path)
    const deletes = outcome.files.filter(f => f.action === 'delete').map(f => f.path)
    if (restores.length === 0 && deletes.length === 0) {
      impact.textContent = '目标之后没有需要还原的变更。'
    } else {
      const lines = [
        ...restores.map(path => `还原 ${path}`),
        ...deletes.map(path => `删除 ${path}`),
      ]
      if (outcome.backupOff) {
        const list = document.createElement('div')
        list.textContent = lines.join('\n')
        impact.replaceChildren(list, el('div', CLASS.popoverNote, '快照备份已关闭，本次还原可能不充分。'))
      } else {
        impact.textContent = lines.join('\n')
      }
    }
    confirm.disabled = false
    // 确认是本步唯一动作；启用后聚焦它，直接 Enter 即确认。
    confirm.focus()
    confirm.addEventListener('click', () => {
      closePopover()
      onRewind('both', outcome.kind === 'success' ? outcome.planId : undefined)
    })
  })().catch(() => {
    impact.textContent = '获取文件变更失败：意外错误'
  })
}

/**
 * 浮层壳：挂载、定位、外部点击关闭、捕获阶段 ↑/↓/Esc。
 */
interface PopoverShell {
  /** 内容重渲染后重新定位。 */
  readonly position: () => void
  /** 移除浮层与监听（closePopover 也做这件事）。 */
  readonly dispose: () => void
}

/** 围绕 root 挂载共享浮层壳。 */
function mountShell(root: HTMLElement, anchor: HTMLElement, onKeyDown: (event: KeyboardEvent) => void): PopoverShell {
  /** 定位在锚点下方右对齐，近底部翻转到上方；最终钳制在视口内。 */
  const position = (): void => {
    const rect = anchor.getBoundingClientRect()
    const gap = 4
    const height = root.offsetHeight
    const width = root.offsetWidth
    const below = rect.bottom + gap + height <= window.innerHeight - 8
    const rawTop = below ? rect.bottom + gap : rect.top - gap - height
    const rawLeft = Math.min(rect.right, window.innerWidth - 8 - width)
    // 钳制：锚点脱离 DOM（rect 全零）或滚出视口时，弹层仍留在屏幕内。
    const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max))
    root.style.top = `${Math.round(clamp(rawTop, 8, window.innerHeight - height - 8))}px`
    root.style.left = `${Math.round(clamp(rawLeft, 8, window.innerWidth - width - 8))}px`
  }

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null
    if (root.contains(target) || anchor.contains(target)) return
    closePopover()
  }
  // document 捕获阶段：先于宿主的 React handler，浮层打开期间从 composer
  // 抢走 ↑/↓/Esc（↑ 是输入历史召回）。Enter 无需处理：焦点按钮原生激活。
  const deferred = setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
  }, 0)
  const dispose = (): void => {
    clearTimeout(deferred)
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeyDown, true)
  }

  document.body.append(root)
  position()
  return { position, dispose }
}

/** 打开锚定在按钮附近的模式选择浮层。 */
export function openPopover(opts: PopoverOptions): void {
  closePopover()
  liveSessionId = opts.sessionId
  const { sessionId, seq, time, preview, anchor, onRewind } = opts

  const root = el('div', CLASS.popover)
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', '回退对话')

  /** 「回退对话和代码」模式的可用性，由 preview 决定。 */
  type BothState =
    | { state: 'loading' }
    | { state: 'hasChanges' }
    | { state: 'noChanges' }
    | { state: 'error'; message: string }
  let bothState: BothState = { state: 'loading' }
  /** 打开时取到的影响结局；both 步复用（不再发第二条命令行）。 */
  let impactOutcome: PreviewOutcome = null

  /** 当前步：Esc 在模式步是取消，在影响步是返回。 */
  let step: 'modes' | 'impact' = 'modes'

  const renderModes = (): void => {
    step = 'modes'
    const children: HTMLElement[] = [
      el('div', CLASS.popoverTitle, '回退对话'),
      el('div', CLASS.popoverTarget, formatTarget(seq, time, preview)),
      modeOption('仅回退对话', '撤回这条消息及其后的对话，文本回填输入框', () => {
        closePopover()
        onRewind('chat')
      }),
    ]
    if (bothState.state === 'noChanges') {
      // 检查点没有跟踪的文件变更时只给对话回退；muted note 保持布局稳定。
      children.push(el('div', CLASS.popoverImpact, '目标之后没有需要还原的文件变更。'))
    } else if (bothState.state === 'error') {
      // preview 失败（如目标已被压缩遮蔽）：展示宿主原因，不给永远禁用的
      // 加载中入口。
      children.push(el('div', CLASS.popoverImpact, `获取文件变更失败：${bothState.message}`))
    } else {
      const option = modeOption(
        '回退对话和代码',
        bothState.state === 'loading' ? '正在检查文件变更…' : '同时还原被改动的文件',
        renderImpact,
      )
      if (bothState.state === 'loading') option.disabled = true
      children.push(option)
    }
    const actions = el('div', CLASS.popoverActions)
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = CLASS.popoverGhost
    cancel.textContent = '取消'
    cancel.addEventListener('click', closePopover)
    actions.append(cancel)
    children.push(actions)
    root.replaceChildren(...children)
    focusFirst(root)
  }

  /** 进入影响清单步（返回/Esc 回到模式步）。 */
  const renderImpact = (): void => {
    step = 'impact'
    renderImpactStep(root, opts, renderModes, impactOutcome)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      moveFocus(root, 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      moveFocus(root, -1)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      // Esc 是当前步 ghost 按钮的键盘孪生：模式步取消，影响步返回。
      if (step === 'impact') renderModes()
      else closePopover()
    }
  }

  // 消费 pointerdown 预取：同目标 → 开门即最终态（零闪烁）。
  const pre = prewarmSlot
  prewarmSlot = null
  const usePre = pre !== null && pre.seq === seq ? pre : null

  /** 把一次探测结局落到 both 可用性状态。 */
  const applyOutcome = (outcome: PreviewOutcome): void => {
    impactOutcome = outcome
    if (outcome !== null && outcome.kind === 'success') {
      bothState = { state: outcome.files.length > 0 ? 'hasChanges' : 'noChanges' }
    } else {
      bothState = { state: 'error', message: outcome?.text ?? '预览请求超时' }
    }
  }

  /** 开门：首渲染 + 挂壳；both 仍为加载态时继续 dsh-rewind 的异步落定。 */
  const mount = (): void => {
    renderModes()
    const shell = mountShell(root, anchor, onKeyDown)
    popoverEl = root
    disposeOutside = shell.dispose
    shell.position()
    if (bothState.state !== 'loading') return
    void (async () => {
      const outcome = usePre !== null
        ? await usePre.promise
        : await previewImpact(sessionId, seq)
      applyOutcome(outcome)
      renderModes()
      shell.position()
    })().catch(() => {
      bothState = { state: 'error', message: '意外错误' }
      renderModes()
      shell.position()
    })
  }

  if (usePre !== null && usePre.settled !== undefined) {
    // 预取已落定：开门即最终态。
    applyOutcome(usePre.settled)
    mount()
    return
  }

  if (usePre !== null) {
    // 预取在途：最多等 250ms 再开门——pointerdown 已先行探测,通常此刻刚好
    // 落定,开门零闪烁;超时则回退加载态(dsh-rewind 原生行为)。等待期间
    // 用户关掉浮层(Esc/再次点击)会取消这次开门。
    pendingMount = mount
    void (async () => {
      await Promise.race([
        usePre.promise.catch(() => null),
        new Promise(r => setTimeout(r, 250)),
      ])
      const go = pendingMount
      pendingMount = null
      if (go !== mount) return
      if (usePre.settled !== undefined) applyOutcome(usePre.settled)
      mount()
    })()
    return
  }

  // 无预取：开门即加载态，随后异步落定（dsh-rewind 原生路径）。
  mount()
}

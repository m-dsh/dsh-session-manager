/**
 * 顶栏固定最近用户消息（sticky prompt bar）。
 *
 * 长对话向上滚动时，把视口顶部之外最近的一条用户消息 pin 到滚动容器
 * 顶部，作为一条可点击的提示条；点击回到原始气泡。迁移自
 * dsh-oil-sticky-prompt 0.1.0，选择器已适配 DSH 0.1.2-rc.1 的 DOM：
 * - 行：[data-chat-flow-kind="user"][data-chat-flow-key]
 * - 滚动容器：[data-conversation-scroll]
 * - 气泡文本：克隆行节点剔除插件注入/时间戳/图标按钮后取 textContent
 * - 顶栏 pill 与系统用户气泡 Sixlwa_bubble 同款度量
 */

const HOST_ATTR = 'data-dsh-sticky-host'

/** 折叠原始换行，避免短首行在两行 clamp 里遮住后续内容。 */
export function flattenPromptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

interface StuckRowBox {
  key: string
  top: number
}

const PIN = 0.5
const RELEASE = 8

/**
 * 最近一条已滚过视口顶部的用户行；带滞回（PIN/RELEASE）防止样式抖动。
 * currentKey 为当前 pinned key，用于在边缘区间保持粘滞。
 */
export function pickPinnedRow(
  rows: readonly StuckRowBox[],
  scrollerTop: number,
  currentKey?: string,
): string | undefined {
  let lastPast: string | undefined
  let lastPastIndex = -1
  for (const [index, row] of rows.entries()) {
    if (row.top <= scrollerTop + PIN) {
      lastPast = row.key
      lastPastIndex = index
    }
  }

  if (currentKey !== undefined) {
    const currentIndex = rows.findIndex((row) => row.key === currentKey)
    const current = currentIndex === -1 ? undefined : rows[currentIndex]
    if (lastPastIndex > currentIndex) return lastPast
    if (current !== undefined && current.top <= scrollerTop + RELEASE) return currentKey
  }

  return lastPast
}

interface RowBox extends StuckRowBox {
  row: HTMLElement
}

const EASE = '220ms cubic-bezier(0.22, 1, 0.36, 1)'
const hideTimers = new WeakMap<HTMLElement, number>()
const TIME_ONLY = /^\d{1,2}:\d{2}(?::\d{2})?$/

function rowBoxesOf(scroller: HTMLElement): RowBox[] {
  const rows: RowBox[] = []
  for (const row of scroller.querySelectorAll<HTMLElement>(
    '[data-chat-flow-kind="user"][data-chat-flow-key]',
  )) {
    const key = row.getAttribute('data-chat-flow-key') ?? ''
    if (key === '') continue
    // 隐藏的流程节点（折叠过程行）不带用户文本，跳过
    if (row.hasAttribute('data-turn-process-hidden')) continue
    rows.push({ key, top: row.getBoundingClientRect().top, row })
  }
  return rows
}

function ensureHost(scroller: HTMLElement): HTMLElement {
  const existing = scroller.querySelector(`:scope > [${HOST_ATTR}]`)
  if (existing instanceof HTMLElement) return existing
  const host = document.createElement('div')
  host.setAttribute(HOST_ATTR, '')
  host.innerHTML =
    '<div class="dshSessionManagerStickyBar" hidden><button type="button" class="dshSessionManagerStickyPrompt"><span class="dshSessionManagerStickyText"></span></button></div>'
  scroller.prepend(host)
  return host
}

function clearTransform(prompt: HTMLElement): void {
  prompt.style.transition = ''
  prompt.style.transform = ''
  prompt.style.transformOrigin = ''
}

function placeFrom(prompt: HTMLElement, from: DOMRect, to: DOMRect): void {
  const scaleX = from.width / Math.max(to.width, 1)
  const scaleY = from.height / Math.max(to.height, 1)
  prompt.style.transition = 'none'
  prompt.style.transformOrigin = 'top left'
  prompt.style.transform =
    `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scaleX}, ${scaleY})`
}

function animateToRest(prompt: HTMLElement): void {
  // 强制一次 reflow 让起始 transform 生效后再过渡
  prompt.getBoundingClientRect()
  prompt.style.transition = `transform ${EASE}`
  prompt.style.transform = 'none'
}

function textOf(row: HTMLElement): string {
  // 克隆后剔除插件自身注入的节点与时间戳叶子，避免抓取行内工具文本。
  const clone = row.cloneNode(true) as HTMLElement
  for (const element of clone.querySelectorAll<HTMLElement>(
    '[data-dsh-checkpoint-pill], [data-dsh-sticky-host]',
  )) element.remove()
  for (const element of Array.from(clone.querySelectorAll<HTMLElement>('button'))) {
    const label = element.getAttribute('aria-label')?.toLowerCase() ?? ''
    if (label === '复制' || label === 'copy' || label === '') element.remove()
  }
  for (const element of Array.from(clone.querySelectorAll<HTMLElement>('span, time, div'))) {
    if (element.childElementCount === 0 && TIME_ONLY.test(element.textContent ?? '')) element.remove()
  }
  return flattenPromptText(clone.textContent ?? '')
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

function bindJumpInto(prompt: HTMLButtonElement, scroller: HTMLElement, key: string): void {
  prompt.onclick = () => {
    scroller
      .querySelector(`[data-chat-flow-kind="user"][data-chat-flow-key="${cssEscape(key)}"]`)
      ?.scrollIntoView({
        block: 'start',
        behavior: reducedMotion() ? 'auto' : 'smooth',
      })
  }
}

function hideBar(host: HTMLElement, bar: HTMLElement, prompt: HTMLElement): void {
  delete host.dataset.dshStickyKey
  if (bar.hidden) return
  clearTransform(prompt)
  const finish = () => {
    hideTimers.delete(host)
    bar.hidden = true
    delete bar.dataset.dshStickyVisible
    const label = bar.querySelector('.dshSessionManagerStickyText')
    if (label !== null) label.textContent = ''
  }
  if (reducedMotion()) {
    finish()
    return
  }
  delete bar.dataset.dshStickyVisible
  hideTimers.set(host, window.setTimeout(finish, 170))
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 整组用户行 key 全部替换（切换会话/内容重建）时为 true，用于触发静默稳定窗口。 */
export function isRowSetReplaced(previous: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  if (previous.size === 0 || next.size === 0) return false
  for (const key of next) {
    if (previous.has(key)) return false
  }
  return true
}

/** 切换会话后宿主要恢复滚动、补历史分页、稳定内容高度，期间布局是中间态；
 *  静默窗口内不渲染提示条，避免先显示“上一条”再跳到“最新一条”。 */
const SETTLE_MS = 300
const MAX_SUPPRESS_MS = 1200

interface StickyState {
  keys: Set<string>
  sessionId?: string
  suppressUntil: number
  suppressStart: number
  settleTimer?: number
}

const stickyStates = new WeakMap<HTMLElement, StickyState>()

function stateOf(scroller: HTMLElement): StickyState {
  let state = stickyStates.get(scroller)
  if (state === undefined) {
    state = { keys: new Set(), suppressUntil: 0, suppressStart: 0 }
    stickyStates.set(scroller, state)
  }
  return state
}

function userKeySet(scroller: HTMLElement): Set<string> {
  const keys = new Set<string>()
  for (const row of scroller.querySelectorAll<HTMLElement>(
    '[data-chat-flow-kind="user"][data-chat-flow-key]',
  )) {
    const key = row.getAttribute('data-chat-flow-key')
    if (key) keys.add(key)
  }
  return keys
}

function safeSessionId(getSessionId?: () => string | undefined): string | undefined {
  if (getSessionId === undefined) return undefined
  try {
    return getSessionId()
  } catch {
    return undefined
  }
}

/** 当前安装实例的 rAF 刷新入口（scheduleSettle 静默结束后复用它渲染最终态）。 */
let refreshScroller: ((scroller: HTMLElement) => void) | undefined

function scheduleSettle(
  scroller: HTMLElement,
  state: StickyState,
  isEnabled: () => boolean,
  delay: number,
): void {
  if (state.settleTimer !== undefined) window.clearTimeout(state.settleTimer)
  state.settleTimer = window.setTimeout(() => {
    state.settleTimer = undefined
    if (!scroller.isConnected) return
    refreshScroller?.(scroller)
  }, Math.max(0, delay))
}

function renderBar(
  scroller: HTMLElement,
  isEnabled: () => boolean,
  getSessionId?: () => string | undefined,
): void {
  // 注入前按当前设置复核：这样即使页面上还残留着旧 bundle 的实例（HMR/重建后
  // 未及卸载），关掉开关后它也不会再显示提示条。
  if (!isEnabled()) {
    const stale = scroller.querySelector(`:scope > [${HOST_ATTR}]`)
    if (stale instanceof HTMLElement) stale.remove()
    return
  }
  if (!scroller.isConnected) return

  const host = ensureHost(scroller)
  const bar = host.querySelector<HTMLElement>('.dshSessionManagerStickyBar')
  const label = host.querySelector<HTMLElement>('.dshSessionManagerStickyText')
  const prompt = host.querySelector<HTMLButtonElement>('.dshSessionManagerStickyPrompt')
  if (bar === null || label === null || prompt === null) return

  const state = stateOf(scroller)
  const sessionId = safeSessionId(getSessionId)
  const keys = userKeySet(scroller)
  const switched =
    (sessionId !== undefined && state.sessionId !== undefined && sessionId !== state.sessionId) ||
    isRowSetReplaced(state.keys, keys)
  if (sessionId !== undefined) state.sessionId = sessionId

  if (switched) {
    state.keys = keys
    const now = Date.now()
    state.suppressStart = now
    state.suppressUntil = now + SETTLE_MS
    hideBar(host, bar, prompt)
    scheduleSettle(scroller, state, isEnabled, SETTLE_MS)
    return
  }
  state.keys = keys

  const now = Date.now()
  if (state.suppressUntil > now && now - state.suppressStart < MAX_SUPPRESS_MS) {
    // 静默期内继续有变动（分页/高度稳定），顺延窗口；上限兜底防止永不恢复。
    state.suppressUntil = Math.min(now + SETTLE_MS, state.suppressStart + MAX_SUPPRESS_MS)
    scheduleSettle(scroller, state, isEnabled, state.suppressUntil - now)
    return
  }
  state.suppressUntil = 0

  const rows = rowBoxesOf(scroller)
  const previous = host.dataset.dshStickyKey
  const next = pickPinnedRow(
    rows.map((row) => ({ key: row.key, top: row.top })),
    scroller.getBoundingClientRect().top,
    previous,
  )
  const match = rows.find((row) => row.key === next)
  if (next === undefined || match === undefined) {
    if (previous === undefined || bar.hidden || hideTimers.has(host)) return
    hideBar(host, bar, prompt)
    return
  }

  const pendingHide = hideTimers.get(host)
  if (pendingHide !== undefined) {
    window.clearTimeout(pendingHide)
    hideTimers.delete(host)
  }

  const text = textOf(match.row)
  if (text === '') {
    hideBar(host, bar, prompt)
    return
  }

  const same = previous === next && !bar.hidden && pendingHide === undefined
  if (same) {
    if (label.textContent !== text) label.textContent = text
    bindJumpInto(prompt, scroller, next)
    return
  }

  const from = match.row.getBoundingClientRect()
  label.textContent = text
  host.dataset.dshStickyKey = next
  bar.hidden = false
  bar.dataset.dshStickyVisible = '1'
  bindJumpInto(prompt, scroller, next)

  if (reducedMotion()) {
    clearTransform(prompt)
    return
  }
  placeFrom(prompt, from, prompt.getBoundingClientRect())
  animateToRest(prompt)
}

/** 安装：滚动容器级监听 + 一次性 resize/Mutation 刷新。清理返回后 DOM 自净。 */
export function installStickyUserRows(
  isEnabled: () => boolean = () => true,
  getSessionId?: () => string | undefined,
): () => void {
  let frame = 0
  const refresh = (scroller: HTMLElement) => {
    if (frame !== 0) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      renderBar(scroller, isEnabled, getSessionId)
    })
  }
  refreshScroller = refresh

  const onScroll = (event: Event) => {
    const target = event.target
    if (
      !(target instanceof HTMLElement) ||
      !target.hasAttribute('data-conversation-scroll')
    ) return
    refresh(target)
  }

  const onMutate = () => {
    for (const scroller of document.querySelectorAll<HTMLElement>('[data-conversation-scroll]')) {
      refresh(scroller)
    }
  }

  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  window.addEventListener('resize', onMutate)
  onMutate()

  return () => {
    document.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', onMutate)
    if (frame !== 0) window.cancelAnimationFrame(frame)
    refreshScroller = undefined
    for (const host of document.querySelectorAll(`[${HOST_ATTR}]`)) host.remove()
  }
}

const STYLE_ID = 'dsh-session-manager: sticky prompt'
const STYLES = `
[${HOST_ATTR}]{
  position:sticky;
  top:0;
  z-index:5;
  height:0;
  overflow:visible;
  pointer-events:none;
}
.dshSessionManagerStickyBar{
  position:absolute;
  left:0;
  right:0;
  top:0;
  display:flex;
  justify-content:center;
  padding:8px calc(var(--dsh-composer-side-clearance, 16px) + 16px);
  background:var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1, #fff));
  box-shadow:0 16px 16px -12px var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1, #fff));
  opacity:0;
  transition:opacity 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.dshSessionManagerStickyBar[data-dsh-sticky-visible]{opacity:1}
.dshSessionManagerStickyBar[hidden]{display:none}
.dshSessionManagerStickyPrompt{
  display:block;
  box-sizing:border-box;
  width:100%;
  max-width:var(--dsh-chat-content-width, 748px);
  margin:0;
  padding:10px 16px;
  border:none;
  border-radius:22px;
  background:var(--dsw-specific-bubble, var(--dsw-alias-bg-secondary, #f2f4f7));
  color:var(--dsw-alias-label-primary, #101828);
  font:inherit;
  font-size:var(--dsh-content-font-size, 14px);
  line-height:calc(22px + var(--dsh-content-font-delta, 0px));
  text-align:right;
  pointer-events:auto;
  cursor:pointer;
  will-change:transform;
}
.dshSessionManagerStickyPrompt:focus-visible{
  outline:none;
  box-shadow:0 0 0 2px var(--dsw-alias-border-l3, #98a2b3);
}
.dshSessionManagerStickyText{
  display:-webkit-box;
  overflow:hidden;
  overflow-wrap:anywhere;
  white-space:normal;
  -webkit-box-orient:vertical;
  -webkit-line-clamp:2;
}
@media (prefers-reduced-motion:reduce){
  .dshSessionManagerStickyBar{box-shadow:none;opacity:1;transition:none}
  .dshSessionManagerStickyPrompt{transition:none}
}
`

function ensureStickyStyle(): void {
  const existing = document.querySelector(
    `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`,
  )
  const tag = existing instanceof HTMLStyleElement ? existing : document.createElement('style')
  tag.dataset.plugin = 'dsh-session-manager'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = STYLES
  if (existing === null) document.head.appendChild(tag)
}

/** 在插件 Client ctx 上安装 sticky prompt；返回卸载函数。 */
export function applyStickyPrompt(
  isEnabled: () => boolean = () => true,
  getSessionId?: () => string | undefined,
): () => void {
  if (typeof document === 'undefined') return () => undefined
  ensureStickyStyle()
  return installStickyUserRows(isEnabled, getSessionId)
}

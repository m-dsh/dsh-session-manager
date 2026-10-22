/**
 * Pure computation of the chat rows a rewind hides from the rendered
 * transcript. Extracted from the client plugin (`src/client/index.ts`) so the
 * multi-rewind cut logic stays unit-testable without a DOM.
 *
 * Ported from SiriLee/dsh-rewind (MIT), src/client/hidden.ts（未移植图片
 * 附件回填与 pending 插话部分——本插件不做这两件事）。
 *
 * @module dsh-session-manager/client/hidden
 */

import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * The internal engine channel every client call is sent to. Mirrored by
 * `ENGINE_COMMAND` in `src/index.ts` — the two bundles share no module.
 */
export const ENGINE_COMMAND = 'rewind-plugin'

/** Engine command names the client recognizes. */
export const ENGINE_COMMANDS: ReadonlySet<string> = new Set([ENGINE_COMMAND])

/**
 * A chat-snapshot view node as the hiding / composer-refill logic reads it.
 * The harness's view node shape plus the `anchorSeq` the chat snapshot carries
 * (the plugin reads `anchorSeq` off each node; it is not declared on the
 * harness's `ConversationViewNode`).
 */
export interface ChatConversationViewNode {
  readonly key: string
  readonly kind?: string
  readonly data?: unknown
  readonly anchorSeq: number
  /** Owning Turn as the chat snapshot carries it; its `turn` and `start` are read
   * (see `addWithdrawnTurnChrome`). */
  readonly location?: { readonly turn?: { readonly turn?: unknown; readonly start?: unknown } }
}

/** Minimal chat snapshot reader the hiding logic needs. */
export interface HiddenChat {
  readonly order: readonly string[]
  readonly nodes: { get(key: string): ChatConversationViewNode | undefined }
  /** Turn-keyed node index; absent on older snapshots, which the chrome pass tolerates. */
  readonly locations?: { getTurn(turn: number): readonly string[] }
}

/**
 * Reader for one session's live chat snapshot: the chat is served by the
 * `uiConversation` service's named "chat" view.
 */
export type ChatOf = (
  session: { readonly sessionId: string } | undefined,
) => HiddenChat | undefined

/**
 * Subscribe to one session's live chat-update signal, for waiting on a chat
 * snapshot change without polling.
 */
export type ChatWatch = (sessionId: string, cb: () => void) => () => void

/**
 * Choose the chat-update subscription: the `uiConversation` "chat" view's own
 * `subscribe`. Extracted as a pure channel-selection step so the resolver is
 * unit-testable. Never throws.
 */
export function resolveChatWatch(
  resolveView: (sessionId: string) => { subscribe?(cb: () => void): () => void } | undefined,
  sessionId: string,
  cb: () => void,
): () => void {
  const view = resolveView(sessionId)
  return view?.subscribe?.(cb) ?? (() => {})
}

/**
 * Resolve the chat snapshot from the `uiConversation` "chat" view. The view's
 * `getSnapshot()` returns undefined until the named view is registered, which
 * degrades to `undefined` (no targets, no hiding — never a crash).
 */
export function chatSnapshotOf(
  chatView: { getSnapshot(): unknown } | undefined,
): HiddenChat | undefined {
  return (chatView?.getSnapshot() ?? undefined) as HiddenChat | undefined
}

/**
 * The plain text of the human message at `seq` in the chat snapshot, for
 * filling the composer after a withdraw. Accepts BOTH `user` and `steering`
 * nodes: a plan-mode (`/plan <text>`) input is delivered through the agent
 * inbox next-step and claimed, so it renders as `steering`, and its text must
 * still return to the composer. State absent → undefined; a message with no
 * text blocks → ''. Same text-blocks join the candidate side uses.
 */
export function messageTextAt(chat: HiddenChat | undefined, seq: number): string | undefined {
  if (chat === undefined) return undefined
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
    const data = node.data as {
      seq?: number
      content?: readonly { type?: string; text?: string }[]
    }
    if (data.seq === seq) {
      return data.content
        ?.map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('')
    }
  }
  return undefined
}

/**
 * Extract the rewind target seq from a command's structured `args`
 * (e.g. `@5 chat`, `preview @5 both`). Locale-independent — never parses the
 * host's human outcome copy.
 */
export function targetSeqOfArgs(args: string | null | undefined): number | undefined {
  if (args === undefined || args === null) return undefined
  const match = args.match(/@(\d+)/)
  return match !== null ? Number(match[1]) : undefined
}

/**
 * True when one of this plugin's engine command nodes is an EXECUTED rewind for
 * `seq` — the admission form the popover drives (`@<seq> chat` / `both`) that
 * settled with a marker-carrying success outcome. The composer refill waits for
 * exactly this node after the user confirms, so a history-loaded command can
 * never trigger a fill.
 */
export function isExecutedRewindCommand(node: CommandNode, seq: number): boolean {
  if (node.name === null || !ENGINE_COMMANDS.has(node.name) || node.outcome?.kind !== 'success') return false
  // A success WITHOUT a marker rewound nothing (an impact preview).
  if (node.outcome.sourceEventSeq === undefined) return false
  const args = node.args ?? ''
  return new RegExp(`(?:^|\\s)@${seq}(?:\\s|$)`).test(args)
}

/**
 * Whether a preview outcome reports tracked file changes — the availability
 * of the "rewind conversation and code" option.
 *
 * Reads ONLY the machine-readable `impact=<n>` trailer the host appends to
 * preview text. Older host output without the trailer is treated as having no
 * changes (never guesses from human copy). Absent text (undefined) degrades to
 * always-show so a working option is never hidden on a failed probe.
 */
export function hasFileImpact(text: string | undefined): boolean {
  if (text === undefined) return true
  const match = text.match(/impact=(\d+)/)
  if (match !== null) return Number(match[1]) > 0
  return false
}

/** Whether the preview reports that new file checkpoints are disabled. */
export function hasBackupDisabled(text: string | undefined): boolean {
  return text !== undefined && /(?:^|\n)backup=off(?:\n|$)/.test(text)
}

/**
 * The preview's host-stashed plan id (the `plan=<id>` machine token), used to
 * arm the TOCTOU re-check on the subsequent both execution. Absent on hosts
 * without the hardening.
 */
export function planIdOfPreviewText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const match = text.match(/(?:^|\n)plan=([0-9a-f]+)(?:\n|$)/)
  return match !== null ? (match[1] ?? undefined) : undefined
}

/**
 * True when an engine command node is an impact preview — the internal probe
 * the popover runs (`preview @seq both`) to fetch the restore/delete
 * list. Previews never surface in the transcript (their result is shown in
 * the popover), so their flow node is hidden in every state.
 */
function isPreviewCommand(command: CommandNode): boolean {
  return (command.args ?? '').includes('preview')
}

/**
 * True when an engine command node is the internal candidate-list probe
 * (`__candidates`). Like previews, its flow node never surfaces in the
 * transcript — it only feeds the picker — so it is hidden in every state.
 */
export function isCandidateCommand(command: CommandNode): boolean {
  return (command.args ?? '').includes('__candidates')
}

/**
 * One executed rewind's cut: the target seq through the marker's seq, inclusive.
 */
interface CutSpan {
  readonly start: number
  end: number
}

/**
 * Coalesce rewind cut spans into disjoint, ascending ranges.
 *
 * A span covers an inclusive range of anchor seqs, so two spans that overlap
 * describe one continuous cut and merge. Only strict overlap merges: adjacent
 * ranges stay separate, which keeps the union exact without assuming seqs are
 * integers. Membership then costs one binary search per node instead of a scan
 * of every rewind × node pair.
 *
 * @param spans - one `[target, marker]` range per executed rewind.
 * @returns the merged ranges, ascending by start.
 */
function coalesceCuts(spans: readonly CutSpan[]): readonly CutSpan[] {
  if (spans.length < 2) return spans
  const sorted = [...spans].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: CutSpan[] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end
      continue
    }
    merged.push({ start: span.start, end: span.end })
  }
  return merged
}

/**
 * Whether an anchor seq falls inside any coalesced cut range.
 * @param cuts - coalesced ranges, ascending by start (see `coalesceCuts`).
 * @param seq - the anchor seq to test.
 * @returns true when a rewind withdrew that seq.
 */
function cutsContain(cuts: readonly CutSpan[], seq: number): boolean {
  let low = 0
  let high = cuts.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const cut = cuts[middle]!
    if (seq < cut.start) high = middle - 1
    else if (seq > cut.end) low = middle + 1
    else return true
  }
  return false
}

/**
 * Node keys of rows OUTSIDE every cut, by anchor value. The DOM hide matches a
 * row by anchor VALUE, so a chrome row may only join the set while no live row
 * shares that value.
 * @param snap - the live chat snapshot.
 * @param cuts - coalesced withdrawn ranges (see `coalesceCuts`).
 */
function liveAnchorKeys(snap: HiddenChat, cuts: readonly CutSpan[]): Map<number, string[]> {
  const live = new Map<number, string[]>()
  for (const key of snap.order) {
    const node = snap.nodes.get(key)
    if (node === undefined || cutsContain(cuts, node.anchorSeq)) continue
    const keys = live.get(node.anchorSeq)
    if (keys === undefined) live.set(node.anchorSeq, [key])
    else keys.push(key)
  }
  return live
}

const EMPTY_KEYS: readonly string[] = []

/**
 * Add the Turn-process summary row of every Turn whose rows were ALL withdrawn.
 *
 * That row is the one Turn row whose anchor can precede the rewind target: a Turn
 * stopped before any process evidence anchors at `turn.start.seq − 0.1`, which is
 * BEFORE its human message (the target), so the anchor comparison never reaches
 * it. Same rule as the seat pass's emptied GROUP shell, one level up: the summary
 * goes when it can no longer disclose anything live. This reads a SUPERSET of the
 * harness's disclosure members, so the test can only get harder to pass — a
 * misjudgement drops the summary row, never a live one.
 *
 * @param snap - the live chat snapshot.
 * @param cuts - coalesced withdrawn ranges (see `coalesceCuts`).
 * @param hidden - the set being built; extended in place.
 */
function addWithdrawnTurnChrome(snap: HiddenChat, cuts: readonly CutSpan[], hidden: Set<number>): void {
  const locations = snap.locations
  if (locations === undefined || cuts.length === 0) return
  let live: Map<number, string[]> | undefined
  for (const key of snap.order) {
    const chrome = snap.nodes.get(key)
    if (chrome === undefined || chrome.kind !== 'turn-process') continue
    const located = chrome.location?.turn
    // A window that holds only part of the Turn cannot be judged honestly.
    if (located?.start === undefined) continue
    const turn = located.turn
    if (typeof turn !== 'number') continue
    const keys = locations.getTurn(turn)
    if (keys.length === 0) continue
    const rows = keys
      .map(member => snap.nodes.get(member))
      .filter((member): member is ChatConversationViewNode => member !== undefined)
    if (rows.length !== keys.length) continue
    if (!rows.every(member => member.key === chrome.key || cutsContain(cuts, member.anchorSeq))) continue
    live ??= liveAnchorKeys(snap, cuts)
    if ((live.get(chrome.anchorSeq) ?? EMPTY_KEYS).some(holder => holder !== chrome.key)) continue
    hidden.add(chrome.anchorSeq)
  }
}

/**
 * Per-snapshot memo of {@link hiddenSeqsOf}.
 *
 * A chat snapshot wrapper is replaced on every committed update, while the
 * refresher runs once per DOM mutation batch; the fold cannot have changed
 * between those refreshes. The cache keeps its own copy and every hit returns a
 * copy: the exported API must not hand callers a shared mutable `Set` that
 * could poison the cache.
 */
const hiddenSeqsMemo = new WeakMap<HiddenChat, Set<number>>()

/**
 * Anchor seqs that must be hidden from the rendered transcript so the user sees
 * the conversation as the agent sees it: every impact-preview flow node (it only
 * exists to feed the popover) and every SUCCESSFUL executed rewind command
 * row, plus every message a rewind withdrew — the target, everything after it,
 * and the (unrendered) marker.
 *
 * Each executed rewind cuts ONE span `[target, marker]`, and callers must keep
 * the spans SEPARATE: collapsing them to `[min target, max marker]` would hide a
 * still-on-surface gap of new traffic between an earlier marker and a later
 * target. Endpoints come from the command nodes (`sourceEventSeq` is the
 * marker's log seq; the outcome text carries the target seq).
 *
 * A Turn whose rows were ALL withdrawn also contributes its Turn-process summary
 * row, whose own anchor can precede the target (see `addWithdrawnTurnChrome`).
 */
export function hiddenSeqsOf(snap: HiddenChat): Set<number> {
  const memo = hiddenSeqsMemo.get(snap)
  if (memo !== undefined) return new Set(memo)
  const hidden = new Set<number>()
  const spans: CutSpan[] = []
  for (const key of snap.order) {
    const node = snap.nodes.get(key)
    if (node === undefined || node.kind !== 'command') continue
    const command = node.data as CommandNode
    if (command.name === null || !ENGINE_COMMANDS.has(command.name)) continue
    // An internal probe (preview or candidate-list fetch) is hidden in every
    // state — pending, succeeded, or errored — so no row flashes in the
    // transcript while the popover shows its result. Probes never contribute
    // to the cut range (nothing was actually rewound).
    if (isPreviewCommand(command) || isCandidateCommand(command)) {
      hidden.add(command.seq)
      continue
    }
    // Only SUCCESSFUL executed rewinds are hidden (their result is noise once
    // the conversation is rewound). A failed executed rewind must stay visible
    // so the user sees the error instead of silently missing the rewind.
    if (command.outcome?.kind !== 'success') continue
    // A success WITHOUT a marker rewound nothing: leave its row visible and
    // do not extend the cut range.
    const marker = command.outcome.sourceEventSeq
    if (marker === undefined) continue
    hidden.add(command.seq)
    const target = targetSeqOfArgs(command.args)
    if (target !== undefined) {
      spans.push({ start: target, end: marker })
    }
  }
  const cuts = coalesceCuts(spans)
  for (const key of snap.order) {
    const node = snap.nodes.get(key)
    if (node === undefined) continue
    if (cutsContain(cuts, node.anchorSeq)) hidden.add(node.anchorSeq)
  }
  try {
    addWithdrawnTurnChrome(snap, cuts, hidden)
  } catch {
    // A malformed index must not break the hiding that already works.
  }
  hiddenSeqsMemo.set(snap, new Set(hidden))
  return new Set(hidden)
}
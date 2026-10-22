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
import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client';
/**
 * The internal engine channel every client call is sent to. Mirrored by
 * `ENGINE_COMMAND` in `src/index.ts` — the two bundles share no module.
 */
export declare const ENGINE_COMMAND = "rewind-plugin";
/** Engine command names the client recognizes. */
export declare const ENGINE_COMMANDS: ReadonlySet<string>;
/**
 * A chat-snapshot view node as the hiding / composer-refill logic reads it.
 * The harness's view node shape plus the `anchorSeq` the chat snapshot carries
 * (the plugin reads `anchorSeq` off each node; it is not declared on the
 * harness's `ConversationViewNode`).
 */
export interface ChatConversationViewNode {
    readonly key: string;
    readonly kind?: string;
    readonly data?: unknown;
    readonly anchorSeq: number;
    /** Owning Turn as the chat snapshot carries it; its `turn` and `start` are read
     * (see `addWithdrawnTurnChrome`). */
    readonly location?: {
        readonly turn?: {
            readonly turn?: unknown;
            readonly start?: unknown;
        };
    };
}
/** Minimal chat snapshot reader the hiding logic needs. */
export interface HiddenChat {
    readonly order: readonly string[];
    readonly nodes: {
        get(key: string): ChatConversationViewNode | undefined;
    };
    /** Turn-keyed node index; absent on older snapshots, which the chrome pass tolerates. */
    readonly locations?: {
        getTurn(turn: number): readonly string[];
    };
}
/**
 * Reader for one session's live chat snapshot: the chat is served by the
 * `uiConversation` service's named "chat" view.
 */
export type ChatOf = (session: {
    readonly sessionId: string;
} | undefined) => HiddenChat | undefined;
/**
 * Subscribe to one session's live chat-update signal, for waiting on a chat
 * snapshot change without polling.
 */
export type ChatWatch = (sessionId: string, cb: () => void) => () => void;
/**
 * Choose the chat-update subscription: the `uiConversation` "chat" view's own
 * `subscribe`. Extracted as a pure channel-selection step so the resolver is
 * unit-testable. Never throws.
 */
export declare function resolveChatWatch(resolveView: (sessionId: string) => {
    subscribe?(cb: () => void): () => void;
} | undefined, sessionId: string, cb: () => void): () => void;
/**
 * Resolve the chat snapshot from the `uiConversation` "chat" view. The view's
 * `getSnapshot()` returns undefined until the named view is registered, which
 * degrades to `undefined` (no targets, no hiding — never a crash).
 */
export declare function chatSnapshotOf(chatView: {
    getSnapshot(): unknown;
} | undefined): HiddenChat | undefined;
/**
 * The plain text of the human message at `seq` in the chat snapshot, for
 * filling the composer after a withdraw. Accepts BOTH `user` and `steering`
 * nodes: a plan-mode (`/plan <text>`) input is delivered through the agent
 * inbox next-step and claimed, so it renders as `steering`, and its text must
 * still return to the composer. State absent → undefined; a message with no
 * text blocks → ''. Same text-blocks join the candidate side uses.
 */
export declare function messageTextAt(chat: HiddenChat | undefined, seq: number): string | undefined;
/**
 * Extract the rewind target seq from a command's structured `args`
 * (e.g. `@5 chat`, `preview @5 both`). Locale-independent — never parses the
 * host's human outcome copy.
 */
export declare function targetSeqOfArgs(args: string | null | undefined): number | undefined;
/**
 * True when one of this plugin's engine command nodes is an EXECUTED rewind for
 * `seq` — the admission form the popover drives (`@<seq> chat` / `both`) that
 * settled with a marker-carrying success outcome. The composer refill waits for
 * exactly this node after the user confirms, so a history-loaded command can
 * never trigger a fill.
 */
export declare function isExecutedRewindCommand(node: CommandNode, seq: number): boolean;
/**
 * Whether a preview outcome reports tracked file changes — the availability
 * of the "rewind conversation and code" option.
 *
 * Reads ONLY the machine-readable `impact=<n>` trailer the host appends to
 * preview text. Older host output without the trailer is treated as having no
 * changes (never guesses from human copy). Absent text (undefined) degrades to
 * always-show so a working option is never hidden on a failed probe.
 */
export declare function hasFileImpact(text: string | undefined): boolean;
/** Whether the preview reports that new file checkpoints are disabled. */
export declare function hasBackupDisabled(text: string | undefined): boolean;
/**
 * The preview's host-stashed plan id (the `plan=<id>` machine token), used to
 * arm the TOCTOU re-check on the subsequent both execution. Absent on hosts
 * without the hardening.
 */
export declare function planIdOfPreviewText(text: string | undefined): string | undefined;
/**
 * True when an engine command node is the internal candidate-list probe
 * (`__candidates`). Like previews, its flow node never surfaces in the
 * transcript — it only feeds the picker — so it is hidden in every state.
 */
export declare function isCandidateCommand(command: CommandNode): boolean;
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
export declare function hiddenSeqsOf(snap: HiddenChat): Set<number>;
//# sourceMappingURL=hidden.d.ts.map
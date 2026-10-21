import React from 'react';
import type { ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client';
export declare const name = "dsh-session-manager-client";
export declare const inject: readonly ["slots", "workspaces", "sessions", "configForms"];
interface ObservableSnapshot<T> {
    getSnapshot(): T;
    subscribe?(listener: () => void): () => void;
}
interface SessionSummary {
    id: string;
    title?: string;
    displayTitle?: string;
    cwd?: string;
}
interface SessionListState {
    ids: string[];
    byId: Record<string, SessionSummary>;
    current?: string;
}
interface WorkspaceListState {
    items: readonly Record<string, unknown>[];
}
interface DshSlotReg {
    inject: (key: string, factory: () => unknown) => () => void;
    register: (opts: Record<string, unknown>, comp: (props: Record<string, unknown>) => React.ReactElement) => () => void;
}
interface DshWorkspaces {
    readonly list: ObservableSnapshot<WorkspaceListState>;
    archiveSession(sessionId: string): Promise<void>;
    connectWorkspace(workspaceId: string): Promise<string>;
}
/** 0.1.2：Session.getSnapshot() 只有 queue/running 等控制字段，没有消息节点；
 *  消息上下文必须读 uiConversation 的 chat 视图（其 legacy 切片含 flat nodes + turnEnds）。 */
interface SessionFace {
    prompt(parts: unknown[], mode: 'queue' | 'steer', signal?: AbortSignal): Promise<unknown>;
}
interface DshSessions {
    readonly list: ObservableSnapshot<SessionListState>;
    binding(id: string): {
        session: SessionFace;
    } | undefined;
    fork(opts: {
        sessionId: string;
        atSeq?: number;
        increaseTitle?: boolean;
    }): Promise<string>;
    open(id: string): void;
}
interface ConversationNode {
    kind: string;
    seq: number;
    messageId?: string;
    turn?: number;
    content?: unknown[];
}
interface ChatLegacySliceView {
    turnEnds?: ReadonlyMap<number, number>;
    nodes?: readonly ConversationNode[];
}
interface ChatViewNode {
    key?: string;
    id?: string;
    kind?: string;
    anchorSeq?: number;
    visibility?: string;
    location?: {
        kind?: string;
        turn?: {
            turn?: number;
        };
    };
    data?: {
        seq?: number;
        content?: unknown[];
        finalNode?: {
            messageId?: string;
            id?: string;
        };
        status?: string;
    } | null;
}
interface ChatNodeStoreView {
    values(): readonly ChatViewNode[];
}
interface ChatSnapshotView {
    order?: readonly string[];
    nodes?: ChatNodeStoreView;
    legacy?: ChatLegacySliceView;
}
/** 0.1.2 ConversationSnapshot：入口是 views store，chat 只是其中一个 target。 */
interface ConversationSnapshot {
    views?: {
        get(target: string): ChatSnapshotView | undefined;
    };
}
interface ChatSource {
    getSnapshot(): ChatSnapshotView | undefined;
    subscribe(listener: () => void): () => void;
}
interface ConversationStore {
    snapshot: ObservableSnapshot<ConversationSnapshot>;
    target(target: string): ChatSource;
}
interface DshUiConversation {
    binding(sessionId: string): ConversationStore | undefined;
}
/**
 * Client 侧连接句柄（RPC 调用面）。
 * 仅列出本插件使用的业务成员；设置控制器类型使用公开的 ConfigForm 契约。
 */
interface ClientContext {
    slots: DshSlotReg;
    workspaces: DshWorkspaces;
    sessions: DshSessions;
    configForms: Pick<ConfigForms, 'get'>;
    get(name: 'uiConversation'): DshUiConversation | undefined;
    on?: (name: 'dispose', callback: () => void) => void;
}
/** 上下文解析器：安装早于宿主服务启动时，一次性捕获会拿到 undefined，必须按需取。 */
type Resolver<T> = () => T | undefined;
export declare function apply(ctx: ClientContext): void;
interface UserRefreshTarget {
    key: string;
    turn: number;
    content: unknown[];
    previousTurnEnd: number | undefined;
    /** 该回合是否仍在生成回复（生成中禁止再刷新）。 */
    generating: boolean;
    /** 同回合所有助手节点的 seat key：点击刷新瞬间降暗+占位，避免 fork 期间的“卡住”观感。 */
    assistantKeys: string[];
}
declare function computeUserRefreshTargets(chat: ChatSnapshotView | undefined): Map<string, UserRefreshTarget>;
/** 提交 prompt 前，收集重建会话里已有 assistant 的 messageId 基线。 */
declare function collectBaselineAssistantIds(getUiConversation: Resolver<DshUiConversation>, sessionId: string): Set<string>;
/**
 * 等待"本次新生成"的 assistant 进入终态：仅 `status === 'settled'` 算成功，
 * `status === 'interrupted'` 算失败/被中断。基线之外的 assistant（含 streaming 中
 * 尚未拿到 messageId 的节点）一律视为"新回复"，不再拿历史回复顶包。
 */
declare function waitForNewAssistant(getUiConversation: Resolver<DshUiConversation>, sessionId: string, baselineIds: Set<string>, signal: AbortSignal | undefined, timeoutMs?: number): Promise<void>;
interface RetryContext {
    content: unknown[];
    previousTurnEnd: number | undefined;
    turn: number | undefined;
    assistantStatus: string | undefined;
    /** 被打此消息的助手节点 seat key：点击后立即降暗+占位，消除 fork 期间卡顿观感。 */
    assistantKey: string | undefined;
}
/** 0.1.2 会话快照没有消息节点；上下文从 chat 视图读取。
 *  chat.legacy.turnEnds 与 legacy turn 语义一致（completedTurn → end.seq）。 */
declare function computeRetryContext(chat: ChatSnapshotView | undefined, messageId: string): RetryContext | undefined;
/** assistant 节点的 messageId：优先 finalNode。 */
declare function assistantMessageId(node: ChatViewNode): string | undefined;
export { assistantMessageId, collectBaselineAssistantIds, computeRetryContext, computeUserRefreshTargets, waitForNewAssistant };
//# sourceMappingURL=index.d.ts.map
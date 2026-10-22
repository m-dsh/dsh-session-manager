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
    /** 0.2.x：本地引用计数（mainView>0 即主视图正在展示的会话）。 */
    retainedBy?: Record<string, number>;
}
interface SessionListState {
    ids: string[];
    byId: Record<string, SessionSummary>;
    /** 老版本字段；0.2.1 起移除，改用 byId[id].retainedBy.mainView。 */
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
interface RemoteCommandResult {
    ok: boolean;
    value?: {
        matched?: boolean;
    };
    error?: {
        code?: string;
        message?: string;
    };
}
interface SessionFace {
    prompt(parts: unknown[], mode: 'queue' | 'steer', signal?: AbortSignal): Promise<unknown>;
    /** 执行一条斜杠命令（纯接纳语义；结局以 chat 视图的 CommandNode 落定）。 */
    command(line: string): Promise<RemoteCommandResult>;
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
    /** 会话输入 shell 的作用域键（composer draft 写入需要）。 */
    scope?(id: string): unknown;
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
    /** 按 turn 聚合的节点索引(0.2.x 快照携带;缺席时 chrome 判定容忍降级)。 */
    locations?: {
        getTurn(turn: number): readonly string[];
    };
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
    get(name: 'connection'): unknown;
    get(name: 'conversation'): unknown;
    on?: (name: 'dispose', callback: () => void) => void;
}
export declare function apply(ctx: ClientContext): void;
interface UserRefreshTarget {
    key: string;
    /** 目标 user/message 事件 seq（就地回退的 @seq）。 */
    seq: number;
    turn: number;
    content: unknown[];
    previousTurnEnd: number | undefined;
    /** 该回合是否仍在生成回复（生成中禁止再刷新）。 */
    generating: boolean;
    /** 同回合所有助手节点的 seat key：点击刷新瞬间降暗+占位，避免 fork 期间的“卡住”观感。 */
    assistantKeys: string[];
}
declare function computeUserRefreshTargets(chat: ChatSnapshotView | undefined): Map<string, UserRefreshTarget>;
interface RetryContext {
    content: unknown[];
    /** 所属用户消息的 user/message 事件 seq（就地回退的 @seq）。 */
    userSeq: number | undefined;
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
export { assistantMessageId, computeRetryContext, computeUserRefreshTargets };
//# sourceMappingURL=index.d.ts.map
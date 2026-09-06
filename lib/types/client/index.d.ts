import React from 'react';
export declare const name = "dsh-session-manager-client";
export declare const inject: readonly ["slots", "workspaces", "sessions"];
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
    register: (opts: {
        name: string;
        id: string;
        order?: number;
        label?: string;
        inject?: (sid: string) => Record<string, unknown>;
        locale?: string;
    }, comp: (props: Record<string, unknown>) => React.ReactElement) => () => void;
}
interface DshWorkspaces {
    readonly list: ObservableSnapshot<WorkspaceListState>;
    archiveSession(sessionId: string): Promise<void>;
    connectWorkspace(workspaceId: string): Promise<string>;
}
interface SessionFace extends ObservableSnapshot<ConversationSnapshot> {
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
interface ConversationSnapshot {
    nodes?: readonly ConversationNode[];
    turnEnds?: ReadonlyMap<number, number>;
}
interface ClientContext {
    slots: DshSlotReg;
    workspaces: DshWorkspaces;
    sessions: DshSessions;
    on?: (name: 'dispose', callback: () => void) => void;
}
export declare function apply(ctx: ClientContext): void;
export {};
//# sourceMappingURL=index.d.ts.map
/**
 * 回退读取的 RPC 通道（浏览器半）：影响预览走 Connection RPC，不占命令
 * 通道、不往会话日志追加 command/run 事件（对齐 dsh-rewind v0.18.0）。
 *
 * Ported from SiriLee/dsh-rewind (MIT), src/client/host-rpc.ts（仅 preview
 * 端点；响应额外携带 host 托管的 planId，供 both 执行的 TOCTOU 复核）。
 *
 * @module dsh-session-manager/client/host-rpc
 */
/** 回退将影响的一个文件。 */
export interface PreviewFileImpact {
    readonly path: string;
    readonly action: 'restore' | 'delete';
}
/** 一次影响预览的结局：成功（结构化清单 + planId）/ 失败 / 超时（null）。 */
export type PreviewOutcome = {
    readonly kind: 'success';
    readonly files: readonly PreviewFileImpact[];
    readonly backupOff: boolean;
    readonly planId: string | undefined;
} | {
    readonly kind: 'error';
    readonly text: string;
} | null;
/** RPC 结果信封。 */
type RpcResult = {
    readonly ok: true;
    readonly value: unknown;
} | {
    readonly ok: false;
    readonly error: {
        readonly code: string;
        readonly message: string;
    };
};
/** 本模块读取的 client connection 服务切面。 */
export interface ConnectionLike {
    readonly rpc: {
        call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult>;
    };
}
/** 经 RPC 解析一个目标的影响清单（含 planId）。 */
export declare function previewOverRpc(connection: ConnectionLike | undefined, sessionId: string, seq: number): Promise<PreviewOutcome>;
export {};
//# sourceMappingURL=host-rpc.d.ts.map
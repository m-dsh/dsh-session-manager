/**
 * 回退读取的 RPC 通道（浏览器半）：影响预览走 Connection RPC，不占命令
 * 通道、不往会话日志追加 command/run 事件（对齐 dsh-rewind v0.18.0）。
 *
 * Ported from SiriLee/dsh-rewind (MIT), src/client/host-rpc.ts（仅 preview
 * 端点；响应额外携带 host 托管的 planId，供 both 执行的 TOCTOU 复核）。
 *
 * @module dsh-session-manager/client/host-rpc
 */

const CHANNEL = 'dsh-session-manager-rewind'
const TIMEOUT_MS = 8000

/** 回退将影响的一个文件。 */
export interface PreviewFileImpact {
  readonly path: string
  readonly action: 'restore' | 'delete'
}

/** 一次影响预览的结局：成功（结构化清单 + planId）/ 失败 / 超时（null）。 */
export type PreviewOutcome =
  | { readonly kind: 'success'; readonly files: readonly PreviewFileImpact[]; readonly backupOff: boolean; readonly planId: string | undefined }
  | { readonly kind: 'error'; readonly text: string }
  | null

/** RPC 结果信封。 */
type RpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** 本模块读取的 client connection 服务切面。 */
export interface ConnectionLike {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isImpact(value: unknown): value is PreviewFileImpact {
  return isRecord(value)
    && typeof value['path'] === 'string'
    && (value['action'] === 'restore' || value['action'] === 'delete')
}

function isAbort(error: unknown): boolean {
  const name = (error as { readonly name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

/** 经 RPC 解析一个目标的影响清单（含 planId）。 */
export async function previewOverRpc(
  connection: ConnectionLike | undefined,
  sessionId: string,
  seq: number,
): Promise<PreviewOutcome> {
  if (connection === undefined) return { kind: 'error', text: 'host RPC 不可用' }
  try {
    const result = await connection.rpc.call(CHANNEL, 'preview', { sessionId, seq }, AbortSignal.timeout(TIMEOUT_MS))
    if (!result.ok) {
      return { kind: 'error', text: result.error.message }
    }
    const value = result.value
    if (!isRecord(value)
      || typeof value['backupOff'] !== 'boolean'
      || !Array.isArray(value['files']) || !value['files'].every(isImpact)
      || (value['planId'] !== undefined && typeof value['planId'] !== 'string')) {
      return { kind: 'error', text: '预览响应无效' }
    }
    return { kind: 'success', files: value['files'], backupOff: value['backupOff'], planId: value['planId'] }
  } catch (error) {
    if (isAbort(error)) return null
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}
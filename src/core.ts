/** dsh-session-manager checkpoint 跨端协议。只包含可序列化的数据。 */

// RPC channel 只能有一个 path segment；endpoint 再承载具体操作。
export const CHECKPOINT_CHANNEL = '/dsh-session-manager'

/** 单个检查点信息 */
export interface CheckpointInfo {
  /** 检查点序号（会话 event seq） */
  seq: number
  /** 所属 turn 编号 */
  turn: number
  /** 用户消息预览（前 80 字符） */
  preview: string
}

/** 列出检查点请求 */
export interface ListCheckpointsRequest {
  sessionId: string
}

export interface ListCheckpointsResponse {
  checkpoints: CheckpointInfo[]
}

/** 回滚对话请求 */
export interface RollbackConversationRequest {
  sessionId: string
  checkpointSeq: number
}

export interface RollbackConversationResponse {
  newSessionId: string
}

/** 回滚预演请求：只读，不写任何文件。 */
export interface PreviewRollbackRequest {
  sessionId: string
  checkpointSeq: number
}

/** 文件要执行的单个撤销操作（Host 在预演时计算好，Client 不能自行上传路径）。 */
export interface RollbackOperation {
  path: string
  /** restore=写回目标内容；delete=删除该文件 */
  action: 'restore' | 'delete'
  /** restore 时目标内容来源：snapshot=检查点快照；head=git HEAD（检查点时未改动、窗口内被改过）。 */
  source: 'snapshot' | 'head'
  /** 预演时读到的当前 sha256（复原：`<sha256>`；文件当时不存在：`absent`）。执行前 Host 会复核。 */
  expectedCurrentSha: string
  /** 写回内容（source=snapshot 时是 base64；source=head 时为空，由 git restore 现场读取）。 */
  targetBase64?: string
}

/** 无法安全恢复的文件（超限 / 符号链接 / 类型不支持），默认阻止文件回滚。 */
export interface UnsupportedFile {
  path: string
  reason: string
}

/** Host 侧保存的完整回滚计划：Client 执行时只提交 planId。 */
export interface RollbackPlan {
  planId: string
  sessionId: string
  checkpointSeq: number
  snapshotSeq?: number
  /** exact=精确找到该 checkpointSeq 的快照；missing=没有，文件回滚应被禁止。 */
  snapshotStatus: 'exact' | 'missing'
  /** 该精确快照是否已成功持久化到磁盘（false 表示重启后会丢，仅本进程可用）。 */
  persisted: boolean
  isGit: boolean
  createdAt: number
  /** 计划涉及文件的当前状态摘要，file<--- 快速判断计划是否过期（仍以逐文件哈希复核为准）。 */
  fingerprint: string
  scoped: boolean
  unknownSnapshots: number
  skipped: string[]
  skippedCount: number
  snapshotFiles: number
  operations: RollbackOperation[]
  unsupported: UnsupportedFile[]
}

/** 回滚预演结果：展示用 + 计划托管在 Host（planId 用于 apply-rollback）。 */
export interface PreviewRollbackResponse {
  planId: string
  /** 将被写回的文件（含 source=snapshot 与 source=head）。 */
  restore: string[]
  /** 将被删除的文件（检查点后新增 / 检查点时已不存在）。 */
  remove: string[]
  /** 因"不是本次对话改动的文件"而跳过的文件（最多 50 条，用于展示）。 */
  skipped: string[]
  skippedCount: number
  /** 是否成功把范围限定为"本次对话动过的文件"。 */
  scoped: boolean
  /** 窗口内缺少归属信息的快照数。 */
  unknownSnapshots: number
  /** 快照里记录的文件总数（诊断用，界面不再展示）。 */
  snapshotFiles: number
  /** exact=精确快照可用；missing=禁止文件回滚。 */
  snapshotStatus: 'exact' | 'missing'
  /** 精确快照是否已持久化（false 时重启后不可用，需提示）。 */
  persisted: boolean
  /** 是否找到了可用的文件快照。 */
  hasSnapshot: boolean
  snapshotSeq?: number
  /** 工作目录是否为 git 仓库。 */
  isGit: boolean
  /** 无法安全恢复的文件；非空时默认阻止文件回滚。 */
  unsupported: UnsupportedFile[]
}

/** 执行回滚：只提交 planId，宿主按预演时存储的计划复核哈希后执行。 */
export interface ApplyRollbackRequest {
  planId: string
}

export interface ApplyRollbackResponse {
  restored: string[]
  removed: string[]
  /** 预演后文件被改动、按安全规则未覆盖的文件列表。 */
  conflicts: string[]
  errors: string[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseListCheckpointsRequest(value: unknown): ListCheckpointsRequest | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string') return undefined
  return { sessionId: value.sessionId }
}

export function parseRollbackConversationRequest(value: unknown): RollbackConversationRequest | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.checkpointSeq !== 'number') return undefined
  if (value.checkpointSeq < 0) return undefined
  return { sessionId: value.sessionId, checkpointSeq: value.checkpointSeq }
}

export function parsePreviewRollbackRequest(value: unknown): PreviewRollbackRequest | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.checkpointSeq !== 'number') return undefined
  if (value.checkpointSeq < 0) return undefined
  return { sessionId: value.sessionId, checkpointSeq: value.checkpointSeq }
}

export function parseApplyRollbackRequest(value: unknown): ApplyRollbackRequest | undefined {
  if (!isRecord(value) || typeof value.planId !== 'string' || value.planId === '') return undefined
  return { planId: value.planId }
}
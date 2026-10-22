/**
 * dsh-session-manager Host 入口。
 *
 * 合并两块能力：
 * - 设置命名空间：sticky prompt / 删除会话开关（Client 侧经 configForms 读写）
 * - 就地回退：/rewind 命令（append-only 表面遮蔽）+ Claude Code 式写前备份
 *   检查点存储
 *
 * 回退机制（移植自 SiriLee/dsh-rewind，MIT）：
 * - 规划纯函数在 src/rewind.ts；执行是往会话日志追加一条 user/message 标记，
 *   其 surfaceOp 把目标消息及其后的全部表面节点替换为自己——只切模型可见
 *   表面，日志 append-only 从不改写。
 * - 文件还原（both 模式）走 src/snapshot.ts 的检查点存储：tools/execute 写前
 *   捕获原字节，tools/post-execute 按回合锚提交；回退到消息 N 时还原所有
 *   锚在 N 及之后的备份，还原对照真实磁盘、以备份为唯一来源。
 *
 * 在 dsh-rewind 基础上的本地加固：preview 记录每路径当前 sha256 并托管
 * planId；both 执行按 planId 复核——预演到执行之间被外部改动的文件跳过
 * 并计入 failed，不覆盖（保留本插件原 fork 方案的 TOCTOU 防护语义）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
// 仅类型导入：拉入 settings 服务的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-settings'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import { REWIND_MARKER_SOURCE } from './marker'
import { preferredLocale, translate, type HostKey, type HostLocaleId } from './locales'
import {
  listRewindCandidates,
  parseRewindTarget,
  planRewind,
  RewindError,
  type RewindMode,
  type RewindPlan,
} from './rewind'
import {
  DEFAULT_MAX_FILE_BYTES,
  MAX_ANCHOR_GROUPS,
  defaultProbe,
  reconcileTracked,
  SnapshotStore,
  UnknownStoreVersionError,
  type DiskProbe,
  type PendingBackup,
  type PruneStaleReport,
  type RestoreOutcome,
  type UncoveredPath,
} from './snapshot'
import {
  AUTO_SWEEP_INTERVAL_MS,
  DEFAULT_CLEANUP_CONFIG,
  parseCleanupCommand,
  resolveCleanupStatePath,
  runAutoCleanupCheck,
  saveLastSweepAt,
  volatileCleanupStore,
  type CleanupConfig,
  type CleanupConfigStore,
  type CleanupConfigWriter,
  type CleanupSettings,
} from './snapshot-cleanup'

export const name = 'dsh-session-manager'
export const inject = ['commands', 'tools', 'settings'] as const

/**
 * 内部引擎通道：client 的回退按钮/浮层都走它，不占用任何人类可注册的
 * 命令名。与 src/client/hidden.ts 的 ENGINE_COMMAND 镜像——两个 bundle
 * 不共享模块。
 */
export const ENGINE_COMMAND = 'rewind-plugin'

// ═══════════════════════════════════════════════════════════
//  Config
// ═══════════════════════════════════════════════════════════

/** 文件检查点开关的默认值（对齐 Claude Code 的 fileCheckpointingEnabled）。 */
export const DEFAULT_FILE_CHECKPOINTING_ENABLED = true

/** 插件配置：默认值必须写在 schema 里，不能写成普通对象。 */
export const Config = Schema.object({
  stickyPromptEnabled: Schema.boolean().default(true).volatile(),
  sessionDeleteEnabled: Schema.boolean().default(true).volatile(),
  fileCheckpointingEnabled: Schema.boolean().default(DEFAULT_FILE_CHECKPOINTING_ENABLED).volatile(),
  autoCleanupEnabled: Schema.boolean().default(DEFAULT_CLEANUP_CONFIG.enabled).volatile(),
  autoCleanupMaxAgeDays: Schema.number().step(1).min(1).default(DEFAULT_CLEANUP_CONFIG.maxAgeDays).volatile(),
  // 快照存储根目录（精确路径；缺省落在 <dsh home>/dsh-session-manager/rewind-snapshots）。
  snapshotDir: Schema.string(),
  // 宿主 home 覆盖（config.dshHome > $DSH_HOME > ~/.dsh）。
  dshHome: Schema.string(),
  dedup: Schema.boolean().default(true),
  maxFileBytes: Schema.number().step(1).min(0).default(DEFAULT_MAX_FILE_BYTES),
  maxAnchorGroups: Schema.number().step(1).min(1).default(MAX_ANCHOR_GROUPS),
  autoSweepIntervalMs: Schema.number().step(1).min(1).default(AUTO_SWEEP_INTERVAL_MS),
})

export type ConfigType = ReturnType<typeof Config>

/** apply 收到的已解析配置的形状（volatile 字段解析为 live 引用）。 */
export interface ResolvedConfig extends CleanupSettings {
  readonly snapshotDir?: string
  readonly dshHome?: string
  readonly dedup?: boolean
  readonly maxFileBytes?: number
  readonly maxAnchorGroups?: number
  readonly autoSweepIntervalMs?: number
  readonly fileCheckpointingEnabled: { get(): boolean }
}

// ═══════════════════════════════════════════════════════════
//  Host 文案（en 为键集真值，zh 全量覆盖）
// ═══════════════════════════════════════════════════════════

/** 命令文案的激活语言；mount 时读一次偏好，每次命令调用前刷新。 */
let activeLocale: HostLocaleId = 'en'

/** dsh-client-locale 持久化偏好的 profile entry 与字段名。 */
const LOCALE_ENTRY = 'locale'
const LOCALE_FIELD = 'preference'

/**
 * 同步读取用户语言偏好：settings 服务的 descriptor 读——与设置 UI、client
 * 的 locale 运行时同一条公共通道。任何失败回落中性默认（en）。
 */
function readHostLocale(ctx: Context): HostLocaleId {
  try {
    const row = ctx.settings
      .describe({ redactSecrets: true })
      .find(entry => entry.ns === LOCALE_ENTRY)
    return preferredLocale((row?.value as Record<string, unknown> | undefined)?.[LOCALE_FIELD])
  } catch {
    return 'en'
  }
}

/** 渲染一条 host 文案（{name} 模板插值）。 */
function t(key: HostKey, params?: Record<string, string | number>): string {
  return translate(activeLocale, key, params)
}

// ═══════════════════════════════════════════════════════════
//  配置键与清理策略存储
// ═══════════════════════════════════════════════════════════

/** Loader 的嵌套 include id 前缀（本 fiber 与其 profile row 之间）。 */
const INCLUDE_ENTRY_PREFIX = 'include:'

/** 本 fiber 的 Loader entry id（裸 apply 时没有）。 */
function rewindConfigKey(ctx: Context): string | undefined {
  return (ctx as { fiber?: { entry?: { id?: string } } }).fiber?.entry?.id
}

/**
 * 设置页以此地址引用本插件配置：bundle 的 PROFILE ROW id（包名），
 * 而不是本 fiber 的嵌套 include id。
 */
export function profileEntryKey(entryId: string | undefined): string | undefined {
  if (entryId === undefined) return undefined
  return entryId.startsWith(INCLUDE_ENTRY_PREFIX) ? entryId.slice(INCLUDE_ENTRY_PREFIX.length) : entryId
}

/** 是否允许记录新的写前备份。缺省配置保持默认（开）。 */
function isFileCheckpointingEnabled(config: ResolvedConfig | undefined): boolean {
  return config?.fileCheckpointingEnabled?.get() !== false
}

/** 清理配置存储（config 或 Loader entry 缺席时 undefined → fail-closed）。 */
let cleanupStore: CleanupConfigStore | undefined

/** 读清理配置；不可用时 fail-closed。 */
async function readCleanupPolicy(): Promise<{ ok: true; config: CleanupConfig } | { ok: false; error: string }> {
  if (cleanupStore === undefined) {
    return { ok: false, error: 'cleanup policy unavailable; snapshot cleanup policy cannot be read' }
  }
  return { ok: true, config: cleanupStore.load() }
}

/** 校验后持久化清理配置。 */
async function writeCleanupPolicy(next: CleanupConfig): Promise<void> {
  if (cleanupStore === undefined) throw new Error('cleanup policy unavailable; snapshot cleanup policy cannot be written')
  await cleanupStore.save(next)
}

// ═══════════════════════════════════════════════════════════
//  写前捕获管道
// ═══════════════════════════════════════════════════════════

/** 追踪的写类工具。 */
const TRACKED_TOOLS = new Set(['write', 'edit'])

/** 子代理会话不追踪（对齐 Claude Code：其编辑无法由父会话回退还原）。 */
function isSubagentSession(session: Session): boolean {
  const header = session.header as { origin?: string; delegationDepth?: number } | undefined
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

/** 从工具调用参数里取被修改文件路径；非追踪工具返回 undefined。 */
function mutationPathOf(exec: ToolExecution): string | undefined {
  const args = exec.arguments as { file_path?: unknown }
  if (exec.name === 'write' || exec.name === 'edit') {
    return typeof args.file_path === 'string' ? args.file_path : undefined
  }
  return undefined
}

/** 一次写前捕获：display path + 暂存原字节（null = 文件当时不存在，即创建）。 */
interface PendingCapture {
  readonly path: string
  readonly backup: PendingBackup | null
}

/** 丢弃一次暂存捕获（幂等；失败不扩散）。 */
async function discardCapture(capture: PendingCapture | undefined): Promise<void> {
  if (capture === undefined || capture.backup === null) return
  try {
    const { rm } = await import('node:fs/promises')
    await rm(capture.backup.file, { force: true })
  } catch {
    // 暂存副本位于 store 自己的 .pending/ 里，prune 会清理过期项。
  }
}

/** fs 错误是否表示「路径不存在」。 */
function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/**
 * tools/execute（around-dispatch 阶段）写前捕获：审批 ask 已在此前短路、
 * 被拒调用不会 dispatch——批准的仍捕获，被拒的绝不留痕。
 */
async function captureBefore(
  fs: FileSystem,
  workingDirectory: WorkingDirectoryService,
  store: SnapshotStore,
  exec: ToolExecution,
  pending: Map<string, PendingCapture>,
): Promise<void> {
  if (!TRACKED_TOOLS.has(exec.name)) return
  const agent = exec.agent
  if (agent === undefined) return
  if (isSubagentSession(agent.session)) return
  const path = mutationPathOf(exec)
  if (path === undefined) return
  const cwd = await workingDirectory.ensure(agent, exec.signal)
  let target: Awaited<ReturnType<FileSystem['resolve']>>
  try {
    target = await fs.resolve(path, { cwd, signal: exec.signal })
  } catch {
    return
  }
  const info = await fs.stat(target, exec.signal).catch((error: unknown) => {
    // 只有明确的「不存在」才记为创建；其他失败放弃捕获——把存在的文件
    // 记成创建会让之后的回退删除它。
    if (isNotFoundError(error)) return undefined
    throw error
  })
  if (info !== undefined && info.type !== 'file') return
  // 尺寸上限：超限不备份、不注册为已跟踪（没有记录就没有可被误还原的历史）。
  if (info !== undefined && store.isOverFileCap(info.size)) return
  const key = `${exec.agent?.id ?? 'anon'}:${exec.callId}`
  if (info === undefined) {
    pending.set(key, { path: target.displayPath, backup: null })
    return
  }
  const staged = await store.stageCapture(agent.session.id, key)
  let backup: PendingBackup
  try {
    const { copyFile, stat } = await import('node:fs/promises')
    await copyFile(target.displayPath, staged)
    const st = await stat(staged)
    const source = await stat(target.displayPath).catch(() => undefined)
    backup = {
      file: staged,
      size: st.size,
      ...(source !== undefined ? { mode: source.mode & 0o7777 } : {}),
    }
  } catch (error) {
    // 服务报告是普通文件但本地复制失败：不是「不存在」——放弃捕获
    //（不能记成创建），不留暂存。
    await discardCapture({ path: target.displayPath, backup: { file: staged, size: 0 } })
    throw error
  }
  pending.set(key, { path: target.displayPath, backup })
}

/** 回合锚（最近 user/message 的 seq）的增量缓存条目。 */
interface AnchorCacheEntry {
  readonly anchor: number | undefined
  readonly eventsLength: number
}

/**
 * 最近 user/message seq —— 本回合的锚。
 * 增量：两次工具结果之间追加的 tool/assistant 事件不动锚，只扫新增事件
 * ——均摊 O(1)。按 Session 对象做 WeakMap 键（会话 id 可能被复用）。
 */
function anchorSeqOf(session: Session, cache: WeakMap<Session, AnchorCacheEntry>): number | undefined {
  const events = session.snapshotEvents()
  const cached = cache.get(session)
  if (cached !== undefined && cached.eventsLength === events.length) return cached.anchor
  let anchor: number | undefined = cached?.anchor
  for (let i = events.length - 1; i >= (cached?.eventsLength ?? 0); i--) {
    if (events[i]!.type === 'user/message') {
      anchor = events[i]!.seq
      break
    }
  }
  cache.set(session, { anchor, eventsLength: events.length })
  return anchor
}

/**
 * tools/post-execute 提交：把暂存字节移入检查点存储。失败调用丢弃；
 * 开关在捕获后翻转的丢弃；无 agent / 无锚的丢弃。
 */
async function commitEntry(
  store: SnapshotStore,
  pending: Map<string, PendingCapture>,
  anchorCache: WeakMap<Session, AnchorCacheEntry>,
  trackedBySession: Map<string, Set<string>>,
  exec: ToolExecution,
  result: { readonly isError: boolean },
  checkpointingEnabled: boolean,
): Promise<void> {
  const key = `${exec.agent?.id ?? 'anon'}:${exec.callId}`
  const capture = pending.get(key)
  if (capture === undefined) return
  pending.delete(key)
  if (!checkpointingEnabled) {
    await discardCapture(capture)
    return
  }
  if (result.isError) {
    await discardCapture(capture)
    return
  }
  const agent = exec.agent
  if (agent === undefined) {
    await discardCapture(capture)
    return
  }
  const anchorSeq = anchorSeqOf(agent.session, anchorCache)
  if (anchorSeq === undefined) {
    await discardCapture(capture)
    return
  }
  try {
    await store.recordBackup(agent.session.id, {
      callId: exec.callId,
      anchorSeq,
      path: capture.path,
    }, capture.backup)
  } catch (error) {
    // 被拒提交（更新版本的 store、IO 失败）让暂存字节无主：丢弃并保持
    // 报错响亮。
    await discardCapture(capture)
    throw error
  }
  let tracked = trackedBySession.get(agent.session.id)
  if (tracked === undefined) {
    tracked = new Set()
    trackedBySession.set(agent.session.id, tracked)
  }
  tracked.add(capture.path)
}

// ═══════════════════════════════════════════════════════════
//  回退标记
// ═══════════════════════════════════════════════════════════

/**
 * 标记内容：恒定的自说明占位。必须非空——日志不可变但服务的模型可能更换，
 * 严格的 OpenAI 兼容网关会拒绝空 user message（HTTP 400）。
 */
const REWIND_MARKER_CONTENT: ContentBlock[] = [{ type: 'text', text: '(empty message)' }]

/** 构建回退标记：带 surface-replace 语义的 user/message。 */
function buildMarker(): UserMessage {
  return createUserMessage({
    content: REWIND_MARKER_CONTENT,
    source: REWIND_MARKER_SOURCE,
  })
}

// ═══════════════════════════════════════════════════════════
//  结果渲染（人读文案 + 机器 token trailer）
// ═══════════════════════════════════════════════════════════

/** 人类可读的字节数（二进制单位）。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${bytes} B`
}

/** 解析 target；失败映射为 RewindError。 */
function resolveOrError(events: readonly SessionEvent[], surface: readonly number[], raw: string): RewindPlan {
  const target = parseRewindTarget(raw)
  if (target === undefined) {
    throw new RewindError('invalid-index', t('error.invalidTarget', { raw }))
  }
  return planRewind(events, surface, target)
}

/** 失败文件的后缀渲染。 */
function renderFailures(failed: readonly { path: string; message: string }[]): string {
  if (failed.length === 0) return ''
  return t('failures.suffix', {
    count: failed.length,
    list: failed.map(f => t('failures.item', { path: f.path, message: f.message })).join(t('sep.list')),
  })
}

/** 因上限被跳过的路径逐条列名（其余跳过仍归 skip.count 汇总）。 */
function renderSkipped(outcome: RestoreOutcome, uncovered: readonly UncoveredPath[], maxFileBytes: number): string {
  const capped = new Set(uncovered.map(item => item.path))
  const limit = formatBytes(maxFileBytes)
  return outcome.skipped
    .filter(path => capped.has(path))
    .map(path => t('plan.skip', { path, reason: t('skipReason.oversized', { limit }) }))
    .join('\n')
}

// ═══════════════════════════════════════════════════════════
//  TOCTOU 复核（本插件在 dsh-rewind 之上的加固）
// ═══════════════════════════════════════════════════════════

/** 一次预演托管的计划：目标 + 每路径预演时刻的磁盘指纹。 */
interface PreviewCacheEntry {
  readonly sessionId: string
  readonly targetSeq: number
  readonly expected: ReadonlyMap<string, string>
  readonly expiresAt: number
}

const PREVIEW_TTL_MS = 10 * 60 * 1000
const previewCache = new Map<string, PreviewCacheEntry>()
const MAX_PREVIEWS = 16

/** 托管一份预演基线，返回 planId。 */
function stashPreview(sessionId: string, targetSeq: number, expected: ReadonlyMap<string, string>): string {
  const planId = randomUUID().replaceAll('-', '').slice(0, 16)
  previewCache.set(planId, { sessionId, targetSeq, expected, expiresAt: Date.now() + PREVIEW_TTL_MS })
  if (previewCache.size > MAX_PREVIEWS) {
    const oldest = [...previewCache.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0]
    for (const [key, entry] of previewCache) {
      if (entry === oldest) {
        previewCache.delete(key)
        break
      }
    }
  }
  return planId
}

/** 消费一份预演基线（一次性；过期或不匹配返回 undefined）。 */
function consumePreview(planId: string | undefined, sessionId: string, targetSeq: number): PreviewCacheEntry | undefined {
  if (planId === undefined) return undefined
  const entry = previewCache.get(planId)
  if (entry === undefined) return undefined
  previewCache.delete(planId)
  if (entry.expiresAt < Date.now() || entry.sessionId !== sessionId || entry.targetSeq !== targetSeq) return undefined
  return entry
}

/**
 * 文件当前的磁盘指纹：sha256 十六进制；不存在为 'absent'；不可读为
 * undefined（无法判定——复核时放行，绝不因读不到而误伤）。
 */
async function diskMarker(path: string): Promise<string | undefined> {
  try {
    const buf = await readFile(path)
    return createHash('sha256').update(buf).digest('hex')
  } catch (error) {
    return isNotFoundError(error) ? 'absent' : undefined
  }
}

/**
 * 包装 DiskProbe：预演清单里的路径若在执行时刻指纹变化（预演→执行窗口
 * 内被外部改动），视为「已一致」排除出动作集并记入 drift——不覆盖。
 * 清单外的路径全部透传（保持 dsh-rewind 的原生重规划行为）。
 */
function verifyProbe(base: DiskProbe, expected: ReadonlyMap<string, string>, drift: { path: string; message: string }[]): DiskProbe {
  return {
    matches: async (source, path) => {
      const want = expected.get(path)
      if (want !== undefined) {
        const now = await diskMarker(path)
        if (now !== undefined && now !== want) {
          drift.push({ path, message: t('conflict.drifted') })
          return true
        }
      }
      return base.matches(source, path)
    },
    copy: (path, dest) => base.copy(path, dest),
    ...(base.size === undefined ? {} : { size: (path: string) => base.size!(path) }),
    isLink: path => base.isLink(path),
  }
}

// ═══════════════════════════════════════════════════════════
//  还原后的 fs 观察同步
// ═══════════════════════════════════════════════════════════

/** 解析 display path 为 fs target；失败返回 undefined（同步静默跳过）。 */
async function resolveObservationTarget(
  fs: FileSystem,
  path: string,
): Promise<Awaited<ReturnType<FileSystem['resolve']>> | undefined> {
  try {
    return await fs.resolve(path)
  } catch {
    return undefined
  }
}

/**
 * both 还原走裸 node:fs，fs 观察策略层看不见。不同步的话，本会话下一次写
 * 还原/删除过的文件会被 stale guard 拒（FS_STALE_VERSION）。在公共
 * fs/observed 事件上发权威观察：删除的记 absent（下次 createIfAbsent），
 * 还原的带新版本（下次 CAS 成功）。只 heal 还原自身造成的不一致——之后
 * 的外部改动仍照常触发 stale 防护。
 */
async function syncRestoreObservations(
  ctx: Context,
  fs: FileSystem | undefined,
  agent: Agent,
  outcome: RestoreOutcome,
): Promise<void> {
  if (fs === undefined) return
  const actor = { agent }
  for (const path of outcome.deleted) {
    const target = await resolveObservationTarget(fs, path)
    if (target === undefined) continue
    ctx.emit('fs/observed', target, { kind: 'absent' }, actor)
  }
  for (const path of outcome.restored) {
    const target = await resolveObservationTarget(fs, path)
    if (target === undefined) continue
    const info = await fs.stat(target).catch(() => undefined)
    if (info === undefined) continue
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, actor)
  }
}

// ═══════════════════════════════════════════════════════════
//  执行回退
// ═══════════════════════════════════════════════════════════

/** 等 agent 空闲（含 maintenance 阶段）；race 15s 超时与 abort。 */
async function waitForAgentIdle(agent: Agent, signal: AbortSignal, timeoutMs = 15_000): Promise<boolean> {
  if (signal.aborted) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('rewind idle wait timed out')), timeoutMs)
        onAbort = () => reject(new Error('rewind idle wait aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    return true
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** 正在执行回退的会话集合（防并发双 append）。 */
type InflightRewinds = Set<string>

/**
 * 回退丢弃所有 pending steering（next-step inbox）插话——它们属于被切掉
 * 的未来；next-turn 队列不动（宿主 QueueDock 有自己的逐条管理）。
 */
function dropPendingSteering(agent: Agent): void {
  for (const message of [...agent.inbox.nextStep]) {
    agent.inbox.remove(message.id)
  }
}

/** 把 RewindError 映射为命令错误结果。 */
function rewindErrorResult(error: unknown): CommandResult {
  if (error instanceof RewindError) {
    const text = {
      'no-user-messages': t('noUserMessages'),
      'invalid-index': error.message,
      'not-a-user-message': error.message,
      'not-on-surface': error.message,
    }[error.code]
    return { kind: 'error', text }
  }
  throw error
}

/** 执行一次已验证的回退：追加标记，可选还原文件。 */
async function executeRewind(
  ctx: Context,
  store: SnapshotStore,
  fs: FileSystem | undefined,
  invocation: CommandInvocation,
  rawTarget: string,
  mode: RewindMode,
  inflight: InflightRewinds,
  checkpointingEnabled: boolean,
  previewPlanId?: string,
): Promise<CommandResult> {
  const { agent } = invocation
  const sessionId = agent.session.id
  // 每会话 in-flight 守卫：两次并发回退（双击、双 tab）都会对同一表面
  // 规划，第二次 append 的 replace 范围会指向已被第一次遮蔽的节点。
  if (inflight.has(sessionId)) {
    return { kind: 'error', text: t('inflight') }
  }
  inflight.add(sessionId)
  try {
    // 生成中的回合必须先停：强制取消（保留 inbox），等收敛后再回退。
    if (agent.status !== 'idle') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      const stopped = await waitForAgentIdle(agent, invocation.signal)
      if (!stopped) {
        return { kind: 'error', text: t('stopFailed') }
      }
    }
    // 回退到它们之前，就不能让 pending steering 活着送到下一轮。
    dropPendingSteering(agent)
    if (invocation.signal.aborted) {
      return { kind: 'error', text: t('cancelled') }
    }
    let plan: RewindPlan
    try {
      plan = resolveOrError(agent.session.snapshotEvents(), agent.session.surface.nodes, rawTarget)
    } catch (error) {
      return rewindErrorResult(error)
    }

    const marker = buildMarker()
    let event: ReturnType<Session['append']>
    try {
      event = agent.session.append('user/message', marker, {
        surfaceOp: { op: 'replace', startSeq: plan.surfaceStart as SessionSeq, endSeq: plan.surfaceEnd as SessionSeq },
        sourceEventSeqs: [...plan.shadowedSeqs] as SessionSeq[],
      })
    } catch (error) {
      return {
        kind: 'error',
        text: t('failed', { error: error instanceof Error ? error.message : String(error) }),
      }
    }

    let restore = ''
    if (mode === 'both') {
      // TOCTOU 复核基线：预演托管的 planId（无预演直执行时无基线——
      // 这就是 dsh-rewind 的原生行为，加固只在「预演→执行」窗口内生效）。
      const preview = consumePreview(previewPlanId, agent.session.id, plan.targetSeq)
      const drift: { path: string; message: string }[] = []
      const probe = preview === undefined ? defaultProbe : verifyProbe(defaultProbe, preview.expected, drift)
      let outcome: RestoreOutcome | undefined
      try {
        outcome = await store.restoreAfter(agent.session.id, plan.targetSeq, path => unlink(path), probe)
      } catch (error) {
        // 更新版本 store 写的快照：文件还原整体 fail-closed（未改动），
        // 而上面的对话回退已成功——两者独立。
        if (!(error instanceof UnknownStoreVersionError)) throw error
        const version = await store.readStoreVersion(agent.session.id)
        restore = `${t('sep.clause')}${t('storeUnsupported', { version: version ?? error.version })}`
      }
      if (outcome !== undefined) {
        // 还原走裸 node:fs，观察策略层看不见：先重同步（见函数注释）。
        await syncRestoreObservations(ctx, fs, agent, outcome)
        const parts: string[] = []
        if (outcome.restored.length > 0) parts.push(t('restore.count', { count: outcome.restored.length }))
        if (outcome.deleted.length > 0) parts.push(t('delete.count', { count: outcome.deleted.length }))
        if (outcome.skipped.length > 0) {
          parts.push(t('skip.count', { count: outcome.skipped.length }))
          // 保守跳过（上限拒绝）必须可见，绝不静默省略。
          const capped = await store.uncoveredPaths(agent.session.id).catch(() => [] as UncoveredPath[])
          const skippedLines = renderSkipped(outcome, capped, store.fileCapBytes)
          if (skippedLines !== '') parts.push(skippedLines)
        }
        if (!checkpointingEnabled) parts.push(t('backupOff'))
        restore = parts.length > 0 ? `${t('sep.clause')}${parts.join(t('sep.list'))}` : t('noRestorable')
        // 复核拒绝的（预演后被外部改动）与还原失败的一并汇报。
        restore += renderFailures([...drift, ...outcome.failed])
      }
      else if (drift.length > 0) {
        restore += renderFailures(drift)
      }
    }

    // 每次回退都撤回目标消息及其后内容；其文本由 client 回填 composer。
    return {
      kind: 'success',
      text: t('success', { targetSeq: plan.targetSeq, restore }),
      sourceEventSeq: event.seq,
    }
  } finally {
    inflight.delete(sessionId)
  }
}

// ═══════════════════════════════════════════════════════════
//  命令处理
// ═══════════════════════════════════════════════════════════

/**
 * 影响预览（RPC 端点内部）：读影响清单 + 每路径基线指纹，托管 planId 并
 * 随响应带回——both 执行按 planId 做 TOCTOU 复核。
 */
async function previewImpactPayload(
  store: SnapshotStore,
  session: Session,
  seq: number,
  checkpointingEnabled: boolean,
): Promise<{ files: { path: string; action: 'restore' | 'delete' }[]; backupOff: boolean; planId: string }> {
  const plan = resolveOrError(session.snapshotEvents(), session.surface.nodes, `@${seq}`)
  const impacts = await store.impactsAfter(session.id, plan.targetSeq)
  // 每路径当前磁盘指纹：both 执行前 TOCTOU 复核的基线。
  const expected = new Map<string, string>()
  for (const impact of impacts) {
    const marker = await diskMarker(impact.path)
    if (marker !== undefined) expected.set(impact.path, marker)
  }
  const planId = stashPreview(session.id, plan.targetSeq, expected)
  return { files: impacts.map(f => ({ path: f.path, action: f.action })), backupOff: !checkpointingEnabled, planId }
}

/** Connection RPC 结果信封。 */
type RewindRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** Host Connection 通用 RPC registry 的 handler 形状。 */
type RewindRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal, peer: unknown) => Promise<RewindRpcResult>

/** 本插件注册的 ctx.connection 切面。 */
interface RewindRpcHost {
  readonly rpc: { handle(channel: string, handler: RewindRpcHandler): () => Promise<void> }
}

/** RPC handler 借助 agents 服务按 id 解析会话的切面。 */
interface AgentLookup {
  get(sessionId: string): { readonly session: Session } | undefined
}

/** 构造一个失败的 RPC 结果。 */
function rpcFailure(code: string, message: string): RewindRpcResult {
  return { ok: false, error: { code, message, details: {} } }
}

/** 影响预览与候选列表的只读 RPC 端点（走 Connection RPC，不产生会话日志事件）。 */
function createRewindRpcHandler(
  store: SnapshotStore,
  agentsOf: () => AgentLookup | undefined,
  checkpointingEnabled: () => boolean,
): RewindRpcHandler {
  return async (endpoint, payload) => {
    try {
      if (!(typeof payload === 'object' && payload !== null && !Array.isArray(payload))) {
        return rpcFailure('dsm-rewind/bad-request', 'invalid payload')
      }
      const sessionId = (payload as Record<string, unknown>)['sessionId']
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return rpcFailure('dsm-rewind/bad-request', 'sessionId must be a non-empty string')
      }
      const agents = agentsOf()
      if (agents === undefined) return rpcFailure('dsm-rewind/agents-unavailable', 'agent registry is unavailable')
      const agent = agents.get(sessionId)
      if (agent === undefined) return rpcFailure('dsm-rewind/session-not-found', `session ${sessionId} is not attached`)
      if (endpoint === 'preview') {
        const seq = (payload as Record<string, unknown>)['seq']
        if (!Number.isSafeInteger(seq)) return rpcFailure('dsm-rewind/bad-request', 'seq must be an integer')
        return { ok: true, value: await previewImpactPayload(store, agent.session, seq as number, checkpointingEnabled()) }
      }
      return rpcFailure('dsm-rewind/unknown-endpoint', `unknown endpoint: ${endpoint}`)
    } catch (error) {
      if (error instanceof RewindError) {
        return rpcFailure('dsm-rewind/rejected', error.message)
      }
      if (error instanceof UnknownStoreVersionError) {
        return rpcFailure('dsm-rewind/store-unsupported', error.message)
      }
      return rpcFailure('dsm-rewind/failed', error instanceof Error ? error.message : String(error))
    }
  }
}

/**
/**
 * /rewind 主文法：
 *   空  → 撤回最近一条用户消息（client 装饰会拦截成候选面板，
 *         这里是无装饰环境的防御路径）
 *   @seq chat|both [planId] → 执行（planId 触发 TOCTOU 复核）
 *
 * 影响预览不在命令通道上：走 Connection RPC（previewImpactPayload），不往
 * 会话日志追加 command/run 事件（对齐 dsh-rewind v0.18.0，#56）。
 */
async function handleRewind(
  ctx: Context,
  store: SnapshotStore,
  fs: FileSystem | undefined,
  invocation: CommandInvocation,
  inflight: InflightRewinds,
  checkpointingEnabled: boolean,
): Promise<CommandResult> {
  const session = invocation.agent.session
  const input = invocation.rawInput.trim()

  if (input === '') {
    const candidates = listRewindCandidates(session.snapshotEvents(), session.surface.nodes, 1)
    if (candidates.length === 0) {
      return { kind: 'error', text: t('noUserMessages') }
    }
    return executeRewind(ctx, store, fs, invocation, `@${candidates[0]!.seq}`, 'chat', inflight, checkpointingEnabled)
  }

  const parts = input.split(/\s+/)
  const target = parts[0]!
  const mode = parts[1]
  const planId = parts[2]
  if (mode !== undefined && mode !== 'chat' && mode !== 'both') {
    return { kind: 'error', text: t('engine.rejected') }
  }
  // 只有目标没有模式：人类两步流程已被 client 接管，engine 通道一律拒绝。
  if (mode === undefined) return { kind: 'error', text: t('engine.rejected') }
  return executeRewind(ctx, store, fs, invocation, target, mode, inflight, checkpointingEnabled, planId)
}

// ═══════════════════════════════════════════════════════════
//  自动清理
// ═══════════════════════════════════════════════════════════

/** 本 mount 是否已跑过一次自动清理检查（每次 apply 重置）。 */
let autoSweepChecked = false

/**
 * 首次会话活动（用户消息或工具结果）时后台跑一次检查；之后本 mount 不再
 * 考虑。last-sweep 时间落盘，节奏跨重启续期。永不 reject。
 */
async function maybeRunAutoCleanup(
  ctx: Context,
  store: SnapshotStore,
  sessionId: string | undefined,
  dshHome: string | undefined,
  sweepIntervalMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (autoSweepChecked || signal?.aborted === true) return
  autoSweepChecked = true
  try {
    await runAutoCleanupCheck({
      pruner: store,
      readConfig: () => readCleanupPolicy(),
      statePath: resolveCleanupStatePath(dshHome),
      log: msg => ctx.logger.warn(msg),
      ...(sweepIntervalMs === undefined ? {} : { intervalMs: sweepIntervalMs }),
      ...(signal === undefined ? {} : { signal }),
    }, sessionId)
  } catch (error) {
    try {
      ctx.logger.warn(`[dsh-session-manager] snapshot auto-cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // context 已释放，logger 没了：无处可报。
    }
  }
}

/** PruneStaleReport 的 run 子命令渲染。 */
function formatCleanupReport(report: PruneStaleReport): string {
  const key: HostKey = report.dryRun ? 'cleanup.runDry' : 'cleanup.runApply'
  const text = t(key, {
    deleted: report.deleted,
    freed: report.freedBytes,
    kept: report.kept,
    remaining: report.remainingBytes,
  })
  return report.skippedActive > 0 ? `${text}\n${t('cleanup.skipped', { skipped: report.skippedActive })}` : text
}

/** ClearSessionReport 渲染。 */
function formatClearReport(report: { entries: number; bytes: number; dryRun: boolean }): string {
  const key: HostKey = report.dryRun ? 'cleanup.clearDry' : 'cleanup.clearApply'
  return t(key, { entries: report.entries, bytes: report.bytes })
}

/** /snapshot-auto-cleanup 文法：status/on/off/max-age/run。 */
async function handleSnapshotCleanup(
  ctx: Context,
  store: SnapshotStore,
  invocation: CommandInvocation,
  dshHome: string | undefined,
  trackedBySession: Map<string, Set<string>>,
): Promise<CommandResult> {
  const parsed = parseCleanupCommand(invocation.rawInput)
  if ('error' in parsed) return { kind: 'error', text: t('cleanup.usage') }
  switch (parsed.action) {
    case 'status': {
      const loaded = await readCleanupPolicy()
      if (!loaded.ok) return { kind: 'error', text: t('cleanup.cfgInvalid', { detail: loaded.error }) }
      return {
        kind: 'success',
        text: t('cleanup.status', {
          state: t(loaded.config.enabled ? 'cleanup.enabled' : 'cleanup.disabled'),
          days: loaded.config.maxAgeDays,
        }),
      }
    }
    case 'on':
    case 'off': {
      const loaded = await readCleanupPolicy()
      const next: CleanupConfig = { ...(loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG), enabled: parsed.action === 'on' }
      try {
        await writeCleanupPolicy(next)
      } catch (error) {
        return { kind: 'error', text: t('cleanup.saveFailed', { detail: error instanceof Error ? error.message : String(error) }) }
      }
      return { kind: 'success', text: t(parsed.action === 'on' ? 'cleanup.onOk' : 'cleanup.offOk') }
    }
    case 'max-age': {
      const loaded = await readCleanupPolicy()
      const next: CleanupConfig = { ...(loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG), maxAgeDays: parsed.value! }
      try {
        await writeCleanupPolicy(next)
      } catch (error) {
        return { kind: 'error', text: t('cleanup.saveFailed', { detail: error instanceof Error ? error.message : String(error) }) }
      }
      return { kind: 'success', text: t('cleanup.maxAgeOk', { days: parsed.value! }) }
    }
    case 'run': {
      const apply = parsed.apply
      // --current 把动作改指当前会话的快照（「现在就清掉本会话」）。
      if (parsed.target === 'current') {
        return handleClearCurrent(ctx, store, invocation, apply, trackedBySession)
      }
      const loaded = await readCleanupPolicy()
      if (!loaded.ok) return { kind: 'error', text: t('cleanup.cfgInvalid', { detail: loaded.error }) }
      try {
        const report = await store.pruneStale({
          keepActiveId: invocation.agent.session.id,
          maxAgeDays: loaded.config.maxAgeDays,
          dryRun: !apply,
        })
        // 真实清扫后重锚 24h 窗口，避免手动清扫后自动清扫立刻再跑。
        if (!report.dryRun) await saveLastSweepAt(resolveCleanupStatePath(dshHome), Date.now())
        return { kind: 'success', text: formatCleanupReport(report) }
      } catch (error) {
        return { kind: 'error', text: t('cleanup.runFailed', { detail: error instanceof Error ? error.message : String(error) }) }
      }
    }
  }
}

/**
 * run --current：清除当前会话的快照。apply 必须等回合停止——运行中的
 * turn 会与并发 recordBackeup 交错出悬空 dedup 链接；停不下来就报错，
 * 绝不让插件损坏。
 */
async function handleClearCurrent(
  ctx: Context,
  store: SnapshotStore,
  invocation: CommandInvocation,
  apply: boolean,
  trackedBySession: Map<string, Set<string>>,
): Promise<CommandResult> {
  const { agent } = invocation
  const sessionId = agent.session.id
  if (apply) {
    if (agent.status !== 'idle') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      const stopped = await waitForAgentIdle(agent, invocation.signal)
      if (!stopped) {
        return { kind: 'error', text: t('cleanup.clearActive', { sessionId }) }
      }
    }
    if (invocation.signal.aborted) {
      return { kind: 'error', text: t('cleanup.clearCancelled') }
    }
  }
  try {
    const report = await store.clearSession(sessionId, { dryRun: !apply })
    // 内存中的已跟踪集合一并丢弃：下一条用户消息边界会重新推导空集合，
    // 而不是重扫每个曾经跟踪过的文件。
    if (!report.dryRun) trackedBySession.delete(sessionId)
    return { kind: 'success', text: formatClearReport(report) }
  } catch (error) {
    return { kind: 'error', text: t('cleanup.clearFailed', { detail: error instanceof Error ? error.message : String(error), sessionId }) }
  }
}

// ═══════════════════════════════════════════════════════════
//  Host apply
// ═══════════════════════════════════════════════════════════

export function apply(ctx: Context, config?: ResolvedConfig): void {
  // 每次 mount 重置模块级 host 状态：一次性清扫门、上一个 mount 的策略
  // 存储都不能跨 live disable → enable 存活。
  autoSweepChecked = false
  cleanupStore = undefined
  activeLocale = readHostLocale(ctx)

  // mount 生命周期：fiber dispose 时中止后台异步工作（live 插件管理器随时
  // 可能卸载插件，异步 listener 不能再写盘或读已释放的服务）。
  const lifecycle = new AbortController()
  ctx.effect(() => () => { lifecycle.abort() })

  const dshHome = config?.dshHome
  const store = new SnapshotStore(config?.snapshotDir, {
    dedup: config?.dedup,
    dshHome,
    maxFileBytes: config?.maxFileBytes,
    maxAnchorGroups: config?.maxAnchorGroups,
  })

  // 清理策略经 config 的 volatile 引用读写，写入走 settings 服务的 entry
  // API（按 PROFILE ROW id 寻址）。无 resolved config 或无 Loader entry
  // 时无处可写，策略保持 fail-closed（读报「不可用」，清扫删不了任何东西）。
  const configKey = profileEntryKey(rewindConfigKey(ctx))
  if (config !== undefined && configKey !== undefined) {
    const writer: CleanupConfigWriter = {
      entryId: configKey,
      update: (id, patch) => ctx.settings.update(id, patch),
      clear: (id, fields) => ctx.settings.mutate(id, fields.map(field => ({ op: 'unset' as const, path: [field] }))),
    }
    cleanupStore = volatileCleanupStore(config, writer)
  }

  // 写前捕获暂存：agent id + callId 为键（callId 唯一，按 agent 分桶让
  // 跨会话碰撞不可能）。fiber dispose 在两次监听之间时，兜底丢弃暂存字节。
  const pending = new Map<string, PendingCapture>()
  ctx.effect(() => () => {
    const captures = [...pending.values()]
    pending.clear()
    return Promise.all(captures.map(capture => discardCapture(capture))).then(() => undefined)
  })

  // 回合锚缓存（按 Session 对象）；每会话 in-flight 守卫；已跟踪路径集合。
  const anchorCache = new WeakMap<Session, AnchorCacheEntry>()
  const inflight: InflightRewinds = new Set()
  const trackedBySession = new Map<string, Set<string>>()
  // fs 服务（动态注入作用域里捕获）；命令路径用它做还原后的观察同步。
  let fsService: FileSystem | undefined

  // ── 命令注册：每个独立 try/catch，一个名字被占只损失那个名字 ──
  const withHostLocale = (
    handler: (invocation: CommandInvocation) => Promise<CommandResult>,
  ): ((invocation: CommandInvocation) => Promise<CommandResult>) =>
    (invocation) => {
      activeLocale = readHostLocale(ctx)
      return handler(invocation)
    }

  const rewindHandler = withHostLocale(
    invocation => handleRewind(ctx, store, fsService, invocation, inflight, isFileCheckpointingEnabled(config)),
  )
  // 引擎通道是机器驱动的：人类触达（菜单选中或完整输入）一律被拒。
  const engineHandler = withHostLocale(
    invocation => invocation.rawInput.trim() === ''
      ? Promise.resolve<CommandResult>({ kind: 'error', text: t('engine.rejected') })
      : handleRewind(ctx, store, fsService, invocation, inflight, isFileCheckpointingEnabled(config)),
  )
  const cleanupHandler = withHostLocale(
    invocation => handleSnapshotCleanup(ctx, store, invocation, dshHome, trackedBySession),
  )

  const disposers: Array<() => void> = []
  const registerCommand = (definition: Record<string, unknown>): void => {
    try {
      const dispose = ctx.commands.register(definition as never)
      disposers.push(dispose)
    } catch (error) {
      ctx.logger.warn(`[dsh-session-manager] command "${String(definition.name)}" was not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  registerCommand({ name: 'rewind', description: t('command.description'), handler: rewindHandler })
  registerCommand({ name: 'undo', description: t('command.undoDescription'), handler: rewindHandler })
  registerCommand({
    name: ENGINE_COMMAND,
    description: t('engine.description'),
    input: { hint: t('engine.inputHint') },
    handler: engineHandler,
  })
  registerCommand({
    name: 'snapshot-auto-cleanup',
    description: t('cleanup.description'),
    input: { hint: t('cleanup.inputHint') },
    handler: cleanupHandler,
  })
  if (disposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0)) dispose()
    })
  }

  // ── 会话格式守卫：DSH 迁移/加载后，快照若锚在不同的会话格式下则
  //    清除（seq 引用会被 v2→v3 迁移错映射）。子代理会话跳过。 ──
  ctx.on('agent/created', (payload: { agent: Agent }): undefined => {
    const session = payload.agent.session
    if (isSubagentSession(session)) return undefined
    void (async () => {
      try {
        if (lifecycle.signal.aborted) return
        // 此后记录的快照都盖当前会话格式戳，未来格式变化可被检测。
        store.setFormatVersion(session.header.version)
        // 先做 store 版本守卫：更新版本写的快照绝不动（ADR-10 fail-closed）。
        try {
          await store.assertKnownStoreVersion(session.id)
        } catch (error) {
          ctx.logger.warn(`[dsh-session-manager] file restore disabled for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        if (lifecycle.signal.aborted) return
        const result = await store.reconcileFormatVersion(session.id, session.header.version)
        if (result.cleared) {
          ctx.logger.warn(`[dsh-session-manager] cleared snapshots for ${session.id}: session format changed (v${session.header.version})`)
        }
      } catch (error) {
        ctx.logger.warn(`[dsh-session-manager] session-format reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    return undefined
  })

  // ── 消息边界重扫（对齐 Claude Code 的 fileHistoryMakeSnapshot）：每条
  //    user/message 落日志时重读该会话所有已跟踪文件，为变更者记
  //    before-backup——外部/手动修改也入档。 ──
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'user/message') return
    if (isSubagentSession(session)) return
    // 回退执行中绝不能开始扫描：marker 自身的 append 会同步触发本
    // listener，而 restoreAfter 正在写这些文件（both 模式）。
    if (inflight.has(session.id)) return
    void (async () => {
      try {
        if (lifecycle.signal.aborted) return
        const sessionId = session.id
        // 懒自动清理：用户消息是一天里最实际的首个触发点，后台跑、fail-closed。
        void maybeRunAutoCleanup(ctx, store, sessionId, dshHome, config?.autoSweepIntervalMs, lifecycle.signal)
        if (!isFileCheckpointingEnabled(config)) return
        let tracked = trackedBySession.get(sessionId)
        if (tracked === undefined) {
          tracked = await store.trackedPaths(sessionId)
          trackedBySession.set(sessionId, tracked)
        }
        if (tracked.size === 0) return
        if (lifecycle.signal.aborted) return
        await reconcileTracked(store, sessionId, event.seq, tracked)
      } catch (error) {
        ctx.logger.warn(`[dsh-session-manager] boundary re-check failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  })

  // ── 只读 RPC 通道：影响预览（含 planId）。`rpc.handle` 内部的 effect
  //    会重读 owner.webServer、丢失插件作用域的 inject 集，所以从 root
  //    context 注册、随本插件释放（对齐 dsh-rewind u10 审计项）。 ──
  ctx.inject(['connection'], (scope) => {
    try {
      const connection = (scope.root as unknown as { readonly connection?: RewindRpcHost }).connection
      if (connection === undefined) return
      const dispose = connection.rpc.handle(
        'dsh-session-manager-rewind',
        createRewindRpcHandler(
          store,
          () => scope.get('agents') as AgentLookup | undefined,
          () => isFileCheckpointingEnabled(config),
        ),
      )
      scope.effect(() => dispose, 'dsh-session-manager rewind RPC channel')
    } catch (error) {
      ctx.logger.warn(`[dsh-session-manager] RPC channel registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // ── 检查点管道：需要 fs + workingDirectory（动态注入；缺席的部署
  //    不备份，both 报「无可还原变更」）。 ──
  ctx.inject(['fs', 'workingDirectory'], (scope) => {
    const fs = scope.fs as FileSystem
    const workingDirectory = scope.workingDirectory as WorkingDirectoryService
    fsService = fs
    // 作用域随任一服务释放：丢引用，命令路径绝不把已释放的实例交给观察同步。
    scope.effect(() => () => { fsService = undefined })

    scope.on('tools/execute', async (exec: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
      try {
        if (isFileCheckpointingEnabled(config)) {
          await captureBefore(fs, workingDirectory, store, exec, pending)
        }
      } catch (error) {
        ctx.logger.warn(`[dsh-session-manager] before-capture failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })

    scope.on('tools/post-execute', async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
      try {
        // 工具结果是无用户消息时的兜底清扫触发点；子代理会话跳过（它不
        // 拥有快照，占着活动会话豁免反而让父会话失去豁免）。
        const session = exec.agent?.session
        if (session !== undefined && !isSubagentSession(session)) {
          void maybeRunAutoCleanup(ctx, store, session.id, dshHome, config?.autoSweepIntervalMs, lifecycle.signal)
        }
        await commitEntry(store, pending, anchorCache, trackedBySession, exec, result, isFileCheckpointingEnabled(config))
      } catch (error) {
        ctx.logger.warn(`[dsh-session-manager] checkpoint commit failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })

    scope.on('tools/result', (exec: ToolExecution): undefined => {
      // execute 瀑布里其他 wrapper 抛错会跳过 post-execute：这里兜底丢弃
      // 暂存捕获（幂等；被 commit 消费过则为 no-op）。
      const key = `${exec.agent?.id ?? 'anon'}:${exec.callId}`
      const capture = pending.get(key)
      pending.delete(key)
      void discardCapture(capture)
      return undefined
    })
  })
}
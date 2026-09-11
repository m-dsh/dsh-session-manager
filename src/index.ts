/**
 * dsh-session-manager Host 入口。
 *
 * 合并两块能力：
 * - 设置命名空间：Web 设置面板的 sticky prompt / 删除会话开关（Client 侧读写）
 * - checkpoint 回滚：会话回滚（sessionController.fork）+ 文件回滚（经校验的执行计划）
 *
 * 文件回滚安全模型：
 * - preview-rollback 只读计算完整执行计划（planId 托管在 Host，含每个文件的期望哈希/存在性）
 * - apply-rollback 只接受 planId，逐文件复核哈希后执行；Client 不得上传任意路径
 * - 删除全局 git restore；git 场景只对 Host 计算出的单路径执行 restore
 * - 精确快照缺失 => 禁止文件回滚
 */

import { homedir } from 'node:os'
import { join, resolve, dirname, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  unlink,
  readdir,
  mkdir,
  readFile,
  writeFile,
  lstat,
  realpath,
  readlink,
  rename,
  chmod,
} from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import {
  CHECKPOINT_CHANNEL,
  parseApplyRollbackRequest,
  parseListCheckpointsRequest,
  parsePreviewRollbackRequest,
  parseRollbackConversationRequest,
  type CheckpointInfo,
  type PreviewRollbackResponse,
  type RollbackOperation,
  type RollbackPlan,
  type UnsupportedFile,
} from './core'

export const name = 'dsh-session-manager'
// RPC 路由必须等 connection 服务完成后再安装；否则重启时可能因服务尚未出现而永久跳过注册。
// settings 供 Client 的设置面板读写开关，缺失时只影响开关，不影响回滚。
export const inject = ['connection', 'settings'] as const

/** 设置命名空间：Client 用 settingsScope.bind({ namespace: 'session-manager' }) 读写。 */
const SESSION_MANAGER_NS = settingsNamespace('session-manager')

/** 设置 schema：默认开启；默认值必须写在 schema 里，不能写成普通对象。 */
export const Config = Schema.object({
  stickyPromptEnabled: Schema.boolean().default(true),
  sessionDeleteEnabled: Schema.boolean().default(true),
})

export type ConfigType = ReturnType<typeof Config>

interface DshSessions {
  // parentSession：fork 时宿主写进子会话 header 的祖先链字段（持久化，重启后仍在）。
  get(id: string): { id: string; header?: { cwd?: string; parentSession?: string } } | undefined
}

/** 0.1.2 的会话控制器：fork 改为对象参数，返回 { sessionId }。 */
interface DshSessionController {
  fork(request: { sessionId: string; atSeq?: number; increaseTitle?: boolean }): Promise<{ sessionId: string }>
}

interface DshShell {
  /** dsh-shell 契约字段是 `workdir`（不是 cwd）；`stdoutMaxBytes` 保证大输出不截断。 */
  run(spec: { command: string; workdir?: string; timeoutMs?: number; stdoutMaxBytes?: number }): Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

interface HostConnectionHandle {
  rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>,
      opts?: { authority?: string },
    ): void
  }
}

/** Host settings 服务：注册设置命名空间，Web 设置面板据此读写开关。 */
interface HostSettings {
  register(namespace: unknown, schema: unknown, opts?: { applies?: string }): void
}

interface HostContext extends Context {
  get(name: 'connection'): HostConnectionHandle | undefined
  get(name: 'sessions'): DshSessions | undefined
  get(name: 'sessionController'): DshSessionController | undefined
  get(name: 'shell'): DshShell | undefined
}

// ═══════════════════════════════════════════════════════════
//  文件快照数据库模型
// ═══════════════════════════════════════════════════════════

/** 单文件大小上限（base64 后约 400K 字符），超过则显式声明 unsupported 而不是静默丢弃。 */
const SNAPSHOT_FILE_LIMIT = 300_000

/** 检查点文件快照：显式记录每个候选路径在检查点时刻的状态。 */
interface CheckpointFiles {
  changed: string[]
  untracked: string[]
  mode: 'git' | 'filesystem'
  /** 检查点时刻存在、且成功捕获内容的普通文件（base64 内容）。 */
  contents: Record<string, string>
  /** 检查点时刻已不存在（例如 git 里已删除的跟踪文件）；旧快照没有该字段。 */
  missing?: string[]
  /** 检查点时刻为符号链接（不捕获内容、不跟随写入）；旧快照没有该字段。 */
  symlinks?: string[]
  /** 超过大小上限、内容未捕获；旧快照没有该字段。 */
  oversized?: { path: string; size: number }[]
  /** 本回合（上一次检查点之后）被工具调用触碰过的文件，回滚时用于限定范围。旧快照没有该字段 => 归属未知。 */
  touched?: string[]
  /** 是否已成功持久化到磁盘（false = 重启后丢失，仅当前进程可用）。 */
  persisted?: boolean
}

/** 检查点文件快照存储（内存缓存；磁盘持久化用于插件/DSH 重启后仍可回滚） */
const checkpointStore = new Map<string, Map<number, CheckpointFiles>>()
const MAX_SNAPSHOTS_PER_SESSION = 20
let totalMemorySnapshots = 0
const MAX_TOTAL_MEMORY_SNAPSHOTS = 2000

const KEEP_SNAPSHOTS = MAX_SNAPSHOTS_PER_SESSION

// ═══════════════════════════════════════════════════════════
//  文件归属：记录"本次对话动过哪些文件"（启发式，仅作辅助范围限制）
// ═══════════════════════════════════════════════════════════

/** 每个会话在"上一次检查点之后"被工具触碰过的文件；回合结束时写进快照并清空。 */
const pendingTouched = new Map<string, Set<string>>()
const MAX_TOUCHED_PATHS = 4000

/** 只认这些动词的操作数，避免 ls/grep/find 里的路径被误当成"改动过"。 */
const MUTATING_SHELL_COMMANDS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'touch', 'mkdir', 'truncate', 'tee', 'ln', 'install', 'sed', 'gzip', 'gunzip',
])

/** 工具参数里可能承载文件路径的键。 */
const TOOL_PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'target_path', 'target', 'paths', 'files']

/** 规整成"工作区相对 POSIX 路径"；工作区之外或可疑值返回 undefined。 */
function normalizeTouchedPath(candidate: unknown, cwd?: string): string | undefined {
  if (typeof candidate !== 'string') return undefined
  let value = candidate.trim().replace(/^['"]+/, '').replace(/['"]+$/, '').replace(/\\/g, '/')
  if (!value || value.startsWith('-') || value.includes('$') || value.includes('*')) return undefined
  if (value.startsWith('/')) {
    if (!cwd) return undefined
    const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!value.startsWith(`${root}/`)) return undefined
    value = value.slice(root.length + 1)
  }
  value = value.replace(/^\.\//, '')
  if (!value || value.startsWith('..')) return undefined
  if (value.startsWith('.git/') || value.includes('/node_modules/')) return undefined
  return value
}

/** 从 shell 命令里提取会被写入/删除的路径（保守：只认写删动词与重定向目标）。 */
function touchedPathsFromCommand(command: string, cwd?: string): string[] {
  const found: string[] = []
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const tokens = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
      token.replace(/^['"]|['"]$/g, ''),
    )
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] ?? ''
      // 重定向目标：> path、>> path、2> path，以及紧贴写法 >path
      const bareRedirect = token.replace(/^\d*>>?/, '')
      if (bareRedirect !== token) {
        const inline = normalizeTouchedPath(bareRedirect, cwd)
        if (inline) found.push(inline)
        else {
          const next = normalizeTouchedPath(tokens[index + 1], cwd)
          if (next) found.push(next)
        }
        continue
      }
      if (!MUTATING_SHELL_COMMANDS.has(token)) continue
      for (const operand of tokens.slice(index + 1)) {
        if (operand.startsWith('-')) continue
        const target = normalizeTouchedPath(operand, cwd)
        if (target) found.push(target)
      }
    }
  }
  return found
}

/** 只读工具：它们也带 file_path/path 参数，但不能算"改动过"。 */
const READ_ONLY_TOOLS = new Set([
  'read', 'read_image', 'view', 'open', 'cat', 'head', 'tail', 'stat', 'ls', 'list', 'tree',
  'glob', 'grep', 'find', 'search', 'describe_image',
])

/** 记一次工具调用触碰的文件（arguments 可能是 JSON 字符串或已解析对象）。 */
function recordToolCall(sessionId: string, toolName: string, rawArguments: unknown, cwd?: string): void {
  if (READ_ONLY_TOOLS.has(toolName)) return
  const touched: string[] = []
  let args: unknown = rawArguments
  if (typeof rawArguments === 'string') {
    try {
      args = JSON.parse(rawArguments) as unknown
    } catch {
      // 不是 JSON：可能是 bash 的命令行原文
      touched.push(...touchedPathsFromCommand(rawArguments, cwd))
      args = undefined
    }
  }
  if (isRecord(args)) {
    for (const key of TOOL_PATH_KEYS) {
      const value = args[key]
      if (typeof value === 'string') {
        const path = normalizeTouchedPath(value, cwd)
        if (path) touched.push(path)
      } else if (Array.isArray(value)) {
        for (const item of value) {
          const path = normalizeTouchedPath(item, cwd)
          if (path) touched.push(path)
        }
      }
    }
    if (typeof args.command === 'string') touched.push(...touchedPathsFromCommand(args.command, cwd))
  }
  if (touched.length === 0) return

  let bucket = pendingTouched.get(sessionId)
  if (!bucket) {
    bucket = new Set<string>()
    pendingTouched.set(sessionId, bucket)
  }
  for (const path of touched) {
    if (bucket.size >= MAX_TOUCHED_PATHS) break
    bucket.add(path)
  }
}

// ═══════════════════════════════════════════════════════════
//  快照磁盘持久化：~/.dsh/dsh-session-manager/<会话id>/<seq>.json
// ═══════════════════════════════════════════════════════════

/** 会话 id 只保留 [A-Za-z0-9_-]，防止路径拼进意外字符。 */
function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

function snapshotRoot(): string {
  return join(homedir(), '.dsh', 'dsh-session-manager')
}

function isCheckpointFiles(value: unknown): value is CheckpointFiles {
  if (!isRecord(value) || !Array.isArray(value.changed) || !Array.isArray(value.untracked)) return false
  if (value.mode !== 'git' && value.mode !== 'filesystem') return false
  return typeof value.contents === 'object' && value.contents !== null
}

/** 原子写：先写 .tmp 再 rename，避免中途退出留下半截 JSON；权限收紧到 0600 / 0700。 */
async function persistSnapshot(sessionId: string, seq: number, snapshot: CheckpointFiles): Promise<void> {
  const dir = join(snapshotRoot(), sanitizeId(sessionId))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `${seq}.json.tmp`)
  const final = join(dir, `${seq}.json`)
  await writeFile(tmp, JSON.stringify({ version: 1, sessionId, seq, ...snapshot }), { mode: 0o600 })
  await rename(tmp, final)
  try {
    await chmod(dir, 0o700)
  } catch {
    // 权限收紧失败不影响快照本身。
  }

  // 每个 session 目录只保留最近 KEEP_SNAPSHOTS 份，旧快照顺带清理。
  try {
    const names = await readdir(dir)
    const seqFiles = names
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number(name.slice(0, -5)))
      .sort((a, b) => b - a)
    for (const stale of seqFiles.slice(KEEP_SNAPSHOTS)) {
      try {
        await unlink(join(dir, `${stale}.json`))
      } catch {
        // 单个清理失败不影响快照本身。
      }
    }
  } catch {
    // 目录列举失败不影响快照本身。
  }
}

async function loadSnapshot(sessionId: string, seq: number): Promise<CheckpointFiles | undefined> {
  try {
    const raw = await readFile(join(snapshotRoot(), sanitizeId(sessionId), `${seq}.json`), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isCheckpointFiles(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

// ═══════════════════════════════════════════════════════════
//  fork 祖先链：记录 child <- parent 及分叉边界 seq，避免分支污染
// ═══════════════════════════════════════════════════════════

interface LineageEntry {
  parent: string
  parentSeq: number
}

async function readLineageMap(): Promise<Record<string, LineageEntry>> {
  try {
    const raw = await readFile(join(snapshotRoot(), 'lineage.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as Record<string, LineageEntry>) : {}
  } catch {
    return {}
  }
}

async function recordLineage(child: string, parent: string, parentSeq: number): Promise<void> {
  const map = await readLineageMap()
  map[child] = { parent, parentSeq }
  const dir = snapshotRoot()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, 'lineage.json.tmp')
  const final = join(dir, 'lineage.json')
  await writeFile(tmp, JSON.stringify(map), { mode: 0o600 })
  await rename(tmp, final)
}

interface LineageNode {
  id: string
  /** 该节点对子分支可见的最大 seq（=它 fork 出下一跳时的边界 seq）；根节点为 +∞。 */
  maxSeq: number
}

/**
 * 祖先链：child(∞) → parent(child 的 fork 边界) → …
 * 用 header.parentSession 兜底；parentSeq 只有持久化的 lineage.json 才有。
 * 没有 parentSeq 的祖先（旧数据），其"之后"窗口不可信——精确 seq 查找仍可用，窗口扫描跳过。
 */
async function sessionLineage(sessions: DshSessions | undefined, sessionId: string): Promise<LineageNode[]> {
  const chain: LineageNode[] = []
  const seen = new Set<string>()
  const persisted = await readLineageMap()
  let id: string | undefined = sessionId
  let maxSeq = Number.POSITIVE_INFINITY
  while (id && chain.length < 10 && !seen.has(id)) {
    seen.add(id)
    chain.push({ id, maxSeq })
    const entry: LineageEntry | undefined = persisted[id]
    const header = sessions?.get(id)?.header as { cwd?: string; parentSession?: string } | undefined
    const parent: string | undefined = entry?.parent ?? header?.parentSession
    // 只有在 lineage.json 里记过分叉边界，才知道父分支对子分支的可见上限；
    // 不知道边界（旧数据）则窗口不可信，用 NaN 标记（精确 seq 查找仍可用）。
    maxSeq = entry?.parentSeq !== undefined ? entry.parentSeq : Number.NaN
    id = parent
  }
  return chain
}

// ═══════════════════════════════════════════════════════════
//  宿主 apply + RPC
// ═══════════════════════════════════════════════════════════

export function apply(ctx: HostContext): void {
  const hostSettings = (ctx as unknown as { settings?: HostSettings }).settings
  try {
    hostSettings?.register(SESSION_MANAGER_NS, Config, { applies: 'live' })
  } catch (err) {
    console.warn(`[dsh-session-manager] 注册设置命名空间失败：${toErrorMessage(err)}`)
  }

  const connection = ctx.get('connection')
  const sessions = ctx.get('sessions')
  const shell = ctx.get('shell')

  // 订阅 assistant/message 的 tool-call：归属收集（本回合触碰过的文件）。
  const events = ctx as unknown as {
    on?: (name: 'session/event', listener: (session: unknown, event: unknown) => void) => void
  }
  events.on?.('session/event', (session: unknown, event: unknown) => {
    if (!isRecord(event) || event.type !== 'assistant/message') return
    if (!isRecord(session) || typeof session.id !== 'string') return
    const data = isRecord(event.data) ? event.data : undefined
    const message = data && isRecord(data.message) ? data.message : undefined
    const content = message && Array.isArray(message.content) ? message.content : undefined
    if (!content) return
    const header = isRecord(session.header) ? session.header : undefined
    const cwd = header && typeof header.cwd === 'string' ? header.cwd : undefined
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool-call') continue
      const toolName = typeof block.name === 'string' ? block.name : ''
      recordToolCall(session.id, toolName, block.arguments, cwd)
    }
  })

  // connection 服务不可用时静默跳过，不阻塞 DSH 启动
  if (!connection) return

  connection.rpc.handle(
    CHECKPOINT_CHANNEL,
    async (endpoint, payload) => {
      // ── list-checkpoints ──
      if (endpoint === 'list-checkpoints') {
        const req = parseListCheckpointsRequest(payload)
        if (!req) return failure('无效的检查点列表请求')
        return success({ checkpoints: getCheckpoints(req.sessionId) })
      }

      // ── save-checkpoint ──
      if (endpoint === 'save-checkpoint') {
        if (!isRecord(payload) || typeof payload.sessionId !== 'string') return failure('无效请求')
        const { sessionId, seq } = payload as { sessionId: string; seq: number }
        if (typeof seq !== 'number') return failure('无效的 seq')
        await saveCheckpoint(sessionId, seq, shell, sessions?.get(sessionId)?.header?.cwd)
        return success({ saved: true })
      }

      // ── rollback-conversation ──
      if (endpoint === 'rollback-conversation') {
        const req = parseRollbackConversationRequest(payload)
        if (!req) return failure('无效的回滚对话请求')
        const controller = ctx.get('sessionController')
        if (!controller) return failure('会话控制器服务不可用')
        try {
          // increaseTitle：让 fork 出来的新会话标题带序号后缀，避免列表出现完全同名的记录。
          const forked = await controller.fork({ sessionId: req.sessionId, atSeq: req.checkpointSeq, increaseTitle: true })
          // 记录 fork 边界：子分支回滚"复制进来的旧消息"时，只能看到父分支 <= parentSeq 的快照。
          await recordLineage(forked.sessionId, req.sessionId, req.checkpointSeq).catch(() => undefined)
          return success({ newSessionId: forked.sessionId })
        } catch (err) {
          return failure(`回滚对话失败：${toErrorMessage(err)}`)
        }
      }

      // ── preview-rollback ──（只读：计算并托管执行计划）
      if (endpoint === 'preview-rollback') {
        const req = parsePreviewRollbackRequest(payload)
        if (!req) return failure('无效的回滚预演请求')
        const previewSession = sessions?.get(req.sessionId)
        if (!previewSession) return failure('会话不存在')
        try {
          const preview = await previewRollback(sessions, req.sessionId, req.checkpointSeq, shell, previewSession.header?.cwd)
          return success(preview)
        } catch (err) {
          return failure(`回滚预演失败：${toErrorMessage(err)}`)
        }
      }

      // ── apply-rollback ──（Client 只提交 planId；Host 复核哈希后执行）
      if (endpoint === 'apply-rollback') {
        const req = parseApplyRollbackRequest(payload)
        if (!req) return failure('无效的回滚执行请求')
        const planSession = planStore.get(req.planId)?.plan?.sessionId
        const cwd = planSession ? sessions?.get(planSession)?.header?.cwd : undefined
        try {
          const result = await applyRollback(req.planId, shell, cwd)
          return success(result)
        } catch (err) {
          return failure(`回滚文件失败：${toErrorMessage(err)}`)
        }
      }

      return failure(`未知操作：${String(endpoint)}`)
    },
    { authority: 'trusted-host' },
  )

  // 每个回合结束时自动截取工作区文件快照。
  const listen = (ctx as { on?: (name: string, listener: (...args: unknown[]) => void) => void }).on
  listen?.('session/event', (...args: unknown[]) => {
    const session = args[0] as { id?: string; header?: { cwd?: string } } | undefined
    const event = args[1] as { type?: string; seq?: number } | undefined
    if (session?.id === undefined || event?.type !== 'turn/end' || typeof event.seq !== 'number') return
    if (!shell) return
    void saveCheckpoint(session.id, event.seq, shell, session.header?.cwd).catch((error) => {
      console.warn(`[dsh-session-manager] 保存检查点快照失败：${toErrorMessage(error)}`)
    })
  })
}

// ═══════════════════════════════════════════════════════════
//  Checkpoint 管理
// ═══════════════════════════════════════════════════════════

function getCheckpoints(sessionId: string): CheckpointInfo[] {
  const sessionFiles = checkpointStore.get(sessionId)
  if (!sessionFiles) return []
  const result: CheckpointInfo[] = []
  for (const [seq, snapshot] of sessionFiles) {
    const meta = snapshot.changed.find((f) => f.startsWith('__meta__:'))
    let turn = 0
    let preview = ''
    if (meta) {
      try {
        const parsed = JSON.parse(meta.slice('__meta__:'.length))
        turn = Number(parsed.turn ?? 0)
        preview = String(parsed.preview ?? '').slice(0, 80)
      } catch { /* ignore */ }
    }
    result.push({ seq, turn, preview })
  }
  result.sort((a, b) => b.seq - a.seq)
  return result
}

/** single-flight：同一 sessionId+seq 的保存只跑一次，避免并发的 turn/end 重复扫描工作区。 */
const checkpointJobs = new Map<string, Promise<void>>()

async function saveCheckpoint(
  sessionId: string,
  seq: number,
  shell: DshShell | undefined,
  cwd?: string,
): Promise<void> {
  const key = `${sessionId}:${seq}`
  const running = checkpointJobs.get(key)
  if (running) return running
  const job = (async () => {
    let sessionFiles = checkpointStore.get(sessionId)
    if (!sessionFiles) {
      sessionFiles = new Map()
      checkpointStore.set(sessionId, sessionFiles)
    }
    if (sessionFiles.has(seq)) return

    const isGit = await isGitRepository(shell, cwd)
    const changed = isGit ? await getChangedFiles(shell, cwd) : []
    const untracked = isGit ? await getUntrackedFiles(shell, cwd) : await getWorkspaceFiles(cwd)
    // 显式记录每个候选路径的状态（内容 / missing / 符号链接 / 超限），不再静默丢文件。
    const captured = await captureWorkspaceState(cwd, Array.from(new Set([...changed, ...untracked])))
    const touched = Array.from(pendingTouched.get(sessionId) ?? [])
    pendingTouched.delete(sessionId)
    const snapshot: CheckpointFiles = {
      changed,
      untracked,
      mode: isGit ? 'git' : 'filesystem',
      contents: captured.contents,
      missing: captured.missing,
      symlinks: captured.symlinks,
      oversized: captured.oversized,
      touched,
      persisted: true,
    }
    sessionFiles.set(seq, snapshot)
    totalMemorySnapshots += 1
    evictMemorySnapshots(sessionFiles)

    try {
      await persistSnapshot(sessionId, seq, snapshot)
    } catch (err) {
      snapshot.persisted = false
      console.warn(`[dsh-session-manager] 快照持久化失败 seq=${seq}：${toErrorMessage(err)}`)
    }
  })()
  checkpointJobs.set(key, job)
  try {
    await job
  } finally {
    checkpointJobs.delete(key)
  }
}

/** 内存快照淘汰：单会话最多 KEEP_SNAPSHOTS 份；全局也给个总上限。 */
function evictMemorySnapshots(sessionFiles: Map<number, CheckpointFiles>): void {
  while (sessionFiles.size > MAX_SNAPSHOTS_PER_SESSION) {
    let lowest = Number.POSITIVE_INFINITY
    for (const seq of sessionFiles.keys()) if (seq < lowest) lowest = seq
    sessionFiles.delete(lowest)
    totalMemorySnapshots -= 1
  }
  if (totalMemorySnapshots > MAX_TOTAL_MEMORY_SNAPSHOTS) {
    // 全局过量：从最早插入的会话开始逐条淘汰最老的 seq。
    for (const [sid, files] of checkpointStore) {
      while (files.size > 0 && totalMemorySnapshots > MAX_TOTAL_MEMORY_SNAPSHOTS) {
        let lowest = Number.POSITIVE_INFINITY
        for (const seq of files.keys()) if (seq < lowest) lowest = seq
        files.delete(lowest)
        totalMemorySnapshots -= 1
        pendingTouched.delete(sid)
      }
      if (totalMemorySnapshots <= MAX_TOTAL_MEMORY_SNAPSHOTS) break
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  git 探测与文件枚举（-z 按 NUL 解析，兼容含换行的路径）
// ═══════════════════════════════════════════════════════════

async function isGitRepository(shell: DshShell | undefined, cwd?: string): Promise<boolean> {
  if (!shell || !cwd) return false
  try {
    const result = await shell.run({
      command: 'git rev-parse --is-inside-work-tree 2>/dev/null',
      workdir: cwd,
      timeoutMs: 3000,
    })
    return result.exitCode === 0 && result.stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function getChangedFiles(shell: DshShell | undefined, cwd?: string): Promise<string[]> {
  if (!shell) return []
  try {
    const result = await shell.run({
      command: 'git diff --name-only -z --diff-filter=AMDR HEAD 2>/dev/null; git ls-files --deleted -z 2>/dev/null',
      workdir: cwd,
      timeoutMs: 5000,
      stdoutMaxBytes: 2_000_000,
    })
    if (result.exitCode !== 0) return []
    return Array.from(new Set(result.stdout.split('\0').filter(Boolean)))
  } catch {
    return []
  }
}

async function getUntrackedFiles(shell: DshShell | undefined, cwd?: string): Promise<string[]> {
  if (!shell) return []
  try {
    const result = await shell.run({
      command: 'git ls-files --others --exclude-standard -z',
      workdir: cwd,
      timeoutMs: 5000,
      stdoutMaxBytes: 2_000_000,
    })
    if (result.exitCode !== 0) return []
    return result.stdout.split('\0').filter(Boolean)
  } catch {
    return []
  }
}

// ═══════════════════════════════════════════════════════════
//  工作区遍历与文件状态捕获
// ═══════════════════════════════════════════════════════════

/** 目录遍历时跳过的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build'])

/** 递归列出 cwd 下所有常规文件（相对路径，`/` 分隔），与 find -type f 语义一致（不含符号链接）。 */
async function walkWorkspaceFiles(cwd: string, dir = ''): Promise<string[]> {
  const entries = await readdir(resolve(cwd, dir), { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...(await walkWorkspaceFiles(cwd, rel)))
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

/** target 必须位于 root 之内（拒绝 `..` 越界路径）。 */
function isWithin(root: string, target: string): boolean {
  const base = resolve(root)
  const path = resolve(target)
  return path.startsWith(base + sep)
}

async function getWorkspaceFiles(cwd?: string): Promise<string[]> {
  if (!cwd) return []
  try {
    return await walkWorkspaceFiles(cwd)
  } catch {
    return []
  }
}

interface CaptureResult {
  contents: Record<string, string>
  missing: string[]
  symlinks: string[]
  oversized: { path: string; size: number }[]
}

/** 显式捕获每个候选路径在检查点时刻的状态；读不到/超限/符号链接都单独归类。 */
async function captureWorkspaceState(cwd: string | undefined, files: string[]): Promise<CaptureResult> {
  const result: CaptureResult = { contents: {}, missing: [], symlinks: [], oversized: [] }
  if (!cwd) return result
  for (const file of new Set(files)) {
    const full = resolve(cwd, file)
    if (!isWithin(cwd, full)) continue
    try {
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        result.symlinks.push(file)
        continue
      }
      if (info.isDirectory()) continue // 目录不参与内容快照
      if (!info.isFile()) {
        result.missing.push(file) // 特殊文件类型不可恢复
        continue
      }
      if (info.size > SNAPSHOT_FILE_LIMIT) {
        result.oversized.push({ path: file, size: info.size })
        continue
      }
      const buf = await readFile(full)
      if (buf.length > SNAPSHOT_FILE_LIMIT) {
        result.oversized.push({ path: file, size: buf.length })
        continue
      }
      result.contents[file] = buf.toString('base64')
    } catch {
      result.missing.push(file) // 读取失败 / 检查点时刻已不存在
    }
  }
  return result
}

// ═══════════════════════════════════════════════════════════
//  快照解析与回滚计划
// ═══════════════════════════════════════════════════════════

/** 精确快照：只在祖先链上找 seq 完全等于 checkpointSeq 的那一份，不做"更早快照"回退。 */
async function resolveExactSnapshot(
  sessions: DshSessions | undefined,
  sessionId: string,
  checkpointSeq: number,
): Promise<{ snapshot?: CheckpointFiles; snapshotSeq?: number }> {
  const chain = await sessionLineage(sessions, sessionId)
  // 等待仍在截取中的边界快照（single-flight 保存），避免预演读到旧的或空的结果。
  for (const { id } of chain) {
    const pending = checkpointJobs.get(`${id}:${checkpointSeq}`)
    if (pending) {
      try {
        await pending
      } catch {
        // 保存失败不阻断预演：照样落回 missing / 旧快照。
      }
    }
  }
  for (const { id } of chain) {
    const memory = checkpointStore.get(id)?.get(checkpointSeq)
    if (memory) return { snapshot: memory, snapshotSeq: checkpointSeq }
    const disk = await loadSnapshot(id, checkpointSeq)
    if (disk) return { snapshot: disk, snapshotSeq: checkpointSeq }
  }
  return {}
}

/**
 * 窗口快照（checkpointSeq 之后）：本会话 + 祖先链，但祖先只取 <= 其 fork 边界的 seq，
 * 避免父分支 fork 之后的快照污染子分支的归属判断与"检查点后新增"判断。
 */
async function snapshotsAfter(
  sessions: DshSessions | undefined,
  sessionId: string,
  checkpointSeq: number,
): Promise<CheckpointFiles[]> {
  const result: CheckpointFiles[] = []
  const seen = new Set<string>()
  for (const { id, maxSeq } of await sessionLineage(sessions, sessionId)) {
    // 祖先节点必须知道分叉边界（maxSeq 有限）才纳入窗口；未知边界的旧祖先跳过，避免分支污染。
    if (id !== sessionId && !Number.isFinite(maxSeq)) continue
    for (const [seq, snapshot] of checkpointStore.get(id) ?? []) {
      if (seq <= checkpointSeq || seq > maxSeq || seen.has(`${id}:${seq}`)) continue
      seen.add(`${id}:${seq}`)
      result.push(snapshot)
    }
    try {
      const dir = join(snapshotRoot(), sanitizeId(id))
      for (const name of await readdir(dir)) {
        if (!/^\d+\.json$/.test(name)) continue
        const seq = Number(name.slice(0, -5))
        if (seq <= checkpointSeq || seq > maxSeq || seen.has(`${id}:${seq}`)) continue
        seen.add(`${id}:${seq}`)
        const snapshot = await loadSnapshot(id, seq)
        if (snapshot) result.push(snapshot)
      }
    } catch {
      // 目录不存在：只看内存。
    }
  }
  return result
}

/** 检查点之后新增的候选文件：更晚的快照里出现过、但本检查点快照没有。 */
async function findCreatedAfter(
  sessions: DshSessions | undefined,
  sessionId: string,
  checkpointSeq: number,
  snapshot: CheckpointFiles,
): Promise<string[]> {
  const checkpointFiles = new Set([...snapshot.untracked, ...(snapshot.missing ?? [])])
  const laterFiles = new Set<string>()
  for (const later of await snapshotsAfter(sessions, sessionId, checkpointSeq)) {
    for (const file of later.untracked) laterFiles.add(file)
  }
  return Array.from(laterFiles).filter((file) => !checkpointFiles.has(file))
}

async function existingFiles(cwd: string | undefined, candidates: string[]): Promise<string[]> {
  const present: string[] = []
  for (const file of candidates) {
    if (!cwd) break
    const full = resolve(cwd, file)
    if (!isWithin(cwd, full)) continue
    try {
      await lstat(full)
      present.push(file)
    } catch {
      // 已经不存在，无需撤销。
    }
  }
  return present
}

interface FileState {
  state: 'present' | 'absent'
  /** present 时的内容标识：<sha256> / symlink:<target> / kind:<dir|other>。 */
  marker?: string
}

async function currentFileState(cwd: string | undefined, file: string): Promise<FileState> {
  if (!cwd) return { state: 'absent' }
  const full = resolve(cwd, file)
  if (!isWithin(cwd, full)) return { state: 'absent' }
  try {
    const info = await lstat(full)
    if (info.isSymbolicLink()) return { state: 'present', marker: `symlink:${await readlink(full)}` }
    if (info.isDirectory()) return { state: 'present', marker: 'kind:dir' }
    if (!info.isFile()) return { state: 'present', marker: 'kind:other' }
    const buf = await readFile(full)
    return { state: 'present', marker: sha256(buf) }
  } catch {
    return { state: 'absent' }
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 目标路径不能经符号链接逃出工作区：逐级 realpath 最深存在祖先，确认仍在 cwd 内。 */
async function realWithin(cwd: string, full: string): Promise<boolean> {
  try {
    const rootReal = await realpath(cwd)
    let probe = dirname(full)
    for (let depth = 0; depth < 40; depth += 1) {
      try {
        const real = await realpath(probe)
        return real === rootReal || real.startsWith(rootReal + sep)
      } catch {
        const parent = dirname(probe)
        if (parent === probe) return false
        probe = parent
      }
    }
    return false
  } catch {
    return false
  }
}

// ═══════════════════════════════════════════════════════════
//  预演：生成计划 + 托管
// ═══════════════════════════════════════════════════════════

/** Host 侧计划托管：planId → 计划（限时、一次性）。 */
const planStore = new Map<string, { plan: RollbackPlan; expiresAt: number }>()
const PLAN_TTL_MS = 10 * 60 * 1000
const MAX_PLANS = 200

function stashPlan(plan: RollbackPlan): void {
  planStore.set(plan.planId, { plan, expiresAt: Date.now() + PLAN_TTL_MS })
  if (planStore.size > MAX_PLANS) {
    const oldest = [...planStore.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
    if (oldest) planStore.delete(oldest[0])
  }
}

/** 非本次对话改动的文件（可能很多）：只保留前 50 条用于展示 + 一个总数。 */
function addSkipped(skipped: string[], file: string): number {
  if (skipped.length < 50) skipped.push(file)
  return 1
}

async function previewRollback(
  sessions: DshSessions | undefined,
  sessionId: string,
  checkpointSeq: number,
  shell: DshShell | undefined,
  cwd?: string,
): Promise<PreviewRollbackResponse> {
  const isGit = await isGitRepository(shell, cwd)
  const exact = await resolveExactSnapshot(sessions, sessionId, checkpointSeq)
  const snapshot = exact.snapshot
  const snapshotSeq = exact.snapshotSeq
  const persisted = snapshot?.persisted !== false

  // 无精确快照：直接返回 missing，禁止文件回滚（不静默 fallback）。
  if (!snapshot) {
    return {
      planId: '', restore: [], remove: [], skipped: [], skippedCount: 0,
      scoped: false, unknownSnapshots: 0, snapshotFiles: 0,
      snapshotStatus: 'missing', persisted: false, hasSnapshot: false, snapshotSeq: undefined,
      isGit, unsupported: [],
    }
  }

  // 归属：窗口内（检查点之后）各快照记录的"工具调用碰过的文件"。
  const scopeSnapshots = await snapshotsAfter(sessions, sessionId, checkpointSeq)
  const scopedFiles = new Set<string>()
  let unknownSnapshots = 0
  for (const item of scopeSnapshots) {
    if (item.touched === undefined) unknownSnapshots += 1
    else for (const file of item.touched) scopedFiles.add(file)
  }
  const scoped = scopeSnapshots.length > 0 && unknownSnapshots === 0

  const ops: RollbackOperation[] = []
  const restoreList: string[] = []
  const removeList: string[] = []
  const skipped: string[] = []
  let skippedCount = 0
  const unsupported: UnsupportedFile[] = []

  // 1) 检查点 contents：应恢复为这些内容。内容一致跳过；缺失一律恢复；内容被改且非本次对话 → 跳过。
  for (const file of Object.keys(snapshot.contents)) {
    const encoded = snapshot.contents[file]
    if (encoded === undefined) continue
    const target = Buffer.from(encoded, 'base64')
    const cur = await currentFileState(cwd, file)
    if (cur.state === 'present' && cur.marker === sha256(target)) continue
    if (cur.state === 'present') {
      if (scoped && !scopedFiles.has(file)) {
        skippedCount += addSkipped(skipped, file)
        continue
      }
    }
    ops.push({
      path: file, action: 'restore', source: 'snapshot',
      expectedCurrentSha: cur.state === 'present' ? cur.marker ?? '' : 'absent',
      targetBase64: encoded,
    })
    restoreList.push(file)
  }

  // 2) 检查点 missing：应不存在 → 现在还存在的删除。
  for (const file of snapshot.missing ?? []) {
    const cur = await currentFileState(cwd, file)
    if (cur.state === 'absent') continue
    if (scoped && !scopedFiles.has(file)) {
      skippedCount += 1
      if (skipped.length < 50) skipped.push(file)
      continue
    }
    ops.push({ path: file, action: 'delete', source: 'snapshot', expectedCurrentSha: cur.marker ?? '' })
    removeList.push(file)
  }

  // 3) 检查点后新增（旧快照启示）：后续快照里出现过、但本检查点没有、现在还存在的文件。
  const createdAfter = await findCreatedAfter(sessions, sessionId, checkpointSeq, snapshot)
  for (const file of await existingFiles(cwd, createdAfter)) {
    const cur = await currentFileState(cwd, file)
    if (cur.state === 'absent') continue
    if (scoped && !scopedFiles.has(file)) {
      skippedCount += 1
      if (skipped.length < 50) skipped.push(file)
      continue
    }
    ops.push({ path: file, action: 'delete', source: 'snapshot', expectedCurrentSha: cur.marker ?? '' })
    removeList.push(file)
  }

  // 4) git：窗口内被触碰、检查点时未改（==HEAD）、现在 != HEAD 的跟踪文件 → 单路径 git restore HEAD。
  if (isGit) {
    const windowChanged = new Set<string>()
    for (const item of scopeSnapshots) for (const file of item.changed) windowChanged.add(file)
    for (const file of scopedFiles) {
      if (!windowChanged.has(file)) continue
      if (snapshot.contents[file] !== undefined) continue
      if ((snapshot.missing ?? []).includes(file)) continue
      const cur = await currentFileState(cwd, file)
      if (cur.state === 'absent') continue
      ops.push({ path: file, action: 'restore', source: 'head', expectedCurrentSha: cur.marker ?? '' })
      restoreList.push(file)
    }
  }

  // 5) 无法安全恢复的文件：符号链接 / 超限。
  for (const file of snapshot.symlinks ?? []) {
    unsupported.push({ path: file, reason: '符号链接，不跟随写入' })
  }
  for (const item of snapshot.oversized ?? []) {
    unsupported.push({ path: item.path, reason: `超过快照大小限制（${item.size} 字节）` })
  }

  const fingerprint = sha256(Buffer.from(
    ops.map((op) => `${op.path}:${op.action}:${op.expectedCurrentSha}`).sort().join('\n'),
    'utf8',
  ))

  const plan: RollbackPlan = {
    planId: randomUUID(),
    sessionId,
    checkpointSeq,
    snapshotSeq,
    snapshotStatus: 'exact',
    persisted,
    isGit,
    createdAt: Date.now(),
    fingerprint,
    scoped,
    unknownSnapshots,
    skipped,
    skippedCount,
    snapshotFiles: Object.keys(snapshot.contents).length,
    operations: ops,
    unsupported,
  }
  stashPlan(plan)

  return {
    planId: plan.planId,
    restore: restoreList,
    remove: removeList,
    skipped,
    skippedCount,
    scoped,
    unknownSnapshots,
    snapshotFiles: Object.keys(snapshot.contents).length,
    snapshotStatus: 'exact',
    persisted,
    hasSnapshot: true,
    snapshotSeq,
    isGit,
    unsupported,
  }
}

// ═══════════════════════════════════════════════════════════
//  执行：按计划复核哈希后应用
// ═══════════════════════════════════════════════════════════

async function applyRollback(
  planId: string,
  shell: DshShell | undefined,
  cwd: string | undefined,
): Promise<{ restored: string[]; removed: string[]; conflicts: string[]; errors: string[] }> {
  const restored: string[] = []
  const removed: string[] = []
  const conflicts: string[] = []
  const errors: string[] = []

  const entry = planStore.get(planId)
  if (!entry || entry.expiresAt < Date.now()) {
    errors.push('回滚计划不存在或已过期，请重新打开对话框生成计划')
    return { restored, removed, conflicts, errors }
  }
  planStore.delete(planId) // 一次性
  const plan = entry.plan

  for (const op of plan.operations) {
    const full = cwd ? resolve(cwd, op.path) : undefined
    if (!cwd || !full || !isWithin(cwd, full)) {
      conflicts.push(`${op.path}：路径越界，未执行`)
      continue
    }
    // 符号链接逃逸防护：目标路径不得经符号链接指向工作区外。
    if (!(await realWithin(cwd, full))) {
      conflicts.push(`${op.path}：路径经由符号链接指向工作区外，未执行`)
      continue
    }

    // 预检：逐文件哈希/存在性复核。预演后被改动 => 不覆盖，记冲突。
    const cur = await currentFileState(cwd, op.path)
    if (op.expectedCurrentSha === 'absent') {
      if (cur.state !== 'absent') {
        conflicts.push(`${op.path}：预演后文件出现，未覆盖`)
        continue
      }
    } else if (cur.state === 'absent' || cur.marker !== op.expectedCurrentSha) {
      conflicts.push(`${op.path}：预演后被改动，未覆盖`)
      continue
    }

    try {
      if (op.action === 'restore') {
        if (op.source === 'snapshot') {
          if (op.targetBase64 === undefined) throw new Error('计划缺少目标内容')
          await mkdir(dirname(full), { recursive: true })
          await writeFile(full, Buffer.from(op.targetBase64, 'base64'))
          restored.push(op.path)
        } else {
          // git HEAD：单路径，Host 计算并确认过的路径才允许。
          if (!shell) throw new Error('Shell 服务不可用')
          const r = await shell.run({
            command: `git restore --source=HEAD --worktree --staged -- ${shellQuote(op.path)} 2>&1`,
            workdir: cwd,
            timeoutMs: 10000,
          })
          if (r.exitCode !== 0) throw new Error(r.stderr || 'git restore 失败')
          restored.push(op.path)
        }
      } else {
        // 删除：复核过哈希，目标确实是检查点时不存在 / 由本次对话新增。
        const info = await lstat(full)
        if (info.isSymbolicLink()) {
          conflicts.push(`${op.path}：符号链接，未删除`)
          continue
        }
        await unlink(full)
        removed.push(op.path)
      }
    } catch (err) {
      errors.push(`${op.path}: ${toErrorMessage(err)}`)
    }
  }

  return { restored, removed, conflicts, errors }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// ═══════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function success<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function failure(message: string): { ok: false; error: { code: 'bad-request'; message: string; details: { issues: never[] } } } {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
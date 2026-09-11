import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, unlink, writeFile } from "node:fs/promises";
import Schema from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

//#region src/core.ts
/** dsh-session-manager checkpoint 跨端协议。只包含可序列化的数据。 */
const CHECKPOINT_CHANNEL = "/dsh-session-manager";
function isRecord$1(value) {
	return typeof value === "object" && value !== null;
}
function parseListCheckpointsRequest(value) {
	if (!isRecord$1(value) || typeof value.sessionId !== "string") return void 0;
	return { sessionId: value.sessionId };
}
function parseRollbackConversationRequest(value) {
	if (!isRecord$1(value) || typeof value.sessionId !== "string" || typeof value.checkpointSeq !== "number") return void 0;
	if (value.checkpointSeq < 0) return void 0;
	return {
		sessionId: value.sessionId,
		checkpointSeq: value.checkpointSeq
	};
}
function parsePreviewRollbackRequest(value) {
	if (!isRecord$1(value) || typeof value.sessionId !== "string" || typeof value.checkpointSeq !== "number") return void 0;
	if (value.checkpointSeq < 0) return void 0;
	return {
		sessionId: value.sessionId,
		checkpointSeq: value.checkpointSeq
	};
}
function parseApplyRollbackRequest(value) {
	if (!isRecord$1(value) || typeof value.planId !== "string" || value.planId === "") return void 0;
	return { planId: value.planId };
}

//#endregion
//#region src/index.ts
const name = "dsh-session-manager";
const inject = ["connection", "settings"];
/** 设置命名空间：Client 用 settingsScope.bind({ namespace: 'session-manager' }) 读写。 */
const SESSION_MANAGER_NS = settingsNamespace("session-manager");
/** 设置 schema：默认开启；默认值必须写在 schema 里，不能写成普通对象。 */
const Config = Schema.object({
	stickyPromptEnabled: Schema.boolean().default(true),
	sessionDeleteEnabled: Schema.boolean().default(true)
});
/** 单文件大小上限（base64 后约 400K 字符），超过则显式声明 unsupported 而不是静默丢弃。 */
const SNAPSHOT_FILE_LIMIT = 3e5;
/** 检查点文件快照存储（内存缓存；磁盘持久化用于插件/DSH 重启后仍可回滚） */
const checkpointStore = /* @__PURE__ */ new Map();
const MAX_SNAPSHOTS_PER_SESSION = 20;
let totalMemorySnapshots = 0;
const MAX_TOTAL_MEMORY_SNAPSHOTS = 2e3;
const KEEP_SNAPSHOTS = MAX_SNAPSHOTS_PER_SESSION;
/** 每个会话在"上一次检查点之后"被工具触碰过的文件；回合结束时写进快照并清空。 */
const pendingTouched = /* @__PURE__ */ new Map();
const MAX_TOUCHED_PATHS = 4e3;
/** 只认这些动词的操作数，避免 ls/grep/find 里的路径被误当成"改动过"。 */
const MUTATING_SHELL_COMMANDS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"touch",
	"mkdir",
	"truncate",
	"tee",
	"ln",
	"install",
	"sed",
	"gzip",
	"gunzip"
]);
/** 工具参数里可能承载文件路径的键。 */
const TOOL_PATH_KEYS = [
	"file_path",
	"filePath",
	"path",
	"notebook_path",
	"target_path",
	"target",
	"paths",
	"files"
];
/** 规整成"工作区相对 POSIX 路径"；工作区之外或可疑值返回 undefined。 */
function normalizeTouchedPath(candidate, cwd) {
	if (typeof candidate !== "string") return void 0;
	let value = candidate.trim().replace(/^['"]+/, "").replace(/['"]+$/, "").replace(/\\/g, "/");
	if (!value || value.startsWith("-") || value.includes("$") || value.includes("*")) return void 0;
	if (value.startsWith("/")) {
		if (!cwd) return void 0;
		const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
		if (!value.startsWith(`${root}/`)) return void 0;
		value = value.slice(root.length + 1);
	}
	value = value.replace(/^\.\//, "");
	if (!value || value.startsWith("..")) return void 0;
	if (value.startsWith(".git/") || value.includes("/node_modules/")) return void 0;
	return value;
}
/** 从 shell 命令里提取会被写入/删除的路径（保守：只认写删动词与重定向目标）。 */
function touchedPathsFromCommand(command, cwd) {
	const found = [];
	for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
		const tokens = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^['"]|['"]$/g, ""));
		for (let index = 0; index < tokens.length; index += 1) {
			const token = tokens[index] ?? "";
			const bareRedirect = token.replace(/^\d*>>?/, "");
			if (bareRedirect !== token) {
				const inline = normalizeTouchedPath(bareRedirect, cwd);
				if (inline) found.push(inline);
				else {
					const next = normalizeTouchedPath(tokens[index + 1], cwd);
					if (next) found.push(next);
				}
				continue;
			}
			if (!MUTATING_SHELL_COMMANDS.has(token)) continue;
			for (const operand of tokens.slice(index + 1)) {
				if (operand.startsWith("-")) continue;
				const target = normalizeTouchedPath(operand, cwd);
				if (target) found.push(target);
			}
		}
	}
	return found;
}
/** 只读工具：它们也带 file_path/path 参数，但不能算"改动过"。 */
const READ_ONLY_TOOLS = new Set([
	"read",
	"read_image",
	"view",
	"open",
	"cat",
	"head",
	"tail",
	"stat",
	"ls",
	"list",
	"tree",
	"glob",
	"grep",
	"find",
	"search",
	"describe_image"
]);
/** 记一次工具调用触碰的文件（arguments 可能是 JSON 字符串或已解析对象）。 */
function recordToolCall(sessionId, toolName, rawArguments, cwd) {
	if (READ_ONLY_TOOLS.has(toolName)) return;
	const touched = [];
	let args = rawArguments;
	if (typeof rawArguments === "string") try {
		args = JSON.parse(rawArguments);
	} catch {
		touched.push(...touchedPathsFromCommand(rawArguments, cwd));
		args = void 0;
	}
	if (isRecord(args)) {
		for (const key of TOOL_PATH_KEYS) {
			const value = args[key];
			if (typeof value === "string") {
				const path = normalizeTouchedPath(value, cwd);
				if (path) touched.push(path);
			} else if (Array.isArray(value)) for (const item of value) {
				const path = normalizeTouchedPath(item, cwd);
				if (path) touched.push(path);
			}
		}
		if (typeof args.command === "string") touched.push(...touchedPathsFromCommand(args.command, cwd));
	}
	if (touched.length === 0) return;
	let bucket = pendingTouched.get(sessionId);
	if (!bucket) {
		bucket = /* @__PURE__ */ new Set();
		pendingTouched.set(sessionId, bucket);
	}
	for (const path of touched) {
		if (bucket.size >= MAX_TOUCHED_PATHS) break;
		bucket.add(path);
	}
}
/** 会话 id 只保留 [A-Za-z0-9_-]，防止路径拼进意外字符。 */
function sanitizeId(id) {
	return id.replace(/[^A-Za-z0-9_-]/g, "_");
}
function snapshotRoot() {
	return join(homedir(), ".dsh", "dsh-session-manager");
}
function isCheckpointFiles(value) {
	if (!isRecord(value) || !Array.isArray(value.changed) || !Array.isArray(value.untracked)) return false;
	if (value.mode !== "git" && value.mode !== "filesystem") return false;
	return typeof value.contents === "object" && value.contents !== null;
}
/** 原子写：先写 .tmp 再 rename，避免中途退出留下半截 JSON；权限收紧到 0600 / 0700。 */
async function persistSnapshot(sessionId, seq, snapshot) {
	const dir = join(snapshotRoot(), sanitizeId(sessionId));
	await mkdir(dir, {
		recursive: true,
		mode: 448
	});
	const tmp = join(dir, `${seq}.json.tmp`);
	const final = join(dir, `${seq}.json`);
	await writeFile(tmp, JSON.stringify({
		version: 1,
		sessionId,
		seq,
		...snapshot
	}), { mode: 384 });
	await rename(tmp, final);
	try {
		await chmod(dir, 448);
	} catch {}
	try {
		const seqFiles = (await readdir(dir)).filter((name$1) => /^\d+\.json$/.test(name$1)).map((name$1) => Number(name$1.slice(0, -5))).sort((a, b) => b - a);
		for (const stale of seqFiles.slice(KEEP_SNAPSHOTS)) try {
			await unlink(join(dir, `${stale}.json`));
		} catch {}
	} catch {}
}
async function loadSnapshot(sessionId, seq) {
	try {
		const raw = await readFile(join(snapshotRoot(), sanitizeId(sessionId), `${seq}.json`), "utf8");
		const parsed = JSON.parse(raw);
		return isCheckpointFiles(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
async function readLineageMap() {
	try {
		const raw = await readFile(join(snapshotRoot(), "lineage.json"), "utf8");
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
async function recordLineage(child, parent, parentSeq) {
	const map = await readLineageMap();
	map[child] = {
		parent,
		parentSeq
	};
	const dir = snapshotRoot();
	await mkdir(dir, {
		recursive: true,
		mode: 448
	});
	const tmp = join(dir, "lineage.json.tmp");
	const final = join(dir, "lineage.json");
	await writeFile(tmp, JSON.stringify(map), { mode: 384 });
	await rename(tmp, final);
}
/**
* 祖先链：child(∞) → parent(child 的 fork 边界) → …
* 用 header.parentSession 兜底；parentSeq 只有持久化的 lineage.json 才有。
* 没有 parentSeq 的祖先（旧数据），其"之后"窗口不可信——精确 seq 查找仍可用，窗口扫描跳过。
*/
async function sessionLineage(sessions, sessionId) {
	const chain = [];
	const seen = /* @__PURE__ */ new Set();
	const persisted = await readLineageMap();
	let id = sessionId;
	let maxSeq = Number.POSITIVE_INFINITY;
	while (id && chain.length < 10 && !seen.has(id)) {
		seen.add(id);
		chain.push({
			id,
			maxSeq
		});
		const entry = persisted[id];
		const header = sessions?.get(id)?.header;
		const parent = entry?.parent ?? header?.parentSession;
		maxSeq = entry?.parentSeq !== void 0 ? entry.parentSeq : NaN;
		id = parent;
	}
	return chain;
}
function apply(ctx) {
	const hostSettings = ctx.settings;
	try {
		hostSettings?.register(SESSION_MANAGER_NS, Config, { applies: "live" });
	} catch (err) {
		console.warn(`[dsh-session-manager] 注册设置命名空间失败：${toErrorMessage(err)}`);
	}
	const connection = ctx.get("connection");
	const sessions = ctx.get("sessions");
	const shell = ctx.get("shell");
	ctx.on?.("session/event", (session, event) => {
		if (!isRecord(event) || event.type !== "assistant/message") return;
		if (!isRecord(session) || typeof session.id !== "string") return;
		const data = isRecord(event.data) ? event.data : void 0;
		const message = data && isRecord(data.message) ? data.message : void 0;
		const content = message && Array.isArray(message.content) ? message.content : void 0;
		if (!content) return;
		const header = isRecord(session.header) ? session.header : void 0;
		const cwd = header && typeof header.cwd === "string" ? header.cwd : void 0;
		for (const block of content) {
			if (!isRecord(block) || block.type !== "tool-call") continue;
			const toolName = typeof block.name === "string" ? block.name : "";
			recordToolCall(session.id, toolName, block.arguments, cwd);
		}
	});
	if (!connection) return;
	connection.rpc.handle(CHECKPOINT_CHANNEL, async (endpoint, payload) => {
		if (endpoint === "list-checkpoints") {
			const req = parseListCheckpointsRequest(payload);
			if (!req) return failure("无效的检查点列表请求");
			return success({ checkpoints: getCheckpoints(req.sessionId) });
		}
		if (endpoint === "save-checkpoint") {
			if (!isRecord(payload) || typeof payload.sessionId !== "string") return failure("无效请求");
			const { sessionId, seq } = payload;
			if (typeof seq !== "number") return failure("无效的 seq");
			await saveCheckpoint(sessionId, seq, shell, sessions?.get(sessionId)?.header?.cwd);
			return success({ saved: true });
		}
		if (endpoint === "rollback-conversation") {
			const req = parseRollbackConversationRequest(payload);
			if (!req) return failure("无效的回滚对话请求");
			const controller = ctx.get("sessionController");
			if (!controller) return failure("会话控制器服务不可用");
			try {
				const forked = await controller.fork({
					sessionId: req.sessionId,
					atSeq: req.checkpointSeq,
					increaseTitle: true
				});
				await recordLineage(forked.sessionId, req.sessionId, req.checkpointSeq).catch(() => void 0);
				return success({ newSessionId: forked.sessionId });
			} catch (err) {
				return failure(`回滚对话失败：${toErrorMessage(err)}`);
			}
		}
		if (endpoint === "preview-rollback") {
			const req = parsePreviewRollbackRequest(payload);
			if (!req) return failure("无效的回滚预演请求");
			const previewSession = sessions?.get(req.sessionId);
			if (!previewSession) return failure("会话不存在");
			try {
				return success(await previewRollback(sessions, req.sessionId, req.checkpointSeq, shell, previewSession.header?.cwd));
			} catch (err) {
				return failure(`回滚预演失败：${toErrorMessage(err)}`);
			}
		}
		if (endpoint === "apply-rollback") {
			const req = parseApplyRollbackRequest(payload);
			if (!req) return failure("无效的回滚执行请求");
			const planSession = planStore.get(req.planId)?.plan?.sessionId;
			const cwd = planSession ? sessions?.get(planSession)?.header?.cwd : void 0;
			try {
				return success(await applyRollback(req.planId, shell, cwd));
			} catch (err) {
				return failure(`回滚文件失败：${toErrorMessage(err)}`);
			}
		}
		return failure(`未知操作：${String(endpoint)}`);
	}, { authority: "trusted-host" });
	const listen = ctx.on;
	listen?.("session/event", (...args) => {
		const session = args[0];
		const event = args[1];
		if (session?.id === void 0 || event?.type !== "turn/end" || typeof event.seq !== "number") return;
		if (!shell) return;
		saveCheckpoint(session.id, event.seq, shell, session.header?.cwd).catch((error) => {
			console.warn(`[dsh-session-manager] 保存检查点快照失败：${toErrorMessage(error)}`);
		});
	});
}
function getCheckpoints(sessionId) {
	const sessionFiles = checkpointStore.get(sessionId);
	if (!sessionFiles) return [];
	const result = [];
	for (const [seq, snapshot] of sessionFiles) {
		const meta = snapshot.changed.find((f) => f.startsWith("__meta__:"));
		let turn = 0;
		let preview = "";
		if (meta) try {
			const parsed = JSON.parse(meta.slice(9));
			turn = Number(parsed.turn ?? 0);
			preview = String(parsed.preview ?? "").slice(0, 80);
		} catch {}
		result.push({
			seq,
			turn,
			preview
		});
	}
	result.sort((a, b) => b.seq - a.seq);
	return result;
}
/** single-flight：同一 sessionId+seq 的保存只跑一次，避免并发的 turn/end 重复扫描工作区。 */
const checkpointJobs = /* @__PURE__ */ new Map();
async function saveCheckpoint(sessionId, seq, shell, cwd) {
	const key = `${sessionId}:${seq}`;
	const running = checkpointJobs.get(key);
	if (running) return running;
	const job = (async () => {
		let sessionFiles = checkpointStore.get(sessionId);
		if (!sessionFiles) {
			sessionFiles = /* @__PURE__ */ new Map();
			checkpointStore.set(sessionId, sessionFiles);
		}
		if (sessionFiles.has(seq)) return;
		const isGit = await isGitRepository(shell, cwd);
		const changed = isGit ? await getChangedFiles(shell, cwd) : [];
		const untracked = isGit ? await getUntrackedFiles(shell, cwd) : await getWorkspaceFiles(cwd);
		const captured = await captureWorkspaceState(cwd, Array.from(new Set([...changed, ...untracked])));
		const touched = Array.from(pendingTouched.get(sessionId) ?? []);
		pendingTouched.delete(sessionId);
		const snapshot = {
			changed,
			untracked,
			mode: isGit ? "git" : "filesystem",
			contents: captured.contents,
			missing: captured.missing,
			symlinks: captured.symlinks,
			oversized: captured.oversized,
			touched,
			persisted: true
		};
		sessionFiles.set(seq, snapshot);
		totalMemorySnapshots += 1;
		evictMemorySnapshots(sessionFiles);
		try {
			await persistSnapshot(sessionId, seq, snapshot);
		} catch (err) {
			snapshot.persisted = false;
			console.warn(`[dsh-session-manager] 快照持久化失败 seq=${seq}：${toErrorMessage(err)}`);
		}
	})();
	checkpointJobs.set(key, job);
	try {
		await job;
	} finally {
		checkpointJobs.delete(key);
	}
}
/** 内存快照淘汰：单会话最多 KEEP_SNAPSHOTS 份；全局也给个总上限。 */
function evictMemorySnapshots(sessionFiles) {
	while (sessionFiles.size > MAX_SNAPSHOTS_PER_SESSION) {
		let lowest = Number.POSITIVE_INFINITY;
		for (const seq of sessionFiles.keys()) if (seq < lowest) lowest = seq;
		sessionFiles.delete(lowest);
		totalMemorySnapshots -= 1;
	}
	if (totalMemorySnapshots > MAX_TOTAL_MEMORY_SNAPSHOTS) for (const [sid, files] of checkpointStore) {
		while (files.size > 0 && totalMemorySnapshots > MAX_TOTAL_MEMORY_SNAPSHOTS) {
			let lowest = Number.POSITIVE_INFINITY;
			for (const seq of files.keys()) if (seq < lowest) lowest = seq;
			files.delete(lowest);
			totalMemorySnapshots -= 1;
			pendingTouched.delete(sid);
		}
		if (totalMemorySnapshots <= MAX_TOTAL_MEMORY_SNAPSHOTS) break;
	}
}
async function isGitRepository(shell, cwd) {
	if (!shell || !cwd) return false;
	try {
		const result = await shell.run({
			command: "git rev-parse --is-inside-work-tree 2>/dev/null",
			workdir: cwd,
			timeoutMs: 3e3
		});
		return result.exitCode === 0 && result.stdout.trim() === "true";
	} catch {
		return false;
	}
}
async function getChangedFiles(shell, cwd) {
	if (!shell) return [];
	try {
		const result = await shell.run({
			command: "git diff --name-only -z --diff-filter=AMDR HEAD 2>/dev/null; git ls-files --deleted -z 2>/dev/null",
			workdir: cwd,
			timeoutMs: 5e3,
			stdoutMaxBytes: 2e6
		});
		if (result.exitCode !== 0) return [];
		return Array.from(new Set(result.stdout.split("\0").filter(Boolean)));
	} catch {
		return [];
	}
}
async function getUntrackedFiles(shell, cwd) {
	if (!shell) return [];
	try {
		const result = await shell.run({
			command: "git ls-files --others --exclude-standard -z",
			workdir: cwd,
			timeoutMs: 5e3,
			stdoutMaxBytes: 2e6
		});
		if (result.exitCode !== 0) return [];
		return result.stdout.split("\0").filter(Boolean);
	} catch {
		return [];
	}
}
/** 目录遍历时跳过的目录名。 */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build"
]);
/** 递归列出 cwd 下所有常规文件（相对路径，`/` 分隔），与 find -type f 语义一致（不含符号链接）。 */
async function walkWorkspaceFiles(cwd, dir = "") {
	const entries = await readdir(resolve(cwd, dir), { withFileTypes: true });
	const out = [];
	for (const entry of entries) {
		const rel = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...await walkWorkspaceFiles(cwd, rel));
		} else if (entry.isFile()) out.push(rel);
	}
	return out;
}
/** target 必须位于 root 之内（拒绝 `..` 越界路径）。 */
function isWithin(root, target) {
	const base = resolve(root);
	return resolve(target).startsWith(base + sep);
}
async function getWorkspaceFiles(cwd) {
	if (!cwd) return [];
	try {
		return await walkWorkspaceFiles(cwd);
	} catch {
		return [];
	}
}
/** 显式捕获每个候选路径在检查点时刻的状态；读不到/超限/符号链接都单独归类。 */
async function captureWorkspaceState(cwd, files) {
	const result = {
		contents: {},
		missing: [],
		symlinks: [],
		oversized: []
	};
	if (!cwd) return result;
	for (const file of new Set(files)) {
		const full = resolve(cwd, file);
		if (!isWithin(cwd, full)) continue;
		try {
			const info = await lstat(full);
			if (info.isSymbolicLink()) {
				result.symlinks.push(file);
				continue;
			}
			if (info.isDirectory()) continue;
			if (!info.isFile()) {
				result.missing.push(file);
				continue;
			}
			if (info.size > SNAPSHOT_FILE_LIMIT) {
				result.oversized.push({
					path: file,
					size: info.size
				});
				continue;
			}
			const buf = await readFile(full);
			if (buf.length > SNAPSHOT_FILE_LIMIT) {
				result.oversized.push({
					path: file,
					size: buf.length
				});
				continue;
			}
			result.contents[file] = buf.toString("base64");
		} catch {
			result.missing.push(file);
		}
	}
	return result;
}
/** 精确快照：只在祖先链上找 seq 完全等于 checkpointSeq 的那一份，不做"更早快照"回退。 */
async function resolveExactSnapshot(sessions, sessionId, checkpointSeq) {
	const chain = await sessionLineage(sessions, sessionId);
	for (const { id } of chain) {
		const pending = checkpointJobs.get(`${id}:${checkpointSeq}`);
		if (pending) try {
			await pending;
		} catch {}
	}
	for (const { id } of chain) {
		const memory = checkpointStore.get(id)?.get(checkpointSeq);
		if (memory) return {
			snapshot: memory,
			snapshotSeq: checkpointSeq
		};
		const disk = await loadSnapshot(id, checkpointSeq);
		if (disk) return {
			snapshot: disk,
			snapshotSeq: checkpointSeq
		};
	}
	return {};
}
/**
* 窗口快照（checkpointSeq 之后）：本会话 + 祖先链，但祖先只取 <= 其 fork 边界的 seq，
* 避免父分支 fork 之后的快照污染子分支的归属判断与"检查点后新增"判断。
*/
async function snapshotsAfter(sessions, sessionId, checkpointSeq) {
	const result = [];
	const seen = /* @__PURE__ */ new Set();
	for (const { id, maxSeq } of await sessionLineage(sessions, sessionId)) {
		if (id !== sessionId && !Number.isFinite(maxSeq)) continue;
		for (const [seq, snapshot] of checkpointStore.get(id) ?? []) {
			if (seq <= checkpointSeq || seq > maxSeq || seen.has(`${id}:${seq}`)) continue;
			seen.add(`${id}:${seq}`);
			result.push(snapshot);
		}
		try {
			const dir = join(snapshotRoot(), sanitizeId(id));
			for (const name$1 of await readdir(dir)) {
				if (!/^\d+\.json$/.test(name$1)) continue;
				const seq = Number(name$1.slice(0, -5));
				if (seq <= checkpointSeq || seq > maxSeq || seen.has(`${id}:${seq}`)) continue;
				seen.add(`${id}:${seq}`);
				const snapshot = await loadSnapshot(id, seq);
				if (snapshot) result.push(snapshot);
			}
		} catch {}
	}
	return result;
}
/** 检查点之后新增的候选文件：更晚的快照里出现过、但本检查点快照没有。 */
async function findCreatedAfter(sessions, sessionId, checkpointSeq, snapshot) {
	const checkpointFiles = new Set([...snapshot.untracked, ...snapshot.missing ?? []]);
	const laterFiles = /* @__PURE__ */ new Set();
	for (const later of await snapshotsAfter(sessions, sessionId, checkpointSeq)) for (const file of later.untracked) laterFiles.add(file);
	return Array.from(laterFiles).filter((file) => !checkpointFiles.has(file));
}
async function existingFiles(cwd, candidates) {
	const present = [];
	for (const file of candidates) {
		if (!cwd) break;
		const full = resolve(cwd, file);
		if (!isWithin(cwd, full)) continue;
		try {
			await lstat(full);
			present.push(file);
		} catch {}
	}
	return present;
}
async function currentFileState(cwd, file) {
	if (!cwd) return { state: "absent" };
	const full = resolve(cwd, file);
	if (!isWithin(cwd, full)) return { state: "absent" };
	try {
		const info = await lstat(full);
		if (info.isSymbolicLink()) return {
			state: "present",
			marker: `symlink:${await readlink(full)}`
		};
		if (info.isDirectory()) return {
			state: "present",
			marker: "kind:dir"
		};
		if (!info.isFile()) return {
			state: "present",
			marker: "kind:other"
		};
		return {
			state: "present",
			marker: sha256(await readFile(full))
		};
	} catch {
		return { state: "absent" };
	}
}
function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}
/** 目标路径不能经符号链接逃出工作区：逐级 realpath 最深存在祖先，确认仍在 cwd 内。 */
async function realWithin(cwd, full) {
	try {
		const rootReal = await realpath(cwd);
		let probe = dirname(full);
		for (let depth = 0; depth < 40; depth += 1) try {
			const real = await realpath(probe);
			return real === rootReal || real.startsWith(rootReal + sep);
		} catch {
			const parent = dirname(probe);
			if (parent === probe) return false;
			probe = parent;
		}
		return false;
	} catch {
		return false;
	}
}
/** Host 侧计划托管：planId → 计划（限时、一次性）。 */
const planStore = /* @__PURE__ */ new Map();
const PLAN_TTL_MS = 600 * 1e3;
const MAX_PLANS = 200;
function stashPlan(plan) {
	planStore.set(plan.planId, {
		plan,
		expiresAt: Date.now() + PLAN_TTL_MS
	});
	if (planStore.size > MAX_PLANS) {
		const oldest = [...planStore.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
		if (oldest) planStore.delete(oldest[0]);
	}
}
/** 非本次对话改动的文件（可能很多）：只保留前 50 条用于展示 + 一个总数。 */
function addSkipped(skipped, file) {
	if (skipped.length < 50) skipped.push(file);
	return 1;
}
async function previewRollback(sessions, sessionId, checkpointSeq, shell, cwd) {
	const isGit = await isGitRepository(shell, cwd);
	const exact = await resolveExactSnapshot(sessions, sessionId, checkpointSeq);
	const snapshot = exact.snapshot;
	const snapshotSeq = exact.snapshotSeq;
	const persisted = snapshot?.persisted !== false;
	if (!snapshot) return {
		planId: "",
		restore: [],
		remove: [],
		skipped: [],
		skippedCount: 0,
		scoped: false,
		unknownSnapshots: 0,
		snapshotFiles: 0,
		snapshotStatus: "missing",
		persisted: false,
		hasSnapshot: false,
		snapshotSeq: void 0,
		isGit,
		unsupported: []
	};
	const scopeSnapshots = await snapshotsAfter(sessions, sessionId, checkpointSeq);
	const scopedFiles = /* @__PURE__ */ new Set();
	let unknownSnapshots = 0;
	for (const item of scopeSnapshots) if (item.touched === void 0) unknownSnapshots += 1;
	else for (const file of item.touched) scopedFiles.add(file);
	const scoped = scopeSnapshots.length > 0 && unknownSnapshots === 0;
	const ops = [];
	const restoreList = [];
	const removeList = [];
	const skipped = [];
	let skippedCount = 0;
	const unsupported = [];
	for (const file of Object.keys(snapshot.contents)) {
		const encoded = snapshot.contents[file];
		if (encoded === void 0) continue;
		const target = Buffer.from(encoded, "base64");
		const cur = await currentFileState(cwd, file);
		if (cur.state === "present" && cur.marker === sha256(target)) continue;
		if (cur.state === "present") {
			if (scoped && !scopedFiles.has(file)) {
				skippedCount += addSkipped(skipped, file);
				continue;
			}
		}
		ops.push({
			path: file,
			action: "restore",
			source: "snapshot",
			expectedCurrentSha: cur.state === "present" ? cur.marker ?? "" : "absent",
			targetBase64: encoded
		});
		restoreList.push(file);
	}
	for (const file of snapshot.missing ?? []) {
		const cur = await currentFileState(cwd, file);
		if (cur.state === "absent") continue;
		if (scoped && !scopedFiles.has(file)) {
			skippedCount += 1;
			if (skipped.length < 50) skipped.push(file);
			continue;
		}
		ops.push({
			path: file,
			action: "delete",
			source: "snapshot",
			expectedCurrentSha: cur.marker ?? ""
		});
		removeList.push(file);
	}
	const createdAfter = await findCreatedAfter(sessions, sessionId, checkpointSeq, snapshot);
	for (const file of await existingFiles(cwd, createdAfter)) {
		const cur = await currentFileState(cwd, file);
		if (cur.state === "absent") continue;
		if (scoped && !scopedFiles.has(file)) {
			skippedCount += 1;
			if (skipped.length < 50) skipped.push(file);
			continue;
		}
		ops.push({
			path: file,
			action: "delete",
			source: "snapshot",
			expectedCurrentSha: cur.marker ?? ""
		});
		removeList.push(file);
	}
	if (isGit) {
		const windowChanged = /* @__PURE__ */ new Set();
		for (const item of scopeSnapshots) for (const file of item.changed) windowChanged.add(file);
		for (const file of scopedFiles) {
			if (!windowChanged.has(file)) continue;
			if (snapshot.contents[file] !== void 0) continue;
			if ((snapshot.missing ?? []).includes(file)) continue;
			const cur = await currentFileState(cwd, file);
			if (cur.state === "absent") continue;
			ops.push({
				path: file,
				action: "restore",
				source: "head",
				expectedCurrentSha: cur.marker ?? ""
			});
			restoreList.push(file);
		}
	}
	for (const file of snapshot.symlinks ?? []) unsupported.push({
		path: file,
		reason: "符号链接，不跟随写入"
	});
	for (const item of snapshot.oversized ?? []) unsupported.push({
		path: item.path,
		reason: `超过快照大小限制（${item.size} 字节）`
	});
	const fingerprint = sha256(Buffer.from(ops.map((op) => `${op.path}:${op.action}:${op.expectedCurrentSha}`).sort().join("\n"), "utf8"));
	const plan = {
		planId: randomUUID(),
		sessionId,
		checkpointSeq,
		snapshotSeq,
		snapshotStatus: "exact",
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
		unsupported
	};
	stashPlan(plan);
	return {
		planId: plan.planId,
		restore: restoreList,
		remove: removeList,
		skipped,
		skippedCount,
		scoped,
		unknownSnapshots,
		snapshotFiles: Object.keys(snapshot.contents).length,
		snapshotStatus: "exact",
		persisted,
		hasSnapshot: true,
		snapshotSeq,
		isGit,
		unsupported
	};
}
async function applyRollback(planId, shell, cwd) {
	const restored = [];
	const removed = [];
	const conflicts = [];
	const errors = [];
	const entry = planStore.get(planId);
	if (!entry || entry.expiresAt < Date.now()) {
		errors.push("回滚计划不存在或已过期，请重新打开对话框生成计划");
		return {
			restored,
			removed,
			conflicts,
			errors
		};
	}
	planStore.delete(planId);
	const plan = entry.plan;
	for (const op of plan.operations) {
		const full = cwd ? resolve(cwd, op.path) : void 0;
		if (!cwd || !full || !isWithin(cwd, full)) {
			conflicts.push(`${op.path}：路径越界，未执行`);
			continue;
		}
		if (!await realWithin(cwd, full)) {
			conflicts.push(`${op.path}：路径经由符号链接指向工作区外，未执行`);
			continue;
		}
		const cur = await currentFileState(cwd, op.path);
		if (op.expectedCurrentSha === "absent") {
			if (cur.state !== "absent") {
				conflicts.push(`${op.path}：预演后文件出现，未覆盖`);
				continue;
			}
		} else if (cur.state === "absent" || cur.marker !== op.expectedCurrentSha) {
			conflicts.push(`${op.path}：预演后被改动，未覆盖`);
			continue;
		}
		try {
			if (op.action === "restore") if (op.source === "snapshot") {
				if (op.targetBase64 === void 0) throw new Error("计划缺少目标内容");
				await mkdir(dirname(full), { recursive: true });
				await writeFile(full, Buffer.from(op.targetBase64, "base64"));
				restored.push(op.path);
			} else {
				if (!shell) throw new Error("Shell 服务不可用");
				const r = await shell.run({
					command: `git restore --source=HEAD --worktree --staged -- ${shellQuote(op.path)} 2>&1`,
					workdir: cwd,
					timeoutMs: 1e4
				});
				if (r.exitCode !== 0) throw new Error(r.stderr || "git restore 失败");
				restored.push(op.path);
			}
			else {
				if ((await lstat(full)).isSymbolicLink()) {
					conflicts.push(`${op.path}：符号链接，未删除`);
					continue;
				}
				await unlink(full);
				removed.push(op.path);
			}
		} catch (err) {
			errors.push(`${op.path}: ${toErrorMessage(err)}`);
		}
	}
	return {
		restored,
		removed,
		conflicts,
		errors
	};
}
function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function success(value) {
	return {
		ok: true,
		value
	};
}
function failure(message) {
	return {
		ok: false,
		error: {
			code: "bad-request",
			message,
			details: { issues: [] }
		}
	};
}
function toErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

//#endregion
export { Config, apply, inject, name };
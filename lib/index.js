import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import Schema from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

//#region src/marker.ts
/** Producer kind carried by every marker this plugin appends. */
const REWIND_MARKER_KIND = "dsh-session-manager-rewind";
/** The marker's source: one producer-owned kind, no private fields. */
const REWIND_MARKER_SOURCE = Object.freeze({ kind: REWIND_MARKER_KIND });

//#endregion
//#region src/locales.ts
/**
* The locale a durable preference selects from this plugin's dictionaries.
*
* The harness accepts any BCP 47-style id while this plugin ships only `zh` and
* `en`, so the PRIMARY subtag decides (`zh-CN` → zh) and everything else — an
* unset preference, an unsupported language, a non-string value — is English.
* The client's own selection tries the full tag before the primary subtag; over
* these two dictionaries the outcome is the same.
*
* @param preference - the raw `locale.preference` value.
* @returns the dictionary this plugin renders its host copy in.
*/
function preferredLocale(preference) {
	if (typeof preference !== "string") return "en";
	return preference.toLowerCase().split("-")[0] === "zh" ? "zh" : "en";
}
/** English dictionary — the key-set source of truth (neutral default). */
const en = {
	"plan.rewinding": "Rewind to seq {targetSeq}, removing {count} node(s) from the model context (conversation log kept).",
	"plan.affects": "Affects {count} file(s):",
	"plan.restore": "restore {path}",
	"plan.delete": "delete {path}",
	"plan.noChanges": "No restorable changes after the target.",
	"plan.backupOff": "Snapshot backups are off; this restore may be incomplete.",
	"plan.skip": "  not restored: {path} ({reason})",
	"skipReason.oversized": "over the {limit} backup limit, so the recorded state predates untracked edits",
	"uncovered.header": "{count} tracked file(s) exceed the {limit} backup limit and are not covered:",
	"error.invalidTarget": "Cannot parse target \"{raw}\" (expected <index> or @<seq>)",
	"conflict.drifted": "modified externally after the preview; not overwritten per safety rule",
	"sep.list": ", ",
	"sep.clause": "; ",
	"failures.suffix": "; {count} file(s) failed to restore: {list}",
	"failures.item": "{path} ({message})",
	"inflight": "A rewind is already running for this session; please wait.",
	"stopFailed": "Could not stop the running agent; rewind cancelled. Please try again.",
	"cancelled": "Rewind cancelled.",
	"failed": "Rewind failed: {error}. The session is unchanged.",
	"restore.count": "restored {count} file(s)",
	"delete.count": "deleted {count} file(s)",
	"skip.count": "skipped {count} path(s)",
	"noRestorable": "; no restorable write-class changes after the target",
	"backupOff": "snapshot backups are off, so the restore may be incomplete",
	"storeUnsupported": "file restore unavailable: these snapshots use a newer store format (v{version}) than this plugin understands; nothing was changed. Update the plugin or clear this session's snapshots.",
	"success": "Withdrawn seq {targetSeq} and everything after it (conversation returned to earlier){restore}.",
	"noUserMessages": "This session has no rewindable user messages yet.",
	"command.description": "Rewind the conversation and/or code to a previous point",
	"command.undoDescription": "Alias of /rewind",
	"engine.description": "dsh-session-manager internal command",
	"engine.rejected": "Internal command: use /rewind or /undo.",
	"engine.inputHint": "@<seq> chat|both",
	"cleanup.description": "Manage automatic cleanup of session snapshot backups",
	"cleanup.inputHint": "on | off | max-age <days> | run [--apply] [--current]",
	"cleanup.status": "Auto-cleanup: {state}. Max age: {days} day(s).",
	"cleanup.enabled": "enabled",
	"cleanup.disabled": "disabled",
	"cleanup.onOk": "Auto-cleanup enabled.",
	"cleanup.offOk": "Auto-cleanup disabled — all snapshots kept.",
	"cleanup.maxAgeOk": "Auto-cleanup max age set to {days} day(s).",
	"cleanup.cfgInvalid": "Snapshot cleanup config invalid: {detail}. Nothing was executed; use \"on|off|max-age\" to reset the config.",
	"cleanup.saveFailed": "Could not save cleanup config: {detail}.",
	"cleanup.runDry": "Dry-run: would remove {deleted} session snapshot backup(s), freeing {freed} bytes. Re-run with --apply to delete.",
	"cleanup.runApply": "Removed {deleted} session snapshot backup(s), freeing {freed} bytes; {kept} kept, {remaining} bytes remain.",
	"cleanup.runFailed": "Cleanup failed: {detail}.",
	"cleanup.skipped": "({skipped} active session(s) skipped.)",
	"cleanup.clearDry": "Dry-run: would clear {entries} snapshot(s) of the current session, freeing {bytes} bytes. Re-run with --apply to delete.",
	"cleanup.clearApply": "Cleared {entries} snapshot(s) of the current session, freeing {bytes} bytes. This session now records snapshots fresh from its current state.",
	"cleanup.clearActive": "Could not clear session {sessionId}: the session is still running and could not be stopped. Try again once it is idle.",
	"cleanup.clearCancelled": "Clear cancelled.",
	"cleanup.clearFailed": "Could not clear session {sessionId}: {detail}.",
	"cleanup.usage": "Usage:\n  /snapshot-auto-cleanup                 show status\n  /snapshot-auto-cleanup on|off          enable/disable auto-cleanup\n  /snapshot-auto-cleanup max-age <days>  set the idle cutoff\n  /snapshot-auto-cleanup run [--apply]   dry-run, or execute with --apply\n  /snapshot-auto-cleanup run --current [--apply]   dry-run/clear this session's snapshots"
};
/** Chinese dictionary, checked complete against the en key set. */
const zh = {
	"plan.rewinding": "将回退到 seq {targetSeq}，从模型上下文移除 {count} 个节点（对话日志保留）。",
	"plan.affects": "将影响 {count} 个文件：",
	"plan.restore": "还原 {path}",
	"plan.delete": "删除 {path}",
	"plan.noChanges": "目标之后没有需要还原的变更。",
	"plan.backupOff": "快照备份已关闭；本次还原可能不充分。",
	"plan.skip": "  未还原：{path}（{reason}）",
	"skipReason.oversized": "已超过 {limit} 的备份上限，记录的状态早于未被跟踪的修改",
	"uncovered.header": "{count} 个已跟踪文件超过 {limit} 的备份上限，未纳入记录：",
	"error.invalidTarget": "无法解析目标 \"{raw}\"（应为 <序号> 或 @<seq>）",
	"conflict.drifted": "预演后被外部改动，按安全规则未覆盖",
	"sep.list": "、",
	"sep.clause": "；",
	"failures.suffix": "；{count} 个文件还原失败：{list}",
	"failures.item": "{path}（{message}）",
	"inflight": "该会话已有一个回退正在执行，请稍候。",
	"stopFailed": "无法停止运行中的 agent，回退已取消。请稍后再试。",
	"cancelled": "回退已取消。",
	"failed": "回退失败：{error}。会话未改变。",
	"restore.count": "还原 {count} 个文件",
	"delete.count": "删除 {count} 个文件",
	"skip.count": "跳过 {count} 个路径",
	"noRestorable": "；目标之后没有可还原的写类变更",
	"backupOff": "快照备份已关闭，还原可能不充分",
	"storeUnsupported": "文件还原不可用：这些快照使用了比本插件更新的存储格式（v{version}）；工作区未做任何改动。请更新插件，或清除该会话的快照。",
	"success": "已撤回 seq {targetSeq} 及之后内容（对话已回到此前）{restore}。",
	"noUserMessages": "当前会话还没有可回退的用户消息。",
	"command.description": "回退对话和/或代码到之前的某条消息",
	"command.undoDescription": "/rewind 的别名",
	"engine.description": "dsh-session-manager 内部命令",
	"engine.rejected": "内部命令：请使用 /rewind 或 /undo。",
	"engine.inputHint": "@<seq> chat|both",
	"cleanup.description": "管理会话快照备份的自动清理",
	"cleanup.inputHint": "on | off | max-age <天数> | run [--apply] [--current]",
	"cleanup.status": "自动清理：{state}。最大保留天数：{days} 天。",
	"cleanup.enabled": "已开启",
	"cleanup.disabled": "已关闭",
	"cleanup.onOk": "已开启自动清理。",
	"cleanup.offOk": "已关闭自动清理——保留全部快照。",
	"cleanup.maxAgeOk": "已将自动清理的最大保留天数设为 {days} 天。",
	"cleanup.cfgInvalid": "快照清理配置无效：{detail}。未执行任何操作；请用「on|off|max-age」重设配置以修复。",
	"cleanup.saveFailed": "无法保存清理配置：{detail}。",
	"cleanup.runDry": "预演：将删除 {deleted} 个会话的快照备份，释放 {freed} 字节。加 --apply 正式删除。",
	"cleanup.runApply": "已删除 {deleted} 个会话的快照备份，释放 {freed} 字节；保留 {kept} 个，剩余 {remaining} 字节。",
	"cleanup.runFailed": "清理失败：{detail}。",
	"cleanup.skipped": "（跳过了 {skipped} 个活动会话。）",
	"cleanup.clearDry": "预演：将清除当前会话的 {entries} 个快照，释放 {bytes} 字节。加 --apply 正式删除。",
	"cleanup.clearApply": "已清除当前会话的 {entries} 个快照，释放 {bytes} 字节。该会话已重置为从当前状态重新记录快照。",
	"cleanup.clearActive": "无法清除会话 {sessionId}：会话仍在运行且未能停止，请待其空闲后重试。",
	"cleanup.clearCancelled": "清空已取消。",
	"cleanup.clearFailed": "无法清除会话 {sessionId}：{detail}。",
	"cleanup.usage": "用法：\n  /snapshot-auto-cleanup                 查看状态\n  /snapshot-auto-cleanup on|off          开启/关闭自动清理\n  /snapshot-auto-cleanup max-age <天数>  设置失活阈值（天）\n  /snapshot-auto-cleanup run [--apply]   预演，或加 --apply 执行\n  /snapshot-auto-cleanup run --current [--apply]  预演/清除本会话快照"
};
/** The host dictionaries keyed by locale id. */
const HOST_DICTS = {
	en,
	zh
};
/**
* Render one dictionary key with `{name}` template interpolation. Unknown
* params are ignored; a missing key falls back to the raw key so a dictionary
* gap is visible instead of blank.
* @param lang - the active locale.
* @param key - the dictionary key.
* @param params - `{name}` substitution values.
*/
function translate(lang, key, params = {}) {
	let text = (HOST_DICTS[lang] ?? en)[key] ?? key;
	for (const [name$1, value] of Object.entries(params)) text = text.split(`{${name$1}}`).join(String(value));
	return text;
}

//#endregion
//#region src/rewind.ts
/** A typed rewind failure. The host renders `code` into user-facing copy. */
var RewindError = class extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "RewindError";
	}
};
/** Preview length cap for candidate listings. */
const CANDIDATE_PREVIEW_CHARS = 80;
/**
* Default cap on how many user messages a candidate listing returns (newest
* kept). Matches the snapshot store's MAX_ANCHOR_GROUPS (100), so every
* anchor group that still has restorable file backups is listed; callers can
* still pass an explicit `limit`.
*/
const DEFAULT_CANDIDATE_LIMIT = 100;
/** Narrow an event to a user message. */
function isUserMessageEvent(event) {
	return event.type === "user/message";
}
/**
* True for a HUMAN user message event — one whose `source.kind` is `'user'`.
*
* The surface can carry `user/message` events whose source is NOT the user:
* plugin/system context injection (including compaction checkpoints) and
* tool-result backfill all arrive as `user/message` with a non-`'user'`
* source, and the client renders those as `context` nodes, never as a user
* bubble. Only genuine user messages (and user steering during a running
* turn, which keeps `source.kind: 'user'`) are valid rewind targets — a
* rewind boundary must land on a human prompt, not on injected context.
*/
function isHumanUserMessageEvent(event) {
	return isUserMessageEvent(event) && event.data.source.kind === "user";
}
/** Join the text blocks of a message into one plain string. */
function messagePreview(message) {
	const text = message.content.map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "").join("").replace(/\s+/g, " ").trim();
	return text.length <= CANDIDATE_PREVIEW_CHARS ? text : `${text.slice(0, CANDIDATE_PREVIEW_CHARS - 1)}…`;
}
/** Absolute-seq token: `@` followed by decimal digits only. */
const SEQ_TOKEN = /^@(\d+)$/;
/** Recency-index token: decimal digits only. */
const INDEX_TOKEN = /^(\d+)$/;
/**
* Parse a raw command token into a rewind target. Both forms must be plain
* decimal integers: a bare `Number()` would also accept `@1e3`, `@0x10` and
* `@+5`, and would read a bare `@` as seq 0.
* @param raw - one token: `@123` (absolute seq) or `12` (recency index).
* @returns the parsed target, or undefined when the token is malformed.
*/
function parseRewindTarget(raw) {
	const token = raw.trim();
	const seq = SEQ_TOKEN.exec(token);
	if (seq !== null) {
		const value = Number(seq[1] ?? "");
		return Number.isSafeInteger(value) ? {
			kind: "seq",
			seq: value
		} : void 0;
	}
	const index = INDEX_TOKEN.exec(token);
	if (index !== null) {
		const value = Number(index[1] ?? "");
		return Number.isSafeInteger(value) && value >= 1 ? {
			kind: "index",
			index: value
		} : void 0;
	}
}
/**
* List the selectable rewind candidates: user messages currently on the
* surface, most recent first. Shadowed (compacted-away) user messages are
* intentionally excluded — the rewind boundary cannot be placed where the
* model context no longer reaches.
* @param events - the full session event log.
* @param surface - the ordered surface node seqs (`session.surface.nodes`).
* @param limit - maximum number of candidates to return.
* @returns candidates numbered 1..N by recency.
*/
function listRewindCandidates(events, surface, limit = DEFAULT_CANDIDATE_LIMIT) {
	const surfaceIndexes = /* @__PURE__ */ new Map();
	for (let i = 0; i < surface.length; i++) surfaceIndexes.set(surface[i], i);
	const candidates = [];
	for (let i = events.length - 1; i >= 0 && candidates.length < limit; i--) {
		const event = events[i];
		if (!isHumanUserMessageEvent(event)) continue;
		if (!surfaceIndexes.has(event.seq)) continue;
		candidates.push({
			seq: event.seq,
			time: event.time,
			preview: messagePreview(event.data),
			index: candidates.length + 1
		});
	}
	return candidates;
}
/**
* Resolve a target against the session log and surface into a validated plan.
* @param events - the full session event log.
* @param surface - the ordered surface node seqs.
* @param target - the parsed target.
* @returns the validated rewind plan.
* @throws {RewindError} with a typed code when the target is unusable.
*/
function planRewind(events, surface, target) {
	let targetSeq;
	if (target.kind === "seq") targetSeq = target.seq;
	else {
		const candidate = listRewindCandidates(events, surface, target.index)[target.index - 1];
		if (candidate === void 0) throw new RewindError("invalid-index", `rewind index ${target.index} has no candidate`);
		targetSeq = candidate.seq;
	}
	const targetEvent = events.find((event) => event.seq === targetSeq);
	if (targetEvent === void 0) throw new RewindError("not-a-user-message", `no session event at seq ${targetSeq}`);
	if (!isHumanUserMessageEvent(targetEvent)) throw new RewindError("not-a-user-message", `session event at seq ${targetSeq} is not a human user message (${targetEvent.type})`);
	const targetIndex = surface.indexOf(targetSeq);
	if (targetIndex === -1) throw new RewindError("not-on-surface", `user message at seq ${targetSeq} is no longer in the model context (shadowed by compaction)`);
	const shadowedSeqs = surface.slice(targetIndex);
	return {
		targetSeq,
		targetIndex,
		shadowedSeqs,
		surfaceStart: shadowedSeqs[0],
		surfaceEnd: shadowedSeqs[shadowedSeqs.length - 1]
	};
}

//#endregion
//#region src/snapshot.ts
/** Sub-directory of the harness home holding this plugin's snapshots. */
const SNAPSHOT_DIR_NAME = "rewind-snapshots";
/** Suffix of the raw byte copy holding one entry's before-content. */
const SIDECAR_SUFFIX = ".before";
/** Session-dir sub-directory holding captures that are staged but not committed. */
const PENDING_DIR = ".pending";
/** Session-dir sub-directory holding one pre-restore ("rescue") copy per op. */
const RESCUE_DIR = "rescue";
/** Journal-file prefix of the current format. */
const JOURNAL_PREFIX = "journal-";
/** Journal-file prefix written by the released v1 build (read-only compatibility). */
const LEGACY_JOURNAL_PREFIX = "restore-journal-";
/** Age after which an uncommitted `.pending/` capture is collected by `prune`. */
const PENDING_MAX_AGE_MS = 1440 * 60 * 1e3;
/** Chunk size of the streaming byte comparisons (never load a whole file). */
const COMPARE_CHUNK_BYTES = 64 * 1024;
/** The Unicode replacement character a lossy UTF-8 decode produces. */
const REPLACEMENT_CHAR = "�";
/**
* A regular file larger than this is NOT backed up. This plugin is a
* lightweight, conversation-scoped undo, not a backup system: copying a very
* large file on every edit is what grows the store without bound and saturates
* IO (issue #39). The cap is a declared limitation, not a delta scheme, and is
* exposed as the `maxFileBytes` config field (`0` disables the cap).
*/
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Number of newest anchor groups (user messages) kept per session. */
const MAX_ANCHOR_GROUPS = 100;
/**
* Current on-disk store format version (the session's `store` marker value and
* the `store` field of every entry this build writes). A value ABOVE this one
* means the snapshots were written by a NEWER build: readers must then fail
* closed (no file restore, nothing changed) instead of guessing what the extra
* fields mean. A missing marker (or `1`) means the released v1 string format,
* which is still read.
*/
const CURRENT_STORE_VERSION = 2;
/**
* Thrown when snapshots carry a store format newer than this build understands
* (ADR-10: whole-operation fail-closed — never a partial restore, never a
* clear). The session rewind itself does not depend on snapshots and still
* works.
*/
var UnknownStoreVersionError = class extends Error {
	constructor(version, source) {
		super(`snapshot store version ${version} is newer than this plugin understands (${source})`);
		this.version = version;
		this.source = source;
		this.name = "UnknownStoreVersionError";
	}
};
/** Classify a released-v1 string record (U+FFFD means the decode lost bytes). */
function textSourceOf(text) {
	return text.includes(REPLACEMENT_CHAR) ? {
		kind: "lossyText",
		text
	} : {
		kind: "text",
		bytes: Buffer.from(text, "utf8")
	};
}
/** True when an entry is a dedup link (carries `ref`, not `before`). */
function isLinkEntry(entry) {
	return "ref" in entry;
}
/** Streaming byte equality of two files (never loads either one whole). */
async function sameFileBytes(aPath, bPath) {
	const sizes = await Promise.all([stat(aPath), stat(bPath)]);
	if (sizes[0].size !== sizes[1].size) return false;
	const [a, b] = await Promise.all([open(aPath, "r"), open(bPath, "r")]);
	try {
		const aChunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
		const bChunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
		for (;;) {
			const [ra, rb] = await Promise.all([a.read(aChunk, 0, COMPARE_CHUNK_BYTES, null), b.read(bChunk, 0, COMPARE_CHUNK_BYTES, null)]);
			if (ra.bytesRead !== rb.bytesRead) return false;
			if (ra.bytesRead === 0) return true;
			if (!aChunk.subarray(0, ra.bytesRead).equals(bChunk.subarray(0, rb.bytesRead))) return false;
		}
	} finally {
		await Promise.all([a.close(), b.close()]);
	}
}
/** Streaming byte equality of a file against an in-memory buffer. */
async function sameFileBuffer(path, bytes) {
	if ((await stat(path)).size !== bytes.length) return false;
	const handle = await open(path, "r");
	try {
		const chunk = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
		let offset = 0;
		for (;;) {
			const read = await handle.read(chunk, 0, Math.min(COMPARE_CHUNK_BYTES, bytes.length - offset), offset);
			if (read.bytesRead === 0) return offset === bytes.length;
			if (!chunk.subarray(0, read.bytesRead).equals(bytes.subarray(offset, offset + read.bytesRead))) return false;
			offset += read.bytesRead;
		}
	} finally {
		await handle.close();
	}
}
/** True when the error means "the path does not exist". */
function isEnoent(error) {
	return error?.code === "ENOENT";
}
/** Production probe: real byte comparisons via node:fs, links via lstat + nlink. */
const defaultProbe = {
	async matches(source, path) {
		try {
			if (source === null) {
				await stat(path);
				return false;
			}
			if (source.kind === "blob") return await sameFileBytes(path, source.path);
			if (source.kind === "text") return await sameFileBuffer(path, source.bytes);
			return (await readFile(path)).toString("utf8") === source.text;
		} catch (error) {
			if (isEnoent(error)) return source === null ? true : false;
			return;
		}
	},
	async copy(path, dest) {
		try {
			await copyFile(path, dest);
			return {
				kind: "copied",
				size: (await stat(dest)).size
			};
		} catch (error) {
			if (isEnoent(error)) {
				if (await stat(path).catch(() => void 0) === void 0) return { kind: "absent" };
			}
			return {
				kind: "failed",
				message: error instanceof Error ? error.message : String(error)
			};
		}
	},
	async size(path) {
		try {
			const st = await stat(path);
			return st.isFile() ? st.size : void 0;
		} catch {
			return;
		}
	},
	isLink: isLinkPath
};
/** Sanitize a call id into a safe file name. */
function safeFileId(callId) {
	return callId.replace(/[^a-zA-Z0-9._-]/g, "_");
}
/**
* Sanitize a session id into a safe path segment. Real ids are harness-minted
* UUIDs (a no-op here), but a hostile or malformed id must never traverse out
* of the snapshot root — `.` and `..` are the only bare values the charset
* permits that would alias the root or its parent.
*/
function safeSessionId(sessionId) {
	const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
	return safe === ".." || safe === "." ? "session" : safe;
}
/**
* Atomic JSON file write: serialize to a sibling temp file, then rename over
* the target. A crash between the two steps leaves only the temp — never a
* readable half-written target — and rename is atomic, so readers always see
* either the old file or the complete new one. The temp name is deterministic
* (`<target>.tmp`): a crash-leftover temp is overwritten by the next write of
* the same target and is never picked up by readers (it does not end in
* `.json`). `afterTempWrite` is the test-only crash seam between the steps.
*/
async function writeJsonAtomic(file, data, afterTempWrite) {
	const tmp = `${file}.tmp`;
	await writeFile(tmp, JSON.stringify(data), "utf8");
	afterTempWrite?.();
	await rename(tmp, file);
}
const RESTORE_JOURNAL_STATES = new Set([
	"running",
	"rollback-running",
	"completed",
	"rolled-back",
	"recovery-required"
]);
/** True when a serialized journal reference has a readable shape. */
function isRawJournalRef(value) {
	if (value === null) return true;
	if (typeof value === "string") return true;
	if (typeof value !== "object") return false;
	const ref = value;
	return typeof ref.blob === "string" || typeof ref.text === "string";
}
/**
* Structural validation of a parsed journal. Unlike checkpoint entries (whose
* corruption is silently skipped), a corrupt journal is reported
* fail-loud by `reconcileRestores` — silently dropping it would silently
* erase the ability to recover the interrupted restore.
*
* Accepts both formats: `version: 2` (byte references), the released
* `version: 1` (inline strings) and the legacy prefix that carried no
* `version` at all — but never best-effort-coerces a malformed action.
*/
function isRestoreJournal(value) {
	if (typeof value !== "object" || value === null) return false;
	const v = value;
	if (typeof v.id !== "string" || typeof v.sessionId !== "string" || typeof v.targetSeq !== "number") return false;
	if (v.version !== void 0 && v.version !== 1 && v.version !== 2) return false;
	if (typeof v.state !== "string" || !RESTORE_JOURNAL_STATES.has(v.state)) return false;
	if (!Array.isArray(v.actions)) return false;
	return v.actions.every((action) => {
		if (typeof action !== "object" || action === null) return false;
		const a = action;
		if (typeof a.path !== "string" || a.action !== "restore" && a.action !== "delete") return false;
		if (typeof a.done !== "boolean") return false;
		if (!isRawJournalRef(a.before) || !isRawJournalRef(a.rescue)) return false;
		if (a.action === "restore" && a.before === null) return false;
		return true;
	});
}
/** Convert one serialized journal reference into an in-memory byte source. */
function refToSource(raw, sessionDir) {
	if (raw === null) return null;
	if (typeof raw === "string") return textSourceOf(raw);
	if (typeof raw !== "object") return void 0;
	const ref = raw;
	if (typeof ref.blob === "string") {
		if (!isSafeBackupRef(ref.blob)) return void 0;
		return {
			kind: "blob",
			path: join(sessionDir, ref.blob)
		};
	}
	if (typeof ref.text === "string") return textSourceOf(ref.text);
}
/** Serialize one byte source as a session-relative journal reference. */
function sourceToRef(source, sessionDir, entryPath) {
	if (source === null) return null;
	if (source.kind === "blob") {
		const blob = relative(sessionDir, source.path);
		if (!isSafeBackupRef(blob)) throw new Error(`unsafe backup ref ${blob} for ${entryPath}`);
		return { blob };
	}
	return { text: source.kind === "text" ? source.bytes.toString("utf8") : source.text };
}
/** Serialized (on-disk) form of a journal action. */
function journalToJson(journal, sessionDir) {
	return {
		version: 2,
		id: journal.id,
		sessionId: journal.sessionId,
		targetSeq: journal.targetSeq,
		startedAt: journal.startedAt,
		...journal.finishedAt !== void 0 ? { finishedAt: journal.finishedAt } : {},
		state: journal.state,
		actions: journal.actions.map((action) => ({
			path: action.path,
			action: action.action,
			before: sourceToRef(action.before, sessionDir, action.path),
			rescue: sourceToRef(action.rescue, sessionDir, action.path),
			...action.rescueError !== void 0 ? { rescueError: action.rescueError } : {},
			...action.mode !== void 0 ? { mode: action.mode } : {},
			...action.rescueMode !== void 0 ? { rescueMode: action.rescueMode } : {},
			...action.parent !== void 0 ? { parent: action.parent } : {},
			done: action.done,
			...action.failed !== void 0 ? { failed: action.failed } : {}
		})),
		...journal.rollbackError !== void 0 ? { rollbackError: journal.rollbackError } : {}
	};
}
/** Parse a validated journal's raw shape into the in-memory form. */
function journalFromJson(raw, sessionDir) {
	const actions = [];
	for (const value of raw.actions) {
		const before = refToSource(value.before, sessionDir);
		const rescue = refToSource(value.rescue, sessionDir);
		if (before === void 0 || rescue === void 0) return void 0;
		actions.push({
			path: value.path,
			action: value.action,
			before: value.action === "delete" ? null : before,
			rescue,
			...typeof value.rescueError === "string" ? { rescueError: value.rescueError } : {},
			...typeof value.mode === "number" ? { mode: value.mode } : {},
			...typeof value.rescueMode === "number" ? { rescueMode: value.rescueMode } : {},
			...typeof value.parent === "string" && value.parent.length > 0 ? { parent: value.parent } : {},
			done: value.done,
			...typeof value.failed === "string" ? { failed: value.failed } : {}
		});
	}
	return {
		version: raw.version === 1 ? 1 : 2,
		id: raw.id,
		sessionId: raw.sessionId,
		targetSeq: raw.targetSeq,
		startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
		...typeof raw.finishedAt === "number" ? { finishedAt: raw.finishedAt } : {},
		state: raw.state,
		actions,
		...typeof raw.rollbackError === "string" ? { rollbackError: raw.rollbackError } : {}
	};
}
/** True when a session-dir member is a restore journal (either prefix). */
function isJournalName(name$1) {
	if (!name$1.endsWith(".json")) return false;
	return name$1.startsWith(JOURNAL_PREFIX) || name$1.startsWith(LEGACY_JOURNAL_PREFIX);
}
/** The op id encoded in a journal file name. */
function journalOpIdOf(name$1) {
	const prefix = name$1.startsWith(LEGACY_JOURNAL_PREFIX) ? LEGACY_JOURNAL_PREFIX : JOURNAL_PREFIX;
	return name$1.slice(prefix.length, -5);
}
/** The entry file name one call id maps to (the single naming function). */
function entryFileName(callId) {
	return `${safeFileId(callId)}-${shortHash(callId)}.json`;
}
/** Stable 8-hex digest of an arbitrary string (ids, paths, capture keys). */
function shortHash(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
/** The sidecar file name of one entry file (`<base>.json` → `<base>.before`). */
function sidecarName(entryFile) {
	return `${entryFile.slice(0, -5)}${SIDECAR_SUFFIX}`;
}
/** Anchor seq encoded in a link `ref` (`<anchorSeq>/<file>.json`). */
function refAnchorOf(ref) {
	const slash = ref.indexOf("/");
	return slash === -1 ? NaN : Number(ref.slice(0, slash));
}
/** Serialize one in-memory entry for disk (the current byte format). */
function entryToJson(entry) {
	const base = {
		store: 2,
		callId: entry.callId,
		file: entry.path,
		time: entry.time,
		...entry.parent !== void 0 ? { parent: entry.parent } : {},
		...entry.mode !== void 0 ? { mode: entry.mode } : {},
		...entry.lossy === true ? { lossy: true } : {}
	};
	if (entry.before === null) return {
		...base,
		blob: null,
		size: 0
	};
	if (entry.before.kind !== "blob") throw new Error(`entry for ${entry.path} is not blob-backed`);
	return {
		...base,
		blob: basename(entry.before.path),
		size: entry.size
	};
}
/** Serialize one in-memory dedup link for disk (the current byte format). */
function linkToJson(link) {
	return {
		store: 2,
		callId: link.callId,
		file: link.path,
		ref: link.ref,
		time: link.time,
		...link.parent !== void 0 ? { parent: link.parent } : {}
	};
}
/**
* Read one committed entry, or undefined when missing/corrupt. Accepts both
* formats: the current byte format (`store: 2`, `file`, `blob` + sidecar) and
* the released v1 format (`anchorSeq` + inline `before` string).
*
* The byte format deliberately does NOT carry `anchorSeq` (it equals the
* parent directory) and does NOT reuse the v1 key names — a downgraded v1
* build rejects such an entry instead of reading it as "created", which is
* what keeps a downgrade from deleting workspace files. See
* `tests/downgrade-safety.test.ts`.
*/
async function readEntry(file, anchorSeq) {
	let parsed;
	try {
		const value = JSON.parse(await readFile(file, "utf8"));
		if (typeof value !== "object" || value === null) return void 0;
		parsed = value;
	} catch {
		return;
	}
	if (typeof parsed.store === "number" && parsed.store > CURRENT_STORE_VERSION) throw new UnknownStoreVersionError(parsed.store, file);
	const callId = String(parsed.callId ?? "");
	const time = typeof parsed.time === "number" ? parsed.time : 0;
	const origin = { file };
	if (parsed.store === 2) {
		if (typeof parsed.file !== "string") return void 0;
		const parent = typeof parsed.parent === "string" && parsed.parent.length > 0 ? parsed.parent : void 0;
		const base$1 = {
			callId,
			anchorSeq,
			path: parsed.file,
			time,
			...parent !== void 0 ? { parent } : {},
			...origin
		};
		if (typeof parsed.ref === "string") return {
			...base$1,
			ref: parsed.ref
		};
		if (parsed.blob === null) {
			if (parsed.lossy === true) return void 0;
			if (typeof parsed.size === "number" && parsed.size !== 0) return void 0;
			return {
				...base$1,
				before: null,
				size: 0
			};
		}
		if (typeof parsed.blob !== "string") return void 0;
		if (parsed.blob !== sidecarName(basename(file))) return void 0;
		const size = typeof parsed.size === "number" && parsed.size >= 0 ? parsed.size : 0;
		const mode = typeof parsed.mode === "number" ? parsed.mode : void 0;
		if (parsed.lossy === true) try {
			const text = await readFile(join(dirname(file), parsed.blob), "utf8");
			return {
				...base$1,
				before: {
					kind: "lossyText",
					text
				},
				size,
				lossy: true,
				...mode !== void 0 ? { mode } : {}
			};
		} catch {
			return;
		}
		return {
			...base$1,
			before: {
				kind: "blob",
				path: join(dirname(file), parsed.blob)
			},
			size,
			...mode !== void 0 ? { mode } : {}
		};
	}
	if (typeof parsed.path !== "string" || typeof parsed.anchorSeq !== "number") return void 0;
	const base = {
		callId,
		anchorSeq: parsed.anchorSeq,
		path: parsed.path,
		time,
		...origin
	};
	if (typeof parsed.ref === "string") return {
		...base,
		ref: parsed.ref
	};
	if (parsed.before !== null && typeof parsed.before !== "string") return void 0;
	if (parsed.before === null) return {
		...base,
		before: null,
		size: 0
	};
	return {
		...base,
		before: textSourceOf(parsed.before),
		size: Buffer.byteLength(parsed.before, "utf8")
	};
}
/** Recursive byte total of a directory tree (never follows symlinks). */
async function dirBytes(dir) {
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return 0;
	}
	let total = 0;
	for (const name$1 of names) {
		const full = join(dir, name$1);
		const st = await lstat(full).catch(() => void 0);
		if (st === void 0) continue;
		if (st.isDirectory()) total += await dirBytes(full);
		else if (st.isFile()) total += st.size;
	}
	return total;
}
/**
* True when the path is a symlink or a hard link (nlink > 1) — both are never
* written through on restore: a symlink would redirect the write to its target
* (bypassing the checkpoint), and a hard link would clobber every other name
* pointing at the same inode (e.g. pnpm-installed files). Mirrors Claude Code's
* "symlinked and hard-linked paths not restored".
*/
async function isLinkPath(path) {
	try {
		const stat$1 = await lstat(path);
		return stat$1.isSymbolicLink() || stat$1.nlink > 1;
	} catch {
		return false;
	}
}
/**
* The nearest ancestor of `dir` (inclusive) that exists on disk, or undefined
* when even the root is gone. Used to decide whether a MISSING parent chain can
* be recreated safely (see {@link parentStillMatches}).
*/
async function nearestExistingAncestor(dir) {
	let current = dir;
	for (;;) {
		if (await lstat(current).catch(() => void 0) !== void 0) return current;
		const parent = dirname(current);
		if (parent === current) return void 0;
		current = parent;
	}
}
/**
* True when `path`'s parent directory still resolves where it did at checkpoint
* time (`recorded`, the entry's location pin). Only the path's FINAL component
* is link-checked (see {@link isLinkPath}); without this a repointed ancestor
* directory would redirect a restore — or, worse, an unlink — outside the
* recorded location.
*
* - no pin (a legacy entry, or a commit that could not resolve its parent) →
*   true: the released behavior is preserved;
* - the parent resolves to the pinned location → true. A STABLE symlinked
*   ancestor resolves identically on both sides (the pin is a `realpath`), so
*   a symlinked workspace root is never a false skip;
* - the parent resolves elsewhere → false;
* - the parent chain is gone → true only while the nearest surviving ancestor
*   still resolves INSIDE the pinned location, which keeps "recreate a deleted
*   parent directory" working without following a repointed ancestor;
* - anything undecidable (a link loop, an unreadable component) → false:
*   refuse rather than write into a location that cannot be verified.
*/
async function parentStillMatches(path, recorded) {
	if (recorded === void 0) return true;
	const dir = dirname(path);
	try {
		return await realpath(dir) === recorded;
	} catch (error) {
		if (!isEnoent(error)) return false;
	}
	const ancestor = await nearestExistingAncestor(dir);
	if (ancestor === void 0) return false;
	try {
		const inside = relative(await realpath(ancestor), recorded);
		const escapes = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
		return inside !== "" && !escapes;
	} catch {
		return false;
	}
}
/**
* True when a dedup-link `ref` is a SAFE relative reference to a checkpoint
* entry — `<digits>/<callId>.json`, a single level below the session dir, with
* no traversal or absolute segment. The plugin always writes refs this way
* ({@link SnapshotStore.entryRefOf}); this validates a `ref` read back from
* disk so a hostile or corrupt ref can never escape the store root when a
* restore resolution or prune materialization follows it (mirrors the
* `safeSessionId` / `safeFileId` containment guarantee).
*/
function isSafeLinkRef(ref) {
	return /^[0-9]+\/[a-zA-Z0-9._-]+\.json$/.test(ref);
}
/**
* True when a journal's byte reference is SAFE and relative to the session
* dir: either `<digits>/<name>.before` (an entry sidecar) or
* `rescue/<opId>/<index>.before` (a rescue copy). Validated on both write and
* read, so a corrupt or hostile journal can never point a restore or a
* rollback outside the store (`..`, absolute paths and unknown roots are
* rejected).
*/
function isSafeBackupRef(ref) {
	if (ref.length === 0 || ref.startsWith("/") || ref.includes("\\")) return false;
	const segments = ref.split("/");
	if (segments.length !== 2 && segments.length !== 3) return false;
	if (segments.length === 3 && segments[0] !== RESCUE_DIR) return false;
	return segments.every((segment) => segment !== "." && segment !== ".." && /^[a-zA-Z0-9._-]+$/.test(segment));
}
/**
* Walk one directory tree and compute the total size (regular files only) and
* the newest stamp (max `lstat.mtimeMs` over every member, directories
* included). `lstat` never follows a symlink, so a hostile symlink inside the
* store cannot escape the root or inflate the measurement; a symlink is
* counted as one file's own metadata and not descended into. Directory members
* beginning with `.` (atomic-write temp leftovers, editor droppings) are
* skipped — they are never checkpoint entries.
*/
async function dirSizeAndLastActive(dir) {
	let size = 0;
	let lastActiveMs = 0;
	const visit = async (current) => {
		let st;
		try {
			st = await lstat(current);
		} catch {
			return;
		}
		if (st.mtimeMs > lastActiveMs) lastActiveMs = st.mtimeMs;
		if (!st.isDirectory()) {
			size += st.size;
			return;
		}
		let names;
		try {
			names = await readdir(current);
		} catch {
			return;
		}
		for (const name$1 of names) {
			if (name$1.startsWith(".") && name$1 !== PENDING_DIR) continue;
			await visit(join(current, name$1));
		}
	};
	await visit(dir);
	return {
		size,
		lastActiveMs
	};
}
/**
* On-disk checkpoint store. Every write goes straight through `node:fs`, so a
* restore reliably lands on the real file system.
*/
var SnapshotStore = class SnapshotStore {
	/** Debounce window for the per-commit prune (keeps the readdir+sort off the hot path). */
	static PRUNE_INTERVAL_MS = 1e3;
	/** Session-format-version marker file inside the session dir. Non-`.json`, so it never counts as a checkpoint entry. */
	static FORMAT_FILE = "format";
	/** Plugin STORE-format marker file inside the session dir (non-`.json`, same reasoning). */
	static STORE_FILE = "store";
	lastPruneAt = 0;
	/**
	* Monotonic entry clock. Date.now() has 1ms precision, so back-to-back
	* commits in the same millisecond would TIE on the entry `time` field and
	* entriesAfter's (anchorSeq, time) sort would fall back to the readdir
	* order — filesystem-dependent, so a re-read could pick the WRONG "earliest"
	* version for a path. Bumping past the previous commit keeps the capture
	* order reproducible after a re-read. The read-modify-write below is
	* synchronous (before the first await), so concurrent commits can never
	* observe the same value. Across restarts wall-clock monotonicity holds
	* (restart gaps dwarf 1ms); a backwards NTP step is the only way to break
	* it, and even then the in-process order still holds.
	*/
	lastEntryTime = 0;
	/** Store options; `dedup` toggles in-place content dedup (default on). */
	dedup;
	/**
	* Per-file backup cap in bytes; `<= 0` means no cap. Capture paths consult it
	* and the restore planner refuses a pre-cap record over an over-cap file.
	*/
	maxFileBytes;
	/**
	* Newest anchor groups (user messages) kept per session; `prune` evicts past
	* this bound. A `Config` field (`maxAnchorGroups`).
	*/
	maxAnchorGroups;
	/** Resolved checkpoint store root (absolute); see the constructor's fallback. */
	root;
	/**
	* In-memory per-path "most recent entry" for content dedup, keyed by
	* `<sessionId>\0<path>`. Each value holds the entry's effective byte source
	* (a handle, not a copy) and its own file ref, so a new record with the same
	* content links to the immediately-prior entry (linear chain). Seeded lazily
	* per session from the bounded on-disk window, so dedup survives a host
	* restart. A handle whose bytes vanished (pruned out of band) is treated as
	* "never recorded" — dedup then stores MORE, never less.
	*/
	lastEntry = /* @__PURE__ */ new Map();
	/** Sessions whose dedup state has been seeded from disk this process. */
	seededSessions = /* @__PURE__ */ new Set();
	/** Sessions whose store-format marker this process has already stamped. */
	storeStamped = /* @__PURE__ */ new Set();
	/**
	* Session-format version snapshots are anchored under, stamped into each
	* session's `format` marker when an entry is recorded. `null` until the host
	* sets it (from `agent/created`), so a session that never records is
	* never materialized and a marker is only written where snapshots exist.
	*/
	formatVersion = null;
	constructor(root, opts) {
		this.dedup = opts?.dedup ?? true;
		this.maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
		this.maxAnchorGroups = opts?.maxAnchorGroups ?? MAX_ANCHOR_GROUPS;
		this.root = root ?? join(resolveDshHome(opts?.dshHome), SNAPSHOT_DIR_NAME);
	}
	/** Absolute path of one session's snapshot directory (id sanitized). */
	sessionDir(sessionId) {
		return join(this.root, safeSessionId(sessionId));
	}
	/**
	* True when `size` bytes is over the per-file cap, so it must not be backed
	* up. `undefined` (a backend that cannot report a size) answers false: the
	* guard fails toward STORING, never toward calling a file too big on a guess.
	*/
	isOverFileCap(size) {
		return this.maxFileBytes > 0 && size !== void 0 && size > this.maxFileBytes;
	}
	/** The cap in force, for reporting (0 = unlimited). */
	get fileCapBytes() {
		return this.maxFileBytes;
	}
	/** Absolute path of one anchor group directory. */
	anchorDir(sessionId, anchorSeq) {
		return join(this.sessionDir(sessionId), String(anchorSeq));
	}
	/** Absolute file ref (relative to the session dir) of an entry. */
	entryRefOf(sessionId, callId, anchorSeq) {
		return `${anchorSeq}/${entryFileName(callId)}`;
	}
	/**
	* The session-relative ref of an entry READ from disk: the file that really
	* holds it. A v1 entry keeps its released name, so recomputing the name from
	* the call id would produce a dangling reference.
	*/
	refOfRead(sessionId, entry) {
		if (entry.file !== void 0) return relative(this.sessionDir(sessionId), entry.file);
		return this.entryRefOf(sessionId, entry.callId, entry.anchorSeq);
	}
	/** Drop every in-memory trace of one session (its directory is gone). */
	forgetSession(sessionId) {
		this.seededSessions.delete(sessionId);
		this.storeStamped.delete(sessionId);
		for (const key of [...this.lastEntry.keys()]) if (key.startsWith(`${sessionId}\0`)) this.lastEntry.delete(key);
	}
	/**
	* Forget in-memory state for sessions whose directory no longer exists —
	* after a sweep, or after the user removed a session dir out of band. A
	* stale handle is SAFE (dedup and the boundary both fail toward storing
	* more), but keeping it means the store holds state for a session it deleted
	* and skips re-stamping that session's `format`/`store` markers.
	*/
	async forgetMissingSessions() {
		const known = new Set([...this.seededSessions, ...this.storeStamped]);
		for (const key of this.lastEntry.keys()) {
			const separator = key.indexOf("\0");
			if (separator !== -1) known.add(key.slice(0, separator));
		}
		for (const sessionId of known) if (!await this.exists(this.sessionDir(sessionId)).catch(() => true)) this.forgetSession(sessionId);
	}
	/**
	* Stage a capture slot for one tool call: create the session's `.pending/`
	* area and return the absolute path the caller copies the before-bytes into
	* (never through memory). The slot lives inside the session dir so the
	* commit can `rename` it into the anchor group atomically; a slot that is
	* never committed is either unlinked by its caller or collected by `prune`.
	*/
	async stageCapture(sessionId, key) {
		const dir = join(this.sessionDir(sessionId), PENDING_DIR);
		await mkdir(dir, { recursive: true });
		return join(dir, `${safeFileId(key)}-${shortHash(key)}${SIDECAR_SUFFIX}`);
	}
	/**
	* Seed a session's dedup state from the existing (bounded) on-disk window:
	* scan entries newest-first and record the most recent entry per path. This
	* makes content dedup survive a host restart within the session window. A
	* no-op after the first seed (or when `dedup` is disabled).
	*/
	async ensureDedupSeeded(sessionId) {
		if (!this.dedup || this.seededSessions.has(sessionId)) return;
		this.seededSessions.add(sessionId);
		try {
			for (const entry of await this.entriesAfter(sessionId, 0)) {
				const key = `${sessionId}\0${entry.path}`;
				if (this.lastEntry.has(key)) continue;
				const source = await this.resolveBefore(sessionId, entry);
				this.lastEntry.set(key, {
					source,
					ref: this.refOfRead(sessionId, entry)
				});
			}
		} catch {
			this.seededSessions.delete(sessionId);
		}
	}
	/**
	* Resolve an entry's effective `before` content, following a link chain to
	* its terminal real snapshot. Refs are strictly backward in
	* `(anchorSeq, time)`, so the chain is acyclic and finite. A dangling or
	* cyclic link throws — callers fail per-file (never silently dropping the
	* path from a restore).
	*/
	async resolveBefore(sessionId, entry, seen = /* @__PURE__ */ new Set()) {
		if (!isLinkEntry(entry)) return this.validatedSource(entry);
		const key = `${entry.anchorSeq}:${entry.callId}`;
		if (seen.has(key)) throw new Error(`link cycle at ${entry.path} (${key})`);
		seen.add(key);
		if (!isSafeLinkRef(entry.ref)) throw new Error(`unsafe link ref ${entry.ref} for ${entry.path}`);
		const referenced = await readEntry(join(this.sessionDir(sessionId), entry.ref), refAnchorOf(entry.ref));
		if (referenced === void 0) throw new Error(`dangling link ${entry.ref} for ${entry.path}`);
		return this.resolveBefore(sessionId, referenced, seen);
	}
	/**
	* Validate a real entry's byte source against the store's own files: a
	* sidecar that is missing, not a regular file, or a different size than the
	* metadata records is an INTEGRITY failure (thrown), never a silent skip and
	* never a fallback to "the file was created" — a restore must not delete a
	* file whose backup it cannot read.
	*/
	async validatedSource(entry) {
		const source = entry.before;
		if (source === null || source.kind !== "blob") return source;
		const st = await stat(source.path).catch((error) => {
			if (isEnoent(error)) throw new Error(`missing backup sidecar ${source.path} for ${entry.path}`);
			throw error;
		});
		if (!st.isFile()) throw new Error(`backup sidecar is not a file: ${source.path}`);
		if (st.size !== entry.size) throw new Error(`backup sidecar size mismatch for ${entry.path} (recorded ${entry.size}, found ${st.size})`);
		return source;
	}
	/**
	* True when two recorded byte sources are the same content. Comparison is
	* STREAMING (size first, then chunks) so large files never enter memory.
	* Any unreadable handle — or any legacy lossy source, whose original bytes
	* are unknowable — answers `false`: dedup must fail toward storing more,
	* never toward claiming "unchanged".
	*/
	async sourcesMatch(a, b) {
		if (a === null || b === null) return a === null && b === null;
		try {
			if (a.kind === "blob" && b.kind === "blob") return await sameFileBytes(a.path, b.path);
			if (a.kind === "text" && b.kind === "text") return a.bytes.equals(b.bytes);
			if (a.kind === "blob" && b.kind === "text") return await sameFileBuffer(a.path, b.bytes);
			if (a.kind === "text" && b.kind === "blob") return await sameFileBuffer(b.path, a.bytes);
			return false;
		} catch {
			return false;
		}
	}
	/**
	* Write raw bytes to a sidecar path atomically (temp + rename): a crash
	* between the steps leaves only a `.tmp` that no reader picks up.
	*/
	async writeSidecar(dest, source) {
		const tmp = `${dest}.tmp`;
		if (source.kind === "blob") await copyFile(source.path, tmp);
		else if (source.kind === "text") await writeFile(tmp, source.bytes);
		else await writeFile(tmp, Buffer.from(source.text, "utf8"));
		await rename(tmp, dest);
	}
	/**
	* Place one entry's sidecar next to its entry file: MOVE a staged capture
	* (same filesystem, atomic) or write the bytes from a source. Returns the
	* blob source and its size, or null for a created file. The sidecar is
	* always complete before the entry JSON is written.
	*/
	async placeSidecar(entryFile, content) {
		if (content.source === null) return null;
		const dest = join(dirname(entryFile), sidecarName(basename(entryFile)));
		if (content.staged !== void 0) await rename(content.staged.file, dest);
		else await this.writeSidecar(dest, content.source);
		const st = await stat(dest);
		return {
			source: {
				kind: "blob",
				path: dest
			},
			size: st.size
		};
	}
	/**
	* Commit one entry (a full before-backup or an in-place dedup link) under
	* its anchor group.
	*/
	async commit(sessionId, entry, content, opts) {
		const time = Math.max(Date.now(), this.lastEntryTime + 1);
		this.lastEntryTime = time;
		const parent = await realpath(dirname(entry.path)).catch(() => void 0);
		await this.ensureDedupSeeded(sessionId);
		await this.assertKnownStoreVersion(sessionId);
		const dir = this.anchorDir(sessionId, entry.anchorSeq);
		await mkdir(dir, { recursive: true });
		const file = join(dir, entryFileName(entry.callId));
		const selfRef = this.entryRefOf(sessionId, entry.callId, entry.anchorSeq);
		const key = `${sessionId}\0${entry.path}`;
		const prior = this.lastEntry.get(key);
		const incoming = content.source === null ? null : content.staged !== void 0 ? {
			kind: "blob",
			path: content.staged.file
		} : content.source;
		if (this.dedup && opts?.dedup !== false && prior !== void 0 && await this.sourcesMatch(prior.source, incoming)) {
			const committed = {
				callId: entry.callId,
				anchorSeq: entry.anchorSeq,
				path: entry.path,
				ref: prior.ref,
				...parent !== void 0 ? { parent } : {},
				time
			};
			if (content.staged !== void 0) await rm(content.staged.file, { force: true });
			await writeJsonAtomic(file, linkToJson(committed), () => opts?.crash?.("after-temp-write"));
			this.lastEntry.set(key, {
				source: prior.source,
				ref: selfRef
			});
		} else {
			const placed = await this.placeSidecar(file, content);
			const committed = {
				callId: entry.callId,
				anchorSeq: entry.anchorSeq,
				path: entry.path,
				before: placed?.source ?? null,
				size: placed?.size ?? 0,
				...incoming?.kind === "lossyText" ? { lossy: true } : {},
				...content.mode !== void 0 ? { mode: content.mode } : {},
				...parent !== void 0 ? { parent } : {},
				time
			};
			await writeJsonAtomic(file, entryToJson(committed), () => opts?.crash?.("after-temp-write"));
			this.lastEntry.set(key, {
				source: committed.before,
				ref: selfRef
			});
		}
		if (this.formatVersion !== null) await this.markFormatVersion(sessionId, this.formatVersion);
		if (!this.storeStamped.has(sessionId)) {
			await this.markStoreVersion(sessionId, CURRENT_STORE_VERSION);
			this.storeStamped.add(sessionId);
		}
		const now = Date.now();
		if (now - this.lastPruneAt >= SnapshotStore.PRUNE_INTERVAL_MS) {
			this.lastPruneAt = now;
			await this.prune(sessionId);
		}
	}
	/**
	* Commit one before-backup whose content the caller already holds as raw
	* text (the boundary-friendly API: tests, synthetic records). The bytes are
	* encoded UTF-8, exactly as the released v1 build did for text content.
	*/
	async recordEntry(sessionId, entry, opts) {
		await this.commit(sessionId, entry, { source: entry.before === null ? null : textSourceOf(entry.before) }, opts);
	}
	/**
	* Commit one before-backup whose content is an existing byte file (the
	* capture and boundary paths): `backup.file` is MOVED into the anchor group
	* (same filesystem, so this is atomic), or `null` when the file did not
	* exist — a creation.
	*/
	async recordBackup(sessionId, entry, backup, opts) {
		await this.commit(sessionId, entry, {
			source: backup === null ? null : {
				kind: "blob",
				path: backup.file
			},
			...backup !== null ? { staged: { file: backup.file } } : {},
			...backup?.mode !== void 0 ? { mode: backup.mode } : {}
		}, opts);
	}
	/**
	* The byte source recorded by the path's MOST RECENT entry, or undefined
	* when the path has never been recorded (a fresh tracking sight). This is
	* the single in-memory "last known state" the boundary compares the disk
	* against — the same source `recordEntry` dedups against, so there is one
	* handle and one comparison per decision, not two. Seeding is idempotent
	* (once per session from disk).
	*/
	async lastKnownContent(sessionId, path) {
		await this.ensureDedupSeeded(sessionId);
		return this.lastEntry.get(`${sessionId}\0${path}`)?.source;
	}
	/**
	* All committed entries anchored at or after `targetSeq`, newest first (for
	* preview ordering). The boundary is inclusive: rewinding to a message also
	* reverts the changes its own turn caused (the rewind cut removes that
	* turn's assistant response and tool calls), so only entries anchored at
	* earlier messages survive.
	*/
	async entriesAfter(sessionId, targetSeq) {
		const sessionDir = this.sessionDir(sessionId);
		let names;
		try {
			names = await readdir(sessionDir);
		} catch (error) {
			if (error.code === "ENOENT") return [];
			throw error;
		}
		const entries = [];
		for (const name$1 of names) {
			const anchorSeq = Number(name$1);
			if (!Number.isSafeInteger(anchorSeq) || anchorSeq < targetSeq) continue;
			const files = await readdir(this.anchorDir(sessionId, anchorSeq)).catch(() => []);
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const entry = await readEntry(join(this.anchorDir(sessionId, anchorSeq), file), anchorSeq);
				if (entry !== void 0) entries.push(entry);
			}
		}
		return entries.sort((a, b) => b.anchorSeq - a.anchorSeq || b.time - a.time);
	}
	/**
	* Per-path EARLIEST committed entry anchored at or after the target — the
	* single source of truth for both restore and impact preview.
	*/
	async earliestEntries(sessionId, targetSeq) {
		const earliest = /* @__PURE__ */ new Map();
		for (const entry of await this.entriesAfter(sessionId, targetSeq)) {
			const current = earliest.get(entry.path);
			if (current === void 0 || entry.anchorSeq < current.anchorSeq || entry.anchorSeq === current.anchorSeq && entry.time < current.time) earliest.set(entry.path, entry);
		}
		return earliest;
	}
	/**
	* The single source of truth for BOTH the impact preview and the restore
	* pass: reconcile the earliest recorded entry per path (at/after the
	* target) against the CURRENT on-disk state, and plan only the actions
	* that would actually change the disk. This is the Claude Code model —
	* `fileHistoryGetDiffStats` / `applySnapshot` both compare against the
	* live filesystem (`checkOriginFileChanged`) and count only real
	* differences, so a rewind whose target state already matches the disk is
	* a no-op with zero impact.
	*
	* - `before === null` (the file did not exist at the target) plans a
	*   `delete` ONLY when the file currently exists; an already-absent file
	*   is a no-op — this kills the "ghost impact" of replaying an entry a
	*   previous rewind already consumed.
	* - a recorded byte source plans a `restore` ONLY when the current bytes
	*   differ from it (or the file is missing); identical bytes are a no-op —
	*   this keeps repeated rewinds idempotent.
	* - A released-v1 record that lost bytes to a lossy decode (`lossyText`) is
	*   compared with the same lossy decode but NEVER written back: a skip is
	*   reported instead of destroying live bytes with U+FFFD content.
	* - An unreadable / unresolvable record is a per-file FAILURE, never a
	*   delete: planning a delete for a file we cannot restore is the one
	*   mistake that loses data.
	* - Symlinked / hard-linked paths are never planned (they are reported as
	*   skipped by the restore pass, never written through).
	* - A probe failure (e.g. a permission error reading the file) plans the
	*   action conservatively as if the file differed, so an unreadable file
	*   is never silently dropped from the restore.
	*
	* @param sessionId - session whose snapshot store to plan against.
	* @param targetSeq - rewind target; entries anchored at/after it apply.
	* @param probe - current-disk state probe (defaults to the real FS).
	* @returns the planned actions, the link paths skipped, and per-file failures.
	*/
	async planRestore(sessionId, targetSeq, probe) {
		await this.assertKnownStoreVersion(sessionId);
		const actions = [];
		const skipped = [];
		const failed = [];
		for (const entry of (await this.earliestEntries(sessionId, targetSeq)).values()) {
			let source;
			try {
				source = await this.resolveBefore(sessionId, entry);
			} catch (error) {
				failed.push({
					path: entry.path,
					message: error instanceof Error ? error.message : String(error)
				});
				continue;
			}
			try {
				if (await probe.isLink(entry.path)) {
					skipped.push(entry.path);
					continue;
				}
				if (!await parentStillMatches(entry.path, entry.parent)) {
					skipped.push(entry.path);
					continue;
				}
				if (probe.size !== void 0 && this.isOverFileCap(await probe.size(entry.path))) {
					skipped.push(entry.path);
					continue;
				}
				if (source !== null && source.kind === "lossyText") {
					if (await probe.matches(source, entry.path) !== true) skipped.push(entry.path);
					continue;
				}
				if (await probe.matches(source, entry.path) === true) continue;
				const pin = entry.parent !== void 0 ? { parent: entry.parent } : {};
				if (source === null) actions.push({
					path: entry.path,
					action: "delete",
					...pin
				});
				else {
					const mode = isLinkEntry(entry) ? void 0 : entry.mode;
					actions.push({
						path: entry.path,
						action: "restore",
						before: source,
						...mode !== void 0 ? { mode } : {},
						...pin
					});
				}
			} catch {
				if (source !== null && source.kind === "lossyText") {
					skipped.push(entry.path);
					continue;
				}
				const pin = entry.parent !== void 0 ? { parent: entry.parent } : {};
				if (source === null) actions.push({
					path: entry.path,
					action: "delete",
					...pin
				});
				else actions.push({
					path: entry.path,
					action: "restore",
					before: source,
					...pin
				});
			}
		}
		return {
			actions,
			skipped,
			failed
		};
	}
	/** Per-file restore impact: only actions that would actually change the disk. */
	async impactsAfter(sessionId, targetSeq, probe = defaultProbe) {
		const { actions } = await this.planRestore(sessionId, targetSeq, probe);
		return actions.sort((a, b) => a.path.localeCompare(b.path)).map((action) => ({
			path: action.path,
			action: action.action
		}));
	}
	/**
	* Restore the workspace to the target message's checkpoint: execute exactly
	* the actions {@link planRestore} derived from the record + current disk
	* reconciliation — write the before content back, or delete the file when
	* it was created after the target and still exists. Symlinked and
	* hard-linked paths are skipped (reported, never written through); a
	* restored file's parent directory is created when it was deleted after
	* the backup; a delete whose file is ALREADY absent is a silent no-op (not
	* a failure — the target state is already reached). Failures are per-file
	* and never abort the pass.
	*
	* The pass is journaled for crash safety: the pre-restore ("rescue") state
	* of every planned path is captured and an intent journal persisted BEFORE
	* any mutation, then each action is marked done as it is applied. A host
	* crash at any point leaves the journal on disk; after a restart
	* {@link reconcileRestores} reports where the restore stopped,
	* {@link continueRestore} finishes it and {@link rollbackRestore} undoes it
	* back to the exact pre-restore state. Journal IO itself never fails the
	* restore (it degrades to a journal-less pass).
	*/
	async restoreAfter(sessionId, targetSeq, deleteFile, probe = defaultProbe, opts) {
		const restored = [];
		const deleted = [];
		const skipped = [];
		const failed = [];
		const { actions, skipped: skippedPaths, failed: planFailed } = await this.planRestore(sessionId, targetSeq, probe);
		skipped.push(...skippedPaths);
		failed.push(...planFailed);
		if (actions.length === 0) return {
			restored,
			deleted,
			skipped,
			failed
		};
		const journal = await this.beginRestore(sessionId, targetSeq, actions, probe);
		for (let i = 0; i < actions.length; i++) {
			const action = actions[i];
			opts?.crash?.("before-action", i);
			const journalAction = journal.actions[i];
			let applied;
			try {
				applied = await this.applyActionToDisk(action.action, action.path, action.action === "restore" ? action.before : null, deleteFile, {
					...action.action === "restore" && action.mode !== void 0 ? { mode: action.mode } : {},
					...action.parent !== void 0 ? { parent: action.parent } : {}
				});
				if (applied === "skipped") {
					journalAction.failed = `parent directory moved or repointed: ${dirname(action.path)}`;
					await this.saveJournal(journal);
					failed.push({
						path: action.path,
						message: journalAction.failed
					});
					continue;
				}
				if (applied === "enoent") {
					journalAction.done = true;
					await this.saveJournal(journal);
					continue;
				}
			} catch (error) {
				journalAction.failed = error instanceof Error ? error.message : String(error);
				await this.saveJournal(journal);
				failed.push({
					path: action.path,
					message: journalAction.failed
				});
				continue;
			}
			opts?.crash?.("after-action", i);
			journalAction.done = true;
			await this.saveJournal(journal);
			if (applied === "restored") restored.push(action.path);
			else deleted.push(action.path);
		}
		if (failed.length === 0) {
			journal.state = "completed";
			journal.finishedAt = Date.now();
		}
		await this.saveJournal(journal);
		return {
			restored,
			deleted,
			skipped,
			failed
		};
	}
	/** Absolute path of one restore-op journal file (the current prefix). */
	journalPath(sessionId, opId) {
		return join(this.sessionDir(sessionId), `${JOURNAL_PREFIX}${safeFileId(opId)}.json`);
	}
	/**
	* Locate an existing journal file for an op: the current prefix first, then
	* the prefix the released v1 build wrote (a restore interrupted before the
	* upgrade must still be continuable / rollbackable).
	*/
	async findJournalFile(sessionId, opId) {
		const dir = this.sessionDir(sessionId);
		for (const name$1 of [`${JOURNAL_PREFIX}${safeFileId(opId)}.json`, `${LEGACY_JOURNAL_PREFIX}${safeFileId(opId)}.json`]) {
			const file = join(dir, name$1);
			try {
				await stat(file);
				return file;
			} catch {
				continue;
			}
		}
	}
	/**
	* Best-effort journal persist: journal IO failures are non-fatal by design —
	* a restore must never fail because its audit journal could not be written.
	* reconcileRestores() re-derives the true state from the disk, so a missing
	* or stale journal only loses the trail, never the recovery ability.
	*
	* A journal read back from a legacy file is rewritten IN PLACE (same file),
	* so a redo / rollback of a pre-upgrade op never leaves two divergent
	* versions of the same op on disk.
	*/
	async saveJournal(journal) {
		try {
			await writeJsonAtomic(journal.sourceFile ?? this.journalPath(journal.sessionId, journal.id), journalToJson(journal, this.sessionDir(journal.sessionId)));
		} catch {}
	}
	/**
	* Journal one restore pass before mutating anything: capture the rescue
	* (pre-restore) state of every planned path as a raw byte copy and persist
	* the intent (references only) atomically. Returns the in-memory journal; a
	* persist failure degrades to a journal-less restore (non-fatal, see
	* {@link saveJournal}).
	*/
	async beginRestore(sessionId, targetSeq, actions, probe) {
		const sessionDir = this.sessionDir(sessionId);
		try {
			await this.pruneTerminalJournals(sessionDir, await readdir(sessionDir));
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const id = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		const rescueDir = join(sessionDir, RESCUE_DIR, safeFileId(id));
		let rescueDirReady = false;
		const journalActions = [];
		for (const [index, action] of actions.entries()) {
			let rescue = null;
			let rescueError;
			const dest = join(rescueDir, `${index}${SIDECAR_SUFFIX}`);
			try {
				if (!rescueDirReady) {
					await mkdir(rescueDir, { recursive: true });
					rescueDirReady = true;
				}
				const copied = await probe.copy(action.path, dest);
				if (copied.kind === "copied") rescue = {
					kind: "blob",
					path: dest
				};
				else if (copied.kind === "failed") rescueError = copied.message;
			} catch (error) {
				rescueError = error instanceof Error ? error.message : String(error);
			}
			const rescueMode = (await stat(action.path).catch(() => void 0))?.mode;
			const journalAction = {
				path: action.path,
				action: action.action,
				before: action.action === "restore" ? action.before : null,
				rescue,
				...action.action === "restore" && action.mode !== void 0 ? { mode: action.mode } : {},
				...action.parent !== void 0 ? { parent: action.parent } : {},
				...rescueMode !== void 0 ? { rescueMode: rescueMode & 4095 } : {},
				done: false
			};
			if (rescueError !== void 0) journalAction.rescueError = rescueError;
			journalActions.push(journalAction);
		}
		const journal = {
			version: 2,
			id,
			sessionId,
			targetSeq,
			startedAt: Date.now(),
			state: "running",
			actions: journalActions
		};
		await this.saveJournal(journal);
		return journal;
	}
	/**
	* Read one journal by op id; undefined when it does not exist. A corrupt
	* journal THROWS (fail-loud): unlike checkpoint entries, silently dropping
	* a journal would silently erase the interrupted restore's recovery record.
	*/
	async readJournal(sessionId, opId) {
		const file = await this.findJournalFile(sessionId, opId);
		if (file === void 0) return void 0;
		let parsed;
		try {
			parsed = JSON.parse(await readFile(file, "utf8"));
		} catch (error) {
			throw new Error(`restore journal ${file} is corrupt: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!isRestoreJournal(parsed)) throw new Error(`restore journal ${file} failed schema validation`);
		const journal = journalFromJson(parsed, this.sessionDir(sessionId));
		if (journal === void 0) throw new Error(`restore journal ${file} failed schema validation`);
		journal.sourceFile = file;
		return journal;
	}
	/**
	* Every journal file of a session (both prefixes) — valid ones plus corrupt
	* ones with their error — so reconciliation can report corruption instead of
	* dropping it.
	*/
	async listJournals(sessionId) {
		const sessionDir = this.sessionDir(sessionId);
		let names;
		try {
			names = await readdir(sessionDir);
		} catch (error) {
			if (isEnoent(error)) return {
				journals: [],
				corrupt: []
			};
			throw error;
		}
		const journals = [];
		const corrupt = [];
		for (const name$1 of names) {
			if (!isJournalName(name$1)) continue;
			try {
				const parsed = JSON.parse(await readFile(join(sessionDir, name$1), "utf8"));
				if (!isRestoreJournal(parsed)) {
					corrupt.push({
						file: name$1,
						message: "journal failed schema validation"
					});
					continue;
				}
				const journal = journalFromJson(parsed, sessionDir);
				if (journal === void 0) {
					corrupt.push({
						file: name$1,
						message: "journal references are invalid"
					});
					continue;
				}
				journal.sourceFile = join(sessionDir, name$1);
				journals.push(journal);
			} catch (error) {
				corrupt.push({
					file: name$1,
					message: error instanceof Error ? error.message : String(error)
				});
			}
		}
		return {
			journals,
			corrupt
		};
	}
	/**
	* Execute ONE fs mutation with exactly the pre-journal semantics: a delete
	* runs through the injected deleteFile (ENOENT tolerated — the file is
	* already absent, i.e. the target state is reached), a restore copies the
	* recorded bytes back over the file (creating the parent if needed).
	*
	* This is the only place the store writes restored content to the real FS,
	* and it is deliberately raw `copyFile`/`writeFile`/`unlink` rather than the
	* fs service: the caller only ever hands it a path from `planRestore` — one
	* the session's own write-class tool call recorded and resolved (never a
	* symlink/hard link) and only when it differs from the live disk. So no
	* arbitrary path, no model input, never automatic.
	*
	* The write is IN PLACE (no temp + rename): it keeps the file's inode and
	* thus its xattrs/ACL, and crash safety is provided by the journal plus disk
	* reconciliation instead (a half-written file simply does not match the
	* goal, so a redo rewrites it).
	*
	* Permissions are best-effort (ADR-9/R3): the mode is only ever applied as
	* part of a CONTENT restore (never as a reason to plan one), and a chmod
	* failure never fails the restore.
	*/
	async applyActionToDisk(kind, path, content, deleteFile, opts) {
		if (!await parentStillMatches(path, opts?.parent)) return "skipped";
		if (kind === "delete") try {
			await deleteFile(path);
			return "deleted";
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return "enoent";
		}
		if (content === null) throw new Error(`restore of ${path} has no recorded content`);
		await mkdir(dirname(path), { recursive: true });
		const current = (await stat(path).catch(() => void 0))?.mode;
		let widened = false;
		if (current !== void 0 && (current & 128) === 0) {
			await chmod(path, current | 128).catch(() => void 0);
			widened = true;
		}
		try {
			if (content.kind === "blob") await copyFile(content.path, path);
			else if (content.kind === "text") await writeFile(path, content.bytes);
			else await writeFile(path, Buffer.from(content.text, "utf8"));
		} catch (error) {
			if (widened && current !== void 0) await chmod(path, current).catch(() => void 0);
			throw error;
		}
		if (opts?.mode !== void 0) await chmod(path, opts.mode).catch(() => void 0);
		else if (widened && current !== void 0) await chmod(path, current).catch(() => void 0);
		return "restored";
	}
	/**
	* Reconcile the session's restore journals against the real disk — the
	* "host restart" account: for every interrupted op, report which paths
	* already match its goal (restored) and which are still pending, and expose
	* any recorded failures. Journals whose goal is already fully reached on
	* disk (e.g. a later rewind completed the work) are auto-healed to their
	* terminal state and not reported. A corrupt journal is reported
	* `recovery-required` — never silently dropped.
	*
	* Deliberately NOT gated on the session's `store` marker: a journal is fully
	* self-describing (`version` plus byte references), and refusing to finish an
	* interrupted op merely because the SESSION marker looks newer would strand a
	* half-restored workspace — the outcome the legacy-journal support exists to
	* prevent. A reference the newer build moved shows up as a per-file failure,
	* never as a silent write.
	*
	* @param sessionId - session whose journals to reconcile.
	* @param probe - current-disk state probe (defaults to the real FS).
	* @returns one report per non-terminal journal still needing attention.
	*/
	async reconcileRestores(sessionId, probe = defaultProbe) {
		const { journals, corrupt } = await this.listJournals(sessionId);
		const reports = [];
		for (const bad of corrupt) reports.push({
			opId: journalOpIdOf(bad.file),
			state: "recovery-required",
			journalState: "recovery-required",
			targetSeq: 0,
			startedAt: 0,
			restored: [],
			pending: [],
			failed: [],
			corrupt: bad.message
		});
		for (const journal of journals) {
			if (journal.state === "completed" || journal.state === "rolled-back") continue;
			const report = await this.reconcileJournal(journal, probe);
			if (report !== void 0) reports.push(report);
		}
		return reports.sort((a, b) => a.startedAt - b.startedAt || a.opId.localeCompare(b.opId));
	}
	/**
	* Reconcile ONE non-terminal journal against the real disk. Returns
	* undefined when the op's goal is already fully reached (auto-heals to the
	* terminal state); otherwise a report of restored/pending/failed paths.
	* For `running` journals the goal is the restore target; for
	* `rollback-running` / `recovery-required` journals it is the rescue
	* (pre-restore) state.
	*/
	async reconcileJournal(journal, probe) {
		const rollbackPhase = journal.state === "rollback-running" || journal.state === "recovery-required";
		const restored = [];
		const pending = [];
		const failed = [];
		let allReached = true;
		for (const action of journal.actions) {
			if (action.failed !== void 0) {
				failed.push({
					path: action.path,
					message: action.failed
				});
				allReached = false;
				continue;
			}
			let reached;
			try {
				const goal = rollbackPhase ? action.rescue : action.action === "delete" ? null : action.before;
				reached = await probe.matches(goal, action.path) === true;
			} catch {
				reached = false;
			}
			if (reached) restored.push(action.path);
			else pending.push(action.path);
			if (!reached) allReached = false;
		}
		if (allReached && failed.length === 0) {
			if (rollbackPhase) journal.state = "rolled-back";
			else journal.state = "completed";
			journal.finishedAt = Date.now();
			await this.saveJournal(journal);
			return;
		}
		return {
			opId: journal.id,
			state: journal.state === "recovery-required" ? "recovery-required" : "interrupted",
			journalState: journal.state,
			targetSeq: journal.targetSeq,
			startedAt: journal.startedAt,
			restored,
			pending,
			failed,
			...journal.rollbackError === void 0 ? {} : { rollbackError: journal.rollbackError }
		};
	}
	/**
	* Continue (redo) an interrupted restore: finish the op by applying every action
	* whose disk state does not yet match its goal — the restore target for
	* `running` journals. Actions are decided by the REAL disk (the same "disk
	* is truth" rule as reconciliation), so a crash between an fs op and its
	* done-mark is completed deterministically and a path the user already
	* fixed is marked done without being rewritten. Failed actions are retried;
	* a re-failure re-records the failure. The journal becomes `completed` once
	* every action reaches the target.
	*/
	async continueRestore(sessionId, opId, deleteFile, probe = defaultProbe, opts) {
		const journal = await this.readJournal(sessionId, opId);
		if (journal === void 0) throw new Error(`restore journal ${opId} not found for session ${sessionId}`);
		if (journal.state !== "running") throw new Error(`restore journal ${opId} is in state ${journal.state}; only a running restore can be continued`);
		const restored = [];
		const deleted = [];
		const failed = [];
		for (let i = 0; i < journal.actions.length; i++) {
			const action = journal.actions[i];
			opts?.crash?.("before-action", i);
			let reached;
			try {
				const goal = action.action === "delete" ? null : action.before;
				reached = await probe.matches(goal, action.path) === true;
			} catch {
				reached = false;
			}
			if (reached) {
				action.done = true;
				delete action.failed;
				await this.saveJournal(journal);
				continue;
			}
			let applied;
			try {
				applied = await this.applyActionToDisk(action.action, action.path, action.action === "restore" ? action.before : null, deleteFile, {
					...action.action === "restore" && action.mode !== void 0 ? { mode: action.mode } : {},
					...action.parent !== void 0 ? { parent: action.parent } : {}
				});
				if (applied === "skipped") {
					action.failed = `parent directory moved or repointed: ${dirname(action.path)}`;
					await this.saveJournal(journal);
					failed.push({
						path: action.path,
						message: action.failed
					});
					continue;
				}
				if (applied === "enoent") {
					action.done = true;
					await this.saveJournal(journal);
					continue;
				}
			} catch (error) {
				action.failed = error instanceof Error ? error.message : String(error);
				await this.saveJournal(journal);
				failed.push({
					path: action.path,
					message: action.failed
				});
				continue;
			}
			opts?.crash?.("after-action", i);
			action.done = true;
			delete action.failed;
			await this.saveJournal(journal);
			if (applied === "restored") restored.push(action.path);
			else deleted.push(action.path);
		}
		if (journal.actions.every((action) => action.done) && !journal.actions.some((action) => action.failed !== void 0)) {
			journal.state = "completed";
			journal.finishedAt = Date.now();
			await this.saveJournal(journal);
		}
		return {
			restored,
			deleted,
			skipped: [],
			failed
		};
	}
	/**
	* Roll back an interrupted restore: undo every action whose disk
	* state does not match its rescue (pre-restore) record, returning the
	* workspace to the exact state it had before the restore started. Decided
	* by the REAL disk, so actions the crash left applied-but-unmarked are
	* undone too, and a path already back at its rescue state is skipped —
	* the pass is idempotent across crashes (a retry finishes the remaining
	* actions). The journal moves `running` → `rollback-running` → `rolled-back`;
	* a failed undo leaves it `recovery-required` (retryable), and paths whose
	* rescue capture failed are reported and left untouched.
	*/
	async rollbackRestore(sessionId, opId, deleteFile, probe = defaultProbe, opts) {
		const journal = await this.readJournal(sessionId, opId);
		if (journal === void 0) throw new Error(`restore journal ${opId} not found for session ${sessionId}`);
		if (journal.state === "completed" || journal.state === "rolled-back") throw new Error(`restore journal ${opId} is already ${journal.state}`);
		if (journal.state !== "rollback-running") {
			journal.state = "rollback-running";
			await this.saveJournal(journal);
		}
		const restored = [];
		const deleted = [];
		const failed = [];
		let rollbackFailed = false;
		for (let i = 0; i < journal.actions.length; i++) {
			const action = journal.actions[i];
			if (action.rescueError !== void 0) {
				journal.rollbackError = `rescue unavailable for ${action.path}: ${action.rescueError}`;
				journal.state = "recovery-required";
				await this.saveJournal(journal);
				failed.push({
					path: action.path,
					message: journal.rollbackError
				});
				rollbackFailed = true;
				continue;
			}
			opts?.crash?.("before-action", i);
			let reached;
			try {
				reached = await probe.matches(action.rescue, action.path) === true;
			} catch {
				reached = false;
			}
			if (reached) {
				action.done = false;
				await this.saveJournal(journal);
				continue;
			}
			let applied;
			try {
				applied = await this.applyActionToDisk(action.rescue === null ? "delete" : "restore", action.path, action.rescue, deleteFile, {
					...action.rescueMode !== void 0 ? { mode: action.rescueMode } : {},
					...action.parent !== void 0 ? { parent: action.parent } : {}
				});
				if (applied === "skipped") {
					journal.rollbackError = `parent directory moved or repointed: ${action.path}`;
					journal.state = "recovery-required";
					await this.saveJournal(journal);
					failed.push({
						path: action.path,
						message: journal.rollbackError
					});
					rollbackFailed = true;
					continue;
				}
				if (applied === "enoent") {
					action.done = false;
					await this.saveJournal(journal);
					continue;
				}
			} catch (error) {
				journal.rollbackError = error instanceof Error ? error.message : String(error);
				journal.state = "recovery-required";
				await this.saveJournal(journal);
				failed.push({
					path: action.path,
					message: journal.rollbackError
				});
				rollbackFailed = true;
				continue;
			}
			opts?.crash?.("after-action", i);
			action.done = false;
			await this.saveJournal(journal);
			if (applied === "restored") restored.push(action.path);
			else deleted.push(action.path);
		}
		if (!rollbackFailed) {
			journal.state = "rolled-back";
			journal.finishedAt = Date.now();
			await this.saveJournal(journal);
		}
		return {
			restored,
			deleted,
			skipped: [],
			failed
		};
	}
	/**
	* Drop the session's oldest anchor groups beyond `keep` (default
	* {@link MAX_ANCHOR_GROUPS}), deleting their whole directories. Also
	* recycles terminal restore journals (see {@link pruneTerminalJournals}),
	* so the per-commit cap bounds BOTH the checkpoint entries and the journal
	* accumulation.
	*
	* Because dedup links reference prior entries, eviction is LINK-AWARE: before
	* deleting the oldest groups, any SURVIVING (kept-group) link whose `ref`
	* lands on a real snapshot inside a doomed group is MATERIALIZED (rewritten
	* as a real snapshot carrying the resolved content), so no kept link is left
	* dangling. Links form a linear predecessor chain, so materializing the first
	* link after each doomed real is enough — later links already point at that
	* materialized entry (or at other kept links), requiring no rewrite.
	*
	* `opts.crash` is the test-only seam: a crash fired inside a materialization
	* write (between its temp write and rename) leaves ONLY a `.tmp` — the doomed
	* real is still on disk and the kept link still resolves, so nothing dangles
	* and a later prune simply re-materializes.
	*/
	async prune(sessionId, keep = this.maxAnchorGroups, opts) {
		const sessionDir = this.sessionDir(sessionId);
		let names;
		try {
			names = await readdir(sessionDir);
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		await this.pruneTerminalJournals(sessionDir, names);
		await this.prunePendingCaptures(join(sessionDir, PENDING_DIR));
		const seqs = names.map(Number).filter((seq) => Number.isSafeInteger(seq)).sort((a, b) => a - b);
		const excess = seqs.length - keep;
		if (excess <= 0) return;
		const doomed = new Set(seqs.slice(0, excess));
		for (const seq of await this.pinnedAnchors(sessionDir, names)) doomed.delete(seq);
		if (doomed.size === 0) return;
		for (const seq of seqs.slice(excess)) {
			const files = await readdir(this.anchorDir(sessionId, seq)).catch(() => []);
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const entryFile = join(this.anchorDir(sessionId, seq), file);
				let entry;
				try {
					entry = await readEntry(entryFile, seq);
				} catch {
					continue;
				}
				if (entry === void 0 || !isLinkEntry(entry)) continue;
				if (!isSafeLinkRef(entry.ref)) continue;
				const refAnchor = refAnchorOf(entry.ref);
				if (!Number.isSafeInteger(refAnchor) || !doomed.has(refAnchor)) continue;
				let source;
				try {
					source = await this.resolveBefore(sessionId, entry);
				} catch (error) {
					if (error instanceof UnknownStoreVersionError) throw error;
					continue;
				}
				const pin = entry.parent !== void 0 ? { parent: entry.parent } : {};
				let real;
				if (source === null) real = {
					callId: entry.callId,
					anchorSeq: entry.anchorSeq,
					path: entry.path,
					before: null,
					size: 0,
					...pin,
					time: entry.time
				};
				else {
					const dest = join(dirname(entryFile), sidecarName(basename(entryFile)));
					await this.writeSidecar(dest, source);
					const st = await stat(dest);
					real = {
						callId: entry.callId,
						anchorSeq: entry.anchorSeq,
						path: entry.path,
						before: {
							kind: "blob",
							path: dest
						},
						size: st.size,
						...source.kind === "lossyText" ? { lossy: true } : {},
						...pin,
						time: entry.time
					};
				}
				await writeJsonAtomic(entryFile, entryToJson(real), () => opts?.crash?.("after-temp-write"));
			}
		}
		for (const seq of doomed) await rm(this.anchorDir(sessionId, seq), {
			recursive: true,
			force: true
		});
		this.seededSessions.delete(sessionId);
		for (const key of [...this.lastEntry.keys()]) if (key.startsWith(`${sessionId}\0`)) this.lastEntry.delete(key);
	}
	/**
	* Collect staged captures that were never committed and are older than
	* {@link PENDING_MAX_AGE_MS}: a crash between `tools/execute` and
	* `tools/post-execute` can leak one, and the process that would have
	* unlinked it is gone.
	*/
	async prunePendingCaptures(pendingDir) {
		let names;
		try {
			names = await readdir(pendingDir);
		} catch {
			return;
		}
		const cutoff = Date.now() - PENDING_MAX_AGE_MS;
		for (const name$1 of names) {
			const file = join(pendingDir, name$1);
			const st = await lstat(file).catch(() => void 0);
			if (st === void 0 || !st.isFile() || st.mtimeMs >= cutoff) continue;
			await rm(file, { force: true });
		}
	}
	/**
	* Anchor groups a NON-TERMINAL journal still depends on — the groups holding
	* the sidecars its actions restore from. `prune` must not evict them while
	* the op can still be finished. Rescue copies live under `rescue/`, never in
	* an anchor group, so only `before` references matter; a group is pinned only
	* for a well-formed, safe reference (a corrupt journal pins nothing).
	*/
	async pinnedAnchors(sessionDir, names) {
		const pinned = /* @__PURE__ */ new Set();
		for (const name$1 of names) {
			if (!isJournalName(name$1)) continue;
			let parsed;
			try {
				parsed = JSON.parse(await readFile(join(sessionDir, name$1), "utf8"));
			} catch {
				continue;
			}
			if (!isRestoreJournal(parsed)) continue;
			const journal = journalFromJson(parsed, sessionDir);
			if (journal === void 0) continue;
			if (journal.state === "completed" || journal.state === "rolled-back") continue;
			for (const action of journal.actions) {
				const source = action.before;
				if (source === null || source.kind !== "blob") continue;
				const ref = relative(sessionDir, source.path);
				if (!isSafeBackupRef(ref)) continue;
				const anchor = refAnchorOf(ref);
				if (Number.isSafeInteger(anchor)) pinned.add(anchor);
			}
		}
		return pinned;
	}
	/**
	* Recycle terminal restore journals (`completed` / `rolled-back`): once an
	* op finished, its journal and its rescue bytes are dead weight that would
	* otherwise accumulate without bound (one journal per both-mode rewind).
	* Non-terminal journals (crashed ops awaiting reconcile / continue /
	* rollback) and unclassifiable (corrupt) ones are ALWAYS kept — a recovery
	* record that cannot be classified is never destroyed.
	*/
	async pruneTerminalJournals(sessionDir, names) {
		for (const name$1 of names) {
			if (!isJournalName(name$1)) continue;
			const file = join(sessionDir, name$1);
			try {
				const parsed = JSON.parse(await readFile(file, "utf8"));
				if (parsed.state === "completed" || parsed.state === "rolled-back") {
					await rm(file, { force: true });
					await rm(join(sessionDir, RESCUE_DIR, safeFileId(journalOpIdOf(name$1))), {
						recursive: true,
						force: true
					});
				}
			} catch {}
		}
	}
	/** True when a path exists on disk. */
	async exists(path) {
		try {
			await stat(path);
			return true;
		} catch (error) {
			if (isEnoent(error)) return false;
			throw error;
		}
	}
	/**
	* Cross-session retention sweep: remove WHOLE session directories whose
	* newest member stamp is older than `maxAgeDays` days of idle, keeping the
	* active session (`keepActiveId`) untouched. This is the anti-growth policy
	* for finished sessions (rewind only ever reads the active session, so a
	* finished session's backups are provably dead weight).
	*
	* SAFETY:
	*  - Only whole session directories are removed (dedup refs are
	*    session-relative, so there is no cross-session dangling to materialize);
	*  - the active session is never targeted (`keepActiveId`), and everything
	*    else is protected by its own mtime — a session that is still written to
	*    keeps scrolling its newest member stamp forward, so it is never old
	*    enough to be pruned;
	*  - a non-positive `maxAgeDays` throws instead of degenerating into a
	*    mass-destructive `cutoff` in the far future;
	*  - the walk uses `lstat` (no symlink following) and skips dot-prefixed
	*    temp left overs — except the real `.pending/` area, whose staged bytes
	*    are content and whose freshness is activity — so measurement stays
	*    inside the store root.
	*
	* `dryRun` computes and reports exactly what would be removed without
	* deleting anything — the `/snapshot-auto-cleanup run` preview.
	*/
	async pruneStale(opts) {
		const { keepActiveId, dryRun = false } = opts;
		const maxAgeDays = opts.maxAgeDays;
		if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new RangeError("pruneStale: maxAgeDays must be a positive finite number");
		const cutoffMs = Date.now() - maxAgeDays * 864e5;
		let scanned = 0;
		let deleted = 0;
		let freedBytes = 0;
		let kept = 0;
		let skippedActive = 0;
		let remainingBytes = 0;
		const report = () => ({
			scanned,
			deleted,
			freedBytes,
			kept,
			remainingBytes,
			skippedActive,
			dryRun
		});
		let names;
		try {
			names = await readdir(this.root);
		} catch (error) {
			if (error.code === "ENOENT") return report();
			throw error;
		}
		for (const name$1 of names) {
			if (name$1.startsWith(".")) continue;
			const full = join(this.root, name$1);
			let st;
			try {
				st = await lstat(full);
			} catch {
				continue;
			}
			if (!st.isDirectory()) continue;
			scanned++;
			if (keepActiveId !== void 0 && safeSessionId(keepActiveId) === name$1) {
				skippedActive++;
				remainingBytes += (await dirSizeAndLastActive(full)).size;
				continue;
			}
			const { size, lastActiveMs } = await dirSizeAndLastActive(full);
			if (lastActiveMs < cutoffMs) {
				deleted++;
				freedBytes += size;
				if (!dryRun) await rm(full, {
					recursive: true,
					force: true
				});
			} else {
				kept++;
				remainingBytes += size;
			}
		}
		if (!dryRun) await this.forgetMissingSessions();
		return report();
	}
	/**
	* All distinct paths ever recorded for a session — the "tracked files"
	* set. Mirrors Claude Code's global `trackedFiles` collection (files stay
	* tracked once a write-class tool touched them), derived from the disk
	* entries so no extra persistence is needed.
	*/
	async trackedPaths(sessionId) {
		const paths = /* @__PURE__ */ new Set();
		for (const entry of await this.entriesAfter(sessionId, 0)) paths.add(entry.path);
		return paths;
	}
	/**
	* The session's recorded paths whose current size is over the cap, so no
	* backup of that state exists. One `stat` per recorded path; a path first seen
	* over the cap was never recorded and is therefore not listed.
	*/
	async uncoveredPaths(sessionId, probe = defaultProbe) {
		const sizeOf = probe.size?.bind(probe);
		if (this.maxFileBytes <= 0 || sizeOf === void 0) return [];
		const uncovered = [];
		for (const path of await this.trackedPaths(sessionId)) {
			const size = await sizeOf(path);
			if (this.isOverFileCap(size)) uncovered.push({
				path,
				...size !== void 0 ? { size } : {}
			});
		}
		return uncovered;
	}
	/**
	* Summarize a session's on-disk footprint for a clear dry-run: anchor-group
	* count, committed checkpoint-entry count (one per `.json` in an anchor
	* group), restore-journal count (both journal prefixes), and the total bytes
	* the session dir occupies — entry JSONs, raw byte sidecars, `rescue/**` and
	* the staged `.pending/**` copies alike, so the number matches what a `du` of
	* that directory reports.
	*
	* Walks with `lstat` (never follows a symlink, so a hostile symlink cannot
	* escape the store root or inflate the measurement) and skips dot-prefixed
	* temp leftovers (the one exception is `.pending/`, whose staged bytes are
	* real store content).
	*/
	async sessionStats(sessionId) {
		const sessionDir = this.sessionDir(sessionId);
		let names;
		try {
			names = await readdir(sessionDir);
		} catch (error) {
			if (isEnoent(error)) return {
				anchorGroups: 0,
				entries: 0,
				journals: 0,
				bytes: 0
			};
			throw error;
		}
		let anchorGroups = 0;
		let entries = 0;
		let journals = 0;
		let bytes = 0;
		for (const name$1 of names) {
			if (name$1.startsWith(".") && name$1 !== PENDING_DIR) continue;
			const full = join(sessionDir, name$1);
			const st = await lstat(full).catch(() => void 0);
			if (st === void 0) continue;
			if (st.isDirectory()) {
				if (name$1 === PENDING_DIR || name$1 === RESCUE_DIR) {
					bytes += await dirBytes(full);
					continue;
				}
				if (!Number.isSafeInteger(Number(name$1))) continue;
				anchorGroups++;
				for (const file of await readdir(full).catch(() => [])) if (file.endsWith(".json")) entries++;
				bytes += await dirBytes(full);
				continue;
			}
			if (!st.isFile()) continue;
			if (isJournalName(name$1)) journals++;
			bytes += st.size;
		}
		return {
			anchorGroups,
			entries,
			journals,
			bytes
		};
	}
	/**
	* Remove a session's ENTIRE snapshot directory — every anchor group, every
	* checkpoint entry, and every restore journal — and reset the store's
	* in-memory dedup state so the session starts recording fresh from the
	* current workspace state. This is the manual "get rid of this session's
	* records NOW" action on the ACTIVE session the user is driving (it is never
	* targetable by id; that is a directory-manipulation concern the user can do
	* directly).
	*
	* SEMANTICS — clearing is an explicit abandonment: issuing the command means
	* the user accepts that this session's snapshot archive goes away. It is
	* therefore NOT gated on the state of any restore journal. A clear and a
	* restore are both slash commands the host runs to completion for an agent,
	* so they never interleave — any non-terminal journal present on disk is a
	* stale orphan from a previous (crashed) process, and discarding it is the
	* correct, safe resolution of that abandoned restore.
	*
	* SAFETY (this module's real concern is the plugin's ongoing BEHAVIOR, not
	* losing snapshots):
	*  - Only the session dir is removed; dedup refs are session-relative, so
	*    there is no cross-session dangling to materialize (the same rationale as
	*    {@link pruneStale}'s whole-dir removal).
	*  - The in-memory dedup state (`lastEntry` / `seededSessions`) is ALWAYS
	*    reset on an apply — even when the dir was already empty. A stale
	*    in-memory entry (e.g. a session whose dir was removed out-of-band) would
	*    otherwise link a later `recordEntry` to a deleted prior entry, leaving a
	*    dangling ref that breaks restore resolution. This is the primary
	*    correctness guarantee.
	*
	* `dryRun` computes the report without touching disk or memory.
	*/
	async clearSession(sessionId, opts) {
		const dryRun = opts?.dryRun ?? false;
		const stats = await this.sessionStats(sessionId);
		if (!dryRun) {
			if (stats.anchorGroups > 0 || stats.journals > 0 || stats.bytes > 0) await rm(this.sessionDir(sessionId), {
				recursive: true,
				force: true
			});
			this.forgetSession(sessionId);
		}
		return {
			sessionId,
			...stats,
			dryRun
		};
	}
	/**
	* Read the session-format version marker recorded for a session, or `null`
	* when there is no marker — a pre-marker, legacy snapshot dir, or a session
	* that never materialized a dir.
	*/
	async readFormatVersion(sessionId) {
		try {
			const raw = await readFile(join(this.sessionDir(sessionId), SnapshotStore.FORMAT_FILE), "utf8");
			const parsed = Number(raw.trim());
			return Number.isFinite(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	/**
	* Record the session-format version a session's snapshots are anchored under
	* (`session.header.version`: 2 for the v2 format, 3 for the v3 format). The
	* marker is a tiny non-`.json` file, so it never counts as a checkpoint
	* entry in `sessionStats`/`clearSession`. Written atomically (temp + rename)
	* like every other persisted marker, so a crash mid-write can only leave an
	* inert `format.tmp` — never a partial marker that a later reconcile could
	* misread as a version mismatch and wrongly clear.
	*/
	async markFormatVersion(sessionId, sessionVersion) {
		const dir = this.sessionDir(sessionId);
		await mkdir(dir, { recursive: true });
		const file = join(dir, SnapshotStore.FORMAT_FILE);
		const tmp = `${file}.tmp`;
		await writeFile(tmp, `${sessionVersion}`, "utf8");
		await rename(tmp, file);
	}
	/**
	* Set the session-format version the store stamps onto every snapshot it
	* records. The host sets this once per process from `agent/created`
	* (`agent.session.header.version`), so a marker is only materialized for a
	* session that actually records a snapshot.
	*/
	setFormatVersion(sessionVersion) {
		this.formatVersion = sessionVersion;
	}
	/**
	* Read the plugin's STORE-format marker for a session, or null when there is
	* none (a released-v1 dir, or a session that never recorded a snapshot). The
	* marker is a quick session-level signal; every entry and journal is also
	* self-describing (`store` / `version`), so a missing marker never changes
	* how an entry is read.
	*/
	async readStoreVersion(sessionId) {
		try {
			const raw = await readFile(join(this.sessionDir(sessionId), SnapshotStore.STORE_FILE), "utf8");
			const parsed = Number(raw.trim());
			return Number.isFinite(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	/**
	* Stamp the store-format marker (atomically, like `format`). Written
	* alongside every byte-format entry, so a session that only ever holds the
	* released string format keeps no marker and is read as v1.
	*/
	async markStoreVersion(sessionId, storeVersion) {
		const dir = this.sessionDir(sessionId);
		await mkdir(dir, { recursive: true });
		const file = join(dir, SnapshotStore.STORE_FILE);
		const tmp = `${file}.tmp`;
		await writeFile(tmp, `${storeVersion}`, "utf8");
		await rename(tmp, file);
	}
	/**
	* Refuse to plan against (or write into) a session whose store format is
	* NEWER than this build understands (ADR-10): the caller reports it and
	* changes nothing — no partial restore, no clear, no v2 entry written into a
	* v3 store. Checked before any entry is read, so the marker alone is enough
	* to fail closed.
	*/
	async assertKnownStoreVersion(sessionId) {
		const version = await this.readStoreVersion(sessionId);
		if (version !== null && version > CURRENT_STORE_VERSION) throw new UnknownStoreVersionError(version, join(this.sessionDir(sessionId), SnapshotStore.STORE_FILE));
	}
	/**
	* Session-format-version guard: clear a session's snapshot dir when the
	* format its snapshots were anchored under differs from the current session
	* format, so seq-anchored references can never survive a format migration
	* mis-mapped. Runs at `agent/created` — after DSH has migrated/loaded
	* the session, so `sessionVersion` is the post-migration value.
	*
	* Conservative rule (per the "delete stale snapshots" policy): a session
	* with no recorded marker but with snapshot content is treated as legacy and
	* cleared; a session whose marker differs from `sessionVersion` is cleared.
	* A matching version — or an untouched session with nothing to protect — is
	* left alone. The marker is re-stamped to the current version afterward so a
	* FUTURE format change is detected on the next start.
	*
	* @returns whether a session snapshot dir was cleared.
	*/
	async reconcileFormatVersion(sessionId, sessionVersion) {
		const stored = await this.readFormatVersion(sessionId);
		if (stored === sessionVersion) return { cleared: false };
		const stats = await this.sessionStats(sessionId);
		const hasContent = stats.anchorGroups > 0 || stats.journals > 0;
		if (hasContent) await this.clearSession(sessionId);
		if (hasContent || stored !== null) await this.markFormatVersion(sessionId, sessionVersion);
		return { cleared: hasContent };
	}
};
/** Short content hash used to key synthetic recheck entries. */
function hashPath(path) {
	return shortHash(path);
}
/**
* Re-check every tracked file at a user-message boundary and record the
* current on-disk state for any file whose state changed since it was last
* seen — Claude Code's `fileHistoryMakeSnapshot` re-stats every tracked file
* at each user message and snapshots the new state (changed files get a new
* backup version, deleted files a null marker). Here the "new version" is a
* plain before-backup entry anchored at the boundary message, so an EXTERNAL
* edit or deletion (never seen by the write-class tool capture) enters the
* record and can be restored by a later rewind.
*
* Semantics: the recorded `before` is the file's state at the boundary —
* the state the boundary message's turn starts from, exactly like the
* tool-captured entries. An entry is written only when the state differs
* from the path's most-recent recorded content (`lastKnownContent`); a fresh
* sighting (never recorded) always records. The state is compared against the
* SAME single in-memory source `recordEntry` dedups against, so there is one
* content copy and one comparison — not the two (a boundary map plus the
* dedup map) the previous model held. Only CHANGED files are recorded, and
* each is a full snapshot (`dedup: false`): a changed state always differs
* from the recent record, so the link decision would never apply there.
*
* Symlinked / hard-linked paths are never re-checked (restores skip them).
* A probe failure skips the file with a warning-level no-op; it never aborts
* the boundary pass, and it never records the path as absent.
*
* @param store - the session's snapshot store.
* @param sessionId - session whose tracked files to re-check.
* @param anchorSeq - the boundary user-message seq (entry anchor).
* @param tracked - the session's tracked path set (read-only here).
* @param probe - current-disk state probe (defaults to the real FS).
* @returns the number of entries recorded.
*/
async function reconcileTracked(store, sessionId, anchorSeq, tracked, probe = defaultProbe) {
	try {
		await store.assertKnownStoreVersion(sessionId);
	} catch {
		return 0;
	}
	let recorded = 0;
	for (const path of tracked) try {
		if (await probe.isLink(path)) continue;
		if (store.isOverFileCap(await probe.size?.(path))) continue;
		const last = await store.lastKnownContent(sessionId, path);
		if (last !== void 0 && last !== null && last.kind !== "lossyText") {
			const same = await probe.matches(last, path);
			if (same === void 0 || same) continue;
		}
		const callId = `recheck-${anchorSeq}-${hashPath(path)}`;
		const staged = await store.stageCapture(sessionId, callId);
		const copied = await probe.copy(path, staged);
		if (copied.kind === "failed") {
			await rm(staged, { force: true });
			continue;
		}
		await store.recordBackup(sessionId, {
			callId,
			anchorSeq,
			path
		}, copied.kind === "absent" ? null : {
			file: staged,
			size: copied.size
		}, { dedup: false });
		recorded++;
	} catch {}
	return recorded;
}

//#endregion
//#region src/snapshot-cleanup.ts
/** The default keep threshold: finished sessions idle > 30 days are pruned. */
const DEFAULT_MAX_AGE_DAYS = 30;
/** The safe default policy (off) — a missing/corrupt value behaves like this. */
const DEFAULT_CLEANUP_CONFIG = {
	enabled: false,
	maxAgeDays: DEFAULT_MAX_AGE_DAYS
};
/**
* Adapter over the live {@link CleanupSettings} references and the host's entry
* write port, mapping the document's field names onto the resolved policy's own.
* Reads re-read the references, so a settings write is visible without a
* remount; writes validate via `parseCleanupConfig` first, so a bad value can
* never reach the document (defense-in-depth below the schema), and a defaulted
* field is cleared rather than pinned.
*/
function volatileCleanupStore(settings, writer) {
	return {
		load: () => ({
			enabled: settings.autoCleanupEnabled.get() ?? DEFAULT_CLEANUP_CONFIG.enabled,
			maxAgeDays: settings.autoCleanupMaxAgeDays.get() ?? DEFAULT_CLEANUP_CONFIG.maxAgeDays
		}),
		save: async (next) => {
			const parsed = parseCleanupConfig({
				enabled: next.enabled,
				maxAgeDays: next.maxAgeDays
			});
			if (!parsed.ok) throw new RangeError(parsed.error);
			const clear = [];
			const patch = {};
			if (parsed.config.enabled === DEFAULT_CLEANUP_CONFIG.enabled) clear.push("autoCleanupEnabled");
			else patch.autoCleanupEnabled = parsed.config.enabled;
			if (parsed.config.maxAgeDays === DEFAULT_CLEANUP_CONFIG.maxAgeDays) clear.push("autoCleanupMaxAgeDays");
			else patch.autoCleanupMaxAgeDays = parsed.config.maxAgeDays;
			if (clear.length > 0) await writer.clear(writer.entryId, clear);
			if (Object.keys(patch).length > 0) await writer.update(writer.entryId, patch);
		}
	};
}
/** Default auto-sweep cadence (once a day); `autoSweepIntervalMs` overrides it. */
const AUTO_SWEEP_INTERVAL_MS = 1440 * 60 * 1e3;
/** The state file that records the last automatic-sweep wall-clock time. */
const STATE_FILENAME = "snapshot-cleanup-last-sweep.json";
/**
* Resolve the last-sweep state path. It sits under the harness home so the
* 24h cadence SURVIVES a host restart (a real deployment is rarely up 24/7,
* so an in-memory timestamp would reset on every boot and re-sweep too often).
*/
function resolveCleanupStatePath(dshHome) {
	return join(resolveDshHome(dshHome), STATE_FILENAME);
}
/**
* Read the persisted last-sweep time (epoch ms). A missing or corrupt file
* reads as `0` ("never swept"), so the next activity runs the sweep — which is
* safe because the sweep is idempotent and never deletes the active session.
*/
async function loadLastSweepAt(path) {
	try {
		const value = JSON.parse(await readFile(path, "utf8"))["lastSweepAt"];
		return typeof value === "number" && Number.isFinite(value) ? value : 0;
	} catch {
		return 0;
	}
}
/** Persist the last-sweep time, atomically (temp + rename). */
async function saveLastSweepAt(path, ms) {
	const tmp = `${path}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(tmp, JSON.stringify({ lastSweepAt: ms }), "utf8");
	await rename(tmp, path);
}
/**
* Whether the caller's mount has been aborted. A call, not an inline
* comparison: the flag flips between awaits, and TypeScript narrows an inlined
* check to a constant after the first one.
* @param signal - the mount lifecycle signal, when the caller has one.
* @returns whether the mount has been aborted.
*/
function isAborted(signal) {
	return signal?.aborted === true;
}
/**
* The one-shot auto-cleanup check. Loads the policy + persisted last-sweep time
* and, only when enabled AND >=24h since the last sweep, runs the sweep and
* re-anchors the window on disk. Dependencies (store, paths, logger) are
* injected so the composition is unit-testable without a host. Never rejects:
* a corrupt config fail-closes (no deletion) and logs, a prune failure logs.
*
* `sessionId` is the active session directory that must never be pruned.
* `signal` is the caller's mount lifecycle: an abort before the prune or before
* the re-anchor stops the sweep (a live plugin unload must not keep deleting
* under a disposed owner).
*/
async function runAutoCleanupCheck(deps, sessionId) {
	try {
		const loaded = await deps.readConfig();
		if (!loaded.ok) {
			deps.log(`[dsh-rewind] snapshot cleanup config invalid; auto-cleanup skipped: ${loaded.error}`);
			return;
		}
		if (!loaded.config.enabled) return;
		if (isAborted(deps.signal)) return;
		if (!shouldRunAutoSweep(await loadLastSweepAt(deps.statePath), Date.now(), deps.intervalMs)) return;
		if (isAborted(deps.signal)) return;
		await deps.pruner.pruneStale({
			keepActiveId: sessionId,
			maxAgeDays: loaded.config.maxAgeDays
		});
		if (isAborted(deps.signal)) return;
		await saveLastSweepAt(deps.statePath, Date.now());
	} catch (error) {
		deps.log(`[dsh-rewind] snapshot auto-cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/**
* Validate one parsed JSON value into a {@link CleanupConfig}. Tolerates
* unknown extra keys; rejects a present-but-wrong-typed known key. Missing
* known keys fall back to the safe default.
*/
function parseCleanupConfig(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {
		ok: false,
		error: "config must be a JSON object"
	};
	const record = raw;
	let enabled = DEFAULT_CLEANUP_CONFIG.enabled;
	let maxAgeDays = DEFAULT_CLEANUP_CONFIG.maxAgeDays;
	if (record["enabled"] !== void 0) {
		if (typeof record["enabled"] !== "boolean") return {
			ok: false,
			error: "\"enabled\" must be a boolean"
		};
		enabled = record["enabled"];
	}
	if (record["maxAgeDays"] !== void 0) {
		const value = record["maxAgeDays"];
		if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return {
			ok: false,
			error: "\"maxAgeDays\" must be a positive integer"
		};
		maxAgeDays = value;
	}
	return {
		ok: true,
		config: {
			enabled,
			maxAgeDays
		}
	};
}
/**
* Parse the free-form text after `/snapshot-auto-cleanup`. Pure so it is
* unit-testable; `src/index.ts` maps the resolved action onto the store / the
* config file. `max-age` returns the validated positive day count.
*
* The `run` verb is the single manual-cleanup action. `--apply` is the ONLY
* execute-vs-dry-run switch (position-independent): without it the action is a
* dry-run preview. `--current` re-targets the action to the ACTIVE session's
* snapshots (the manual "clear this session now"); without it, `run` keeps its
* age-based stale-session sweep semantics. The old `run-apply` abbreviation is
* gone — use `run --apply`.
*/
function parseCleanupCommand(rawInput) {
	const parts = rawInput.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { action: "status" };
	switch (parts[0]) {
		case "status": return parts.length === 1 ? { action: "status" } : { error: "usage: /snapshot-auto-cleanup status" };
		case "on": return parts.length === 1 ? { action: "on" } : { error: "usage: /snapshot-auto-cleanup on" };
		case "off": return parts.length === 1 ? { action: "off" } : { error: "usage: /snapshot-auto-cleanup off" };
		case "max-age": {
			if (parts.length !== 2) return { error: "usage: /snapshot-auto-cleanup max-age <days>" };
			const days = Number(parts[1]);
			if (!Number.isInteger(days) || days <= 0) return { error: "\"max-age\" must be a positive integer (days)" };
			return {
				action: "max-age",
				value: days
			};
		}
		case "run-apply": return { error: "the \"run-apply\" abbreviation was removed; use \"run --apply\"" };
		case "run": {
			let apply$1 = false;
			let current = false;
			for (const rawFlag of parts.slice(1)) if (rawFlag === "--apply") apply$1 = true;
			else if (rawFlag === "--current") current = true;
			else return { error: `unknown /snapshot-auto-cleanup run flag "${rawFlag}"` };
			return {
				action: "run",
				target: current ? "current" : "rules",
				apply: apply$1
			};
		}
		default: return { error: `unknown /snapshot-auto-cleanup subcommand "${parts[0]}"` };
	}
}
/**
* The auto-sweep throttle: `lastAtMs` of `0` means "never ran" (a fresh
* process), so the first call always sweeps; after that a call within
* `intervalMs` is a no-op. `autoSweepIntervalMs` sets the cadence.
*/
function shouldRunAutoSweep(lastAtMs, nowMs, intervalMs = AUTO_SWEEP_INTERVAL_MS) {
	return nowMs - lastAtMs >= intervalMs;
}

//#endregion
//#region src/index.ts
const name = "dsh-session-manager";
const inject = [
	"commands",
	"tools",
	"settings"
];
/**
* 内部引擎通道：client 的回退按钮/浮层都走它，不占用任何人类可注册的
* 命令名。与 src/client/hidden.ts 的 ENGINE_COMMAND 镜像——两个 bundle
* 不共享模块。
*/
const ENGINE_COMMAND = "rewind-plugin";
/** 文件检查点开关的默认值（对齐 Claude Code 的 fileCheckpointingEnabled）。 */
const DEFAULT_FILE_CHECKPOINTING_ENABLED = true;
/** 插件配置：默认值必须写在 schema 里，不能写成普通对象。 */
const Config = Schema.object({
	stickyPromptEnabled: Schema.boolean().default(true).volatile(),
	sessionDeleteEnabled: Schema.boolean().default(true).volatile(),
	fileCheckpointingEnabled: Schema.boolean().default(DEFAULT_FILE_CHECKPOINTING_ENABLED).volatile(),
	autoCleanupEnabled: Schema.boolean().default(DEFAULT_CLEANUP_CONFIG.enabled).volatile(),
	autoCleanupMaxAgeDays: Schema.number().step(1).min(1).default(DEFAULT_CLEANUP_CONFIG.maxAgeDays).volatile(),
	snapshotDir: Schema.string(),
	dshHome: Schema.string(),
	dedup: Schema.boolean().default(true),
	maxFileBytes: Schema.number().step(1).min(0).default(DEFAULT_MAX_FILE_BYTES),
	maxAnchorGroups: Schema.number().step(1).min(1).default(MAX_ANCHOR_GROUPS),
	autoSweepIntervalMs: Schema.number().step(1).min(1).default(AUTO_SWEEP_INTERVAL_MS)
});
/** 命令文案的激活语言；mount 时读一次偏好，每次命令调用前刷新。 */
let activeLocale = "en";
/** dsh-client-locale 持久化偏好的 profile entry 与字段名。 */
const LOCALE_ENTRY = "locale";
const LOCALE_FIELD = "preference";
/**
* 同步读取用户语言偏好：settings 服务的 descriptor 读——与设置 UI、client
* 的 locale 运行时同一条公共通道。任何失败回落中性默认（en）。
*/
function readHostLocale(ctx) {
	try {
		return preferredLocale((ctx.settings.describe({ redactSecrets: true }).find((entry) => entry.ns === LOCALE_ENTRY)?.value)?.[LOCALE_FIELD]);
	} catch {
		return "en";
	}
}
/** 渲染一条 host 文案（{name} 模板插值）。 */
function t(key, params) {
	return translate(activeLocale, key, params);
}
/** Loader 的嵌套 include id 前缀（本 fiber 与其 profile row 之间）。 */
const INCLUDE_ENTRY_PREFIX = "include:";
/** 本 fiber 的 Loader entry id（裸 apply 时没有）。 */
function rewindConfigKey(ctx) {
	return ctx.fiber?.entry?.id;
}
/**
* 设置页以此地址引用本插件配置：bundle 的 PROFILE ROW id（包名），
* 而不是本 fiber 的嵌套 include id。
*/
function profileEntryKey(entryId) {
	if (entryId === void 0) return void 0;
	return entryId.startsWith(INCLUDE_ENTRY_PREFIX) ? entryId.slice(8) : entryId;
}
/** 是否允许记录新的写前备份。缺省配置保持默认（开）。 */
function isFileCheckpointingEnabled(config) {
	return config?.fileCheckpointingEnabled?.get() !== false;
}
/** 清理配置存储（config 或 Loader entry 缺席时 undefined → fail-closed）。 */
let cleanupStore;
/** 读清理配置；不可用时 fail-closed。 */
async function readCleanupPolicy() {
	if (cleanupStore === void 0) return {
		ok: false,
		error: "cleanup policy unavailable; snapshot cleanup policy cannot be read"
	};
	return {
		ok: true,
		config: cleanupStore.load()
	};
}
/** 校验后持久化清理配置。 */
async function writeCleanupPolicy(next) {
	if (cleanupStore === void 0) throw new Error("cleanup policy unavailable; snapshot cleanup policy cannot be written");
	await cleanupStore.save(next);
}
/** 追踪的写类工具。 */
const TRACKED_TOOLS = new Set(["write", "edit"]);
/** 子代理会话不追踪（对齐 Claude Code：其编辑无法由父会话回退还原）。 */
function isSubagentSession(session) {
	const header = session.header;
	return header?.origin === "subagent" || (header?.delegationDepth ?? 0) > 0;
}
/** 从工具调用参数里取被修改文件路径；非追踪工具返回 undefined。 */
function mutationPathOf(exec) {
	const args = exec.arguments;
	if (exec.name === "write" || exec.name === "edit") return typeof args.file_path === "string" ? args.file_path : void 0;
}
/** 丢弃一次暂存捕获（幂等；失败不扩散）。 */
async function discardCapture(capture) {
	if (capture === void 0 || capture.backup === null) return;
	try {
		const { rm: rm$1 } = await import("node:fs/promises");
		await rm$1(capture.backup.file, { force: true });
	} catch {}
}
/** fs 错误是否表示「路径不存在」。 */
function isNotFoundError(error) {
	return error?.code === "ENOENT";
}
/**
* tools/execute（around-dispatch 阶段）写前捕获：审批 ask 已在此前短路、
* 被拒调用不会 dispatch——批准的仍捕获，被拒的绝不留痕。
*/
async function captureBefore(fs, workingDirectory, store, exec, pending) {
	if (!TRACKED_TOOLS.has(exec.name)) return;
	const agent = exec.agent;
	if (agent === void 0) return;
	if (isSubagentSession(agent.session)) return;
	const path = mutationPathOf(exec);
	if (path === void 0) return;
	const cwd = await workingDirectory.ensure(agent, exec.signal);
	let target;
	try {
		target = await fs.resolve(path, {
			cwd,
			signal: exec.signal
		});
	} catch {
		return;
	}
	const info = await fs.stat(target, exec.signal).catch((error) => {
		if (isNotFoundError(error)) return void 0;
		throw error;
	});
	if (info !== void 0 && info.type !== "file") return;
	if (info !== void 0 && store.isOverFileCap(info.size)) return;
	const key = `${exec.agent?.id ?? "anon"}:${exec.callId}`;
	if (info === void 0) {
		pending.set(key, {
			path: target.displayPath,
			backup: null
		});
		return;
	}
	const staged = await store.stageCapture(agent.session.id, key);
	let backup;
	try {
		const { copyFile: copyFile$1, stat: stat$1 } = await import("node:fs/promises");
		await copyFile$1(target.displayPath, staged);
		const st = await stat$1(staged);
		const source = await stat$1(target.displayPath).catch(() => void 0);
		backup = {
			file: staged,
			size: st.size,
			...source !== void 0 ? { mode: source.mode & 4095 } : {}
		};
	} catch (error) {
		await discardCapture({
			path: target.displayPath,
			backup: {
				file: staged,
				size: 0
			}
		});
		throw error;
	}
	pending.set(key, {
		path: target.displayPath,
		backup
	});
}
/**
* 最近 user/message seq —— 本回合的锚。
* 增量：两次工具结果之间追加的 tool/assistant 事件不动锚，只扫新增事件
* ——均摊 O(1)。按 Session 对象做 WeakMap 键（会话 id 可能被复用）。
*/
function anchorSeqOf(session, cache) {
	const events = session.snapshotEvents();
	const cached = cache.get(session);
	if (cached !== void 0 && cached.eventsLength === events.length) return cached.anchor;
	let anchor = cached?.anchor;
	for (let i = events.length - 1; i >= (cached?.eventsLength ?? 0); i--) if (events[i].type === "user/message") {
		anchor = events[i].seq;
		break;
	}
	cache.set(session, {
		anchor,
		eventsLength: events.length
	});
	return anchor;
}
/**
* tools/post-execute 提交：把暂存字节移入检查点存储。失败调用丢弃；
* 开关在捕获后翻转的丢弃；无 agent / 无锚的丢弃。
*/
async function commitEntry(store, pending, anchorCache, trackedBySession, exec, result, checkpointingEnabled) {
	const key = `${exec.agent?.id ?? "anon"}:${exec.callId}`;
	const capture = pending.get(key);
	if (capture === void 0) return;
	pending.delete(key);
	if (!checkpointingEnabled) {
		await discardCapture(capture);
		return;
	}
	if (result.isError) {
		await discardCapture(capture);
		return;
	}
	const agent = exec.agent;
	if (agent === void 0) {
		await discardCapture(capture);
		return;
	}
	const anchorSeq = anchorSeqOf(agent.session, anchorCache);
	if (anchorSeq === void 0) {
		await discardCapture(capture);
		return;
	}
	try {
		await store.recordBackup(agent.session.id, {
			callId: exec.callId,
			anchorSeq,
			path: capture.path
		}, capture.backup);
	} catch (error) {
		await discardCapture(capture);
		throw error;
	}
	let tracked = trackedBySession.get(agent.session.id);
	if (tracked === void 0) {
		tracked = /* @__PURE__ */ new Set();
		trackedBySession.set(agent.session.id, tracked);
	}
	tracked.add(capture.path);
}
/**
* 标记内容：恒定的自说明占位。必须非空——日志不可变但服务的模型可能更换，
* 严格的 OpenAI 兼容网关会拒绝空 user message（HTTP 400）。
*/
const REWIND_MARKER_CONTENT = [{
	type: "text",
	text: "(empty message)"
}];
/** 构建回退标记：带 surface-replace 语义的 user/message。 */
function buildMarker() {
	return createUserMessage({
		content: REWIND_MARKER_CONTENT,
		source: REWIND_MARKER_SOURCE
	});
}
/** 人类可读的字节数（二进制单位）。 */
function formatBytes(bytes) {
	if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
	return `${bytes} B`;
}
/** 解析 target；失败映射为 RewindError。 */
function resolveOrError(events, surface, raw) {
	const target = parseRewindTarget(raw);
	if (target === void 0) throw new RewindError("invalid-index", t("error.invalidTarget", { raw }));
	return planRewind(events, surface, target);
}
/** 失败文件的后缀渲染。 */
function renderFailures(failed) {
	if (failed.length === 0) return "";
	return t("failures.suffix", {
		count: failed.length,
		list: failed.map((f) => t("failures.item", {
			path: f.path,
			message: f.message
		})).join(t("sep.list"))
	});
}
/** 因上限被跳过的路径逐条列名（其余跳过仍归 skip.count 汇总）。 */
function renderSkipped(outcome, uncovered, maxFileBytes) {
	const capped = new Set(uncovered.map((item) => item.path));
	const limit = formatBytes(maxFileBytes);
	return outcome.skipped.filter((path) => capped.has(path)).map((path) => t("plan.skip", {
		path,
		reason: t("skipReason.oversized", { limit })
	})).join("\n");
}
const PREVIEW_TTL_MS = 600 * 1e3;
const previewCache = /* @__PURE__ */ new Map();
const MAX_PREVIEWS = 16;
/** 托管一份预演基线，返回 planId。 */
function stashPreview(sessionId, targetSeq, expected) {
	const planId = randomUUID().replaceAll("-", "").slice(0, 16);
	previewCache.set(planId, {
		sessionId,
		targetSeq,
		expected,
		expiresAt: Date.now() + PREVIEW_TTL_MS
	});
	if (previewCache.size > MAX_PREVIEWS) {
		const oldest = [...previewCache.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
		for (const [key, entry] of previewCache) if (entry === oldest) {
			previewCache.delete(key);
			break;
		}
	}
	return planId;
}
/** 消费一份预演基线（一次性；过期或不匹配返回 undefined）。 */
function consumePreview(planId, sessionId, targetSeq) {
	if (planId === void 0) return void 0;
	const entry = previewCache.get(planId);
	if (entry === void 0) return void 0;
	previewCache.delete(planId);
	if (entry.expiresAt < Date.now() || entry.sessionId !== sessionId || entry.targetSeq !== targetSeq) return void 0;
	return entry;
}
/**
* 文件当前的磁盘指纹：sha256 十六进制；不存在为 'absent'；不可读为
* undefined（无法判定——复核时放行，绝不因读不到而误伤）。
*/
async function diskMarker(path) {
	try {
		const buf = await readFile(path);
		return createHash("sha256").update(buf).digest("hex");
	} catch (error) {
		return isNotFoundError(error) ? "absent" : void 0;
	}
}
/**
* 包装 DiskProbe：预演清单里的路径若在执行时刻指纹变化（预演→执行窗口
* 内被外部改动），视为「已一致」排除出动作集并记入 drift——不覆盖。
* 清单外的路径全部透传（保持 dsh-rewind 的原生重规划行为）。
*/
function verifyProbe(base, expected, drift) {
	return {
		matches: async (source, path) => {
			const want = expected.get(path);
			if (want !== void 0) {
				const now = await diskMarker(path);
				if (now !== void 0 && now !== want) {
					drift.push({
						path,
						message: t("conflict.drifted")
					});
					return true;
				}
			}
			return base.matches(source, path);
		},
		copy: (path, dest) => base.copy(path, dest),
		...base.size === void 0 ? {} : { size: (path) => base.size(path) },
		isLink: (path) => base.isLink(path)
	};
}
/** 解析 display path 为 fs target；失败返回 undefined（同步静默跳过）。 */
async function resolveObservationTarget(fs, path) {
	try {
		return await fs.resolve(path);
	} catch {
		return;
	}
}
/**
* both 还原走裸 node:fs，fs 观察策略层看不见。不同步的话，本会话下一次写
* 还原/删除过的文件会被 stale guard 拒（FS_STALE_VERSION）。在公共
* fs/observed 事件上发权威观察：删除的记 absent（下次 createIfAbsent），
* 还原的带新版本（下次 CAS 成功）。只 heal 还原自身造成的不一致——之后
* 的外部改动仍照常触发 stale 防护。
*/
async function syncRestoreObservations(ctx, fs, agent, outcome) {
	if (fs === void 0) return;
	const actor = { agent };
	for (const path of outcome.deleted) {
		const target = await resolveObservationTarget(fs, path);
		if (target === void 0) continue;
		ctx.emit("fs/observed", target, { kind: "absent" }, actor);
	}
	for (const path of outcome.restored) {
		const target = await resolveObservationTarget(fs, path);
		if (target === void 0) continue;
		const info = await fs.stat(target).catch(() => void 0);
		if (info === void 0) continue;
		ctx.emit("fs/observed", target, {
			kind: "present",
			version: info.version
		}, actor);
	}
}
/** 等 agent 空闲（含 maintenance 阶段）；race 15s 超时与 abort。 */
async function waitForAgentIdle(agent, signal, timeoutMs = 15e3) {
	if (signal.aborted) return false;
	let timer;
	let onAbort;
	try {
		await Promise.race([agent.whenIdle(), new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(/* @__PURE__ */ new Error("rewind idle wait timed out")), timeoutMs);
			onAbort = () => reject(/* @__PURE__ */ new Error("rewind idle wait aborted"));
			signal.addEventListener("abort", onAbort, { once: true });
		})]);
		return true;
	} catch {
		return false;
	} finally {
		if (timer !== void 0) clearTimeout(timer);
		if (onAbort !== void 0) signal.removeEventListener("abort", onAbort);
	}
}
/**
* 回退丢弃所有 pending steering（next-step inbox）插话——它们属于被切掉
* 的未来；next-turn 队列不动（宿主 QueueDock 有自己的逐条管理）。
*/
function dropPendingSteering(agent) {
	for (const message of [...agent.inbox.nextStep]) agent.inbox.remove(message.id);
}
/** 把 RewindError 映射为命令错误结果。 */
function rewindErrorResult(error) {
	if (error instanceof RewindError) return {
		kind: "error",
		text: {
			"no-user-messages": t("noUserMessages"),
			"invalid-index": error.message,
			"not-a-user-message": error.message,
			"not-on-surface": error.message
		}[error.code]
	};
	throw error;
}
/** 执行一次已验证的回退：追加标记，可选还原文件。 */
async function executeRewind(ctx, store, fs, invocation, rawTarget, mode, inflight, checkpointingEnabled, previewPlanId) {
	const { agent } = invocation;
	const sessionId = agent.session.id;
	if (inflight.has(sessionId)) return {
		kind: "error",
		text: t("inflight")
	};
	inflight.add(sessionId);
	try {
		if (agent.status !== "idle") {
			agent.cancel({ kind: "user" }, { keepInbox: true });
			if (!await waitForAgentIdle(agent, invocation.signal)) return {
				kind: "error",
				text: t("stopFailed")
			};
		}
		dropPendingSteering(agent);
		if (invocation.signal.aborted) return {
			kind: "error",
			text: t("cancelled")
		};
		let plan;
		try {
			plan = resolveOrError(agent.session.snapshotEvents(), agent.session.surface.nodes, rawTarget);
		} catch (error) {
			return rewindErrorResult(error);
		}
		const marker = buildMarker();
		let event;
		try {
			event = agent.session.append("user/message", marker, {
				surfaceOp: {
					op: "replace",
					startSeq: plan.surfaceStart,
					endSeq: plan.surfaceEnd
				},
				sourceEventSeqs: [...plan.shadowedSeqs]
			});
		} catch (error) {
			return {
				kind: "error",
				text: t("failed", { error: error instanceof Error ? error.message : String(error) })
			};
		}
		let restore = "";
		if (mode === "both") {
			const preview = consumePreview(previewPlanId, agent.session.id, plan.targetSeq);
			const drift = [];
			const probe = preview === void 0 ? defaultProbe : verifyProbe(defaultProbe, preview.expected, drift);
			let outcome;
			try {
				outcome = await store.restoreAfter(agent.session.id, plan.targetSeq, (path) => unlink(path), probe);
			} catch (error) {
				if (!(error instanceof UnknownStoreVersionError)) throw error;
				const version = await store.readStoreVersion(agent.session.id);
				restore = `${t("sep.clause")}${t("storeUnsupported", { version: version ?? error.version })}`;
			}
			if (outcome !== void 0) {
				await syncRestoreObservations(ctx, fs, agent, outcome);
				const parts = [];
				if (outcome.restored.length > 0) parts.push(t("restore.count", { count: outcome.restored.length }));
				if (outcome.deleted.length > 0) parts.push(t("delete.count", { count: outcome.deleted.length }));
				if (outcome.skipped.length > 0) {
					parts.push(t("skip.count", { count: outcome.skipped.length }));
					const capped = await store.uncoveredPaths(agent.session.id).catch(() => []);
					const skippedLines = renderSkipped(outcome, capped, store.fileCapBytes);
					if (skippedLines !== "") parts.push(skippedLines);
				}
				if (!checkpointingEnabled) parts.push(t("backupOff"));
				restore = parts.length > 0 ? `${t("sep.clause")}${parts.join(t("sep.list"))}` : t("noRestorable");
				restore += renderFailures([...drift, ...outcome.failed]);
			} else if (drift.length > 0) restore += renderFailures(drift);
		}
		return {
			kind: "success",
			text: t("success", {
				targetSeq: plan.targetSeq,
				restore
			}),
			sourceEventSeq: event.seq
		};
	} finally {
		inflight.delete(sessionId);
	}
}
/**
* 影响预览（RPC 端点内部）：读影响清单 + 每路径基线指纹，托管 planId 并
* 随响应带回——both 执行按 planId 做 TOCTOU 复核。
*/
async function previewImpactPayload(store, session, seq, checkpointingEnabled) {
	const plan = resolveOrError(session.snapshotEvents(), session.surface.nodes, `@${seq}`);
	const impacts = await store.impactsAfter(session.id, plan.targetSeq);
	const expected = /* @__PURE__ */ new Map();
	for (const impact of impacts) {
		const marker = await diskMarker(impact.path);
		if (marker !== void 0) expected.set(impact.path, marker);
	}
	const planId = stashPreview(session.id, plan.targetSeq, expected);
	return {
		files: impacts.map((f) => ({
			path: f.path,
			action: f.action
		})),
		backupOff: !checkpointingEnabled,
		planId
	};
}
/** 构造一个失败的 RPC 结果。 */
function rpcFailure(code, message) {
	return {
		ok: false,
		error: {
			code,
			message,
			details: {}
		}
	};
}
/** 影响预览与候选列表的只读 RPC 端点（走 Connection RPC，不产生会话日志事件）。 */
function createRewindRpcHandler(store, agentsOf, checkpointingEnabled) {
	return async (endpoint, payload) => {
		try {
			if (!(typeof payload === "object" && payload !== null && !Array.isArray(payload))) return rpcFailure("dsm-rewind/bad-request", "invalid payload");
			const sessionId = payload["sessionId"];
			if (typeof sessionId !== "string" || sessionId.length === 0) return rpcFailure("dsm-rewind/bad-request", "sessionId must be a non-empty string");
			const agents = agentsOf();
			if (agents === void 0) return rpcFailure("dsm-rewind/agents-unavailable", "agent registry is unavailable");
			const agent = agents.get(sessionId);
			if (agent === void 0) return rpcFailure("dsm-rewind/session-not-found", `session ${sessionId} is not attached`);
			if (endpoint === "preview") {
				const seq = payload["seq"];
				if (!Number.isSafeInteger(seq)) return rpcFailure("dsm-rewind/bad-request", "seq must be an integer");
				return {
					ok: true,
					value: await previewImpactPayload(store, agent.session, seq, checkpointingEnabled())
				};
			}
			return rpcFailure("dsm-rewind/unknown-endpoint", `unknown endpoint: ${endpoint}`);
		} catch (error) {
			if (error instanceof RewindError) return rpcFailure("dsm-rewind/rejected", error.message);
			if (error instanceof UnknownStoreVersionError) return rpcFailure("dsm-rewind/store-unsupported", error.message);
			return rpcFailure("dsm-rewind/failed", error instanceof Error ? error.message : String(error));
		}
	};
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
async function handleRewind(ctx, store, fs, invocation, inflight, checkpointingEnabled) {
	const session = invocation.agent.session;
	const input = invocation.rawInput.trim();
	if (input === "") {
		const candidates = listRewindCandidates(session.snapshotEvents(), session.surface.nodes, 1);
		if (candidates.length === 0) return {
			kind: "error",
			text: t("noUserMessages")
		};
		return executeRewind(ctx, store, fs, invocation, `@${candidates[0].seq}`, "chat", inflight, checkpointingEnabled);
	}
	const parts = input.split(/\s+/);
	const target = parts[0];
	const mode = parts[1];
	const planId = parts[2];
	if (mode !== void 0 && mode !== "chat" && mode !== "both") return {
		kind: "error",
		text: t("engine.rejected")
	};
	if (mode === void 0) return {
		kind: "error",
		text: t("engine.rejected")
	};
	return executeRewind(ctx, store, fs, invocation, target, mode, inflight, checkpointingEnabled, planId);
}
/** 本 mount 是否已跑过一次自动清理检查（每次 apply 重置）。 */
let autoSweepChecked = false;
/**
* 首次会话活动（用户消息或工具结果）时后台跑一次检查；之后本 mount 不再
* 考虑。last-sweep 时间落盘，节奏跨重启续期。永不 reject。
*/
async function maybeRunAutoCleanup(ctx, store, sessionId, dshHome, sweepIntervalMs, signal) {
	if (autoSweepChecked || signal?.aborted === true) return;
	autoSweepChecked = true;
	try {
		await runAutoCleanupCheck({
			pruner: store,
			readConfig: () => readCleanupPolicy(),
			statePath: resolveCleanupStatePath(dshHome),
			log: (msg) => ctx.logger.warn(msg),
			...sweepIntervalMs === void 0 ? {} : { intervalMs: sweepIntervalMs },
			...signal === void 0 ? {} : { signal }
		}, sessionId);
	} catch (error) {
		try {
			ctx.logger.warn(`[dsh-session-manager] snapshot auto-cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		} catch {}
	}
}
/** PruneStaleReport 的 run 子命令渲染。 */
function formatCleanupReport(report) {
	const text = t(report.dryRun ? "cleanup.runDry" : "cleanup.runApply", {
		deleted: report.deleted,
		freed: report.freedBytes,
		kept: report.kept,
		remaining: report.remainingBytes
	});
	return report.skippedActive > 0 ? `${text}\n${t("cleanup.skipped", { skipped: report.skippedActive })}` : text;
}
/** ClearSessionReport 渲染。 */
function formatClearReport(report) {
	return t(report.dryRun ? "cleanup.clearDry" : "cleanup.clearApply", {
		entries: report.entries,
		bytes: report.bytes
	});
}
/** /snapshot-auto-cleanup 文法：status/on/off/max-age/run。 */
async function handleSnapshotCleanup(ctx, store, invocation, dshHome, trackedBySession) {
	const parsed = parseCleanupCommand(invocation.rawInput);
	if ("error" in parsed) return {
		kind: "error",
		text: t("cleanup.usage")
	};
	switch (parsed.action) {
		case "status": {
			const loaded = await readCleanupPolicy();
			if (!loaded.ok) return {
				kind: "error",
				text: t("cleanup.cfgInvalid", { detail: loaded.error })
			};
			return {
				kind: "success",
				text: t("cleanup.status", {
					state: t(loaded.config.enabled ? "cleanup.enabled" : "cleanup.disabled"),
					days: loaded.config.maxAgeDays
				})
			};
		}
		case "on":
		case "off": {
			const loaded = await readCleanupPolicy();
			const next = {
				...loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG,
				enabled: parsed.action === "on"
			};
			try {
				await writeCleanupPolicy(next);
			} catch (error) {
				return {
					kind: "error",
					text: t("cleanup.saveFailed", { detail: error instanceof Error ? error.message : String(error) })
				};
			}
			return {
				kind: "success",
				text: t(parsed.action === "on" ? "cleanup.onOk" : "cleanup.offOk")
			};
		}
		case "max-age": {
			const loaded = await readCleanupPolicy();
			const next = {
				...loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG,
				maxAgeDays: parsed.value
			};
			try {
				await writeCleanupPolicy(next);
			} catch (error) {
				return {
					kind: "error",
					text: t("cleanup.saveFailed", { detail: error instanceof Error ? error.message : String(error) })
				};
			}
			return {
				kind: "success",
				text: t("cleanup.maxAgeOk", { days: parsed.value })
			};
		}
		case "run": {
			const apply$1 = parsed.apply;
			if (parsed.target === "current") return handleClearCurrent(ctx, store, invocation, apply$1, trackedBySession);
			const loaded = await readCleanupPolicy();
			if (!loaded.ok) return {
				kind: "error",
				text: t("cleanup.cfgInvalid", { detail: loaded.error })
			};
			try {
				const report = await store.pruneStale({
					keepActiveId: invocation.agent.session.id,
					maxAgeDays: loaded.config.maxAgeDays,
					dryRun: !apply$1
				});
				if (!report.dryRun) await saveLastSweepAt(resolveCleanupStatePath(dshHome), Date.now());
				return {
					kind: "success",
					text: formatCleanupReport(report)
				};
			} catch (error) {
				return {
					kind: "error",
					text: t("cleanup.runFailed", { detail: error instanceof Error ? error.message : String(error) })
				};
			}
		}
	}
}
/**
* run --current：清除当前会话的快照。apply 必须等回合停止——运行中的
* turn 会与并发 recordBackeup 交错出悬空 dedup 链接；停不下来就报错，
* 绝不让插件损坏。
*/
async function handleClearCurrent(ctx, store, invocation, apply$1, trackedBySession) {
	const { agent } = invocation;
	const sessionId = agent.session.id;
	if (apply$1) {
		if (agent.status !== "idle") {
			agent.cancel({ kind: "user" }, { keepInbox: true });
			if (!await waitForAgentIdle(agent, invocation.signal)) return {
				kind: "error",
				text: t("cleanup.clearActive", { sessionId })
			};
		}
		if (invocation.signal.aborted) return {
			kind: "error",
			text: t("cleanup.clearCancelled")
		};
	}
	try {
		const report = await store.clearSession(sessionId, { dryRun: !apply$1 });
		if (!report.dryRun) trackedBySession.delete(sessionId);
		return {
			kind: "success",
			text: formatClearReport(report)
		};
	} catch (error) {
		return {
			kind: "error",
			text: t("cleanup.clearFailed", {
				detail: error instanceof Error ? error.message : String(error),
				sessionId
			})
		};
	}
}
function apply(ctx, config) {
	autoSweepChecked = false;
	cleanupStore = void 0;
	activeLocale = readHostLocale(ctx);
	const lifecycle = new AbortController();
	ctx.effect(() => () => {
		lifecycle.abort();
	});
	const dshHome = config?.dshHome;
	const store = new SnapshotStore(config?.snapshotDir, {
		dedup: config?.dedup,
		dshHome,
		maxFileBytes: config?.maxFileBytes,
		maxAnchorGroups: config?.maxAnchorGroups
	});
	const configKey = profileEntryKey(rewindConfigKey(ctx));
	if (config !== void 0 && configKey !== void 0) cleanupStore = volatileCleanupStore(config, {
		entryId: configKey,
		update: (id, patch) => ctx.settings.update(id, patch),
		clear: (id, fields) => ctx.settings.mutate(id, fields.map((field) => ({
			op: "unset",
			path: [field]
		})))
	});
	const pending = /* @__PURE__ */ new Map();
	ctx.effect(() => () => {
		const captures = [...pending.values()];
		pending.clear();
		return Promise.all(captures.map((capture) => discardCapture(capture))).then(() => void 0);
	});
	const anchorCache = /* @__PURE__ */ new WeakMap();
	const inflight = /* @__PURE__ */ new Set();
	const trackedBySession = /* @__PURE__ */ new Map();
	let fsService;
	const withHostLocale = (handler) => (invocation) => {
		activeLocale = readHostLocale(ctx);
		return handler(invocation);
	};
	const rewindHandler = withHostLocale((invocation) => handleRewind(ctx, store, fsService, invocation, inflight, isFileCheckpointingEnabled(config)));
	const engineHandler = withHostLocale((invocation) => invocation.rawInput.trim() === "" ? Promise.resolve({
		kind: "error",
		text: t("engine.rejected")
	}) : handleRewind(ctx, store, fsService, invocation, inflight, isFileCheckpointingEnabled(config)));
	const cleanupHandler = withHostLocale((invocation) => handleSnapshotCleanup(ctx, store, invocation, dshHome, trackedBySession));
	const disposers = [];
	const registerCommand = (definition) => {
		try {
			const dispose = ctx.commands.register(definition);
			disposers.push(dispose);
		} catch (error) {
			ctx.logger.warn(`[dsh-session-manager] command "${String(definition.name)}" was not registered: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	registerCommand({
		name: "rewind",
		description: t("command.description"),
		handler: rewindHandler
	});
	registerCommand({
		name: "undo",
		description: t("command.undoDescription"),
		handler: rewindHandler
	});
	registerCommand({
		name: ENGINE_COMMAND,
		description: t("engine.description"),
		input: { hint: t("engine.inputHint") },
		handler: engineHandler
	});
	registerCommand({
		name: "snapshot-auto-cleanup",
		description: t("cleanup.description"),
		input: { hint: t("cleanup.inputHint") },
		handler: cleanupHandler
	});
	if (disposers.length > 0) ctx.effect(() => () => {
		for (const dispose of disposers.splice(0)) dispose();
	});
	ctx.on("agent/created", (payload) => {
		const session = payload.agent.session;
		if (isSubagentSession(session)) return void 0;
		(async () => {
			try {
				if (lifecycle.signal.aborted) return;
				store.setFormatVersion(session.header.version);
				try {
					await store.assertKnownStoreVersion(session.id);
				} catch (error) {
					ctx.logger.warn(`[dsh-session-manager] file restore disabled for ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
					return;
				}
				if (lifecycle.signal.aborted) return;
				if ((await store.reconcileFormatVersion(session.id, session.header.version)).cleared) ctx.logger.warn(`[dsh-session-manager] cleared snapshots for ${session.id}: session format changed (v${session.header.version})`);
			} catch (error) {
				ctx.logger.warn(`[dsh-session-manager] session-format reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		})();
	});
	ctx.on("session/event", (session, event) => {
		if (event.type !== "user/message") return;
		if (isSubagentSession(session)) return;
		if (inflight.has(session.id)) return;
		(async () => {
			try {
				if (lifecycle.signal.aborted) return;
				const sessionId = session.id;
				maybeRunAutoCleanup(ctx, store, sessionId, dshHome, config?.autoSweepIntervalMs, lifecycle.signal);
				if (!isFileCheckpointingEnabled(config)) return;
				let tracked = trackedBySession.get(sessionId);
				if (tracked === void 0) {
					tracked = await store.trackedPaths(sessionId);
					trackedBySession.set(sessionId, tracked);
				}
				if (tracked.size === 0) return;
				if (lifecycle.signal.aborted) return;
				await reconcileTracked(store, sessionId, event.seq, tracked);
			} catch (error) {
				ctx.logger.warn(`[dsh-session-manager] boundary re-check failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		})();
	});
	ctx.inject(["connection"], (scope) => {
		try {
			const connection = scope.root.connection;
			if (connection === void 0) return;
			const dispose = connection.rpc.handle("dsh-session-manager-rewind", createRewindRpcHandler(store, () => scope.get("agents"), () => isFileCheckpointingEnabled(config)));
			scope.effect(() => dispose, "dsh-session-manager rewind RPC channel");
		} catch (error) {
			ctx.logger.warn(`[dsh-session-manager] RPC channel registration failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	ctx.inject(["fs", "workingDirectory"], (scope) => {
		const fs = scope.fs;
		const workingDirectory = scope.workingDirectory;
		fsService = fs;
		scope.effect(() => () => {
			fsService = void 0;
		});
		scope.on("tools/execute", async (exec, next) => {
			try {
				if (isFileCheckpointingEnabled(config)) await captureBefore(fs, workingDirectory, store, exec, pending);
			} catch (error) {
				ctx.logger.warn(`[dsh-session-manager] before-capture failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
			return next();
		});
		scope.on("tools/post-execute", async (exec, result, next) => {
			try {
				const session = exec.agent?.session;
				if (session !== void 0 && !isSubagentSession(session)) maybeRunAutoCleanup(ctx, store, session.id, dshHome, config?.autoSweepIntervalMs, lifecycle.signal);
				await commitEntry(store, pending, anchorCache, trackedBySession, exec, result, isFileCheckpointingEnabled(config));
			} catch (error) {
				ctx.logger.warn(`[dsh-session-manager] checkpoint commit failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
			return next();
		});
		scope.on("tools/result", (exec) => {
			const key = `${exec.agent?.id ?? "anon"}:${exec.callId}`;
			const capture = pending.get(key);
			pending.delete(key);
			discardCapture(capture);
		});
	});
}

//#endregion
export { Config, DEFAULT_FILE_CHECKPOINTING_ENABLED, ENGINE_COMMAND, apply, inject, name, profileEntryKey };
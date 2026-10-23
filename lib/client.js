window.__ModuleLoader__.load({ id: "dsh-session-manager", factory: (require) => {
var module={exports:{}}; var exports=module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);

//#region src/client/stickyPrompt.ts
/**
* 顶栏固定最近用户消息（sticky prompt bar）。
*
* 长对话向上滚动时，把视口顶部之外最近的一条用户消息 pin 到滚动容器
* 顶部，作为一条可点击的提示条；点击回到原始气泡。迁移自
* dsh-oil-sticky-prompt 0.1.0，选择器已适配 DSH 0.1.2-rc.1 的 DOM：
* - 行：[data-chat-flow-kind="user"][data-chat-flow-key]
* - 滚动容器：[data-conversation-scroll]
* - 气泡文本：克隆行节点剔除插件注入/时间戳/图标按钮后取 textContent
* - 顶栏 pill 与系统用户气泡 Sixlwa_bubble 同款度量
*/
const HOST_ATTR = "data-dsh-sticky-host";
/** 折叠原始换行，避免短首行在两行 clamp 里遮住后续内容。 */
function flattenPromptText(text) {
	return text.replace(/\s+/g, " ").trim();
}
const PIN = .5;
const RELEASE = 8;
/**
* 最近一条已**完全**滚出视口顶部的用户行；带滞回（PIN/RELEASE）防止
* 样式抖动。吸附条件是行底(不是行顶)越过视口顶——长消息主体还在视口
* 内可见时不吸附,避免吸附条遮住消息上部导致无法完整阅读。
* currentKey 为当前 pinned key，用于在边缘区间保持粘滞。
*/
function pickPinnedRow(rows, scrollerTop, currentKey) {
	const visible = rows.filter((row) => row.bottom > row.top);
	let lastPast;
	let lastPastIndex = -1;
	for (const [index, row] of visible.entries()) if (row.bottom <= scrollerTop + PIN) {
		lastPast = row.key;
		lastPastIndex = index;
	}
	if (currentKey !== void 0) {
		const currentIndex = visible.findIndex((row) => row.key === currentKey);
		const current = currentIndex === -1 ? void 0 : visible[currentIndex];
		if (lastPastIndex > currentIndex) return lastPast;
		if (current !== void 0 && current.bottom <= scrollerTop + RELEASE) return currentKey;
	}
	return lastPast;
}
const hideTimers = /* @__PURE__ */ new WeakMap();
const TIME_ONLY = /^\d{1,2}:\d{2}(?::\d{2})?$/;
function rowBoxesOf(scroller) {
	const rows = [];
	for (const row of scroller.querySelectorAll("[data-chat-flow-kind=\"user\"][data-chat-flow-key]")) {
		const key = row.getAttribute("data-chat-flow-key") ?? "";
		if (key === "") continue;
		if (row.hasAttribute("data-turn-process-hidden")) continue;
		const rect = row.getBoundingClientRect();
		rows.push({
			key,
			top: rect.top,
			bottom: rect.bottom,
			row
		});
	}
	return rows;
}
function ensureHost(scroller) {
	const existing = scroller.querySelector(`:scope > [${HOST_ATTR}]`);
	if (existing instanceof HTMLElement) return existing;
	const host = document.createElement("div");
	host.setAttribute(HOST_ATTR, "");
	host.innerHTML = "<div class=\"dshSessionManagerStickyBar\" hidden><button type=\"button\" class=\"dshSessionManagerStickyPrompt\"><span class=\"dshSessionManagerStickyText\"></span></button></div>";
	scroller.prepend(host);
	return host;
}
function clearTransform(prompt) {
	prompt.style.transition = "";
	prompt.style.transform = "";
	prompt.style.transformOrigin = "";
}
function textOf(row) {
	const clone = row.cloneNode(true);
	for (const element of clone.querySelectorAll("[data-dsh-checkpoint-pill], [data-dsh-sticky-host]")) element.remove();
	for (const element of Array.from(clone.querySelectorAll("button"))) {
		const label = element.getAttribute("aria-label")?.toLowerCase() ?? "";
		if (label === "复制" || label === "copy" || label === "") element.remove();
	}
	for (const element of Array.from(clone.querySelectorAll("span, time, div"))) if (element.childElementCount === 0 && TIME_ONLY.test(element.textContent ?? "")) element.remove();
	return flattenPromptText(clone.textContent ?? "");
}
function reducedMotion() {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function bindJumpInto(prompt, scroller, key) {
	prompt.onclick = () => {
		scroller.querySelector(`[data-chat-flow-kind="user"][data-chat-flow-key="${cssEscape(key)}"]`)?.scrollIntoView({
			block: "start",
			behavior: reducedMotion() ? "auto" : "smooth"
		});
	};
}
function hideBar(host, bar, prompt) {
	delete host.dataset.dshStickyKey;
	if (bar.hidden) return;
	clearTransform(prompt);
	const finish = () => {
		hideTimers.delete(host);
		bar.hidden = true;
		delete bar.dataset.dshStickyVisible;
		const label = bar.querySelector(".dshSessionManagerStickyText");
		if (label !== null) label.textContent = "";
	};
	if (reducedMotion()) {
		finish();
		return;
	}
	delete bar.dataset.dshStickyVisible;
	hideTimers.set(host, window.setTimeout(finish, 170));
}
function cssEscape(value) {
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
	return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
/** 整组用户行 key 全部替换（切换会话/内容重建）时为 true，用于触发静默稳定窗口。 */
function isRowSetReplaced(previous, next) {
	if (previous.size === 0 || next.size === 0) return false;
	for (const key of next) if (previous.has(key)) return false;
	return true;
}
/** 切换会话后宿主要恢复滚动、补历史分页、稳定内容高度，期间布局是中间态；
*  静默窗口内不渲染提示条，避免先显示“上一条”再跳到“最新一条”。 */
const SETTLE_MS = 300;
const MAX_SUPPRESS_MS = 1200;
const stickyStates = /* @__PURE__ */ new WeakMap();
function stateOf(scroller) {
	let state = stickyStates.get(scroller);
	if (state === void 0) {
		state = {
			keys: /* @__PURE__ */ new Set(),
			suppressUntil: 0,
			suppressStart: 0
		};
		stickyStates.set(scroller, state);
	}
	return state;
}
function userKeySet(scroller) {
	const keys = /* @__PURE__ */ new Set();
	for (const row of scroller.querySelectorAll("[data-chat-flow-kind=\"user\"][data-chat-flow-key]")) {
		const key = row.getAttribute("data-chat-flow-key");
		if (key) keys.add(key);
	}
	return keys;
}
function safeSessionId(getSessionId) {
	if (getSessionId === void 0) return void 0;
	try {
		return getSessionId();
	} catch {
		return;
	}
}
/** 当前安装实例的 rAF 刷新入口（scheduleSettle 静默结束后复用它渲染最终态）。 */
let refreshScroller;
function scheduleSettle(scroller, state, isEnabled, delay) {
	if (state.settleTimer !== void 0) window.clearTimeout(state.settleTimer);
	state.settleTimer = window.setTimeout(() => {
		state.settleTimer = void 0;
		if (!scroller.isConnected) return;
		refreshScroller?.(scroller);
	}, Math.max(0, delay));
}
function renderBar(scroller, isEnabled, getSessionId) {
	if (!isEnabled()) {
		const stale = scroller.querySelector(`:scope > [${HOST_ATTR}]`);
		if (stale instanceof HTMLElement) stale.remove();
		return;
	}
	if (!scroller.isConnected) return;
	const host = ensureHost(scroller);
	const bar = host.querySelector(".dshSessionManagerStickyBar");
	const label = host.querySelector(".dshSessionManagerStickyText");
	const prompt = host.querySelector(".dshSessionManagerStickyPrompt");
	if (bar === null || label === null || prompt === null) return;
	const state = stateOf(scroller);
	const sessionId = safeSessionId(getSessionId);
	const keys = userKeySet(scroller);
	const switched = sessionId !== void 0 && state.sessionId !== void 0 && sessionId !== state.sessionId || isRowSetReplaced(state.keys, keys);
	if (sessionId !== void 0) state.sessionId = sessionId;
	if (switched) {
		state.keys = keys;
		const now$1 = Date.now();
		state.suppressStart = now$1;
		state.suppressUntil = now$1 + SETTLE_MS;
		hideBar(host, bar, prompt);
		scheduleSettle(scroller, state, isEnabled, SETTLE_MS);
		return;
	}
	state.keys = keys;
	const now = Date.now();
	if (state.suppressUntil > now && now - state.suppressStart < MAX_SUPPRESS_MS) {
		state.suppressUntil = Math.min(now + SETTLE_MS, state.suppressStart + MAX_SUPPRESS_MS);
		scheduleSettle(scroller, state, isEnabled, state.suppressUntil - now);
		return;
	}
	state.suppressUntil = 0;
	const rows = rowBoxesOf(scroller);
	const previous = host.dataset.dshStickyKey;
	const next = pickPinnedRow(rows.map((row) => ({
		key: row.key,
		top: row.top,
		bottom: row.bottom
	})), scroller.getBoundingClientRect().top, previous);
	const match = rows.find((row) => row.key === next);
	if (next === void 0 || match === void 0) {
		if (previous === void 0 || bar.hidden || hideTimers.has(host)) return;
		hideBar(host, bar, prompt);
		return;
	}
	const pendingHide = hideTimers.get(host);
	if (pendingHide !== void 0) {
		window.clearTimeout(pendingHide);
		hideTimers.delete(host);
	}
	const text = textOf(match.row);
	if (text === "") {
		hideBar(host, bar, prompt);
		return;
	}
	if (previous === next && !bar.hidden && pendingHide === void 0) {
		if (label.textContent !== text) label.textContent = text;
		bindJumpInto(prompt, scroller, next);
		return;
	}
	label.textContent = text;
	host.dataset.dshStickyKey = next;
	bar.hidden = false;
	bar.dataset.dshStickyVisible = "1";
	bindJumpInto(prompt, scroller, next);
	clearTransform(prompt);
}
/** 安装：滚动容器级监听 + 一次性 resize/Mutation 刷新。清理返回后 DOM 自净。 */
function installStickyUserRows(isEnabled = () => true, getSessionId) {
	let frame = 0;
	const refresh = (scroller) => {
		if (frame !== 0) return;
		frame = window.requestAnimationFrame(() => {
			frame = 0;
			renderBar(scroller, isEnabled, getSessionId);
		});
	};
	refreshScroller = refresh;
	const onScroll = (event) => {
		const target = event.target;
		if (!(target instanceof HTMLElement) || !target.hasAttribute("data-conversation-scroll")) return;
		refresh(target);
	};
	const onMutate = () => {
		for (const scroller of document.querySelectorAll("[data-conversation-scroll]")) refresh(scroller);
	};
	document.addEventListener("scroll", onScroll, {
		capture: true,
		passive: true
	});
	window.addEventListener("resize", onMutate);
	onMutate();
	return () => {
		document.removeEventListener("scroll", onScroll, true);
		window.removeEventListener("resize", onMutate);
		if (frame !== 0) window.cancelAnimationFrame(frame);
		refreshScroller = void 0;
		for (const host of document.querySelectorAll(`[${HOST_ATTR}]`)) host.remove();
	};
}
const STYLE_ID = "dsh-session-manager: sticky prompt";
const STYLES = `
[${HOST_ATTR}]{
  position:sticky;
  top:0;
  z-index:5;
  height:0;
  overflow:visible;
  pointer-events:none;
}
.dshSessionManagerStickyBar{
  position:absolute;
  left:0;
  right:0;
  top:0;
  display:flex;
  justify-content:center;
  padding:8px calc(var(--dsh-composer-side-clearance, 16px) + 16px);
  background:var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1, #fff));
  box-shadow:0 16px 16px -12px var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1, #fff));
  opacity:0;
  transition:opacity 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.dshSessionManagerStickyBar[data-dsh-sticky-visible]{opacity:1}
.dshSessionManagerStickyBar[hidden]{display:none}
.dshSessionManagerStickyPrompt{
  display:block;
  box-sizing:border-box;
  width:100%;
  max-width:var(--dsh-chat-content-width, 748px);
  margin:0;
  padding:10px 16px;
  border:none;
  border-radius:22px;
  background:var(--dsw-specific-bubble, var(--dsw-alias-bg-secondary, #f2f4f7));
  color:var(--dsw-alias-label-primary, #101828);
  font:inherit;
  font-size:var(--dsh-content-font-size, 14px);
  line-height:calc(22px + var(--dsh-content-font-delta, 0px));
  text-align:right;
  pointer-events:auto;
  cursor:pointer;
}
.dshSessionManagerStickyPrompt:focus-visible{
  outline:none;
  box-shadow:0 0 0 2px var(--dsw-alias-border-l3, #98a2b3);
}
.dshSessionManagerStickyText{
  display:-webkit-box;
  overflow:hidden;
  overflow-wrap:anywhere;
  white-space:normal;
  -webkit-box-orient:vertical;
  -webkit-line-clamp:2;
}
@media (prefers-reduced-motion:reduce){
  .dshSessionManagerStickyBar{box-shadow:none;opacity:1;transition:none}
  .dshSessionManagerStickyPrompt{transition:none}
}
`;
function ensureStickyStyle() {
	const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`);
	const tag = existing instanceof HTMLStyleElement ? existing : document.createElement("style");
	tag.dataset.plugin = "dsh-session-manager";
	tag.dataset.pluginCss = STYLE_ID;
	tag.textContent = STYLES;
	if (existing === null) document.head.appendChild(tag);
}
/** 在插件 Client ctx 上安装 sticky prompt；返回卸载函数。 */
function applyStickyPrompt(isEnabled = () => true, getSessionId) {
	if (typeof document === "undefined") return () => void 0;
	ensureStickyStyle();
	return installStickyUserRows(isEnabled, getSessionId);
}

//#endregion
//#region src/client/hidden.ts
/**
* The internal engine channel every client call is sent to. Mirrored by
* `ENGINE_COMMAND` in `src/index.ts` — the two bundles share no module.
*/
const ENGINE_COMMAND = "rewind-plugin";
/** Engine command names the client recognizes. */
const ENGINE_COMMANDS = new Set([ENGINE_COMMAND]);
/**
* The plain text of the human message at `seq` in the chat snapshot, for
* filling the composer after a withdraw. Accepts BOTH `user` and `steering`
* nodes: a plan-mode (`/plan <text>`) input is delivered through the agent
* inbox next-step and claimed, so it renders as `steering`, and its text must
* still return to the composer. State absent → undefined; a message with no
* text blocks → ''. Same text-blocks join the candidate side uses.
*/
function messageTextAt(chat, seq) {
	if (chat === void 0) return void 0;
	for (const key of chat.order) {
		const node = chat.nodes.get(key);
		if (node === void 0 || node.kind !== "user" && node.kind !== "steering") continue;
		const data = node.data;
		if (data.seq === seq) return data.content?.map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "").join("");
	}
}
/**
* Extract the rewind target seq from a command's structured `args`
* (e.g. `@5 chat`, `preview @5 both`). Locale-independent — never parses the
* host's human outcome copy.
*/
function targetSeqOfArgs(args) {
	if (args === void 0 || args === null) return void 0;
	const match = args.match(/@(\d+)/);
	return match !== null ? Number(match[1]) : void 0;
}
/**
* True when one of this plugin's engine command nodes is an EXECUTED rewind for
* `seq` — the admission form the popover drives (`@<seq> chat` / `both`) that
* settled with a marker-carrying success outcome. The composer refill waits for
* exactly this node after the user confirms, so a history-loaded command can
* never trigger a fill.
*/
function isExecutedRewindCommand(node, seq) {
	if (node.name === null || !ENGINE_COMMANDS.has(node.name) || node.outcome?.kind !== "success") return false;
	if (node.outcome.sourceEventSeq === void 0) return false;
	const args = node.args ?? "";
	return (/* @__PURE__ */ new RegExp(`(?:^|\\s)@${seq}(?:\\s|$)`)).test(args);
}
/**
* True when an engine command node is an impact preview — the internal probe
* the popover runs (`preview @seq both`) to fetch the restore/delete
* list. Previews never surface in the transcript (their result is shown in
* the popover), so their flow node is hidden in every state.
*/
function isPreviewCommand(command) {
	return (command.args ?? "").includes("preview");
}
/**
* True when an engine command node is the internal candidate-list probe
* (`__candidates`). Like previews, its flow node never surfaces in the
* transcript — it only feeds the picker — so it is hidden in every state.
*/
function isCandidateCommand(command) {
	return (command.args ?? "").includes("__candidates");
}
/**
* Coalesce rewind cut spans into disjoint, ascending ranges.
*
* A span covers an inclusive range of anchor seqs, so two spans that overlap
* describe one continuous cut and merge. Only strict overlap merges: adjacent
* ranges stay separate, which keeps the union exact without assuming seqs are
* integers. Membership then costs one binary search per node instead of a scan
* of every rewind × node pair.
*
* @param spans - one `[target, marker]` range per executed rewind.
* @returns the merged ranges, ascending by start.
*/
function coalesceCuts(spans) {
	if (spans.length < 2) return spans;
	const sorted = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
	const merged = [];
	for (const span of sorted) {
		const last = merged[merged.length - 1];
		if (last !== void 0 && span.start <= last.end) {
			if (span.end > last.end) last.end = span.end;
			continue;
		}
		merged.push({
			start: span.start,
			end: span.end
		});
	}
	return merged;
}
/**
* Whether an anchor seq falls inside any coalesced cut range.
* @param cuts - coalesced ranges, ascending by start (see `coalesceCuts`).
* @param seq - the anchor seq to test.
* @returns true when a rewind withdrew that seq.
*/
function cutsContain(cuts, seq) {
	let low = 0;
	let high = cuts.length - 1;
	while (low <= high) {
		const middle = low + high >> 1;
		const cut = cuts[middle];
		if (seq < cut.start) high = middle - 1;
		else if (seq > cut.end) low = middle + 1;
		else return true;
	}
	return false;
}
/**
* Node keys of rows OUTSIDE every cut, by anchor value. The DOM hide matches a
* row by anchor VALUE, so a chrome row may only join the set while no live row
* shares that value.
* @param snap - the live chat snapshot.
* @param cuts - coalesced withdrawn ranges (see `coalesceCuts`).
*/
function liveAnchorKeys(snap, cuts) {
	const live = /* @__PURE__ */ new Map();
	for (const key of snap.order) {
		const node = snap.nodes.get(key);
		if (node === void 0 || cutsContain(cuts, node.anchorSeq)) continue;
		const keys = live.get(node.anchorSeq);
		if (keys === void 0) live.set(node.anchorSeq, [key]);
		else keys.push(key);
	}
	return live;
}
const EMPTY_KEYS = [];
/**
* Add the Turn-process summary row of every Turn whose rows were ALL withdrawn.
*
* That row is the one Turn row whose anchor can precede the rewind target: a Turn
* stopped before any process evidence anchors at `turn.start.seq − 0.1`, which is
* BEFORE its human message (the target), so the anchor comparison never reaches
* it. Same rule as the seat pass's emptied GROUP shell, one level up: the summary
* goes when it can no longer disclose anything live. This reads a SUPERSET of the
* harness's disclosure members, so the test can only get harder to pass — a
* misjudgement drops the summary row, never a live one.
*
* @param snap - the live chat snapshot.
* @param cuts - coalesced withdrawn ranges (see `coalesceCuts`).
* @param hidden - the set being built; extended in place.
*/
function addWithdrawnTurnChrome(snap, cuts, hidden) {
	const locations = snap.locations;
	if (locations === void 0 || cuts.length === 0) return;
	let live;
	for (const key of snap.order) {
		const chrome = snap.nodes.get(key);
		if (chrome === void 0 || chrome.kind !== "turn-process") continue;
		const located = chrome.location?.turn;
		if (located?.start === void 0) continue;
		const turn = located.turn;
		if (typeof turn !== "number") continue;
		const keys = locations.getTurn(turn);
		if (keys.length === 0) continue;
		const rows = keys.map((member) => snap.nodes.get(member)).filter((member) => member !== void 0);
		if (rows.length !== keys.length) continue;
		if (!rows.every((member) => member.key === chrome.key || cutsContain(cuts, member.anchorSeq))) continue;
		live ??= liveAnchorKeys(snap, cuts);
		if ((live.get(chrome.anchorSeq) ?? EMPTY_KEYS).some((holder) => holder !== chrome.key)) continue;
		hidden.add(chrome.anchorSeq);
	}
}
/**
* Per-snapshot memo of {@link hiddenSeqsOf}.
*
* A chat snapshot wrapper is replaced on every committed update, while the
* refresher runs once per DOM mutation batch; the fold cannot have changed
* between those refreshes. The cache keeps its own copy and every hit returns a
* copy: the exported API must not hand callers a shared mutable `Set` that
* could poison the cache.
*/
const hiddenSeqsMemo = /* @__PURE__ */ new WeakMap();
/**
* Anchor seqs that must be hidden from the rendered transcript so the user sees
* the conversation as the agent sees it: every impact-preview flow node (it only
* exists to feed the popover) and every SUCCESSFUL executed rewind command
* row, plus every message a rewind withdrew — the target, everything after it,
* and the (unrendered) marker.
*
* Each executed rewind cuts ONE span `[target, marker]`, and callers must keep
* the spans SEPARATE: collapsing them to `[min target, max marker]` would hide a
* still-on-surface gap of new traffic between an earlier marker and a later
* target. Endpoints come from the command nodes (`sourceEventSeq` is the
* marker's log seq; the outcome text carries the target seq).
*
* A Turn whose rows were ALL withdrawn also contributes its Turn-process summary
* row, whose own anchor can precede the target (see `addWithdrawnTurnChrome`).
*/
function hiddenSeqsOf(snap) {
	const memo = hiddenSeqsMemo.get(snap);
	if (memo !== void 0) return new Set(memo);
	const hidden = /* @__PURE__ */ new Set();
	const spans = [];
	for (const key of snap.order) {
		const node = snap.nodes.get(key);
		if (node === void 0 || node.kind !== "command") continue;
		const command = node.data;
		if (command.name === null || !ENGINE_COMMANDS.has(command.name)) continue;
		if (isPreviewCommand(command) || isCandidateCommand(command)) {
			hidden.add(command.seq);
			continue;
		}
		if (command.outcome?.kind !== "success") continue;
		const marker = command.outcome.sourceEventSeq;
		if (marker === void 0) continue;
		hidden.add(command.seq);
		const target = targetSeqOfArgs(command.args);
		if (target !== void 0) spans.push({
			start: target,
			end: marker
		});
	}
	const cuts = coalesceCuts(spans);
	for (const key of snap.order) {
		const node = snap.nodes.get(key);
		if (node === void 0) continue;
		if (cutsContain(cuts, node.anchorSeq)) hidden.add(node.anchorSeq);
	}
	try {
		addWithdrawnTurnChrome(snap, cuts, hidden);
	} catch {}
	hiddenSeqsMemo.set(snap, new Set(hidden));
	return new Set(hidden);
}

//#endregion
//#region src/client/styles.ts
/**
* 回退按钮与模式浮层的样式类 + 注入 CSS（沿用 --dsw-* 设计令牌，
* 与宿主菜单视觉一致）。样式由 client 入口的 ensureRewindStyle 注入。
*
* Ported from SiriLee/dsh-rewind (MIT), src/client/styles.ts（去掉与本插件
* 无关的部分，类名换成 dsmgr- 前缀）。
*/
const CLASS = {
	button: "dsmgr-rewind-btn",
	popover: "dsmgr-rewind-popover",
	popoverTitle: "dsmgr-rewind-popover-title",
	popoverTarget: "dsmgr-rewind-popover-target",
	popoverOption: "dsmgr-rewind-popover-option",
	popoverOptionLabel: "dsmgr-rewind-popover-option-label",
	popoverOptionHint: "dsmgr-rewind-popover-option-hint",
	popoverImpact: "dsmgr-rewind-popover-impact",
	popoverNote: "dsmgr-rewind-popover-note",
	popoverActions: "dsmgr-rewind-popover-actions",
	popoverPrimary: "dsmgr-rewind-popover-primary",
	popoverGhost: "dsmgr-rewind-popover-ghost"
};
/**
* The ↶ glyph, drawn inline so the bundle stays dependency-free.
*
* Size follows the product-icon set (15px, as the neighbouring copy/branch
* actions). Stroke 1.25: ↶ is a single open stroke next to dense outline
* glyphs, so at 1 it reads thinned out.
*/
const REWIND_ICON_SVG = [
	"<svg width=\"15\" height=\"15\" viewBox=\"0 0 16 16\" fill=\"none\" aria-hidden=\"true\">",
	"  <path d=\"M6.5 2.5 2.5 6.5l4 4\" stroke=\"currentColor\" stroke-width=\"1.25\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
	"  <path d=\"M2.5 6.5h7a4 4 0 0 1 4 4v1.5\" stroke=\"currentColor\" stroke-width=\"1.25\" stroke-linecap=\"round\"/>",
	"</svg>"
].join("");
/** 浮层与按钮样式（scoped under `.dsmgr-rewind-*`）。 */
/** The ✎ glyph:与 ↶ 同一套视觉参数(15px、描边 1.25、圆角端点)。 */
const EDIT_ICON_SVG = [
	"<svg width=\"15\" height=\"15\" viewBox=\"0 0 16 16\" fill=\"none\" aria-hidden=\"true\">",
	"  <path d=\"M11.3 2.6a1.5 1.5 0 0 1 2.1 2.1L5.2 12.9l-2.8.7.7-2.8 8.2-8.2z\" stroke=\"currentColor\" stroke-width=\"1.25\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
	"</svg>"
].join("");
const REWIND_STYLE = `
/* 行内编辑态:该用户行只显示编辑器,其余内容(气泡/操作行)隐藏。 */
[data-chat-flow-kind="user"][data-dsh-editing="true"] > :not([data-dsh-edit-editor]) {
  display: none !important;
}
.dsmgr-rewind-popover {
  position: fixed;
  z-index: 1000;
  width: 288px;
  padding: 12px;
  /* 材质对齐宿主 overlay（dsh-rewind v0.18.0）：elevation 描边 + 阴影 +
     背景 backdrop 隔离，替代中性边框。 */
  border: 0;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  isolation: isolate;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3));
  font-size: 14px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dsmgr-rewind-popover-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}
.dsmgr-rewind-popover-target {
  margin: 4px 0 10px;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  word-break: break-all;
}
.dsmgr-rewind-popover-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  margin: 0 0 6px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsmgr-rewind-popover-option:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
/* 方向键移动真实焦点，焦点行携带指针填充、抑制浏览器圈环（暗色模式下
   双色圈环会在填充行上读作残边）。 */
.dsmgr-rewind-popover-option:focus-visible:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  outline: none;
}
.dsmgr-rewind-popover-option:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsmgr-rewind-popover-option-label {
  font-weight: 500;
}
.dsmgr-rewind-popover-option-hint {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsmgr-rewind-popover-impact {
  margin: 4px 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  max-height: 160px;
  overflow: auto;
}
.dsmgr-rewind-popover-note {
  margin-top: 6px;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-tertiary);
}
.dsmgr-rewind-popover-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dsmgr-rewind-popover-primary,
.dsmgr-rewind-popover-ghost {
  padding: 5px 12px;
  border: none;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
}
.dsmgr-rewind-popover-primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dsmgr-rewind-popover-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}
.dsmgr-rewind-popover-primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsmgr-rewind-popover-ghost {
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.dsmgr-rewind-popover-ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
`;

//#endregion
//#region src/client/popover.ts
/** 单例浮层元素；null 表示关闭。 */
let popoverEl = null;
/**
* pointerdown 预取槽：按钮按下的瞬间就发起 preview（人手按下到弹起约
* 80-150ms，足够覆盖探测往返），浮层打开时若已落定则直接以最终态首渲染
* ——多数情况下「正在检查文件变更…」根本不会出现。打开即消费（一次性）。
*/
let prewarmSlot = null;
/** 在按钮 pointerdown 时预取某目标的 preview（无副作用，失败静默）。 */
function prewarmPreview(sessionId, seq) {
	try {
		const slot = {
			seq,
			promise: previewImpact(sessionId, seq)
		};
		slot.promise.then((outcome) => {
			slot.settled = outcome;
		}).catch(() => {});
		prewarmSlot = slot;
	} catch {}
}
let disposeOutside = null;
/** 浮层持有键盘的会话 id；null 表示无。 */
let liveSessionId = null;
/** 插件的 composer 聚焦通道（把键盘还给某会话的 composer）。 */
let composerFocuser = null;
/** 注册 composer 聚焦通道（client 插件装配时调用一次）。 */
function registerComposerFocuser(focus) {
	composerFocuser = focus;
}
/** 在途的延迟开门回调；closePopover 取消它（关门后再开门=幽灵浮层）。 */
let pendingMount = null;
/** 关闭当前浮层（如有），并把键盘还给其 composer。 */
function closePopover() {
	pendingMount = null;
	if (popoverEl !== null) {
		popoverEl.remove();
		popoverEl = null;
	}
	if (disposeOutside !== null) {
		disposeOutside();
		disposeOutside = null;
	}
	const sessionId = liveSessionId;
	liveSessionId = null;
	if (sessionId !== null) try {
		composerFocuser?.(sessionId);
	} catch {}
}
/** 目标行格式（seq · [HH:MM ·] 预览）。 */
function formatTarget(seq, time, preview) {
	if (time === void 0) return `seq ${seq} · ${preview || "(无文本)"}`;
	const d = new Date(time);
	return `seq ${seq} · ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} · ${preview || "(无文本)"}`;
}
/** 找最新的匹配谓词的回退命令节点。 */
function findCommand(chat, match) {
	if (chat === void 0) return void 0;
	let found;
	for (const key of chat.order) {
		const node = chat.nodes.get(key);
		if (node !== void 0 && node.kind === "command") {
			const command = node.data;
			if (match(command)) found = command;
		}
	}
	return found;
}
/**
* 当前匹配 `match` 的命令节点 seq 集合。在发出同形状新命令前采样，供随后
* 的等待排除：同一目标的重复 preview/回退必须等本次命令的节点，而不是
* 落在上一条命令的陈旧结局上。
*/
function knownCommandSeqs(session, chatOf, match) {
	const known = /* @__PURE__ */ new Set();
	const chat = chatOf(session);
	if (chat === void 0) return known;
	for (const key of chat.order) {
		const node = chat.nodes.get(key);
		if (node !== void 0 && node.kind === "command") {
			const command = node.data;
			if (match(command)) known.add(command.seq);
		}
	}
	return known;
}
/**
* 监听会话快照解析最新匹配回退命令的结局（command/run + command/done 落
* 成一个 CommandNode）。
* @returns 带结局文本的节点，超时返回 null。
*/
function waitForCommand(session, chatOf, match, timeoutMs = 8e3, watch) {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(value);
		};
		const check = () => {
			const node = findCommand(chatOf(session), match);
			if (node?.outcome !== null && node?.outcome !== void 0) settle({
				kind: node.outcome.kind,
				text: node.outcome.text
			});
		};
		const unsubscribe = watch(check);
		const timer = setTimeout(() => settle(null), timeoutMs);
		check();
	});
}
/** 预览调用通道：由 client 入口装配时注入（Connection RPC）。 */
let previewCall = null;
/** 注册/注销预览通道（插件装配与卸载时调用）。 */
function registerPreviewCall(call) {
	previewCall = call;
}
/** 发起一次影响预览（通道未就绪时返回错误结局）。 */
function previewImpact(sessionId, seq) {
	if (previewCall === null) return Promise.resolve({
		kind: "error",
		text: "预览通道未就绪"
	});
	return previewCall(sessionId, seq);
}
/** 元素工厂（本地实现，不引框架）。 */
function el(tag, className, text) {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== void 0) node.textContent = text;
	return node;
}
function modeOption(label, hint, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = CLASS.popoverOption;
	const labelEl = el("span", CLASS.popoverOptionLabel, label);
	const hintEl = el("span", CLASS.popoverOptionHint, hint);
	button.append(labelEl, hintEl);
	button.addEventListener("click", onClick);
	return button;
}
/**
* 当前浮层步里启用、可聚焦的按钮（DOM 序）。ghost 返回/取消按钮刻意排除：
* 它们是 Esc 专属（不进 ↑/↓ 循环）。
*/
function focusableButtons(root) {
	return Array.from(root.querySelectorAll("button")).filter((button) => !button.disabled && !button.classList.contains(CLASS.popoverGhost));
}
/** 聚焦当前步第一个启用按钮（无则 no-op）。 */
function focusFirst(root) {
	focusableButtons(root)[0]?.focus();
}
/** 在步内按钮间移动焦点，两端环绕。 */
function moveFocus(root, dir) {
	const buttons = focusableButtons(root);
	if (buttons.length === 0) return;
	const active = document.activeElement;
	const index = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;
	buttons[index === -1 ? dir === 1 ? 0 : buttons.length - 1 : (index + dir + buttons.length) % buttons.length]?.focus();
}
/**
* 渲染影响清单步：展示影响结局，然后确认/返回。
* 打开浮层时已取的结局复用——这里再跑一次 preview 会重复探测并留下第二
* 条（会被隐藏的）命令行。
*/
function renderImpactStep(root, opts, back, cached) {
	const { sessionId, seq, onRewind } = opts;
	const impact = el(CLASS.popoverImpact, CLASS.popoverImpact);
	impact.textContent = "正在检查文件变更…";
	const actions = el("div", CLASS.popoverActions);
	const backButton = document.createElement("button");
	backButton.type = "button";
	backButton.className = CLASS.popoverGhost;
	backButton.textContent = "返回";
	backButton.addEventListener("click", back);
	actions.append(backButton);
	const confirm = document.createElement("button");
	confirm.type = "button";
	confirm.className = CLASS.popoverPrimary;
	confirm.textContent = "确认回退";
	confirm.disabled = true;
	actions.append(confirm);
	root.replaceChildren(impact, actions);
	focusFirst(root);
	(async () => {
		const outcome = cached ?? await previewImpact(sessionId, seq);
		if (outcome === null) {
			impact.textContent = "获取文件变更失败：请求超时";
			return;
		}
		if (outcome.kind === "error") {
			impact.textContent = `获取文件变更失败：${outcome.text}`;
			return;
		}
		const restores = outcome.files.filter((f) => f.action === "restore").map((f) => f.path);
		const deletes = outcome.files.filter((f) => f.action === "delete").map((f) => f.path);
		if (restores.length === 0 && deletes.length === 0) impact.textContent = "目标之后没有需要还原的变更。";
		else {
			const lines = [...restores.map((path) => `还原 ${path}`), ...deletes.map((path) => `删除 ${path}`)];
			if (outcome.backupOff) {
				const list = document.createElement("div");
				list.textContent = lines.join("\n");
				impact.replaceChildren(list, el("div", CLASS.popoverNote, "快照备份已关闭，本次还原可能不充分。"));
			} else impact.textContent = lines.join("\n");
		}
		confirm.disabled = false;
		confirm.focus();
		confirm.addEventListener("click", () => {
			closePopover();
			onRewind("both", outcome.kind === "success" ? outcome.planId : void 0);
		});
	})().catch(() => {
		impact.textContent = "获取文件变更失败：意外错误";
	});
}
/** 围绕 root 挂载共享浮层壳。 */
function mountShell(root, anchor, onKeyDown) {
	/** 定位在锚点下方右对齐，近底部翻转到上方；最终钳制在视口内。 */
	const position = () => {
		const rect = anchor.getBoundingClientRect();
		const gap = 4;
		const height = root.offsetHeight;
		const width = root.offsetWidth;
		const rawTop = rect.bottom + gap + height <= window.innerHeight - 8 ? rect.bottom + gap : rect.top - gap - height;
		const rawLeft = Math.min(rect.right, window.innerWidth - 8 - width);
		const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
		root.style.top = `${Math.round(clamp(rawTop, 8, window.innerHeight - height - 8))}px`;
		root.style.left = `${Math.round(clamp(rawLeft, 8, window.innerWidth - width - 8))}px`;
	};
	const onPointerDown = (event) => {
		const target = event.target;
		if (root.contains(target) || anchor.contains(target)) return;
		closePopover();
	};
	const deferred = setTimeout(() => {
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
	}, 0);
	const dispose = () => {
		clearTimeout(deferred);
		document.removeEventListener("pointerdown", onPointerDown);
		document.removeEventListener("keydown", onKeyDown, true);
	};
	document.body.append(root);
	position();
	return {
		position,
		dispose
	};
}
/** 打开锚定在按钮附近的模式选择浮层。 */
function openPopover(opts) {
	closePopover();
	liveSessionId = opts.sessionId;
	const { sessionId, seq, time, preview, anchor, onRewind } = opts;
	const root = el("div", CLASS.popover);
	root.setAttribute("role", "dialog");
	root.setAttribute("aria-label", "回退对话");
	let bothState = { state: "loading" };
	/** 打开时取到的影响结局；both 步复用（不再发第二条命令行）。 */
	let impactOutcome = null;
	/** 当前步：Esc 在模式步是取消，在影响步是返回。 */
	let step = "modes";
	const renderModes = () => {
		step = "modes";
		const children = [
			el("div", CLASS.popoverTitle, "回退对话"),
			el("div", CLASS.popoverTarget, formatTarget(seq, time, preview)),
			modeOption("仅回退对话", "撤回这条消息及其后的对话，文本回填输入框", () => {
				closePopover();
				onRewind("chat");
			})
		];
		if (bothState.state === "noChanges") children.push(el("div", CLASS.popoverImpact, "目标之后没有需要还原的文件变更。"));
		else if (bothState.state === "error") children.push(el("div", CLASS.popoverImpact, `获取文件变更失败：${bothState.message}`));
		else {
			const option = modeOption("回退对话和代码", bothState.state === "loading" ? "正在检查文件变更…" : "同时还原被改动的文件", renderImpact);
			if (bothState.state === "loading") option.disabled = true;
			children.push(option);
		}
		const actions = el("div", CLASS.popoverActions);
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = CLASS.popoverGhost;
		cancel.textContent = "取消";
		cancel.addEventListener("click", closePopover);
		actions.append(cancel);
		children.push(actions);
		root.replaceChildren(...children);
		focusFirst(root);
	};
	/** 进入影响清单步（返回/Esc 回到模式步）。 */
	const renderImpact = () => {
		step = "impact";
		renderImpactStep(root, opts, renderModes, impactOutcome);
	};
	const onKeyDown = (event) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			event.stopPropagation();
			moveFocus(root, 1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			moveFocus(root, -1);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			if (step === "impact") renderModes();
			else closePopover();
		}
	};
	const pre = prewarmSlot;
	prewarmSlot = null;
	const usePre = pre !== null && pre.seq === seq ? pre : null;
	/** 把一次探测结局落到 both 可用性状态。 */
	const applyOutcome = (outcome) => {
		impactOutcome = outcome;
		if (outcome !== null && outcome.kind === "success") bothState = { state: outcome.files.length > 0 ? "hasChanges" : "noChanges" };
		else bothState = {
			state: "error",
			message: outcome?.text ?? "预览请求超时"
		};
	};
	/** 开门：首渲染 + 挂壳；both 仍为加载态时继续 dsh-rewind 的异步落定。 */
	const mount = () => {
		renderModes();
		const shell = mountShell(root, anchor, onKeyDown);
		popoverEl = root;
		disposeOutside = shell.dispose;
		shell.position();
		if (bothState.state !== "loading") return;
		(async () => {
			applyOutcome(usePre !== null ? await usePre.promise : await previewImpact(sessionId, seq));
			renderModes();
			shell.position();
		})().catch(() => {
			bothState = {
				state: "error",
				message: "意外错误"
			};
			renderModes();
			shell.position();
		});
	};
	if (usePre !== null && usePre.settled !== void 0) {
		applyOutcome(usePre.settled);
		mount();
		return;
	}
	if (usePre !== null) {
		pendingMount = mount;
		(async () => {
			await Promise.race([usePre.promise.catch(() => null), new Promise((r) => setTimeout(r, 250))]);
			const go = pendingMount;
			pendingMount = null;
			if (go !== mount) return;
			if (usePre.settled !== void 0) applyOutcome(usePre.settled);
			mount();
		})();
		return;
	}
	mount();
}

//#endregion
//#region src/client/host-rpc.ts
/**
* 回退读取的 RPC 通道（浏览器半）：影响预览走 Connection RPC，不占命令
* 通道、不往会话日志追加 command/run 事件（对齐 dsh-rewind v0.18.0）。
*
* Ported from SiriLee/dsh-rewind (MIT), src/client/host-rpc.ts（仅 preview
* 端点；响应额外携带 host 托管的 planId，供 both 执行的 TOCTOU 复核）。
*
* @module dsh-session-manager/client/host-rpc
*/
const CHANNEL = "dsh-session-manager-rewind";
const TIMEOUT_MS = 8e3;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isImpact(value) {
	return isRecord(value) && typeof value["path"] === "string" && (value["action"] === "restore" || value["action"] === "delete");
}
function isAbort(error) {
	const name$1 = error?.name;
	return name$1 === "AbortError" || name$1 === "TimeoutError";
}
/** 经 RPC 解析一个目标的影响清单（含 planId）。 */
async function previewOverRpc(connection, sessionId, seq) {
	if (connection === void 0) return {
		kind: "error",
		text: "host RPC 不可用"
	};
	try {
		const result = await connection.rpc.call(CHANNEL, "preview", {
			sessionId,
			seq
		}, AbortSignal.timeout(TIMEOUT_MS));
		if (!result.ok) return {
			kind: "error",
			text: result.error.message
		};
		const value = result.value;
		if (!isRecord(value) || typeof value["backupOff"] !== "boolean" || !Array.isArray(value["files"]) || !value["files"].every(isImpact) || value["planId"] !== void 0 && typeof value["planId"] !== "string") return {
			kind: "error",
			text: "预览响应无效"
		};
		return {
			kind: "success",
			files: value["files"],
			backupOff: value["backupOff"],
			planId: value["planId"]
		};
	} catch (error) {
		if (isAbort(error)) return null;
		return {
			kind: "error",
			text: error instanceof Error ? error.message : String(error)
		};
	}
}

//#endregion
//#region src/client/settings.ts
const SETTINGS_NAMESPACE = "dsh-session-manager";
/** 开关状态：字段缺省即视为开启（与 Host schema 默认值一致）。 */
function readSettings(snapshot) {
	const value = snapshot.value ?? {};
	return {
		stickyPrompt: value.stickyPromptEnabled !== false,
		sessionDelete: value.sessionDeleteEnabled !== false
	};
}
const CSS_ATTR = "data-dsmgr-css";
function injectCss() {
	if (typeof document === "undefined") return () => void 0;
	const previous = document.querySelector(`style[${CSS_ATTR}]`);
	const tag = previous instanceof HTMLStyleElement ? previous : document.createElement("style");
	tag.setAttribute(CSS_ATTR, "1");
	tag.textContent = [
		".dsmgr_card{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}",
		".dsmgr_row{display:flex;align-items:center;gap:12px;padding:12px 14px}",
		".dsmgr_row+.dsmgr_row{border-top:1px solid var(--dsw-alias-border-l2)}",
		".dsmgr_rowText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
		".dsmgr_rowTitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
		".dsmgr_rowDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
		".dsmgr_card .dsmgr_toggle{appearance:none;position:relative;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}",
		".dsmgr_card .dsmgr_toggle[aria-checked=true]{background:var(--dsw-alias-brand-primary)}",
		".dsmgr_card .dsmgr_toggle:disabled{opacity:.5;cursor:default}",
		".dsmgr_card .dsmgr_toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
		".dsmgr_card .dsmgr_knob{corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}",
		".dsmgr_card .dsmgr_toggle[aria-checked=false] .dsmgr_knob{background:var(--dsw-alias-switch-thumb)}",
		".dsmgr_note{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}"
	].join("");
	if (previous === null) document.head.appendChild(tag);
	return () => tag.remove();
}
function ToggleSwitch(props) {
	return react.default.createElement("button", {
		type: "button",
		role: "switch",
		"aria-checked": props.checked,
		"aria-label": props.label,
		disabled: props.disabled,
		className: "dsmgr_toggle",
		style: {
			boxSizing: "border-box",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "flex-start",
			flex: "0 0 auto",
			width: 36,
			height: 20,
			padding: 2,
			margin: 0,
			border: 0,
			borderRadius: 999
		},
		onClick: props.onChange
	}, react.default.createElement("span", {
		className: "dsmgr_knob",
		style: {
			boxSizing: "border-box",
			display: "block",
			flexShrink: 0,
			width: 16,
			height: 16,
			margin: 0,
			padding: 0,
			border: 0,
			borderRadius: "50%",
			transform: `translateX(${props.checked ? 16 : 0}px)`
		}
	}));
}
function SettingsRow(props) {
	return react.default.createElement("div", { className: "dsmgr_row" }, react.default.createElement("div", { className: "dsmgr_rowText" }, react.default.createElement("div", { className: "dsmgr_rowTitle" }, props.title), react.default.createElement("div", { className: "dsmgr_rowDesc" }, props.description)), react.default.createElement(ToggleSwitch, {
		checked: props.checked,
		disabled: props.disabled,
		label: props.title,
		onChange: props.onChange
	}));
}
function SessionManagerSection(props) {
	const { scope } = props;
	const [snapshot, setSnapshot] = (0, react.useState)(() => scope.getSnapshot());
	const [writeError, setWriteError] = (0, react.useState)();
	(0, react.useEffect)(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
	const settings = readSettings(snapshot);
	const writable = snapshot.status === "ready" && snapshot.writable === true;
	const row = (title, description, checked, field) => react.default.createElement(SettingsRow, {
		title,
		description,
		checked,
		disabled: !writable,
		onChange: () => {
			setWriteError(void 0);
			scope.set(field, !checked).then((accepted) => {
				if (!accepted) setWriteError("设置未保存，请根据最新状态重试。");
			}, () => setWriteError("设置保存失败，请检查连接后重试。"));
		}
	});
	const note = snapshot.status === "loading" ? "正在读取设置…" : snapshot.status === "unavailable" ? "设置暂时不可用，请确认 Host 已加载兼容的 dsh-session-manager 插件，并刷新页面。" : snapshot.writable === false ? "当前设置只读（由上层配置下发）。" : "修改立即生效，无需重启。";
	return react.default.createElement("div", null, react.default.createElement("div", { className: "dsmgr_card" }, row("提示词悬浮", "滚动长回复时，把最近一条滚出视口顶部的用户消息固定在会话顶部，点击可跳回原消息。", settings.stickyPrompt, "stickyPromptEnabled"), row("删除会话", "在会话记录的下拉菜单末尾添加“删除会话”（始终为最后一项）。", settings.sessionDelete, "sessionDeleteEnabled")), react.default.createElement("div", {
		className: "dsmgr_note",
		role: writeError ? "alert" : void 0
	}, writeError ?? note));
}

//#endregion
//#region src/client/index.ts
const name = "dsh-session-manager-client";
const inject = [
	"slots",
	"workspaces",
	"sessions",
	"configForms"
];
/**
* 当前主视图会话 id：优先老版本的 current 字段；0.2.1 起取
* retainedBy.mainView > 0 的会话（对齐 dsh-rewind 的 isMainViewSession）。
*/
function currentSessionId(sessions) {
	const state = sessions.list.getSnapshot();
	if (typeof state.current === "string" && state.current !== "") return state.current;
	const byId = state.byId ?? {};
	for (const [id, row] of Object.entries(byId)) if ((row.retainedBy?.mainView ?? 0) > 0) return id;
}
/** 0.1.2 里助手的 chat 节点 kind 实际是 "assistant-step"（不是 "assistant"）。 */
function isAssistantNode(node) {
	return node.kind === "assistant-step" || node.kind === "assistant";
}
function apply(ctx) {
	const { slots, workspaces, sessions } = ctx;
	const getUiConversation = () => {
		try {
			return ctx.get("uiConversation");
		} catch {
			return;
		}
	};
	const scope = ctx.configForms.get(SETTINGS_NAMESPACE);
	const disposeSettingsCss = injectCss();
	let disposeSticky;
	let disposeSessionMenu;
	const stickyEnabledNow = () => readSettings(scope.getSnapshot()).stickyPrompt;
	const sessionDeleteEnabledNow = () => readSettings(scope.getSnapshot()).sessionDelete;
	const syncFeatureGates = () => {
		const { stickyPrompt, sessionDelete } = readSettings(scope.getSnapshot());
		if (stickyPrompt && disposeSticky === void 0) disposeSticky = applyStickyPrompt(stickyEnabledNow, () => {
			try {
				return currentSessionId(sessions);
			} catch {
				return;
			}
		});
		else if (!stickyPrompt && disposeSticky !== void 0) {
			disposeSticky();
			disposeSticky = void 0;
		}
		if (sessionDelete && disposeSessionMenu === void 0) disposeSessionMenu = installSessionMenuDelete(workspaces, sessions, sessionDeleteEnabledNow);
		else if (!sessionDelete && disposeSessionMenu !== void 0) {
			disposeSessionMenu();
			disposeSessionMenu = void 0;
		}
	};
	slots.inject("settings.section", () => slots.register({
		name: "settings.section",
		id: SETTINGS_NAMESPACE,
		order: 710,
		label: "会话管理",
		inject: () => ({ scope })
	}, SessionManagerSection));
	const unsubscribeSettings = scope.subscribe(syncFeatureGates);
	syncFeatureGates();
	slots.inject("conversation.chat.assistant-actions", () => {
		return slots.register({
			name: "conversation.chat.assistant-actions",
			id: "retry-message",
			order: -10,
			label: "重新生成"
		}, function RetryAction(props) {
			const sessionId = String(props.sessionId ?? "");
			const messageId = String(props.messageId ?? "");
			return react.default.createElement(RetryButton, {
				key: messageId,
				sessionId,
				messageId,
				sessions,
				getUiConversation
			});
		});
	});
	const getConversation = () => {
		try {
			return ctx.get("conversation");
		} catch {
			return;
		}
	};
	const getConnection = () => {
		try {
			return ctx.get("connection");
		} catch {
			return;
		}
	};
	const disposeRewind = installRewindEntries(sessions, getUiConversation, getConversation, getConnection);
	ctx.on?.("dispose", disposeRewind);
	ctx.on?.("dispose", () => closePopover());
	ctx.on?.("dispose", () => {
		unsubscribeSettings();
		disposeSticky?.();
		disposeSessionMenu?.();
		disposeSettingsCss();
	});
}
/** 取用户消息首个文本块(前 80 字)。 */
function extractUserText(content) {
	if (!Array.isArray(content)) return "";
	for (const block of content) if (typeof block === "object" && block !== null) {
		const b = block;
		if ((b.type === "text" || b.kind === "text") && typeof b.text === "string") return b.text.slice(0, 80);
	}
	return "";
}
/**
* 把本仓的 ChatSnapshotView 适配成 hidden 模块的 HiddenChat 读取器：
* hidden 的算法按 order+get(key) 消费快照，本仓节点存储只有 values()。
*/
function hiddenChatOf(chat) {
	if (!chat?.nodes) return void 0;
	const byKey = /* @__PURE__ */ new Map();
	const orderKeys = [];
	for (const node of chat.nodes.values()) if (typeof node.key === "string" && node.key !== "") {
		byKey.set(node.key, node);
		orderKeys.push(node.key);
	}
	return {
		order: chat.order ?? orderKeys,
		nodes: { get: (key) => {
			const node = byKey.get(key);
			if (node === void 0) return void 0;
			return node;
		} },
		...chat.locations !== void 0 ? { locations: chat.locations } : {}
	};
}
/** key → 节点索引（隐藏判定按行 key 找 anchorSeq）。 */
function nodeKeyIndex(chat) {
	const byKey = /* @__PURE__ */ new Map();
	if (!chat?.nodes) return byKey;
	for (const node of chat.nodes.values()) if (typeof node.key === "string" && node.key !== "") byKey.set(node.key, node);
	return byKey;
}
/**
* 从 chat 视图精确计算每条可回退的用户消息：in-place 方案的目标就是消息
* 自身的 seq（不再需要 turnEnds 推 fork 边界）。用户气泡与 steering 插话
* 都算（插话尚未被模型读取，同样可撤回）。
*/
function computeRewindCandidates(chat) {
	if (!chat?.nodes) return [];
	const byKey = nodeKeyIndex(chat);
	const keys = chat.order ?? [...byKey.keys()];
	const result = [];
	for (const key of keys) {
		const node = byKey.get(key);
		if (node === void 0 || node.kind !== "user" && node.kind !== "steering") continue;
		const seq = typeof node.anchorSeq === "number" ? node.anchorSeq : node.data?.seq;
		if (typeof seq !== "number") continue;
		result.push({
			key,
			seq,
			preview: extractUserText(node.data?.content)
		});
	}
	return result;
}
function computeUserRefreshTargets(chat) {
	const map = /* @__PURE__ */ new Map();
	if (!chat?.nodes) return map;
	const generatingTurns = /* @__PURE__ */ new Set();
	const assistantKeysByTurn = /* @__PURE__ */ new Map();
	for (const node of chat.nodes.values()) {
		const turn = node.location?.turn?.turn;
		if (!isAssistantNode(node)) continue;
		if (typeof turn === "number") {
			if (typeof node.key === "string" && node.key !== "") {
				const keys = assistantKeysByTurn.get(turn) ?? [];
				keys.push(node.key);
				assistantKeysByTurn.set(turn, keys);
			}
			if (node.data?.status === "running") generatingTurns.add(turn);
		}
	}
	const turnEnds = chat.legacy?.turnEnds;
	for (const node of chat.nodes.values()) {
		if (node.kind !== "user" || node.visibility === "hidden") continue;
		if (typeof node.key !== "string" || node.key === "") continue;
		const turn = node.location?.turn?.turn;
		if (typeof turn !== "number") continue;
		const content = node.data?.content;
		if (!Array.isArray(content) || content.length === 0) continue;
		const seq = typeof node.anchorSeq === "number" ? node.anchorSeq : node.data?.seq;
		if (typeof seq !== "number") continue;
		let previousTurnEnd;
		if (turnEnds) {
			for (const [completedTurn, endSeq] of turnEnds) if (completedTurn < turn && (previousTurnEnd === void 0 || endSeq > previousTurnEnd)) previousTurnEnd = endSeq;
		}
		map.set(node.key, {
			key: node.key,
			seq,
			turn,
			content: [...content],
			previousTurnEnd,
			generating: generatingTurns.has(turn),
			assistantKeys: assistantKeysByTurn.get(turn) ?? []
		});
	}
	return map;
}
function refreshIcon() {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.5");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.append(createSvgElement("path", { d: "M13.5 8a5.5 5.5 0 0 1-9.5 3.5" }), createSvgElement("path", { d: "M2.5 8a5.5 5.5 0 0 1 9.5-3.5" }), createSvgElement("polyline", { points: "6,4 2,4 2,8" }), createSvgElement("polyline", { points: "10,12 14,12 14,8" }));
	return svg;
}
/** 把刷新按钮放到「时间」之后（复制/回滚之前）；无时间元素时退回最前。 */
function placeRefreshButton(actions, button) {
	const time = actions.querySelector("[class*=\"timeStart\"], [class*=\"timeEnd\"]");
	if (time) {
		if (time.nextSibling !== button) actions.insertBefore(button, time.nextSibling);
		return;
	}
	if (actions.firstChild !== button) actions.insertBefore(button, actions.firstChild);
}
function escapeSelector(value) {
	try {
		const escape = window.CSS?.escape;
		if (escape) return escape(value);
	} catch {}
	return value.replace(/["\\]/g, "\\$&");
}
/**
* 点击刷新/重新生成后的即时反馈：把该回合的助手 seat 降暗并追加“正在回复中…”占位，
* 让 fork 在后台跑时不显得卡住。返回的 restore 在成功切换或失败后调用（幂等）。
* 优先按 seat key 精确命中；key 缺失/查不到时退回按 data-chat-turn 整轮（排除用户行）。
*/
function showRegeneratingPlaceholder(seatKeys, turn) {
	if (typeof document === "undefined") return () => void 0;
	const seats = [];
	for (const key of seatKeys) {
		if (!key) continue;
		const seat = document.querySelector(`[data-chat-flow-key="${escapeSelector(key)}"]`);
		if (seat) seats.push(seat);
	}
	if (seats.length === 0 && typeof turn === "number") for (const el$1 of Array.from(document.querySelectorAll(`[data-chat-turn="${turn}"]`))) {
		const kind = el$1.getAttribute("data-chat-flow-kind") ?? "";
		if (kind !== "user" && kind !== "steering") seats.push(el$1);
	}
	if (seats.length === 0) return () => void 0;
	for (const seat of seats) {
		seat.style.opacity = "0.5";
		seat.style.filter = "saturate(0.55)";
	}
	const badge = document.createElement("div");
	badge.className = "dsh-regen-placeholder";
	badge.textContent = "正在回复中…";
	seats[seats.length - 1].appendChild(badge);
	return () => {
		for (const seat of seats) {
			seat.style.opacity = "";
			seat.style.filter = "";
		}
		badge.remove();
	};
}
/** 在 actions 行里维护「刷新」按钮（位于时间之后）。 */
function ensureRefreshButton(actions, target, run) {
	const existing = actions.querySelector("[data-dsh-refresh=\"true\"]");
	if (existing) {
		placeRefreshButton(actions, existing);
		return;
	}
	const button = document.createElement("button");
	button.type = "button";
	button.dataset.dshRefresh = "true";
	button.dataset.dshRefreshKey = target.key;
	button.setAttribute("aria-label", `刷新第 ${target.turn} 条提示词`);
	button.title = `重新回答第 ${target.turn} 条提示词`;
	button.style.cssText = [
		"background:transparent",
		"border:none",
		"border-radius:28px",
		"cursor:pointer",
		"padding:6px",
		"display:inline-flex",
		"justify-content:center",
		"align-items:center",
		"color:var(--dsw-alias-label-tertiary)",
		"width:28px",
		"height:28px"
	].join(";");
	button.addEventListener("mouseenter", () => {
		button.style.background = "var(--dsw-alias-interactive-bg-hover)";
		button.style.color = "var(--dsw-alias-label-secondary)";
	});
	button.addEventListener("mouseleave", () => {
		button.style.background = "transparent";
		button.style.color = "var(--dsw-alias-label-tertiary)";
	});
	button.appendChild(refreshIcon());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		run(target, button);
	});
	placeRefreshButton(actions, button);
}
const CHECKPOINT_PILL = "[data-dsh-checkpoint-pill=\"true\"]";
/** actions 容器必须真实持有按钮；空装饰壳（可能匹配 actions 前缀类名）不能当宿主。 */
/**
* 行 → chat 节点：按 0.2.1 的行身份解析——`data-chat-anchor-key`（FLOW key，
* step 部件是复合 `["<nodeKey>","<part>"]`）优先，`data-chat-node-key`（纯
* 节点 key）兜底，旧版 `data-chat-flow-key` 再兜底。对齐 dsh-rewind 的
* resolveSeatAnchorSeq 与官方 viewport 自己的身份读取。
*/
function resolveSeatNode(row, nodesByKey) {
	const anchorKey = row.dataset.chatAnchorKey;
	const nodeKey = row.dataset.chatNodeKey;
	const legacyKey = row.getAttribute("data-chat-flow-key");
	return (anchorKey !== void 0 && anchorKey !== "" ? nodesByKey.get(anchorKey) : void 0) ?? (nodeKey !== void 0 && nodeKey !== "" ? nodesByKey.get(nodeKey) : void 0) ?? (legacyKey !== null && legacyKey !== "" ? nodesByKey.get(legacyKey) : void 0);
}
/**
* 定位用户行的 actions 容器（复制/分支按钮所在的 IconActions 行）。
* 结构性定位：actions 行总是排在行内最后（图片缩略图也是 button 且在前
* 面），取「最后一个非本插件按钮」的父元素；失败回落 class 扫描
* （老版 DOM）。对齐 dsh-rewind 的 actionsContainerOf。
*/
function actionsContainerOf(row) {
	const own = (button) => button.dataset.dshCheckpointButton === "true" || button.dataset.dshCheckpointActionButton === "true" || button.dataset.dshRefresh === "true" || button.closest(CHECKPOINT_PILL) !== null;
	const structural = Array.from(row.querySelectorAll("button")).filter((button) => !own(button)).at(-1)?.parentElement;
	if (structural instanceof HTMLElement && structural.querySelector("button") !== null) return structural;
	return findActionsRow(row);
}
function findActionsRow(row) {
	const candidates = Array.from(row.querySelectorAll("[class*=\"_actions\"], [class*=\"actions\"]"));
	return candidates.find((element) => element.querySelector("button") !== null) ?? candidates[0];
}
function ensureRewindStyle() {
	const style = document.querySelector("style[data-dsh-checkpoint-style]") ?? document.createElement("style");
	style.dataset.dshCheckpointStyle = "true";
	style.textContent = [
		REWIND_STYLE,
		`${CHECKPOINT_PILL}{display:contents!important;opacity:1!important;visibility:visible!important;pointer-events:auto!important}`,
		`${CHECKPOINT_PILL}>button{flex:none!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;cursor:pointer!important}`,
		`.dsh-regen-placeholder{display:inline-flex!important;align-items:center!important;gap:6px!important;margin-top:8px!important;padding:4px 10px!important;border-radius:12px!important;font-size:12px!important;line-height:18px!important;color:var(--dsw-alias-label-secondary,#666)!important;background:var(--dsw-alias-interactive-bg-default,rgba(127,127,127,0.12))!important}`,
		`.dsh-regen-placeholder::before{content:""!important;width:6px!important;height:6px!important;border-radius:50%!important;background:currentColor!important;animation:dsh-regen-pulse 1.1s ease-in-out infinite!important}`,
		`@keyframes dsh-regen-pulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}`
	].join("\n");
	if (!style.parentElement) document.head.appendChild(style);
}
function currentSessionSnapshot(sessions, getUiConversation) {
	const sessionId = currentSessionId(sessions);
	if (!sessionId) return void 0;
	let chat;
	try {
		const binding = getUiConversation()?.binding(sessionId);
		chat = binding?.target?.("chat")?.getSnapshot() ?? binding?.snapshot?.getSnapshot()?.views?.get("chat") ?? void 0;
	} catch {
		chat = void 0;
	}
	return {
		sessionId,
		chat
	};
}
function removeAllCheckpointPills() {
	for (const element of Array.from(document.querySelectorAll(CHECKPOINT_PILL))) element.remove();
}
/** ✎ 编辑图标（与 ↶ 同一套视觉参数）。 */
function editIcon() {
	const template = document.createElement("template");
	template.innerHTML = EDIT_ICON_SVG.trim();
	const icon = template.content.firstElementChild;
	if (icon === null) throw new Error("edit icon svg is empty");
	return icon;
}
/** dsh-rewind 的 ↶ 图标（内联 SVG，描边 1.25 与相邻操作按钮对齐）。 */
function rewindIcon() {
	const template = document.createElement("template");
	template.innerHTML = REWIND_ICON_SVG.trim();
	const icon = template.content.firstElementChild;
	if (icon === null) throw new Error("rewind icon svg is empty");
	return icon;
}
/**
* 绑定按钮的回退动作：pointerdown 捕获点击意图（避免宿主在 click 前重绘
* 吞掉事件），并顺带预取 preview——按下到弹起的窗口足够覆盖探测往返，
* 浮层打开时直接以落定态渲染。
*/
function attachCheckpointAction(button, onOpen, onPrewarm) {
	const prewarm = (event) => {
		event.preventDefault();
		event.stopPropagation();
		try {
			onPrewarm?.();
		} catch {}
	};
	const activate = (event) => {
		event.preventDefault();
		event.stopPropagation();
		onOpen();
	};
	button.addEventListener("pointerdown", prewarm, true);
	button.addEventListener("click", activate, true);
}
function createRewindPill(cp, key, onOpen, onPrewarm, onEdit) {
	const pill = document.createElement("div");
	pill.dataset.dshCheckpointPill = "true";
	pill.dataset.dshCheckpointKey = key;
	const button = document.createElement("button");
	button.type = "button";
	button.setAttribute("aria-label", "回退到这条消息");
	button.title = cp.preview ? `回退到这条消息：${cp.preview}` : "回退到这条消息";
	button.dataset.dshCheckpointButton = "true";
	button.replaceChildren(rewindIcon());
	attachCheckpointAction(button, onOpen, onPrewarm);
	pill.appendChild(button);
	if (onEdit !== void 0) {
		const editButton = document.createElement("button");
		editButton.type = "button";
		editButton.dataset.dshEditButton = "true";
		editButton.setAttribute("aria-label", "编辑这条消息");
		editButton.title = "编辑这条消息并重发（撤回它及其后的对话）";
		editButton.style.cssText = [
			"background:transparent",
			"border:none",
			"border-radius:28px",
			"cursor:pointer",
			"padding:6px",
			"display:inline-flex",
			"justify-content:center",
			"align-items:center",
			"color:var(--dsw-alias-label-tertiary)",
			"width:28px",
			"height:28px"
		].join(";");
		editButton.addEventListener("mouseenter", () => {
			editButton.style.background = "var(--dsw-alias-interactive-bg-hover)";
			editButton.style.color = "var(--dsw-alias-label-secondary)";
		});
		editButton.addEventListener("mouseleave", () => {
			editButton.style.background = "transparent";
			editButton.style.color = "var(--dsw-alias-label-tertiary)";
		});
		editButton.replaceChildren(editIcon());
		attachCheckpointAction(editButton, onEdit);
		pill.appendChild(editButton);
	}
	return pill;
}
function adoptCopyButtonStyle(pill, actions, cp, onOpen, onPrewarm) {
	const current = pill.querySelector("button");
	if (!current || current.dataset.dshCopyStyle === "true") return;
	const template = Array.from(actions.querySelectorAll("button")).find((button) => {
		const label = button.getAttribute("aria-label")?.toLowerCase() ?? "";
		return label === "复制" || label === "copy";
	});
	if (!template) return;
	const replacement = template.cloneNode(true);
	replacement.dataset.dshCopyStyle = "true";
	replacement.dataset.dshCheckpointActionButton = "true";
	replacement.setAttribute("aria-label", "回退到这条消息");
	replacement.title = cp.preview ? `回退到这条消息：${cp.preview}` : "回退到这条消息";
	replacement.replaceChildren(rewindIcon());
	current.replaceWith(replacement);
	attachCheckpointAction(replacement, onOpen, onPrewarm);
}
/** 就地重发钩子：installRewindEntries 装配时写入,卸载时清除;RetryButton 经它复用同一管线。 */
let regenerateHook;
/**
* 回退入口安装（常驻在每条用户消息 actions 行，DOM 注入）：
* - ↶ 按钮 + 模式浮层（chat / both+影响清单）
* - 被撤回行的隐藏（data-dsh-rewind-hidden，观测性标记）
* - 回退成功后把目标消息文本回填 composer
* 保留本仓原有的 MutationObserver + actions 行适配骨架（不引 React portal）。
*/
function installRewindEntries(sessions, getUiConversation, getConversation, getConnection) {
	if (typeof document === "undefined") return () => void 0;
	ensureRewindStyle();
	registerPreviewCall((sessionId, seq) => previewOverRpc(getConnection(), sessionId, seq));
	let disposed = false;
	let syncing = false;
	let lastDebugSignature = "";
	const debugEnabled = () => {
		try {
			return window.localStorage.getItem("dshSessionManagerDebug") === "1";
		} catch {
			return false;
		}
	};
	let latestRefreshTargets = /* @__PURE__ */ new Map();
	/** 用户消息「刷新」：共用重新生成核心；成功即替换原回答（原会话归档）。 */
	const runRefresh = (target, button) => {
		const sessionId = currentSessionId(sessions);
		if (!sessionId) return;
		const current = latestRefreshTargets.get(target.key) ?? target;
		button.disabled = true;
		button.style.opacity = "0.5";
		const restore = showRegeneratingPlaceholder(current.assistantKeys, current.turn);
		regenerateInPlace(sessionId, current.seq).catch((error) => {
			button.title = `刷新失败：${toErrorMessage(error)}`;
		}).finally(() => {
			restore();
			button.disabled = false;
			button.style.opacity = "";
		});
	};
	/** 某会话的 chat 视图快照（读取失败降级 undefined）。 */
	const chatViewOf = (sessionId) => {
		try {
			const binding = getUiConversation()?.binding(sessionId);
			return binding?.target?.("chat")?.getSnapshot() ?? binding?.snapshot?.getSnapshot()?.views?.get("chat") ?? void 0;
		} catch {
			return;
		}
	};
	/** hidden 模块的 chat 读取器（order + get(key)）。 */
	const chatOf = (session) => hiddenChatOf(session === void 0 ? void 0 : chatViewOf(session.sessionId));
	/** chat 快照更新信号：等待命令结局时被唤醒。 */
	const watchChat = (sessionId, cb) => {
		try {
			return getUiConversation()?.binding(sessionId)?.target?.("chat")?.subscribe?.(cb) ?? (() => {});
		} catch {
			return () => {};
		}
	};
	/** composer 的 DOM 兜底：直接写 contenteditable（Lexical 经 input 事件接管）。 */
	const fillComposerEditable = (text) => {
		const editable = document.querySelector("[data-composer-input]");
		if (editable === null) return false;
		editable.focus();
		const selection = document.getSelection();
		if (selection !== null) {
			const range = document.createRange();
			range.selectNodeContents(editable);
			selection.removeAllRanges();
			selection.addRange(range);
		}
		let ok = false;
		try {
			ok = document.execCommand("insertText", false, text);
		} catch {
			ok = false;
		}
		if (ok) return true;
		editable.textContent = text;
		editable.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	};
	/**
	* composer 写入：优先宿主 conversation.input 的 setDraft（整稿替换），
	* 失败降级 DOM contenteditable。绝不抛错。
	*/
	const writeComposer = (sessionId, text) => {
		try {
			const conversation = getConversation();
			const scope = sessions.scope?.(sessionId);
			const facade = conversation?.input !== void 0 && scope !== void 0 ? conversation.input.for(scope) : void 0;
			if (facade !== void 0) try {
				facade.setDraft(text);
				try {
					facade.focus?.();
				} catch {}
				return true;
			} catch {}
		} catch {}
		return fillComposerEditable(text);
	};
	/** 用 Enter 提交 composer（就地重发的最后一步）。 */
	const submitComposer = () => {
		const editable = document.querySelector("[data-composer-input]");
		if (editable === null) return false;
		editable.focus();
		editable.dispatchEvent(new KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true
		}));
		return true;
	};
	let editingRow = null;
	/** 关闭编辑器并还原消息原样(取消/成功后/开新编辑器时调用)。 */
	const closeEditor = () => {
		if (editingRow === null) return;
		editingRow.removeAttribute("data-dsh-editing");
		editingRow.querySelector("[data-dsh-edit-editor]")?.remove();
		editingRow = null;
	};
	/** 在目标用户行打开行内编辑器(同一时刻仅一个)。 */
	const openEditor = (row, cp) => {
		closePopover();
		closeEditor();
		const sessionId = currentSessionId(sessions);
		if (sessionId === void 0) return;
		const original = messageTextAt(chatOf({ sessionId }), cp.seq) ?? cp.preview;
		row.dataset.dshEditing = "true";
		editingRow = row;
		const editor = document.createElement("div");
		editor.dataset.dshEditEditor = "true";
		editor.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:8px",
			"width:100%",
			"padding:10px",
			"border:1px solid var(--dsw-alias-border-l2,#e4e7ec)",
			"border-radius:12px",
			"background:var(--dsw-alias-bg-primary,#fff)"
		].join(";");
		const textarea = document.createElement("textarea");
		textarea.value = original;
		textarea.setAttribute("aria-label", "编辑用户提示词");
		const MAX_EDITOR_HEIGHT = 320;
		textarea.style.cssText = [
			"box-sizing:border-box",
			"width:100%",
			"min-height:64px",
			`max-height:${MAX_EDITOR_HEIGHT}px`,
			"resize:none",
			"border:none",
			"outline:none",
			"overflow-y:auto",
			"background:transparent",
			"color:var(--dsw-alias-label-primary,#101828)",
			"font-family:inherit",
			"font-size:calc(14px + var(--dsh-content-font-delta, 0px))",
			"line-height:20px",
			"white-space:pre-wrap"
		].join(";");
		const autoSize = () => {
			textarea.style.height = "auto";
			textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_EDITOR_HEIGHT)}px`;
		};
		textarea.addEventListener("input", autoSize);
		const actions = document.createElement("div");
		actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px".split(";").join(";");
		const hint = document.createElement("span");
		hint.style.cssText = "font-size:12px;color:var(--dsw-alias-label-tertiary,#667085);align-self:center;margin-right:auto";
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.textContent = "取消";
		cancel.style.cssText = [
			"padding:5px 12px",
			"border:none",
			"border-radius:8px",
			"cursor:pointer",
			"background:transparent",
			"color:var(--dsw-alias-label-secondary,#475467)",
			"font-size:13px"
		].join(";");
		cancel.addEventListener("click", closeEditor);
		const confirm = document.createElement("button");
		confirm.type = "button";
		confirm.textContent = "确定";
		confirm.style.cssText = [
			"padding:5px 12px",
			"border:none",
			"border-radius:8px",
			"cursor:pointer",
			"background:var(--dsw-alias-button-primary-fill,#13715b)",
			"color:var(--dsw-alias-label-primary-foreground,#fff)",
			"font-size:13px"
		].join(";");
		const runConfirm = () => {
			const text = textarea.value;
			if (text.trim() === "") {
				closeEditor();
				return;
			}
			confirm.disabled = true;
			confirm.textContent = "正在回退…";
			hint.textContent = "";
			(async () => {
				if (await rewindAndRefillSession(sessionId, cp.seq, "chat", void 0, text)) {
					closeEditor();
					submitComposer();
				} else {
					confirm.disabled = false;
					confirm.textContent = "确定";
					hint.textContent = "回退失败，请重试";
				}
			})().catch(() => {
				confirm.disabled = false;
				confirm.textContent = "确定";
				hint.textContent = "回退失败，请重试";
			});
		};
		confirm.addEventListener("click", runConfirm);
		textarea.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closeEditor();
				return;
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				event.stopPropagation();
				runConfirm();
			}
		});
		actions.append(hint, cancel, confirm);
		editor.append(textarea, actions);
		row.prepend(editor);
		autoSize();
		textarea.focus();
		editor.scrollIntoView({ block: "nearest" });
	};
	registerComposerFocuser((sessionId) => {
		try {
			const conversation = getConversation();
			const scope = sessions.scope?.(sessionId);
			(conversation?.input !== void 0 && scope !== void 0 ? conversation.input.for(scope) : void 0)?.focus?.();
		} catch {}
		document.querySelector("[data-composer-input]")?.focus();
	});
	/**
	* 执行回退并回填：引擎通道发命令 → 等 marker-carrying 成功结局 → 把目标
	* 消息文本回填 composer。浮层已自行关闭；这里的失败只进控制台。
	*/
	/**
	* 就地回退并回填（浮层确认后的执行体）：引擎命令 → 等 marker 结局 → 把
	* 目标消息文本回填 composer。返回是否成功回填。
	*/
	const rewindAndRefillSession = async (sessionId, seq, mode, planId, textOverride) => {
		const binding = sessions.binding(sessionId);
		if (binding === void 0) return false;
		const engineFace = {
			sessionId,
			command: (line) => binding.session.command(line)
		};
		const known = knownCommandSeqs(engineFace, chatOf, (node) => isExecutedRewindCommand(node, seq));
		let result;
		try {
			const line = mode === "both" && planId !== void 0 ? `/${ENGINE_COMMAND} @${seq} both ${planId}` : `/${ENGINE_COMMAND} @${seq} ${mode}`;
			result = await binding.session.command(line);
		} catch (error) {
			console.warn("[dsh-session-manager] 回退命令抛错，跳过回填", error);
			return false;
		}
		if (!result.ok) {
			console.warn("[dsh-session-manager] 回退命令被拒绝", result.error);
			return false;
		}
		if (result.value?.matched !== true) {
			console.warn("[dsh-session-manager] 回退命令未匹配（宿主可能未注册）");
			return false;
		}
		let outcome;
		try {
			outcome = await waitForCommand(engineFace, chatOf, (node) => isExecutedRewindCommand(node, seq) && !known.has(node.seq), 2e4, (cb) => watchChat(sessionId, cb));
		} catch (error) {
			console.warn("[dsh-session-manager] 等待回退结局抛错", error);
			return false;
		}
		if (outcome === null) {
			console.warn("[dsh-session-manager] 回退在超时内未落定，跳过回填");
			return false;
		}
		if (outcome.kind !== "success") {
			console.warn("[dsh-session-manager] 回退被拒绝：", outcome.text);
			throw new Error(outcome.text ?? "回退被拒绝");
		}
		if (currentSessionId(sessions) !== sessionId) return false;
		const text = textOverride ?? messageTextAt(chatOf({ sessionId }), seq);
		if (text === void 0) return false;
		return writeComposer(sessionId, text);
	};
	const runRewindAndFill = async (sessionId, seq, mode, planId) => {
		try {
			await rewindAndRefillSession(sessionId, seq, mode, planId);
		} catch {}
	};
	/**
	* 就地重发（刷新/重新生成的新实现）：回退到目标消息 → 文本回填 →
	* 自动 Enter 重发。不再 fork：会话 id 不变、无切换/归档/模型同步。
	*/
	const regenerateInPlace = async (sessionId, seq) => {
		if (await rewindAndRefillSession(sessionId, seq, "chat")) submitComposer();
	};
	regenerateHook = regenerateInPlace;
	/** pointerdown 预取（RPC）：浮层打开时直接以落定态渲染，消除「检查中」闪烁。 */
	const prewarmRewind = (seq) => {
		const sessionId = currentSessionId(sessions);
		if (sessionId === void 0) return;
		prewarmPreview(sessionId, seq);
	};
	/** 点击按钮：打开模式浮层（影响清单经 RPC，执行经引擎命令通道）。 */
	const openRewindPopover = (cp, anchor) => {
		const sessionId = currentSessionId(sessions);
		if (sessionId === void 0) return;
		openPopover({
			sessionId,
			seq: cp.seq,
			preview: cp.preview,
			anchor,
			onRewind: (mode, planId) => {
				runRewindAndFill(sessionId, cp.seq, mode, planId);
			}
		});
	};
	const sync = () => {
		if (disposed || syncing) return;
		syncing = true;
		try {
			const current = currentSessionSnapshot(sessions, getUiConversation);
			const chat = current?.chat;
			const nodesByKey = nodeKeyIndex(chat);
			const candidates = computeRewindCandidates(chat);
			const byKey = new Map(candidates.map((cp) => [cp.key, cp]));
			const refreshTargets = computeUserRefreshTargets(chat);
			latestRefreshTargets = refreshTargets;
			const hiddenChat = hiddenChatOf(chat);
			const hiddenSeqs = hiddenChat === void 0 ? void 0 : hiddenSeqsOf(hiddenChat);
			if (hiddenSeqs !== void 0) {
				const setHidden = (row, hide) => {
					if (hide && row.dataset.dshRewindHidden !== "true") {
						row.style.display = "none";
						row.dataset.dshRewindHidden = "true";
					} else if (!hide && row.dataset.dshRewindHidden === "true") {
						row.style.display = "";
						delete row.dataset.dshRewindHidden;
					}
				};
				for (const row of Array.from(document.querySelectorAll("[data-chat-anchor-key], [data-chat-node-key], [data-chat-flow-key]"))) {
					const node = resolveSeatNode(row, nodesByKey);
					const anchorSeq = typeof node?.anchorSeq === "number" ? node.anchorSeq : typeof node?.data?.seq === "number" ? node.data.seq : void 0;
					setHidden(row, typeof anchorSeq === "number" && hiddenSeqs.has(anchorSeq));
				}
				for (const shell of Array.from(document.querySelectorAll("[data-chat-anchor-key^=\"group:\"]"))) {
					const members = Array.from(shell.querySelectorAll("[data-chat-anchor-key], [data-chat-node-key], [data-chat-flow-key]"));
					if (members.length === 0) continue;
					setHidden(shell, members.every((member) => member.dataset.dshRewindHidden === "true"));
				}
			}
			const pillByKey = /* @__PURE__ */ new Map();
			for (const element of Array.from(document.querySelectorAll(CHECKPOINT_PILL))) {
				const pill = element;
				const key = pill.dataset.dshCheckpointKey;
				if (key && !pillByKey.has(key)) pillByKey.set(key, pill);
				else pill.remove();
			}
			const seen = /* @__PURE__ */ new Set();
			const seenRefresh = /* @__PURE__ */ new Set();
			const rows = Array.from(document.querySelectorAll("[data-chat-flow-kind=\"user\"], [data-chat-flow-kind=\"steering\"]"));
			let rowsWithActions = 0;
			let copyTemplates = 0;
			for (const row of rows) {
				const node = resolveSeatNode(row, nodesByKey);
				const key = typeof node?.key === "string" ? node.key : "";
				const cp = key === "" ? void 0 : byKey.get(key);
				let pill = key === "" ? void 0 : pillByKey.get(key);
				if (!cp || row.dataset.dshRewindHidden === "true") {
					pill?.remove();
					if (cp === void 0) continue;
					actionsContainerOf(row)?.querySelector("[data-dsh-refresh=\"true\"]")?.remove();
					continue;
				}
				seen.add(key);
				if (pill === void 0) {
					pill = createRewindPill(cp, key, () => {
						const button$1 = pill.querySelector("button");
						if (button$1 !== null) openRewindPopover(cp, button$1);
					}, () => prewarmRewind(cp.seq), () => {
						openEditor(row, cp);
					});
					pillByKey.set(key, pill);
				}
				const actions = actionsContainerOf(row);
				if (actions) {
					if (!actions.contains(pill)) actions.appendChild(pill);
					adoptCopyButtonStyle(pill, actions, cp, () => {
						const liveButton = pill.querySelector("button");
						if (liveButton !== null) openRewindPopover(cp, liveButton);
					}, () => prewarmRewind(cp.seq));
					rowsWithActions += 1;
					if (actions.querySelector("button[aria-label=\"复制\"], button[aria-label=\"copy\"]")) copyTemplates += 1;
				} else if (row.nextElementSibling !== pill) row.insertAdjacentElement("afterend", pill);
				const refreshTarget = key === "" ? void 0 : refreshTargets.get(key);
				if (actions) {
					const refreshButton = actions.querySelector("[data-dsh-refresh=\"true\"]");
					if (refreshTarget && !refreshTarget.generating) {
						seenRefresh.add(key);
						ensureRefreshButton(actions, refreshTarget, runRefresh);
					} else refreshButton?.remove();
				}
				const button = pill.querySelector("button");
				if (button) {
					if (button.querySelector("svg") === null) button.replaceChildren(rewindIcon());
					button.title = cp.preview ? `回退到这条消息：${cp.preview}` : "回退到这条消息";
				}
				const editButton = pill.querySelector("[data-dsh-edit-button=\"true\"]");
				if (editButton !== null) {
					if (editButton.querySelector("svg") === null) editButton.replaceChildren(editIcon());
					editButton.title = cp.preview ? `编辑这条消息并重发：${cp.preview}` : "编辑这条消息并重发";
				}
			}
			for (const pill of pillByKey.values()) if (!seen.has(pill.dataset.dshCheckpointKey ?? "")) pill.remove();
			for (const element of Array.from(document.querySelectorAll("[data-dsh-refresh=\"true\"]"))) if (!seenRefresh.has(element.dataset.dshRefreshKey ?? "")) element.remove();
			if (debugEnabled()) {
				const signature = JSON.stringify({
					sessionId: current?.sessionId,
					hasChat: Boolean(chat),
					hasOrder: Array.isArray(chat?.order),
					rows: rows.length,
					resolved: rows.filter((row) => resolveSeatNode(row, nodesByKey) !== void 0).length,
					candidates: candidates.length,
					hidden: hiddenSeqs?.size ?? 0,
					rowsWithActions,
					copyTemplates,
					pills: document.querySelectorAll(CHECKPOINT_PILL).length
				});
				if (signature !== lastDebugSignature) {
					lastDebugSignature = signature;
					console.debug("[dsh-session-manager] rewind sync:", signature);
				}
			}
		} finally {
			syncing = false;
		}
	};
	const IGNORED_SCOPE = [
		"[data-composer-seat]",
		"[data-composer-input]",
		"[data-sidebar-right-panel]",
		"[data-sidebar-chat]",
		"[data-plugin-panel]"
	].join(", ");
	let scheduled = false;
	const schedule = () => {
		if (disposed || syncing || scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			if (!disposed) sync();
		});
	};
	const onMutations = (mutations) => {
		if (mutations.length > 0) {
			let ignored = 0;
			for (const mutation of mutations) {
				const target = mutation.target;
				if (target instanceof Element && target.closest(IGNORED_SCOPE) !== null) ignored += 1;
			}
			if (ignored === mutations.length) return;
		}
		schedule();
	};
	const unsubscribe = sessions.list.subscribe?.(schedule);
	const observer = new MutationObserver(onMutations);
	observer.observe(document.body, {
		childList: true,
		subtree: true
	});
	schedule();
	return () => {
		disposed = true;
		observer.disconnect();
		unsubscribe?.();
		closePopover();
		closeEditor();
		registerPreviewCall(null);
		removeAllCheckpointPills();
		document.querySelectorAll("[data-dsh-refresh=\"true\"]").forEach((element) => element.remove());
	};
}
function installSessionMenuDelete(workspaces, sessions, isEnabled = () => true) {
	if (typeof document === "undefined") return () => void 0;
	let selectedSessionId;
	let disposed = false;
	const inferSessionIdFromFiber = (element) => {
		let current = element;
		while (current) {
			const fiberKey = Object.keys(current).find((key) => key.startsWith("__reactFiber$"));
			let fiber = fiberKey ? current[fiberKey] : void 0;
			let depth = 0;
			while (fiber && depth++ < 24) {
				const props = fiber.memoizedProps;
				const candidate = (props?.node)?.id ?? props?.sessionId ?? props?.id;
				if (typeof candidate === "string" && sessions.list.getSnapshot().byId[candidate]) return candidate;
				fiber = fiber.return;
			}
			current = current.parentElement;
		}
	};
	const inferSessionIdFromRow = (row) => {
		const fromFiber = inferSessionIdFromFiber(row);
		if (fromFiber) return fromFiber;
		const text = row?.textContent?.trim() ?? "";
		const state = sessions.list.getSnapshot();
		const matches = state.ids.filter((id) => {
			const item = state.byId[id];
			const title = item?.displayTitle ?? item?.title ?? "";
			return Boolean(title) && text.includes(title);
		});
		return matches.length === 1 ? matches[0] : void 0;
	};
	const onDocumentPointerDown = (event) => {
		const button = (event.target instanceof Element ? event.target : null)?.closest("button");
		const row = button?.closest("[role=\"treeitem\"]") ?? button?.closest("[data-session-id]");
		if (!button || !row) return;
		selectedSessionId = row.getAttribute("data-session-id") ?? inferSessionIdFromRow(row);
		queueMicrotask(syncDeleteMenuItem);
	};
	const syncDeleteMenuItem = () => {
		if (disposed || !selectedSessionId) return;
		if (!isEnabled()) {
			document.querySelectorAll("[data-dsh-session-delete=\"true\"]").forEach((element) => element.remove());
			return;
		}
		const archiveItem = Array.from(document.querySelectorAll("[role=\"menuitem\"], [role=\"menu\"] button")).find((item) => {
			const text = item.textContent?.trim().toLocaleLowerCase() ?? "";
			return text.includes("归档会话") || text.includes("archive session");
		});
		const menu = archiveItem?.closest("[role=\"menu\"]") ?? null;
		if (!archiveItem || !menu) return;
		const viewport = archiveItem.closest("[role=\"presentation\"]");
		const list = viewport !== null && menu.contains(viewport) ? viewport : menu;
		const existing = Array.from(list.children).find((child) => child instanceof HTMLElement && child.getAttribute("data-dsh-session-delete") === "true");
		if (existing) {
			if (list.lastElementChild !== existing) list.append(existing);
			return;
		}
		document.querySelectorAll("[data-dsh-session-delete=\"true\"]").forEach((element) => element.remove());
		const archiveWrapper = archiveItem.parentElement;
		const deleteNode = (archiveWrapper !== null && archiveWrapper.querySelectorAll("[role=\"menuitem\"]").length === 1 ? archiveWrapper : archiveItem).cloneNode(true);
		const deleteItem = deleteNode.getAttribute("role") === "menuitem" ? deleteNode : deleteNode.querySelector("[role=\"menuitem\"]");
		if (!deleteItem) return;
		deleteNode.setAttribute("data-dsh-session-delete", "true");
		deleteItem.setAttribute("aria-label", "删除会话");
		deleteItem.removeAttribute("aria-current");
		deleteItem.removeAttribute("aria-keyshortcuts");
		for (const key of deleteItem.querySelectorAll("kbd")) key.closest("span[aria-hidden=\"true\"]")?.remove();
		replaceMenuLabel(deleteItem, "删除会话");
		replaceMenuIcon(deleteItem);
		deleteItem.style.color = "var(--dsw-alias-state-error-primary, #d92d20)";
		deleteItem.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();
			const sessionId = selectedSessionId;
			if (!sessionId) return;
			if (!window.confirm("确定删除这个会话吗？")) return;
			try {
				await workspaces.archiveSession(sessionId);
			} catch (error) {
				window.alert(`删除会话失败：${toErrorMessage(error)}`);
			}
		}, true);
		list.append(deleteNode);
	};
	document.addEventListener("pointerdown", onDocumentPointerDown, true);
	const observer = new MutationObserver(syncDeleteMenuItem);
	observer.observe(document.body, {
		childList: true,
		subtree: true
	});
	return () => {
		disposed = true;
		observer.disconnect();
		document.removeEventListener("pointerdown", onDocumentPointerDown, true);
		document.querySelectorAll("[data-dsh-session-delete=\"true\"]").forEach((element) => element.remove());
	};
}
function replaceMenuLabel(item, label) {
	const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
	let node;
	while (node = walker.nextNode()) {
		if (node.parentElement?.closest("svg")) continue;
		if (node.nodeValue?.trim()) {
			node.nodeValue = label;
			return;
		}
	}
	item.append(document.createTextNode(label));
}
function replaceMenuIcon(item) {
	const source = item.querySelector("svg");
	if (!source) return;
	const icon = source.cloneNode(false);
	icon.setAttribute("viewBox", "0 0 24 24");
	icon.setAttribute("fill", "none");
	icon.setAttribute("stroke", "currentColor");
	icon.setAttribute("stroke-width", "1.8");
	icon.setAttribute("stroke-linecap", "round");
	icon.setAttribute("stroke-linejoin", "round");
	icon.replaceChildren(createSvgElement("path", { d: "M4 6h16" }), createSvgElement("path", { d: "M10 6V4h4v2" }), createSvgElement("path", { d: "M6 8v12h12V8" }), createSvgElement("path", { d: "M10 11v6M14 11v6" }));
	source.replaceWith(icon);
}
function createSvgElement(name$1, attributes) {
	const element = document.createElementNS("http://www.w3.org/2000/svg", name$1);
	for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
	return element;
}
/** 重新生成的模块级幂等锁：跨组件实例/重挂载生效。key = `${sessionId}:${sourceKey}`。 */
const subscribeNoop = () => () => void 0;
/** 0.1.2 会话快照没有消息节点；上下文从 chat 视图读取。
*  chat.legacy.turnEnds 与 legacy turn 语义一致（completedTurn → end.seq）。 */
function computeRetryContext(chat, messageId) {
	if (!chat?.nodes) return void 0;
	const ordering = chat.order ?? [];
	const orderIndex = /* @__PURE__ */ new Map();
	ordering.forEach((key, index) => orderIndex.set(key, index));
	const sorted = [...chat.nodes.values()].sort((a, b) => (orderIndex.get(a.key ?? "") ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.key ?? "") ?? Number.MAX_SAFE_INTEGER));
	const assistantIndex = sorted.findIndex((node) => isAssistantNode(node) && assistantMessageId(node) === messageId);
	if (assistantIndex < 0) return void 0;
	const assistant = sorted[assistantIndex];
	if (!assistant) return void 0;
	const turn = assistant.location?.turn?.turn;
	const before = sorted.slice(0, assistantIndex);
	let user = before.find((node) => node.kind === "user" && node.location?.turn?.turn === turn);
	if (!user) user = [...before].reverse().find((node) => node.kind === "user");
	const content = user?.data?.content;
	if (!Array.isArray(content) || content.length === 0) return void 0;
	let previousTurnEnd;
	const turnEnds = chat.legacy?.turnEnds;
	if (typeof turn === "number" && turnEnds) {
		for (const [completedTurn, endSeq] of turnEnds) if (completedTurn < turn && (previousTurnEnd === void 0 || endSeq > previousTurnEnd)) previousTurnEnd = endSeq;
	}
	const assistantStatus = assistant.data?.status;
	const userSeq = typeof user?.anchorSeq === "number" ? user.anchorSeq : user?.data?.seq;
	return {
		content: [...content],
		userSeq,
		previousTurnEnd,
		turn: typeof turn === "number" ? turn : void 0,
		assistantStatus: typeof assistantStatus === "string" ? assistantStatus : void 0,
		assistantKey: assistant.key
	};
}
function RetryButton({ sessionId, messageId, sessions, getUiConversation }) {
	const [busy, setBusy] = react.default.useState(false);
	const [error, setError] = react.default.useState(null);
	const controllerRef = react.default.useRef(null);
	const chatSource = react.default.useMemo(() => {
		if (!sessionId) return void 0;
		try {
			return getUiConversation()?.binding(sessionId)?.target("chat") ?? void 0;
		} catch {
			return;
		}
	}, [getUiConversation, sessionId]);
	const chat = react.default.useSyncExternalStore(chatSource?.subscribe ?? subscribeNoop, () => chatSource?.getSnapshot());
	const retryContext = react.default.useMemo(() => computeRetryContext(chat, messageId), [chat, messageId]);
	react.default.useEffect(() => () => {
		controllerRef.current?.abort(/* @__PURE__ */ new Error("组件已卸载"));
	}, []);
	if (!retryContext) return null;
	const handle = async () => {
		if (busy || !sessionId) return;
		controllerRef.current = new AbortController();
		setBusy(true);
		setError(null);
		const restore = showRegeneratingPlaceholder(retryContext.assistantKey ? [retryContext.assistantKey] : [], retryContext.turn);
		if (retryContext.userSeq === void 0) {
			setError("定位不到所属用户消息");
			return;
		}
		try {
			await (regenerateHook?.(sessionId, retryContext.userSeq) ?? Promise.reject(/* @__PURE__ */ new Error("回退管线未就绪")));
		} catch (cause) {
			setError(toErrorMessage(cause));
		} finally {
			restore();
			setBusy(false);
			controllerRef.current = null;
		}
	};
	const generating = retryContext.assistantStatus === "running";
	const errorColor = "var(--dsw-alias-state-error-primary, #d92d20)";
	const onMouseEnter = (event) => {
		event.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover)";
		event.currentTarget.style.color = error ? errorColor : "var(--dsw-alias-label-secondary)";
	};
	const onMouseLeave = (event) => {
		event.currentTarget.style.background = "transparent";
		event.currentTarget.style.color = error ? errorColor : "var(--dsw-alias-label-tertiary)";
	};
	const title = error ? `重新生成失败：${error}` : "重新生成此回复";
	return react.default.createElement("button", {
		type: "button",
		"aria-label": title,
		title,
		disabled: busy || generating,
		onClick: handle,
		style: {
			width: 28,
			height: 28,
			display: "inline-flex",
			justifyContent: "center",
			alignItems: "center",
			cursor: busy || generating ? "default" : "pointer",
			background: "transparent",
			border: "none",
			borderRadius: 28,
			color: error ? errorColor : "var(--dsw-alias-label-tertiary)",
			padding: 0,
			opacity: busy ? .5 : void 0
		},
		onMouseEnter,
		onMouseLeave
	}, react.default.createElement("svg", {
		width: 16,
		height: 16,
		viewBox: "0 0 16 16",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.5,
		strokeLinecap: "round",
		strokeLinejoin: "round"
	}, react.default.createElement("path", { d: "M13.5 8a5.5 5.5 0 0 1-9.5 3.5" }), react.default.createElement("path", { d: "M2.5 8a5.5 5.5 0 0 1 9.5-3.5" }), react.default.createElement("polyline", { points: "6,4 2,4 2,8" }), react.default.createElement("polyline", { points: "10,12 14,12 14,8" })));
}
/** assistant 节点的 messageId：优先 finalNode。 */
function assistantMessageId(node) {
	const data = node.data;
	const finalId = data?.finalNode?.messageId ?? data?.finalNode?.id ?? data?.messageId;
	return typeof finalId === "string" ? finalId : void 0;
}
function toErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

//#endregion
exports.apply = apply;
exports.assistantMessageId = assistantMessageId;
exports.computeRetryContext = computeRetryContext;
exports.computeUserRefreshTargets = computeUserRefreshTargets;
exports.inject = inject;
exports.name = name;
return module.exports; } });
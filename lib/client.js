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

//#region src/core.ts
/** dsh-session-manager checkpoint 跨端协议。只包含可序列化的数据。 */
const CHECKPOINT_CHANNEL = "/dsh-session-manager";

//#endregion
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
* 最近一条已滚过视口顶部的用户行；带滞回（PIN/RELEASE）防止样式抖动。
* currentKey 为当前 pinned key，用于在边缘区间保持粘滞。
*/
function pickPinnedRow(rows, scrollerTop, currentKey) {
	let lastPast;
	let lastPastIndex = -1;
	for (const [index, row] of rows.entries()) if (row.top <= scrollerTop + PIN) {
		lastPast = row.key;
		lastPastIndex = index;
	}
	if (currentKey !== void 0) {
		const currentIndex = rows.findIndex((row) => row.key === currentKey);
		const current = currentIndex === -1 ? void 0 : rows[currentIndex];
		if (lastPastIndex > currentIndex) return lastPast;
		if (current !== void 0 && current.top <= scrollerTop + RELEASE) return currentKey;
	}
	return lastPast;
}
const EASE = "220ms cubic-bezier(0.22, 1, 0.36, 1)";
const hideTimers = /* @__PURE__ */ new WeakMap();
const TIME_ONLY = /^\d{1,2}:\d{2}(?::\d{2})?$/;
function rowBoxesOf(scroller) {
	const rows = [];
	for (const row of scroller.querySelectorAll("[data-chat-flow-kind=\"user\"][data-chat-flow-key]")) {
		const key = row.getAttribute("data-chat-flow-key") ?? "";
		if (key === "") continue;
		if (row.hasAttribute("data-turn-process-hidden")) continue;
		rows.push({
			key,
			top: row.getBoundingClientRect().top,
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
function placeFrom(prompt, from, to) {
	const scaleX = from.width / Math.max(to.width, 1);
	const scaleY = from.height / Math.max(to.height, 1);
	prompt.style.transition = "none";
	prompt.style.transformOrigin = "top left";
	prompt.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scaleX}, ${scaleY})`;
}
function animateToRest(prompt) {
	prompt.getBoundingClientRect();
	prompt.style.transition = `transform ${EASE}`;
	prompt.style.transform = "none";
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
		top: row.top
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
	const from = match.row.getBoundingClientRect();
	label.textContent = text;
	host.dataset.dshStickyKey = next;
	bar.hidden = false;
	bar.dataset.dshStickyVisible = "1";
	bindJumpInto(prompt, scroller, next);
	if (reducedMotion()) {
		clearTransform(prompt);
		return;
	}
	placeFrom(prompt, from, prompt.getBoundingClientRect());
	animateToRest(prompt);
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
  will-change:transform;
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
//#region src/client/settings.ts
const SETTINGS_NAMESPACE = "session-manager";
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
		".dsmgr_toggle{flex:none;appearance:none;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);cursor:pointer;border-radius:999px;width:40px;height:22px;padding:2px;transition:background .12s,border-color .12s;display:inline-flex;position:relative}",
		".dsmgr_toggle[aria-checked=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}",
		".dsmgr_toggle:disabled{opacity:.4;cursor:default}",
		".dsmgr_toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
		".dsmgr_knob{background:var(--dsw-alias-label-primary-foreground,#fff);width:18px;height:18px;box-shadow:0 0 0 1px var(--dsw-alias-border-l4,#0f172a1f);border-radius:50%;transition:transform .12s;display:block;transform:translate(0)}",
		".dsmgr_toggle[aria-checked=true] .dsmgr_knob{transform:translate(18px)}",
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
		onClick: props.onChange
	}, react.default.createElement("span", { className: "dsmgr_knob" }));
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
	(0, react.useEffect)(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
	const settings = readSettings(snapshot);
	const writable = snapshot.status === "ready" && snapshot.writable === true;
	const row = (title, description, checked, field) => react.default.createElement(SettingsRow, {
		title,
		description,
		checked,
		disabled: !writable,
		onChange: () => {
			scope.set(field, !checked);
		}
	});
	const note = snapshot.status === "loading" ? "正在读取设置…" : snapshot.status === "unavailable" ? "设置暂时不可用：Host 端未注册 session-manager 命名空间。" : snapshot.writable === false ? "当前设置只读（由上层配置下发）。" : "修改立即生效，无需重启。";
	return react.default.createElement("div", null, react.default.createElement("div", { className: "dsmgr_card" }, row("提示词悬浮", "滚动长回复时，把最近一条滚出视口顶部的用户消息固定在会话顶部，点击可跳回原消息。", settings.stickyPrompt, "stickyPromptEnabled"), row("删除会话", "在会话记录的下拉菜单中，于“归档会话”下方添加“删除会话”。", settings.sessionDelete, "sessionDeleteEnabled")), react.default.createElement("div", { className: "dsmgr_note" }, note));
}

//#endregion
//#region src/client/index.ts
const name = "dsh-session-manager-client";
const inject = [
	"slots",
	"workspaces",
	"sessions",
	"settingsScope"
];
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
	const getConnection = () => {
		try {
			return ctx.get("connection");
		} catch {
			return;
		}
	};
	const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
	const disposeSettingsCss = injectCss();
	let disposeSticky;
	let disposeSessionMenu;
	const stickyEnabledNow = () => readSettings(scope.getSnapshot()).stickyPrompt;
	const sessionDeleteEnabledNow = () => readSettings(scope.getSnapshot()).sessionDelete;
	const syncFeatureGates = () => {
		const { stickyPrompt, sessionDelete } = readSettings(scope.getSnapshot());
		if (stickyPrompt && disposeSticky === void 0) disposeSticky = applyStickyPrompt(stickyEnabledNow, () => {
			try {
				return sessions.list.getSnapshot().current;
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
				workspaces,
				getUiConversation
			});
		});
	});
	const disposeCheckpoints = installCheckpointEntries(sessions, workspaces, getUiConversation, getConnection);
	ctx.on?.("dispose", disposeCheckpoints);
	ctx.on?.("dispose", () => {
		unsubscribeSettings();
		disposeSticky?.();
		disposeSessionMenu?.();
		disposeSettingsCss();
	});
}
function extractUserText(content) {
	if (!Array.isArray(content)) return "";
	for (const block of content) if (typeof block === "object" && block !== null) {
		const b = block;
		if ((b.type === "text" || b.kind === "text") && typeof b.text === "string") return b.text.slice(0, 80);
	}
	return "";
}
function computeUserCheckpoints(chat) {
	if (!chat) return [];
	const turnEnds = chat.legacy?.turnEnds;
	if (!chat.nodes || !turnEnds) return [];
	const result = [];
	for (const node of chat.nodes.values()) {
		if (node.kind !== "user" || node.visibility !== "visible") continue;
		if (typeof node.key !== "string" || node.key === "") continue;
		const turn = node.location?.turn?.turn;
		if (typeof turn !== "number") continue;
		const forkSeq = turnEnds.get(turn - 1);
		if (typeof forkSeq !== "number") continue;
		result.push({
			key: node.key,
			turn,
			preview: extractUserText(node.data?.content),
			forkSeq
		});
	}
	const order = chat.order;
	if (order && order.length > 0) {
		const indexByKey = /* @__PURE__ */ new Map();
		order.forEach((key, index) => indexByKey.set(key, index));
		result.sort((a, b) => (indexByKey.get(a.key) ?? 0) - (indexByKey.get(b.key) ?? 0));
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
		if (node.kind !== "user" || node.visibility !== "visible") continue;
		if (typeof node.key !== "string" || node.key === "") continue;
		const turn = node.location?.turn?.turn;
		if (typeof turn !== "number") continue;
		const content = node.data?.content;
		if (!Array.isArray(content) || content.length === 0) continue;
		let previousTurnEnd;
		if (turnEnds) {
			for (const [completedTurn, endSeq] of turnEnds) if (completedTurn < turn && (previousTurnEnd === void 0 || endSeq > previousTurnEnd)) previousTurnEnd = endSeq;
		}
		map.set(node.key, {
			key: node.key,
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
	if (seats.length === 0 && typeof turn === "number") for (const el of Array.from(document.querySelectorAll(`[data-chat-turn="${turn}"]`))) {
		const kind = el.getAttribute("data-chat-flow-kind") ?? "";
		if (kind !== "user" && kind !== "steering") seats.push(el);
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
const CHECKPOINT_DIALOG = "[data-dsh-checkpoint-dialog=\"true\"]";
/** actions 容器必须真实持有按钮；空装饰壳（可能匹配 actions 前缀类名）不能当宿主。 */
function findActionsRow(row) {
	const candidates = Array.from(row.querySelectorAll("[class*=\"_actions\"], [class*=\"actions\"]"));
	return candidates.find((element) => element.querySelector("button") !== null) ?? candidates[0];
}
function ensureCheckpointStyle() {
	const style = document.querySelector("style[data-dsh-checkpoint-style]") ?? document.createElement("style");
	style.dataset.dshCheckpointStyle = "true";
	style.textContent = [
		`${CHECKPOINT_PILL}{display:contents!important;opacity:1!important;visibility:visible!important;pointer-events:auto!important}`,
		`${CHECKPOINT_PILL}>button{flex:none!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;cursor:pointer!important}`,
		`.dsh-regen-placeholder{display:inline-flex!important;align-items:center!important;gap:6px!important;margin-top:8px!important;padding:4px 10px!important;border-radius:12px!important;font-size:12px!important;line-height:18px!important;color:var(--dsw-alias-label-secondary,#666)!important;background:var(--dsw-alias-interactive-bg-default,rgba(127,127,127,0.12))!important}`,
		`.dsh-regen-placeholder::before{content:""!important;width:6px!important;height:6px!important;border-radius:50%!important;background:currentColor!important;animation:dsh-regen-pulse 1.1s ease-in-out infinite!important}`,
		`@keyframes dsh-regen-pulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}`
	].join("\n");
	if (!style.parentElement) document.head.appendChild(style);
}
function currentSessionSnapshot(sessions, getUiConversation) {
	const sessionId = sessions.list.getSnapshot().current;
	if (!sessionId) return void 0;
	let chat;
	try {
		chat = (getUiConversation()?.binding(sessionId))?.snapshot?.getSnapshot()?.views?.get("chat") ?? void 0;
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
function createCheckpointPill(cp, key, onOpen) {
	const pill = document.createElement("div");
	pill.dataset.dshCheckpointPill = "true";
	pill.dataset.dshCheckpointKey = key;
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = `↩ 回滚 #${cp.turn}`;
	button.title = cp.preview ? `回滚到第 ${cp.turn} 轮之前：${cp.preview}` : `回滚到第 ${cp.turn} 轮之前`;
	button.dataset.dshCheckpointButton = "true";
	attachCheckpointAction(button, onOpen);
	pill.appendChild(button);
	return pill;
}
function attachCheckpointAction(button, onOpen) {
	const activate = (event) => {
		event.preventDefault();
		event.stopPropagation();
		onOpen();
	};
	button.addEventListener("pointerdown", activate, true);
	button.addEventListener("click", activate, true);
}
function adoptCopyButtonStyle(pill, actions, cp, onOpen) {
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
	replacement.setAttribute("aria-label", `回滚到第 ${cp.turn} 轮之前`);
	replacement.title = cp.preview ? `回滚到第 ${cp.turn} 轮之前：${cp.preview}` : `回滚到第 ${cp.turn} 轮之前`;
	replacement.replaceChildren(document.createTextNode("↩"));
	current.replaceWith(replacement);
	attachCheckpointAction(replacement, onOpen);
}
/** 调一次 checkpoint RPC，失败时抛出带宿主错误信息的 Error。 */
async function callCheckpoint(connection, endpoint, payload) {
	const result = await connection.rpc.call(CHECKPOINT_CHANNEL, endpoint, payload);
	if (!result.ok) throw new Error(result.error?.message ?? `${endpoint} 失败`);
	return result.value;
}
function openRollbackDialog(cp, sessions, workspaces, getConnection) {
	document.querySelector(CHECKPOINT_DIALOG)?.remove();
	const overlay = document.createElement("div");
	overlay.dataset.dshCheckpointDialog = "true";
	overlay.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.3)";
	const card = document.createElement("div");
	card.style.cssText = "position:relative;overflow:hidden;background:var(--dsw-alias-bg-primary,#fff);border-radius:12px;padding:24px;min-width:360px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,0.18);color:var(--dsw-alias-label-primary,#101828)";
	const progressTrack = document.createElement("div");
	progressTrack.style.cssText = "display:none;position:absolute;left:0;right:0;top:0;height:4px;background:var(--dsw-alias-bg-tertiary,#eaecf0)";
	const progressFill = document.createElement("div");
	progressFill.style.cssText = "height:100%;width:0;background:var(--dsw-alias-state-success-primary,#12b76a);transition:width 200ms ease";
	progressTrack.appendChild(progressFill);
	card.appendChild(progressTrack);
	const title = document.createElement("div");
	title.style.cssText = "font-size:15px;font-weight:600;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center";
	const titleText = document.createElement("span");
	titleText.textContent = `撤销第 ${cp.turn} 轮及之后`;
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.setAttribute("aria-label", "关闭");
	close.style.cssText = "background:none;border:none;font-size:18px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#98a2b3);padding:0 4px;line-height:1";
	close.addEventListener("click", () => overlay.remove());
	title.append(titleText, close);
	card.appendChild(title);
	if (cp.preview) {
		const preview = document.createElement("div");
		preview.textContent = cp.preview;
		preview.style.cssText = "font-size:12px;color:var(--dsw-alias-label-tertiary,#98a2b3);margin-bottom:16px;padding:8px 10px;background:var(--dsw-alias-bg-secondary,#f9fafb);border-radius:6px;max-height:48px;overflow:hidden;line-height:1.4";
		card.appendChild(preview);
	}
	const status = document.createElement("div");
	status.dataset.dshCheckpointStatus = "true";
	status.style.cssText = "display:none;font-size:12px;margin-top:10px;color:var(--dsw-alias-label-secondary,#475467);line-height:1.5";
	card.appendChild(status);
	const message = document.createElement("div");
	message.style.cssText = "font-size:12px;margin-top:10px;display:none;line-height:1.5";
	card.appendChild(message);
	const details = document.createElement("div");
	details.dataset.dshCheckpointDetails = "true";
	details.style.cssText = "display:none;margin-top:8px;max-height:150px;overflow:auto;font-size:11px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#475467);background:var(--dsw-alias-bg-secondary,#f9fafb);border-radius:6px;padding:8px 10px;white-space:pre-wrap;word-break:break-all";
	card.appendChild(details);
	const footer = document.createElement("div");
	footer.style.cssText = "display:none;margin-top:12px;justify-content:flex-end";
	const doneButton = document.createElement("button");
	doneButton.type = "button";
	doneButton.dataset.dshCheckpointDone = "true";
	doneButton.textContent = "关闭";
	doneButton.style.cssText = "padding:6px 16px;font-size:12px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-secondary,#d0d5dd);background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#101828)";
	doneButton.addEventListener("click", () => overlay.remove());
	footer.appendChild(doneButton);
	card.appendChild(footer);
	const showMessage = (text, isError) => {
		message.textContent = text;
		message.style.display = text ? "block" : "none";
		message.style.color = isError ? "var(--dsw-alias-state-error-primary,#d92d20)" : "var(--dsw-alias-state-success-primary,#12b76a)";
	};
	const actionButtons = () => Array.from(card.querySelectorAll("button[data-dsh-checkpoint-action]"));
	let startedAt = 0;
	let stepText = "";
	let ticker;
	const stopTicker = () => {
		if (ticker !== void 0) clearInterval(ticker);
		ticker = void 0;
	};
	const renderStatus = () => {
		if (!stepText) {
			status.textContent = "";
			return;
		}
		const seconds = Math.round((Date.now() - startedAt) / 1e3);
		status.textContent = seconds >= 2 ? `${stepText}（已用 ${seconds} 秒）` : stepText;
	};
	const ui = {
		begin() {
			startedAt = Date.now();
			progressTrack.style.display = "block";
			status.style.display = "block";
			progressFill.style.background = "var(--dsw-alias-state-success-primary,#12b76a)";
			showMessage("", false);
			details.style.display = "none";
			for (const action of actionButtons()) action.style.display = "none";
			if (ticker === void 0) ticker = setInterval(renderStatus, 500);
		},
		progress(percent, step) {
			progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
			stepText = step;
			renderStatus();
		},
		detail(items) {
			details.textContent = items.join("\n");
			details.style.display = items.length > 0 ? "block" : "none";
			details.scrollTop = details.scrollHeight;
		},
		fail(text) {
			stopTicker();
			stepText = "";
			progressFill.style.background = "var(--dsw-alias-state-error-primary,#d92d20)";
			progressFill.style.width = "100%";
			renderStatus();
			showMessage(text, true);
			footer.style.display = "flex";
			for (const action of actionButtons()) {
				action.style.display = "";
				action.disabled = false;
			}
			progressTrack.style.display = "none";
		},
		done(summary, isError, items = []) {
			stopTicker();
			stepText = "";
			progressFill.style.background = isError ? "var(--dsw-alias-state-error-primary,#d92d20)" : "var(--dsw-alias-state-success-primary,#12b76a)";
			progressFill.style.width = "100%";
			renderStatus();
			showMessage(summary, isError);
			ui.detail(items);
			footer.style.display = "flex";
		}
	};
	let planState = "loading";
	let plan;
	const fileOptionHint = () => {
		const tail = `清除第 ${cp.turn} 轮及之后的所有对话记录，并回滚工作区文件`;
		if (planState === "loading") return `${tail}（正在读取检查点快照…）`;
		if (planState === "error" || !plan) return `${tail}（预演失败：无法确认文件变更范围，不会执行文件回滚）`;
		if (plan.snapshotStatus === "missing") return `${tail}：该检查点没有精确的文件快照，无法回滚文件（可改用「仅回滚对话」）`;
		if (!plan.hasSnapshot) return `${tail}：该检查点没有文件快照，只能恢复 git 跟踪文件`;
		if (plan.unsupported.length > 0) return `${tail}：${plan.unsupported.length} 个文件无法安全恢复，已禁止文件回滚`;
		const parts = [`清除第 ${cp.turn} 轮及之后的对话`];
		parts.push(plan.restore.length > 0 ? `只回滚本次对话改动的 ${plan.restore.length} 个文件` : "文件无需改动");
		if (plan.remove.length > 0) parts.push(`撤销 ${plan.remove.length} 个新增文件`);
		if (!plan.scoped) parts.push("（归属信息不完整，将按全工作区回滚）");
		else if (plan.skippedCount > 0) parts.push(`（跳过 ${plan.skippedCount} 个非本次对话的改动）`);
		if (plan.persisted === false) parts.push("（快照未持久化，重启后不可用）");
		return parts.join("，");
	};
	/**
	* 点击前就把"将回滚什么"摊开给用户看，避免回滚完才发现多撤了东西。
	* 只列会被回滚的内容：与检查点一致的文件、非本次对话改动的文件都不展示，
	* 只有"没有活可干"时才用一句话说明原因（否则纯属噪声）。
	*/
	const renderPlan = (value) => {
		const lines = [];
		if (value.restore.length > 0) {
			lines.push(`将回滚（本次对话改动，${value.restore.length}）`);
			for (const file of value.restore.slice(0, 30)) lines.push(`  ${file}`);
			if (value.restore.length > 30) lines.push(`  …另有 ${value.restore.length - 30} 个`);
		}
		if (value.remove.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push(`将删除（检查点后新增，${value.remove.length}）`);
			for (const file of value.remove.slice(0, 30)) lines.push(`  ${file}`);
			if (value.remove.length > 30) lines.push(`  …另有 ${value.remove.length - 30} 个`);
		}
		if (lines.length === 0) lines.push(value.snapshotStatus === "missing" ? "该检查点没有精确文件快照，无法回滚文件" : value.hasSnapshot ? "文件与检查点一致，无需改动" : "该检查点没有文件快照，只能恢复 git 跟踪的文件");
		for (const item of value.unsupported) lines.push("", `无法安全恢复：${item.path}（${item.reason}）`);
		if (value.snapshotStatus === "exact" && value.persisted === false) lines.push("", "注意：该快照未成功持久化，重启后不可用。");
		if (!value.scoped && value.unknownSnapshots > 0) lines.push("", `注意：窗口内 ${value.unknownSnapshots} 个检查点缺少文件归属信息，本次按全工作区回滚（会把上表之外的其他改动一并撤销）。`);
		ui.detail(lines);
	};
	const makeAction = (label, hintOf, withFiles) => {
		const action = document.createElement("button");
		action.type = "button";
		action.dataset.dshCheckpointAction = "true";
		action.style.cssText = "width:100%;padding:10px 14px;font-size:13px;border-radius:8px;cursor:pointer;text-align:left;line-height:1.4;border:1px solid var(--dsw-alias-border-secondary,#d0d5dd);background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#101828)";
		const labelDiv = document.createElement("div");
		labelDiv.textContent = label;
		const hintDiv = document.createElement("div");
		hintDiv.style.cssText = "font-size:11px;margin-top:2px;color:var(--dsw-alias-label-tertiary,#98a2b3)";
		action.append(labelDiv, hintDiv);
		const refreshHint = () => {
			hintDiv.textContent = hintOf();
		};
		refreshHint();
		hintRefreshers.push(refreshHint);
		action.addEventListener("click", () => {
			performRollback(cp, withFiles, sessions, workspaces, getConnection, ui, () => plan);
		});
		return action;
	};
	const hintRefreshers = [];
	const group = document.createElement("div");
	group.style.cssText = "display:flex;flex-direction:column;gap:8px";
	group.appendChild(makeAction("仅回滚对话", () => `清除第 ${cp.turn} 轮及之后的所有对话记录，不恢复文件变更`, false));
	group.appendChild(makeAction("回滚对话 + 文件", fileOptionHint, true));
	card.appendChild(group);
	overlay.appendChild(card);
	overlay.addEventListener("click", (event) => {
		if (event.target === overlay) overlay.remove();
	});
	document.body.appendChild(overlay);
	const connection = getConnection();
	if (!connection) {
		planState = "error";
		for (const refresh of hintRefreshers) refresh();
		return;
	}
	callCheckpoint(connection, "preview-rollback", {
		sessionId: sessions.list.getSnapshot().current,
		checkpointSeq: cp.forkSeq
	}).then((value) => {
		plan = value;
		planState = "ready";
		renderPlan(value);
	}).catch(() => {
		planState = "error";
	}).finally(() => {
		for (const refresh of hintRefreshers) refresh();
	});
}
/** 防止双击 / 连续点击触发两次回滚。 */
let rollbackInFlight = false;
async function performRollback(cp, withFiles, sessions, workspaces, getConnection, ui, getPlan) {
	if (rollbackInFlight) {
		ui.fail("正在执行回滚，请稍候");
		return;
	}
	rollbackInFlight = true;
	try {
		const sessionId = sessions.list.getSnapshot().current;
		if (!sessionId) {
			ui.fail("无法确定当前会话");
			return;
		}
		const connection = getConnection();
		if (!connection) {
			ui.fail("连接服务不可用");
			return;
		}
		ui.begin();
		let preview = getPlan();
		if (withFiles && !preview) {
			ui.progress(6, "正在读取检查点快照…");
			preview = await callCheckpoint(connection, "preview-rollback", {
				sessionId,
				checkpointSeq: cp.forkSeq
			});
		}
		if (withFiles) {
			if (!preview || preview.snapshotStatus !== "exact" || !preview.planId) {
				ui.fail("该检查点没有精确的文件快照，无法回滚文件。可改用「仅回滚对话」。");
				return;
			}
			if (preview.unsupported.length > 0) {
				ui.fail(`以下文件无法安全恢复，已取消文件回滚（可改用「仅回滚对话」）：\n${preview.unsupported.map((item) => `  ${item.path}（${item.reason}）`).join("\n")}`);
				return;
			}
		}
		let applyResult;
		if (withFiles && preview) {
			const plan = preview;
			const workCount = plan.restore.length + plan.remove.length;
			ui.progress(30, `正在校验并按计划回滚 ${workCount} 个文件…`);
			ui.detail([]);
			applyResult = await callCheckpoint(connection, "apply-rollback", { planId: plan.planId });
			const conflicts = applyResult.conflicts ?? [];
			const errors = applyResult.errors ?? [];
			if (conflicts.length > 0 || errors.length > 0) {
				const detail = [...conflicts.length > 0 ? [
					"",
					`以下文件预演后被改动，已按安全规则跳过（${conflicts.length}）：`,
					...conflicts
				] : [], ...errors.length > 0 ? [
					"",
					`以下文件处理失败（${errors.length}）：`,
					...errors
				] : []];
				ui.done("文件回滚未完全成功，已取消对话回滚（原会话保持不变）。", true, detail);
				return;
			}
		}
		ui.progress(78, `正在清除第 ${cp.turn} 轮及之后的对话…`);
		const convData = await callCheckpoint(connection, "rollback-conversation", {
			sessionId,
			checkpointSeq: cp.forkSeq
		});
		sessions.open(convData.newSessionId);
		if (!withFiles) {
			await archiveQuietly(workspaces, sessionId);
			ui.done(`已回滚对话：已清除第 ${cp.turn} 轮及之后的记录，并切换到新会话`, false);
			return;
		}
		const restored = applyResult?.restored ?? [];
		const removed = applyResult?.removed ?? [];
		await archiveQuietly(workspaces, sessionId);
		const parts = [`已回滚对话和文件：清除第 ${cp.turn} 轮及之后的对话`];
		if (restored.length > 0) parts.push(`写回 ${restored.length} 个有改动的文件`);
		if (removed.length > 0) parts.push(`撤销 ${removed.length} 个新增文件`);
		if (restored.length === 0 && removed.length === 0) parts.push(preview?.hasSnapshot ? "文件与检查点一致，无需改动" : "该检查点没有文件快照，未改动文件");
		const scopeNote = preview && !preview.scoped && preview.unknownSnapshots > 0 ? "注意：窗口内存在缺少归属信息的检查点，本次按全工作区回滚。" : "";
		ui.done(`${parts.join("，")}。${scopeNote}`, false, [...restored.map((file) => `写回 ${file}`), ...removed.map((file) => `撤销新增 ${file}`)]);
	} catch (err) {
		ui.fail(toErrorMessage(err));
	} finally {
		rollbackInFlight = false;
	}
}
async function archiveQuietly(workspaces, sessionId) {
	try {
		await workspaces.archiveSession(sessionId);
	} catch {}
}
function installCheckpointEntries(sessions, workspaces, getUiConversation, getConnection) {
	if (typeof document === "undefined") return () => void 0;
	ensureCheckpointStyle();
	let disposed = false;
	let syncing = false;
	let timer;
	let lastDebugSignature = "";
	let latestRefreshTargets = /* @__PURE__ */ new Map();
	const debugEnabled = () => {
		try {
			return window.localStorage.getItem("dshSessionManagerDebug") === "1";
		} catch {
			return false;
		}
	};
	/** 用户消息「刷新」：共用重新生成核心；成功即替换原回答（原会话归档）。 */
	const runRefresh = (target, button) => {
		const sessionId = sessions.list.getSnapshot().current;
		if (!sessionId) return;
		const current = latestRefreshTargets.get(target.key) ?? target;
		button.disabled = true;
		button.style.opacity = "0.5";
		const restore = showRegeneratingPlaceholder(current.assistantKeys, current.turn);
		regenerateTurn({
			sessionId,
			sourceKey: `user:${current.key}`,
			content: current.content,
			previousTurnEnd: current.previousTurnEnd,
			turn: current.turn
		}, {
			sessions,
			workspaces,
			getUiConversation
		}).then(async (replacementSessionId) => {
			if (sessions.list.getSnapshot().current === sessionId) sessions.open(replacementSessionId);
			await archiveQuietly(workspaces, sessionId);
		}).catch((error) => {
			button.title = `刷新失败：${toErrorMessage(error)}`;
		}).finally(() => {
			restore();
			button.disabled = false;
			button.style.opacity = "";
		});
	};
	const sync = () => {
		if (disposed || syncing) return;
		syncing = true;
		try {
			const current = currentSessionSnapshot(sessions, getUiConversation);
			const checkpoints = computeUserCheckpoints(current?.chat);
			const byKey = new Map(checkpoints.map((cp) => [cp.key, cp]));
			const refreshTargets = computeUserRefreshTargets(current?.chat);
			latestRefreshTargets = refreshTargets;
			const pillByKey = /* @__PURE__ */ new Map();
			for (const element of Array.from(document.querySelectorAll(CHECKPOINT_PILL))) {
				const pill = element;
				const key = pill.dataset.dshCheckpointKey;
				if (key && !pillByKey.has(key)) pillByKey.set(key, pill);
				else pill.remove();
			}
			const seen = /* @__PURE__ */ new Set();
			const seenRefresh = /* @__PURE__ */ new Set();
			const rows = Array.from(document.querySelectorAll("[data-chat-flow-kind=\"user\"]"));
			let rowsWithActions = 0;
			let copyTemplates = 0;
			for (const row of rows) {
				const key = row.getAttribute("data-chat-flow-key") ?? "";
				seen.add(key);
				const cp = key ? byKey.get(key) : void 0;
				let pill = key ? pillByKey.get(key) : void 0;
				if (!cp) {
					pill?.remove();
					continue;
				}
				if (!pill) {
					pill = createCheckpointPill(cp, key, () => openRollbackDialog(cp, sessions, workspaces, getConnection));
					pillByKey.set(key, pill);
				}
				const actions = findActionsRow(row);
				if (actions) {
					if (!actions.contains(pill)) actions.appendChild(pill);
					adoptCopyButtonStyle(pill, actions, cp, () => openRollbackDialog(cp, sessions, workspaces, getConnection));
					rowsWithActions += 1;
					if (actions.querySelector("button[aria-label=\"复制\"], button[aria-label=\"copy\"]")) copyTemplates += 1;
				} else if (row.nextElementSibling !== pill) row.insertAdjacentElement("afterend", pill);
				const refreshTarget = key ? refreshTargets.get(key) : void 0;
				if (actions) {
					const refreshButton = actions.querySelector("[data-dsh-refresh=\"true\"]");
					if (refreshTarget && !refreshTarget.generating) {
						seenRefresh.add(key);
						ensureRefreshButton(actions, refreshTarget, runRefresh);
					} else refreshButton?.remove();
				}
				const button = pill.querySelector("button");
				if (button) {
					if (button.dataset.dshCopyStyle !== "true") button.textContent = `↩ 回滚 #${cp.turn}`;
					button.title = cp.preview ? `回滚到第 ${cp.turn} 轮之前：${cp.preview}` : `回滚到第 ${cp.turn} 轮之前`;
				}
			}
			for (const pill of pillByKey.values()) if (!seen.has(pill.dataset.dshCheckpointKey ?? "")) pill.remove();
			for (const element of Array.from(document.querySelectorAll("[data-dsh-refresh=\"true\"]"))) if (!seenRefresh.has(element.dataset.dshRefreshKey ?? "")) element.remove();
			if (debugEnabled()) {
				const signature = JSON.stringify({
					sessionId: current?.sessionId,
					hasChat: Boolean(current?.chat),
					rows: rows.length,
					checkpoints: checkpoints.length,
					rowsWithActions,
					copyTemplates,
					pills: document.querySelectorAll(CHECKPOINT_PILL).length
				});
				if (signature !== lastDebugSignature) {
					lastDebugSignature = signature;
					console.debug("[dsh-session-manager] rollback sync:", signature);
				}
			}
		} finally {
			syncing = false;
		}
	};
	const schedule = () => {
		if (disposed || syncing || timer !== void 0) return;
		timer = setTimeout(() => {
			timer = void 0;
			if (!disposed) sync();
		}, 50);
	};
	const unsubscribe = sessions.list.subscribe?.(schedule);
	const observer = new MutationObserver(schedule);
	observer.observe(document.body, {
		childList: true,
		subtree: true
	});
	schedule();
	return () => {
		disposed = true;
		if (timer !== void 0) clearTimeout(timer);
		observer.disconnect();
		unsubscribe?.();
		removeAllCheckpointPills();
		document.querySelector(CHECKPOINT_DIALOG)?.remove();
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
		if (!archiveItem || archiveItem.parentElement?.querySelector("[data-dsh-session-delete=\"true\"]")) return;
		const deleteItem = archiveItem.cloneNode(true);
		deleteItem.setAttribute("data-dsh-session-delete", "true");
		deleteItem.setAttribute("aria-label", "删除会话");
		deleteItem.removeAttribute("aria-current");
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
		archiveItem.insertAdjacentElement("afterend", deleteItem);
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
const activeRegenerations = /* @__PURE__ */ new Set();
/** 等待新回复的硬上限（足够覆盖长答案；显式取消走 AbortController）。 */
const REGENERATE_TIMEOUT_MS = 600 * 1e3;
/** 读取某会话的 chat 视图快照。 */
function readChatView(getUiConversation, sessionId) {
	try {
		return getUiConversation()?.binding(sessionId)?.snapshot?.getSnapshot()?.views?.get("chat");
	} catch {
		return;
	}
}
/** 提交 prompt 前，收集重建会话里已有 assistant 的 messageId 基线。 */
function collectBaselineAssistantIds(getUiConversation, sessionId) {
	const ids = /* @__PURE__ */ new Set();
	const chat = readChatView(getUiConversation, sessionId);
	for (const node of chat?.nodes?.values() ?? []) {
		if (!isAssistantNode(node)) continue;
		const id = assistantMessageId(node);
		if (id !== void 0) ids.add(id);
	}
	return ids;
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
* 等待"本次新生成"的 assistant 进入终态：仅 `status === 'settled'` 算成功，
* `status === 'interrupted'` 算失败/被中断。基线之外的 assistant（含 streaming 中
* 尚未拿到 messageId 的节点）一律视为"新回复"，不再拿历史回复顶包。
*/
async function waitForNewAssistant(getUiConversation, sessionId, baselineIds, signal, timeoutMs = REGENERATE_TIMEOUT_MS) {
	const scanFresh = () => {
		const chat = readChatView(getUiConversation, sessionId);
		const fresh = [];
		for (const node of chat?.nodes?.values() ?? []) {
			if (!isAssistantNode(node)) continue;
			const id = assistantMessageId(node);
			if (id === void 0 || !baselineIds.has(id)) fresh.push(node);
		}
		return fresh.at(-1);
	};
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("已取消");
		const target = scanFresh();
		if (target) {
			const status = target.data?.status;
			if (status === "settled") return;
			if (status === "interrupted") throw new Error("重新生成已被中断");
		}
		if (Date.now() >= deadline) throw new Error("等待新回复超时");
		await sleep(150);
	}
}
/** 读源会话当前生效的模型选择（投影 view 的 next = pending ?? lastUsed）。 */
function readModelSelection(sessions, sessionId) {
	try {
		const next = ((sessions.binding(sessionId)?.session)?.projections?.faceOf?.("modelSelection")?.getSnapshot())?.next;
		if (next && typeof next.provider === "string" && typeof next.model === "string") return {
			provider: next.provider,
			model: next.model,
			...typeof next.reasoningEffort === "string" ? { reasoningEffort: next.reasoningEffort } : {}
		};
	} catch {}
}
/** 把选择补设到重建出的会话（selectForNextRequest 生效于下一次请求）；失败不阻塞重新生成。 */
async function restoreModelSelection(sessions, sessionId, selection) {
	try {
		const result = await (sessions.binding(sessionId)?.session)?.remote?.session?.selectModel?.({
			sessionId,
			provider: selection.provider,
			model: selection.model,
			...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
		});
		if (result && result.ok === false) console.warn(`[dsh-session-manager] 恢复模型选择失败：${result.error?.message ?? "unknown"}`);
	} catch (error) {
		console.warn("[dsh-session-manager] 恢复模型选择失败：", error);
	}
}
/** 第一轮也尽量 fork（atSeq=0 截取到仅 header，继承配置）；失败才退化为 connectWorkspace。 */
async function forkFirstTurn(deps, req) {
	try {
		return await deps.sessions.fork({
			sessionId: req.sessionId,
			atSeq: 0,
			increaseTitle: false
		});
	} catch {
		const workspaceId = findWorkspaceId(req.sessionId, deps.sessions, deps.workspaces);
		if (!workspaceId) throw new Error("无法确定该会话所属工作区");
		return await deps.workspaces.connectWorkspace(workspaceId);
	}
}
/** 刷新/重新生成主流程：fork → prompt（宿主接纳即返回）→ 返回新会话 id。
*  答案随后在新会话里流式生成；由调用方立刻 switch + 归档原会话，做到「原地替换」
*  的手感：fork 已完整保留原历史，旧会话只是归档隐藏、可恢复。 */
async function regenerateTurn(req, deps) {
	const lockKey = `${req.sessionId}:${req.sourceKey}`;
	if (activeRegenerations.has(lockKey)) throw new Error("正在重新生成，请稍候");
	activeRegenerations.add(lockKey);
	const controller = new AbortController();
	const onExternalAbort = () => controller.abort();
	deps.signal?.addEventListener("abort", onExternalAbort, { once: true });
	const timeout = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("重新生成超时")), REGENERATE_TIMEOUT_MS);
	let replacementSessionId;
	try {
		replacementSessionId = req.previousTurnEnd !== void 0 ? await deps.sessions.fork({
			sessionId: req.sessionId,
			atSeq: req.previousTurnEnd,
			increaseTitle: false
		}) : await forkFirstTurn(deps, req);
		const replacement = deps.sessions.binding(replacementSessionId);
		if (!replacement) throw new Error("重建会话失败");
		const selection = readModelSelection(deps.sessions, req.sessionId);
		if (selection) await restoreModelSelection(deps.sessions, replacementSessionId, selection);
		await replacement.session.prompt(req.content, "queue", controller.signal);
		return replacementSessionId;
	} catch (error) {
		if (replacementSessionId !== void 0) try {
			await deps.workspaces.archiveSession(replacementSessionId);
		} catch {}
		throw error;
	} finally {
		clearTimeout(timeout);
		deps.signal?.removeEventListener("abort", onExternalAbort);
		activeRegenerations.delete(lockKey);
	}
}
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
	return {
		content: [...content],
		previousTurnEnd,
		turn: typeof turn === "number" ? turn : void 0,
		assistantStatus: typeof assistantStatus === "string" ? assistantStatus : void 0,
		assistantKey: assistant.key
	};
}
function RetryButton({ sessionId, messageId, sessions, workspaces, getUiConversation }) {
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
		const controller = new AbortController();
		controllerRef.current = controller;
		setBusy(true);
		setError(null);
		const restore = showRegeneratingPlaceholder(retryContext.assistantKey ? [retryContext.assistantKey] : [], retryContext.turn);
		try {
			const replacementSessionId = await regenerateTurn({
				sessionId,
				sourceKey: messageId,
				content: retryContext.content,
				previousTurnEnd: retryContext.previousTurnEnd,
				turn: retryContext.turn
			}, {
				sessions,
				workspaces,
				getUiConversation,
				signal: controller.signal
			});
			if (sessions.list.getSnapshot().current === sessionId) sessions.open(replacementSessionId);
			await archiveQuietly(workspaces, sessionId);
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
function findWorkspaceId(sessionId, sessions, workspaces) {
	const session = sessions.list.getSnapshot().byId[sessionId];
	const items = workspaces.list.getSnapshot().items;
	const pathId = items.find((item) => {
		const path = item.path ?? item.cwd ?? item.root;
		return typeof path === "string" && Boolean(session?.cwd) && path === session.cwd;
	})?.id;
	if (typeof pathId === "string") return pathId;
	const containingId = items.find((item) => containsString(item, sessionId, 0))?.id;
	return typeof containingId === "string" ? containingId : void 0;
}
function containsString(value, expected, depth) {
	if (value === expected) return true;
	if (depth >= 4 || value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((item) => containsString(item, expected, depth + 1));
	return Object.values(value).some((item) => containsString(item, expected, depth + 1));
}
function toErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

//#endregion
exports.apply = apply;
exports.assistantMessageId = assistantMessageId;
exports.collectBaselineAssistantIds = collectBaselineAssistantIds;
exports.computeRetryContext = computeRetryContext;
exports.computeUserRefreshTargets = computeUserRefreshTargets;
exports.inject = inject;
exports.name = name;
exports.waitForNewAssistant = waitForNewAssistant;
return module.exports; } });
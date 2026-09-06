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

//#region src/client/index.ts
const name = "dsh-session-manager-client";
const inject = [
	"slots",
	"workspaces",
	"sessions"
];
function apply(ctx) {
	const { slots, workspaces, sessions } = ctx;
	const disposeSessionMenu = installSessionMenuDelete(workspaces, sessions);
	ctx.on?.("dispose", disposeSessionMenu);
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
				useSession: props.useSession
			});
		});
	});
}
function installSessionMenuDelete(workspaces, sessions) {
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
/** 只替换菜单文字，保留宿主菜单原有的布局、class、快捷键和图标容器。 */
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
/** 复用宿主菜单图标的尺寸和样式，只替换为删除图标。 */
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
function RetryButton({ sessionId, messageId, sessions, workspaces, useSession }) {
	const [busy, setBusy] = react.default.useState(false);
	const [error, setError] = react.default.useState(null);
	const retryContext = useSession?.((snapshot) => {
		const nodes = snapshot.nodes ?? [];
		const assistantIndex = nodes.findIndex((node) => node.kind === "assistant" && node.messageId === messageId);
		if (assistantIndex < 0) return void 0;
		const assistant = nodes[assistantIndex];
		let user;
		for (let index = assistantIndex - 1; index >= 0; index--) if (nodes[index].kind === "user") {
			user = nodes[index];
			break;
		}
		if (!user?.content?.length) return void 0;
		let previousTurnEnd;
		if (typeof assistant.turn === "number" && snapshot.turnEnds) {
			for (const [turn, endSeq] of snapshot.turnEnds) if (turn < assistant.turn && (previousTurnEnd === void 0 || endSeq > previousTurnEnd)) previousTurnEnd = endSeq;
		}
		return {
			content: [...user.content],
			previousTurnEnd
		};
	});
	const handle = async () => {
		if (!retryContext || busy) return;
		setBusy(true);
		setError(null);
		let replacementSessionId;
		let replacementOpened = false;
		try {
			if (retryContext.previousTurnEnd !== void 0) replacementSessionId = await sessions.fork({
				sessionId,
				atSeq: retryContext.previousTurnEnd,
				increaseTitle: false
			});
			else {
				const workspaceId = findWorkspaceId(sessionId, sessions, workspaces);
				if (!workspaceId) throw new Error("无法确定该会话所属工作区");
				replacementSessionId = await workspaces.connectWorkspace(workspaceId);
			}
			const replacement = sessions.binding(replacementSessionId);
			if (!replacement) throw new Error("重建会话失败");
			await replacement.session.prompt(retryContext.content, "queue");
			await waitUntilReplacementHasAssistantContent(replacement.session);
			replacementOpened = true;
			sessions.open(replacementSessionId);
			await workspaces.archiveSession(sessionId);
		} catch (cause) {
			if (replacementSessionId && replacementSessionId !== sessionId && !replacementOpened) try {
				await workspaces.archiveSession(replacementSessionId);
			} catch {}
			setError(toErrorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	const onMouseEnter = (event) => {
		event.currentTarget.style.color = "var(--dsw-alias-label-primary)";
	};
	const onMouseLeave = (event) => {
		event.currentTarget.style.color = error ? "var(--dsw-alias-state-error-primary, #d92d20)" : "var(--dsw-alias-label-tertiary)";
	};
	const title = error ? `重新生成失败：${error}` : retryContext ? "重新生成此回复" : "无法定位此回复对应的用户消息";
	return react.default.createElement("button", {
		type: "button",
		"aria-label": title,
		title,
		disabled: busy || !retryContext,
		onClick: handle,
		style: {
			width: 28,
			height: 28,
			display: "inline-flex",
			justifyContent: "center",
			alignItems: "center",
			cursor: busy || !retryContext ? "default" : "pointer",
			background: "transparent",
			border: "none",
			borderRadius: "50%",
			color: error ? "var(--dsw-alias-state-error-primary, #d92d20)" : "var(--dsw-alias-label-tertiary)",
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
async function waitUntilReplacementHasAssistantContent(session) {
	const hasContent = () => {
		return (session.getSnapshot().nodes ?? []).some((node) => {
			if (node.kind !== "assistant") return false;
			return Array.isArray(node.content) && node.content.length > 0;
		});
	};
	if (hasContent()) return;
	await new Promise((resolve, reject) => {
		let settled = false;
		let unsubscribe;
		let timeout;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			unsubscribe?.();
			clearTimeout(timeout);
			if (error) reject(error);
			else resolve();
		};
		const check = () => {
			if (hasContent()) finish();
		};
		timeout = setTimeout(() => finish(/* @__PURE__ */ new Error("等待新回复超时")), 3e4);
		unsubscribe = session.subscribe?.(check);
		check();
	});
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
exports.inject = inject;
exports.name = name;
return module.exports; } });
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
/** 折叠原始换行，避免短首行在两行 clamp 里遮住后续内容。 */
export declare function flattenPromptText(text: string): string;
interface StuckRowBox {
    key: string;
    top: number;
}
/**
 * 最近一条已滚过视口顶部的用户行；带滞回（PIN/RELEASE）防止样式抖动。
 * currentKey 为当前 pinned key，用于在边缘区间保持粘滞。
 */
export declare function pickPinnedRow(rows: readonly StuckRowBox[], scrollerTop: number, currentKey?: string): string | undefined;
/** 整组用户行 key 全部替换（切换会话/内容重建）时为 true，用于触发静默稳定窗口。 */
export declare function isRowSetReplaced(previous: ReadonlySet<string>, next: ReadonlySet<string>): boolean;
/** 安装：滚动容器级监听 + 一次性 resize/Mutation 刷新。清理返回后 DOM 自净。 */
export declare function installStickyUserRows(isEnabled?: () => boolean, getSessionId?: () => string | undefined): () => void;
/** 在插件 Client ctx 上安装 sticky prompt；返回卸载函数。 */
export declare function applyStickyPrompt(isEnabled?: () => boolean, getSessionId?: () => string | undefined): () => void;
export {};
//# sourceMappingURL=stickyPrompt.d.ts.map
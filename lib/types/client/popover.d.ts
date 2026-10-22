/**
 * 回退模式选择浮层（纯 DOM，无 React）。交互的第二步：目标已固定（被点
 * 的消息）；浮层提供两种模式。选「回退对话和代码」时先经 Connection RPC
 * 取影响清单并展示，确认后才执行。
 *
 * 键盘：↑/↓ 只在当前步的动作按钮间移动，Enter 原生激活焦点按钮，Esc 是
 * 浮层各步 ghost 按钮（取消/返回）的键盘孪生；监听在 document 捕获阶段，
 * 浮层打开期间从 composer 抢走按键。
 *
 * 影响预览走 RPC（dsh-rewind v0.18.0 方案）：不占命令通道、不往会话日志
 * 追加 command/run 事件；执行仍走命令通道（onRewind 回调持有）。
 *
 * Ported from SiriLee/dsh-rewind (MIT), src/client/popover.ts。
 */
import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { PreviewOutcome } from './host-rpc';
import type { ChatOf } from './hidden';
export interface PopoverOptions {
    /** 回退目标消息所在会话 id（RPC 预览用）。 */
    readonly sessionId: string;
    /** 目标消息 seq。 */
    readonly seq: number;
    /** 目标消息时间（展示用；快照未携带时省略）。 */
    readonly time?: number;
    /** 目标消息预览文本。 */
    readonly preview: string;
    /** 打开浮层的按钮（外部点击忽略目标）。 */
    readonly anchor: HTMLElement;
    /**
     * 执行一次回退。浮层先自行关闭；回调持有命令 + composer 回填的完整
     * 生命周期（见 client/index.ts 的 runRewindAndFill）。
     */
    readonly onRewind: (mode: 'chat' | 'both', planId?: string) => void;
}
/** 在按钮 pointerdown 时预取某目标的 preview（无副作用，失败静默）。 */
export declare function prewarmPreview(sessionId: string, seq: number): void;
/** 注册 composer 聚焦通道（client 插件装配时调用一次）。 */
export declare function registerComposerFocuser(focus: (sessionId: string) => void): void;
/** 关闭当前浮层（如有），并把键盘还给其 composer。 */
export declare function closePopover(): void;
/** 等待执行结局时读取 chat 的会话面（sessionId 即可）。 */
type SessionRef = {
    readonly sessionId: string;
};
/**
 * 当前匹配 `match` 的命令节点 seq 集合。在发出同形状新命令前采样，供随后
 * 的等待排除：同一目标的重复 preview/回退必须等本次命令的节点，而不是
 * 落在上一条命令的陈旧结局上。
 */
export declare function knownCommandSeqs(session: SessionRef, chatOf: ChatOf, match: (node: CommandNode) => boolean): Set<number>;
/**
 * 监听会话快照解析最新匹配回退命令的结局（command/run + command/done 落
 * 成一个 CommandNode）。
 * @returns 带结局文本的节点，超时返回 null。
 */
export declare function waitForCommand(session: SessionRef, chatOf: ChatOf, match: (node: CommandNode) => boolean, timeoutMs: number | undefined, watch: (cb: () => void) => () => void): Promise<{
    kind: 'success' | 'error';
    text?: string;
} | null>;
/** 注册/注销预览通道（插件装配与卸载时调用）。 */
export declare function registerPreviewCall(call: ((sessionId: string, seq: number) => Promise<PreviewOutcome>) | null): void;
/** 打开锚定在按钮附近的模式选择浮层。 */
export declare function openPopover(opts: PopoverOptions): void;
export {};
//# sourceMappingURL=popover.d.ts.map
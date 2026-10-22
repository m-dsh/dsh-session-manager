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
import Schema from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { type CleanupSettings } from './snapshot-cleanup';
export declare const name = "dsh-session-manager";
export declare const inject: readonly ["commands", "tools", "settings"];
/**
 * 内部引擎通道：client 的回退按钮/浮层都走它，不占用任何人类可注册的
 * 命令名。与 src/client/hidden.ts 的 ENGINE_COMMAND 镜像——两个 bundle
 * 不共享模块。
 */
export declare const ENGINE_COMMAND = "rewind-plugin";
/** 文件检查点开关的默认值（对齐 Claude Code 的 fileCheckpointingEnabled）。 */
export declare const DEFAULT_FILE_CHECKPOINTING_ENABLED = true;
/** 插件配置：默认值必须写在 schema 里，不能写成普通对象。 */
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    stickyPromptEnabled: Schema<boolean, boolean, "volatile-defined">;
    sessionDeleteEnabled: Schema<boolean, boolean, "volatile-defined">;
    fileCheckpointingEnabled: Schema<boolean, boolean, "volatile-defined">;
    autoCleanupEnabled: Schema<boolean, boolean, "volatile-defined">;
    autoCleanupMaxAgeDays: Schema<number, number, "volatile-defined">;
    snapshotDir: Schema<string, string, "plain">;
    dshHome: Schema<string, string, "plain">;
    dedup: Schema<boolean, boolean, "defined">;
    maxFileBytes: Schema<number, number, "defined">;
    maxAnchorGroups: Schema<number, number, "defined">;
    autoSweepIntervalMs: Schema<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    stickyPromptEnabled: Schema<boolean, boolean, "volatile-defined">;
    sessionDeleteEnabled: Schema<boolean, boolean, "volatile-defined">;
    fileCheckpointingEnabled: Schema<boolean, boolean, "volatile-defined">;
    autoCleanupEnabled: Schema<boolean, boolean, "volatile-defined">;
    autoCleanupMaxAgeDays: Schema<number, number, "volatile-defined">;
    snapshotDir: Schema<string, string, "plain">;
    dshHome: Schema<string, string, "plain">;
    dedup: Schema<boolean, boolean, "defined">;
    maxFileBytes: Schema<number, number, "defined">;
    maxAnchorGroups: Schema<number, number, "defined">;
    autoSweepIntervalMs: Schema<number, number, "defined">;
}>>, "plain">;
export type ConfigType = ReturnType<typeof Config>;
/** apply 收到的已解析配置的形状（volatile 字段解析为 live 引用）。 */
export interface ResolvedConfig extends CleanupSettings {
    readonly snapshotDir?: string;
    readonly dshHome?: string;
    readonly dedup?: boolean;
    readonly maxFileBytes?: number;
    readonly maxAnchorGroups?: number;
    readonly autoSweepIntervalMs?: number;
    readonly fileCheckpointingEnabled: {
        get(): boolean;
    };
}
/**
 * 设置页以此地址引用本插件配置：bundle 的 PROFILE ROW id（包名），
 * 而不是本 fiber 的嵌套 include id。
 */
export declare function profileEntryKey(entryId: string | undefined): string | undefined;
export declare function apply(ctx: Context, config?: ResolvedConfig): void;
//# sourceMappingURL=index.d.ts.map
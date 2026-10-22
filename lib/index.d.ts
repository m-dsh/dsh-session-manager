import Schema from "@deepseek-ai/schemastery";
import { Context, Volatile } from "@deepseek-ai/cordis";

//#region src/snapshot-cleanup.d.ts

/**
 * The live configuration slice the cleanup policy reads: the two schema fields
 * the host resolves into stable references before `apply` runs. The host's
 * `Config` schema (see `src/index.ts`) declares both as `.volatile()`, which is
 * what makes them user-editable in the Plugins page and live-updated without a
 * restart. These are the DOCUMENT's field names; the resolved policy keeps its
 * own ({@link CleanupConfig}), and the adapter below is the one place that maps
 * between the two.
 */
interface CleanupSettings {
  readonly autoCleanupEnabled: Volatile<boolean>;
  readonly autoCleanupMaxAgeDays: Volatile<number>;
}
//#endregion
//#region src/index.d.ts

declare const name = "dsh-session-manager";
declare const inject: readonly ["commands", "tools", "settings"];
/**
 * 内部引擎通道：client 的回退按钮/浮层都走它，不占用任何人类可注册的
 * 命令名。与 src/client/hidden.ts 的 ENGINE_COMMAND 镜像——两个 bundle
 * 不共享模块。
 */
declare const ENGINE_COMMAND = "rewind-plugin";
/** 文件检查点开关的默认值（对齐 Claude Code 的 fileCheckpointingEnabled）。 */
declare const DEFAULT_FILE_CHECKPOINTING_ENABLED = true;
/** 插件配置：默认值必须写在 schema 里，不能写成普通对象。 */
declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
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
type ConfigType = ReturnType<typeof Config>;
/** apply 收到的已解析配置的形状（volatile 字段解析为 live 引用）。 */
interface ResolvedConfig extends CleanupSettings {
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
declare function profileEntryKey(entryId: string | undefined): string | undefined;
declare function apply(ctx: Context, config?: ResolvedConfig): void;
//#endregion
export { Config, ConfigType, DEFAULT_FILE_CHECKPOINTING_ENABLED, ENGINE_COMMAND, ResolvedConfig, apply, inject, name, profileEntryKey };
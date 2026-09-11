import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts

declare const name = "dsh-session-manager";
declare const inject: readonly ["connection", "settings"];
/** 设置 schema：默认开启；默认值必须写在 schema 里，不能写成普通对象。 */
declare const Config: Schema<Schemastery.ObjectS<{
  stickyPromptEnabled: Schema<boolean, boolean>;
  sessionDeleteEnabled: Schema<boolean, boolean>;
}>, Schemastery.ObjectT<{
  stickyPromptEnabled: Schema<boolean, boolean>;
  sessionDeleteEnabled: Schema<boolean, boolean>;
}>>;
type ConfigType = ReturnType<typeof Config>;
interface DshSessions {
  get(id: string): {
    id: string;
    header?: {
      cwd?: string;
      parentSession?: string;
    };
  } | undefined;
}
/** 0.1.2 的会话控制器：fork 改为对象参数，返回 { sessionId }。 */
interface DshSessionController {
  fork(request: {
    sessionId: string;
    atSeq?: number;
    increaseTitle?: boolean;
  }): Promise<{
    sessionId: string;
  }>;
}
interface DshShell {
  /** dsh-shell 契约字段是 `workdir`（不是 cwd）；`stdoutMaxBytes` 保证大输出不截断。 */
  run(spec: {
    command: string;
    workdir?: string;
    timeoutMs?: number;
    stdoutMaxBytes?: number;
  }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}
interface HostConnectionHandle {
  rpc: {
    handle(channel: string, handler: (endpoint: string, payload: unknown) => Promise<{
      ok: boolean;
      value?: unknown;
      error?: unknown;
    }>, opts?: {
      authority?: string;
    }): void;
  };
}
interface HostContext extends Context {
  get(name: 'connection'): HostConnectionHandle | undefined;
  get(name: 'sessions'): DshSessions | undefined;
  get(name: 'sessionController'): DshSessionController | undefined;
  get(name: 'shell'): DshShell | undefined;
}
declare function apply(ctx: HostContext): void;
//#endregion
export { Config, ConfigType, apply, inject, name };
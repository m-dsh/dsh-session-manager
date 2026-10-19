import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts

declare const name = "dsh-session-manager";
declare const inject: readonly ["connection"];
/** 设置 schema：默认开启；默认值必须写在 schema 里，不能写成普通对象。 */
declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
  stickyPromptEnabled: Schema<boolean, boolean, "volatile-defined">;
  sessionDeleteEnabled: Schema<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  stickyPromptEnabled: Schema<boolean, boolean, "volatile-defined">;
  sessionDeleteEnabled: Schema<boolean, boolean, "volatile-defined">;
}>>, "plain">;
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
  fetch: {
    register(route: {
      path: string;
      methods: string[];
      requestBody: string;
      fetch: (request: Request) => Promise<Response>;
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
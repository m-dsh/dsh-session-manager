/**
 * dsh-session-manager Host 入口。
 *
 * 合并两块能力：
 * - 设置命名空间：Web 设置面板的 sticky prompt / 删除会话开关（Client 侧读写）
 * - checkpoint 回滚：会话回滚（sessionController.fork）+ 文件回滚（经校验的执行计划）
 *
 * 文件回滚安全模型：
 * - preview-rollback 只读计算完整执行计划（planId 托管在 Host，含每个文件的期望哈希/存在性）
 * - apply-rollback 只接受 planId，逐文件复核哈希后执行；Client 不得上传任意路径
 * - 删除全局 git restore；git 场景只对 Host 计算出的单路径执行 restore
 * - 精确快照缺失 => 禁止文件回滚
 */
import Schema from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-session-manager";
export declare const inject: readonly ["connection", "webServer"];
/** 设置 schema：默认开启；默认值必须写在 schema 里，不能写成普通对象。 */
export declare const Config: Schema<Schemastery.ObjectS<{
    stickyPromptEnabled: Schema<boolean, boolean>;
    sessionDeleteEnabled: Schema<boolean, boolean>;
}>, Schemastery.ObjectT<{
    stickyPromptEnabled: Schema<boolean, boolean>;
    sessionDeleteEnabled: Schema<boolean, boolean>;
}>>;
export type ConfigType = ReturnType<typeof Config>;
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
export declare function apply(ctx: HostContext): void;
export {};
//# sourceMappingURL=index.d.ts.map
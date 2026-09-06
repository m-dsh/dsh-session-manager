/**
 * Client-only 插件的 Host 入口。
 *
 * 保留空入口是为了让 DSH 能按 package.json 的主入口加载插件；
 * 会话删除和重新生成均由 src/client/index.ts 负责。
 */
export const name = 'dsh-session-manager'

export function apply(): void {
  // UI 功能全部运行在 Client，Host 不注册 Tool，也不持有额外状态。
}

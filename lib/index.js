//#region src/index.ts
/**
* Client-only 插件的 Host 入口。
*
* 保留空入口是为了让 DSH 能按 package.json 的主入口加载插件；
* 会话删除和重新生成均由 src/client/index.ts 负责。
*/
const name = "dsh-session-manager";
function apply() {}

//#endregion
export { apply, name };
/**
 * 设置卡与门控读取（Session 管理）。
 *
 * Host 端导出 Config 由 SettingsForms 自动收集（entry id = dsh-session-manager）；
 * 这里通过 ctx.configForms.get 读写同命名空间，并把开关实时映射到
 * 各功能（顶栏固定最近用户消息 / 会话菜单删除会话）的安装与卸载。
 */
import React from 'react';
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client';
export declare const SETTINGS_NAMESPACE = "dsh-session-manager";
export interface SessionManagerSettings {
    stickyPromptEnabled?: boolean;
    sessionDeleteEnabled?: boolean;
}
/** 开关状态：字段缺省即视为开启（与 Host schema 默认值一致）。 */
export declare function readSettings(snapshot: ConfigFormSnapshot<SessionManagerSettings>): {
    stickyPrompt: boolean;
    sessionDelete: boolean;
};
declare function injectCss(): () => void;
export declare function SessionManagerSection(props: Record<string, unknown>): React.ReactElement;
export { injectCss as injectSettingsCss };
//# sourceMappingURL=settings.d.ts.map
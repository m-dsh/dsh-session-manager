# dsh-session-manager

一个 Client-only DSH 插件，提供两项会话操作：

- 在会话记录菜单的“归档会话”下方添加“删除会话”；
- 在助手消息操作区添加“重新生成”，重新生成当前助手回复，而不是继续发送新的提示词。

删除操作调用宿主公开的 `archiveSession` 能力。DSH 当前没有会话行菜单 Slot，因此菜单按钮使用兼容层插入，并在插件卸载时清理监听器、观察器和动态菜单项。

## 兼容性

- DSH：`>=0.1.1-rc.2`
- Web Client：需要提供 `slots`、`workspaces` 和 `sessions` 注入能力。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build
```

插件包通过 `package.json` 的 `exports["./client"]` 和 `dsh.client` 配置加载 Client bundle；Host 入口仅用于保留标准插件加载契约，不注册 Tool 或其他 Host 状态。

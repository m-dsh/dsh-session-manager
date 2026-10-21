import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { Config, apply, inject, name } from '../src/index'

describe('Host 入口', () => {
  it('导出稳定名称，并声明 connection 依赖', () => {
    expect(name).toBe('dsh-session-manager')
    // connection：经 /api exact Fetch 路由提供 checkpoint 回滚接口。
    expect(inject).toEqual(['connection'])
  })

  it('schema 默认开启两个可实时编辑的功能开关', () => {
    const config = Config({})
    expect(config.stickyPromptEnabled.get()).toBe(true)
    expect(config.sessionDeleteEnabled.get()).toBe(true)
    expect(Config.dict.stickyPromptEnabled.meta.volatile).toBe(true)
    expect(Config.dict.sessionDeleteEnabled.meta.volatile).toBe(true)
  })

  it('不再手动注册设置命名空间（SettingsForms 自动收集导出的 Config）', () => {
    expect(() => apply({ get: () => undefined, on: () => {} } as never)).not.toThrow()
  })

  it('只等待有效的 connection 服务，就绪后激活且无需 webServer', async () => {
    const root = new Context()
    const register = vi.fn(() => async () => {})
    const activate = vi.fn((ctx: Context) => apply(ctx as never))
    try {
      const plugin = root.plugin({ Config, inject, apply: activate })
      await plugin.await()
      expect(plugin.state).toBe(0)
      expect(activate).not.toHaveBeenCalled()

      const provider = root.plugin((ctx: Context) => {
        ctx.provide('connection', { fetch: { register } })
      })
      await provider.await()
      await plugin.await()
      expect(plugin.state).toBe(2)
      expect(activate).toHaveBeenCalledOnce()
      expect(root.get('webServer')).toBeUndefined()
      expect(register).toHaveBeenCalledWith(expect.objectContaining({
        path: '/api/dsh-session-manager', methods: ['POST'], requestBody: 'buffered',
      }))
      expect(plugin.config.stickyPromptEnabled.get()).toBe(true)
      expect(plugin.config.sessionDeleteEnabled.get()).toBe(true)
    } finally {
      await root.fiber.dispose()
    }
  })
})

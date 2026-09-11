import { describe, expect, it, vi } from 'vitest'
import { Config, apply, inject, name } from '../src/index'

describe('Host 入口', () => {
  it('导出稳定名称，并声明 connection + settings 依赖', () => {
    expect(name).toBe('dsh-session-manager')
    // connection：注册 checkpoint 回滚 RPC；settings：注册设置命名空间。
    expect(inject).toEqual(['connection', 'settings'])
  })

  it('schema 默认开启两个功能开关', () => {
    expect(Config({})).toEqual({ stickyPromptEnabled: true, sessionDeleteEnabled: true })
  })

  it('注册 session-manager 设置命名空间，applies 为 live', () => {
    const register = vi.fn()
    const set = vi.fn()

    apply({ settings: { register, set }, get: () => undefined, on: () => {} } as never)

    expect(register).toHaveBeenCalledTimes(1)
    const [namespace, schema, options] = register.mock.calls[0] as [
      unknown,
      (value: unknown) => unknown,
      unknown,
    ]
    expect(namespace).toBe('session-manager')
    expect(schema({})).toEqual({ stickyPromptEnabled: true, sessionDeleteEnabled: true })
    expect(options).toEqual({ applies: 'live' })
  })
})

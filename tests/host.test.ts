import { describe, expect, it, vi } from 'vitest'
import { Config, apply, inject, name } from '../src/index'

describe('Host 入口', () => {
  it('导出稳定名称，并声明 connection 依赖', () => {
    expect(name).toBe('dsh-session-manager')
    // connection：经 /api exact Fetch 路由提供 checkpoint 回滚接口。
    expect(inject).toEqual(['connection'])
  })

  it('schema 默认开启两个功能开关', () => {
    expect(Config({})).toEqual({ stickyPromptEnabled: true, sessionDeleteEnabled: true })
  })

  it('不再手动注册设置命名空间（SettingsForms 自动收集导出的 Config）', () => {
    const register = vi.fn()

    apply({ get: () => undefined, on: () => {} } as never)

    expect(register).not.toHaveBeenCalled()
    // Config 已导出且可实例化，SettingsForms 会按 entry id 收集成表单。
    expect(Config({})).toEqual({ stickyPromptEnabled: true, sessionDeleteEnabled: true })
  })
})

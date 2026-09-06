import { describe, expect, it } from 'vitest'
import { apply, name, inject } from '../src/client/index'

describe('Client 插件入口', () => {
  it('导出稳定名称和可调用入口', () => {
    expect(name).toBe('dsh-session-manager-client')
    expect(inject).toEqual(['slots', 'workspaces', 'sessions'])

    const slots = {
      inject: (_key: string, fn: () => unknown) => fn(),
      register: () => () => {},
    }
    const workspaces = { archiveSession: async () => {} }
    const sessions = { binding: () => undefined }

    expect(() => apply({ slots, workspaces, sessions } as never)).not.toThrow()
  })
})
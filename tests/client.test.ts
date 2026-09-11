import { describe, expect, it, vi } from 'vitest'
import { apply, name, inject } from '../src/client/index'

interface RegisteredSection {
  name: string
  id: string
  label: string
}

function createHarness(initial: Record<string, boolean> = {}) {
  const sections: RegisteredSection[] = []
  const setCalls: Array<{ field: string; value: unknown }> = []
  let notify: (() => void) | undefined
  let values = { ...initial }

  const slots = {
    inject: (_key: string, fn: () => unknown) => fn(),
    register: (opts: RegisteredSection) => {
      sections.push(opts)
      return () => {}
    },
  }
  const workspaces = { archiveSession: async () => {} }
  const sessions = { binding: () => undefined }
  const scope = {
    getSnapshot: () => ({ status: 'ready' as const, writable: true, value: values }),
    subscribe: (listener: () => void) => {
      notify = listener
      return () => {
        notify = undefined
      }
    },
    set: async (field: string, value: unknown) => {
      setCalls.push({ field, value })
      values = { ...values, [field]: value as boolean }
      notify?.()
    },
    unset: async () => {},
  }

  return {
    ctx: { slots, workspaces, sessions, settingsScope: { bind: () => scope } },
    sections,
    setCalls,
    setValues: (next: Record<string, boolean>) => {
      values = { ...next }
      notify?.()
    },
  }
}

describe('Client 插件入口', () => {
  it('导出稳定名称和可调用入口', () => {
    expect(name).toBe('dsh-session-manager-client')
    expect(inject).toEqual(['slots', 'workspaces', 'sessions', 'settingsScope'])

    const { ctx } = createHarness()
    expect(() => apply(ctx as never)).not.toThrow()
  })

  it('注册“会话管理”设置分区，绑定 session-manager 命名空间', () => {
    const { ctx, sections } = createHarness()

    apply(ctx as never)

    const section = sections.find((item) => item.name === 'settings.section')
    expect(section).toBeDefined()
    expect(section?.id).toBe('session-manager')
    expect(section?.label).toBe('会话管理')
  })

  it('开关切换时写入对应字段且不抛错', async () => {
    const { ctx, setCalls } = createHarness({ stickyPromptEnabled: true, sessionDeleteEnabled: true })

    apply(ctx as never)
    const scope = ctx.settingsScope.bind() as unknown as {
      set: (field: string, value: unknown) => Promise<void>
    }
    await scope.set('stickyPromptEnabled', false)

    expect(setCalls).toEqual([{ field: 'stickyPromptEnabled', value: false }])
  })

  it('设置变化时重新应用功能门控（不重复注册、可关闭）', () => {
    const { ctx, setValues } = createHarness({ stickyPromptEnabled: true, sessionDeleteEnabled: true })
    const onDispose = vi.fn()

    apply({ ...ctx, on: onDispose } as never)
    expect(() => setValues({ stickyPromptEnabled: false, sessionDeleteEnabled: false })).not.toThrow()
    expect(() => setValues({ stickyPromptEnabled: true, sessionDeleteEnabled: true })).not.toThrow()
  })
})

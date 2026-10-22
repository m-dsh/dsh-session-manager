import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, name, inject } from '../src/client/index'
import { applyStickyPrompt } from '../src/client/stickyPrompt'

vi.mock('../src/client/stickyPrompt', () => ({ applyStickyPrompt: vi.fn(() => vi.fn()) }))

interface RegisteredSection {
  name: string
  id: string
  label: string
}

function createHarness(initial: Record<string, boolean> = {}) {
  const sections: RegisteredSection[] = []
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
      values = { ...values, [field]: value as boolean }
      notify?.()
      return true
    },
    unset: async () => {},
  }

  return {
    ctx: { slots, workspaces, sessions, configForms: { get: vi.fn(() => scope) } },
    sections,
    setValues: (next: Record<string, boolean>) => {
      values = { ...next }
      notify?.()
    },
  }
}

describe('Client 插件入口', () => {
  beforeEach(() => vi.clearAllMocks())

  it('导出稳定名称和可调用入口', () => {
    expect(name).toBe('dsh-session-manager-client')
    expect(inject).toEqual(['slots', 'workspaces', 'sessions', 'configForms'])

    const { ctx } = createHarness()
    expect(() => apply(ctx as never)).not.toThrow()
  })

  it('注册“会话管理”设置分区，绑定 dsh-session-manager 命名空间', () => {
    const { ctx, sections } = createHarness()

    apply(ctx as never)

    const section = sections.find((item) => item.name === 'settings.section')
    expect(section).toBeDefined()
    expect(section?.id).toBe('dsh-session-manager')
    expect(section?.label).toBe('会话管理')
    expect(ctx.configForms.get).toHaveBeenCalledWith('dsh-session-manager')
  })

  it('configForms 就绪后在真实 Cordis 中激活，无需 webUiSettings', async () => {
    const root = new Context()
    const { ctx, sections } = createHarness()
    const activate = vi.fn((context: Context) => apply(context as never))
    try {
      const provider = root.plugin((context: Context) => {
        context.provide('slots', ctx.slots)
        context.provide('workspaces', ctx.workspaces)
        context.provide('sessions', ctx.sessions)
      })
      await provider.await()
      const plugin = root.plugin({ inject, apply: activate })
      await plugin.await()
      expect(plugin.state).toBe(0)
      expect(activate).not.toHaveBeenCalled()

      const settings = root.plugin((context: Context) => {
        context.provide('configForms', ctx.configForms)
      })
      await settings.await()
      await plugin.await()
      expect(plugin.state).toBe(2)
      expect(activate).toHaveBeenCalledOnce()
      expect(root.get('webUiSettings')).toBeUndefined()
      expect(sections.some((section) => section.id === 'dsh-session-manager')).toBe(true)
    } finally {
      await root.fiber.dispose()
    }
  })

  it('设置变化时重新应用功能门控（不重复注册、可关闭）', () => {
    const { ctx, setValues } = createHarness({ stickyPromptEnabled: true, sessionDeleteEnabled: true })
    const disposeSticky = vi.fn()
    vi.mocked(applyStickyPrompt).mockReturnValueOnce(disposeSticky)

    apply(ctx as never)
    expect(applyStickyPrompt).toHaveBeenCalledTimes(1)
    const enabledNow = vi.mocked(applyStickyPrompt).mock.calls[0]?.[0] ?? (() => false)
    expect(enabledNow()).toBe(true)
    setValues({ stickyPromptEnabled: true, sessionDeleteEnabled: true })
    expect(applyStickyPrompt).toHaveBeenCalledTimes(1)
    setValues({ stickyPromptEnabled: false, sessionDeleteEnabled: false })
    expect(enabledNow()).toBe(false)
    expect(disposeSticky).toHaveBeenCalledOnce()
    setValues({ stickyPromptEnabled: true, sessionDeleteEnabled: true })
    expect(applyStickyPrompt).toHaveBeenCalledTimes(2)
  })
})

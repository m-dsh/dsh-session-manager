import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { Config, apply, ENGINE_COMMAND, inject, name } from '../src/index'
import { DEFAULT_MAX_FILE_BYTES, MAX_ANCHOR_GROUPS } from '../src/snapshot'
import { AUTO_SWEEP_INTERVAL_MS, DEFAULT_CLEANUP_CONFIG } from '../src/snapshot-cleanup'

describe('Host 入口', () => {
  it('导出稳定名称，并声明 commands/tools/settings 依赖', () => {
    expect(name).toBe('dsh-session-manager')
    // 回退命令走 commands 服务注册；tools 事件承载写前备份；settings
    // 读写清理策略与语言偏好。
    expect(inject).toEqual(['commands', 'tools', 'settings'])
    expect(ENGINE_COMMAND).toBe('rewind-plugin')
  })

  it('schema 声明全部功能开关与回退存储参数，默认值可实时编辑', () => {
    const config = Config({})
    expect(config.stickyPromptEnabled.get()).toBe(true)
    expect(config.sessionDeleteEnabled.get()).toBe(true)
    expect(config.fileCheckpointingEnabled.get()).toBe(true)
    expect(config.autoCleanupEnabled.get()).toBe(DEFAULT_CLEANUP_CONFIG.enabled)
    expect(config.autoCleanupMaxAgeDays.get()).toBe(DEFAULT_CLEANUP_CONFIG.maxAgeDays)
    expect(config.dedup).toBe(true)
    expect(config.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES)
    expect(config.maxAnchorGroups).toBe(MAX_ANCHOR_GROUPS)
    expect(config.autoSweepIntervalMs).toBe(AUTO_SWEEP_INTERVAL_MS)
    for (const field of ['stickyPromptEnabled', 'sessionDeleteEnabled', 'fileCheckpointingEnabled', 'autoCleanupEnabled', 'autoCleanupMaxAgeDays']) {
      expect(Config.dict?.[field].meta.volatile).toBe(true)
    }
    // 回退存储参数的合法域：0 关闭单文件上限；组数必须 >= 1。
    expect(Config({ maxFileBytes: 0, maxAnchorGroups: 1 } as never).maxFileBytes).toBe(0)
    for (const value of [-1, 1.5, Number.NaN]) {
      expect(() => Config({ maxFileBytes: value } as never)).toThrow()
      expect(() => Config({ maxAnchorGroups: value } as never)).toThrow()
      expect(() => Config({ autoSweepIntervalMs: value } as never)).toThrow()
    }
    for (const value of [0, -1, 2.5, Number.NaN]) {
      expect(() => Config({ autoCleanupMaxAgeDays: value } as never)).toThrow()
    }
    expect(() => Config({ fileCheckpointingEnabled: 'yes' } as never)).toThrow()
    expect(() => Config({ autoCleanupEnabled: 'yes' } as never)).toThrow()
  })

  it('命令服务就绪后注册四个命令；缺席时静默降级不阻塞', async () => {
    const root = new Context()
    const registered: Record<string, unknown>[] = []
    const activate = vi.fn((ctx: Context) => apply(ctx as never, Config({}) as never))
    try {
      const plugin = root.plugin({ Config, inject, apply: activate })
      await plugin.await()
      expect(plugin.state).toBe(0)
      expect(activate).not.toHaveBeenCalled()

      const provider = root.plugin((ctx: Context) => {
        ctx.provide('commands', {
          register: (def: Record<string, unknown>) => {
            registered.push(def)
            return () => {
              const index = registered.indexOf(def)
              if (index >= 0) registered.splice(index, 1)
            }
          },
        })
        ctx.provide('tools', {})
        ctx.provide('settings', { describe: () => [], update: async () => {}, mutate: async () => {} })
      })
      await provider.await()
      await plugin.await()
      expect(plugin.state).toBe(2)
      expect(activate).toHaveBeenCalledOnce()
      expect(registered.map(def => def.name)).toEqual([
        'rewind',
        'undo',
        ENGINE_COMMAND,
        'snapshot-auto-cleanup',
      ])
      expect(plugin.config.stickyPromptEnabled.get()).toBe(true)
    } finally {
      await root.fiber.dispose()
      expect(registered).toEqual([])
    }
  })

  it('一个命令名被占用只损失那个名字，其余照常注册', async () => {
    const root = new Context()
    const registered: Record<string, unknown>[] = []
    const activate = vi.fn((ctx: Context) => apply(ctx as never, Config({}) as never))
    try {
      const provider = root.plugin((ctx: Context) => {
        ctx.provide('commands', {
          register: (def: Record<string, unknown>) => {
            if (def.name === 'rewind') throw new Error('duplicate command name')
            registered.push(def)
            return () => {
              const index = registered.indexOf(def)
              if (index >= 0) registered.splice(index, 1)
            }
          },
        })
        ctx.provide('tools', {})
        ctx.provide('settings', { describe: () => [], update: async () => {}, mutate: async () => {} })
      })
      await provider.await()
      const plugin = root.plugin({ Config, inject, apply: activate })
      await plugin.await()
      expect(activate).toHaveBeenCalledOnce()
      expect(registered.map(def => def.name)).toEqual([
        'undo',
        ENGINE_COMMAND,
        'snapshot-auto-cleanup',
      ])
    } finally {
      await root.fiber.dispose()
    }
  })
})
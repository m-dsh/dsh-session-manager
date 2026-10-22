import React from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readSettings, SessionManagerSection, type SessionManagerSettings } from '../src/client/settings'

const { stateChanged } = vi.hoisted(() => ({ stateChanged: vi.fn() }))

vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useEffect: () => {},
    useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, stateChanged],
  }
})

function createForm(overrides: Partial<ConfigFormSnapshot<SessionManagerSettings>> = {}) {
  const snapshot: ConfigFormSnapshot<SessionManagerSettings> = {
    status: 'ready', value: { stickyPromptEnabled: true, sessionDeleteEnabled: false },
    writable: true, revision: 0, base: {}, user: {}, ...overrides,
  }
  const form: ConfigForm<SessionManagerSettings> = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: vi.fn(async () => true),
    unset: vi.fn(async () => true),
    mutate: vi.fn(async () => true),
  }
  return { form, snapshot }
}

function render(form: ConfigForm<SessionManagerSettings>) {
  const tree = SessionManagerSection({ scope: form })
  const [card, note] = React.Children.toArray(tree.props.children) as React.ReactElement[]
  const rows = React.Children.toArray(card.props.children) as React.ReactElement[]
  return { rows, note: note.props.children }
}

describe('会话管理设置卡', () => {
  beforeEach(() => stateChanged.mockClear())

  it('根据 Host 值显示开关，点击后写入对应字段', async () => {
    const { form } = createForm()
    const { rows } = render(form)
    expect(rows[0].props.checked).toBe(true)
    expect(rows[1].props.checked).toBe(false)
    rows[0].props.onChange()
    await vi.waitFor(() => expect(form.set).toHaveBeenCalledWith('stickyPromptEnabled', false))
    expect(stateChanged).not.toHaveBeenCalledWith(expect.any(String))
  })

  it('保留关闭值并在缺省时使用默认开启值', () => {
    const { snapshot } = createForm()
    expect(readSettings(snapshot)).toEqual({ stickyPrompt: true, sessionDelete: false })
    expect(readSettings({ ...snapshot, value: {} })).toEqual({ stickyPrompt: true, sessionDelete: true })
  })

  it.each([true, false])('开关保留原生按钮语义并固定滑块圆角：checked=%s', (checked) => {
    const { form } = createForm({ value: { stickyPromptEnabled: checked }, writable: false })
    const row = render(form).rows[0]
    const renderComponent = (element: React.ReactElement): React.ReactElement =>
      (element.type as (props: unknown) => React.ReactElement)(element.props)
    const rowElement = renderComponent(row)
    const toggle = React.Children.toArray(rowElement.props.children)[1] as React.ReactElement
    const button = renderComponent(toggle)
    expect(button.type).toBe('button')
    expect(button.props).toMatchObject({
      type: 'button', role: 'switch', 'aria-checked': checked,
      'aria-label': '提示词悬浮', disabled: true,
      style: { borderRadius: 999, alignItems: 'center', width: 36, height: 20, padding: 2, border: 0 },
    })
    expect(button.props.children.props).toMatchObject({
      className: 'dsmgr_knob',
      style: { borderRadius: '50%', width: 16, height: 16, flexShrink: 0, transform: `translateX(${checked ? 16 : 0}px)` },
    })
  })

  it.each([
    { status: 'loading' as const, text: '正在读取设置' },
    { status: 'unavailable' as const, text: 'Host 已加载兼容' },
  ])('禁用 $status 状态并显示对应提示', ({ status, text }) => {
    const { form } = createForm({ status, writable: false, value: undefined })
    const { rows, note } = render(form)
    expect(rows.every((row) => row.props.disabled)).toBe(true)
    expect(note).toContain(text)
    expect(note).not.toContain('Host 端未注册')
  })

  it.each([false, new Error('connection lost')])('报告 Host 拒绝或传输失败：%s', async (result) => {
    const { form } = createForm()
    if (result instanceof Error) vi.mocked(form.set).mockRejectedValueOnce(result)
    else vi.mocked(form.set).mockResolvedValueOnce(result)
    render(form).rows[0].props.onChange()
    await vi.waitFor(() => expect(stateChanged).toHaveBeenCalledWith(
      result instanceof Error ? '设置保存失败，请检查连接后重试。' : '设置未保存，请根据最新状态重试。',
    ))
  })
})

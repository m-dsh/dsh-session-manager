/**
 * 设置卡与门控读取（Session 管理）。
 *
 * Host 端在 src/index.ts 注册 settingsNamespace('session-manager')；
 * 这里通过 ctx.settingsScope.bind 读写同命名空间，并把开关实时映射到
 * 各功能（顶栏固定最近用户消息 / 会话菜单删除会话）的安装与卸载。
 */

import React, { useEffect, useState } from 'react'

export const SETTINGS_NAMESPACE = 'session-manager'

export interface SessionManagerSettings {
  stickyPromptEnabled?: boolean
  sessionDeleteEnabled?: boolean
}

export interface SettingsScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value?: T
  writable?: boolean
}

export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** 开关状态：字段缺省即视为开启（与 Host schema 默认值一致）。 */
export function readSettings(snapshot: SettingsScopeSnapshot<SessionManagerSettings>): {
  stickyPrompt: boolean
  sessionDelete: boolean
} {
  const value = snapshot.value ?? {}
  return {
    stickyPrompt: value.stickyPromptEnabled !== false,
    sessionDelete: value.sessionDeleteEnabled !== false,
  }
}

// ── CSS ────────────────────────────────────────────────────────

const CSS_ATTR = 'data-dsmgr-css'

function injectCss(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const previous = document.querySelector(`style[${CSS_ATTR}]`)
  const tag = previous instanceof HTMLStyleElement ? previous : document.createElement('style')
  tag.setAttribute(CSS_ATTR, '1')
  tag.textContent = [
    '.dsmgr_card{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
    '.dsmgr_row{display:flex;align-items:center;gap:12px;padding:12px 14px}',
    '.dsmgr_row+.dsmgr_row{border-top:1px solid var(--dsw-alias-border-l2)}',
    '.dsmgr_rowText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
    '.dsmgr_rowTitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
    '.dsmgr_rowDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
    '.dsmgr_toggle{flex:none;appearance:none;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);cursor:pointer;border-radius:999px;width:40px;height:22px;padding:2px;transition:background .12s,border-color .12s;display:inline-flex;position:relative}',
    '.dsmgr_toggle[aria-checked=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}',
    '.dsmgr_toggle:disabled{opacity:.4;cursor:default}',
    '.dsmgr_toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
    '.dsmgr_knob{background:var(--dsw-alias-label-primary-foreground,#fff);width:18px;height:18px;box-shadow:0 0 0 1px var(--dsw-alias-border-l4,#0f172a1f);border-radius:50%;transition:transform .12s;display:block;transform:translate(0)}',
    '.dsmgr_toggle[aria-checked=true] .dsmgr_knob{transform:translate(18px)}',
    '.dsmgr_note{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  ].join('')
  if (previous === null) document.head.appendChild(tag)
  return () => tag.remove()
}

// ── 组件 ───────────────────────────────────────────────────────

function ToggleSwitch(props: {
  checked: boolean
  disabled: boolean
  label: string
  onChange: () => void
}): React.ReactElement {
  return React.createElement(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': props.checked,
      'aria-label': props.label,
      disabled: props.disabled,
      className: 'dsmgr_toggle',
      onClick: props.onChange,
    },
    React.createElement('span', { className: 'dsmgr_knob' }),
  )
}

function SettingsRow(props: {
  title: string
  description: string
  checked: boolean
  disabled: boolean
  onChange: () => void
}): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'dsmgr_row' },
    React.createElement(
      'div',
      { className: 'dsmgr_rowText' },
      React.createElement('div', { className: 'dsmgr_rowTitle' }, props.title),
      React.createElement('div', { className: 'dsmgr_rowDesc' }, props.description),
    ),
    React.createElement(ToggleSwitch, {
      checked: props.checked,
      disabled: props.disabled,
      label: props.title,
      onChange: props.onChange,
    }),
  )
}

interface SectionProps {
  scope: SettingsScope<SessionManagerSettings>
}

export function SessionManagerSection(props: Record<string, unknown>): React.ReactElement {
  const { scope } = props as unknown as SectionProps
  const [snapshot, setSnapshot] = useState<SettingsScopeSnapshot<SessionManagerSettings>>(() =>
    scope.getSnapshot(),
  )

  useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope])

  const settings = readSettings(snapshot)
  const ready = snapshot.status === 'ready'
  const writable = ready && snapshot.writable === true

  const row = (
    title: string,
    description: string,
    checked: boolean,
    field: keyof SessionManagerSettings,
  ): React.ReactElement =>
    React.createElement(SettingsRow, {
      title,
      description,
      checked,
      disabled: !writable,
      onChange: () => {
        void scope.set(field, !checked)
      },
    })

  const note =
    snapshot.status === 'loading'
      ? '正在读取设置…'
      : snapshot.status === 'unavailable'
        ? '设置暂时不可用：Host 端未注册 session-manager 命名空间。'
        : snapshot.writable === false
          ? '当前设置只读（由上层配置下发）。'
          : '修改立即生效，无需重启。'

  return React.createElement(
    'div',
    null,
    React.createElement(
      'div',
      { className: 'dsmgr_card' },
      row(
        '提示词悬浮',
        '滚动长回复时，把最近一条滚出视口顶部的用户消息固定在会话顶部，点击可跳回原消息。',
        settings.stickyPrompt,
        'stickyPromptEnabled',
      ),
      row(
        '删除会话',
        '在会话记录的下拉菜单中，于“归档会话”下方添加“删除会话”。',
        settings.sessionDelete,
        'sessionDeleteEnabled',
      ),
    ),
    React.createElement('div', { className: 'dsmgr_note' }, note),
  )
}

export { injectCss as injectSettingsCss }

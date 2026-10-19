/**
 * 设置卡与门控读取（Session 管理）。
 *
 * Host 端导出 Config 由 SettingsForms 自动收集（entry id = dsh-session-manager）；
 * 这里通过 ctx.configForms.get 读写同命名空间，并把开关实时映射到
 * 各功能（顶栏固定最近用户消息 / 会话菜单删除会话）的安装与卸载。
 */

import React, { useEffect, useState } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

export const SETTINGS_NAMESPACE = 'dsh-session-manager'

export interface SessionManagerSettings {
  stickyPromptEnabled?: boolean
  sessionDeleteEnabled?: boolean
}

/** 开关状态：字段缺省即视为开启（与 Host schema 默认值一致）。 */
export function readSettings(snapshot: ConfigFormSnapshot<SessionManagerSettings>): {
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
    '.dsmgr_card .dsmgr_toggle{appearance:none;background:var(--dsw-alias-bg-layer-3);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3);cursor:pointer;transition:background .12s}',
    '.dsmgr_card .dsmgr_toggle[aria-checked=true]{background:var(--dsw-alias-brand-primary);box-shadow:none}',
    '.dsmgr_card .dsmgr_toggle:disabled{opacity:.4;cursor:default}',
    '.dsmgr_card .dsmgr_toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
    '.dsmgr_card .dsmgr_knob{background:var(--dsw-alias-label-primary-foreground,#fff);box-shadow:0 0 0 1px var(--dsw-alias-border-l4,#0f172a1f);transition:transform .12s}',
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
      style: {
        boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'flex-start', flex: '0 0 40px', width: 40, height: 22,
        padding: 2, margin: 0, border: 0, borderRadius: 999,
      },
      onClick: props.onChange,
    },
    React.createElement('span', {
      className: 'dsmgr_knob',
      style: {
        boxSizing: 'border-box', display: 'block', flexShrink: 0,
        width: 18, height: 18, margin: 0, padding: 0, border: 0, borderRadius: '50%',
        transform: `translateX(${props.checked ? 18 : 0}px)`,
      },
    }),
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
  scope: ConfigForm<SessionManagerSettings>
}

export function SessionManagerSection(props: Record<string, unknown>): React.ReactElement {
  const { scope } = props as unknown as SectionProps
  const [snapshot, setSnapshot] = useState<ConfigFormSnapshot<SessionManagerSettings>>(() =>
    scope.getSnapshot(),
  )
  const [writeError, setWriteError] = useState<string | undefined>()

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
        setWriteError(undefined)
        void scope.set(field, !checked).then(
          (accepted) => {
            if (!accepted) setWriteError('设置未保存，请根据最新状态重试。')
          },
          () => setWriteError('设置保存失败，请检查连接后重试。'),
        )
      },
    })

  const note =
    snapshot.status === 'loading'
      ? '正在读取设置…'
      : snapshot.status === 'unavailable'
        ? snapshot.mode === 'memory'
          ? '当前连接不支持保存设置，请在 DSH 所在电脑通过 localhost 打开设置。'
          : '设置暂时不可用，请确认 Host 已加载兼容的 dsh-session-manager 插件，并刷新页面。'
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
    React.createElement('div', { className: 'dsmgr_note', role: writeError ? 'alert' : undefined }, writeError ?? note),
  )
}

export { injectCss as injectSettingsCss }

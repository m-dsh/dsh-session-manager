/**
 * 回退按钮与模式浮层的样式类 + 注入 CSS（沿用 --dsw-* 设计令牌，
 * 与宿主菜单视觉一致）。样式由 client 入口的 ensureRewindStyle 注入。
 *
 * Ported from SiriLee/dsh-rewind (MIT), src/client/styles.ts（去掉与本插件
 * 无关的部分，类名换成 dsmgr- 前缀）。
 */

export const CLASS = {
  button: 'dsmgr-rewind-btn',
  popover: 'dsmgr-rewind-popover',
  popoverTitle: 'dsmgr-rewind-popover-title',
  popoverTarget: 'dsmgr-rewind-popover-target',
  popoverOption: 'dsmgr-rewind-popover-option',
  popoverOptionLabel: 'dsmgr-rewind-popover-option-label',
  popoverOptionHint: 'dsmgr-rewind-popover-option-hint',
  popoverImpact: 'dsmgr-rewind-popover-impact',
  popoverNote: 'dsmgr-rewind-popover-note',
  popoverActions: 'dsmgr-rewind-popover-actions',
  popoverPrimary: 'dsmgr-rewind-popover-primary',
  popoverGhost: 'dsmgr-rewind-popover-ghost',
} as const

/**
 * The ↶ glyph, drawn inline so the bundle stays dependency-free.
 *
 * Size follows the product-icon set (15px, as the neighbouring copy/branch
 * actions). Stroke 1.25: ↶ is a single open stroke next to dense outline
 * glyphs, so at 1 it reads thinned out.
 */
export const REWIND_ICON_SVG = [
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">',
  '  <path d="M6.5 2.5 2.5 6.5l4 4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>',
  '  <path d="M2.5 6.5h7a4 4 0 0 1 4 4v1.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>',
  '</svg>',
].join('')

/** 浮层与按钮样式（scoped under `.dsmgr-rewind-*`）。 */
/** The ✎ glyph:与 ↶ 同一套视觉参数(15px、描边 1.25、圆角端点)。 */
export const EDIT_ICON_SVG = [
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">',
  '  <path d="M11.3 2.6a1.5 1.5 0 0 1 2.1 2.1L5.2 12.9l-2.8.7.7-2.8 8.2-8.2z" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('')

export const REWIND_STYLE = `
/* 行内编辑态:该用户行只显示编辑器,其余内容(气泡/操作行)隐藏。 */
[data-chat-flow-kind="user"][data-dsh-editing="true"] > :not([data-dsh-edit-editor]) {
  display: none !important;
}
.dsmgr-rewind-popover {
  position: fixed;
  z-index: 1000;
  width: 288px;
  padding: 12px;
  /* 材质对齐宿主 overlay（dsh-rewind v0.18.0）：elevation 描边 + 阴影 +
     背景 backdrop 隔离，替代中性边框。 */
  border: 0;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  isolation: isolate;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3));
  font-size: 14px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dsmgr-rewind-popover-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}
.dsmgr-rewind-popover-target {
  margin: 4px 0 10px;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  word-break: break-all;
}
.dsmgr-rewind-popover-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  margin: 0 0 6px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsmgr-rewind-popover-option:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
/* 方向键移动真实焦点，焦点行携带指针填充、抑制浏览器圈环（暗色模式下
   双色圈环会在填充行上读作残边）。 */
.dsmgr-rewind-popover-option:focus-visible:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  outline: none;
}
.dsmgr-rewind-popover-option:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsmgr-rewind-popover-option-label {
  font-weight: 500;
}
.dsmgr-rewind-popover-option-hint {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsmgr-rewind-popover-impact {
  margin: 4px 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  max-height: 160px;
  overflow: auto;
}
.dsmgr-rewind-popover-note {
  margin-top: 6px;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-tertiary);
}
.dsmgr-rewind-popover-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dsmgr-rewind-popover-primary,
.dsmgr-rewind-popover-ghost {
  padding: 5px 12px;
  border: none;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
}
.dsmgr-rewind-popover-primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dsmgr-rewind-popover-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}
.dsmgr-rewind-popover-primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsmgr-rewind-popover-ghost {
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.dsmgr-rewind-popover-ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
`
/**
 * 回退按钮与模式浮层的样式类 + 注入 CSS（沿用 --dsw-* 设计令牌，
 * 与宿主菜单视觉一致）。样式由 client 入口的 ensureRewindStyle 注入。
 *
 * Ported from SiriLee/dsh-rewind (MIT), src/client/styles.ts（去掉与本插件
 * 无关的部分，类名换成 dsmgr- 前缀）。
 */
export declare const CLASS: {
    readonly button: "dsmgr-rewind-btn";
    readonly popover: "dsmgr-rewind-popover";
    readonly popoverTitle: "dsmgr-rewind-popover-title";
    readonly popoverTarget: "dsmgr-rewind-popover-target";
    readonly popoverOption: "dsmgr-rewind-popover-option";
    readonly popoverOptionLabel: "dsmgr-rewind-popover-option-label";
    readonly popoverOptionHint: "dsmgr-rewind-popover-option-hint";
    readonly popoverImpact: "dsmgr-rewind-popover-impact";
    readonly popoverNote: "dsmgr-rewind-popover-note";
    readonly popoverActions: "dsmgr-rewind-popover-actions";
    readonly popoverPrimary: "dsmgr-rewind-popover-primary";
    readonly popoverGhost: "dsmgr-rewind-popover-ghost";
};
/**
 * The ↶ glyph, drawn inline so the bundle stays dependency-free.
 *
 * Size follows the product-icon set (15px, as the neighbouring copy/branch
 * actions). Stroke 1.25: ↶ is a single open stroke next to dense outline
 * glyphs, so at 1 it reads thinned out.
 */
export declare const REWIND_ICON_SVG: string;
/** 浮层与按钮样式（scoped under `.dsmgr-rewind-*`）。 */
/** The ✎ glyph:与 ↶ 同一套视觉参数(15px、描边 1.25、圆角端点)。 */
export declare const EDIT_ICON_SVG: string;
export declare const REWIND_STYLE = "\n/* \u884C\u5185\u7F16\u8F91\u6001:\u8BE5\u7528\u6237\u884C\u53EA\u663E\u793A\u7F16\u8F91\u5668,\u5176\u4F59\u5185\u5BB9(\u6C14\u6CE1/\u64CD\u4F5C\u884C)\u9690\u85CF\u3002 */\n[data-chat-flow-kind=\"user\"][data-dsh-editing=\"true\"] > :not([data-dsh-edit-editor]) {\n  display: none !important;\n}\n.dsmgr-rewind-popover {\n  position: fixed;\n  z-index: 1000;\n  width: 288px;\n  padding: 12px;\n  /* \u6750\u8D28\u5BF9\u9F50\u5BBF\u4E3B overlay\uFF08dsh-rewind v0.18.0\uFF09\uFF1Aelevation \u63CF\u8FB9 + \u9634\u5F71 +\n     \u80CC\u666F backdrop \u9694\u79BB\uFF0C\u66FF\u4EE3\u4E2D\u6027\u8FB9\u6846\u3002 */\n  border: 0;\n  border-radius: var(--dsw-radius-md, 12px);\n  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));\n  backdrop-filter: var(--dsw-menu-backdrop-filter);\n  isolation: isolate;\n  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);\n  box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3));\n  font-size: 14px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-primary);\n}\n.dsmgr-rewind-popover-title {\n  font-size: 14px;\n  font-weight: 600;\n  line-height: 20px;\n}\n.dsmgr-rewind-popover-target {\n  margin: 4px 0 10px;\n  font-size: 12px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-tertiary);\n  word-break: break-all;\n}\n.dsmgr-rewind-popover-option {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  width: 100%;\n  margin: 0 0 6px;\n  padding: 8px 10px;\n  border: 1px solid transparent;\n  border-radius: 8px;\n  background: transparent;\n  color: inherit;\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n}\n.dsmgr-rewind-popover-option:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n/* \u65B9\u5411\u952E\u79FB\u52A8\u771F\u5B9E\u7126\u70B9\uFF0C\u7126\u70B9\u884C\u643A\u5E26\u6307\u9488\u586B\u5145\u3001\u6291\u5236\u6D4F\u89C8\u5668\u5708\u73AF\uFF08\u6697\u8272\u6A21\u5F0F\u4E0B\n   \u53CC\u8272\u5708\u73AF\u4F1A\u5728\u586B\u5145\u884C\u4E0A\u8BFB\u4F5C\u6B8B\u8FB9\uFF09\u3002 */\n.dsmgr-rewind-popover-option:focus-visible:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover);\n  outline: none;\n}\n.dsmgr-rewind-popover-option:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n.dsmgr-rewind-popover-option-label {\n  font-weight: 500;\n}\n.dsmgr-rewind-popover-option-hint {\n  font-size: 12px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-tertiary);\n}\n.dsmgr-rewind-popover-impact {\n  margin: 4px 0 10px;\n  padding: 8px 10px;\n  border-radius: 8px;\n  background: var(--dsw-alias-interactive-bg-hover);\n  font-size: 12px;\n  line-height: 16px;\n  color: var(--dsw-alias-label-secondary);\n  white-space: pre-wrap;\n  max-height: 160px;\n  overflow: auto;\n}\n.dsmgr-rewind-popover-note {\n  margin-top: 6px;\n  font-size: 11px;\n  line-height: 15px;\n  color: var(--dsw-alias-label-tertiary);\n}\n.dsmgr-rewind-popover-actions {\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n}\n.dsmgr-rewind-popover-primary,\n.dsmgr-rewind-popover-ghost {\n  padding: 5px 12px;\n  border: none;\n  border-radius: 8px;\n  font: inherit;\n  font-size: 13px;\n  line-height: 18px;\n  cursor: pointer;\n}\n.dsmgr-rewind-popover-primary {\n  background: var(--dsw-alias-button-primary-fill);\n  color: var(--dsw-alias-label-primary-foreground);\n}\n.dsmgr-rewind-popover-primary:hover:not(:disabled) {\n  background: var(--dsw-alias-button-primary-hover);\n}\n.dsmgr-rewind-popover-primary:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n.dsmgr-rewind-popover-ghost {\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n}\n.dsmgr-rewind-popover-ghost:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n";
//# sourceMappingURL=styles.d.ts.map
/**
 * Host-side copy for dsh-session-manager's rewind command output and command
 * description. Chinese only (this plugin ships zh only); the en table stays
 * as the key-set source of truth.
 *
 * Ported from SiriLee/dsh-rewind (MIT), src/locales.ts.
 *
 * Architecture (matches the dsh ecosystem): the HOST half of a dual-face
 * plugin has no locale service — only the browser client carries one. The host
 * therefore renders its command-adjacent copy from the durable user preference
 * dsh-client-locale persists, defaulting to English — the ecosystem's neutral
 * default language (the harness `FALLBACK_LOCALE`). See packages/client/locale
 * in deepseek-harness.
 *
 * DSH 0.1.7 moved that preference out of a registered settings section into the
 * `locale` entry's own Config, so the host reads it through the settings
 * service's descriptor read (`readHostLocale` in `src/index.ts`) — the same
 * public read the settings UI and the client's own locale runtime perform.
 *
 * The client half (`src/client/locales.ts`) owns all interactive UI copy via
 * `ctx.locale` + `t()`; the host's human text is a machine channel the client
 * renders through machine tokens (`impact=<n>`, `args` @seq), never by parsing
 * host prose.
 *
 * DSH localizes only its OWN command descriptions via the client locale — a
 * closed `HOST_FACES` allowlist; third-party plugin descriptions are
 * not in that channel (see docs/compat/audit.md, RU-I18N), and no host command
 * OUTPUT is localized for anyone, so this dictionary is what carries it.
 *
 * English is the key-set source of truth; zh is checked complete against it.
 *
 * @module dsh-session-manager/locales
 */
/** Host-side supported locale ids, mirroring the harness's shipped locales. */
export type HostLocaleId = 'zh' | 'en';
/**
 * The locale a durable preference selects from this plugin's dictionaries.
 *
 * The harness accepts any BCP 47-style id while this plugin ships only `zh` and
 * `en`, so the PRIMARY subtag decides (`zh-CN` → zh) and everything else — an
 * unset preference, an unsupported language, a non-string value — is English.
 * The client's own selection tries the full tag before the primary subtag; over
 * these two dictionaries the outcome is the same.
 *
 * @param preference - the raw `locale.preference` value.
 * @returns the dictionary this plugin renders its host copy in.
 */
export declare function preferredLocale(preference: unknown): HostLocaleId;
/** English dictionary — the key-set source of truth (neutral default). */
export declare const en: {
    'plan.rewinding': string;
    'plan.affects': string;
    'plan.restore': string;
    'plan.delete': string;
    'plan.noChanges': string;
    'plan.backupOff': string;
    'plan.skip': string;
    'skipReason.oversized': string;
    'uncovered.header': string;
    'error.invalidTarget': string;
    'conflict.drifted': string;
    'sep.list': string;
    'sep.clause': string;
    'failures.suffix': string;
    'failures.item': string;
    inflight: string;
    stopFailed: string;
    cancelled: string;
    failed: string;
    'restore.count': string;
    'delete.count': string;
    'skip.count': string;
    noRestorable: string;
    backupOff: string;
    storeUnsupported: string;
    success: string;
    noUserMessages: string;
    'command.description': string;
    'command.undoDescription': string;
    'engine.description': string;
    'engine.rejected': string;
    'engine.inputHint': string;
    'cleanup.description': string;
    'cleanup.inputHint': string;
    'cleanup.status': string;
    'cleanup.enabled': string;
    'cleanup.disabled': string;
    'cleanup.onOk': string;
    'cleanup.offOk': string;
    'cleanup.maxAgeOk': string;
    'cleanup.cfgInvalid': string;
    'cleanup.saveFailed': string;
    'cleanup.runDry': string;
    'cleanup.runApply': string;
    'cleanup.runFailed': string;
    'cleanup.skipped': string;
    'cleanup.clearDry': string;
    'cleanup.clearApply': string;
    'cleanup.clearActive': string;
    'cleanup.clearCancelled': string;
    'cleanup.clearFailed': string;
    'cleanup.usage': string;
};
/** The host rewind dictionary key union. */
export type HostKey = keyof typeof en;
/** Chinese dictionary, checked complete against the en key set. */
export declare const zh: Record<HostKey, string>;
/** The host dictionaries keyed by locale id. */
export declare const HOST_DICTS: Record<HostLocaleId, Record<HostKey, string>>;
/**
 * Render one dictionary key with `{name}` template interpolation. Unknown
 * params are ignored; a missing key falls back to the raw key so a dictionary
 * gap is visible instead of blank.
 * @param lang - the active locale.
 * @param key - the dictionary key.
 * @param params - `{name}` substitution values.
 */
export declare function translate(lang: HostLocaleId, key: HostKey, params?: Record<string, string | number>): string;
//# sourceMappingURL=locales.d.ts.map
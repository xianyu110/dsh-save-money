/**
 * dsh-save-money — i18n index: dictionary aggregation + language helpers.
 *
 * Each locale lives in its own file (i18n/zh.ts, i18n/en.ts, …) exporting a
 * Dict; this module merges them and provides detectLang / resolveLang / t().
 * Inlined into the Client plugin body at build time (scripts/build.js) — the
 * locale modules are transpiled and concatenated BEFORE this file, so the
 * dictionaries below resolve as same-scope consts (no ESM imports survive the
 * inline pass).
 */

// Locale dictionaries are inlined ahead of this file by scripts/build.js;
// declare them here so this module type-checks standalone.
declare const zh: Dict
declare const en: Dict
declare const de: Dict
declare const fr: Dict
declare const es: Dict
declare const it: Dict
declare const pt: Dict
declare const ja: Dict
declare const ko: Dict
declare const zhTW: Dict

// Types declared locally (the locale files import them from types.ts; the
// inline pass concatenates everything into one scope, so these resolve).
declare type Lang = 'zh' | 'zh-TW' | 'en' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'ja' | 'ko'
interface Dict {
  [key: string]: string
}

export const I18N: Record<Lang, Dict> = { zh, 'zh-TW': zhTW, en, de, fr, es, it, pt, ja, ko }

declare const navigator: { language?: string } | undefined

/** Detect the browser locale (zh* → zh / zh-TW, else a supported language). */
export function detectLang(): Lang {
  try {
    const l = (typeof navigator !== 'undefined' && navigator && navigator.language) || ''
    const tag = l.toLowerCase().replace(/_/g, '-')
    if (/^zh/.test(tag)) {
      // Traditional Chinese: zh-TW / zh-HK / zh-MO / zh-Hant* ; simplified otherwise
      if (/zh-(tw|hk|mo|hant)/.test(tag)) return 'zh-TW'
      return 'zh'
    }
    if (/^de/.test(tag)) return 'de'
    if (/^fr/.test(tag)) return 'fr'
    if (/^es/.test(tag)) return 'es'
    if (/^it/.test(tag)) return 'it'
    if (/^pt/.test(tag)) return 'pt'
    if (/^ja/.test(tag)) return 'ja'
    if (/^ko/.test(tag)) return 'ko'
  } catch (e) { /* fall through to en */ }
  return 'en'
}

/** Resolve the configured language: explicit locale, else browser detection. */
export function resolveLang(cfgLang: string | undefined | null): Lang {
  if (cfgLang === 'zh' || cfgLang === 'zh-TW' || cfgLang === 'de' || cfgLang === 'fr' ||
      cfgLang === 'es' || cfgLang === 'it' || cfgLang === 'pt' || cfgLang === 'ja' || cfgLang === 'ko') {
    return cfgLang as Lang
  }
  if (cfgLang === 'en') return 'en'
  return detectLang()
}

/** Translate a key with optional {var} substitution; falls back to English. */
export function t(currentLang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s: string = (I18N[currentLang] && (I18N[currentLang] as any)[key]) || (I18N.en as any)[key] || key
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]))
  }
  return s
}

/**
 * dsh-save-money — Account balance display (host of the header balance UI).
 *
 * Kept as a separate module (inlined into the Client plugin body by
 * scripts/build.js, exactly like src/core.ts) so the feature can grow without
 * bloating the main plugin body. Pure functions only — no React import, no
 * globals — so it stays unit-testable and works in both the dynamic-plugin
 * sandbox and the official bundle form (React is passed in by the caller).
 */

/** Currency symbol lookup — the API reports CNY/USD, but map any known ISO 4217 code. */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  JPY: '¥',
  KRW: '₩',
  USD: '$',
  HKD: 'HK$',
  SGD: 'S$',
  TWD: 'NT$',
  EUR: '€',
  GBP: '£',
  CHF: 'CHF',
  AUD: 'A$',
  CAD: 'C$',
  NZD: 'NZ$',
  RUB: '₽',
  INR: '₹',
  BRL: 'R$',
  MXN: 'MX$',
}

/** Extract the displayable balance from a raw /save-money/balance response, or null. */
export function pickBalance(raw: any): { currency: string; total: string; granted: string; toppedUp: string } | null {
  if (!raw || typeof raw !== 'object' || raw.ok !== true) return null
  if (!Array.isArray(raw.balance) || raw.balance.length === 0) return null
  const b = raw.balance[0]
  if (!b || typeof b !== 'object') return null
  return {
    currency: String(b.currency || ''),
    total: String(b.total || ''),
    granted: String(b.granted || ''),
    toppedUp: String(b.toppedUp || ''),
  }
}

/** Currency symbol for the balance display (CNY → ¥, USD → $, …); unknown → $ fallback. */
export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] || '$'
}

/** The hover detail text (total / granted / topped-up). */
export function balanceTitle(b: { currency: string; total: string; granted: string; toppedUp: string }): string {
  const sym = currencySymbol(b.currency)
  return sym + ' total ' + b.total
    + (b.granted !== undefined ? ' (granted ' + b.granted + ', topped-up ' + b.toppedUp + ')' : '')
}

/** Format one spend value: spent → "¥1.25", recovered → "+¥1.25", n/a → "–". */
function fmtSpend(v: any, sym: string): string {
  if (v === null || v === undefined) return '\u2013' // en dash — history not yet sampled
  const n = Number(v)
  if (!Number.isFinite(n)) return '\u2013'
  // 正数=花掉(显示 "¥1.23"),负数=余额回升(显示 "+¥1.23")
  return (n >= 0 ? '' : '+') + sym + Math.abs(n).toFixed(2)
}

/**
 * The multi-line hover detail for the balance card, or null when the balance
 * is unavailable. Line 0 is the balance summary; then ONE LINE PER spend
 * window — 10m / 1h / 24h — always present so the user can see the features
 * exist. A window whose history is not yet sampled (first ~5 minutes after
 * enabling the display) shows "–" instead of a value; `labels` provides the
 * i18n texts (e.g. '近1h消费').
 *
 * `ranges` (when supplied) carries the wall-clock start instants of each
 * window (m10 / h1 / h24, ms). The client renders them as a time suffix so
 * the rolling spend windows are explicit — e.g. "近1h消费 07:00–08:00 ¥1.25" —
 * matching the bar chart's explicit "07:40–07:50" windows instead of leaving
 * two different "10 minutes" unlabeled and confusing.
 *
 * The client renders these lines in its own card (native `title` tooltips get
 * clipped at the viewport edge and cannot wrap, which is why the single-line
 * title is no longer used).
 */
export function balanceDetailLines(balance: any, labels?: { h1: string; m10: string; h24: string }, ranges?: { h1: number; m10: number; h24: number }): string[] | null {
  const b = pickBalance(balance)
  if (!b) return null
  const sym = currencySymbol(b.currency)
  const lines: string[] = [balanceTitle(b)]
  const s: any = balance && typeof balance === 'object' && balance.spend && typeof balance.spend === 'object' ? balance.spend : null
  if (s) {
    const h1 = fmtSpend(s.h1, sym)
    const m10 = fmtSpend(s.m10, sym)
    const h24 = fmtSpend(s.h24, sym)
    // Every window line is always rendered; unsampled history shows "–".
    // ranges carry window START instants → append "HH:mm–HH:mm" via a
    // caller-supplied formatter (kept out of this pure module: it has no tz).
    lines.push((labels ? labels.h1 : '1h') + ' ' + h1)
    lines.push((labels ? labels.m10 : '10m') + ' ' + m10)
    lines.push((labels ? labels.h24 : '24h') + ' ' + h24)
  }
  return lines
}

/**
 * Build the React element for the header balance text, or null when the
 * balance is unavailable (no credential / request failed / not the official
 * DeepSeek API). React is passed in — never imported.
 *
 * The text color uses the theme alias token --dsw-alias-label-secondary (the
 * same secondary-label token the Session Log uses), so it adapts to light and
 * dark mode automatically. No `title` attribute: the full detail (balance +
 * spend) is rendered by the caller in a custom hover card from
 * balanceDetailLines(), because native tooltips get clipped at the viewport
 * edge.
 */
export function renderBalanceElement(balance: any, React: any): any | null {
  const b = pickBalance(balance)
  if (!b) return null
  return React.createElement('span', {
    style: {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '14px', fontWeight: 600, whiteSpace: 'nowrap',
      marginRight: '8px', pointerEvents: 'auto', cursor: 'default',
    },
  }, currencySymbol(b.currency) + b.total)
}

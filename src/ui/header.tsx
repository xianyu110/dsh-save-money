/**
 * dsh-save-money — Client UI: session-header entry (src/ui/header.tsx)
 *
 * The single persistent header entry (next to the Session log): the status
 * text, the account balance with its hover detail card, the settings popover,
 * the spend bar-chart popover and the floating pause banner. Registered in the
 * conversation.session.header.utilities slot by the client body; this file
 * only renders — data and actions flow in through props.
 *
 * The balance hover card and the bar-chart tooltip are custom floating cards
 * (fixed + zIndex 10001): native `title` tooltips get clipped at the viewport
 * edge and cannot wrap, so the long text was invisible. Cards follow the
 * mouse and extend LEFT from the cursor (the balance sits at the right edge
 * of the header), clamped so they never leave the viewport.
 */

declare const React: any
declare const window: any
declare function wallClock(tz: string, date: Date): { y: number; mo: number; d: number; weekday: number; minutes: number }
declare function renderBalanceElement(balance: any, React: any): any | null
declare function balanceDetailLines(balance: any, labels?: { h1: string; m10: string; h24: string }): string[] | null
declare function currencySymbol(currency: string): string

/** Factory: build the HeaderEntry component bound to client deps + UI pieces. */
export function createHeaderEntry(deps: any, subs: any) {
  const t = deps.t
  const detectedTz = deps.detectedTz
  const badgeInfo = deps.badgeInfo
  const { SettingsView, FloatingBanner, BarChart } = subs

  const HeaderEntry = (props: any) => {
    const st = props.st
    const actions = props.actions
    const onRefresh = props.onRefresh || (() => {})
    const [open, setOpen] = React.useState(false)
    const [barsOpen, setBarsOpen] = React.useState(false)
    const b = badgeInfo(st)
    // "Save" + symbol + status text all use the state color
    const text = React.createElement('span', {
      onClick: () => setOpen(!open),
      style: {
        color: b.color, fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap',
        padding: '4px 8px', cursor: 'pointer', borderRadius: '6px',
        border: '1px solid ' + b.color, marginRight: '8px',
        pointerEvents: 'auto',
      },
      title: t('headerTitle', { status: b.text }),
    }, t('badgeLabel', { symbol: b.symbol, text: b.text }))
    // Account balance (DeepSeek /user/balance) next to the status text —
    // hidden when unavailable (no credential / request failed / not the
    // official DeepSeek API). Implemented in src/balance-client.ts.
    const balTipInit: any = null
    const [balTip, setBalTip] = React.useState(balTipInit)
    const updateBalTip = (e: any) => {
      const vw = typeof window !== 'undefined' && window && typeof window.innerWidth === 'number' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' && window && typeof window.innerHeight === 'number' ? window.innerHeight : 768
      const x = typeof e.clientX === 'number' ? e.clientX : vw
      const y = typeof e.clientY === 'number' ? e.clientY : 0
      // Card right edge sits 12px left of the cursor and extends left;
      // clamped so it never leaves the viewport on either side.
      const right = Math.max(8, Math.min(vw - 8, vw - x + 12))
      const top = Math.max(8, Math.min(y + 14, vh - 180))
      setBalTip({ right, top })
    }
    // Balance visibility follows the MOST RECENT model request (dynamic
    // multi-provider setups): show only while the latest actual request ran
    // on the official DeepSeek provider. A provider switch hides the balance
    // WITHOUT clearing the sampled history, so switching back to DeepSeek
    // re-shows it immediately. `provider` is null before any request (fresh
    // session) — show then too, the official account is queryable.
    const balVisible = !!(st.balance && typeof st.balance === 'object'
      && st.balance.ok === true
      && (st.balance.provider === null || st.balance.provider === undefined || st.balance.provider === 'deepseek-official'))
    const balanceEl = balVisible ? renderBalanceElement(st.balance, React) : null
    const balCard = (() => {
      if (!balTip || !balanceEl) return null
      const lines = balanceDetailLines(st.balance, { h1: t('spendH1'), m10: t('spendM10'), h24: t('spendH24') })
      if (!lines) return null
      // Append the exact wall-clock window to the m10/h1 lines (same source
      // and alignment as the bar chart): "Last 1h spend 07:00–08:00 ¥1.25".
      // h24 spans days, so it gets no range to avoid ambiguity.
      const sa = st.balance && st.balance.spendAt
      if (sa && typeof sa.m10 === 'number' && typeof sa.h1 === 'number') {
        try {
          const tzShow = (st.config && typeof st.config.timezone === 'string' && st.config.timezone.length > 0)
            ? st.config.timezone
            : detectedTz
          const fmt = (tt: number) => {
            const wc = wallClock(tzShow, new Date(tt))
            return String(Math.floor(wc.minutes / 60)).padStart(2, '0') + ':' + String(wc.minutes % 60).padStart(2, '0')
          }
          if (lines.length >= 2) lines[1] += ' ' + fmt(sa.h1) + '–' + fmt(sa.h1 + 60 * 60 * 1000)
          if (lines.length >= 3) lines[2] += ' ' + fmt(sa.m10) + '–' + fmt(sa.m10 + 10 * 60 * 1000)
        } catch (e) { /* keep the unlabelled lines on any tz error */ }
      }
      return React.createElement('div', {
        style: {
          position: 'fixed', right: balTip.right, top: balTip.top, zIndex: 10001,
          background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
          borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
          boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
          padding: '6px 10px', fontSize: '12px', lineHeight: '1.6',
          maxWidth: 'min(340px, calc(100vw - 24px))',
          whiteSpace: 'normal', overflowWrap: 'break-word',
          pointerEvents: 'none',
        },
      }, lines.map((ln, i) => React.createElement('div', {
        key: i,
        style: i === 0 ? { fontWeight: 700 } : { color: 'var(--dsw-alias-label-secondary)' },
      }, ln)))
    })()
    const pop = open
      ? React.createElement('div', {
          style: {
            position: 'fixed', right: '16px', top: '56px', width: '380px',
            // bg-layer-2: pure white in light themes, coordinated dark in dark
            // themes — follows the theme automatically
            background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
            borderRadius: '10px',
            boxShadow: '0 6px 24px rgba(0,0,0,0.35)', padding: '4px 8px 8px',
            zIndex: 10000, border: '1px solid var(--dsw-alias-border-l1)', maxHeight: '70vh', overflowY: 'auto',
            pointerEvents: 'auto',
          },
        },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 6px 0' } },
            React.createElement('span', { style: { fontSize: '13px', fontWeight: 700 } }, t('settingsTitle')),
            React.createElement('button', {
              onClick: () => setOpen(false),
              style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px', color: 'var(--dsw-alias-label-secondary)', pointerEvents: 'auto' },
            }, '✕'),
          ),
          React.createElement(SettingsView, { st, ...actions }),
        )
      : null
    // Spend bar-chart popup (click the balance): last 8h per 10 min.
    const chartPopup = barsOpen && balanceEl
      ? React.createElement('div', {
          style: {
            position: 'fixed', right: '16px', top: '56px', width: '420px',
            background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
            borderRadius: '10px',
            boxShadow: '0 6px 24px rgba(0,0,0,0.35)', padding: '4px 8px 8px',
            zIndex: 10000, border: '1px solid var(--dsw-alias-border-l1)', pointerEvents: 'auto',
          },
        },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 6px 0' } },
            React.createElement('span', { style: { fontSize: '13px', fontWeight: 700 } }, t('barsTitle')),
            React.createElement('button', {
              onClick: () => setBarsOpen(false),
              style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px', color: 'var(--dsw-alias-label-secondary)', pointerEvents: 'auto' },
            }, '✕'),
          ),
          React.createElement(BarChart, {
            bars: st.balance && st.balance.bars,
            timezone: st.config && st.config.timezone,
            symbol: (st.balance && st.balance.balance && st.balance.balance[0])
              ? currencySymbol(String(st.balance.balance[0].currency || ''))
              : '¥',
          }),
        )
      : null
    return React.createElement('div', { style: { display: 'contents' } },
      text,
      balanceEl
        ? React.createElement('div', {
            style: { display: 'contents', cursor: 'pointer' },
            onMouseEnter: updateBalTip,
            onMouseMove: updateBalTip,
            onMouseLeave: () => setBalTip(null),
            onClick: (e: any) => {
              e.stopPropagation()
              setBalTip(null) // clear the hover card so it cannot cover the popup
              setBarsOpen((v: any) => {
                const opening = !v
                if (opening) {
                  // Force one refresh when opening so the chart reflects the
                  // newest samples (the host 5-min sampler does not push).
                  onRefresh()
                }
                return !v
              }) // clicking again closes (toggle)
            },
          }, balanceEl, balCard)
        : null,
      pop,
      chartPopup,
      React.createElement(FloatingBanner, { st, doEndWindow: actions.doEndWindow }),
    )
  }
  return HeaderEntry
}

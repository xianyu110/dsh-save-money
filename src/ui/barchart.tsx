/**
 * dsh-save-money — Client UI: spend bar chart (src/ui/barchart.tsx)
 *
 * Last-8h spend per 10 minutes, rendered with plain divs (no chart library,
 * theme tokens only). Positive bars (spend) use the error/primary color
 * upward; balance top-ups (recharges/refunds) are NOT drawn — the axis is
 * positive-only and the negative window shows a "top-up" note on hover, so
 * large recharges never crush the spend bars into invisibility and the
 * plugin only analyses consumption (the official site shows top-ups).
 * Bars with null history (not yet sampled) are drawn as a faint dot so the
 * feature is visible from the start.
 *
 * The hover tooltip is a CUSTOM floating card (same as the header balance
 * card): instant (no native-title delay), follows the mouse, clamped to the
 * viewport. It exposes the window time range, the amount, and the
 * external-spend warning.
 */

declare const React: any
declare const window: any
declare function wallClock(tz: string, date: Date): { y: number; mo: number; d: number; weekday: number; minutes: number }

/** Factory: build the BarChart component bound to client deps. */
export function createBarChart(deps: any) {
  const t = deps.t
  const detectedTz = deps.detectedTz

  const BarChart = (props: any) => {
    const bars = props.bars
    const sym = props.symbol
    const tzShow = props.timezone || detectedTz
    const tipInit: any = null
    const [tip, setTip] = React.useState(tipInit)
    if (!Array.isArray(bars) || bars.length === 0) {
      return React.createElement('div', { style: { padding: '24px 8px', textAlign: 'center', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '–')
    }
    // bars[0] = most recent; render newest on the right → reverse to oldest first
    const ordered = bars.slice().reverse()
    const HEIGHT = 120
    // ---- Axis data ----
    // Spend only: positive values (spend) define the axis range; balance
    // top-ups (negative) take no part in the axis and draw no bar (a large
    // recharge would crush the spend bars into invisibility; the official
    // site shows top-ups, the plugin only analyses consumption, and hiding
    // them also avoids exposing balance movements). Negative windows are
    // annotated "top-up" on hover.
    let maxPos = 0
    for (const b of ordered) {
      if (b && typeof b.spent === 'number' && Number.isFinite(b.spent) && b.spent > 0 && b.spent > maxPos) maxPos = b.spent
    }
    // Y axis: 1/2/5×10^n key-point step (easy integer/half-integer values),
    // upper bound = the next key-point multiple above the highest bar
    // (slightly above it, leaving headroom). At most 5 ticks, fewer allowed —
    // grid lines, labels and bar heights all share this unified upper bound.
    const axis = (() => {
      const span = Math.max(maxPos, 0.001)
      const mag = Math.pow(10, Math.floor(Math.log10(span)))
      let step = 0
      for (const m of [1, 2, 5, 10]) {
        const s = m * mag
        if (Math.ceil(span / s) <= 4) { step = s; break } // step spacing ≤4 → ≤5 ticks
      }
      if (step === 0) step = 10 * mag
      const topMax = Math.ceil(span / step) * step // bound slightly above the max
      const ticks: number[] = []
      for (let v = 0; v <= topMax + 1e-9; v += step) {
        const clean = step >= 1 ? Math.round(v) : Math.round(v * 1000) / 1000
        if (clean !== ticks[ticks.length - 1]) ticks.push(clean)
      }
      return { step, topMax, ticks }
    })()
    const yTicks = axis.ticks
    const yMax = axis.topMax // tick bound (≥ maxPos)
    // The 0 baseline sits at the bottom: only the positive (spend) direction
    const zeroY = HEIGHT
    // Bar height in pixels, normalised against yMax
    const barH = (v: number): number => {
      if (v > 0) return yMax > 0 ? Math.max(2, Math.round(v / yMax * zeroY)) : 2
      return 2
    }
    // Spend bars only: positive bars (spend) use the error color upward; 0
    // values (no spend) use a neutral color; null (unsampled) is a faint
    // short dot; a positive bar whose window has no local activity
    // (activity=false) uses the warn color — the drop may come from another
    // environment. Negative values (balance top-up) return null → not drawn
    // (spend analysis only, top-ups are hidden).
    const barStyle = (b: any) => {
      const spent = b ? b.spent : null
      const finite = typeof spent === 'number' && Number.isFinite(spent)
      const value = finite ? (spent as number) : 0
      if (finite && value < 0) return null // balance top-up → no bar
      const zero = finite && value === 0
      const external = finite && value > 0 && !(b && b.activity)
      return {
        position: 'absolute' as const,
        left: '0',
        right: '0',
        bottom: '0',
        height: barH(value) + 'px',
        margin: '0 1px',
        background: !finite
          ? 'var(--dsw-alias-border-l1)' // faint placeholder for unsampled
          : zero
            ? 'var(--dsw-alias-border-l1)' // truly zero spend → neutral
            : external
              ? 'var(--dsw-alias-state-warn-primary)' // spend without local activity → warn
              : 'var(--dsw-alias-state-error-primary)',
        opacity: finite ? (zero ? 0.4 : 0.92) : 0.5,
        borderRadius: '1px',
      } as any
    }
    const formatBar = (spent: any) => {
      if (!(typeof spent === 'number' && Number.isFinite(spent))) return '–'
      const abs = Math.abs(spent).toFixed(2)
      return spent >= 0 ? sym + abs : '+' + sym + abs
    }
    // Wall-clock "HH:mm–HH:mm" range for a bar window, in the configured
    // timezone (the same one used to align the bar boundaries — the user sees
    // whole windows in the timezone they configured). Fallback: browser tz.
    const fmtWindow = (at: number, ms: number): string => {
      try {
        const f = (tt: number) => {
          try {
            const wc = wallClock(tzShow, new Date(tt))
            return String(Math.floor(wc.minutes / 60)).padStart(2, '0') + ':' + String(wc.minutes % 60).padStart(2, '0')
          } catch (e2) {
            const d = new Date(tt)
            return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
          }
        }
        return f(at) + '–' + f(at + ms)
      } catch (e) { return '' }
    }
    // Floating card positioning: follows the mouse, right edge 12px left of
    // the cursor, clamped inside the viewport
    const updateTip = (e: any, b: any) => {
      const vw = typeof window !== 'undefined' && window && typeof window.innerWidth === 'number' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' && window && typeof window.innerHeight === 'number' ? window.innerHeight : 768
      const x = typeof e.clientX === 'number' ? e.clientX : vw
      const y = typeof e.clientY === 'number' ? e.clientY : 0
      const right = Math.max(8, Math.min(vw - 8, vw - x + 12))
      const top = Math.max(8, Math.min(y + 14, vh - 120))
      setTip({ right, top, b })
    }
    const BAR_MS = 10 * 60 * 1000
    const tipCard = tip && tip.b
      ? React.createElement('div', {
          style: {
            position: 'fixed', right: tip.right, top: tip.top, zIndex: 10001,
            background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
            borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
            boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
            padding: '6px 10px', fontSize: '12px', lineHeight: '1.6',
            maxWidth: 'min(340px, calc(100vw - 24px))',
            whiteSpace: 'normal', overflowWrap: 'break-word',
            pointerEvents: 'none',
          },
        },
          React.createElement('div', { style: { fontWeight: 700 } },
            '10min ' + fmtWindow(tip.b.at, BAR_MS)),
          (tip.b && typeof tip.b.spent === 'number' && Number.isFinite(tip.b.spent) && tip.b.spent < 0)
            ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-success-primary)' } },
                t('barsTopUp'))
            : React.createElement('div', null,
                (tip.b && tip.b.spent !== null && tip.b.spent !== undefined ? formatBar(tip.b.spent) : '–')),
          (tip.b && tip.b.spent !== null && tip.b.spent !== undefined && tip.b.spent >= 0 && !tip.b.activity)
            ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', marginTop: '2px' } }, t('barsExternal'))
            : null,
        )
      : null
    const nowLabel = t('barsHint')
    const fmtTick = (tt: number): string => {
      try {
        const wc = wallClock(tzShow, new Date(tt))
        return String(Math.floor(wc.minutes / 60)).padStart(2, '0') + ':' + String(wc.minutes % 60).padStart(2, '0')
      } catch (e) {
        const d = new Date(tt)
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      }
    }
    const fmtTickVal = (v: number): string => {
      // Float cleanup: values near an integer (e.g. 0.6000000000000001) are
      // shown as integers
      const cleaned = Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v
      const abs = Math.abs(cleaned)
      const s = abs >= 1000 ? abs.toFixed(0) : abs >= 100 ? abs.toFixed(1) : abs.toFixed(2)
      return (cleaned < 0 ? '-' : '') + s
    }
    // Y tick position: value v maps to pixel top = zeroY - (v/yMax)*zeroY.
    // Larger values sit higher, 0 lands exactly on the baseline — visually
    // consistent with the bars (all normalised by yMax).
    const yTop = (v: number): number => {
      if (yMax <= 0) return zeroY
      return Math.round(zeroY - (v / yMax) * zeroY)
    }
    // X axis: whole-hour ticks. Find every hour boundary (HH:00) inside the
    // bar-covered time range, converted to a percentage position by bar index
    // — easier to read than arbitrary spaced moments and comparable with the
    // official per-hour billing. At most 8 ticks.
    const BAR_MS_X = 10 * 60 * 1000
    const oldestAt = ordered[0] ? ordered[0].at : 0
    const newestEnd = ordered[ordered.length - 1] ? ordered[ordered.length - 1].at + BAR_MS_X : 0
    const xTicks: { at: number; leftPct: number }[] = []
    if (newestEnd > 0 && ordered.length > 0) {
      const firstHour = Math.floor(oldestAt / 3600000) * 3600000
      const spanMs = newestEnd - oldestAt
      for (let t = firstHour; t <= newestEnd; t += 3600000) {
        if (t < oldestAt) continue
        const leftPct = spanMs > 0 ? ((t - oldestAt) / spanMs) * 100 : 0
        xTicks.push({ at: t, leftPct })
        if (xTicks.length >= 8) break
      }
    }
    // Layout: left column with Y ticks + right column (plot area + X axis)
    return React.createElement('div', { style: { padding: '10px 12px 8px' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'stretch' } },
        // Y tick column (amounts, absolutely positioned to align with bars)
        React.createElement('div', {
          style: {
            position: 'relative', width: '44px', marginRight: '6px',
            fontSize: '10px', color: 'var(--dsw-alias-label-secondary)', textAlign: 'right',
            height: HEIGHT + 'px', flexShrink: 0,
          },
        }, yTicks.map((v, i) => React.createElement('span', {
          key: i,
          style: {
            position: 'absolute', right: '0',
            top: yTop(v) + 'px',
            transform: 'translateY(-50%)',
            whiteSpace: 'nowrap',
          },
        }, sym + fmtTickVal(v)))),
        // Plot area + X axis
        React.createElement('div', { style: { flex: '1 1 0', minWidth: 0 } },
          React.createElement('div', {
            style: {
              position: 'relative',
              height: HEIGHT + 'px',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
            },
          },
            // Horizontal grid lines (one per Y tick, dashed; the 0 baseline
            // solid) — the v===0 grid line doubles as the baseline.
            yTicks.map((v, i) => React.createElement('div', {
              key: 'g' + i,
              style: {
                position: 'absolute', left: '0', right: '0',
                top: yTop(v) + 'px', height: '1px',
                borderTop: v === 0
                  ? '1px solid var(--dsw-alias-border-l1)'
                  : '1px dashed var(--dsw-alias-border-l1)',
                opacity: v === 0 ? 1 : 0.45,
                pointerEvents: 'none',
              },
            })),
            // Bars (each occupies 1/48 of the width)
            ordered.map((b: any, i: number) => {
              const innerStyle = barStyle(b)
              // Negative (top-up) bars are not drawn, but the hover target
              // stays so the "top-up" note can show. The outer placeholder
              // container always renders to keep the 48 slots aligned.
              return React.createElement('div', {
                key: i,
                style: {
                  position: 'absolute', top: '0', bottom: '0',
                  left: (i / ordered.length * 100) + '%',
                  width: (100 / ordered.length) + '%',
                },
                onMouseEnter: (e: any) => updateTip(e, b),
                onMouseMove: (e: any) => updateTip(e, b),
                onMouseLeave: () => setTip(null),
              }, innerStyle
                ? React.createElement('div', { style: innerStyle })
                : null)
            }),
          ),
          // X tick labels (whole hours)
          React.createElement('div', {
            style: {
              position: 'relative', height: '16px', marginTop: '2px',
              fontSize: '10px', color: 'var(--dsw-alias-label-secondary)',
            },
          }, xTicks.map((tk, i) => React.createElement('span', {
            key: i,
            style: {
              position: 'absolute',
              left: tk.leftPct + '%',
              transform: 'translateX(-50%)',
              whiteSpace: 'nowrap',
            },
          }, fmtTick(tk.at)))),
        ),
      ),
      React.createElement('div', { style: { marginTop: '4px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
        nowLabel,
      ),
      React.createElement('div', { style: { marginTop: '2px', fontSize: '10px', color: 'var(--dsw-alias-label-secondary)', opacity: 0.8 } },
        t('barsDisclaimer'),
      ),
      tipCard,
    )
  }
  return BarChart
}

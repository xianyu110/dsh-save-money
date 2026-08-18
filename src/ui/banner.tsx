/**
 * dsh-save-money — Client UI: floating banner (src/ui/banner.tsx)
 *
 * Registered in the session-header utilities slot (a normal layout chain) and
 * floated with position:fixed — the shell.overlay container is
 * pointer-events:none (click-through) and its slot anchor is display:contents,
 * which broke button hit-testing. Visible only while a pause window is active
 * (WARN = upcoming, PAUSED = in effect). The "End this save mode" button is a
 * one-shot end for the CURRENT window only (in-memory, not persisted; the
 * persistent enabled flag is untouched, so future windows keep saving money).
 */

// React is a shell global symbol — use it directly, do not ctx.get('React').
declare const React: any

/** Factory: build the FloatingBanner component bound to a translator. */
export function createFloatingBanner(deps: any) {
  const t = deps.t
  const FloatingBanner = (props: any) => {
    const st = props.st
    const doEndWindow = props.doEndWindow
    const isWarn = st.state === 'WARN'
    const isPaused = st.state === 'PAUSED'
    if (!isWarn && !isPaused) return null
    return React.createElement('div', {
      style: {
        position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: isPaused ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)',
        padding: '8px 18px', borderRadius: '999px', fontSize: '13px', fontWeight: 600,
        zIndex: 9999, boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
        display: 'flex', alignItems: 'center', gap: '10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        pointerEvents: 'auto',
      },
    },
      React.createElement('span', { style: { pointerEvents: 'none' } }, isPaused
        ? t('bannerPaused') + (st.window ? ' ' + st.window.resumeAt + t('bannerAutoResume') : '')
        : t('bannerWarn') + (st.minutesToPause != null ? st.minutesToPause + t('bannerMinutes') : t('bannerMoment'))),
      React.createElement('button', {
        style: {
          border: 'none', background: isPaused ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)', color: '#fff',
          borderRadius: '999px', padding: '3px 12px', cursor: 'pointer', fontSize: '12px',
          pointerEvents: 'auto',
        },
        onClick: () => void doEndWindow(),
      }, t('endThisWindow')),
    )
  }
  return FloatingBanner
}

/**
 * dsh-save-money — Client UI: status badge (src/ui/badge.tsx)
 *
 * The badge (color / text / symbol) reflects the current save-mode snapshot:
 * disabled (grey), working (green), warning (amber, pause upcoming) or paused
 * (red).
 *
 * Inlined into the client plugin body at build time (scripts/build.js): no
 * imports survive, so cross-module references are `declare`d for standalone
 * type-checking and resolve to the inlined scope at runtime.
 */

/** Factory: build the status-badge helper bound to a translator. */
export function createBadgeInfo(deps: any) {
  const t = deps.t
  return (st: any) => {
    const color = !st.enabled ? '#9E9E9E' : st.state === 'PAUSED' ? '#E53935' : st.state === 'WARN' ? '#F9A825' : '#4CAF50'
    const text = !st.enabled ? t('badgeDisabled') : st.state === 'PAUSED' ? t('badgePaused') : st.state === 'WARN' ? t('badgeWarn') : t('badgeWorking')
    const symbol = !st.enabled ? '⚪' : st.state === 'PAUSED' ? '🔴' : st.state === 'WARN' ? '🟡' : '🟢'
    return { color, text, symbol }
  }
}

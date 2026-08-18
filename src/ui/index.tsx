/**
 * dsh-save-money — Client UI composition root (src/ui/index.tsx)
 *
 * createUi(deps) wires every client UI piece into one object consumed by the
 * client plugin body. `deps` carries the shared client dependencies (the
 * reactive translator, the detected browser timezone and the DSH button
 * component); the badge helper is folded back into deps so both the settings
 * panel and the header entry can reach it.
 *
 * Inlined into the client plugin body at build time (scripts/build.js): the
 * sub-factories are declared here for standalone type-checking and resolve to
 * the inlined scope at runtime (inline order: badge → banner → settings →
 * barchart → header → index).
 */

declare function createBadgeInfo(deps: any): any
declare function createFloatingBanner(deps: any): any
declare function createSettingsView(deps: any): any
declare function createBarChart(deps: any): any
declare function createHeaderEntry(deps: any, subs: any): any

/** Compose the full client UI from the shared dependencies. */
export function createUi(deps: any) {
  const badgeInfo = createBadgeInfo(deps)
  const uiDeps = { ...deps, badgeInfo }
  const SettingsView = createSettingsView(uiDeps)
  const FloatingBanner = createFloatingBanner(uiDeps)
  const BarChart = createBarChart(uiDeps)
  const HeaderEntry = createHeaderEntry(uiDeps, { SettingsView, FloatingBanner, BarChart })
  return { badgeInfo, SettingsView, HeaderEntry }
}

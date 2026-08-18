/**
 * dsh-save-money — Client half (single source of the dynamic-plugin code.client)
 *
 * Browser UI (entry convergence):
 * 1. conversation.session.header.utilities — the only persistent header entry
 *    (next to the Session log): status text "Save · 🟢 Working" (click to open
 *    the settings popover) + the top floating banner (position:fixed, includes
 *    the "Disable save mode" button).
 * 2. settings.section — system settings page "Save-money" (one section in the
 *    settings panel; not a persistent entry).
 *
 * Key implementation notes:
 * - The PAUSED banner copy ("Paused: model requests suspended, no cost, HH:mm
 *   auto-resumes") works with the Host request-level gate: nothing throws, the
 *   request waits before being sent and continues once released.
 * - The banner is registered in the session-header utilities slot (a normal
 *   layout chain) and floats with position:fixed — the shell.overlay container
 *   is pointer-events:none (click-through) and its slot anchor is
 *   display:contents, which broke button hit-testing.
 *
 * Experience notes:
 * - React / host are Client Builtin GLOBAL symbols — use them directly, do not
 *   ctx.get('React').
 * - slots / timer are Services — go through ctx.get / inject.
 * - The dynamic Client half has no browser timer globals (no setInterval) —
 *   use the timer service, and in React effects dispose via the cleanup.
 * - There is no "open settings panel" Client Event — the popover is drawn by
 *   the plugin (fixed + zIndex 10000).
 *
 * i18n: UI strings live in the I18N dictionary below (zh + en). The language is
 * auto-detected from navigator.language (zh* → zh, anything else → en).
 */

declare const React: any
declare const host: any
declare const navigator: { language?: string } | undefined
declare const window: any
declare const fetch: any
// ModuleLoader 注入的同步 require:可解析 __DSH_BOOT__ 图里的 client 模块,
// 例如 DSH 系统按钮组件 @deepseek-ai/dsh-client-ui-primitives。
declare const require: any
// Core + balance helpers (src/core.ts, src/balance-client.ts) are inlined
// into this body at build time (scripts/build.js); the declarations below keep
// this file type-checked.
declare function parseHHMM(s: string): number | null
declare function formatHHMM(m: number): string
declare function wallClock(tz: string, date: Date): { y: number; mo: number; d: number; weekday: number; minutes: number }
declare function wallToUTC(tz: string, y: number, mo: number, d: number, hhmm: number): number
declare function convertHHMM(tzFrom: string, tzTo: string, hhmm: number, ref?: Date): number
declare function utcOffsetMinutes(tz: string, date: Date): number
declare function renderBalanceElement(balance: any, React: any): any | null
declare function balanceDetailLines(balance: any, labels?: { h1: string; m10: string; h24: string }): string[] | null
declare function currencySymbol(currency: string): string

// --- i18n dictionary (erased types at build time) ---
type Lang = 'zh' | 'zh-TW' | 'en' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'ja' | 'ko'
interface Dict {
  badgeDisabled: string
  badgePaused: string
  badgeWarn: string
  badgeWorking: string
  bannerPaused: string
  bannerAutoResume: string
  bannerWarn: string
  bannerMinutes: string
  bannerMoment: string
  endThisWindow: string
  endWindowActive: string
  statusPrefix: string
  windowSuffix: string
  pausedNote: string
  deepseekPreset: string
  presetExists: string
  presetUpgraded: string
  presetAdded: string
  applyFailed: string
  savedMsg: string
  enable: string
  timezone: string
  language: string
  langAuto: string
  langZh: string
  langZhTw: string
  langEn: string
  langDe: string
  langFr: string
  langEs: string
  langIt: string
  langPt: string
  langJa: string
  langKo: string
  windowsTitle: string
  pause: string
  resume: string
  removeTitle: string
  addWindow: string
  save: string
  settingsTitle: string
  headerTitle: string
  badgeLabel: string
  sectionLabel: string
  settingsHeading: string
  showBalance: string
  spendH1: string
  spendM10: string
  spendH24: string
  barsTitle: string
  barsHint: string
  barsExternal: string
  barsDisclaimer: string
}

const I18N: Record<Lang, Dict> = {
  zh: {
    badgeDisabled: '未启用',
    badgePaused: '已经暂停',
    badgeWarn: '即将暂停',
    badgeWorking: '工作中',
    bannerPaused: '⛔ 已暂停：模型请求已挂起，不产生费用。',
    bannerAutoResume: ' 自动继续',
    bannerWarn: '⏳ 距离暂停还有 ',
    bannerMinutes: ' 分钟',
    bannerMoment: '片刻',
    endThisWindow: '结束本次省钱模式',
    endWindowActive: '✅ 您已结束本次省钱模式：窗口 {a}-{b} 已跳过，{c} 自动恢复省钱（重新关闭再勾选「启用」可重置）',
    statusPrefix: '状态：',
    windowSuffix: '（{a}-{b}）',
    pausedNote: '暂停窗口内所有模型请求在发出前被挂起（不产生费用），窗口结束自动继续，上下文不受影响；点「结束本次省钱模式」可立即恢复并跳过本窗口（只影响当前窗口，下一窗口照常生效）。',
    deepseekPreset: '一键 DeepSeek 分时计价省钱策略',
    presetExists: 'DeepSeek 预设两组窗口（含 2 分钟余量）已存在，未重复添加。勾选「启用」即可生效。',
    presetUpgraded: '已升级 {n} 组旧窗口为带余量窗口；',
    presetAdded: '已添加 {n} 组 DeepSeek 预设窗口（未启用，请自行勾选「启用」）。',
    applyFailed: '一键应用失败：',
    savedMsg: '已保存 {n} 组窗口。',
    enable: '启用',
    timezone: '时区',
    language: '语言',
    langAuto: '自动（跟随浏览器）',
    langZh: '中文',
    langZhTw: '中文（繁體）',
    langEn: 'English',
    langDe: 'Deutsch',
    langFr: 'Français',
    langEs: 'Español',
    langIt: 'Italiano',
    langPt: 'Português',
    langJa: '日本語',
    langKo: '한국어',
    windowsTitle: '暂停窗口（{tz} 墙上时间，共 {n} 组）',
    pause: '暂停',
    resume: '继续',
    removeTitle: '删除该组',
    addWindow: '+ 添加窗口',
    save: '保存',
    settingsTitle: '省钱插件设置',
    headerTitle: 'save-money：{status}（点击进入设置）',
    badgeLabel: '省钱 · {symbol} {text}',
    sectionLabel: '省钱插件',
    settingsHeading: 'save-money 省钱插件',
    showBalance: '显示余额',
    spendH1: '近1h消费',
    spendM10: '近10m消费',
    spendH24: '近24h消费',
    barsTitle: '最近 8 小时消费(每 10 分钟)',
    barsHint: '绿色柱=余额回升,数值为 0 表示无消费',
    barsExternal: ' · 本窗口无本环境活动,变动可能来自其他环境',
    barsDisclaimer: '数据为采样计算获得仅供参考,实际以官方数据为准',
  },
  en: {
    badgeDisabled: 'Disabled',
    badgePaused: 'Paused',
    badgeWarn: 'Pausing soon',
    badgeWorking: 'Working',
    bannerPaused: '⛔ Paused: model requests suspended, no cost.',
    bannerAutoResume: ' auto-resumes',
    bannerWarn: '⏳ Pause in ',
    bannerMinutes: ' min',
    bannerMoment: 'a moment',
    endThisWindow: 'End this save mode',
    endWindowActive: '✅ You ended this save mode: window {a}-{b} skipped, saving resumes at {c} (toggle Enable off/on to reset)',
    statusPrefix: 'Status: ',
    windowSuffix: ' ({a}-{b})',
    pausedNote: 'All model requests are suspended before being sent (no cost). They resume automatically when the window ends; context is unaffected. Click "End this save mode" to resume now and skip only this window (the next window still takes effect).',
    deepseekPreset: 'One-click DeepSeek peak/off-peak savings',
    presetExists: 'DeepSeek preset windows (2-min margin) already present; not re-added. Check "Enable" to activate.',
    presetUpgraded: 'Upgraded {n} window(s) to the margin version; ',
    presetAdded: 'Added {n} DeepSeek preset window(s) (not enabled — check "Enable" to activate).',
    applyFailed: 'One-click failed: ',
    savedMsg: 'Saved {n} window(s).',
    enable: 'Enable',
    timezone: 'Timezone',
    language: 'Language',
    langAuto: 'Auto (browser)',
    langZh: '中文',
    langZhTw: '中文（繁體）',
    langEn: 'English',
    langDe: 'Deutsch',
    langFr: 'Français',
    langEs: 'Español',
    langIt: 'Italiano',
    langPt: 'Português',
    langJa: '日本語',
    langKo: '한국어',
    windowsTitle: 'Pause windows ({tz} wall-clock, {n} total)',
    pause: 'Pause',
    resume: 'Resume',
    removeTitle: 'Remove this window',
    addWindow: '+ Add window',
    save: 'Save',
    settingsTitle: 'Save-money settings',
    headerTitle: 'save-money: {status} (click for settings)',
    badgeLabel: 'Save · {symbol} {text}',
    sectionLabel: 'Save-money',
    settingsHeading: 'save-money plugin',
    showBalance: 'Show balance',
    spendH1: '1h spent',
    spendM10: '10m spent',
    spendH24: '24h spent',
    barsTitle: 'Last 8h spend (per 10 min)',
    barsHint: 'green bars = balance topped up; 0 = no spend',
    barsExternal: ' · no local activity in this window; change may come from elsewhere',
    barsDisclaimer: 'Estimated from sampled data; official billing takes precedence',
  },
  de: {
    badgeDisabled: 'Deaktiviert',
    badgePaused: 'Pausiert',
    badgeWarn: 'Bald pausiert',
    badgeWorking: 'Aktiv',
    bannerPaused: '⛔ Pausiert: Modellanfragen werden angehalten, keine Kosten.',
    bannerAutoResume: ' setzt automatisch fort',
    bannerWarn: '⏳ Pause in ',
    bannerMinutes: ' Min.',
    bannerMoment: 'einem Moment',
    endThisWindow: 'Diese Sparphase beenden',
    endWindowActive: '✅ Sie haben diese Sparphase beendet: Fenster {a}-{b} übersprungen, Sparmodus setzt um {c} automatisch fort (Ein/Aus schalten setzt zurück).',
    statusPrefix: 'Status: ',
    windowSuffix: ' ({a}-{b})',
    pausedNote: 'Alle Modellanfragen werden im Pausefenster vor dem Senden angehalten (keine Kosten). Sie werden automatisch fortgesetzt, wenn das Fenster endet; der Kontext bleibt unverändert. Klicken Sie auf „Diese Sparphase beenden“, um sofort fortzufahren und nur dieses Fenster zu überspringen.',
    deepseekPreset: 'DeepSeek-Spartarif mit einem Klick',
    presetExists: 'Die beiden DeepSeek-Fenster (mit 2 Min. Rand) sind bereits vorhanden und wurden nicht erneut hinzugefügt. Aktivieren Sie „Aktiviert“.',
    presetUpgraded: '{n} alte Fenster wurden auf die Version mit Rand aktualisiert; ',
    presetAdded: '{n} DeepSeek-Fenster hinzugefügt (nicht aktiviert – bitte „Aktiviert“ ankreuzen).',
    applyFailed: 'Ein-Klick fehlgeschlagen: ',
    savedMsg: '{n} Fenster gespeichert.',
    enable: 'Aktiviert',
    timezone: 'Zeitzone',
    language: 'Sprache',
    langAuto: 'Automatisch (Browser)',
    langZh: 'Chinesisch (vereinfacht)',
    langZhTw: 'Chinesisch (traditionell)',
    langEn: 'Englisch',
    langDe: 'Deutsch',
    langFr: 'Französisch',
    langEs: 'Spanisch',
    langIt: 'Italienisch',
    langPt: 'Portugiesisch',
    langJa: 'Japanisch',
    langKo: 'Koreanisch',
    windowsTitle: 'Pausefenster ({tz} Ortszeit, {n} gesamt)',
    pause: 'Pause',
    resume: 'Fortsetzen',
    removeTitle: 'Fenster entfernen',
    addWindow: '+ Fenster hinzufügen',
    save: 'Speichern',
    settingsTitle: 'Sparmodus-Einstellungen',
    headerTitle: 'save-money: {status} (klicken für Einstellungen)',
    badgeLabel: 'Sparen · {symbol} {text}',
    sectionLabel: 'Sparmodus',
    settingsHeading: 'save-money Sparmodus',
    showBalance: 'Guthaben anzeigen',
    spendH1: 'Verbrauch 1h',
    spendM10: 'Verbrauch 10m',
    spendH24: 'Verbrauch 24h',
    barsTitle: 'Verbrauch letzte 8h (pro 10 Min.)',
    barsHint: 'grüne Balken = Guthaben aufgestockt; 0 = kein Verbrauch',
    barsExternal: ' · in diesem Fenster keine lokale Aktivität; Änderung evtl. von anderswo',
    barsDisclaimer: 'Aus Stichproben geschätzt; maßgeblich ist die offizielle Abrechnung',
  },
  fr: {
    badgeDisabled: 'Désactivé',
    badgePaused: 'En pause',
    badgeWarn: 'Pause imminente',
    badgeWorking: 'En cours',
    bannerPaused: '⛔ En pause : requêtes modèle suspendues, aucun coût.',
    bannerAutoResume: ' reprend automatiquement',
    bannerWarn: '⏳ Pause dans ',
    bannerMinutes: ' min',
    bannerMoment: 'un instant',
    endThisWindow: 'Terminer cette économie',
    endWindowActive: '✅ Vous avez terminé cette économie : fenêtre {a}-{b} ignorée, reprise automatique à {c} (désactivez puis réactivez « Activer » pour réinitialiser).',
    statusPrefix: 'État : ',
    windowSuffix: ' ({a}-{b})',
    pausedNote: 'Toutes les requêtes modèle sont suspendues avant envoi dans la fenêtre de pause (aucun coût) et reprennent automatiquement à la fin de la fenêtre ; le contexte est préservé. Cliquez sur « Terminer cette économie » pour reprendre immédiatement en ignorant uniquement cette fenêtre.',
    deepseekPreset: 'Économies DeepSeek en un clic',
    presetExists: 'Les deux fenêtres DeepSeek (marge de 2 min) existent déjà, rien n\u2019a été ajouté. Cochez « Activer ».',
    presetUpgraded: '{n} ancienne(s) fenêtre(s) mise(s) à niveau avec marge ; ',
    presetAdded: '{n} fenêtre(s) DeepSeek ajoutée(s) (non activée(s) – cochez « Activer »).',
    applyFailed: 'Échec de l\u2019application : ',
    savedMsg: '{n} fenêtre(s) enregistrée(s).',
    enable: 'Activer',
    timezone: 'Fuseau horaire',
    language: 'Langue',
    langAuto: 'Automatique (navigateur)',
    langZh: 'Chinois (simplifié)',
    langZhTw: 'Chinois (traditionnel)',
    langEn: 'Anglais',
    langDe: 'Allemand',
    langFr: 'Français',
    langEs: 'Espagnol',
    langIt: 'Italien',
    langPt: 'Portugais',
    langJa: 'Japonais',
    langKo: 'Coréen',
    windowsTitle: 'Fenêtres de pause ({tz} heure locale, {n} au total)',
    pause: 'Pause',
    resume: 'Reprendre',
    removeTitle: 'Supprimer cette fenêtre',
    addWindow: '+ Ajouter une fenêtre',
    save: 'Enregistrer',
    settingsTitle: 'Paramètres de l\u2019économie',
    headerTitle: 'save-money : {status} (cliquer pour les paramètres)',
    badgeLabel: 'Économie · {symbol} {text}',
    sectionLabel: 'Économie',
    settingsHeading: 'Extension save-money',
    showBalance: 'Afficher le solde',
    spendH1: 'dépensé 1h',
    spendM10: 'dépensé 10m',
    spendH24: 'dépensé 24h',
    barsTitle: 'Dépenses 8 dernières h (par 10 min)',
    barsHint: 'barres vertes = solde rechargé ; 0 = aucune dépense',
    barsExternal: ' · aucune activité locale dans cette fenêtre ; variation peut venir d\u2019ailleurs',
    barsDisclaimer: 'Estimation à partir d\u2019échantillons ; la facturation officielle fait foi',
  },
  es: {
    badgeDisabled: 'Desactivado',
    badgePaused: 'En pausa',
    badgeWarn: 'Pausa próxima',
    badgeWorking: 'En funcionamiento',
    bannerPaused: '⛔ En pausa: solicitudes al modelo suspendidas, sin coste.',
    bannerAutoResume: ' se reanuda automáticamente',
    bannerWarn: '⏳ Pausa en ',
    bannerMinutes: ' min',
    bannerMoment: 'un momento',
    endThisWindow: 'Terminar este ahorro',
    endWindowActive: '✅ Ha terminado este ahorro: ventana {a}-{b} omitida, se reanuda a las {c} (desactive y vuelva a activar «Activar» para restablecer).',
    statusPrefix: 'Estado: ',
    windowSuffix: ' ({a}-{b})',
    pausedNote: 'Todas las solicitudes al modelo se suspenden antes de enviarse durante la ventana de pausa (sin coste) y se reanudan automáticamente al terminar; el contexto no se ve afectado. Pulse « Terminar este ahorro » para reanudar de inmediato omitiendo solo esta ventana.',
    deepseekPreset: 'Ahorro DeepSeek con un clic',
    presetExists: 'Las dos ventanas DeepSeek (margen de 2 min) ya existen; no se añadieron de nuevo. Marque « Activar ».',
    presetUpgraded: '{n} ventana(s) antigua(s) actualizada(s) con margen; ',
    presetAdded: '{n} ventana(s) DeepSeek añadida(s) (sin activar – marque « Activar »).',
    applyFailed: 'Error al aplicar: ',
    savedMsg: '{n} ventana(s) guardada(s).',
    enable: 'Activar',
    timezone: 'Zona horaria',
    language: 'Idioma',
    langAuto: 'Automático (navegador)',
    langZh: 'Chino (simplificado)',
    langZhTw: 'Chino (tradicional)',
    langEn: 'Inglés',
    langDe: 'Alemán',
    langFr: 'Francés',
    langEs: 'Español',
    langIt: 'Italiano',
    langPt: 'Portugués',
    langJa: 'Japonés',
    langKo: 'Coreano',
    windowsTitle: 'Ventanas de pausa ({tz} hora local, {n} en total)',
    pause: 'Pausa',
    resume: 'Reanudar',
    removeTitle: 'Eliminar esta ventana',
    addWindow: '+ Añadir ventana',
    save: 'Guardar',
    settingsTitle: 'Ajustes del ahorro',
    headerTitle: 'save-money: {status} (clic para ajustes)',
    badgeLabel: 'Ahorro · {symbol} {text}',
    sectionLabel: 'Ahorro',
    settingsHeading: 'Extensión save-money',
    showBalance: 'Mostrar saldo',
    spendH1: 'gastado 1h',
    spendM10: 'gastado 10m',
    spendH24: 'gastado 24h',
    barsTitle: 'Gasto últimas 8 h (por 10 min)',
    barsHint: 'barras verdes = saldo recargado; 0 = sin gasto',
    barsExternal: ' · sin actividad local en este tramo; el cambio puede venir de otro sitio',
    barsDisclaimer: 'Estimado a partir de muestras; la facturación oficial es la referencia',
  },
  it: {
    badgeDisabled: 'Disattivato',
    badgePaused: 'In pausa',
    badgeWarn: 'Pausa imminente',
    badgeWorking: 'In funzione',
    bannerPaused: '⛔ In pausa: richieste al modello sospese, nessun costo.',
    bannerAutoResume: ' riprende automaticamente',
    bannerWarn: '⏳ Pausa tra ',
    bannerMinutes: ' min',
    bannerMoment: 'un attimo',
    endThisWindow: 'Termina questa modalità di risparmio',
    endWindowActive: '✅ Hai terminato questa modalità di risparmio: finestra {a}-{b} saltata, riprende alle {c} (disattiva e riattiva «Attiva» per azzerare).',
    statusPrefix: 'Stato: ',
    windowSuffix: ' ({a}-{b})',
    pausedNote: 'Tutte le richieste al modello vengono sospese prima dell\u2019invio nella finestra di pausa (nessun costo) e riprendono automaticamente alla fine; il contesto resta invariato. Clicca su « Termina questa modalità di risparmio » per riprendere subito saltando solo questa finestra.',
    deepseekPreset: 'Risparmio DeepSeek con un clic',
    presetExists: 'Le due finestre DeepSeek (margine 2 min) esistono già; non aggiunte di nuovo. Spunta « Attiva ».',
    presetUpgraded: '{n} vecchia/e finestra/e aggiornata/e con margine; ',
    presetAdded: '{n} finestra/e DeepSeek aggiunta/e (non attiva/e – spunta « Attiva »).',
    applyFailed: 'Applicazione fallita: ',
    savedMsg: '{n} finestra/e salvata/e.',
    enable: 'Attiva',
    timezone: 'Fuso orario',
    language: 'Lingua',
    langAuto: 'Automatico (browser)',
    langZh: 'Cinese (semplificato)',
    langZhTw: 'Cinese (tradizionale)',
    langEn: 'Inglese',
    langDe: 'Tedesco',
    langFr: 'Francese',
    langEs: 'Spagnolo',
    langIt: 'Italiano',
    langPt: 'Portoghese',
    langJa: 'Giapponese',
    langKo: 'Coreano',
    windowsTitle: 'Finestre di pausa ({tz} ora locale, {n} in totale)',
    pause: 'Pausa',
    resume: 'Riprendi',
    removeTitle: 'Rimuovi questa finestra',
    addWindow: '+ Aggiungi finestra',
    save: 'Salva',
    settingsTitle: 'Impostazioni risparmio',
    headerTitle: 'save-money: {status} (clic per impostazioni)',
    badgeLabel: 'Risparmio · {symbol} {text}',
    sectionLabel: 'Risparmio',
    settingsHeading: 'Estensione save-money',
    showBalance: 'Mostra saldo',
    spendH1: 'speso 1h',
    spendM10: 'speso 10m',
    spendH24: 'speso 24h',
    barsTitle: 'Spese ultime 8 h (per 10 min)',
    barsHint: 'barre verdi = saldo ricaricato; 0 = nessuna spesa',
    barsExternal: ' · nessuna attività locale in questo intervallo; variazione forse esterna',
    barsDisclaimer: 'Stima da campionamenti; fa fede la fatturazione ufficiale',
  },
  pt: {
    badgeDisabled: 'Desativado',
    badgePaused: 'Em pausa',
    badgeWarn: 'Pausa em breve',
    badgeWorking: 'Em funcionamento',
    bannerPaused: '⛔ Em pausa: solicitações ao modelo suspensas, sem custo.',
    bannerAutoResume: ' retoma automaticamente',
    bannerWarn: '⏳ Pausa em ',
    bannerMinutes: ' min',
    bannerMoment: 'um momento',
    endThisWindow: 'Terminar este modo de economia',
    endWindowActive: '✅ Você terminou este modo de economia: janela {a}-{b} ignorada, retoma às {c} (desative e reative «Ativar» para redefinir).',
    statusPrefix: 'Estado: ',
    windowSuffix: ' ({a}-{b})',
    pausedNote: 'Todas as solicitações ao modelo são suspensas antes do envio na janela de pausa (sem custo) e retomam automaticamente no fim; o contexto é preservado. Clique em « Terminar este modo de economia » para retomar imediatamente ignorando apenas esta janela.',
    deepseekPreset: 'Economia DeepSeek com um clique',
    presetExists: 'As duas janelas DeepSeek (margem de 2 min) já existem; não foram adicionadas de novo. Marque « Ativar ».',
    presetUpgraded: '{n} janela(s) antiga(s) atualizada(s) com margem; ',
    presetAdded: '{n} janela(s) DeepSeek adicionada(s) (sem ativar – marque « Ativar »).',
    applyFailed: 'Falha ao aplicar: ',
    savedMsg: '{n} janela(s) salva(s).',
    enable: 'Ativar',
    timezone: 'Fuso horário',
    language: 'Idioma',
    langAuto: 'Automático (navegador)',
    langZh: 'Chinês (simplificado)',
    langZhTw: 'Chinês (tradicional)',
    langEn: 'Inglês',
    langDe: 'Alemão',
    langFr: 'Francês',
    langEs: 'Espanhol',
    langIt: 'Italiano',
    langPt: 'Português',
    langJa: 'Japonês',
    langKo: 'Coreano',
    windowsTitle: 'Janelas de pausa ({tz} hora local, {n} no total)',
    pause: 'Pausa',
    resume: 'Retomar',
    removeTitle: 'Remover esta janela',
    addWindow: '+ Adicionar janela',
    save: 'Salvar',
    settingsTitle: 'Configurações da economia',
    headerTitle: 'save-money: {status} (clique para configurações)',
    badgeLabel: 'Economia · {symbol} {text}',
    sectionLabel: 'Economia',
    settingsHeading: 'Extensão save-money',
    showBalance: 'Mostrar saldo',
    spendH1: 'gasto 1h',
    spendM10: 'gasto 10m',
    spendH24: 'gasto 24h',
    barsTitle: 'Gastos últimas 8 h (por 10 min)',
    barsHint: 'barras verdes = saldo recarregado; 0 = sem gasto',
    barsExternal: ' · sem atividade local neste trecho; variação pode vir de outro lugar',
    barsDisclaimer: 'Estimativa baseada em amostras; a cobrança oficial prevalece',
  },
  ja: {
    badgeDisabled: '無効',
    badgePaused: '一時停止中',
    badgeWarn: 'まもなく一時停止',
    badgeWorking: '稼働中',
    bannerPaused: '⛔ 一時停止中:モデルへのリクエストを保留中、費用は発生しません。',
    bannerAutoResume: ' 自動で再開',
    bannerWarn: '⏳ 一時停止まであと ',
    bannerMinutes: ' 分',
    bannerMoment: 'もうすぐ',
    endThisWindow: '今回の節約モードを終了',
    endWindowActive: '✅ 今回の節約モードを終了しました:ウィンドウ {a}-{b} をスキップ、{c} に自動再開（「有効」をオフ→オンでリセット）。',
    statusPrefix: '状態: ',
    windowSuffix: ' （{a}-{b}）',
    pausedNote: '一時停止ウィンドウ中は、すべてのモデルリクエストが送信前に保留されます（費用は発生しません）。ウィンドウ終了時に自動で再開され、コンテキストは影響を受けません。「今回の節約モードを終了」をクリックすると、このウィンドウだけをスキップしてすぐに再開します。',
    deepseekPreset: 'ワンクリック DeepSeek 分時料金節約',
    presetExists: 'DeepSeek プリセットの 2 ウィンドウ（2 分の余裕込み）は既に存在します。重複追加はしません。「有効」にチェックしてください。',
    presetUpgraded: '旧ウィンドウ {n} 件を余裕付きにアップグレードしました。',
    presetAdded: 'DeepSeek プリセットウィンドウを {n} 件追加しました（未有効。ご自身で「有効」にチェックしてください）。',
    applyFailed: '適用に失敗しました:',
    savedMsg: '{n} 個のウィンドウを保存しました。',
    enable: '有効',
    timezone: 'タイムゾーン',
    language: '言語',
    langAuto: '自動（ブラウザに従う）',
    langZh: '中国語（簡体字）',
    langZhTw: '中国語（繁体字）',
    langEn: '英語',
    langDe: 'ドイツ語',
    langFr: 'フランス語',
    langEs: 'スペイン語',
    langIt: 'イタリア語',
    langPt: 'ポルトガル語',
    langJa: '日本語',
    langKo: '韓国語',
    windowsTitle: '一時停止ウィンドウ（{tz} 現地時間、全 {n} 件）',
    pause: '一時停止',
    resume: '再開',
    removeTitle: 'このウィンドウを削除',
    addWindow: '+ ウィンドウを追加',
    save: '保存',
    settingsTitle: '節約プラグイン設定',
    headerTitle: 'save-money：{status}（クリックで設定）',
    badgeLabel: '節約 · {symbol} {text}',
    sectionLabel: '節約プラグイン',
    settingsHeading: 'save-money 節約プラグイン',
    showBalance: '残高を表示',
    spendH1: '1h 消費',
    spendM10: '10m 消費',
    spendH24: '24h 消費',
    barsTitle: '最近8時間の消費（10分ごと）',
    barsHint: '緑のバー=残高チャージ、0=消費なし',
    barsExternal: ' · この区間にローカル活動なし、変動は他環境の可能性',
    barsDisclaimer: 'サンプルから推定した参考値です。公式の請求が優先されます',
  },
  ko: {
    badgeDisabled: '비활성화됨',
    badgePaused: '일시중지됨',
    badgeWarn: '곧 일시중지',
    badgeWorking: '작동 중',
    bannerPaused: '⛔ 일시중지됨: 모델 요청이 보류되어 비용이 발생하지 않습니다.',
    bannerAutoResume: ' 자동 재개',
    bannerWarn: '⏳ 일시중지까지 ',
    bannerMinutes: ' 분',
    bannerMoment: '곧',
    endThisWindow: '이번 절약 모드 종료',
    endWindowActive: '✅ 이번 절약 모드를 종료했습니다: 창 {a}-{b} 건너뜀, {c}에 자동 재개（「활성화」를 껐다 켜면 초기화）.',
    statusPrefix: '상태: ',
    windowSuffix: ' ({a}-{b})',
    pausedNote: '일시중지 창 동안 모든 모델 요청은 전송 전에 보류됩니다(비용 없음). 창이 끝나면 자동으로 재개되며 컨텍스트는 영향을 받지 않습니다. 「이번 절약 모드 종료」를 클릭하면 이 창만 건너뛰고 즉시 재개합니다.',
    deepseekPreset: '원클릭 DeepSeek 시간대별 절약',
    presetExists: 'DeepSeek 프리셋 창 2개(2분 여유 포함)가 이미 있습니다. 중복 추가하지 않았습니다. 「활성화」를 체크하세요.',
    presetUpgraded: '이전 창 {n}개를 여유 포함 버전으로 업그레이드했습니다. ',
    presetAdded: 'DeepSeek 프리셋 창 {n}개를 추가했습니다(비활성화 상태. 「활성화」를 직접 체크하세요).',
    applyFailed: '적용 실패:',
    savedMsg: '창 {n}개를 저장했습니다.',
    enable: '활성화',
    timezone: '시간대',
    language: '언어',
    langAuto: '자동(브라우저 따름)',
    langZh: '중국어(간체)',
    langZhTw: '중국어(번체)',
    langEn: '영어',
    langDe: '독일어',
    langFr: '프랑스어',
    langEs: '스페인어',
    langIt: '이탈리아어',
    langPt: '포르투갈어',
    langJa: '일본어',
    langKo: '한국어',
    windowsTitle: '일시중지 창({tz} 현지 시간, 총 {n}개)',
    pause: '일시중지',
    resume: '재개',
    removeTitle: '이 창 삭제',
    addWindow: '+ 창 추가',
    save: '저장',
    settingsTitle: '절약 플러그인 설정',
    headerTitle: 'save-money: {status}(클릭하여 설정)',
    badgeLabel: '절약 · {symbol} {text}',
    sectionLabel: '절약 플러그인',
    settingsHeading: 'save-money 절약 플러그인',
    showBalance: '잔액 표시',
    spendH1: '1h 소비',
    spendM10: '10m 소비',
    spendH24: '24h 소비',
    barsTitle: '최근 8시간 소비(10분 단위)',
    barsHint: '초록 막대=잔액 충전, 0=소비 없음',
    barsExternal: ' · 이 구간에 로컬 활동 없음, 변동은 다른 환경 가능성',
    barsDisclaimer: '샘플 기반 추정치이며, 공식 청구 내역이 우선합니다',
  },
  'zh-TW': {
    badgeDisabled: '未啟用',
    badgePaused: '已暫停',
    badgeWarn: '即將暫停',
    badgeWorking: '運作中',
    bannerPaused: '⛔ 已暫停：模型請求已掛起，不產生費用。',
    bannerAutoResume: ' 自動繼續',
    bannerWarn: '⏳ 距離暫停還有 ',
    bannerMinutes: ' 分鐘',
    bannerMoment: '片刻',
    endThisWindow: '結束本次省錢模式',
    endWindowActive: '✅ 您已結束本次省錢模式：視窗 {a}-{b} 已跳過，{c} 自動恢復省錢（重新關閉再勾選「啟用」可重設）。',
    statusPrefix: '狀態：',
    windowSuffix: '（{a}-{b}）',
    pausedNote: '暫停視窗內所有模型請求在發出前被掛起（不產生費用），視窗結束自動繼續，上下文不受影響；點「結束本次省錢模式」可立即恢復並跳過本視窗（只影響目前視窗，下一視窗照常生效）。',
    deepseekPreset: '一鍵 DeepSeek 分時計價省錢策略',
    presetExists: 'DeepSeek 預設兩組視窗（含 2 分鐘餘量）已存在，未重複新增。勾選「啟用」即可生效。',
    presetUpgraded: '已升級 {n} 組舊視窗為帶餘量視窗；',
    presetAdded: '已新增 {n} 組 DeepSeek 預設視窗（未啟用，請自行勾選「啟用」）。',
    applyFailed: '一鍵套用失敗：',
    savedMsg: '已儲存 {n} 組視窗。',
    enable: '啟用',
    timezone: '時區',
    language: '語言',
    langAuto: '自動（跟隨瀏覽器）',
    langZh: '中文（簡體）',
    langZhTw: '中文（繁體）',
    langEn: '英文',
    langDe: '德文',
    langFr: '法文',
    langEs: '西班牙文',
    langIt: '義大利文',
    langPt: '葡萄牙文',
    langJa: '日文',
    langKo: '韓文',
    windowsTitle: '暫停視窗（{tz} 牆上時間，共 {n} 組）',
    pause: '暫停',
    resume: '繼續',
    removeTitle: '刪除該組',
    addWindow: '+ 新增視窗',
    save: '儲存',
    settingsTitle: '省錢外掛設定',
    headerTitle: 'save-money：{status}（點擊進入設定）',
    badgeLabel: '省錢 · {symbol} {text}',
    sectionLabel: '省錢外掛',
    settingsHeading: 'save-money 省錢外掛',
    showBalance: '顯示餘額',
    spendH1: '近1小時消費',
    spendM10: '近10分鐘消費',
    spendH24: '近24小時消費',
    barsTitle: '最近 8 小時消費（每 10 分鐘）',
    barsHint: '綠色柱=餘額回升，數值為 0 表示無消費',
    barsExternal: ' · 本窗口無本環境活動，變動可能來自其他環境',
    barsDisclaimer: '數據為採樣計算獲得僅供參考，實際以官方數據為準',
  },
}

function detectLang(): Lang {
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
// Language is reactive: currentLang starts from browser detection and is
// overridden by the persisted config choice ('zh'/'zh-TW'/'en'/...) or kept on
// 'auto' (follow the browser) — see refresh() below and the settings dropdown.
let currentLang: Lang = detectLang()
// Plugin name + version shown next to the Save button in the settings popover.
// '__VERSION__' is replaced at build time (scripts/build.js) with the real
// version from package.json — never edit this literal by hand.
const PLUGIN_VERSION = '__VERSION__'
const resolveLang = (cfgLang: string | undefined | null): Lang => {
  if (cfgLang === 'zh' || cfgLang === 'zh-TW' || cfgLang === 'de' || cfgLang === 'fr' ||
      cfgLang === 'es' || cfgLang === 'it' || cfgLang === 'pt' || cfgLang === 'ja' || cfgLang === 'ko') {
    return cfgLang as Lang
  }
  if (cfgLang === 'en') return 'en'
  return detectLang()
}
const t = (key: string, vars?: Record<string, string | number>): string => {
  let s: string = (I18N[currentLang] && (I18N[currentLang] as any)[key]) || (I18N.en as any)[key] || key
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]))
  }
  return s
}

// ---- 24 fixed whole-hour timezones (real timezone rules, DST-aware) ----
// One representative per integer UTC offset (UTC-11 … UTC+12), fixed order.
// The (UTC+X) label is computed live, so DST zones show their current offset
// (e.g. Europe/London (UTC+1) in summer) while the picker stays stable.
interface TzEntry { name: string; off: number }
const ALL_TIMEZONES: TzEntry[] = (() => {
  const ZONES = [
    'Pacific/Pago_Pago', 'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles',
    'America/Denver', 'America/Chicago', 'America/New_York', 'America/Halifax',
    'America/Sao_Paulo', 'Atlantic/South_Georgia', 'Atlantic/Azores', 'UTC',
    'Europe/London', 'Europe/Paris', 'Europe/Athens', 'Europe/Moscow',
    'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Bangkok',
    'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Brisbane', 'Pacific/Auckland',
  ]
  const now = new Date()
  return ZONES.map((n) => {
    try { return { name: n, off: utcOffsetMinutes(n, now) * 60000 } }
    catch (e) { return { name: n, off: NaN } }
  })
})()
const TZ_OFF = new Map(ALL_TIMEZONES.map((x) => [x.name, x.off] as [string, number]))
const fmtOff = (ms: number): string => {
  const m = ms / 60000
  const sign = m >= 0 ? '+' : '-'
  const a = Math.abs(m)
  const h = Math.floor(a / 60)
  const mm = a % 60
  return 'UTC' + sign + h + (mm > 0 ? ':' + String(mm).padStart(2, '0') : '')
}

return {
  inject: ['timer'],
  async apply(ctx: any) {
    const slots = ctx.get('slots')
    const timer = ctx.timer
    if (!React || !slots || !timer) {
      console.error('[save-money] client apply aborted')
      return
    }

    // DSH 系统按钮组件(ui-primitives):圆润胶囊、token 自动适配亮/暗主题。
    // require 由 ModuleLoader 提供;同步 require 跳过异步加载分支,若该模块
    // 的 script 尚未注册,require 会抛错——捕获后退回自绘按钮,UI 永不挂。
    let DSHButton: any = undefined
    try {
      DSHButton = (require('@deepseek-ai/dsh-client-ui-primitives') || {}).Button
    } catch (e) {
      console.error('[save-money] ui-primitives unavailable, falling back to hand-drawn buttons: ' + String((e && (e as any).message) || e))
    }

    // Unified Host call: the dynamic-plugin Client half talks to the host via
    // the harness RPC global (`host.call`); the official bundled Client half
    // (plugin/client.js, no harness global) talks to the same-origin
    // webServer HTTP endpoints registered by the Host half (/save-money/*).
    const callHost = async (method: string, args?: any): Promise<any> => {
      if (typeof host !== 'undefined' && host && typeof host.call === 'function') {
        return host.call(method, args)
      }
      const res = await fetch('/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: args === undefined ? undefined : JSON.stringify(args),
      })
      if (!res.ok) throw new Error('save-money http ' + res.status)
      return res.json()
    }

    // Detect the browser timezone, fall back to Beijing time
    let detectedTz = 'Asia/Shanghai'
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz && typeof tz === 'string' && tz.length > 0) detectedTz = tz
    } catch (e) { /* fall back to Beijing time */ }

    let snapshot: any = { enabled: false, state: 'NORMAL', reason: null, window: null, minutesToPause: null, endWindowUntil: null, pauseRecord: null, config: null, balance: null }
    // Last successful balance fetch (ms) — the balance is refreshed on user
    // messages or every 10 minutes, not on every 30s poll.
    let lastBalanceAt = 0
    // Backoff gate (ms epoch): after a balance failure/timeout we wait this
    // long before trying again, so a failing upstream is never hammered every
    // 30s (and a hung host call can never wedge the refresh loop).
    let nextBalanceAttemptAt = 0
    const BALANCE_RETRY_MS = 5 * 60 * 1000
    // Browser-side hard timeout for one balance call, driven by the cordis
    // timer service (the sandbox has no setTimeout global). A stuck host
    // balance handler must fail this side quickly instead of wedging refresh.
    const balanceWithTimeout = (p: Promise<any>, ms: number, message: string): Promise<any> => {
      const timeoutP = timer.timeout(ms).then(() => { throw new Error(message) })
      return Promise.race([p, timeoutP])
    }
    const refresh = async () => {
      let dirty = false
      try {
        const s = await callHost('save-money/status')
        if (s && typeof s === 'object') {
          const prevBalance = snapshot.balance // keep the last shown balance across polls
          snapshot = s
          snapshot.balance = prevBalance
          dirty = s.balanceDirty === true
          // Keep the UI language in sync with the persisted config choice
          if (s.config && typeof s.config.lang === 'string') currentLang = resolveLang(s.config.lang)
        }
      } catch (e: any) {
        console.error('[save-money] status poll failed: ' + String((e && e.message) || e))
      }
      // Balance updates: on user messages (host sets balanceDirty when a
      // llm/stream request arrives) or every 10 minutes — not on every poll.
      // The host also gates the endpoint when the display is off.
      // 余额刷新:用户发消息(host 置 balanceDirty)立即更新一次;否则每 5 分钟
      // 自动更新一次(定时刷新,不是每次 30s 轮询都打接口)。
      const BALANCE_MS = 5 * 60 * 1000
      const nowMs = Date.now()
      const due = (!lastBalanceAt || nowMs - lastBalanceAt > BALANCE_MS) && nowMs >= nextBalanceAttemptAt
      if (snapshot.config && snapshot.config.showBalance === true && (dirty || due)) {
        try {
          const b = await balanceWithTimeout(callHost('save-money/balance'), 4000, 'balance call timeout')
          // Only a successful response counts as "fetched": a failure keeps the
          // previous value (or null) and leaves lastBalanceAt stale, so the next
          // poll retries instead of waiting 10 minutes for the next refresh.
          if (b && typeof b === 'object' && b.ok === true) {
            snapshot.balance = b
            lastBalanceAt = Date.now()
          } else {
            // Non-ok or unreachable: back off so a failing upstream is not
            // retried every 30s poll.
            nextBalanceAttemptAt = Date.now() + BALANCE_RETRY_MS
          }
        } catch (e: any) {
          console.error('[save-money] balance fetch failed: ' + String((e && (e as any).message) || e))
          nextBalanceAttemptAt = Date.now() + BALANCE_RETRY_MS
        }
      } else if (!(snapshot.config && snapshot.config.showBalance === true)) {
        snapshot.balance = null
        // Re-enabling the display must fetch immediately, not wait for the next
        // 10-minute or message-driven refresh: reset the staleness marker here,
        // otherwise `due` stays false and the balance never reappears.
        lastBalanceAt = 0
        nextBalanceAttemptAt = 0
      }
    }
    void refresh()
    ctx.effect(() => timer.interval(() => { void refresh() }, 30000))

    // useSnap returns [st, setSt]: components can refresh manually (button
    // clicks reflect the new state immediately)
    const useSnap = () => {
      const [st, setSt] = React.useState({ ...snapshot })
      React.useEffect(() => {
        let alive = true
        const tick = async () => { await refresh(); if (alive) setSt({ ...snapshot }) }
        void tick()
        const stop = timer.interval(() => { void tick() }, 30000)
        return () => { alive = false; stop() }
      }, [])
      return [st, setSt]
    }

    // Per-registration actions: doConfigure = RPC + immediate refresh.
    // A failed configure (e.g. the harness restarted and the RPC is gone) must
    // not leave the UI frozen on stale state: we still refresh + re-render so
    // the checkbox reflects what the host actually persisted, and log the error
    // instead of silently swallowing it.
    const makeActions = (setSt: any) => ({
      doConfigure: async (patch: any) => {
        try {
          await callHost('save-money/configure', patch)
        } catch (e: any) {
          console.error('[save-money] configure failed: ' + String((e && e.message) || e))
        }
        try { await refresh() } catch (e) {}
        setSt({ ...snapshot })
      },
      doEndWindow: async () => {
        try {
          await callHost('save-money/end-window')
        } catch (e: any) {
          console.error('[save-money] end-window failed: ' + String((e && e.message) || e))
        }
        try { await refresh() } catch (e) {}
        setSt({ ...snapshot })
      },
    })

    // ---------- Status badge color / text / symbol ----------
    const badgeInfo = (st: any) => {
      const color = !st.enabled ? '#9E9E9E' : st.state === 'PAUSED' ? '#E53935' : st.state === 'WARN' ? '#F9A825' : '#4CAF50'
      const text = !st.enabled ? t('badgeDisabled') : st.state === 'PAUSED' ? t('badgePaused') : st.state === 'WARN' ? t('badgeWarn') : t('badgeWorking')
      const symbol = !st.enabled ? '⚪' : st.state === 'PAUSED' ? '🔴' : st.state === 'WARN' ? '🟡' : '🟢'
      return { color, text, symbol }
    }

    // ---------- Settings panel (ignore on top, single Save at the bottom) ----------
    const SettingsView = (props: any) => {
      const st = props.st
      const doConfigure = props.doConfigure
      const doEndWindow = props.doEndWindow || (async () => {})
      const cfg = st.config || {}
      const [tz, setTz] = React.useState(cfg.timezone || detectedTz)
      // Default windows shown when none are configured (fresh install / all
      // windows deleted) — matches the one-click DeepSeek preset (2-minute
      // boundary margin): 08:58–12:02, 13:58–18:02.
      const DEFAULT_WINS = [
        { pauseAt: '08:58', resumeAt: '12:02' },
        { pauseAt: '13:58', resumeAt: '18:02' },
      ]
      const [wins, setWins] = React.useState(DEFAULT_WINS.map((w: any) => ({ ...w })))
      const [msg, setMsg] = React.useState('')
      const [langSel, setLangSel] = React.useState(cfg.lang || 'auto')
      const prevWinKey = React.useRef('')
      const prevTz = React.useRef(null)
      const prevLang = React.useRef(null)
      React.useEffect(() => {
        // Sync only when the config actually changed (the 30s poll must not
        // interrupt in-progress edits)
        if (cfg.timezone && cfg.timezone !== prevTz.current) {
          prevTz.current = cfg.timezone
          setTz(cfg.timezone)
        }
        const cl = cfg.lang || 'auto'
        if (cl !== prevLang.current) {
          prevLang.current = cl
          setLangSel(cl)
          currentLang = resolveLang(cl)
        }
        const ws = cfg.windows || []
        const key = JSON.stringify(ws)
        if (key !== prevWinKey.current) {
          prevWinKey.current = key
          setWins(ws.length > 0
            ? ws.map((w: any) => ({ pauseAt: w.pauseAt, resumeAt: w.resumeAt }))
            : DEFAULT_WINS.map((w: any) => ({ ...w })))
        }
      }, [st])
      const row = (label: string, children: any) => React.createElement('div', { style: { margin: '8px 0', display: 'flex', alignItems: 'center', gap: '8px' } },
        React.createElement('span', { style: { minWidth: '80px', fontSize: '13px' } }, label), children)
      const input = (value: string, setter: any, width?: string) => React.createElement('input', {
        value, onChange: (e: any) => setter(e.target.value),
        style: {
          width: width || '72px', padding: '3px 6px', fontSize: '13px',
          background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '4px',
        },
      })
      const btn = (text: string, fn: any, primary: boolean) => DSHButton
        ? React.createElement(DSHButton, {
            variant: 'outline',
            size: 'sm',
            onClick: fn,
          }, text)
        : React.createElement('button', {
            onClick: fn,
            style: {
              padding: '6px 14px', cursor: 'pointer', fontSize: '13px',
              background: primary ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-bg-layer-2)',
              color: primary ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-label-primary)',
              border: primary ? 'none' : '1px solid var(--dsw-alias-border-l1)',
              borderRadius: '6px',
            },
          }, text)
      // Window add/remove/edit
      const setWin = (i: number, key: string, val: string) => setWins(wins.map((w: any, j: number) => (j === i ? { ...w, [key]: val } : w)))
      const addWin = () => setWins([...wins, { pauseAt: '08:58', resumeAt: '12:02' }])
      const delWin = (i: number) => setWins(wins.filter((_: any, j: number) => j !== i))
      // One-click apply = dedupe-append (does NOT auto-enable; the user checks
      // the Enable box themselves). The DeepSeek preset windows carry a 2-minute
      // boundary margin — pause 2 min early, resume 2 min late
      // (08:58–12:02, 13:58–18:02, avoiding clock-skew requests slipping
      // through or releasing early at peak boundaries).
      const DEEPSEEK_PRESET = [
        { pauseAt: '08:58', resumeAt: '12:02', timezone: 'Asia/Shanghai' },
        { pauseAt: '13:58', resumeAt: '18:02', timezone: 'Asia/Shanghai' },
      ]
      // Legacy DeepSeek windows (no margin) — removed first on one-click so the
      // overlap validation does not reject the new ones.
      const DEEPSEEK_LEGACY = [
        { pauseAt: '09:00', resumeAt: '12:00', timezone: 'Asia/Shanghai' },
        { pauseAt: '14:00', resumeAt: '18:00', timezone: 'Asia/Shanghai' },
      ]
      const applyDeepSeekPreset = async () => {
        try {
          // WYSIWYG: work from the window list the user currently SEES in the
          // UI (wins), not from whatever was last persisted on the host — so
          // edits made but not yet saved are respected.
          const curTz = (st.config && st.config.timezone) || 'Asia/Shanghai'
          const key = (w: any) => String(w.pauseAt) + '|' + String(w.resumeAt) + '|' + (w.timezone || curTz)
          const legacyKeys = new Set(DEEPSEEK_LEGACY.map(key))
          const cleaned = wins.filter((w: any) => !legacyKeys.has(key(w))) // upgrade legacy windows
          const existing = new Set(cleaned.map(key))
          const add = DEEPSEEK_PRESET.filter((p: any) => !existing.has(key(p)))
          if (add.length === 0) {
            setMsg(t('presetExists'))
            return
          }
          const merged = cleaned.concat(add)
          setWins(merged) // reflect the result in the UI immediately
          await doConfigure({ windows: merged }) // windows only, enabled untouched
          const upgraded = wins.length - cleaned.length
          setMsg((upgraded > 0 ? t('presetUpgraded', { n: upgraded }) : '') + t('presetAdded', { n: add.length }))
        } catch (e: any) {
          setMsg(t('applyFailed') + String((e && e.message) || e))
        }
      }
      // Unified Save at the bottom (replaces the old "apply windows" button)
      const saveAll = () => {
        const clean = wins
          .map((w: any) => ({ pauseAt: String(w.pauseAt || '').trim(), resumeAt: String(w.resumeAt || '').trim() }))
          .filter((w: any) => w.pauseAt !== '' && w.resumeAt !== '')
        void doConfigure({ windows: clean.map((w: any) => ({ ...w, timezone: tz })) })
        setMsg(t('savedMsg', { n: clean.length }))
      }
      const b = badgeInfo(st)
      return React.createElement('div', { style: { padding: '12px' } },
        // Top: status text + end-this-window button (kept near the top; shown
        // only when a window is active — WARN or PAUSED)
        React.createElement('div', { style: { margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          React.createElement('span', { style: { fontSize: '13px', fontWeight: 600, color: b.color } },
            t('statusPrefix') + b.text + (st.state === 'PAUSED' && st.window ? t('windowSuffix', { a: st.window.pauseAt, b: st.window.resumeAt }) : '')),
          (st.state === 'WARN' || st.state === 'PAUSED')
            ? btn(t('endThisWindow'), () => void doEndWindow(), st.state === 'PAUSED')
            : null,
          st.state === 'PAUSED' ? React.createElement('div', { style: { margin: '6px 0', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' } }, t('pausedNote')) : null,
        ),
        // Green status line while "end this save mode" is in effect for the
        // current window (in-memory, one-shot): tells the user what happened
        // and how to reset it.
        st.endWindowUntil ? React.createElement('div', { style: { margin: '6px 0 10px', fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)', fontWeight: 600 } },
          t('endWindowActive', { a: st.window ? st.window.pauseAt : '', b: st.window ? st.window.resumeAt : '', c: st.window ? st.window.resumeAt : '' })) : null,
        btn(t('deepseekPreset'), () => void applyDeepSeekPreset(), true),
        msg ? React.createElement('div', { style: { margin: '8px 0', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, msg) : null,
        row(t('enable'), React.createElement('input', {
          type: 'checkbox', checked: !!st.enabled,
          onChange: (e: any) => void doConfigure({ enabled: e.target.checked }),
          style: { accentColor: 'var(--dsw-alias-brand-primary)', width: 16, height: 16, cursor: 'pointer' },
        })),
        row(t('showBalance'), React.createElement('input', {
          type: 'checkbox', checked: !!cfg.showBalance,
          onChange: (e: any) => void doConfigure({ showBalance: e.target.checked }),
          style: { accentColor: 'var(--dsw-alias-brand-primary)', width: 16, height: 16, cursor: 'pointer' },
        })),
        row(t('timezone'), React.createElement('select', {
          value: tz,
          onChange: (e: any) => {
            const v = e.target.value
            if (!v || v === tz) return
            const oldTz = tz
            setTz(v)
            // WYSIWYG: convert every window from the old timezone to the new
            // one (real timezone rules, DST-aware; e.g. Beijing 08:58 ->
            // London 01:58 in summer, 00:58 in winter). NOT saved yet — the
            // bottom Save button persists timezone + converted times together.
            setWins(wins.map((w: any) => {
              const p = parseHHMM(String(w.pauseAt))
              const r = parseHHMM(String(w.resumeAt))
              return {
                pauseAt: p === null ? String(w.pauseAt || '') : formatHHMM(convertHHMM(oldTz, v, p)),
                resumeAt: r === null ? String(w.resumeAt || '') : formatHHMM(convertHHMM(oldTz, v, r)),
              }
            }))
          },
          style: {
            padding: '3px 6px', fontSize: '13px', maxWidth: '240px',
            background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
            border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '4px',
          },
        },
          // Current timezone first, then the full IANA list sorted by offset
          // (offset computed with today's rules, so DST zones move correctly).
          [tz].concat(ALL_TIMEZONES.filter((x: TzEntry) => x.name !== tz).map((x: TzEntry) => x.name))
            .map((n: string) => {
              const off = TZ_OFF.get(n)
              return React.createElement('option', { key: n, value: n },
                n + (off !== undefined && !Number.isNaN(off) ? ' (' + fmtOff(off) + ')' : ''))
            }),
        )),
        // Language: auto (follow the browser) by default; manual zh/en choice is
        // persisted into the host config (save-money.config.json, `lang` field)
        // so it survives refresh/restart in every plugin form.
        row(t('language'), React.createElement('select', {
          value: langSel,
          onChange: (e: any) => {
            const v = e.target.value
            setLangSel(v)
            currentLang = resolveLang(v)
            void doConfigure({ lang: v })
          },
          style: {
            padding: '3px 6px', fontSize: '13px',
            background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
            border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '4px',
          },
        },
          React.createElement('option', { value: 'auto' }, t('langAuto')),
          React.createElement('option', { value: 'zh' }, t('langZh')),
          React.createElement('option', { value: 'zh-TW' }, t('langZhTw')),
          React.createElement('option', { value: 'en' }, t('langEn')),
          React.createElement('option', { value: 'de' }, t('langDe')),
          React.createElement('option', { value: 'fr' }, t('langFr')),
          React.createElement('option', { value: 'es' }, t('langEs')),
          React.createElement('option', { value: 'it' }, t('langIt')),
          React.createElement('option', { value: 'pt' }, t('langPt')),
          React.createElement('option', { value: 'ja' }, t('langJa')),
          React.createElement('option', { value: 'ko' }, t('langKo')),
        )),
        React.createElement('div', { style: { marginTop: '12px', fontSize: '13px', fontWeight: 600 } },
          t('windowsTitle', { tz, n: wins.length })),
        wins.map((w: any, i: number) => React.createElement('div', { key: i, style: { margin: '6px 0', display: 'flex', alignItems: 'center', gap: '6px' } },
          React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', width: '28px' } }, String(i + 1) + '.'),
          React.createElement('span', { style: { fontSize: '12px' } }, t('pause')),
          input(w.pauseAt, (v: string) => setWin(i, 'pauseAt', v)),
          React.createElement('span', { style: { fontSize: '12px' } }, t('resume')),
          input(w.resumeAt, (v: string) => setWin(i, 'resumeAt', v)),
          React.createElement('button', {
            onClick: () => delWin(i),
            style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px', color: 'var(--dsw-alias-state-error-primary)', padding: '2px 4px' },
            title: t('removeTitle'),
          }, '✕'),
        )),
        React.createElement('div', { style: { margin: '8px 0' } },
          btn(t('addWindow'), () => addWin(), false),
        ),
        // Bottom: plugin name + version on the left, unified Save button
        React.createElement('div', { style: { margin: '10px 0 2px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          React.createElement('span', {
            style: {
              fontSize: '11px', color: 'var(--dsw-alias-label-secondary)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            },
          }, 'save-money v' + PLUGIN_VERSION),
          btn(t('save'), () => saveAll(), true),
        ),
      )
    }

    // ---------- Top floating banner (registered in the header slot,
    //            position:fixed) ----------
    // The button is "End this save mode" — one-shot end for the current
    // window only (in-memory, not persisted; the persistent enabled flag is
    // untouched, so future windows keep saving money).
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
    // ---- Bar chart: last 8h spend per 10 minutes (click the balance) ----
    // Rendered with plain divs (no chart library, theme tokens only). Positive
    // bars (spent) use the error/primary color upward, negative (top-up) use
    // the success color downward. Bars with null history (not yet sampled) are
    // drawn as a faint dot so the feature is visible from the start.
    // Hover tooltip is a CUSTOM floating card (same as the header balance
    // card): instant (no native-title delay), follows the mouse, clamped to the
    // viewport. Bars expose the window time range, the amount, and the
    // external-spend warning.
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
      // ---- 坐标轴数据 ----
      // 正负最大值(绝对值),决定 0 基线与 Y 轴刻度范围
      let maxPos = 0
      let maxNeg = 0
      for (const b of ordered) {
        if (b && typeof b.spent === 'number' && Number.isFinite(b.spent)) {
          if (b.spent > 0 && b.spent > maxPos) maxPos = b.spent
          if (b.spent < 0 && -b.spent > maxNeg) maxNeg = -b.spent
        }
      }
      // Y 轴:用 1/2/5×10^n 关键点步长(用户易读的整数/半整数),上限取覆盖
      // 数据最高点的下一个关键点倍数(略高于最高柱、留白)。刻度数 ≤ 5,
      // 允许更少 —— 网格线、标签、柱高都基于这个统一的上限,读图直观。
      const axis = (() => {
        const span = Math.max(maxPos, maxNeg, 0.001)
        const mag = Math.pow(10, Math.floor(Math.log10(span)))
        let step = 0
        for (const m of [1, 2, 5, 10]) {
          const s = m * mag
          if (Math.ceil(span / s) <= 4) { step = s; break } // 间隔≤4 → 刻度≤5
        }
        if (step === 0) step = 10 * mag
        const topMax = Math.ceil(span / step) * step // 上限略高于最高点
        const ticks: number[] = []
        for (let v = 0; v <= topMax + 1e-9; v += step) {
          const clean = step >= 1 ? Math.round(v) : Math.round(v * 1000) / 1000
          if (clean !== ticks[ticks.length - 1]) ticks.push(clean)
        }
        return { step, topMax, ticks }
      })()
      const yTicks = axis.ticks
      const yMax = axis.topMax // 刻度上限(≥ maxPos)
      // 0 基线位置(距顶部像素):正负按各自刻度上限各占比例
      const zeroY = maxNeg === 0 ? HEIGHT : Math.round(maxNeg / (yMax + maxNeg) * HEIGHT)
      // 每根柱的高度(像素):正柱占 0 线上方空间,负柱占下方,统一按 yMax 归一
      const barH = (v: number): number => {
        if (v > 0) return yMax > 0 ? Math.max(2, Math.round(v / yMax * zeroY)) : 2
        if (v < 0) return maxNeg > 0 ? Math.max(2, Math.round(-v / maxNeg * (HEIGHT - zeroY))) : 2
        return 2
      }
      // 正柱(消费)用 error 色向上;负柱(回升)用 success 色向下;
      // 0 值(确实没消费)用中性边框色,避免与"有消费"混淆;
      // null(未采样)为半透明浅色短点;
      // 正柱且本窗口无本环境活动(activity=false)用 warn 警示色——
      // 下降可能来自其他环境(本机未用却扣款),不当作本环境消费。
      const barStyle = (b: any) => {
        const spent = b ? b.spent : null
        const finite = typeof spent === 'number' && Number.isFinite(spent)
        const value = finite ? (spent as number) : 0
        const zero = finite && value === 0
        const positive = value > 0
        const external = finite && positive && !(b && b.activity)
        return {
          position: 'absolute' as const,
          left: '0',
          right: '0',
          bottom: positive ? '0' : undefined,
          top: positive ? undefined : '0',
          height: barH(value) + 'px',
          margin: '0 1px',
          background: !finite
            ? 'var(--dsw-alias-border-l1)' // faint placeholder for unsampled
            : zero
              ? 'var(--dsw-alias-border-l1)' // truly zero spend → neutral
              : external
                ? 'var(--dsw-alias-state-warn-primary)' // spend without local activity → warn
                : positive
                  ? 'var(--dsw-alias-state-error-primary)'
                  : 'var(--dsw-alias-state-success-primary)',
          opacity: finite ? (zero ? 0.4 : 0.92) : 0.5,
          borderRadius: '1px',
        } as any
      }
      const formatBar = (spent: any) => {
        if (!(typeof spent === 'number' && Number.isFinite(spent))) return '–'
        const abs = Math.abs(spent).toFixed(2)
        return spent >= 0 ? sym + abs : '+' + sym + abs
      }
      // 柱窗口的墙钟起止 "HH:mm–HH:mm",按配置时区显示(与柱边界对齐使用的
      // 时区一致——用户配置哪个时区,看到的就是哪个时区的整数窗口)。
      // fallback:浏览器本地时区。
      const fmtWindow = (at: number, ms: number): string => {
        try {
          const f = (t: number) => {
            try {
              const wc = wallClock(tzShow, new Date(t))
              return String(Math.floor(wc.minutes / 60)).padStart(2, '0') + ':' + String(wc.minutes % 60).padStart(2, '0')
            } catch (e2) {
              const d = new Date(t)
              return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
            }
          }
          return f(at) + '–' + f(at + ms)
        } catch (e) { return '' }
      }
      // 浮动框定位:跟随鼠标,右缘贴鼠标左侧 12px,clamp 在视口内
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
            React.createElement('div', null,
              (tip.b && tip.b.spent !== null && tip.b.spent !== undefined ? formatBar(tip.b.spent) : '–')),
            (tip.b && tip.b.spent !== null && tip.b.spent !== undefined && tip.b.spent >= 0 && !tip.b.activity)
              ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', marginTop: '2px' } }, t('barsExternal'))
              : null,
          )
        : null
      const nowLabel = t('barsHint')
      const fmtTick = (t: number): string => {
        try {
          const wc = wallClock(tzShow, new Date(t))
          return String(Math.floor(wc.minutes / 60)).padStart(2, '0') + ':' + String(wc.minutes % 60).padStart(2, '0')
        } catch (e) {
          const d = new Date(t)
          return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
        }
      }
      const fmtTickVal = (v: number): string => {
        // 浮点清洗:接近整数的值(如 0.6000000000000001)按整数显示
        const cleaned = Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v
        const abs = Math.abs(cleaned)
        const s = abs >= 1000 ? abs.toFixed(0) : abs >= 100 ? abs.toFixed(1) : abs.toFixed(2)
        return (cleaned < 0 ? '-' : '') + s
      }
      // Y 轴刻度定位:刻度值 v 的像素 top = zeroY - (v/yMax)*zeroY。
      // 值越大越靠上,0 恰落在基线上 —— 与柱体视觉一致(统一按 yMax 归一)。
      const yTop = (v: number): number => {
        if (yMax <= 0) return zeroY
        return Math.round(zeroY - (v / yMax) * zeroY)
      }
      // X 轴:整点小时刻度。在柱覆盖的时间范围内找所有整点时刻
      // (HH:00),按柱索引换算成百分比位置 —— 比均匀分布的任意时刻更易读、
      // 与官方后台按整点计费可比。最多取 8 个。
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
      // 布局:左列 Y 轴刻度 + 右列(绘图区 + X 轴)
      return React.createElement('div', { style: { padding: '10px 12px 8px' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'stretch' } },
          // Y 轴刻度列(金额,绝对定位对齐柱高)
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
          // 绘图区 + X 轴
          React.createElement('div', { style: { flex: '1 1 0', minWidth: 0 } },
            React.createElement('div', {
              style: {
                position: 'relative',
                height: HEIGHT + 'px',
                borderBottom: '1px solid var(--dsw-alias-border-l1)',
              },
            },
              // 水平网格线(Y 轴每个刻度一条,虚线;0 基线实线)已在下方渲染,
              // 不再单独画 0 基线(由 v===0 的网格线承担)。
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
              // 柱(每个占 1/48 宽度)
              ordered.map((b: any, i: number) => {
                return React.createElement('div', {
                  key: i,
                  style: {
                    position: 'absolute', top: '0', bottom: '0',
                    left: (i / ordered.length * 100) + '%',
                    width: (100 / ordered.length) + '%',
                  },
                }, React.createElement('div', {
                  style: barStyle(b),
                  onMouseEnter: (e: any) => updateTip(e, b),
                  onMouseMove: (e: any) => updateTip(e, b),
                  onMouseLeave: () => setTip(null),
                }))
              }),
            ),
            // X 轴刻度(整点小时)
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
    // ---- Main UI: session-header right-aligned area (status text + floating
    //      banner in the same slot; the banner no longer uses shell.overlay) ----
    slots.inject('conversation.session.header.utilities', () => slots.register(
      { name: 'conversation.session.header.utilities', id: 'save-money-status-text', order: 5 },
      () => {
        const [st, setSt] = useSnap()
        const [open, setOpen] = React.useState(false)
        const [barsOpen, setBarsOpen] = React.useState(false)
        const actions = makeActions(setSt)
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
        // The full detail (balance + spend stats) is a custom hover card:
        // native `title` tooltips get clipped at the viewport edge and cannot
        // wrap, so the long text was invisible. The card follows the mouse and
        // extends LEFT from the cursor (the balance sits at the right edge of
        // the header), clamped so it never leaves the viewport.
        const balTipInit: any = null
        const [balTip, setBalTip] = React.useState(balTipInit)
        const updateBalTip = (e: any) => {
          const vw = typeof window !== 'undefined' && window && typeof window.innerWidth === 'number' ? window.innerWidth : 1024
          const vh = typeof window !== 'undefined' && window && typeof window.innerHeight === 'number' ? window.innerHeight : 768
          const x = typeof e.clientX === 'number' ? e.clientX : vw
          const y = typeof e.clientY === 'number' ? e.clientY : 0
          // 卡片右缘贴在鼠标左侧 12px 处、向左延伸;用 clamp 保证右缘不会
          // 超出视口右缘,鼠标靠近屏幕左侧时也不会跑到屏幕外。
          const right = Math.max(8, Math.min(vw - 8, vw - x + 12))
          const top = Math.max(8, Math.min(y + 14, vh - 180))
          setBalTip({ right, top })
        }
        // Balance visibility follows the MOST RECENT model request (dynamic
        // multi-provider setups): show only while the latest actual request ran
        // on the official DeepSeek provider. A provider switch hides the
        // balance WITHOUT clearing the sampled history, so switching back to
        // DeepSeek re-shows it immediately. `provider` is null before any
        // request (fresh session) — show then too, the official account is
        // queryable.
        const balVisible = !!(st.balance && typeof st.balance === 'object'
          && st.balance.ok === true
          && (st.balance.provider === null || st.balance.provider === undefined || st.balance.provider === 'deepseek-official'))
        const balanceEl = balVisible ? renderBalanceElement(st.balance, React) : null
        const balCard = (() => {
          if (!balTip || !balanceEl) return null
          const lines = balanceDetailLines(st.balance, { h1: t('spendH1'), m10: t('spendM10'), h24: t('spendH24') })
          if (!lines) return null
          // 给 m10/h1 行追加精确时间窗口(与柱形图同源、同对齐基准):
          // "近1h消费 07:00–08:00 ¥1.25"。h24 跨天,不加范围避免歧义。
          const sa = st.balance && st.balance.spendAt
          if (sa && typeof sa.m10 === 'number' && typeof sa.h1 === 'number') {
            try {
              const tzShow = (st.config && typeof st.config.timezone === 'string' && st.config.timezone.length > 0)
                ? st.config.timezone
                : detectedTz
              const fmt = (t: number) => {
                const wc = wallClock(tzShow, new Date(t))
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
                // bg-layer-2:亮色=纯白,暗色=协调深色,随主题自动切换
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
                  setBalTip(null) // 打开弹窗时清掉 hover 卡片,避免遮挡
                  setBarsOpen((v: any) => {
                    const opening = !v
                    if (opening) {
                      // 打开柱形图时强制刷新一次,确保图表反映最新采样
                      // (host 5 分钟定时器采样后不会主动推给 client)。
                      void refresh()
                    }
                    return !v
                  }) // 再次点击关闭(toggle)
                },
              }, balanceEl, balCard)
            : null,
          pop,
          chartPopup,
          React.createElement(FloatingBanner, { st, doEndWindow: actions.doEndWindow }),
        )
      }
    ))

    // ---- System settings page (settings.section, kept) ----
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'save-money', order: 25, label: t('sectionLabel') },
      () => {
        const [st, setSt] = useSnap()
        const actions = makeActions(setSt)
        return React.createElement('div', { style: { padding: '12px' } },
          React.createElement('h3', { style: { margin: '0 0 12px', fontSize: '15px' } }, t('settingsHeading')),
          React.createElement(SettingsView, { st, ...actions }),
        )
      }
    ))
  },
}

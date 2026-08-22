/**
 * dsh-save-money — Dynamic tools registration (Host side).
 *
 * The four save-money tools (status / configure / end-window / debug-tick),
 * registered through the harness in the dynamic-plugin sandbox and through
 * the ctx.tools service in the official module (plugin/index.js) form.
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive; everything needed arrives through the `deps` object.
 */

/**
 * Register every save-money tool for one plugin instance.
 * @param deps.harnessApi - harness global in the dynamic sandbox (or null).
 * @param deps.ctx - plugin context (ctx.get for the tools service).
 * @param deps.status - () => current status object.
 * @param deps.configure - (args) => applyConfig(unwrap(args) || {}).
 * @param deps.onTick - () => run one state-machine transition (debug tool).
 * @param deps.endWindowHandler - () => Promise<new status>.
 */
export function createToolRegistrar(deps: any): void {
  const harnessApi = deps.harnessApi
  const ctx = deps.ctx
  const TOOL_DEFS: any[] = [
    {
      name: 'save_money_status',
      description: 'Query the save-money plugin state: enabled, gate state (NORMAL/WARN/PAUSED), busy detection, current window with UTC projection, PauseRecord summary, and full config.',
      parameters: { type: 'object', properties: {} },
      execute: async () => deps.status(),
    },
    {
      name: 'save_money_configure',
      description: 'Set the save-money plugin configuration. Partial patch: enabled (bool), timezone (IANA name), warnMinutes (number), reconcileOnStart (bool), lang (auto/zh/zh-TW/en/de/fr/es/it/pt/ja/ko), showBalance (bool, shows the DeepSeek account balance in the header; off by default), activeDays (array of ISO weekday ints 1-7, may be empty = never pause; default [1,2,3,4,5] Mon-Fri), modelApply (object of booleans: official-flash / official-pro / official-vision / other-flash / other-pro / other-vision — official = the DeepSeek official API, other = every non-official provider (opencode, relays, ...); checked = pause this model tier inside windows, unchecked = exempt), windows (array of {pauseAt, resumeAt, days?, timezone?}, HH:mm wall-clock in the window timezone). Validates, stores in memory, and persists to the workspace config file. Returns the applied config.',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          timezone: { type: 'string' },
          warnMinutes: { type: 'number' },
          reconcileOnStart: { type: 'boolean' },
          lang: { type: 'string' },
          showBalance: { type: 'boolean' },
          activeDays: { type: 'array', items: { type: 'number' } },
          modelApply: {
            type: 'object',
            properties: {
              'official-flash': { type: 'boolean' },
              'official-pro': { type: 'boolean' },
              'official-vision': { type: 'boolean' },
              'other-flash': { type: 'boolean' },
              'other-pro': { type: 'boolean' },
              'other-vision': { type: 'boolean' },
            },
          },
          windows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pauseAt: { type: 'string' },
                resumeAt: { type: 'string' },
                days: { type: 'array', items: { type: 'number' } },
                timezone: { type: 'string' },
              },
            },
          },
        },
      },
      execute: async (args: any) => deps.configure(args),
    },
    {
      name: 'save_money_end_window',
      description: 'End save mode for the currently active pause window only (one-shot, in-memory, not persisted): if paused, immediately resumes frozen goals and releases the request gate; if a pause is upcoming, cancels it. The window is skipped until its resumeAt. The next window (today or later) still takes effect; the persistent enabled flag is untouched. Returns the new status.',
      parameters: { type: 'object', properties: {} },
      execute: async () => deps.endWindowHandler(),
    },
    {
      name: 'save_money_debug_tick',
      description: 'Development tool: run one state-machine transition manually (as if a tick fired now). Returns the new status. Useful to verify freeze/resume without waiting for the timer.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        deps.onTick()
        return deps.status()
      },
    },
  ]
  for (const def of TOOL_DEFS) {
    const tool = {
      ...def,
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args: any, result: any) => [{ type: 'text', text: JSON.stringify(result) }],
      },
    }
    if (harnessApi) {
      ctx.effect(() => harnessApi.registerTool(ctx, harnessApi.defineTool(tool)))
    } else {
      const tools = ctx.get('tools')
      if (tools && typeof tools.register === 'function') ctx.effect(() => tools.register(tool))
    }
  }
}

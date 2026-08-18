/**
 * dsh-save-money — HTTP endpoints for the official bundle Client half
 * (Host side).
 *
 * The bundled Client half (plugin/client.js, no harness global) talks to the
 * same-origin webServer endpoints registered here (/save-money/*). The
 * dynamic-plugin Client half keeps using the harness RPC and never registers
 * routes on the host's global webServer.
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive; everything needed arrives through the `deps` object.
 */

/**
 * Register the /save-money/* endpoints on a webServer service.
 * @param ws - the webServer service (or undefined before it exists).
 * @param deps.status - () => current status object.
 * @param deps.balanceQuery - () => Promise<balance response>.
 * @param deps.applyConfig - (patch) => applied config.
 * @param deps.endWindowHandler - () => Promise<new status>.
 * @returns the webServer disposer, or undefined when ws is unusable.
 */
export function registerHttpEndpoints(ws: any, deps: any): (() => void) | void {
  if (!ws || typeof ws.register !== 'function') return
  const sendJson = (res: any, code: number, obj: any) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  return ws.register({
    kind: 'prefix',
    path: '/save-money',
    handler: async (req: any, res: any) => {
      try {
        const rawPath = String(req.url || '/').split('?')[0]
        const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath
        if (path === '/save-money/status') {
          sendJson(res, 200, deps.status())
          return
        }
        if (path === '/save-money/balance') {
          sendJson(res, 200, await deps.balanceQuery())
          return
        }
        if (req.method === 'POST' && path === '/save-money/configure') {
          let raw = ''
          for await (const chunk of req) raw += chunk
          let patch: any = {}
          try { patch = JSON.parse(raw || '{}') } catch (e) { patch = {} }
          sendJson(res, 200, deps.applyConfig(patch))
          return
        }
        if (req.method === 'POST' && path === '/save-money/end-window') {
          for await (const _ of req) { /* drain */ }
          sendJson(res, 200, await deps.endWindowHandler())
          return
        }
        sendJson(res, 404, { ok: false, message: 'not found: ' + path })
      } catch (e: any) {
        sendJson(res, 500, { ok: false, message: String((e && e.message) || e) })
      }
    },
  })
}

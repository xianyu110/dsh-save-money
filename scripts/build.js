/**
 * build.js — Compile the TypeScript plugin sources into plain-JS plugin bodies.
 *
 * Dynamic Cordis plugins only accept plain JavaScript function bodies
 * (no TypeScript, no imports, no bundling). Sources:
 *   - src/core.ts         → dist/core.js         (ESM module; unit-tested)
 *   - src/balance-host.ts → dist/balance-host.js (ESM module; unit-tested)
 *   - src/balance-client.ts → dist/balance-client.js (ESM module; unit-tested)
 *   - src/host.ts         → dist/host.js   (plugin body; core + balance-host inlined)
 *   - src/client.ts       → dist/client.js (plugin body; core + balance-client inlined)
 *
 * Inlining: the helper modules are transpiled first, their `export` statements
 * are stripped, and the resulting declarations are injected into the plugin
 * body before the top-level `return {` — so the dynamic plugin stays a single
 * import-free file while the logic lives in testable modules.
 *
 * Usage: node scripts/build.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const distDir = join(root, 'dist')

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
}

/** Transpile one TS source; exit(1) on any error-level diagnostic. */
function transpile(name) {
  const source = readFileSync(join(srcDir, name + '.ts'), 'utf8')
  const result = ts.transpileModule(source, {
    compilerOptions,
    fileName: name + '.ts',
    reportDiagnostics: true,
  })
  let failed = false
  if (result.diagnostics && result.diagnostics.length > 0) {
    for (const d of result.diagnostics) {
      if (d.category === ts.DiagnosticCategory.Error) {
        failed = true
        console.error('[build] ' + name + '.ts: ' + ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      }
    }
  }
  if (failed) {
    console.error('[build] ' + name + '.ts: transpile failed, aborting')
    process.exit(1)
  }
  return result.outputText
}

/** Strip ESM export syntax from a transpiled helper body. */
function stripExports(js) {
  return js
    .replace(/^export \{\s*[\s\S]*?\}\s*;\s*$/m, '') // trailing `export { ... };`
    .replace(/^export function /gm, 'function ')
    .replace(/^export const /gm, 'const ')
    .replace(/^export /gm, '')
}

mkdirSync(distDir, { recursive: true })

// Plugin version for the client footer (replaces the '__VERSION__' placeholder
// in src/client.ts). Read from the root package.json so the displayed version
// always matches the shipped manifest.
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const PLUGIN_VERSION = String(rootPkg.version || '0.0.0')
const injectVersion = (js) => js.split('__VERSION__').join(PLUGIN_VERSION)

// dist/*.js — ESM modules used by the unit tests (transpile once, reuse below)
const core = transpile('core')
const balanceHost = transpile('balance-host')
const balanceClient = transpile('balance-client')
writeFileSync(join(distDir, 'core.js'), core, 'utf8')
writeFileSync(join(distDir, 'balance-host.js'), balanceHost, 'utf8')
writeFileSync(join(distDir, 'balance-client.js'), balanceClient, 'utf8')
console.log('[build] core.ts -> dist/core.js (' + core.length + ' bytes)')
console.log('[build] balance-host.ts -> dist/balance-host.js (' + balanceHost.length + ' bytes)')
console.log('[build] balance-client.ts -> dist/balance-client.js (' + balanceClient.length + ' bytes)')

// dist/host.js — plugin body with core + balance-host helpers inlined
const hostJs = transpile('host')
const inlineMarker = '\nreturn {'
const idx = hostJs.indexOf(inlineMarker)
if (idx < 0) {
  console.error('[build] host.ts: no top-level "return {" found')
  process.exit(1)
}
const hostWithCore = hostJs.slice(0, idx) + '\n' + stripExports(core) + stripExports(balanceHost) + hostJs.slice(idx)
writeFileSync(join(distDir, 'host.js'), hostWithCore, 'utf8')
console.log('[build] host.ts -> dist/host.js (core + balance-host inlined, ' + hostWithCore.length + ' bytes)')

// dist/client.js — plugin body with core + balance-client helpers inlined
const clientJs = injectVersion(transpile('client'))
const clientIdx = clientJs.indexOf(inlineMarker)
if (clientIdx < 0) {
  console.error('[build] client.ts: no top-level "return {" found')
  process.exit(1)
}
const clientWithCore = clientJs.slice(0, clientIdx) + '\n' + stripExports(core) + stripExports(balanceClient) + clientJs.slice(clientIdx)
writeFileSync(join(distDir, 'client.js'), clientWithCore, 'utf8')
console.log('[build] client.ts -> dist/client.js (core + balance-client inlined, ' + clientWithCore.length + ' bytes)')

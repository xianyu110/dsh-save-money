/**
 * build.js — Compile the TypeScript plugin sources into plain-JS plugin bodies.
 *
 * Dynamic Cordis plugins only accept plain JavaScript function bodies
 * (no TypeScript, no imports, no bundling). Sources:
 *   - src/core.ts   → dist/core.js   (ESM module; unit-tested via node:test)
 *   - src/host.ts   → dist/host.js   (plugin body; core helpers inlined)
 *   - src/client.ts → dist/client.js (plugin body)
 *
 * Inlining: core.ts is transpiled first, its `export` statements are stripped,
 * and the resulting function declarations are injected into the host body
 * before the top-level `return {` — so the dynamic plugin stays a single
 * import-free file while the logic lives in one testable module.
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

/** Strip ESM export syntax from a transpiled core body. */
function stripExports(js) {
  return js
    .replace(/^export \{\s*[\s\S]*?\}\s*;\s*$/m, '') // trailing `export { ... };`
    .replace(/^export function /gm, 'function ')
    .replace(/^export const /gm, 'const ')
    .replace(/^export /gm, '')
}

mkdirSync(distDir, { recursive: true })

// dist/core.js — ESM module used by the unit tests
const coreJs = transpile('core')
writeFileSync(join(distDir, 'core.js'), coreJs, 'utf8')
console.log('[build] core.ts -> dist/core.js (' + coreJs.length + ' bytes)')

// dist/host.js — plugin body with the core helpers inlined
const hostJs = transpile('host')
const inlineMarker = '\nreturn {'
const idx = hostJs.indexOf(inlineMarker)
if (idx < 0) {
  console.error('[build] host.ts: no top-level "return {" found')
  process.exit(1)
}
const hostWithCore = hostJs.slice(0, idx) + '\n' + stripExports(coreJs) + hostJs.slice(idx)
writeFileSync(join(distDir, 'host.js'), hostWithCore, 'utf8')
console.log('[build] host.ts -> dist/host.js (core inlined, ' + hostWithCore.length + ' bytes)')

// dist/client.js — plugin body (i18n UI) with the core helpers inlined
const clientJs = transpile('client')
const clientIdx = clientJs.indexOf(inlineMarker)
if (clientIdx < 0) {
  console.error('[build] client.ts: no top-level "return {" found')
  process.exit(1)
}
const clientWithCore = clientJs.slice(0, clientIdx) + '\n' + stripExports(coreJs) + clientJs.slice(clientIdx)
writeFileSync(join(distDir, 'client.js'), clientWithCore, 'utf8')
console.log('[build] client.ts -> dist/client.js (core inlined, ' + clientWithCore.length + ' bytes)')

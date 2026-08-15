/**
 * typecheck.js — Type-check the TypeScript plugin bodies.
 *
 * The src/*.ts files are plugin BODIES (top-level `return { ... }`), which the
 * TypeScript compiler rejects with TS1108 ("return outside function body").
 * To type-check them we rewrite the top-level `return {` into
 * `const __plugin: any = {` — the object literal keeps its inferred type and
 * every other top-level declaration (interfaces, declares, helpers) stays
 * valid. The check runs on copies in a temp dir, never touching src/.
 *
 * Usage: node scripts/typecheck.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmpDir = join(tmpdir(), 'dsh-save-money-typecheck')

function basename(p) {
  return p.split(/[\\/]/).pop()
}

const options = {
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts'],
  module: ts.ModuleKind.ESNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
}

const rootNames = []
// src/core.ts is a regular ESM module — type-check it as-is.
rootNames.push(join(root, 'src', 'core.ts'))
for (const name of ['host', 'client']) {
  const src = readFileSync(join(root, 'src', name + '.ts'), 'utf8')
  const marker = '\nreturn {'
  const idx = src.indexOf(marker)
  if (idx < 0) {
    console.error('[typecheck] ' + name + '.ts: no top-level "return {" found')
    process.exit(1)
  }
  const head = src.slice(0, idx) // declares, interfaces, helpers
  const body = src.slice(idx + marker.length) // object literal + trailing brace
  // Preamble: sandbox globals (console, harness) + make each file a module so
  // __plugin never collides across files.
  const preamble = 'declare const console: any\ndeclare const harness: any\n'
  const wrapped = preamble + head + '\nconst __plugin: any = {' + body + '\nexport {}\n'
  const tmpFile = join(tmpDir, name + '.ts')
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(tmpFile, wrapped, 'utf8')
  rootNames.push(tmpFile)
}

const program = ts.createProgram(rootNames, options)
const diags = ts.getPreEmitDiagnostics(program)
if (diags.length > 0) {
  for (const d of diags) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
    const loc = d.file ? basename(d.file.fileName) + (d.start != null ? ':' + (d.file.getLineAndCharacterOfPosition(d.start).line + 1) : '') : ''
    console.error('[typecheck] ' + loc + ' ' + msg)
  }
  process.exit(1)
}
console.log('[typecheck] OK')

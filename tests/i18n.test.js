/**
 * i18n.test.js — Locale dictionary consistency checks.
 *
 * Every locale file (src/i18n/<lang>.ts) must export exactly the same set of
 * keys, otherwise a missing translation silently falls back to English
 * (i18n/index.ts t()). This test reads the SOURCE files (no dist build
 * needed) and compares the key sets structurally.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const i18nDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n')
const LOCALES = ['zh', 'zh-TW', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ja', 'ko']

/** Extract the dictionary keys from one locale file's source text. */
function keysOf(lang) {
  const text = readFileSync(join(i18nDir, lang + '.ts'), 'utf8')
  const keys = []
  for (const m of text.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*'/gm)) keys.push(m[1])
  return keys
}

test('i18n: every locale exports the same key set', () => {
  const sets = Object.fromEntries(LOCALES.map((l) => [l, new Set(keysOf(l))]))
  const base = LOCALES[0]
  const missing = {}
  for (const l of LOCALES.slice(1)) {
    const diff = [...sets[base]].filter((k) => !sets[l].has(k))
    if (diff.length > 0) missing[l] = diff
  }
  assert.deepEqual(missing, {}, 'locales missing keys vs ' + base)
})

test('i18n: no duplicate keys inside one locale', () => {
  for (const l of LOCALES) {
    const keys = keysOf(l)
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
    assert.deepEqual(dupes, [], l + ' has duplicate keys')
  }
})

test('i18n: the aggregator references every locale export', () => {
  const idx = readFileSync(join(i18nDir, 'index.ts'), 'utf8')
  const merged = (idx.match(/I18N:\s*Record<Lang,\s*Dict>\s*=\s*\{([\s\S]*?)\}/) || [])[1] || ''
  for (const l of LOCALES) {
    const exportName = l === 'zh-TW' ? 'zhTW' : l
    assert.ok(new RegExp('\\b' + exportName + '\\b').test(merged), 'I18N missing ' + l)
  }
})

#!/usr/bin/env node
/**
 * release.js — one-command release automation for dsh-save-money.
 *
 * The script owns EVERY place the version number appears, so a release is a
 * single command (no manual find-and-replace):
 *   - in-app version  : root package.json → build injects it into the client
 *                       footer (plugin/client.js PLUGIN_VERSION)
 *   - npm package     : plugin/package.json
 *   - README install  : every `dsh-save-money-<x.y.z>.tgz` in README.md and
 *                       README.zh.md (both languages)
 *   - test assertion  : tests/official.test.js
 *   - git tag         : v<version> (created + pushed)
 *   - npm publish     : ./plugin
 *
 * Steps (in order, each printed before it runs):
 *   1. sanity: working tree must be clean; the --version argument is required
 *   2. bump: package.json + plugin/package.json + the version assertion in
 *      tests/official.test.js
 *   3. README: rewrite every dsh-save-money-*.tgz to the new version (both
 *      README.md and README.zh.md)
 *   4. build + run the full test suite
 *   5. git commit (message includes the version), tag v<version>
 *   6. git push origin main --tags
 *   7. npm publish ./plugin
 *
 * README handling: npm only packs files INSIDE plugin/, so the publish step
 * copies the repo-root README.md to plugin/README.md right before publishing
 * and removes it immediately after (even on failure). The README never stays
 * in plugin/ and is never committed (plugin/README.md is gitignored) — there
 * is exactly one README in the repo, at the root.
 *
 * Zero third-party dependencies (Node built-ins only) — nothing is installed,
 * and this script lives in scripts/ so it never enters the npm package
 * (plugin/package.json files[] whitelist controls what is packed).
 *
 * Usage:
 *   node scripts/release.js --version 1.4.3 --dry-run          # rehearsal only
 *   node scripts/release.js --version 1.4.3 --proxy http://host:port   # full run via proxy
 *
 * Options:
 *   --version <x.y.z>  target version (required, semver x.y.z)
 *   --proxy <url>      HTTP proxy for git push and npm publish (e.g.
 *                      http://proxy-host:port — pass your own, never commit a
 *                      real address); git uses -c http.proxy,
 *                      npm gets HTTP(S)_PROXY env vars
 *   --dry-run          print every command without executing anything
 *   --skip-tests       skip the build+test step (CI or time constraints)
 *   --no-publish       stop after git push (do not npm publish)
 *   --no-push          stop after the local commit + tag (no remote ops)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

const valueOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
const has = (name) => args.includes(name)
const version = valueOf('--version')
const proxy = valueOf('--proxy')
const dryRun = has('--dry-run')
const skipTests = has('--skip-tests')
const noPublish = has('--no-publish')
const noPush = has('--no-push')

const SEMVER = /^\d+\.\d+\.\d+$/
const run = (cmd, opts = {}) => {
  const label = cmd.length > 160 ? cmd.slice(0, 157) + '...' : cmd
  console.log(dryRun ? '[dry-run] would run: ' + label : '[run] ' + label)
  if (!dryRun) {
    const env = { ...process.env }
    if (proxy) {
      env.HTTP_PROXY = proxy
      env.HTTPS_PROXY = proxy
    }
    execSync(cmd, { stdio: 'inherit', cwd: opts.cwd || root, env })
  }
}

const fail = (msg) => {
  console.error('[release] ERROR: ' + msg)
  process.exit(1)
}

if (!version) fail('missing --version <x.y.z>')
if (!SEMVER.test(version)) fail('--version must look like x.y.z, got: ' + version)
if (noPush && noPublish) fail('--no-push already stops before publish; --no-publish is redundant')

// 1. Working tree must be clean — a release should never carry uncommitted
//    changes (except the ones this script itself is about to create).
console.log('--- [1/7] sanity checks ---')
try {
  const dirty = execSync('git status --porcelain', { encoding: 'utf8', cwd: root }).trim()
  if (dirty) fail('working tree is not clean:\n' + dirty + '\nCommit or stash first, then re-run.')
} catch (e) {
  fail('cannot run git: ' + String(e && e.message))
}
const pkgPath = join(root, 'package.json')
const pluginPkgPath = join(root, 'plugin', 'package.json')
const testPath = join(root, 'tests', 'official.test.js')
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8')

// 2. Version bump (3 places).
console.log('--- [2/7] version bump to ' + version + ' ---')
const bump = () => {
  const rootPkg = readJson(pkgPath)
  const oldV = rootPkg.version
  rootPkg.version = version
  writeJson(pkgPath, rootPkg)
  const pluginPkg = readJson(pluginPkgPath)
  pluginPkg.version = version
  writeJson(pluginPkgPath, pluginPkg)
  const testSrc = readFileSync(testPath, 'utf8')
  const nextTest = testSrc.replace(/assert\.equal\(pkg\.version, '[^']+'\)/, `assert.equal(pkg.version, '${version}')`)
  if (!nextTest.includes(`pkg.version, '${version}'`)) fail('could not update the version assertion in ' + testPath)
  writeFileSync(testPath, nextTest, 'utf8')
  console.log('  package.json + plugin/package.json + tests/official.test.js version -> ' + version + ' (was ' + oldV + ')')
}
if (!dryRun) bump()

// 3. README: keep the install examples in sync with the new version.
console.log('--- [3/7] README version sync ---')
const updateReadmeVersions = () => {
  const tgzRe = /dsh-save-money-\d+\.\d+\.\d+\.tgz/g
  for (const f of ['README.md', 'README.zh.md']) {
    const p = join(root, f)
    const text = readFileSync(p, 'utf8')
    const next = text.replace(tgzRe, 'dsh-save-money-' + version + '.tgz')
    if (next !== text) {
      writeFileSync(p, next, 'utf8')
      console.log('  ' + f + ': dsh-save-money-*.tgz -> dsh-save-money-' + version + '.tgz')
    } else {
      console.log('  ' + f + ': no tgz references to update')
    }
  }
}
if (!dryRun) updateReadmeVersions()

// 4. Build + tests.
console.log('--- [4/7] build + tests ---')
if (!skipTests) run('npm run prepare && node --test tests/core.test.js tests/balance.test.js tests/official.test.js tests/i18n.test.js', { cwd: root })

// 5. Commit + tag.
console.log('--- [5/7] git commit + tag v' + version + ' ---')
const commitMsg = `feat: release v${version}`
run('git add -A', { cwd: root })
run('git commit -m ' + JSON.stringify(commitMsg), { cwd: root })
run('git tag v' + version, { cwd: root })

// 6. Push (via proxy when given).
console.log('--- [6/7] git push ---')
if (noPush) {
  console.log('  --no-push: stopping after the local commit + tag')
} else {
  const proxyArg = proxy ? ' -c http.proxy=' + proxy : ''
  run('git' + proxyArg + ' push origin main --tags', { cwd: root })
}

// 7. npm publish — with a TEMPORARY plugin/README.md (copied from the root,
//    removed right after, even on failure) so the tarball ships the docs
//    without leaving a permanent copy in plugin/.
console.log('--- [7/7] npm publish ./plugin ---')
if (noPush || noPublish) {
  console.log('  skipped by ' + (noPush ? '--no-push' : '--no-publish'))
} else {
  const readmeTmp = join(root, 'plugin', 'README.md')
  writeFileSync(readmeTmp, readFileSync(join(root, 'README.md'), 'utf8'))
  try {
    run('npm publish ./plugin', { cwd: root })
  } finally {
    try { execSync('del /f /q ' + JSON.stringify(readmeTmp), { cwd: root }) } catch (e) {
      try { execSync('rm -f ' + JSON.stringify(readmeTmp), { cwd: root }) } catch (e2) { /* best-effort */ }
    }
  }
}

console.log(dryRun
  ? '[dry-run] done — nothing was executed. Re-run without --dry-run to release v' + version + '.'
  : '[release] v' + version + ' released: commit + tag + push' + (noPush || noPublish ? ' (publish skipped)' : ' + npm publish') + '.')

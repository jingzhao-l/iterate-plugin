/**
 * test/package-contract.test.ts — release-contract guards for `package.json`.
 *
 * `package.json` is the single source of truth for dsh release compatibility
 * (`dsh.compatibility.dshReleases`), for the aligned `@deepseek-ai/*` versions,
 * and for the published file surface. Both READMEs claim to mirror that field
 * verbatim, and the committed `dist/` build must stay in step with `src/`.
 * None of that was machine-checked before, so a release could ship with a
 * stale compatibility list, a half-bumped dsh dependency set (npm then fails
 * peer resolution at install time), a `version` mismatch between
 * `package.json` and `package-lock.json`, or a `dist/` tree missing a source
 * module. These tests pin all four.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join, relative } from 'node:path'
import { readdirSync } from 'node:fs'
import { clientSourceDigest, DIGEST_MARKER } from '../scripts/client-digest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dsh: {
    compatibility: { dshReleases: Record<string, string> }
    client?: { inject?: string[] }
    bundle?: { patch?: string }
  }
  files?: string[]
  exports?: Record<string, unknown>
  engines?: Record<string, string>
}
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
  version: string
  packages?: Record<string, { version?: string }>
}
const readmeEn = readFileSync(join(root, 'README.md'), 'utf8')
const readmeZh = readFileSync(join(root, 'README.zh-CN.md'), 'utf8')

/** Backticked tokens inside a delimited segment. */
function tokensBetween(text: string, start: string, end: string): string[] {
  const from = text.indexOf(start)
  assert.notEqual(from, -1, `marker not found: ${start}`)
  const to = text.indexOf(end, from)
  assert.notEqual(to, -1, `end marker not found: ${end}`)
  return [...text.slice(from + start.length, to).matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
}

describe('package.json ↔ README compatibility mirror', () => {
  const releases = Object.keys(pkg.dsh.compatibility.dshReleases)

  it('keeps every declared dshReleases entry marked compatible', () => {
    for (const [release, status] of Object.entries(pkg.dsh.compatibility.dshReleases)) {
      assert.equal(status, 'compatible', `${release} must be compatible`)
    }
    assert.ok(releases.length >= 19, 'expected the compatibility list to keep growing')
  })

  it('mirrors the release list verbatim in README.md', () => {
    const listed = tokensBetween(readmeEn, 'declared `compatible`:', ' (')
    assert.deepEqual(listed, releases, 'README.md compatibility list drifted from package.json')
    const count = /\((\d+) releases/.exec(readmeEn)
    assert.ok(count, 'README.md is missing the "(N releases …)" summary')
    assert.equal(Number(count![1]), releases.length, 'README.md release count drifted')
  })

  it('mirrors the release list verbatim in README.zh-CN.md', () => {
    const listed = tokensBetween(readmeZh, '声明为 `compatible`：', '（共')
    assert.deepEqual(listed, releases, 'README.zh-CN.md compatibility list drifted from package.json')
    const count = /共 (\d+) 个版本/.exec(readmeZh)
    assert.ok(count, 'README.zh-CN.md is missing the "共 N 个版本" summary')
    assert.equal(Number(count![1]), releases.length, 'README.zh-CN.md release count drifted')
  })

  it('states the same build target version in both READMEs', () => {
    const target = releases[releases.length - 1]!
    assert.match(
      readmeEn,
      new RegExp(`\`@deepseek-ai/dsh-util-values\` \`${target.replace(/\./g, '\\.')}\``),
      'README.md build-target version drifted',
    )
    assert.match(
      readmeZh,
      new RegExp(`\`@deepseek-ai/dsh-util-values\` \`${target.replace(/\./g, '\\.')}\` 构建`),
      'README.zh-CN.md build-target version drifted',
    )
  })
})

describe('aligned @deepseek-ai/* dependency versions', () => {
  const all = { ...pkg.dependencies, ...pkg.devDependencies }
  const dshVersions = new Set(
    Object.entries(all)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([, version]) => version),
  )

  it('pins every @deepseek-ai/dsh-* package to a single version', () => {
    assert.equal(
      dshVersions.size,
      1,
      `dsh packages must move in lockstep, found: ${[...dshVersions].join(', ')}`,
    )
  })

  it('targets the newest release declared compatible', () => {
    const target = [...dshVersions][0]
    const newest = Object.keys(pkg.dsh.compatibility.dshReleases).at(-1)
    assert.equal(target, newest, 'dependency version must equal the newest dshReleases entry')
  })

  it('keeps @deepseek-ai/cordis on the peer range the target dsh release requires', () => {
    assert.match(all['@deepseek-ai/cordis']!, /^~?\d+\.\d+\.\d+/, 'cordis must stay a concrete range')
  })
})

describe('engines.dsh compatibility range', () => {
  const releases = Object.keys(pkg.dsh.compatibility.dshReleases)

  it('declares engines.dsh as a semver range', () => {
    const range = pkg.engines?.dsh
    assert.ok(range, 'engines.dsh must be declared (dsh ≥ 0.2.1-alpha.4 evaluates it first)')
    assert.equal(typeof range, 'string', 'engines.dsh must be a string range')
    assert.match(range!, /^\s*>=\s*\d+\.\d+\.\d+/, 'engines.dsh must be a ">=X.Y.Z" range')
  })

  it('anchors the range lower bound to the oldest declared-compatible release', () => {
    const range = pkg.engines?.dsh!
    const lowerBound = />=\s*([\w.-]+)/.exec(range)![1]!
    assert.equal(
      lowerBound,
      releases[0],
      'engines.dsh lower bound must equal the oldest dshReleases entry',
    )
  })
})

describe('package-lock.json ↔ package.json version lockstep', () => {
  it('agrees on the package version', () => {
    assert.equal(lock.version, pkg.version, 'package-lock.json version drifted from package.json')
    assert.equal(lock.packages?.['']?.version, pkg.version, 'lock root package version drifted')
  })

  it('agrees on every direct dependency version', () => {
    const rootEntry = lock.packages?.[''] ?? {}
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      assert.equal(
        (rootEntry as Record<string, Record<string, string> | undefined>)[
          pkg.dependencies?.[name] !== undefined ? 'dependencies' : 'devDependencies'
        ]?.[name],
        version,
        `lockfile declaration for ${name} drifted`,
      )
    }
  })
})

describe('published file surface', () => {
  it('points every export at a file that exists', () => {
    const exports = pkg.exports ?? {}
    for (const [key, entry] of Object.entries(exports)) {
      const targets =
        typeof entry === 'string'
          ? { default: entry }
          : (entry as Record<string, string>)
      for (const target of Object.values(targets)) {
        if (typeof target !== 'string' || target.includes('*')) continue
        assert.ok(existsSync(join(root, target)), `export "${key}" target missing: ${target}`)
      }
    }
  })

  it('keeps the bundle patch and client entry on disk', () => {
    assert.ok(pkg.dsh.bundle?.patch, 'dsh.bundle.patch must be declared')
    assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)), 'bundle patch file missing')
    for (const injected of pkg.dsh.client?.inject ?? []) {
      assert.match(injected, /^@deepseek-ai\//, `client inject must be a package name: ${injected}`)
    }
  })
})

describe('committed dist/ build stays in step with src/', () => {
  // `src/client` is excluded from `tsconfig.build.json`: the browser client is
  // bundled separately into `lib/client.js` by `scripts/build-client.mjs`.
  const srcFiles = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.startsWith('client'))
    .map((f) => f.replace(/\.ts$/, '.js'))
    .sort()
  const distFiles = readdirSync(join(root, 'dist'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.js'))
    .sort()

  it('emits a dist module for every source module', () => {
    const missing = srcFiles.filter((f) => !distFiles.includes(f))
    assert.deepEqual(missing, [], `dist/ is stale — rebuild with \`npm run build\`: missing ${missing.join(', ')}`)
  })

  it('ships no dist module without a source counterpart', () => {
    const orphans = distFiles.filter((f) => !srcFiles.includes(f))
    assert.deepEqual(orphans, [], `dist/ has orphans (source deleted?): ${orphans.join(', ')}`)
  })

  it('registers every tool name in the built bundle', () => {
    const built = readFileSync(join(root, 'dist/index.js'), 'utf8')
    const source = readFileSync(join(root, 'src/index.ts'), 'utf8')
    const names = [...source.matchAll(/\['(iterate_[a-z_]+)'/g)].map((m) => m[1]!)
    assert.ok(names.length >= 17, 'expected at least 17 registered tools in src/index.ts')
    for (const name of names) {
      assert.ok(built.includes(name), `dist/index.js is stale — missing tool registration ${name}`)
    }
    assert.equal(relative(root, join(root, 'dist', 'index.js')), 'dist/index.js')
  })
})

describe('committed lib/client.js matches its client sources', () => {
  it('records the digest of src/client/index.ts + lib/parse.js', () => {
    const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
    const marked = new RegExp(`${DIGEST_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9a-f]{64})`).exec(bundle)
    assert.ok(marked, 'lib/client.js is missing its source-digest header — rebuild with `npm run build:client`')
    const actual = clientSourceDigest(root)
    assert.equal(
      marked![1],
      actual,
      'lib/client.js is stale — its sources changed since the last `npm run build:client`',
    )
  })

  it('loads through the __ModuleLoader__ contract', () => {
    const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
    assert.match(bundle, /window\.__ModuleLoader__\.load\(\{ id: "iterate-plugin"/)
  })
})

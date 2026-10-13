/**
 * test/client-i18n.test.ts — the bilingual UI dictionary is a contract, not a
 * hope.
 *
 * `src/client/index.ts` renders every piece of UI chrome through `t()` / `tf()`
 * with the CHINESE literal as the key, and `src/client/i18n.ts` maps those keys
 * to English. Nothing in TypeScript can enforce "every key has a translation"
 * (the keys are data, not types), so this suite does it statically: it scans
 * the client source, collects every Chinese string literal, and asserts each
 * one is either
 *
 *   1. a key in the `EN` dictionary, or
 *   2. the `zh` half of an inline `{ zh, en }` pair (module constants — the
 *      observatory tab labels — which must NOT be frozen at load time),
 *
 * and conversely that every `EN` entry is actually used (no dead strings to
 * drift) and that the `{a0}` placeholder sets match on both sides, so a
 * translation can never silently drop a round number or a count.
 *
 * The behavioral half (language switch, persistence port, detection) is
 * exercised here too — the module is deliberately dependency-free so it can be.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it, beforeEach } from 'node:test'
import {
  EN,
  configureLangStorage,
  detectLang,
  getLang,
  setLang,
  subscribeLang,
  t,
  tf,
  LANG_STORAGE_KEY,
  type Lang,
} from '../src/client/i18n.ts'

// ─── source scanner ──────────────────────────────────────────────────────────

interface Literal {
  /** Evaluated value of the literal (escapes resolved, `${…}` kept raw). */
  value: string
  /** The nearest preceding non-space characters (to spot `zh:` pairs). */
  prefix: string
}

/**
 * Collect every string / template literal in `src`, recursing into `${…}`
 * expressions (a nested template can carry its own Chinese copy) and skipping
 * comments (prose quoting UI strings is documentation, not UI).
 */
function scanLiterals(src: string): Literal[] {
  const found: Literal[] = []
  const quotes = '\'"'
  const unescape = (raw: string): string =>
    raw.replace(/\\(n|r|t|'|`|\\|")/g, (_m, c: string) =>
      c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c,
    )

  const quoted = (i: number): { raw: string; end: number } => {
    const q = src[i]
    let j = i + 1
    while (j < src.length) {
      if (src[j] === '\\') {
        j += 2
        continue
      }
      if (src[j] === q) return { raw: src.slice(i + 1, j), end: j + 1 }
      j += 1
    }
    return { raw: src.slice(i + 1), end: src.length }
  }

  const template = (i: number): { raw: string; end: number; hasExpr: boolean } => {
    let j = i + 1
    let body = ''
    let hasExpr = false
    while (j < src.length) {
      if (src[j] === '\\') {
        body += src.slice(j, j + 2)
        j += 2
        continue
      }
      if (src[j] === '`') {
        return { raw: body, end: j + 1, hasExpr }
      }
      if (src[j] === '$' && src[j + 1] === '{') {
        hasExpr = true
        // Keep the expression verbatim in the key (the transform already
        // rewrote real interpolations into `{aN}` placeholders), but scan it
        // so nested literals are collected too.
        const exprStart = j
        let depth = 1
        let k = j + 2
        while (k < src.length && depth > 0) {
          if (src[k] === '`') {
            k = template(k).end
            continue
          }
          if (quotes.includes(src[k] ?? '')) {
            k = quoted(k).end
            continue
          }
          if (src[k] === '{') depth += 1
          else if (src[k] === '}') depth -= 1
          k += 1
        }
        // Recurse: copy inside `${…}` (e.g. `` `${cond ? '中文' : ''}` ``) is
        // still UI copy and must be checked against the dictionary.
        const inner = src.slice(exprStart + 2, Math.max(exprStart + 2, k - 1))
        const prefix = src.slice(Math.max(0, exprStart - 8), exprStart).trimEnd()
        for (const lit of scanLiterals(inner)) found.push({ ...lit, prefix: lit.prefix || prefix })
        body += src.slice(exprStart, k)
        j = k
        continue
      }
      body += src[j]
      j += 1
    }
    return { raw: body, end: src.length, hasExpr }
  }

  let i = 0
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl + 1
      continue
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close === -1 ? src.length : close + 2
      continue
    }
    const isTemplate = src[i] === '`'
    if (isTemplate || quotes.includes(src[i] ?? '')) {
      const scan = isTemplate ? template(i) : quoted(i)
      // A template that still interpolates (`${…}`) is NOT a dictionary key —
      // the transform rewrites keyed templates into `{a0}` placeholders — so
      // only its nested literals (collected above) are candidates.
      if (!(isTemplate && 'hasExpr' in scan && scan.hasExpr)) {
        const prefix = src.slice(Math.max(0, i - 8), i).trimEnd()
        found.push({ value: unescape(scan.raw), prefix })
      }
      i = scan.end
      continue
    }
    i += 1
  }
  return found
}

const CJK = /[一-鿿]/
const placeholders = (s: string): Set<string> =>
  new Set([...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])))

const CLIENT_SRC = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const clientLiterals = scanLiterals(CLIENT_SRC).filter((l) => CJK.test(l.value))
/** Inline `{ zh, en }` pairs (module constants) — translated in place, not via `EN`. */
const inlinePairs = clientLiterals.filter((l) => /zh:\s*$/.test(l.prefix))
const dictionaryKeys = clientLiterals.filter((l) => !/zh:\s*$/.test(l.prefix))

// ─── dictionary contract ─────────────────────────────────────────────────────

describe('client i18n dictionary', () => {
  it('translates every Chinese literal used by the client', () => {
    const missing = [...new Set(dictionaryKeys.map((l) => l.value))].filter((k) => !(k in EN))
    assert.deepEqual(missing, [], 'these UI strings have no English entry')
  })

  it('has no dead entries — every EN key is used by the client', () => {
    const used = new Set(dictionaryKeys.map((l) => l.value))
    const dead = Object.keys(EN).filter((k) => !used.has(k))
    assert.deepEqual(dead, [], 'these EN entries are unreachable')
  })

  it('keeps the placeholder sets identical between zh and en', () => {
    const mismatched: string[] = []
    for (const [zh, en] of Object.entries(EN)) {
      const a = placeholders(zh)
      const b = placeholders(en)
      if (a.size !== b.size || [...a].some((p) => !b.has(p))) {
        mismatched.push(`${zh} → ${en} (zh: ${[...a].join(',')}; en: ${[...b].join(',')})`)
      }
    }
    assert.deepEqual(mismatched, [], 'placeholders drifted between languages')
  })

  it('never falls back to blank copy', () => {
    for (const [zh, en] of Object.entries(EN)) {
      assert.ok(en.trim().length > 0, `empty translation for ${zh}`)
    }
  })

  it('resolves inline { zh, en } pairs at render time, not load time', () => {
    // The observatory tab labels live in module constants: they must carry both
    // languages so a switch repaints them (a `t()` call evaluated while the
    // module loads would freeze whichever language was active then).
    assert.match(CLIENT_SRC, /label:\s*\{\s*zh:\s*'实时活动流',\s*en:\s*'Live activity'\s*\}/)
    assert.doesNotMatch(
      CLIENT_SRC,
      /zh:\s*t\(/,
      'a module constant must not call t() — it would freeze the load-time language',
    )
  })
})

// ─── runtime behaviour ───────────────────────────────────────────────────────

describe('language state', () => {
  let written: Array<[string, string]> = []
  const store = {
    get: () => null,
    set: (k: string, v: string) => {
      written.push([k, v])
    },
  }

  beforeEach(() => {
    setLang('zh', false)
    written = []
    configureLangStorage(store)
  })

  it('defaults to Chinese and returns keys verbatim in zh', () => {
    assert.equal(getLang(), 'zh')
    assert.equal(t('已复制'), '已复制')
    assert.equal(
      tf('第 {a0} 轮进行中{a1}——首轮汇总报告落地后，这里会显示收敛进度与发现统计。', { a0: 2, a1: '' }),
      '第 2 轮进行中——首轮汇总报告落地后，这里会显示收敛进度与发现统计。',
    )
  })

  it('translates in en and substitutes placeholders', () => {
    setLang('en', false)
    assert.equal(getLang(), 'en')
    assert.equal(t('已复制'), 'Copied')
    assert.equal(
      tf('第 {a0} 轮进行中{a1}——首轮汇总报告落地后，这里会显示收敛进度与发现统计。', {
        a0: 2,
        a1: ' · phase "fix"',
      }),
      'Round 2 in progress · phase "fix" — convergence progress and finding stats appear here once the first aggregated report lands.',
    )
  })

  it('leaves unknown placeholders verbatim instead of printing undefined', () => {
    setLang('en', false)
    assert.equal(tf('{a0} / {nope}', { a0: 'x' }), 'x / {nope}')
    // A key with no EN entry degrades to the Chinese original, never to blank.
    assert.equal(t('未翻译的串'), '未翻译的串')
  })

  it('persists an explicit switch and repaints subscribers', () => {
    const seen: Lang[] = []
    const off = subscribeLang((lang) => seen.push(lang))
    setLang('en')
    off()
    setLang('zh', false)

    assert.deepEqual(seen, ['en'], 'only the explicit switch notified')
    assert.deepEqual(written, [[LANG_STORAGE_KEY, 'en']], 'the choice is persisted once')
  })

  it('does not persist an auto-resolved startup language', () => {
    setLang('en', false)
    assert.deepEqual(written, [], 'auto-detection must not create a preference')
  })

  it('survives a throwing subscriber and a throwing storage port', () => {
    const off = subscribeLang(() => {
      throw new Error('bad subscriber')
    })
    assert.doesNotThrow(() => setLang('en', false))
    off()

    configureLangStorage({
      get: () => {
        throw new Error('storage blocked')
      },
      set: () => {
        throw new Error('storage blocked')
      },
    })
    assert.doesNotThrow(() => setLang('zh'))
    assert.equal(getLang(), 'zh')
  })

  it('detects: stored choice > zh locale > anything else', () => {
    assert.equal(detectLang('en', 'zh-CN'), 'en', 'an explicit choice wins over the locale')
    assert.equal(detectLang('zh', 'en-US'), 'zh')
    assert.equal(detectLang(null, 'zh-Hans-CN'), 'zh')
    assert.equal(detectLang(null, 'en-US'), 'en')
    assert.equal(detectLang(undefined, ''), 'en', 'no locale → the English default')
    assert.equal(detectLang('junk', null), 'en', 'an unreadable value falls through')
  })
})

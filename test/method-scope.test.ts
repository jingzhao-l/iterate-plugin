import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  collectMethodSignatures,
  collectMethodSpans,
  countTouchedMethods,
  countTextLines,
} from '../src/method-scope.ts'
import { diffLines } from '../src/tools/fix.ts'

// ─── collectMethodSignatures ─────────────────────────────────────────────────

describe('collectMethodSignatures', () => {
  it('detects JS/TS function declarations', () => {
    const sigs = collectMethodSignatures('function greet(name) {\n  return name\n}\n')
    assert.deepEqual(sigs, [{ name: 'greet', line: 1 }])
  })

  it('detects async + exported function declarations', () => {
    const sigs = collectMethodSignatures('export async function run() {\n  return 1\n}\n')
    assert.deepEqual(sigs, [{ name: 'run', line: 1 }])
  })

  it('detects arrow-function assignments', () => {
    const sigs = collectMethodSignatures('const handler = (ev) => {\n  ev.preventDefault()\n}\n')
    assert.deepEqual(sigs, [{ name: 'handler', line: 1 }])
  })

  it('detects indented class methods', () => {
    const src = 'class A {\n  private render() {\n    return 1\n  }\n\n  static build() {\n    return new A()\n  }\n}\n'
    const sigs = collectMethodSignatures(src)
    assert.deepEqual(sigs, [
      { name: 'render', line: 2 },
      { name: 'build', line: 6 },
    ])
  })

  it('ignores control-flow keywords and test-framework callables', () => {
    const src = [
      'function real() {',
      '  if (x) {',
      '    it("does a thing", () => {',
      '    })',
      '  }',
      '}',
    ].join('\n')
    const sigs = collectMethodSignatures(src)
    assert.deepEqual(sigs, [{ name: 'real', line: 1 }])
  })

  it('detects Python def (module + method)', () => {
    const src = 'async def fetch(url):\n    pass\n\nclass Svc:\n    def get(self):\n        pass\n'
    const sigs = collectMethodSignatures(src)
    assert.deepEqual(sigs, [
      { name: 'fetch', line: 1 },
      { name: 'get', line: 5 },
    ])
  })

  it('detects Swift / Go / Rust / Ruby / PHP signatures', () => {
    const swift = 'func compute(_ a: Int) -> Int {\n  return a\n}\n'
    assert.deepEqual(collectMethodSignatures(swift), [{ name: 'compute', line: 1 }])

    const go = 'func (s *Store) Load(key string) (string, error) {\n  return "", nil\n}\n'
    assert.deepEqual(collectMethodSignatures(go), [{ name: 'Load', line: 1 }])

    const rust = 'pub fn parse(input: &str) -> Result<i32, Error> {\n  Ok(1)\n}\n'
    assert.deepEqual(collectMethodSignatures(rust), [{ name: 'parse', line: 1 }])

    const ruby = 'def self.build(name)\n  new(name)\nend\n'
    assert.deepEqual(collectMethodSignatures(ruby), [{ name: 'build', line: 1 }])

    const php = 'public function render(array $data) {\n  return $data;\n}\n'
    assert.deepEqual(collectMethodSignatures(php), [{ name: 'render', line: 1 }])
  })
})

// ─── collectMethodSpans / countTextLines ─────────────────────────────────────

describe('collectMethodSpans', () => {
  it('spans run from signature to the line before the next signature', () => {
    const src = 'function a() {\n  x\n}\n\nfunction b() {\n  y\n}\n'
    const spans = collectMethodSpans(src)
    assert.deepEqual(spans, [
      { name: 'a', startLine: 1, endLine: 3 },
      { name: 'b', startLine: 5, endLine: 7 },
    ])
  })

  it('returns [] for method-less code', () => {
    assert.deepEqual(collectMethodSpans('const x = 1\n'), [])
    assert.deepEqual(collectMethodSpans(''), [])
  })

  it('countTextLines ignores a trailing newline', () => {
    assert.equal(countTextLines('a\nb\n'), 2)
    assert.equal(countTextLines('a\nb'), 2)
    assert.equal(countTextLines(''), 0)
  })
})

// ─── countTouchedMethods ─────────────────────────────────────────────────────

describe('countTouchedMethods', () => {
  const A = 'function a() {\n  return 1\n}\n'
  const AB = 'function a() {\n  return 1\n}\nfunction b() {\n  return 2\n}\n'
  const ABC = [
    'function a() {\n  return 1\n}',
    'function b() {\n  return 2\n}',
    'function c() {\n  return 3\n}',
    'function d() {\n  return 4\n}',
    'function e() {\n  return 5\n}',
  ].join('\n')

  it('returns 0 when nothing changed', () => {
    assert.equal(countTouchedMethods(A, A, diffLines(A, A)), 0)
  })

  it('counts a single-method insertion as 1', () => {
    const fixed = 'function a() {\n  if (!x) return 1\n  return 1\n}\n'
    assert.equal(countTouchedMethods(A, fixed, diffLines(A, fixed)), 1)
  })

  it('counts a deleted method as 1 (does not drag in the next method)', () => {
    const after = 'function b() {\n  return 2\n}\n'
    assert.equal(countTouchedMethods(AB, after, diffLines(AB, after)), 1)
  })

  it('counts a change spanning two adjacent methods as 2', () => {
    const fixed = 'function a() {\n  return 10\n}\nfunction b() {\n  return 20\n}\n'
    assert.equal(countTouchedMethods(AB, fixed, diffLines(AB, fixed)), 2)
  })

  it('counts a change spanning four adjacent methods as 4', () => {
    const fixed = [
      'function a() {\n  return 10\n}',
      'function b() {\n  return 20\n}',
      'function c() {\n  return 30\n}',
      'function d() {\n  return 40\n}',
      'function e() {\n  return 5\n}',
    ].join('\n')
    assert.equal(countTouchedMethods(ABC, fixed, diffLines(ABC, fixed)), 4)
  })

  it('treats a rewrite of the same single method as 1', () => {
    const rewritten = 'function a() {\n  // whole body replaced\n  return 99\n}\n'
    assert.equal(countTouchedMethods(A, rewritten, diffLines(A, rewritten)), 1)
  })
})

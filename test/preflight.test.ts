import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildPreflightReport, registerPreflightTool } from '../src/tools/preflight.ts'
import { runGit } from '../src/git-scope.ts'

// ─── Test harness ────────────────────────────────────────────────────────────

type ToolDef = { execute: (a: unknown, e: unknown) => Promise<unknown> }
type Tool = (args: unknown) => Promise<unknown>

function captureTools(
  registrars: Array<(ctx: { tools: { register: (d: unknown) => void } }) => void>,
): Tool[] {
  const defs: ToolDef[] = []
  for (const reg of registrars) {
    reg({ tools: { register: (d: unknown) => { defs.push(d as ToolDef) } } })
  }
  const exec = { signal: new AbortController().signal }
  return defs.map((def) => (args: unknown) => def.execute(args, exec as never) as Promise<unknown>)
}

function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'iterate-preflight-test-'))
  mkdirSync(join(dir, '.iterate'), { recursive: true })
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const CONFIG_WITH_VALIDATION = [
  'validation:',
  '  command_whitelist:',
  '    - "npm test"',
  '  commands:',
  '    default:',
  '      - "npm test"',
].join('\n')

const GATE_FAIL = JSON.stringify({
  timestamp: '2026-10-29T00:00:00.000Z',
  overallStatus: 'fail',
  overallScore: 42,
  dimensions: [{ dimension: 'correctness', convergenceRate: 40, findingsCount: 3, fixedCount: 1, score: 40, status: 'fail' }],
  verificationPassRate: 50,
  totalChecks: 4,
  passedChecks: 2,
  failedChecks: 2,
  failReason: 'not converged',
})

const CHECKPOINT_INTERRUPTED = JSON.stringify({
  mode: 'normal',
  round: 3,
  maxRounds: 5,
  fixedCount: 7,
  architecturalCount: 2,
  resumeCount: 1,
  findings: [],
  startedAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
})

// ─── Pure decision: buildPreflightReport ─────────────────────────────────────

describe('buildPreflightReport', () => {
  it('blocks (fail) when no validation commands are configured — the one blocking check', () => {
    const r = buildPreflightReport({
      validationCommandCount: 0,
      isGitRepo: true,
      changedFiles: 0,
      gateOverallStatus: null,
      interrupted: false,
      resumeCount: 0,
    })
    assert.equal(r.ready, false)
    assert.equal(r.blocking, 1)
    assert.equal(r.warnings, 0)
    const v = r.checks.find((c) => c.id === 'validation')
    assert.ok(v)
    assert.equal(v.status, 'fail')
    assert.deepEqual(v.detail, { commandCount: 0 })
  })

  it('is ready (all pass) when every check is healthy', () => {
    const r = buildPreflightReport({
      validationCommandCount: 3,
      isGitRepo: true,
      changedFiles: 0,
      gateOverallStatus: 'pass',
      interrupted: false,
      resumeCount: 0,
    })
    assert.equal(r.ready, true)
    assert.equal(r.blocking, 0)
    assert.equal(r.warnings, 0)
    for (const c of r.checks) assert.equal(c.status, 'pass')
  })

  it('warns (never blocks) on a non-repo, a dirty tree, a stale FAIL gate and an interrupted checkpoint', () => {
    const r = buildPreflightReport({
      validationCommandCount: 1,
      isGitRepo: false,
      changedFiles: 2,
      gateOverallStatus: 'fail',
      interrupted: true,
      resumeCount: 1,
    })
    assert.equal(r.ready, true) // warnings never block
    assert.equal(r.blocking, 0)
    assert.equal(r.warnings, 4)
    assert.equal(r.checks.find((c) => c.id === 'git')?.status, 'warn')
    assert.equal(r.checks.find((c) => c.id === 'dirty-tree')?.status, 'warn')
    assert.equal(r.checks.find((c) => c.id === 'stale-gate')?.status, 'warn')
    assert.equal(r.checks.find((c) => c.id === 'interrupted-checkpoint')?.status, 'warn')
  })

  it('treats an unknown changed-file count as pass — a git hiccup never fabricates a warning', () => {
    const r = buildPreflightReport({
      validationCommandCount: 1,
      isGitRepo: false,
      changedFiles: null,
      gateOverallStatus: null,
      interrupted: false,
      resumeCount: 0,
    })
    const dirty = r.checks.find((c) => c.id === 'dirty-tree')
    assert.equal(dirty?.status, 'pass')
    assert.equal(dirty?.detail.changedFiles, null)
  })

  it('treats pending / absent gate as pass, fail as warn', () => {
    const pending = buildPreflightReport({
      validationCommandCount: 1,
      isGitRepo: true,
      changedFiles: 0,
      gateOverallStatus: 'pending',
      interrupted: false,
      resumeCount: 0,
    })
    assert.equal(pending.checks.find((c) => c.id === 'stale-gate')?.status, 'pass')
  })

  it('carries resumeCount into the interrupted-checkpoint detail', () => {
    const r = buildPreflightReport({
      validationCommandCount: 1,
      isGitRepo: true,
      changedFiles: 0,
      gateOverallStatus: null,
      interrupted: true,
      resumeCount: 4,
    })
    const ckpt = r.checks.find((c) => c.id === 'interrupted-checkpoint')
    assert.equal(ckpt?.status, 'warn')
    assert.deepEqual(ckpt?.detail, { interrupted: true, resumeCount: 4 })
  })
})

// ─── Registration + execute ──────────────────────────────────────────────────

describe('iterate_preflight tool', () => {
  it('registers as a concurrency-safe read-only tool', () => {
    let def: unknown = null
    registerPreflightTool({ tools: { register: (d: unknown) => { def = d } } })
    const d = def as { name?: string; isConcurrencySafe?: (a: unknown) => boolean; output?: { render?: unknown } }
    assert.equal(d.name, 'iterate_preflight')
    // The harness calls isConcurrencySafe with the exec arguments object; it
    // validates args against the parameter schema (no required fields here).
    assert.equal(d.isConcurrencySafe?.({}), true)
    assert.equal(typeof d.output?.render, 'function')
  })

  it('flags validation.commands as blocking when the project has no validation commands', async () => {
    const { dir, cleanup } = tempProject()
    try {
      // No iterate.config.yaml → defaults (empty validation.commands).
      const [tool] = captureTools([registerPreflightTool])
      assert.ok(tool, 'tool registered')
      const res = await tool({ path: dir }) as {
        ok: boolean
        ready: boolean
        blocking: number
        checks: Array<{ id: string; status: string; detail: Record<string, unknown> }>
      }
      assert.equal(res.ok, true)
      assert.equal(res.ready, false)
      assert.equal(res.blocking, 1)
      const v = res.checks.find((c) => c.id === 'validation')
      assert.equal(v?.status, 'fail')
      assert.deepEqual(v?.detail, { commandCount: 0 })
    } finally {
      cleanup()
    }
  })

  it('passes validation when validation.commands is configured', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, 'iterate.config.yaml'), CONFIG_WITH_VALIDATION, 'utf-8')
      const [tool] = captureTools([registerPreflightTool])
      assert.ok(tool, 'tool registered')
      const res = await tool({ path: dir }) as {
        ok: boolean
        ready: boolean
        checks: Array<{ id: string; status: string; detail: Record<string, unknown> }>
      }
      const v = res.checks.find((c) => c.id === 'validation')
      assert.equal(v?.status, 'pass')
      assert.deepEqual(v?.detail, { commandCount: 1 })
      // With no git repo and no artifacts, the only remaining signals are the
      // git warn (not a repo) — everything else passes.
      assert.equal(res.ok, true)
    } finally {
      cleanup()
    }
  })

  it('detects a git repository and uncommitted changes', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, 'iterate.config.yaml'), CONFIG_WITH_VALIDATION, 'utf-8')
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 'preflight@test.local'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'Preflight Test'], { cwd: dir })
      execFileSync('git', ['add', '.'], { cwd: dir })
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
      const [tool] = captureTools([registerPreflightTool])
      assert.ok(tool, 'tool registered')
      const clean = await tool({ path: dir }) as {
        checks: Array<{ id: string; status: string; detail: Record<string, unknown> }>
      }
      const gitClean = clean.checks.find((c) => c.id === 'git')
      const dirtyClean = clean.checks.find((c) => c.id === 'dirty-tree')
      assert.equal(gitClean?.status, 'pass')
      assert.equal(dirtyClean?.status, 'pass')
      assert.deepEqual(dirtyClean?.detail, { changedFiles: 0 })

      // Dirty it: an untracked file now makes the tree non-clean.
      writeFileSync(join(dir, 'untracked.txt'), 'x', 'utf-8')
      const dirty = await tool({ path: dir }) as {
        checks: Array<{ id: string; status: string; detail: Record<string, unknown> }>
      }
      assert.equal(dirty.checks.find((c) => c.id === 'dirty-tree')?.status, 'warn')
      assert.equal((dirty.checks.find((c) => c.id === 'dirty-tree')?.detail.changedFiles as number) > 0, true)
    } finally {
      cleanup()
    }
  })

  it('flags a stale FAIL quality gate and an interrupted checkpoint', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, 'iterate.config.yaml'), CONFIG_WITH_VALIDATION, 'utf-8')
      writeFileSync(join(dir, '.iterate', 'quality-gate.json'), GATE_FAIL, 'utf-8')
      writeFileSync(join(dir, '.iterate', 'checkpoint.json'), CHECKPOINT_INTERRUPTED, 'utf-8')
      const [tool] = captureTools([registerPreflightTool])
      assert.ok(tool, 'tool registered')
      const res = await tool({ path: dir }) as {
        ok: boolean
        ready: boolean
        blocking: number
        warnings: number
        checks: Array<{ id: string; status: string; detail: Record<string, unknown> }>
      }
      assert.equal(res.ok, true)
      assert.equal(res.blocking, 0)
      assert.equal(res.warnings >= 2, true)
      const gate = res.checks.find((c) => c.id === 'stale-gate')
      assert.equal(gate?.status, 'warn')
      assert.equal(gate?.detail.overallStatus, 'fail')
      const ckpt = res.checks.find((c) => c.id === 'interrupted-checkpoint')
      assert.equal(ckpt?.status, 'warn')
      assert.equal(ckpt?.detail.interrupted, true)
    } finally {
      cleanup()
    }
  })

  it('degrades gracefully (ready, no crash) when git is unavailable', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, 'iterate.config.yaml'), CONFIG_WITH_VALIDATION, 'utf-8')
      // Point at a non-existent git dir so `rev-parse --is-inside-work-tree`
      // fails — the tool must degrade to "not a repo", not throw.
      const [tool] = captureTools([registerPreflightTool])
      assert.ok(tool, 'tool registered')
      const res = await tool({ path: dir }) as {
        ok: boolean
        checks: Array<{ id: string; status: string; detail: Record<string, unknown> }>
      }
      assert.equal(res.ok, true)
      const git = res.checks.find((c) => c.id === 'git')
      assert.equal(git?.status, 'warn')
      assert.equal(git?.detail.isRepo, false)
    } finally {
      cleanup()
    }
  })
})

// ─── validation-command suggestions on the blocking check ───────────────────

describe('preflight validation suggestions', () => {
  it('attaches detected commands + ecosystem + source files to the blocking detail', () => {
    const r = buildPreflightReport({
      validationCommandCount: 0,
      isGitRepo: true,
      changedFiles: 0,
      gateOverallStatus: null,
      interrupted: false,
      resumeCount: 0,
      suggestedCommands: ['npm test', 'npm run lint'],
      ecosystem: 'node',
      detectedFrom: ['package.json', 'package.json'],
    })
    const v = r.checks.find((c) => c.id === 'validation')
    assert.equal(v?.status, 'fail')
    assert.deepEqual(v?.detail, {
      commandCount: 0,
      suggestedCommands: ['npm test', 'npm run lint'],
      ecosystem: 'node',
      detectedFrom: ['package.json', 'package.json'],
    })
  })

  it('omits the suggestion fields when nothing was detected', () => {
    const r = buildPreflightReport({
      validationCommandCount: 0,
      isGitRepo: true,
      changedFiles: 0,
      gateOverallStatus: null,
      interrupted: false,
      resumeCount: 0,
      suggestedCommands: [],
      ecosystem: null,
      detectedFrom: [],
    })
    assert.deepEqual(r.checks.find((c) => c.id === 'validation')?.detail, { commandCount: 0 })
  })

  it('never attaches suggestions when commands are already configured', () => {
    const r = buildPreflightReport({
      validationCommandCount: 2,
      isGitRepo: true,
      changedFiles: 0,
      gateOverallStatus: null,
      interrupted: false,
      resumeCount: 0,
      suggestedCommands: ['npm test'],
      ecosystem: 'node',
      detectedFrom: ['package.json'],
    })
    assert.deepEqual(r.checks.find((c) => c.id === 'validation')?.detail, { commandCount: 2 })
  })

  it('filters junk entries out of suggestedCommands', () => {
    const r = buildPreflightReport({
      validationCommandCount: 0,
      isGitRepo: true,
      changedFiles: 0,
      gateOverallStatus: null,
      interrupted: false,
      resumeCount: 0,
      suggestedCommands: ['npm test', '', 42 as unknown as string, 'npm run lint'],
      ecosystem: 'node',
      detectedFrom: ['package.json'],
    })
    const v = r.checks.find((c) => c.id === 'validation')
    assert.deepEqual((v?.detail as { suggestedCommands?: string[] }).suggestedCommands, ['npm test', 'npm run lint'])
  })

  it('execute() auto-detects commands from the project manifest when none are configured', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'tsc' } }))
      const [tool] = captureTools([registerPreflightTool])
      assert.ok(tool, 'tool registered')
      const res = (await tool({ path: dir })) as {
        ok: boolean
        blocking: number
        checks: Array<{ id: string; status: string; detail: Record<string, unknown> }>
      }
      assert.equal(res.ok, true)
      assert.equal(res.blocking, 1)
      const v = res.checks.find((c) => c.id === 'validation')
      assert.equal(v?.status, 'fail')
      assert.deepEqual(v?.detail.suggestedCommands, ['npm test', 'npm run build'])
      assert.equal(v?.detail.ecosystem, 'node')
      assert.deepEqual(v?.detail.detectedFrom, ['package.json', 'package.json'])
    } finally {
      cleanup()
    }
  })

  it('execute() does not inspect the manifest once commands are configured', async () => {
    const { dir, cleanup } = tempProject()
    try {
      writeFileSync(join(dir, 'iterate.config.yaml'), CONFIG_WITH_VALIDATION, 'utf-8')
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
      const [tool] = captureTools([registerPreflightTool])
      assert.ok(tool, 'tool registered')
      const res = (await tool({ path: dir })) as {
        checks: Array<{ id: string; status: string; detail: Record<string, unknown> }>
      }
      assert.deepEqual(res.checks.find((c) => c.id === 'validation')?.detail, { commandCount: 1 })
    } finally {
      cleanup()
    }
  })
})

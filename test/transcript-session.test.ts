/**
 * test/transcript-session.test.ts — session-linked run records via
 * `iterate_transcript` (dsh ≥ 0.2.1-rc.1 Session state-record API).
 *
 * Drives the real tool against a REAL `@deepseek-ai/dsh-session` Session so the
 * whole chain — capture → appendPluginRecord → session log → readRunRecords →
 * recovery — is exercised end to end, not stubbed.
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { registerTranscriptTool } from '../src/tools/transcript.ts'
import { setSessionRecordApiForTests } from '../src/session-record.ts'

/** Build the tool's execute bound to a given exec object. */
function toolWithExec(exec: unknown): (args: unknown) => Promise<unknown> {
  let def: { execute: (a: unknown, e: unknown) => Promise<unknown> } | null = null
  registerTranscriptTool({
    tools: { register: (d: never) => { def = d as typeof def } },
  } as never)
  if (!def) throw new Error('iterate_transcript was not registered')
  return (args: unknown) => def!.execute(args, exec) as Promise<unknown>
}

/** An execution carrying a real dsh session. */
function execWithSession(session: Session, root: string): unknown {
  return { signal: new AbortController().signal, agent: { session, header: { cwd: root } } }
}

let seq = 0
function newSession(): Session {
  return Session.create(SessionId(`ses_transcriptsession${String(seq++).padStart(7, '0')}`))
}

describe('iterate_transcript session linking', () => {
  beforeEach(() => setSessionRecordApiForTests(undefined))
  afterEach(() => setSessionRecordApiForTests(undefined))

  it('appends a run record on capture and reports linked:true', async () => {
    const session = newSession()
    const root = mkdtempSync(join(tmpdir(), 'iterate-ts-session-'))
    try {
      const tool = toolWithExec(execWithSession(session, root))
      const res = (await tool({
        operation: 'capture',
        path: root,
        mode: 'normal',
        goal: 'green',
        maxRounds: 3,
        roundsExecuted: 1,
        findingsByRound: [2],
        stoppedReason: 'converged',
        rounds: [{ round: 1, findings: [{ dimension: 'correctness', file: 'a.ts', severity: 'high', summary: 'x' }] }],
      })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const linked = res.sessionRecord as { linked: boolean; seq: number }
      assert.equal(linked.linked, true)
      assert.equal(typeof linked.seq, 'number')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recalls the linked record (newest first)', async () => {
    const session = newSession()
    const root = mkdtempSync(join(tmpdir(), 'iterate-ts-recall-'))
    try {
      const tool = toolWithExec(execWithSession(session, root))
      await tool({ operation: 'capture', path: root, roundsExecuted: 1, findingsByRound: [1], rounds: [] })
      await tool({ operation: 'capture', path: root, roundsExecuted: 2, findingsByRound: [1, 0], rounds: [] })
      const res = (await tool({ operation: 'recall', path: root })) as Record<string, unknown>
      assert.equal(res.supported, true)
      const records = res.records as Array<{ round: number }>
      assert.equal(records.length, 2)
      // newest first
      assert.ok(records[0]!.round >= records[1]!.round)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stamps the quality-gate verdict onto the linked record', async () => {
    const session = newSession()
    const root = mkdtempSync(join(tmpdir(), 'iterate-ts-quality-'))
    try {
      const tool = toolWithExec(execWithSession(session, root))
      mkdirSync(join(root, '.iterate'), { recursive: true })
      writeFileSync(join(root, '.iterate', 'quality-gate.json'), JSON.stringify({
        overallStatus: 'pass',
        overallScore: 95,
        dimensions: [],
      }), 'utf-8')
      await tool({
        operation: 'capture',
        path: root,
        roundsExecuted: 1,
        findingsByRound: [0],
        rounds: [],
        stoppedReason: 'converged',
      })
      const res = (await tool({ operation: 'recall', path: root })) as Record<string, unknown>
      const records = res.records as Array<{ qualityStatus: string | null }>
      assert.equal(records[0]!.qualityStatus, 'pass')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records the default pending verdict when no gate snapshot exists', async () => {
    const session = newSession()
    const root = mkdtempSync(join(tmpdir(), 'iterate-ts-quality-'))
    try {
      const tool = toolWithExec(execWithSession(session, root))
      await tool({ operation: 'capture', path: root, roundsExecuted: 1, findingsByRound: [0], rounds: [] })
      const res = (await tool({ operation: 'recall', path: root })) as Record<string, unknown>
      const records = res.records as Array<{ qualityStatus: string | null }>
      // The store's default snapshot is `pending` (undecided), never null: the
      // field always mirrors the CURRENT gate state at write time.
      assert.equal(records[0]!.qualityStatus, 'pending')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers a summary manifest from the session when the file is gone', async () => {
    const session = newSession()
    const root = mkdtempSync(join(tmpdir(), 'iterate-ts-recover-'))
    try {
      const tool = toolWithExec(execWithSession(session, root))
      await tool({
        operation: 'capture',
        path: root,
        mode: 'normal',
        goal: 'green',
        maxRounds: 4,
        roundsExecuted: 2,
        findingsByRound: [3, 0],
        stoppedReason: 'converged',
        rounds: [],
      })
      // Simulate `.iterate/` loss.
      rmSync(join(root, '.iterate'), { recursive: true, force: true })
      assert.equal(existsSync(join(root, '.iterate', 'transcript.json')), false)

      const res = (await tool({ operation: 'read', path: root })) as Record<string, unknown>
      assert.equal(res.found, true)
      assert.equal(res.recovered, true)
      const t = res.transcript as { project: string; mode: string; round: number; maxRounds: number; convergence: number[]; stoppedReason: string; active: boolean }
      assert.equal(t.project, realpathSync(root))
      assert.equal(t.mode, 'normal')
      assert.equal(t.round, 2)
      assert.equal(t.maxRounds, 4)
      assert.deepEqual(t.convergence, [3, 0])
      assert.equal(t.stoppedReason, 'converged')
      assert.equal(t.active, false)
      const meta = res.sessionRecord as { seq: number; updatedAt: string }
      assert.equal(typeof meta.seq, 'number')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers when the on-disk file is malformed', async () => {
    const session = newSession()
    const root = mkdtempSync(join(tmpdir(), 'iterate-ts-malformed-'))
    try {
      const tool = toolWithExec(execWithSession(session, root))
      await tool({ operation: 'capture', path: root, roundsExecuted: 1, findingsByRound: [1], rounds: [] })
      mkdirSync(join(root, '.iterate'), { recursive: true })
      writeFileSync(join(root, '.iterate', 'transcript.json'), '{ not json', 'utf-8')
      const res = (await tool({ operation: 'read', path: root })) as Record<string, unknown>
      assert.equal(res.found, true)
      assert.equal(res.recovered, true)
      assert.match(String(res.error), /recovered|readable|unreadable/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does NOT recover (empty view) when there is no session record', async () => {
    const session = newSession()
    const root = mkdtempSync(join(tmpdir(), 'iterate-ts-norecord-'))
    try {
      const tool = toolWithExec(execWithSession(session, root))
      const res = (await tool({ operation: 'read', path: root })) as Record<string, unknown>
      assert.equal(res.found, false)
      assert.equal(res.recovered, undefined)
      assert.ok(res.transcript)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports supported:false for recall on a host without the API', async () => {
    const session = newSession()
    const root = mkdtempSync(join(tmpdir(), 'iterate-ts-nosupport-'))
    try {
      setSessionRecordApiForTests(null)
      const tool = toolWithExec(execWithSession(session, root))
      const res = (await tool({ operation: 'recall', path: root })) as Record<string, unknown>
      assert.equal(res.supported, false)
      assert.deepEqual(res.records, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('capture still succeeds (link reported as not-linked) with no session in scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iterate-ts-nosession-'))
    try {
      const tool = toolWithExec({ signal: new AbortController().signal })
      const res = (await tool({ operation: 'capture', path: root, roundsExecuted: 1, findingsByRound: [1], rounds: [] })) as Record<string, unknown>
      assert.equal(res.updated, true)
      const link = res.sessionRecord as { linked: boolean }
      assert.equal(link.linked, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

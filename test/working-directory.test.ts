/**
 * test/working-directory.test.ts — session working-directory resolution.
 *
 * dsh 0.2.1-alpha.2 made a session's working directory mutable: the immutable
 * `Session.header.cwd` keeps the ORIGINAL project while the host's
 * `WorkingDirectoryService` (`ctx.get('workingDirectory')`) holds the current
 * one. Every project-root read in the plugin (tool roots, live capture, and
 * the F8 approval-policy source) must follow the service when the host
 * provides it, and must behave exactly as before when it does not — the plugin
 * still claims compatibility with dsh releases back to 0.1.1-rc.1, where no
 * such service exists.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  installWorkingDirectoryContext,
  resetWorkingDirectoryContext,
  effectiveSessionCwd,
  sessionCwdOf,
} from '../src/working-directory.ts'
import { resolveProjectRootForExec } from '../src/config-loader.ts'
import { gateDecision } from '../src/session-hooks.ts'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Two temp dirs standing in for "original project" and "switched project". */
function twoDirs(): { original: string; switched: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'iterate-workdir-test-'))
  const original = join(base, 'original')
  const switched = join(base, 'switched')
  mkdirSync(original)
  mkdirSync(switched)
  return {
    original,
    switched,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

/** A fake cordis context exposing only `get(name)`. */
function contextWith(service: unknown): { get: (name: string) => unknown } {
  return { get: (name: string) => (name === 'workingDirectory' ? service : undefined) }
}

/** Minimal exec shape readable by `sessionCwdOf` / `resolveProjectRootForExec`. */
function execFor(cwd: string | undefined): ToolExecution {
  return {
    agent: { session: { header: cwd === undefined ? {} : { cwd } } },
  } as unknown as ToolExecution
}

afterEach(() => resetWorkingDirectoryContext())

describe('effectiveSessionCwd', () => {
  it('uses the host working directory when the service answers', () => {
    installWorkingDirectoryContext(contextWith({ get: () => '/srv/active' }))
    assert.equal(effectiveSessionCwd({ id: 's1' }, '/srv/original'), '/srv/active')
  })

  it('keeps the header cwd when no context is installed (pre-0.2.1 hosts)', () => {
    resetWorkingDirectoryContext()
    assert.equal(effectiveSessionCwd({ id: 's1' }, '/srv/original'), '/srv/original')
  })

  it('keeps the header cwd when the host has no workingDirectory service', () => {
    installWorkingDirectoryContext(contextWith(undefined))
    assert.equal(effectiveSessionCwd({ id: 's1' }, '/srv/original'), '/srv/original')
  })

  it('keeps the header cwd when the service throws', () => {
    installWorkingDirectoryContext(
      contextWith({
        get() {
          throw new Error('service disposed')
        },
      }),
    )
    assert.equal(effectiveSessionCwd({ id: 's1' }, '/srv/original'), '/srv/original')
  })

  it('refuses a non-string or empty directory from the service', () => {
    installWorkingDirectoryContext(contextWith({ get: () => 42 }))
    assert.equal(effectiveSessionCwd({ id: 's1' }, '/srv/original'), '/srv/original')
    installWorkingDirectoryContext(contextWith({ get: () => '' }))
    assert.equal(effectiveSessionCwd({ id: 's1' }, '/srv/original'), '/srv/original')
  })

  it('never consults the service without a session', () => {
    let called = 0
    installWorkingDirectoryContext(
      contextWith({
        get() {
          called += 1
          return '/srv/active'
        },
      }),
    )
    assert.equal(effectiveSessionCwd(undefined, '/srv/original'), '/srv/original')
    assert.equal(called, 0)
  })

  it('returns undefined only when both sources are empty', () => {
    resetWorkingDirectoryContext()
    assert.equal(effectiveSessionCwd({ id: 's1' }, undefined), undefined)
    assert.equal(effectiveSessionCwd({ id: 's1' }, ''), undefined)
    assert.equal(effectiveSessionCwd(null, undefined), undefined)
  })

  it('ignores a context without a callable get()', () => {
    installWorkingDirectoryContext({ notGet: true })
    assert.equal(effectiveSessionCwd({ id: 's1' }, '/srv/original'), '/srv/original')
    installWorkingDirectoryContext(undefined)
    assert.equal(effectiveSessionCwd({ id: 's1' }, '/srv/original'), '/srv/original')
  })
})

describe('sessionCwdOf', () => {
  it('reads the header cwd when the service is unavailable', () => {
    resetWorkingDirectoryContext()
    assert.equal(sessionCwdOf(execFor('/srv/original')), '/srv/original')
  })

  it('follows the service over the header', () => {
    installWorkingDirectoryContext(contextWith({ get: () => '/srv/active' }))
    assert.equal(sessionCwdOf(execFor('/srv/original')), '/srv/active')
  })

  it('degrades to undefined for a missing or malformed exec', () => {
    resetWorkingDirectoryContext()
    assert.equal(sessionCwdOf(undefined), undefined)
    assert.equal(sessionCwdOf({}), undefined)
    assert.equal(sessionCwdOf({ agent: { session: { header: {} } } }), undefined)
  })

  it('swallows a hostile exec whose getters throw', () => {
    const hostile = {
      get agent(): never {
        throw new Error('boom')
      },
    }
    assert.doesNotThrow(() => sessionCwdOf(hostile))
    assert.equal(sessionCwdOf(hostile), undefined)
  })
})

describe('resolveProjectRootForExec follows the effective directory', () => {
  it('anchors the project root to the service directory, not header.cwd', () => {
    const { original, switched, cleanup } = twoDirs()
    try {
      // resolveProjectRoot collapses symlinks (/var → /private/var on macOS).
      const expectedSwitched = realpathSync(switched)
      const expectedOriginal = realpathSync(original)
      installWorkingDirectoryContext(contextWith({ get: () => switched }))
      const resolved = resolveProjectRootForExec(execFor(original))
      assert.ok(resolved.ok)
      assert.equal(resolved.root, expectedSwitched)

      resetWorkingDirectoryContext()
      const fallback = resolveProjectRootForExec(execFor(original))
      assert.ok(fallback.ok)
      assert.equal(fallback.root, expectedOriginal)
    } finally {
      cleanup()
    }
  })
})

describe('approval gate policy follows the effective directory', () => {
  it('reads deny from the switched workspace even when header.cwd allows', () => {
    const { original, switched, cleanup } = twoDirs()
    try {
      writeFileSync(join(original, 'iterate.config.yaml'), 'observatory:\n  approval: allow\n')
      writeFileSync(join(switched, 'iterate.config.yaml'), 'observatory:\n  approval: deny\n')

      installWorkingDirectoryContext(contextWith({ get: () => switched }))
      const gated = gateDecision({
        name: 'iterate_fix',
        arguments: {},
        agent: { session: { header: { cwd: original } } },
      } as unknown as ToolExecution)
      assert.equal(gated.kind, 'deny', 'the active workspace policy must win')
      assert.ok(gated.kind === 'deny' && gated.reason.length > 0)

      resetWorkingDirectoryContext()
      const legacy = gateDecision({
        name: 'iterate_fix',
        arguments: {},
        agent: { session: { header: { cwd: original } } },
      } as unknown as ToolExecution)
      assert.equal(legacy.kind, 'allow', 'without the service the header path still rules')
    } finally {
      resetWorkingDirectoryContext()
      cleanup()
    }
  })
})

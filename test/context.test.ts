import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { findSkillMd, findSkillRoot, normalizeAttachment, normalizeAttachments } from '../src/tools/context.ts'

/** Create a temp tree and return its root plus a cleanup fn. */
function tempTree(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'iterate-context-test-'))
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function mk(path: string): void {
  mkdirSync(path, { recursive: true })
}

function writeSkill(dir: string, content: string): void {
  mk(dir)
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
}

describe('findSkillRoot', () => {
  it('returns the nearest ancestor directory that contains SKILL.md', () => {
    const { root, cleanup } = tempTree()
    try {
      writeSkill(join(root, 'skill-root'), '# Level A')
      // Start two levels below the SKILL.md dir.
      const start = join(root, 'skill-root', 'nested', 'deeper')
      mk(start)
      const found = findSkillRoot(start)
      assert.ok(found)
      // Normalize trailing slashes so the equality is robust.
      assert.equal(found.replace(/\/$/, ''), join(root, 'skill-root'))
    } finally {
      cleanup()
    }
  })

  it('finds SKILL.md when the start dir itself contains it', () => {
    const { root, cleanup } = tempTree()
    try {
      writeSkill(join(root, 'skill-root'), '# Level A')
      const found = findSkillRoot(join(root, 'skill-root'))
      assert.equal(found, join(root, 'skill-root'))
    } finally {
      cleanup()
    }
  })

  it('returns null when no ancestor directory has a SKILL.md', () => {
    const { root, cleanup } = tempTree()
    try {
      // Walk up from a deep dir with no SKILL.md anywhere up the chain.
      // This exercises the depth cap / filesystem-root termination.
      const start = join(root, 'a', 'b', 'c', 'd')
      mk(start)
      assert.equal(findSkillRoot(start), null)
    } finally {
      cleanup()
    }
  })
})

describe('findSkillMd', () => {
  it('returns the first candidate (priority order) that has a SKILL.md', () => {
    const { root, cleanup } = tempTree()
    try {
      const custom = join(root, 'custom')
      const skill = join(root, 'skill')
      const project = join(root, 'project')
      writeSkill(custom, '# custom')
      writeSkill(skill, '# skill')
      mk(project) // project has no SKILL.md

      // Priority: custom → skill → project.
      const found = findSkillMd([custom, skill, project])
      assert.ok(found)
      assert.equal(found.sourceDir, custom)
      assert.match(found.content, /custom/)

      // When the top candidate lacks SKILL.md, fall through.
      const found2 = findSkillMd([project, skill])
      assert.ok(found2)
      assert.equal(found2.sourceDir, skill)
      assert.match(found2.content, /skill/)
    } finally {
      cleanup()
    }
  })

  it('returns null when none of the candidates has a SKILL.md', () => {
    const { root, cleanup } = tempTree()
    try {
      const empty = join(root, 'empty')
      mk(empty)
      assert.equal(findSkillMd([empty]), null)
      assert.equal(findSkillMd(['', empty, join(root, 'missing')]), null)
    } finally {
      cleanup()
    }
  })
})

describe('normalizeAttachment', () => {
  it('accepts a full valid entry and normalizes fields', () => {
    const res = normalizeAttachment({
      name: 'screenshot.png',
      mediaType: 'image/png',
      width: 1280,
      height: 720,
      note: 'broken layout',
    })
    assert.ok(res.ok)
    assert.deepEqual(res.value, {
      name: 'screenshot.png',
      mediaType: 'image/png',
      width: 1280,
      height: 720,
      note: 'broken layout',
    })
  })

  it('accepts a minimal entry with no optional fields', () => {
    const res = normalizeAttachment({})
    assert.ok(res.ok)
    assert.deepEqual(res.value, {})
  })

  it('rejects non-objects and arrays', () => {
    assert.equal(normalizeAttachment(null).ok, false)
    assert.equal(normalizeAttachment('x').ok, false)
    assert.equal(normalizeAttachment([1]).ok, false)
  })

  it('rejects invalid name (non-string or too long)', () => {
    assert.equal(normalizeAttachment({ name: 42 }).ok, false)
    assert.equal(normalizeAttachment({ name: 'x'.repeat(257) }).ok, false)
  })

  it('rejects unsupported mediaType', () => {
    assert.equal(normalizeAttachment({ mediaType: 'image/bmp' }).ok, false)
    assert.equal(normalizeAttachment({ mediaType: 'text/plain' }).ok, false)
  })

  it('rejects non-integer, negative, or oversized dimensions', () => {
    assert.equal(normalizeAttachment({ width: 1.5 }).ok, false)
    assert.equal(normalizeAttachment({ height: -1 }).ok, false)
    assert.equal(normalizeAttachment({ width: 16385 }).ok, false)
    assert.equal(normalizeAttachment({ width: 0, height: 100 }).ok, true)
  })

  it('rejects an over-long note', () => {
    assert.equal(normalizeAttachment({ note: 'x'.repeat(1001) }).ok, false)
  })
})

describe('normalizeAttachments', () => {
  it('returns empty results for undefined / null / non-array input', () => {
    assert.deepEqual(normalizeAttachments(undefined), { attachments: [], errors: [] })
    assert.deepEqual(normalizeAttachments(null), { attachments: [], errors: [] })
    assert.equal(normalizeAttachments('nope').errors.length, 1)
  })

  it('drops invalid entries and reports reasons', () => {
    const res = normalizeAttachments([{ mediaType: 'image/png' }, { mediaType: 'image/bmp' }, 7])
    assert.equal(res.attachments.length, 1)
    assert.equal(res.errors.length, 2)
    assert.match(res.errors[0] as string, /attachment\.mediaType must be/)
  })

  it('caps the number of attachments at MAX_ATTACHMENTS (8)', () => {
    const res = normalizeAttachments(Array.from({ length: 12 }, () => ({ mediaType: 'image/png' })))
    assert.equal(res.attachments.length, 8)
    // Once the cap is hit, the loop stops and reports a single drop notice.
    assert.equal(res.errors.length, 1)
    assert.match(res.errors[0] as string, /capped/)
  })
})

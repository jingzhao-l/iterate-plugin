import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { findSkillMd, findSkillRoot, isAllowedSkillDir, normalizeAttachment, normalizeAttachments, renderAttachment, registerContextTool } from '../src/tools/context.ts'

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

describe('renderAttachment', () => {
  it('renders every optional field joined by separators', () => {
    const text = renderAttachment(
      { name: 'shot.png', mediaType: 'image/png', width: 1280, height: 800, note: 'broken layout' },
      0,
    )
    assert.equal(text, '[1] · shot.png · image/png · 1280x800 · broken layout')
  })

  it('degrades to just the index for an empty attachment', () => {
    assert.equal(renderAttachment({}, 2), '[3]')
  })

  it('omits a lone dimension when the other one is missing', () => {
    const text = renderAttachment({ mediaType: 'image/webp', width: 640 }, 1)
    assert.equal(text, '[2] · image/webp')
    assert.ok(!text.includes('640'))
  })
})

describe('isAllowedSkillDir', () => {
  it('accepts an existing directory inside the allowed roots', () => {
    const { root, cleanup } = tempTree()
    try {
      const skillDir = join(root, 'skill')
      mk(skillDir)
      assert.equal(isAllowedSkillDir(skillDir, [root]), true)
    } finally {
      cleanup()
    }
  })

  it('accepts the allowed root itself', () => {
    const { root, cleanup } = tempTree()
    try {
      assert.equal(isAllowedSkillDir(root, [root]), true)
    } finally {
      cleanup()
    }
  })

  it('rejects a directory outside the allowed roots', () => {
    const { root, cleanup } = tempTree()
    try {
      const other = mkdtempSync(join(tmpdir(), 'iterate-context-other-'))
      try {
        mk(other)
        assert.equal(isAllowedSkillDir(other, [root]), false)
      } finally {
        rmSync(other, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })

  it('rejects a nonexistent directory and an empty path', () => {
    const { root, cleanup } = tempTree()
    try {
      assert.equal(isAllowedSkillDir(join(root, 'nope'), [root]), false)
      assert.equal(isAllowedSkillDir('   ', [root]), false)
    } finally {
      cleanup()
    }
  })

  it('rejects a symlink whose target is outside the allowed roots', () => {
    const { root, cleanup } = tempTree()
    try {
      const outside = mkdtempSync(join(tmpdir(), 'iterate-context-outside-'))
      try {
        symlinkSync(outside, join(root, 'sneaky'))
        assert.equal(isAllowedSkillDir(join(root, 'sneaky'), [root]), false)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })

  it('accepts a symlink whose target is inside the allowed roots', () => {
    const { root, cleanup } = tempTree()
    try {
      const realDir = join(root, 'real')
      mk(realDir)
      symlinkSync(realDir, join(root, 'alias'))
      assert.equal(isAllowedSkillDir(join(root, 'alias'), [root]), true)
    } finally {
      cleanup()
    }
  })
})

describe('iterate_context skillDir realpath resolution', () => {
  function captureTool(): (args: unknown) => Promise<unknown> {
    let def: { execute: (a: unknown, e: unknown) => Promise<unknown> } | null = null
    registerContextTool({
      tools: { register: (d: never) => { def = d as typeof def } },
    } as never)
    if (!def) throw new Error('iterate_context was not registered')
    const exec = { signal: new AbortController().signal }
    return (args: unknown) => def!.execute(args, exec as never) as Promise<unknown>
  }

  it('reads through the SYMLINK-RESOLVED skillDir, not the raw link path', async () => {
    const { root, cleanup } = tempTree()
    try {
      // SKILL.md lives in `real`; `alias` is a symlink to it.
      const realDir = join(root, 'real')
      writeSkill(realDir, '# Skill instructions')
      symlinkSync(realDir, join(root, 'alias'))

      const tool = captureTool()
      const res = (await tool({ files: 'skill', path: root, skillDir: join(root, 'alias') })) as Record<string, unknown>
      assert.equal(res.error, undefined)
      assert.equal(res.found, true)
      assert.match(res.skill as string, /Skill instructions/)
      // The first search candidate is the VALIDATED realpath (closes the
      // check-vs-read TOCTOU window) — never the raw symlink spelling.
      assert.equal(res.skillSource, realpathSync(join(root, 'alias')))
      assert.equal((res.searched as string[])[0], realpathSync(join(root, 'alias')))
    } finally {
      cleanup()
    }
  })

  it('falls through to lower-priority candidates when skillDir is not an existing dir', async () => {
    const { root, cleanup } = tempTree()
    try {
      writeSkill(root, '# Project skill')
      const tool = captureTool()
      const missingDir = resolve(join(root, 'does-not-exist'))
      const res = (await tool({ files: 'skill', path: root, skillDir: missingDir })) as Record<string, unknown>
      assert.equal(res.found, true)
      // The invalid candidate is skipped entirely (never a search candidate)
      // and the read still lands on a real SKILL.md via the fallback chain.
      assert.equal((res.searched as string[]).includes(missingDir), false)
      assert.ok(res.searched && (res.searched as string[]).length >= 2)
      assert.ok(res.skill && (res.skill as string).length > 0)
    } finally {
      cleanup()
    }
  })
})

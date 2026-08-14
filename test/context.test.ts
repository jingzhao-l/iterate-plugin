import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { findSkillMd, findSkillRoot } from '../src/tools/context.ts'

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

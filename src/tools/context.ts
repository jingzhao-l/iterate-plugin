import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveProjectRootForExec } from '../config-loader.ts'

/** How many ancestor directories we walk up looking for a SKILL.md. */
const MAX_SKILL_DIR_LOOKUP_DEPTH = 12

/** Maximum number of image attachments relayed into the context in one call. */
const MAX_ATTACHMENTS = 8

/** Maximum intrinsic width/height (px) accepted for an attached image. */
const MAX_ATTACHMENT_DIMENSION = 16384

/** A validated, normalized image-attachment entry carried into review context. */
export interface NormalizedAttachment {
  name?: string
  mediaType?: string
  width?: number
  height?: number
  note?: string
}

/** Validation result for a raw attachment entry. */
export type AttachmentValidationResult =
  | { ok: true; value: NormalizedAttachment }
  | { ok: false; error: string }

/**
 * Validate and normalize one raw image-attachment entry passed by the
 * orchestrator. The top-level model observes user-attached images in its own
 * context (as image blocks) and relays their metadata here so reviewers get the
 * same visual evidence. Pure — exported for unit tests.
 */
export function normalizeAttachment(raw: unknown): AttachmentValidationResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'attachment must be an object' }
  }
  const entry = raw as Record<string, unknown>
  const out: NormalizedAttachment = {}
  if (entry.name !== undefined) {
    if (typeof entry.name !== 'string' || entry.name.length > 256) {
      return { ok: false, error: 'attachment.name must be a string (≤ 256 chars)' }
    }
    out.name = entry.name
  }
  if (entry.mediaType !== undefined) {
    if (typeof entry.mediaType !== 'string' || !/^image\/(png|jpeg|webp|gif)$/.test(entry.mediaType)) {
      return { ok: false, error: 'attachment.mediaType must be image/png, image/jpeg, image/webp, or image/gif' }
    }
    out.mediaType = entry.mediaType
  }
  for (const dim of ['width', 'height'] as const) {
    if (entry[dim] !== undefined) {
      if (typeof entry[dim] !== 'number' || !Number.isInteger(entry[dim]) || entry[dim] < 0 || entry[dim] > MAX_ATTACHMENT_DIMENSION) {
        return { ok: false, error: `attachment.${dim} must be an integer in [0, ${MAX_ATTACHMENT_DIMENSION}]` }
      }
      out[dim] = entry[dim]
    }
  }
  if (entry.note !== undefined) {
    if (typeof entry.note !== 'string' || entry.note.length > 1000) {
      return { ok: false, error: 'attachment.note must be a string (≤ 1000 chars)' }
    }
    out.note = entry.note
  }
  return { ok: true, value: out }
}

/**
 * Validate a whole attachments array, dropping invalid entries.
 * Returns the normalized list plus the reasons for any dropped entries.
 */
export function normalizeAttachments(raw: unknown): {
  attachments: NormalizedAttachment[]
  errors: string[]
} {
  const attachments: NormalizedAttachment[] = []
  const errors: string[] = []
  if (raw === undefined || raw === null) return { attachments, errors }
  if (!Array.isArray(raw)) return { attachments, errors: ['attachments must be an array'] }
  for (let i = 0; i < raw.length; i++) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      errors.push(`attachments capped at ${MAX_ATTACHMENTS}; entry ${i} dropped`)
      break
    }
    const result = normalizeAttachment(raw[i])
    if (result.ok) attachments.push(result.value)
    else errors.push(`attachments[${i}]: ${result.error}`)
  }
  return { attachments, errors }
}

/**
 * Render a normalized attachment as a compact text block for the model.
 */
export function renderAttachment(a: NormalizedAttachment, index: number): string {
  const bits: string[] = [`[${index + 1}]`]
  if (a.name) bits.push(a.name)
  if (a.mediaType) bits.push(a.mediaType)
  if (typeof a.width === 'number' && typeof a.height === 'number') bits.push(`${a.width}x${a.height}`)
  if (a.note) bits.push(a.note)
  return bits.join(' · ')
}

/**
 * The directory this source file lives in (…/src/tools). The plugin's own
 * package root is one level up (…/src), and the skill root is typically a few
 * levels above that. We use it as the anchor for auto-detecting where the
 * original SKILL.md lives.
 */
const PLUGIN_SRC_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Walk up from the plugin's own location until a directory containing SKILL.md
 * is found. This is how the plugin locates the ORIGINAL skill (skill 目录)
 * without any hardcoded absolute path — it works whether the plugin is mounted
 * from the source tree or bundled next to the skill.
 *
 * Returns the absolute directory containing SKILL.md, or null if none found
 * within `MAX_SKILL_DIR_LOOKUP_DEPTH` ancestors.
 */
function findSkillRoot(startDir: string): string | null {
  let dir = resolve(startDir)
  for (let depth = 0; depth < MAX_SKILL_DIR_LOOKUP_DEPTH; depth++) {
    if (existsSync(join(dir, 'SKILL.md'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break // reached the filesystem root
    dir = parent
  }
  return null
}

/** Exported for unit tests. See the private `findSkillRoot` above. */
export { findSkillRoot }

/**
 * Read a file from a candidate directory, returning its content or null.
 */
function readProjectFile(projectRoot: string, filename: string): string | null {
  const filePath = join(projectRoot, filename)
  if (!existsSync(filePath)) return null
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Locate the first existing SKILL.md across the candidate directories, in
 * priority order:
 *   1. explicit skillDir (custom path / 自定义路径)
 *   2. auto-detected skill root walking up from the plugin (skill 目录)
 *   3. project root (项目根)
 * Returns the file content plus the directory it was found in, or null.
 */
function findSkillMd(candidates: string[]): { content: string; sourceDir: string } | null {
  for (const dir of candidates) {
    if (!dir) continue
    const content = readProjectFile(dir, 'SKILL.md')
    if (content !== null) return { content, sourceDir: dir }
  }
  return null
}

/** Exported for unit tests. See the private `findSkillMd` above. */
export { findSkillMd }

/**
 * Register the `iterate_context` tool.
 * Reads SKILL.md (original skill instructions) from the skill directory,
 * project root, or a custom path, and ITERATE.md from the project root.
 * Provides the model with the original skill instructions and project knowledge base.
 */
export function registerContextTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_context',
      description:
        'Read project context files (SKILL.md and/or ITERATE.md). ' +
        'SKILL.md contains the original iterate skill instructions; it is searched in ' +
        'the skill directory (auto-detected), the project root, or an explicit `skillDir`. ' +
        'ITERATE.md contains the project-specific knowledge base and onboarding information. ' +
        'Also relays user-attached image metadata (e.g. UI screenshots, error dialogs) into ' +
        'the review context so reviewers can treat them as visual evidence. ' +
        'Use this to understand the skill workflow, project context, and any attached visuals.',

      parameters: {
        files: {
          type: 'string',
          required: true,
          description:
            'Comma-separated list of files to read: "skill", "project", or "skill,project" for both.',
        },
        path: {
          type: 'string',
          description: 'Project root directory (default: current working directory).',
        },
        skillDir: {
          type: 'string',
          description:
            'Custom directory to search for SKILL.md (highest priority). ' +
            'When omitted, SKILL.md is auto-detected from the skill directory, then the project root.',
        },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'Optional display name of the attached image.' },
              mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], description: 'Optional media type of the image.' },
              width: { type: 'integer', description: 'Optional intrinsic width in pixels.' },
              height: { type: 'integer', description: 'Optional intrinsic height in pixels.' },
              note: { type: 'string', description: 'Optional short description of what the image shows and why it matters for this review.' },
            },
          },
          description:
            'Optional: image attachments observed in the session (e.g. UI screenshots, error ' +
            'dialogs, design references) relayed into the review context. The top-level model ' +
            'sees these images natively and passes their metadata here so reviewers get the same ' +
            'visual evidence. Up to 8 entries; invalid entries are dropped and reported.',
        },
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            skill: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            project: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            skillSource: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            error: { type: 'string' },
            searched: { type: 'array', items: { type: 'string' } },
            attachments: { type: 'array', items: { type: 'string' }, description: 'Normalized attached-image descriptions relayed to reviewers.' },
            attachmentErrors: { type: 'array', items: { type: 'string' }, description: 'Reasons for any attachment entries that were dropped.' },
          },
        },
        render: (_args, value) => {
          const parts: string[] = []
          if (value.skill) parts.push(`--- SKILL.md (${value.skillSource ?? '?source?'}) ---\n${value.skill}`)
          if (value.project) parts.push(`--- ITERATE.md ---\n${value.project}`)
          if (Array.isArray(value.attachments) && value.attachments.length > 0) {
            parts.push(`--- User-attached images (${value.attachments.length}) ---\n${value.attachments.join('\n')}`)
          }
          if (!value.skill && !value.project && !(Array.isArray(value.attachments) && value.attachments.length > 0)) {
            parts.push('No files found. Searched: ' + (value.searched?.join(', ') ?? 'none'))
          }
          if (Array.isArray(value.attachmentErrors) && value.attachmentErrors.length > 0) {
            parts.push('Attachment warnings: ' + value.attachmentErrors.join('; '))
          }
          return [{ type: 'text', text: parts.join('\n\n') }]
        },
      },

      async execute(args, exec) {
        const resolved = resolveProjectRootForExec(exec, args.path)
        if (!resolved.ok) {
          return { found: false, error: resolved.reason, searched: [] }
        }
        const projectRoot = resolved.root
        const requested = (args.files ?? '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)

        const result: {
          found: boolean
          skill?: string | null
          project?: string | null
          skillSource?: string | null
          searched: string[]
          attachments?: string[]
          attachmentErrors?: string[]
        } = { found: true, searched: [] }

        // Relay user-attached image metadata into the review context. The
        // orchestrator observes attached images in the session and passes their
        // metadata here; invalid entries are dropped with a reported reason.
        const attachments = normalizeAttachments(args.attachments)
        if (attachments.attachments.length > 0) {
          result.attachments = attachments.attachments.map(renderAttachment)
        }
        if (attachments.errors.length > 0) {
          result.attachmentErrors = attachments.errors
        }

        if (requested.includes('skill') || requested.includes('skill.md')) {
          // Candidate dirs in priority order: custom path → auto-detected skill
          // root → project root. This is how "skill 目录、项目根、自定义路径"
          // are all supported.
          const skillRoot = findSkillRoot(PLUGIN_SRC_DIR)
          const candidates: string[] = []
          if (args.skillDir) candidates.push(args.skillDir)
          if (skillRoot) candidates.push(skillRoot)
          candidates.push(projectRoot)
          result.searched = candidates

          const found = findSkillMd(candidates)
          result.skill = found ? found.content : null
          result.skillSource = found ? found.sourceDir : null
        }
        if (requested.includes('project') || requested.includes('iterate.md')) {
          result.project = readProjectFile(projectRoot, 'ITERATE.md')
        }

        return result
      },
    }),
  )
}

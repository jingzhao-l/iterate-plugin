import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Read a file from the project root, returning its content or null.
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
 * Register the `iterate_context` tool.
 * Reads SKILL.md and/or ITERATE.md from the project root.
 * Provides the model with the original skill instructions and project knowledge base.
 */
export function registerContextTool(ctx: { tools: { register: (def: ReturnType<typeof defineTool>) => void } }): void {
  ctx.tools.register(
    defineTool({
      name: 'iterate_context',
      description:
        'Read project context files (SKILL.md and/or ITERATE.md) from the project root. ' +
        'SKILL.md contains the original iterate skill instructions. ' +
        'ITERATE.md contains the project-specific knowledge base and onboarding information. ' +
        'Use this to understand the skill workflow and project context.',

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
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            skill: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            project: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
        render: (_args, value) => {
          const parts: string[] = []
          if (value.skill) parts.push(`--- SKILL.md ---\n${value.skill}`)
          if (value.project) parts.push(`--- ITERATE.md ---\n${value.project}`)
          if (!value.skill && !value.project) parts.push('No files found.')
          return [{ type: 'text', text: parts.join('\n\n') }]
        },
      },

      async execute(args) {
        const projectRoot = args.path ?? process.cwd()
        const requested = (args.files ?? '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)

        const result: { found: boolean; skill?: string | null; project?: string | null } = { found: true }

        if (requested.includes('skill') || requested.includes('skill.md')) {
          result.skill = readProjectFile(projectRoot, 'SKILL.md')
        }
        if (requested.includes('project') || requested.includes('iterate.md')) {
          result.project = readProjectFile(projectRoot, 'ITERATE.md')
        }

        return result
      },
    }),
  )
}
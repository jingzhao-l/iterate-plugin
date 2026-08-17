import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveProjectRoot } from "../config-loader.js";
/** How many ancestor directories we walk up looking for a SKILL.md. */
const MAX_SKILL_DIR_LOOKUP_DEPTH = 12;
/**
 * The directory this source file lives in (…/src/tools). The plugin's own
 * package root is one level up (…/src), and the skill root is typically a few
 * levels above that. We use it as the anchor for auto-detecting where the
 * original SKILL.md lives.
 */
const PLUGIN_SRC_DIR = dirname(fileURLToPath(import.meta.url));
/**
 * Walk up from the plugin's own location until a directory containing SKILL.md
 * is found. This is how the plugin locates the ORIGINAL skill (skill 目录)
 * without any hardcoded absolute path — it works whether the plugin is mounted
 * from the source tree or bundled next to the skill.
 *
 * Returns the absolute directory containing SKILL.md, or null if none found
 * within `MAX_SKILL_DIR_LOOKUP_DEPTH` ancestors.
 */
function findSkillRoot(startDir) {
    let dir = resolve(startDir);
    for (let depth = 0; depth < MAX_SKILL_DIR_LOOKUP_DEPTH; depth++) {
        if (existsSync(join(dir, 'SKILL.md')))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            break; // reached the filesystem root
        dir = parent;
    }
    return null;
}
/** Exported for unit tests. See the private `findSkillRoot` above. */
export { findSkillRoot };
/**
 * Read a file from a candidate directory, returning its content or null.
 */
function readProjectFile(projectRoot, filename) {
    const filePath = join(projectRoot, filename);
    if (!existsSync(filePath))
        return null;
    try {
        return readFileSync(filePath, 'utf-8');
    }
    catch {
        return null;
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
function findSkillMd(candidates) {
    for (const dir of candidates) {
        if (!dir)
            continue;
        const content = readProjectFile(dir, 'SKILL.md');
        if (content !== null)
            return { content, sourceDir: dir };
    }
    return null;
}
/** Exported for unit tests. See the private `findSkillMd` above. */
export { findSkillMd };
/**
 * Register the `iterate_context` tool.
 * Reads SKILL.md (original skill instructions) from the skill directory,
 * project root, or a custom path, and ITERATE.md from the project root.
 * Provides the model with the original skill instructions and project knowledge base.
 */
export function registerContextTool(ctx) {
    ctx.tools.register(defineTool({
        name: 'iterate_context',
        description: 'Read project context files (SKILL.md and/or ITERATE.md). ' +
            'SKILL.md contains the original iterate skill instructions; it is searched in ' +
            'the skill directory (auto-detected), the project root, or an explicit `skillDir`. ' +
            'ITERATE.md contains the project-specific knowledge base and onboarding information. ' +
            'Use this to understand the skill workflow and project context.',
        parameters: {
            files: {
                type: 'string',
                required: true,
                description: 'Comma-separated list of files to read: "skill", "project", or "skill,project" for both.',
            },
            path: {
                type: 'string',
                description: 'Project root directory (default: current working directory).',
            },
            skillDir: {
                type: 'string',
                description: 'Custom directory to search for SKILL.md (highest priority). ' +
                    'When omitted, SKILL.md is auto-detected from the skill directory, then the project root.',
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
                },
            },
            render: (_args, value) => {
                const parts = [];
                if (value.skill)
                    parts.push(`--- SKILL.md (${value.skillSource ?? '?source?'}) ---\n${value.skill}`);
                if (value.project)
                    parts.push(`--- ITERATE.md ---\n${value.project}`);
                if (!value.skill && !value.project) {
                    parts.push('No files found. Searched: ' + (value.searched?.join(', ') ?? 'none'));
                }
                return [{ type: 'text', text: parts.join('\n\n') }];
            },
        },
        async execute(args) {
            const resolved = resolveProjectRoot(args.path);
            if (!resolved.ok) {
                return { found: false, error: resolved.reason, searched: [] };
            }
            const projectRoot = resolved.root;
            const requested = (args.files ?? '')
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean);
            const result = { found: true, searched: [] };
            if (requested.includes('skill') || requested.includes('skill.md')) {
                // Candidate dirs in priority order: custom path → auto-detected skill
                // root → project root. This is how "skill 目录、项目根、自定义路径"
                // are all supported.
                const skillRoot = findSkillRoot(PLUGIN_SRC_DIR);
                const candidates = [];
                if (args.skillDir)
                    candidates.push(args.skillDir);
                if (skillRoot)
                    candidates.push(skillRoot);
                candidates.push(projectRoot);
                result.searched = candidates;
                const found = findSkillMd(candidates);
                result.skill = found ? found.content : null;
                result.skillSource = found ? found.sourceDir : null;
            }
            if (requested.includes('project') || requested.includes('iterate.md')) {
                result.project = readProjectFile(projectRoot, 'ITERATE.md');
            }
            return result;
        },
    }));
}

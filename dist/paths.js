/**
 * Shared filesystem layout for the iterate plugin's runtime state.
 *
 * All runtime artifacts live under `<projectRoot>/.iterate/`:
 *   .iterate/decision-log.jsonl   — append-only decision log
 *   .iterate/fixes/               — fix system: backups + fix registry
 *   .iterate/checkpoint.json      — iteration checkpoint (resume support)
 *
 * Kept separate from config-loader so every tool points at the same dirs.
 */
import { join } from 'node:path';
/** Runtime state root for a project (e.g. `<projectRoot>/.iterate`). */
export function iterateDir(projectRoot) {
    return join(projectRoot, '.iterate');
}
/** Fix-system directory (backups + registry). */
export function fixesDir(projectRoot) {
    return join(iterateDir(projectRoot), 'fixes');
}
/** Fix-registry file (JSON). */
export function fixRegistryPath(projectRoot) {
    return join(fixesDir(projectRoot), 'registry.json');
}
/** Fix-backup file for one fix id + timestamp. */
export function fixBackupPath(projectRoot, id, timestamp) {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(fixesDir(projectRoot), `${safe}_${timestamp.replace(/[:.]/g, '-')}.bak`);
}
/** Iteration checkpoint file (JSON). */
export function checkpointPath(projectRoot) {
    return join(iterateDir(projectRoot), 'checkpoint.json');
}

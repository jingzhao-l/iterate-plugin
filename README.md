# iterate-plugin for DeepSeek Harness (dsh)

<p align="center">
  <a href="README.md"><strong>English</strong></a> ·
  <a href="README.zh-CN.md"><strong>简体中文</strong></a>
</p>

> **Developed and reviewed in the [iterate-skill monorepo](https://github.com/jingzhao-l/iterate-skill)**: the plugin code is maintained in the main repository and synced here via `git subtree`; **releases and npm publishing happen in this (plugin) repository**, which is the canonical publish point for the dsh ecosystem. Please **star / fork the main repository** and file issues at the [main repository Issues](https://github.com/jingzhao-l/iterate-skill/issues).

## About This Plugin

**iterate** is an open-source project that gives AI coding assistants the ability to review and fix code in multi-round autonomous loops. It targets a concrete pain point:

> AI assistants tend to "talk a lot but do little": a single conversation only touches a few lines, stops caring about the rest of the repo after seeing one file, and rarely double-checks what they broke. iterate automates these closing chores — itemized review, per-dimension triage, fix, validate, and iterate again — so AI actually finishes changes and gets them right.

`iterate-plugin` is the [iterate](https://github.com/jingzhao-l/iterate-skill) integration for the [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) desktop client. It brings iterate's review loop (review → triage → fix → validate → converge) directly into the dsh UI, offering **autonomous closed-loop code iteration** (normal mode) and **dry-run read-only multi-round review**.

Besides 13 pure-function tools, it ships a **build-free Web UI layer** (triage panel, convergence dashboard, stats card, theme skin, etc.) that plugs straight into dsh's existing UI slots. Configuration (`iterate.config.yaml` and the review dimensions) is identical across the other two components of the iterate ecosystem (skill / headless engine) — zero migration cost.

## Features

### Two modes

| Capability | dry-run | normal |
| --- | --- | --- |
| Repeated review until convergence | ✅ | ✅ |
| Parallel dimension review | ✅ | ✅ |
| Deterministic aggregation / dedupe / sort | ✅ | ✅ |
| meta-review report consistency audit | ✅ | ✅ |
| Zero file modification (read-only) | ✅ | ❌ |
| Automatic atomic fix | ❌ | ✅ |
| Validation after each round's fixes | ❌ | ✅ |
| Rollback on failed fixes | ❌ | ✅ |
| Self-stop when converged | ✅ | ✅ |
| Fix atomic findings only, keep architectural for later | ❌ | ✅ |
| Breakpoint save / resume (long iterations) | ✅ | ✅ |

### Tool layer

- **13 registered tools**: `iterate_config` / `iterate_validate` / `iterate_decision_log` / `iterate_context` / `iterate_review` / `iterate_triage` / `iterate_fix` / `iterate_diff` / `iterate_rollback` / `iterate_checkpoint` / `iterate_status` / `iterate_history` / `iterate_prune`
- **Findings triage loop**: review → UI triage (y/n/a) → `iterate_triage` writes back `known_intentional` → auto-filtered next round
- **Structured fix system**: each fix backs up first, writes a registry entry, records the diff; a failed validation can be reverted with `iterate_rollback`
- **Breakpoint resume**: checkpoints saved at the start of each round; interrupted long iterations can resume
- **History audit**: `iterate_history` reads the decision log (filtered by type / time / count) and the fix registry summary to audit run process and fix details
- **Runtime cleanup**: `iterate_prune` removes stale decision-log entries, stale checkpoints, orphaned fix backups and empty rounds; dry-run by default (report-only), real cleanup requires `dryRun:false`, and every cleanup is logged
- **Config read / write**: `iterate_config` supports validated, backed-up, rollback-capable partial writes

### UI layer (build-free client slots)

| UI component | Mounted slot | Function |
| --- | --- | --- |
| ConvergenceDashboard | `conversation.input.dock` | Live round progress bar, severity stats, dimension badges, trend mini-chart above the input; normal mode also shows fix-count badges |
| TriagePanel | `conversation.chat.turnTail` | Per-finding y/n/a triage, filtering, batch (incl. select-all), keyboard shortcuts, localStorage persistence, copy-YAML / apply-instruction |
| StatsCard | `conversation.chat.turnTail` | When no findings remain: convergence stats, round history table, trend chart, completion summary |
| iterate theme skin | `theme.overrideTokens` | Warm-amber 13-dsw-token override, light/dark modes, togglable in settings |
| ProgressCapsule | `shell.overlay` | Popup notification on each round completion / convergence (incl. convergence confirm) |
| SettingsPanel | `settings.section` | Theme toggle, triage-persistence notes, config-management guide, runtime status overview (artifact layout + view/cleanup tool guide), one-click triage data reset |

The UI layer is **defensive by design**: it degrades gracefully if any of `slots` / `theme` / `React` is unavailable — it never crashes the client.

## Installation

### From npm

```bash
dsh plugin --profile web add iterate-plugin
# or
pnpm add iterate-plugin
```

### From GitHub (dsh ecosystem third-party install)

dsh officially supports installing plugins directly from a GitHub repo: `dsh plugin --profile web add "github:owner/repo#ref"` (repo root is the plugin, auto-enabled once `dsh.bundle` is declared). This plugin's standalone [iterate-plugin repository](https://github.com/jingzhao-l/iterate-plugin) has the repo-root-is-plugin publish point, synced from the main repo via `git subtree`, content identical to the npm package:

```bash
dsh plugin --profile web add "github:jingzhao-l/iterate-plugin#main"
```

After installation, restart the dsh service (recommended `dsh web --patch`) and refresh the page so both the host and the client UI layer load.

### Local development / source mount

```bash
dsh plugin --profile web add /path/to/iterate-skill/harness/iterate-plugin
# or
pnpm add /path/to/iterate-skill/harness/iterate-plugin
```

Then add to your profile `cordis.patch.yml`:

```yaml
- insert:
  - id: iterate-plugin
    name: 'iterate-plugin'
```

> The package carries its own `dsh.bundle.patch` (i.e. `cordis.patch.yml`); the npm package's `files` whitelist is `src` / `lib` / `dist` / `cordis.patch.yml` / `README.md` / `LICENSE`. `dist/` is the compiled output of the TypeScript server-side logic, shipped with the package so it works with dsh's `github:owner/repo#ref` git-clone install (Node does not strip TS types under `node_modules`).

## Usage

### dry-run mode (read-only review, no file changes)

When you want "just review repeatedly, modify nothing", an example prompt:

```
dry-run review this project, find all issues across all dimensions
```

The plugin auto-triggers the iterate workflow:

1. `plan` → read config, generate the review plan
2. `loop` → review dimensions in parallel each round, only new findings → deterministic aggregation / dedupe → convergence stats → stop when no new findings
3. `meta-review` → audit report consistency
4. `report` → output final result

### normal mode (autonomous closed-loop iteration)

When you want "iterate this project / fix the issues found", an example prompt:

```
iterate on this project, fix all atomic issues
```

Workflow:

1. `plan` → read config
2. `loop` → parallel review → aggregate / dedupe → parallel atomic fixes → run validation commands → rollback on failure → log → stop when no new findings
3. `report` → output fix statistics

## Project configuration

Put `iterate.config.yaml` at the project root:

```yaml
# Review goal (e.g. "Improve code quality of the project")
goal: "Improve code quality of the project"
# Review dimensions (pick from the plugin's predefined set or customize)
dimensions:
  - correctness
  - security
  - performance
  - maintainability
  - code-style
# Max review rounds
max_rounds: 3
# Review scope
review:
  scope: full  # full = whole project, changed-only = only changed files
# Atomic fix threshold (max lines a single fix may change; beyond requires force)
atomic:
  max_lines: 20
# Known intentionally-unfixed issues (filtered out, never re-reported)
personalization:
  known_intentional:
    - file: src/example.ts
      line: 42
      dimension: security
      reason: "Intentional for demonstration"
# Validation commands (run after fixes; results logged)
validation:
  commands:
    - npm test
    - npm run typecheck
```

> The config can be read and **validated-partially-written** via `iterate_config` (auto backup, auto rollback on write failure).

## Registered tools (13)

| Tool | Function |
| --- | --- |
| `iterate_config` | Read / write `iterate.config.yaml`. `operation=read` returns the full config or a named section; `operation=write` schema-validates, backs up, then merges and writes — auto rollback on failure |
| `iterate_validate` | Run a whitelisted validation command, return the result |
| `iterate_decision_log` | Append a decision log entry (append-only, never edits old ones), stored in `.iterate/decision-log.jsonl` |
| `iterate_context` | Read the `SKILL.md` / `ITERATE.md` context |
| `iterate_review` | Deterministic review engine: `plan` builds the plan, `aggregate` dedupes + converges, `meta-review` audits report consistency. Pure computation, no filesystem access |
| `iterate_triage` | Manage `personalization.known_intentional`: `apply` validates, dedupes (file\|dimension\|line), backs up and writes back to config; `list` reads back the current entries. The only channel for the browser triage panel to write back to config |
| `iterate_fix` | Apply **one atomic fix**: validates the relative path, backs up the original file, enforces atomicity via `atomic.max_lines` (skippable with `force`), writes new content, records a FixRecord and an `atomic_fix` log. The only legal file-modifying entry in normal mode |
| `iterate_diff` | View accumulated fix changes: with `file`, returns the unified diff against the first backup; without it, a per-fixed-file summary |
| `iterate_rollback` | Roll back an applied fix: restore the file from backup, remove that FixRecord from the registry, append a `revert` log. Used after a failed round validation |
| `iterate_checkpoint` | Iteration breakpoint: `save` persists progress to `.iterate/checkpoint.json`, `load` reads it back, `clear` removes it. Resumable interrupted long iterations |
| `iterate_status` | Summarize current iteration state: mode, current/last round, fixes applied, remaining architectural, decision-log entry count, whether a checkpoint exists |
| `iterate_history` | Read iteration history (read-only): decision-log entries (filter by `type` / `since` / `limit`, default latest 50, cap 200) + fix-registry summary (per-round fixed/failed counts). For auditing the run, tracing logs, and inventorying fixes |
| `iterate_prune` | Clean runtime artifacts: stale decision-log entries (by `retainDays`, default 30), stale checkpoints, orphaned fix backups, empty rounds. Dry-run by default (report-only); real cleanup with `dryRun:false`, each cleanup logged |

## Runtime artifact layout

All runtime state lives under `.iterate/` at the project root (can be excluded via `.gitignore`):

```
.iterate/
  decision-log.jsonl      # append-only decision log (plan/review/fix/revert…)
  checkpoint.json         # iteration breakpoint (resume)
  fixes/
    registry.json         # fix registry (list of FixRecords, grouped by round)
    <fix-id>_<ts>.bak     # original file backup before each fix
```

## Design

The plugin follows dsh's "everything-is-a-plugin" architecture:

- **Does exactly two things**: injects the system prompt teaching the model the iterate workflow + registers 13 pure-function tools
- **All orchestration runs through dsh native `workflow` + `agent` + `parallel`**
- **Core logic is entirely pure functions** (dedupe / filter / sort / converge / meta-audit / diff computation / history filtering / cleanup reporting) — unit-testable, no I/O
- **Security model**: file writes confined to the resolved project root (path-traversal protection); always back up before writing, roll back on failure; config writes also back up + roll back; `iterate_prune` is dry-run by default and only clears artifacts under `.iterate/` with every cleanup logged; `iterate_fix` caps content length and `iterate_triage` caps entry count to fend off abnormal oversized payloads
- **Build-free UI**: `lib/client.js` uses a `React.createElement` tree + injected `<style>` tags, all colors via `--dsw-*` tokens, degrading gracefully when a service is missing
- Follows the iterate skill's design principles: deterministic convergence, auditable, least privilege

## Running the tests

```bash
cd harness/iterate-plugin
npm install
npm run typecheck
npm test
```

All tests pass:

- **212 unit tests green**, type-check clean
- Coverage: dedupe, filter, sort, multi-round convergence, meta-review audit, path safety, timeout clamping, config read/write + rollback, triage merge, diff computation, checkpoint validation, fix registry, history read + filter, prune cleanup report + dry-run semantics, UI pure functions (select-all key, runtime status guide).

## License

MIT
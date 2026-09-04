# iterate-plugin for DeepSeek Harness (dsh)

> dsh 桌面端的 iterate 质量指挥中心 + 经验银行插件（v3.1）。把 iterate 生态的同一套 review/fix loop 直接搬进 dsh 界面，新增质量门禁、经验银行、防御事件流与原生指挥操作。
> The iterate ecosystem's quality command center + experience bank plugin for dsh (v3.1). Natively embedded inside the DeepSeek Harness (dsh) desktop client with quality gates, experience bank, defense events stream, and native command buttons.

<p align="center">
  <a href="README.md"><strong>English</strong></a> ·
  <a href="README.zh-CN.md"><strong>简体中文</strong></a>
</p>

> **Developed and reviewed in the [iterate-skill monorepo](https://github.com/jingzhao-l/iterate-skill)**: the plugin code is maintained in the main repository and synced here via `git subtree`; **releases and npm publishing happen in this (plugin) repository**, which is the canonical publish point for the dsh ecosystem. Please **star / fork the main repository** and file issues at the [main repository Issues](https://github.com/jingzhao-l/iterate-skill/issues).

<p align="center">
  <a href="https://github.com/jingzhao-l/iterate-plugin"><img src="https://img.shields.io/github/stars/jingzhao-l/iterate-plugin?style=social&label=Star" alt="Stars"></a>
  <a href="https://github.com/jingzhao-l/iterate-skill"><img src="https://img.shields.io/github/stars/jingzhao-l/iterate-skill?style=social&label=Main%20Repo%20Star" alt="Main Repo Stars"></a>
  <a href="https://www.npmjs.com/package/iterate-plugin"><img src="https://img.shields.io/npm/dt/iterate-plugin?label=Downloads&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow" alt="License"></a>
  <a href="https://github.com/jingzhao-l/iterate-plugin/releases"><img src="https://img.shields.io/github/v/release/jingzhao-l/iterate-plugin" alt="GitHub release"></a>
</p>

> ⭐ If this helps your dsh workflow, give the main repo a star — it means a lot to open-source maintenance!

---

## The iterate Ecosystem / iterate 生态一览

**iterate** is not one single binary — it is a **skill ecosystem** that layers a strict multi-round code gate on top of your existing AI assistants, IDEs, and scripts. It never replaces your tools; it adds an audit-and-close-the-loop layer on them. The whole ecosystem ships as **three interchangeable components sharing one `iterate.config.yaml` + one review-dimension system**:

| Component | Form & Source | Target Scenario |
|---|---|---|
| **[Core Skill + CLI](https://github.com/jingzhao-l/iterate-skill)** | Portable AI skill `/iterate` + `iterate` CLI (source: iterate-skill monorepo root) | Conversation-driven multi-round iteration inside Trae / Claude Code / Cursor / Copilot / Codex and 25+ other assistants |
| **[iterate-harness](https://github.com/jingzhao-l/iterate-harness)** | Standalone headless engine, command `ih` (npm: `iterate-harness`) | Run the EXACT same loop in terminal / CI / git hooks, without any conversational assistant required |
| **iterate-plugin (this repo)** | dsh desktop-client plugin (npm: `iterate-plugin`) | Plug the harness runtime **into the dsh UI**: convergence dashboard, triage panel, round progress — all surfaced as native dsh widgets |

How they fit together: **Core Skill** is the canonical, assistant-agnostic review/fix engine (the "brains"). **iterate-harness** is the same engine wrapped as a headless CLI + WebUI for unattended runs. **iterate-plugin** (this repository) wraps that harness runtime as a dsh plugin, rendering the triage UI and convergence dashboard directly inside the dsh desktop client. Configuration (`iterate.config.yaml`) and the 9-dimension review system are **identical across all three** — learn one, use them all.

Quick install / entry points for the rest of the ecosystem:

```bash
# Core Skill + CLI (install into 25+ AI assistants)
npx iterate-skill-installer

# iterate-harness: headless engine (npm wrapper, simplest)
npm install -g iterate-harness
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/iterate-harness/main/scripts/install.sh | bash
ih iterate init && ih iterate review

# iterate-plugin: dsh desktop plugin (this repo — commands repeated under Installation below)
dsh plugin --profile web add iterate-plugin
```

> This document focuses on **iterate-plugin (this repo)**. For Core Skill docs see the [iterate-skill monorepo](https://github.com/jingzhao-l/iterate-skill); for headless engine docs see [iterate-harness](https://github.com/jingzhao-l/iterate-harness).

---

## About This Plugin

**iterate** is an open-source project that gives AI coding assistants the ability to review and fix code in multi-round autonomous loops. It targets a concrete pain point:

> AI assistants tend to "talk a lot but do little": a single conversation only touches a few lines, stops caring about the rest of the repo after seeing one file, and rarely double-checks what they broke. iterate automates these closing chores — itemized review, per-dimension triage, fix, validate, and iterate again — so AI actually finishes changes and gets them right.

`iterate-plugin` is the [iterate](https://github.com/jingzhao-l/iterate-skill) integration for the [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) desktop client. It brings iterate's review loop (review → triage → fix → validate → converge) directly into the dsh UI, offering **autonomous closed-loop code iteration** (normal mode) and **dry-run read-only multi-round review**.

**v3.1 Quality Command Center**: The plugin has been upgraded from a "passive observation panel" to an "active command center + knowledge base". New features include quality gate view, experience bank, defense events stream, native command buttons, and task_mode indicator.

Besides 17 pure-function tools, it ships a **build-free Web UI layer** (convergence dashboard, triage panel, stats card, observatory panel with 10 tabs, theme skin, etc.) that plugs straight into dsh's existing UI slots. Configuration (`iterate.config.yaml` and the review dimensions) is identical across the other two components of the iterate ecosystem ([skill](https://github.com/jingzhao-l/iterate-skill) / [headless engine](https://github.com/jingzhao-l/iterate-harness)) — zero migration cost.

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

### Tool layer (v3.1: 17 tools)

- **17 registered tools** (14 original + 3 v3.1 quality command center tools):
  - Original: `iterate_config` / `iterate_validate` / `iterate_decision_log` / `iterate_context` / `iterate_review` / `iterate_triage` / `iterate_fix` / `iterate_diff` / `iterate_rollback` / `iterate_checkpoint` / `iterate_status` / `iterate_history` / `iterate_prune` / `iterate_transcript`
  - v3.1: `iterate_experience` / `iterate_quality_gate` / `iterate_defense_events`
- **Findings triage loop**: review → UI triage (y/n/a) → `iterate_triage` writes back `known_intentional` → auto-filtered next round
- **Structured fix system**: each fix backs up first, writes a registry entry, records the diff; a failed validation can be reverted with `iterate_rollback`
- **Breakpoint resume**: checkpoints saved at the start of each round; interrupted long iterations can resume
- **History audit**: `iterate_history` reads the decision log (filtered by type / time / count) and the fix registry summary to audit run process and fix details
- **Runtime cleanup**: `iterate_prune` removes stale decision-log entries, stale checkpoints, orphaned fix backups and empty rounds; dry-run by default (report-only), real cleanup requires `dryRun:false`, and every cleanup is logged
- **Config read / write**: `iterate_config` supports validated, backed-up, rollback-capable partial writes
- **v3.1 Experience Bank**: `iterate_experience` queries historical fixes and patterns with search/filter/adopt
- **v3.1 Quality Gate**: `iterate_quality_gate` queries quality gate status with dimension convergence rates and PASS/FAIL
- **v3.1 Defense Events**: `iterate_defense_events` queries defense events (precondition failures, rollbacks, invariant violations, assumption falsifications)

### UI layer (build-free client slots, v3.1: 10 tabs)

| UI component | Mounted slot | Function |
| --- | --- | --- |
| ConvergenceDashboard | `conversation.input.dock` | Live round progress bar, severity stats, dimension badges, trend mini-chart above the input; normal mode also shows fix-count badges; plus a live workflow-phase chip (current phase + running/stopped); **v3.1: task_mode indicator (code/iterate)** |
| ObservatoryPanel | `conversation.input.dock` | **Ten-tab** runtime observatory below the input: live activity stream (type filter), review threads (expand/collapse all), convergence trend, finding locations (severity/dimension/search filter), fixes + rollback, checkpoint resume, decision timeline (type/round filter + search); **v3.1: Quality Gate (F8)**, **Experience Bank (F9)**, **Defense Events (F10)**; one-click export of all observatory data to JSON (download, copy fallback) |
| TriagePanel | `conversation.chat.turnTail` | Per-finding y/n/a triage, filtering, batch (incl. select-all), keyboard shortcuts, localStorage persistence, copy-YAML / apply-instruction; **v3.1: Native command buttons (approve architectural fix, trigger new round, rollback to checkpoint)** |
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

## Registered tools (v3.1: 17)

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
| `iterate_transcript` | Runtime observatory: persist review transcripts, threads, fixes, and nudge directions to `.iterate/transcript.json` for the client observatory |
| `iterate_experience` | **v3.1** Query experience bank: browse/search historical fixes and patterns. Returns matching entries with hit counts, verified fixes, and related context. Read-only |
| `iterate_quality_gate` | **v3.1** Query quality gate status: dimension convergence rates, verification pass rates, and overall PASS/FAIL. Returns a machine-readable quality certificate. Read-only |
| `iterate_defense_events` | **v3.1** Query defense events: precondition failures, rollbacks, invariant violations, and assumption falsifications. Returns events with descriptions and outcomes. Read-only |

## Runtime artifact layout

All runtime state lives under `.iterate/` at the project root (can be excluded via `.gitignore`):

```
.iterate/
  decision-log.jsonl      # append-only decision log (plan/review/fix/revert…)
  checkpoint.json         # iteration breakpoint (resume)
  transcript.json         # runtime-observatory manifest (per-reviewer threads, trend, fixes, timeline, nudge)
  transcript-live.ndjson  # append-only near-real-time reviewer-activity feed (read/fix/rollback/validate…), byte-capped
  experience.json         # v3.1: experience bank (historical fixes and patterns, accumulated across sessions)
  quality-gate.json       # v3.1: quality gate snapshot (dimension convergence, verification pass rates, PASS/FAIL)
  defense-events.json     # v3.1: defense events stream (precondition failures, rollbacks, invariant violations, assumption falsifications)
  fixes/
    registry.json         # fix registry (list of FixRecords, grouped by round)
    <fix-id>_<ts>.bak     # original file backup before each fix
```

## Design

The plugin follows dsh's "everything-is-a-plugin" architecture:

- **Does exactly two things**: injects the system prompt teaching the model the iterate workflow + registers 17 pure-function tools
- **All orchestration runs through dsh native `workflow` + `agent` + `parallel`**
- **Core logic is entirely pure functions** (dedupe / filter / sort / converge / meta-audit / diff computation / history filtering / cleanup reporting) — unit-testable, no I/O
- **Security model**: file writes confined to the resolved project root (path-traversal protection); always back up before writing, roll back on failure; config writes also back up + roll back; `iterate_prune` is dry-run by default and only clears artifacts under `.iterate/` with every cleanup logged; `iterate_fix` caps content length and `iterate_triage` caps entry count to fend off abnormal oversized payloads
- **Build-free UI**: `lib/client.js` uses a `React.createElement` tree + injected `<style>` tags, all colors via `--dsw-*` tokens, degrading gracefully when a service is missing
- **v3.1 Quality Command Center**: extends the plugin from "passive observation panel" to "active command center + knowledge base" with quality gates, experience bank, defense events, and native command buttons
- Follows the iterate skill's design principles: deterministic convergence, auditable, least privilege

## Running the tests

```bash
cd harness/iterate-plugin
npm install
npm run typecheck
npm test
```

All tests pass:

- **426 unit tests green**, type-check clean
- Coverage: dedupe, filter, sort, multi-round convergence, meta-review audit, path safety, timeout clamping, config read/write + rollback, triage merge, diff computation, checkpoint validation, fix registry, history read + filter, prune cleanup report + dry-run semantics, UI pure functions (select-all key, runtime status guide), **v3.1: experience bank, quality gate, defense events**.

## ⚠️ Disclaimer

This project is provided "AS IS", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement.

**Automated code review and fixing carries inherent risk.** All changes produced in normal mode are generated by AI models and may introduce bugs, regressions, or unintended behavior. Before merging, you should:

- Review every diff before applying it to your main branch or pushing.
- Make sure your project is under git control and can be rolled back (`git restore`, revert, or restore from backup).
- Run your project's own test suite and build checks after each round of fixes.
- Never run this on secrets, credentials, `.env`, or files that must not be modified — configure `protected_paths` accordingly.

Users are solely responsible for the code that is generated, modified, or committed as a result of using this project. By using it, you acknowledge that neither the maintainers nor contributors are liable for any loss, damage, or legal consequences arising from its use.

## License

MIT
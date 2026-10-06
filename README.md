# iterate-plugin for DeepSeek Harness (dsh)

> dsh 桌面端的 iterate 质量指挥中心 + 经验银行插件（v3.6）。把 iterate 生态的同一套 review/fix loop 直接搬进 dsh 界面，新增质量门禁、经验银行、防御事件流与原生指挥操作。
> The iterate ecosystem's quality command center + experience bank plugin for dsh (v3.6). Natively embedded inside the DeepSeek Harness (dsh) desktop client with quality gates, experience bank, defense events stream, and native command buttons.

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

**iterate** is not one single binary — it is a **skill ecosystem** that layers a strict multi-round code gate on top of your existing AI assistants, IDEs, and scripts. It never replaces your tools; it adds an audit-and-close-the-loop layer on them. The whole ecosystem ships as **three interchangeable components sharing one `iterate.config.yaml` + one 9-dimension review system**:

- **[Core Skill + CLI](https://github.com/jingzhao-l/iterate-skill)** — a portable AI skill `/iterate` + `iterate` CLI. For conversation-driven multi-round iteration inside Trae / Claude Code / Cursor / Copilot / Codex and 25+ other assistants.
- **[iterate-harness](https://github.com/jingzhao-l/iterate-harness)** — a standalone headless engine, command `ih` (npm: `iterate-harness`). Runs the **exact same loop** in terminal / CI / git hooks, without any conversational assistant required.
- **iterate-plugin (this repo)** — a dsh desktop-client plugin (npm: `iterate-plugin`). Plugs the harness runtime **into the dsh UI**: convergence dashboard, triage panel, round progress — all surfaced as native dsh widgets.

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

**v3.2 Quality Command Center**: the plugin has grown from a "passive observation panel" into an "active command center + knowledge base". It now ships quality gate view + writable compute, an experience bank with search / adopt / add, a defense events stream (record + bilingual labels), native command buttons, and a `task_mode` indicator.

Besides 17 pure-function tools, it carries a **build-free Web UI layer** (convergence dashboard, triage panel, stats card, 11-tab runtime observatory — live activity stream + F1–F10 —, theme skin, etc.) that plugs straight into dsh's existing UI slots. Configuration (`iterate.config.yaml` and the review dimensions) is identical across the other two components of the iterate ecosystem ([skill](https://github.com/jingzhao-l/iterate-skill) / [headless engine](https://github.com/jingzhao-l/iterate-harness)) — zero migration cost.

---

## 📑 Table of Contents

- [✨ Features](#-features)
- [📦 Installation](#-installation)
- [🧭 Using the UI in dsh](#️-using-the-ui-in-dsh)
- [💬 Usage](#-usage)
- [⚙️ Project configuration](#️-project-configuration)
- [🔧 Registered tools](#-registered-tools)
- [📁 Runtime artifact layout](#-runtime-artifact-layout)
- [🎨 Design](#-design)
- [🧪 Running the tests](#-running-the-tests)
- [⚠️ Disclaimer & License](#️-disclaimer--license)

---

## ✨ Features

### Two modes

The plugin runs the same iterate engine as the rest of the ecosystem, either fully read-only or as an autonomous fix loop:

- **dry-run** — repeats multi-dimension review until convergence; **zero files modified**.
- **normal** — review → atomic fixes → validation every round → rollback on failure → loop until convergence.

Both modes share:

- Repeated review until convergence
- Parallel dimension review
- Deterministic aggregation / dedupe / sort
- meta-review report-consistency audit
- Self-stop when converged
- Breakpoint save / resume (long iterations)

`normal` mode additionally:

- Fixes **atomic findings only** (architectural ones are kept for later approval)
- Validates after each round's fixes
- Rolls back failed fixes, and can save / resume progress

### UI layer (build-free client slots, v3.6: 11 tabs)

- **ConvergenceDashboard** (`conversation.input.dock`) — live round progress bar, severity stats, dimension badges, trend mini-chart above the input; normal mode also shows fix-count badges; plus a live workflow-phase chip (current phase + running/stopped) and a **task_mode indicator (code / iterate)**, now backed by the persisted transcript (`iterate_status` / `iterate_transcript` emit `taskMode`). While a run is active the dashboard switches to a running state (round + phase) instead of the static empty state, and the start buttons are hidden.
- **ObservatoryPanel** (`conversation.input.dock`) — an **eleven-tab** runtime observatory below the input: **live activity stream** (default tab, type filter) + **F1** review threads (expand / collapse all), **F2** convergence trend (incl. the per-round comparison table: findings raised / fixed / severity mix / validation outcomes), **F3** finding locations (severity / dimension / search filter), **F4** fixes + rollback, **F5** checkpoint resume, **F6** run console, **F7** decision timeline (type / round filter + search), **F8** Quality Gate, **F9** Experience Bank, **F10** Defense Events. Number-key shortcuts: `1`–`9` jump to F1–F9, `0` to F10, `-` back to the live stream. **F8/F9/F10 are live** — they scan the session stream for the latest `iterate_quality_gate` / `iterate_experience` / `iterate_defense_events` results and render real data (PASS/FAIL chip + per-dimension score bars, experience entries with adopt buttons + client-side search, defense type-count chips + filtered event stream); when the session stream has none they distinguish "no data on disk" from "not pulled yet" and offer a **拉取磁盘快照 (pull disk snapshot)** instruction that has the model call the read-side tools and echo the `.iterate/` artifacts back into the stream. One-click JSON export of all observatory data — manifest + live + `qualityGate` / `experienceBank` / `defenseEvents` / `report` (download, copy fallback). **v3.5.3: reset actions surfaced** — F5 copies an `iterate_checkpoint clear` instruction, F8 an `iterate_quality_gate clear` instruction, F10 an `iterate_defense_events clear` instruction.
- **TriagePanel** (`conversation.chat.turnTail`) — per-finding triage with `y` (keep → fix), `n` (skip), `a` (known-intentional) keyboard shortcuts and `↑`/`↓` navigation (focus-guarded: only active while the panel has focus), filtering, batch ops (incl. select-all), localStorage persistence. **Write-back closed loop**: the primary button copies an `iterate_triage apply` instruction for the marked entries (the tool validates, dedupes, backs up, rolls back on failure); a secondary button copies the raw `known_intentional` YAML; **回读已写入条目** copies an `iterate_triage list` instruction to confirm what actually landed. Copy payloads are aligned to the target tool schemas. **v3.2: native command buttons** (approve architectural fix, trigger new round, rollback to checkpoint). **v3.3: §8 指派修复 (assign)** — one click copies an `iterate_fix` instruction carrying every in-scope finding (respecting the batch toggle).
- **StatsCard** (`conversation.chat.turnTail`) — convergence stats, round history, trend chart and completion summary when no findings remain.
- **iterate theme skin** (`theme.overrideTokens`) — a warm-amber 13-token `--dsw-*` override, light/dark modes, togglable in settings.
- **ProgressCapsule** (`shell.overlay`) — popup notification on each round completion / convergence (incl. convergence confirm).
- **SettingsPanel** (`settings.section`) — theme toggle, triage-persistence notes, config-management guide (covers `validation.commands` / `language` / `personalization.known_intentional` with an explicit "empty validation.commands = unprotected" warning; a field picker generates the matching `iterate_config write` instruction), runtime status overview (artifact layout + view/cleanup tool guide + disk-snapshot pull), one-click triage data reset.

The UI layer is **defensive by design**: it degrades gracefully if any of `slots` / `theme` / `React` is unavailable — it never crashes the client.

### Behavior beyond the tools

Beyond the 17 registered tools (full reference further down), the plugin closes several loops end to end:

- **Findings triage loop** — review → UI triage (y/n/a) → `iterate_triage` writes back `known_intentional` → auto-filtered next round
- **Structured fix system** — each fix backs up first, writes a registry entry, records the diff; a failed validation can be reverted with `iterate_rollback`
- **Breakpoint resume** — checkpoints saved at the start of each round; interrupted long iterations can resume
- **History audit** — `iterate_history` reads the decision log (filtered by `type` / `since` / `round` / fixed `file` / `limit`, default latest 50, cap 200) plus a fix-registry summary (per-round fixed/failed counts, scoped by the same round/file filters) to audit run process and fix details
- **Runtime cleanup** — `iterate_prune` removes stale decision-log entries, stale checkpoints, orphaned fix backups, empty rounds and stray temp files left by crashed atomic writes; dry-run by default (report-only), real cleanup requires `dryRun:false`, and every cleanup is logged
- **Config read / write** — `iterate_config` supports validated, backed-up, rollback-capable partial writes
- **v3.2 Experience Bank** — `iterate_experience` queries historical fixes and patterns with search / filter / adopt, and can persist new verified fixes (`add`) — re-adding the same pattern+dimension bumps its hit count instead of duplicating it
- **v3.2 Quality Gate** — `iterate_quality_gate` reads quality gate status with per-dimension convergence rates and PASS/FAIL, and can recompute + persist a fresh certificate (`compute`) from this round's findings / validation results (real convergence from `findingsByRound`)
- **v3.2 Defense Events** — `iterate_defense_events` queries defense events (precondition failures, rollbacks, invariant violations, assumption falsifications) and can `record` new ones; readable labels follow the project language (en / zh)

---

## 📦 Installation

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

> The package carries its own `dsh.bundle.patch` (i.e. `cordis.patch.yml`); the npm package's `files` whitelist is `src` / `lib` / `dist` / `cordis.patch.yml` / `README.md` / `README.zh-CN.md` / `LICENSE`. `dist/` is the compiled output of the TypeScript server-side logic, shipped with the package so it works with dsh's `github:owner/repo#ref` git-clone install (Node does not strip TS types under `node_modules`).

---

## 🧭 Using the UI in dsh

The browser client has **no filesystem access** — every panel renders from the dsh session stream (tool results the model echoes back). That is why the plugin's UI is built around one interaction paradigm: **copy an instruction from a button → paste it back into the chat → the model calls the matching tool → the panel fills**. Client buttons never spawn processes.

### Starting an iteration (empty dashboard)

With no report yet, the convergence dashboard shows two buttons — **「完整迭代」 (full iteration)** and **「仅评审」 (review-only)** — each copying a **natural-language instruction** to the clipboard. These are **not slash commands**: the plugin registers no `/iterate` command; paste the text into the conversation and the model runs the iterate workflow through dsh's `workflow` tool. The full-iteration instruction also asks the model to preflight `validation.commands` first — if none is configured it stops and asks you to write one (the same fail-closed rule the workflow enforces), so an unprotected run never looks green.

While a run is active the dashboard switches to a **running state** (round + workflow-phase chips) instead of the static empty state, and the start buttons are hidden.

### Triage panel shortcuts

Focus must be inside the triage panel (the handler ignores keys typed elsewhere):

- `y` — keep the finding for fixing; `n` — skip it; `a` — mark it known-intentional (write-back candidate)
- `↑` / `↓` — move between findings (auto-advances after a verdict)
- batch buttons `y` / `n` / `a` apply the verdict to all findings at once

To write verdicts back, mark entries with `a` and click **生成应用指令** — it copies an `iterate_triage apply` instruction for exactly those entries (the tool validates, dedupes by file|dimension|line, backs up, and rolls back on failure). Paste it back, then click **回读已写入条目** to copy an `iterate_triage list` instruction and confirm what actually landed — the write-back → readback closed loop.

### Observatory tabs & shortcuts

The observatory below the input carries **11 tabs**: the live activity stream (default) plus **F1**–**F10**:

`F1` review threads · `F2` convergence trend (incl. per-round comparison) · `F3` finding locations · `F4` fixes + rollback · `F5` checkpoint resume · `F6` run console · `F7` decision timeline · `F8` quality gate · `F9` experience bank · `F10` defense events

Press `1`–`9` to jump to F1–F9, `0` for F10, and `-` to return to the live stream.

### Disk snapshot pull & export

- **拉取磁盘快照 (pull disk snapshot)** — a new session (or a refresh) starts with empty panels even when `.iterate/` already holds artifacts on disk. The pull button copies an instruction asking the model to call the read-side tools (`iterate_status`, `iterate_transcript` `read`, `iterate_quality_gate` `read`, `iterate_experience` `list`, `iterate_defense_events` `list`, `iterate_history`) and echo their **full** results into the stream; the session scanners then fill the dashboard, F2, F5, F8, F9, F10. Empty states distinguish "no data on disk" from "not pulled yet".
- **导出 JSON (export)** — one click serializes the whole observatory to JSON: manifest + live feed + `qualityGate` + `experienceBank` + `defenseEvents` + `report` (download first, copy-to-clipboard fallback).

### Config management from the settings page

The settings section copies a config-edit guide that lists the supported `iterate.config.yaml` fields — including `validation.commands` (with an explicit warning that an empty list means every round runs unprotected) — and offers a **field picker**: choose a field, and the button generates the matching `iterate_config write` instruction (schema-validated, auto-backup, auto-rollback) for you to paste back.

---

## 💬 Usage

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

---

## ⚙️ Project configuration

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

---

## 🔧 Registered tools (17)

- `iterate_config` — read / write `iterate.config.yaml`. `operation=read` returns the full config or a named section; `operation=write` schema-validates, backs up, then merges and writes — auto rollback on failure
- `iterate_validate` — run a whitelisted validation command, return the result
- `iterate_decision_log` — append a decision log entry (append-only, never edits old ones), stored in `.iterate/decision-log.jsonl`
- `iterate_context` — read the `SKILL.md` / `ITERATE.md` context
- `iterate_review` — deterministic review engine: `plan` builds the plan, `aggregate` dedupes + converges, `meta-review` audits report consistency. Pure computation, no filesystem access
- `iterate_triage` — manage `personalization.known_intentional`: `apply` validates, dedupes (file|dimension|line), backs up and writes back to config; `list` reads back the current entries. The only channel for the browser triage panel to write back to config
- `iterate_fix` — apply **one atomic fix**: validates the relative path, backs up the original file, enforces atomicity via `atomic.max_lines` (skippable with `force`), writes new content, records a FixRecord and an `atomic_fix` log. The only legal file-modifying entry in normal mode
- `iterate_diff` — view accumulated fix changes: with `file`, returns the unified diff against the first backup; without it, a per-fixed-file summary
- `iterate_rollback` — roll back an applied fix: restore the file from backup, remove that FixRecord from the registry, append a `revert` log. Used after a failed round validation
- `iterate_checkpoint` — iteration breakpoint: `save` persists progress to `.iterate/checkpoint.json`, `load` reads it back, `resume` loads + bumps the resume counter (interruption recovery), `clear` removes it (bounded findings payload, `round ≤ maxRounds` enforced). Resumable interrupted long iterations
- `iterate_status` — summarize current iteration state: mode, current/last round, fixes applied, remaining architectural, decision-log entry count, whether a checkpoint exists; **v3.4: also surfaces the persisted quality-gate snapshot, experience-bank summary, and defense-events summary** (`qualityGate` / `experienceBank` / `defenseEvents`)
- `iterate_history` — read iteration history (read-only): decision-log entries (filter by `type` / `since` / `round` / fixed `file` / `limit`, default latest 50, cap 200) + fix-registry summary (per-round fixed/failed counts, scoped by the same round/file filters; a `file`-scoped summary recomputes counts from the kept records). For auditing the run, tracing logs, and inventorying fixes
- `iterate_prune` — clean runtime artifacts: stale decision-log entries (by `retainDays`, default 30), stale checkpoints, orphaned fix backups, empty rounds, stray temp files (crashed atomic writes). Dry-run by default (report-only); real cleanup with `dryRun:false`, each cleanup logged
- `iterate_transcript` — runtime observatory: persist review transcripts, threads, fixes, and nudge directions to `.iterate/transcript.json` for the client observatory
- `iterate_experience` — **v3.2** query the experience bank (list / search / get), `add` a new verified fix (re-adding the same pattern+dimension bumps its hit count instead of duplicating it), or **v3.5 remove a stale/incorrect entry by `id`** so bad experiences never resurface. Persists to `.iterate/experience.json`
- `iterate_quality_gate` — **v3.2** read the quality certificate (`read`), or recompute + persist a fresh one (`compute`) from findings, validation results, `findingsByRound`, and `fixedByDimension`. Real per-dimension convergence rates. **v3.5: `clear` removes the persisted certificate to reset a stale gate before a fresh iteration**
- `iterate_defense_events` — **v3.2** query defense events (list / counts), `record` a new one, or **v3.5.3 `clear` the persisted stream** so a fresh iteration starts without stale defensive data. Human-readable labels follow the project language (en / zh)

---

## 📁 Runtime artifact layout

All runtime state lives under `.iterate/` at the project root (can be excluded via `.gitignore`):

```
.iterate/
  decision-log.jsonl      # append-only decision log (plan/review/fix/revert…)
  checkpoint.json         # iteration breakpoint (resume)
  transcript.json         # runtime-observatory manifest (per-reviewer threads, trend, fixes, timeline, nudge)
  transcript-live.ndjson  # append-only near-real-time reviewer-activity feed (read/fix/rollback/validate…), byte-capped
  experience.json         # v3.2: experience bank (historical fixes and patterns, accumulated across sessions)
  quality-gate.json       # v3.2: quality gate snapshot (dimension convergence, verification pass rates, PASS/FAIL)
  defense-events.json     # v3.2: defense events stream (precondition failures, rollbacks, invariant violations, assumption falsifications)
  fixes/
    registry.json         # fix registry (list of FixRecords, grouped by round)
    <fix-id>_<ts>.bak     # original file backup before each fix
```

---

## 🔐 Permissions, dependencies & compatibility

### Node.js / DSH compatibility

- **Node.js**: `>=20` (`package.json` `engines.node`).
- **DSH**: declares `dsh.compatibility.dshReleases` in `package.json` — **that
  field is the single source of truth** for release compatibility (this README
  mirrors it verbatim; update both together). The following official releases
  are declared `compatible`: `0.1.1-rc.1`, `0.1.2-alpha.4`, `0.1.2-alpha.5`,
  `0.1.2-rc.1`, `0.1.3-alpha.1`, `0.1.5-alpha.1`, `0.1.5-alpha.2`,
  `0.1.5-rc.1`, `0.1.5-rc.2`, `0.1.6-alpha.1`, `0.1.6-alpha.2`,
  `0.1.7-alpha.1`, `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`,
  `0.2.0-rc.2`, `0.2.1-alpha.1` (18 releases, `0.1.1-rc.1` … `0.2.1-alpha.1`).
  The plugin is built against `@deepseek-ai/dsh-tools` /
  `@deepseek-ai/dsh-util-values` `0.2.1-alpha.1` and uses only public contracts
  (tool registration, client slots + theme, bundle patch).
- **Disposable-Profile evidence (real, `dsh` CLI `0.1.1-rc.1`)**: on a temp
  `$DSH_HOME`, `dsh plugin --profile <p> add <this-repo>` installed the bundle in
  ~449 ms; `dsh --profile <p> --dump-config` composed the `iterate-plugin` bundle
  patch into the profile; `dsh plugin --profile <p> remove iterate-plugin`
  uninstalled in ~602 ms and left zero references in the composed config. A full
  runtime boot was **not** exercised here (no model provider in the disposable
  profile), so `dshOperations` start/rollback stay `unknown`/`partial` — see
  `CHANGELOG.md` for the exact commands and timings.

### Runtime permissions (conservative disclosure)

The plugin runs with the **same process capabilities as the DSH host** and touches the
following capabilities; elevated capability means a DSH Profile install stays
`user-reviewed`/guarded rather than auto-approved:

- **Files** — reads and writes project-local state under `<projectRoot>/.iterate/`
  (decision log, checkpoint, transcript, fix backups/registry, quality gate,
  experience bank, defense events). `iterate_fix` / `iterate_triage` also apply
  in-place edits to the user's source files (path-traversal protected to the
  resolved project root, backups taken before every fix, rollback on failure).
  The client half persists triage verdicts to `localStorage`.
- **Commands** — the plugin's own tools execute a small, strictly bounded command
  surface inside the dsh host process, only when the model calls them: `iterate_validate`
  runs one of the **exact-match whitelisted** commands configured in
  `iterate.config.yaml` `validation.commands` (yes, it shells out via
  `node:child_process`, timeout-capped to ≤600 s); `iterate_review` (changed-only
  scope) runs `git diff --name-only -z <branch>` in the project root. Nothing else
  spawns a process. The client "command buttons" only copy paste-able instruction
  text; they do not spawn processes.
- **Credentials** — this plugin does **not** read or transmit credentials at
  runtime. The sibling **iterate-skill / iterate-harness** components may read git
  credentials / GitHub tokens when the user runs their own Git/API operations; those
  are separate packages and are never loaded by this plugin.
- **Network** — no network access at runtime (everything is local to the project).

### Dependencies

Runtime dependencies: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`,
`@deepseek-ai/dsh-util-values`, `js-yaml` — all pinned exact versions. No
install-time lifecycle scripts (`preinstall`/`install`/`postinstall`/`prepare`);
only `prepublishOnly` (build) runs on publish.

### Failure bounds

- All writes are atomic (temp + rename) and confined under `.iterate/`; a crash
  mid-write cannot corrupt the checkpoint/transcript.
- Persistence failures surface as structured `{ ok: false, error }` results instead
  of silent success.
- Fix edits are applied to backups first and rolled back on validation failure.
- The UI degrades gracefully when a slot/service is unavailable.

---

## 🎨 Design

The plugin follows dsh's "everything-is-a-plugin" architecture:

- **Does exactly two things** — injects the system prompt teaching the model the iterate workflow + registers 17 pure-function tools
- **All orchestration runs through dsh native `workflow` + `agent` + `parallel`**
- **Core logic is entirely pure functions** (dedupe / filter / sort / converge / meta-audit / diff computation / history filtering / cleanup reporting) — unit-testable, no I/O
- **Security model** — file writes confined to the resolved project root (path-traversal protection); always back up before writing, roll back on failure; config writes also back up + roll back; `iterate_prune` is dry-run by default and only clears artifacts under `.iterate/` with every cleanup logged; `iterate_fix` caps content length and `iterate_triage` caps entry count to fend off abnormal oversized payloads
- **Build-free UI** — `lib/client.js` uses a `React.createElement` tree + injected `<style>` tags, all colors via `--dsw-*` tokens, degrading gracefully when a service is missing
- **v3.2 Quality Command Center** — extends the plugin from "passive observation panel" to "active command center + knowledge base" with quality gates (read + compute), experience bank (read + add), defense events (read + record), and native command buttons
- Follows the iterate skill's design principles: deterministic convergence, auditable, least privilege

---

## 🧪 Running the tests

```bash
cd harness/iterate-plugin
npm install
npm run typecheck
npm test
```

All tests pass:

- **Full unit suite + type-check clean** (`npm test`, `npm run typecheck`) — the exact count is intentionally not pinned here to avoid doc drift; see `CHANGELOG.md` for per-release magnitudes
- Coverage: dedupe, filter, sort, multi-round convergence, meta-review audit, path safety, timeout clamping, config read/write + rollback, triage merge, diff computation, checkpoint validation, fix registry, history read + filter, prune cleanup report + dry-run semantics, UI pure functions (select-all key, runtime status guide), **v3.2: experience bank, quality gate, defense events, approval-gate fail-open path**.

---

## ⚠️ Disclaimer & License

### Disclaimer

This project is provided "AS IS", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement.

**Automated code review and fixing carries inherent risk.** All changes produced in normal mode are generated by AI models and may introduce bugs, regressions, or unintended behavior. Before merging, you should:

- Review every diff before applying it to your main branch or pushing.
- Make sure your project is under git control and can be rolled back (`git restore`, revert, or restore from backup).
- Run your project's own test suite and build checks after each round of fixes.
- Never run this on secrets, credentials, `.env`, or files that must not be modified — configure `protected_paths` accordingly.

Users are solely responsible for the code that is generated, modified, or committed as a result of using this project. By using it, you acknowledge that neither the maintainers nor contributors are liable for any loss, damage, or legal consequences arising from its use.

### License

MIT
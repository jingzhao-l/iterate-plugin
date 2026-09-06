# Changelog

All notable changes to iterate-plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.3.1] - 2026-09-06

### Fixed

- **DSH STORE manifest compliance**: `package.json` `repository` now points at the canonical monorepo `jingzhao-l/iterate-skill` (with `directory: harness/iterate-plugin`) instead of the independent plugin repo, matching the store's catalog entry; `homepage`/`bugs` updated to match. Declared `dsh.compatibility.dshReleases` (`0.1.2-alpha.4` / `0.1.2-alpha.5` / `0.1.2-rc.1` = `compatible`) so DSH compatibility is explicitly stated. Documented runtime permissions (files / commands / credentials / network), pinned dependencies, the absence of install-time lifecycle scripts, and failure bounds in README (`🔐 权限、依赖与兼容性` section, EN + ZH) per the DSH-Store submission contract.

### Notes

- Metadata- and documentation-only release (no runtime code changed). Fixes the catalog-blocked / update-deferred findings from DSH-Store automation (AI-Scarlett/DSH-Store#504).

## [3.3.0] - 2026-09-06

### Added

- **Quality command center session scans** (`lib/parse.js`): `scanSessionForQualityGate` / `scanSessionForExperienceBank` / `scanSessionForDefenseEvents` deep-scan the in-memory session stream (reverse-chronological, proxy-safe, depth/circular guarded) for the latest `iterate_quality_gate` / `iterate_experience` / `iterate_defense_events` result and normalize it into a JSON-safe shape — `get`/`add` single `entry` collapses into the same list shape the F9 tab renders, and `record`/`counts` fold into the F10 counts+events stream
- **F8 Quality Gate tab now live**: renders the overall PASS/FAIL chip (score, verification pass rate, failed count), per-dimension convergence chips and score bars from the session-scanned snapshot; falls back to the copy-able query instruction only when the session has none
- **F9 Experience Bank tab now live**: renders session-scanned entries (dimension, pattern, hit count, description) with a client-side keyword filter over pattern/description/severity/tags, per-entry 采纳 (adopt) copy instruction when a `verifiedFix` exists, and a live count of in-session entries
- **F10 Defense Events tab now live**: renders type-count chips (前置校验失败 / 回滚 / 不变量违反 / 假设被证伪), the per-type filtered event stream with Round + location + defense narration, and the current filter
- **§8 指派修复 (assign) button** (findings triage): copies one `iterate_fix` instruction carrying every in-scope finding's `file`/`line`/`dimension`/`severity`/`summary` (`suggested_fix` when present); scope follows the batch toggle (`selectAll` = all findings, otherwise the visible filter set)
- **task_mode indicator wiring**: `iterate_transcript capture` accepts an explicit `taskMode` (`"code" | "iterate"`) and the `ReviewTranscriptBuilder` persists it into the manifest (deriving `iterate` for review-loop runs when not supplied, `null` otherwise); `rehydrateBuilder` preserves it across nudge writes; `iterate_status` reads the persisted transcript's `taskMode` (`readTranscriptTaskMode`) and reports it in the status output and render; the client chip (`iterate-chip-taskmode`) now has a real data source via `normalizeTranscript`'s `taskMode` passthrough

### Tests

- parse: 7 new cases — taskMode passthrough (code/iterate/absent/junk), latest-wins quality-gate scan (non-mutating), quality-gate/experience/defense null-on-absence, single-entry fold for `get`/`add`, and deep-find of nested result shapes
- checkpoint: 4 new cases — computeStatus taskMode passthrough/default-null, `readTranscriptTaskMode` missing/corrupt → null, reads `iterate`/`code` from a persisted transcript, and degrades unknown values to null
- transcript: 1 new case — serialize emits `taskMode` (explicit wins, mode-derived default, null when mode absent, invalid value ignored)

## [3.2.2] - 2026-09-06

### Fixed

- **No more silent persist failures**: `writeQualityGate`, `writeExperienceBank`, and `writeDefenseEvents` previously swallowed every I/O error and reported success even when nothing was written — the tools (`iterate_quality_gate compute`, `iterate_experience add`, `iterate_defense_events record`) now return `ok: false` with the failing path/message, matching the structured-result pattern used by `writeConfigFile`/`appendDecisionEntry`/checkpoint/prune
- **Removed dead `toolGate`**: the exported but unused tool-facing gate in `approval-gate.ts` contradicted the documented single-gate architecture (`tools/pre-execute` is the only approval seam; a tool-internal second gate would double-ask). The dead export and its tests were removed

### Tests

- Added 6 regression tests: three store-level write-failure tests (`.iterate` occupied by a plain file) and three tool-level tests proving each write operation surfaces the persistence error instead of `ok: true`

## [3.2.1] - 2026-09-05

### Fixed

- **Approval-gate fail-open fix**: the `tools/pre-execute` gate now degrades to `ask` (require consent) instead of `allow` when the gate itself throws — a hostile or malformed call (e.g. a NUL-byte project path that makes `resolve()` throw inside the gate) previously fell through `next()` and auto-approved destructive `iterate_fix` calls
- **Defensive reads**: `gateDecision` / `decideApproval` read `exec.name` and `exec.arguments` through guarded accessors so proxied or unreadable executions classify as `allow`/`ask` instead of throwing
- **NUL-byte path guard**: `resolveProjectRoot` refuses project roots containing NUL bytes instead of passing them to the filesystem
- **A11y**: the round-completion capsule is now announced to assistive tech (`role="status"` / `aria-live="polite"`)

### Security

- Removed a fail-open path for destructive iterate tool calls. `registerSessionHooks` now returns an explicit `ask` decision with reason `iterate approval gate unavailable — require consent` when the gate cannot run, rather than delegating to the next hook.

### Tests

- Added 6 regression tests covering the fail-open path (NUL-byte path → ask, unreadable/proxied executions, and the gate's waterfall behavior: `ask`/`deny` short-circuit without calling `next()`, `allow` delegates)

## [3.2.0] - 2026-09-05

### Added

- **Writable experience bank**: `iterate_experience` gains an `add` operation that persists a verified fix to `.iterate/experience.json` — re-adding the same `pattern`+`dimension` increments its hit count instead of duplicating it
- **Writable quality gate**: `iterate_quality_gate` gains a `compute` operation that recomputes a fresh certificate from the round's findings, validation results, `findingsByRound`, and `fixedByDimension`, then persists it to `.iterate/quality-gate.json`
- **Writable defense events**: `iterate_defense_events` gains a `record` operation that logs a new defense event to `.iterate/defense-events.json` and updates the by-type counts
- **Real convergence math**: `computeQualityGate` now derives per-dimension convergence rates from the per-round new-finding series (`findingsByRound`) instead of the tautological always-zero formula; exported `convergenceRateFor` helper
- **Bilingual defense labels**: defense event type labels follow the project `language` (en/zh), selectable per-call via the `language` parameter
- **Robustness**: `upsertExperience` is non-mutating, dedupes by pattern+dimension, stamps `timestamp` on new entries, and guards malformed totals; `addDefenseEvent`/`computeCounts` ignore unknown event types instead of crashing; `appendDecisionEntry` reports `count: 0` (not `-1`) and `iterate_decision_log` surfaces append failures via `success: false`
- **Tests**: new coverage for the quality store, experience store, defense store, and all three write operations (34 new tests)

### Changed

- Updated tool descriptions in the injected skill prompt to document the new write operations
- Updated version from 3.1.0 to 3.2.0

## [3.1.0] - 2026-09-04

### Added

- **Quality Gate View (§5)**: New `QualityGatePanel` UI component showing dimension convergence rates, verification pass rates, and overall PASS/FAIL status
- **Experience Bank (§6)**: New `ExperienceBankPanel` UI component for browsing/searching historical fixes and patterns with hit highlighting
- **Defense Events Stream (§7)**: New defense events tab in ObservatoryPanel showing precondition failures, rollbacks, invariant violations, and assumption falsifications
- **Native Command Buttons (§8)**: Added approve architectural fix, trigger new round, and rollback to checkpoint buttons in TriagePanel
- **task_mode Indicator (§10)**: Added task_mode indicator (code/iterate) in ConvergenceDashboard
- **3 new tools**:
  - `iterate_experience`: Query experience bank for historical fixes and patterns
  - `iterate_quality_gate`: Query quality gate status with dimension convergence rates
  - `iterate_defense_events`: Query defense events stream
- **3 new storage layers**:
  - `experience-store.ts`: Read/write experience bank to `.iterate/experience.json`
  - `quality-store.ts`: Read/write quality gate snapshot to `.iterate/quality-gate.json`
  - `defense-store.ts`: Read/write defense events to `.iterate/defense-events.json`
- **Extended types**: Added `QualityGateSnapshot`, `QualityGateDimension`, `ExperienceEntry`, `ExperienceBank`, `DefenseEvent`, `DefenseEventStream`, `DefenseEventType` types
- **Extended IterationStatus**: Added quality gate, experience bank, defense events, and task_mode fields

### Changed

- Updated tool count from 13 to 17 (14 original + 3 v3.1 quality command center tools)
- Updated ObservatoryPanel from 7 tabs to 10 tabs (added F8 Quality Gate, F9 Experience Bank, F10 Defense Events)
- Updated version from 2.12.3 to 3.1.0
- Updated README.md to reflect v3.1 features

### Fixed

- Fixed TypeScript type errors in client code
- Fixed type compatibility issues with `ObsFinding` and `Record<string, unknown>[]`

## [3.0.1] - 2026-09-03

- Previous release (skill-level sync)

## [3.0.0] - 2026-09-03

- Previous release (skill-level sync)

## [2.12.3] - Previous Release

- Initial stable release of v2 series
- 13 registered tools
- 7-tab ObservatoryPanel
- Defensive UI design with graceful degradation
- Build-free Web UI layer
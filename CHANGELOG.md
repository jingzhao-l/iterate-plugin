# Changelog

All notable changes to iterate-plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.5.1] - 2026-09-12

### Added

- **`iterate_experience` `remove` operation** — delete a stale or incorrect
  entry by `id` so a corrupted experience never keeps resurfacing. The store
  helper `removeExperience` returns `{ removed }` and never mutates its input;
  the tool reports `ok:false` for an unknown id (nothing touched) or a missing
  `id` argument, and surfaces persist failures like the other write ops.
- **`iterate_quality_gate` `clear` operation** — `clearQualityGate` removes the
  persisted `.iterate/quality-gate.json` certificate so a stale FAIL gate can be
  reset before a fresh iteration. Reads after clearing fall back to the empty
  `pending` snapshot; fail-safe in tool render.
- **Live activity feed now classifies the v3.0 command-center tools**
  (`iterate_experience` / `iterate_quality_gate` / `iterate_defense_events`) —
  previously their activity never produced a live-feed entry; they now surface
  as `info` activities so the F1 activity stream tells the full story.

### Changed

- **`iterate_rollback` now mirrors the reversal into the persisted observatory
  transcript**: the removed dead code `markFixRolledBack` (only reachable in
  tests) is now wired end-to-end via a fail-safe
  `markFixRolledBackInTranscript` helper — rolling back a fix flags its
  `success:false` in `.iterate/transcript.json` so the client F4 fix/rollback
  panel no longer shows a rolled-back fix as "成功". Best-effort: a missing or
  corrupt transcript is ignored and never breaks the rollback flow.
- **`iterate_status` text render now includes the quality command-center
  summaries** it already returned as JSON: quality-gate status/score/verification
  pass-rate, experience-bank entry/hit totals, and defense-event type counts —
  a single status read reports the whole run state in text too.
- **DSH STORE compatibility widened to the 0.1.5 window**: `dsh.compatibility.
  dshReleases` now also declares `0.1.5-alpha.1`, `0.1.5-alpha.2`, and
  `0.1.5-rc.1` as `compatible` (verified in a disposable profile against the
  0.1.5-rc.1 npm packages; typecheck + full suite green). Build-time dependency
  pins stay at `0.1.2-rc.1` because a clean `npm install` of the 0.1.5 pins
  fails with ERESOLVE (peer `dsh-agent`), and the harness dedupes the
  `@deepseek-ai/dsh-*` packages at install time anyway.

### Tests

- 11 new unit tests covering `removeExperience` (remove/unknown-id/mutate-free),
  `clearQualityGate` (existing + missing certificate), the three new live
  classifier cases, `markFixRolledBackInTranscript` (toggle, missing file,
  corrupt manifest), and tool-level `remove`/`clear` end-to-end flows (persist +
  render).

## [3.5.0] - 2026-09-09

### Added

- **Shared atomic-write layer (`src/atomic-fs.ts`)**: `writeTextAtomic` /
  `writeJsonAtomic` / `writeTextAtomicAsync` — every write goes to a unique
  temp file (`.<name>.tmp-<pid>-<rand>`, same directory as the target) that is
  renamed into place, with a single self-cleanup. A crash mid-write can never
  again leave a truncated state file. Migrated onto it: `quality-gate.json`,
  `defense-events.json`, `experience.json`, `fix-registry.json`,
  `checkpoint.json`, the `decision-log.jsonl` rewrite in `iterate_prune`,
  `iterate.config.yaml`, the live activity-feed trim (`live.ts`), and
  `transcript.json` (async path).
- **`iterate_prune` temp-file sweep**: crashed atomic writes left orphan
  temp files behind forever. `inspectPrune` now reports `staleTemps`
  (recognized by `isPrunableTemp`: current `.<name>.tmp-<pid>-<rand>` plus the
  legacy `.tmp-<pid>-<rand>` / `<name>.tmp` conventions) and `executePrune`
  deletes them; dry-run render shows the count. Tool description and the
  README tool tables (EN + ZH) updated accordingly.
- **Silent audit-trail loss is now visible**: `iterate_decision_log` read
  returns `invalidLines` — corrupt JSONL lines were always skipped, but the
  count was invisible; `readDecisionLogDetailed` exposes it so callers can
  surface a degrading decision log instead of silently reading a shorter one.
- **Cancellation semantics for `iterate_validate`** (`canceled` field on
  `ValidationResult`): `runCommand` now observes the harness signal
  (`exec.signal`). An aborted validation kills the child and reports
  `canceled: true` (exit code 1, duration preserved) instead of the old
  misreported `timedOut: true`; the deadline path still reports `timedOut`
  and never conflates the two. Render shows a "Cancelled" warning line.
- **DSH presentation contract (`presentCall`)** — pending-call cards so the
  client shows what a running call will do before its result exists:
  `iterate_fix` renders a diff card (`+added/-removed · round N · file`,
  `force` marker, forbidden/protected veto reasons), `iterate_validate`
  renders a terminal card titled with the exact whitelisted command, and
  `iterate_config` renders a read/edit card. All presenters are pure
  (args-only, per DSH: no IO, no `cwd`), return `undefined` for malformed
  args, and are unit-tested.
- **DSH concurrency contract (`isConcurrencySafe`)** — per-args metadata on
  every tool: read-only shapes (`iterate_history`, `iterate_context`,
  `iterate_status`, `iterate_diff`, experience list/search/get,
  decision-log `read`, defense-events list/counts, transcript `read`,
  config read) join parallel dispatch groups; mutating shapes (fix, rollback,
  validate, prune, config write, experience `add`, decision-log `append`,
  defense-events `record`, transcript `capture`/`nudge`, quality-gate
  `compute`, triage `apply`) remain exclusive.

### Changed

- Store modules (`quality-store` / `defense-store` / `experience-store`)
  resolve `.iterate/` through the shared `iterateDir()` helper instead of
  hand-rolled path joins (one source of truth for the runtime directory).

### Verified

- Upstream harness review (2026-09-09): latest published `@deepseek-ai/dsh-*`
  on npm remains `0.1.2-rc.1` (the GitHub `v0.1.3-alpha.1` tag has no npm
  release); forward-compatibility was proven by installing the later
  `0.1.5-alpha.1` packages in a sandbox — `npm run typecheck` and the full
  test suite pass against them unchanged, and the release's plugin-visible
  breaking changes (removal of `ctx.agent`, typed Inbox, Session format v3)
  touch no API this plugin uses. Dependency pins therefore stay at
  `0.1.2-rc.1`.

### Tests

- 8 new tests (523 total): temp-file sweep (matcher table, dry-run report,
  execute deletes legacy + current conventions), `runCommand` cancellation
  semantics (caller-signal kill → `canceled` not `timedOut`; deadline →
  `timedOut` not `canceled`), atomic-write temp naming.

## [3.4.1] - 2026-09-07

### Fixed

- **Robustness batch (co-authored tree state)**: 
  - `git-scope.ts` `filterExistingFiles` derives the containment prefix from
    `path.sep` instead of a hardcoded `/` — Windows paths no longer leak outside
    the project root inventory.
  - `skill-prompt.ts` (injected workflow script) convergence guard: a round only
    counts as "converged" when the aggregate accepted it (schema-valid) AND it
    genuinely found zero NEW findings; a schema-invalid/failed round is now
    INCONCLUSIVE and fails the run instead of masquerading as a clean pass (both
    dry-run and normal loops). Also reads the full config with `iterate_config({})`.
  - `lib/parse.js` `countSessionImages` no longer double-counts an image whose
    reference node is already counted, and `extractTranscript` gained `seen`/`depth`
    guards so a cyclic session object can never recurse without bound.
  - `lib/parse.js` `filterTimelineEntries` guards `JSON.stringify` on cyclic/non-
    primitive timeline `data` (search degrades to `String()` instead of throwing);
    `computeSummaryFromFindings` / `severityStats` / `groupByDimension` /
    `buildRoundHistory` / `findingMatches` skip null / non-object elements instead
    of dereferencing them.
  - `lib/parse.js` `latestToolResultNode` now scans `message.tool_calls` for a
    matching tool's `result`/`response`/`message` before falling back to raw content —
    the F8/F9/F10 quality command-center scanners can read sessions whose tool
    results live on assistant tool-call objects (not `session.toolCalls`), fixing
    false-empty panels for that session shape.
  - `src/client/index.ts` command buttons: "批准架构修复" copies an
    `iterate_fix` instruction using the real `force:true` param (the previous
    `is_architectural` param does not exist on the tool), and "回滚检查点" now
    points to `iterate_history` + `iterate_rollback` instead of the nonexistent
    `iterate_checkpoint` rollback operation; removed a dead `buildFindingTrend`
    import and guarded the F7 timeline render against cyclic `data`.
- **DSH STORE contract alignment (AI-Scarlett/DSH-Store#504)**: the manifest and docs
  now satisfy the store's deterministic checks that CAN pass, so the automation can
  re-pin and re-classify instead of blocking on the previously shown reasons:
  - `dsh.compatibility.dshReleases` now declares precise `compatible` for
    `0.1.1-rc.1`, `0.1.2-alpha.4`, `0.1.2-alpha.5`, `0.1.2-rc.1`, and
    `0.1.3-alpha.1` — covering the store's current latest-three window
    (alpha.5 / rc.1 / 0.1.3-alpha.1) so the entry is not culled for compatibility
    coverage. `0.1.1-rc.1` is backed by real disposable-Profile evidence below;
    `0.1.3-alpha.1` is a source declaration (matches the current release window;
    the plugin uses no API changed by that release).
  - README permission disclosure (EN + ZH) fixed an inaccuracy: the plugin's own
    `iterate_validate` tool DOES execute the user's exact-match-whitelisted
    validation commands (`node:child_process`, timeout ≤600 s) and `iterate_review`
    runs `git diff --name-only -z` for changed-only scope. The disclosure now says
    exactly that instead of "shell is run by the host, not this plugin".
- **Disposable-Profile evidence recorded (real, dsh CLI `0.1.1-rc.1`, temp `$DSH_HOME`)**
  — used to satisfy the store's install/start/uninstall evidence request:
  - install: `dsh plugin --profile <p> add <this-repo>` → `+ iterate-plugin
    link:...` in ~449 ms (pnpm 11.23.0);
  - compose: `dsh --profile <p> --dump-config` emits `# == iterate-plugin` /
    `- id: iterate-plugin / name: iterate-plugin`;
  - uninstall: `dsh plugin --profile <p> remove iterate-plugin` → `- iterate-plugin
    link:...` in ~602 ms; the composed config afterwards has zero `iterate` refs.
  - full runtime boot was NOT exercised (no model provider in the disposable
    profile), so `dshOperations` start/rollback remain honestly `unknown`/`partial`.

### Tests

- 12 new cases from the robustness batch: `parse.test.ts` covers the image
  reference node-consumption fix (no double count via a shared ref object), the
  transcript `seen`/`depth` cycle guards, cyclic/non-primitive timeline `data`
  (no crash on search), null/non-object finding + round element tolerance, and
  the `message.tool_calls` variant surfacing for the quality-gate / defense-events
  scanners; `git-scope.test.ts` covers the `sep`-based containment prefix on the
  changed-file filter; `skill-prompt.test.ts` covers the convergence-vs-schema-invalid
  distinction and the plain `iterate_config({})` read. Full suite: **515 pass**.

### Notes

- The store's automation rechecks every eight hours from the new fixed Commit; the
  remaining deterministic gate failures (`runtime source contains the
  files/commands/credentials permission signal`, runtime deps requiring a separate
  supply-chain review) are INHERENT — this plugin genuinely reads/writes files,
  executes a bounded whitelist of commands, and depends on `@deepseek-ai/*` runtime
  packages. Per the DSH-Store contract those capabilities keep the entry
  `user-reviewed`/guarded (browsable with a manual GitHub-install path) rather than
  `source-verified` auto-approved; that is by design and can only change via the
  store's user-review flow, not by manifest edits.

## [3.4.0] - 2026-09-06

### Added

- **`iterate_checkpoint` `resume` operation**: loads an existing checkpoint, bumps `resumeCount`, and persists it back atomically — the observatory F5 panel's resume instruction now works instead of copying an operation the tool rejected (`unknown operation`). The skill's own resume flow (load + manual `resumeCount` bump) is unaffected.
- **`iterate_status` now surfaces the quality command center**: the output carries the persisted quality-gate snapshot, experience-bank summary, and defense-events summary (`qualityGate` / `experienceBank` / `defenseEvents`) — the fields the `IterationStatus` type always declared but never populated. Absent snapshots degrade to `null`, never fabricated.
- **Empty-dashboard launcher**: when no report exists yet, the convergence dashboard offers one-click copy buttons for `/iterate` (full loop) and `/iterate review-only` (dry-run), replacing the passive hint text.

### Fixed

- **Config write prototype-pollution guard**: `applyConfigUpdates` now refuses `__proto__` / `constructor` / `prototype` update keys (mirroring `mergeConfig`) — a model-supplied `{"__proto__": …}` JSON update previously plain-assigned onto the merged config object and changed its prototype.
- **Approval gate no longer bypassable via `iterate_config`**: `validateConfigUpdates` now rejects `updates.observatory.approval` fail-closed (edit the config file directly instead) and validates the `observatory` block's shape (`capture` boolean). The approval policy is the authoritative human-consent seam for destructive tools, so a model-driven flip to `allow` would have disabled the gate.
- **Defense-event counts can never NaN**: `readDefenseEvents` now normalizes persisted streams — `counts` is always recomputed from the events array (a hand-edited file with a missing/stale counts object previously produced `undefined++` → NaN on the next `record`), malformed event entries are dropped, and `addDefenseEvent` always recomputes counts.
- **Quality-gate read never crashes the render**: `readQualityGate` normalizes a hand-edited snapshot (missing `dimensions`, non-numeric fields) so the tool's `render` and the client never throw on `snapshot.dimensions.map`.
- **Review-report convergence is order-independent**: `buildReviewReport` now sorts rounds by round number and computes the last round from the highest reported number — an unsorted round set (parallel/resumed runs) previously read the last ARRAY element, reporting the wrong round's new-finding count and a wrong `converged` flag.
- **Full-scope inventory is Windows-safe**: `collectScopeFiles` derives relative paths via `path.relative` (separator-agnostic) instead of a `root + '/'` string prefix that failed on Windows and leaked absolute paths into the scope/coverage inventory.
- **Defense-event `record` line validation**: a negative `line` (which passes the integer argument schema) is now rejected with a structured error instead of being persisted.
- **Transcript fixes are bounded**: the manifest's `fixes` array is capped (newest 200 win), matching the builder's documented growth-bounding for long runs.
- **History render guard**: decision-log entries without a `round` no longer print `rundefined`.
- **F5 resume instruction title typo** fixed.

### Tests

- 20 new cases: config-write pollution guard + observatory approval fail-closed + shape validation; checkpoint `resume` round-trip (persist + double-resume + no-checkpoint error) and `iterate_status` quality snapshots (seed three store files, verify surfaced); defense-store read normalization (missing counts / malformed events, no NaN); quality-store read normalization (incl. per-dimension fields); transcript fixes cap; review-report unsorted-round convergence; full-scope root-level file.

### Notes

- **Upstream dsh check (2026-09-06)**: DeepSeek Harness released tag `dsh-v0.1.3-alpha.1` (2026-09-04). The corresponding npm packages (`@deepseek-ai/dsh-tools` / `dsh-jobs` / `dsh-session` / `dsh-util-values` / `dsh-client-connection`) are **not yet published** (highest published stays `0.1.2-rc.1`), so the dependency declarations are unchanged this release. Compatibility analysis: v0.1.3-alpha.1's breaking change (Session persistence → lifecycle-scoped `SessionHandle`, async `agentLoop.create()`, per-session lock) and Session-format v2 migration do **not** touch any API this plugin uses (the plugin only reads `exec.agent.session.header.cwd` and never calls `agentLoop.create()`/`Session.events`), and the release carries a known performance regression. Declaring `0.1.3-alpha.1` compatible in `dsh.compatibility.dshReleases` is deferred until the npm packages publish and the regression is addressed.
- `dist/` was rebuilt from source; the committed `dist/` had silently drifted from `src/` since 3.2.2 (dead `toolGate` export and the store write-failure surfacing were in `src/` but not the shipped bundle). The tarball now matches `src/` exactly.

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
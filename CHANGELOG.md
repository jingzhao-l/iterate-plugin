# Changelog

All notable changes to iterate-plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
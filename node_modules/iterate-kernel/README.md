# iterate-kernel

The iterate ecosystem's shared semantic kernel: schemas, the evidence → decision
transcription, the decision-log audit chain, and public validators.

**What it is not.** It carries no verification reasoning. Judging whether a claim is true
belongs to the engine that produced the evidence; this package transcribes what that engine
already decided, so that every shell in the ecosystem speaks the same language instead of
each inventing its own.

## Install

```bash
npm install iterate-kernel
```

## The `zod` in these declarations is exact on purpose

`package.json` pins `zod` to one version rather than a range, because the shipped `.d.ts` are
emitted *by* a zod: with a range, a consumer whose resolver picked a different major got no type
error where one was owed — `z.infer` on these schemas silently degraded to `any`, and TypeScript
complained about the consumer's own code instead. `test/zod-contract.test.mjs` holds that line
(declared spec exact, installed equals declared, emitted declarations still zod-3 shaped). Moving
zod majors is a contract event for every consumer that type-checks against these declarations:
say it in the release note and change that test in the same commit.

## Import per module, not through the barrel

```ts
import { decisionOutcomeFromEvidence } from "iterate-kernel/evidence-decision"
import { appendDecisionEntry } from "iterate-kernel/decision-log"
import { parseEvidencePack } from "iterate-kernel/parse"
```

Each module is its own subpath export. Importing the barrel (`iterate-kernel`) also pulls
in `schemas`, which reads the JSON Schema files next to the package at load time — fine in a
repository, but a runtime file read is a trap for anyone bundling to a single file. The
subpaths avoid it, and they keep a consumer's dependency on this package as narrow as the
APIs it actually uses.

## The pieces

| Module | What it is for |
| --- | --- |
| `evidence-pack` / `parse` | the evidence pack shape, and parsing/validating one |
| `evidence-decision` | the **transcription**: evidence (attribution level, circuit-breaker level, pass/fail/inconclusive) → a decision outcome and a human summary. It reads fields the engine already decided; it never infers. |
| `decision-log-entry` / `decision-log` | the append-only decision-log entry and the `opID ↔ entry` hash chain that makes it auditable. The entry carries the producer's own `kind`, its `round`, the `dimension` a decision served and a bounded `payload` — all optional, so chains written before them keep their bytes and their digests. |
| `decision-log-transcribe` | the mapping from a decision record that the iterate ledgers already write (`{timestamp, round, type, data}` JSONL, produced independently in Python and TypeScript) onto a canonical draft. Rules live in `fixtures/decision-record-transcription.ok-01.json` so the second implementation is coded from the fixture, not from this package. |
| `dimension-context` / `parse` | the dimension-coverage transcription: a plan plus what the engine actually recorded → verified / unverified / unplanned, and one line to put in a summary. It validates id *shape*, never which ids exist — that list belongs to whoever configured the run. |
| `run-plan` / `parse` | the plan that `dimension-context` needs and refuses to invent: which dimensions a run intends to cover, in the caller's order, with the declared source. It carries a **digest** (`rp_` + sha256 of the canonical form) so a ledger line can state which plan a run was held to, and a reader can notice the plan changed mid-run. Nothing here reads a config file — producing a plan is whoever configures the run's job, and that keeps the kernel from learning a consumer's file format. |
| `invariant-report` / `parse` | what the invariant runner may state about its own checks, and the re-verification a failure asks for. It refuses a report that says `pass` while carrying a failed check, and it turns an `error` (a check that could not run) into **no** request: re-verifying the app would answer a question nobody measured. |
| `convergence` | the rules for what the loop does next, from stated inputs only. A tripped breaker, a spent round budget, and an errored check each `halt`; unlooked-or-unmeasured states `verify`, never `converged`. Both harnesses read one idea of "done" instead of growing two. |
| `provider-registration` | metadata for a judgement producer — who offers which method, and what it requires. Registering an existing id is refused rather than silently overridden, and resolution never guesses. |
| `errors` / `schemas` / `canonical-json` / `recipe-config` | `KernelSchemaError`, the JSON Schemas, canonical serialisation, recipe validation |

## A runnable example

This is the whole surface in one file, and it is the shape the API actually wants. Two details
cost real time to discover, so they are written out here rather than left to the error messages:

- **the ledger path is a first argument, not a field.** There is no default location, on purpose:
  a durable audit chain should not be created wherever a process happened to start.
- **`entryId` and `createdAt` are yours to supply** (`sequence` and `prevEntryHash` are derived
  from the ledger and must *not* be sent). `newDecisionEntryId()` mints one in the required
  `dl_<26 Crockford>` form.

```ts
import { decisionOutcomeFromEvidence, decisionSummaryFromEvidence } from "iterate-kernel/evidence-decision"
import { appendDecisionLogEntry, newDecisionEntryId } from "iterate-kernel/decision-log"
import { parseEvidencePack, parseDimensionContextInput } from "iterate-kernel/parse"
import { dimensionContext, formatDimensionContext } from "iterate-kernel/dimension-context"
import { resolve } from "node:path"

const pack = parseEvidencePack(await readFile("evidence.json", "utf8").then(JSON.parse))
const outcome = decisionOutcomeFromEvidence(pack)

// the transcription — never an inference; it reads what the engine already decided
console.log(outcome, decisionSummaryFromEvidence(pack))

// the audit chain — refuses to append onto a tail it cannot re-hash
appendDecisionLogEntry(resolve("ledger.jsonl"), {
  entryId: newDecisionEntryId(),
  createdAt: new Date().toISOString(),
  operationId: pack.operationId,
  outcome,
  summary: decisionSummaryFromEvidence(pack),
})

// dimension coverage — `recorded` is what the engine logged, not what you hoped it would
const input = parseDimensionContextInput({
  planned: [{ id: "correctness" }, { id: "security" }, { id: "ui-ux" }],
  recorded: { security: { decisions: 3, operationIds: [pack.operationId] } },
})
// -> "1/3 dimensions verified, 2 unverified (correctness, ui-ux), 3 decisions"
console.log(formatDimensionContext(dimensionContext(input)))
```

`parseDimensionContextInput` returns the *validated input*; `dimensionContext` computes the
context; `formatDimensionContext` renders the line. Anything recorded but never planned shows up
as `unplanned` — a reporter that quietly dropped it would be the failure this exists to prevent.

## Versioning

`0.1.x` is pre-stable. The schemas and the transcription rules are the contract every
consumer depends on, so a change to either is a minor-version change at minimum, and the
fixtures in `fixtures/` are the executable statement of what the contract means.

## The fixtures are the portable half of the contract

`schemas/` and `fixtures/` ship in the tarball — `test/packaging.test.mjs` packs locally and
refuses a corpus that did not make it into the artifact. Each fixture states its own rules in
its `comment`, written so a second implementation can be coded from the file without reading the
TypeScript. That is the only way this contract reaches the consumers that cannot import it:
`iterate-harness` is Python and `glasspaned` is Swift.

Those consumers do not read this package at runtime. They vendor a copy of the corpus pinned by
sha256 — `iterate-harness/tests/kernel_fixtures/`, checked by its `scripts/check_kernel_fixtures.py`
(`--source kernel/fixtures` inside the monorepo, registry mode in the split repo). Moving a fixture
therefore means re-recording that pin in the same change, and the check fails in whichever
direction the bytes disagree. A cross-implementation comparison that can be skipped silently is
not a contract; it is a note nobody reads.

## Consumers

A consumer's kernel is this package, pinned. There is no second copy of the source anywhere:
the GlassPane Harness fork used to vendor `kernel/src` under `packages/opencode/vendor/kernel`
with a probe that asked whether the canonical branch had moved, and that arrangement was retired
in favour of the npm dependency — its `script/kernel-pin.mjs` now checks the installed version,
the lockfile integrity hash, and the per-file sha256 of the shipped corpus against
`contracts/kernel-pin.json`, and `script/kernel-conformance.mjs` runs the fixtures against the
installed `dist/`.

The Python side still cannot import TypeScript, so it vendors the *corpus* (fixtures and schemas)
and implements the rules itself from the fixture `comment` fields; that is what the paragraph
above describes, and `scripts/check_kernel_fixtures.py` is what keeps the two copies byte-agreed.

Either way, run the fixtures: they are how you find out that the kernel you have is not the
kernel you think you have.

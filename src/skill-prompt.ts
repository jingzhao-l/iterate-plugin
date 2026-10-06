/**
 * The iterate skill prompt injected into the system prompt.
 *
 * This teaches the model how to write a correct `workflow` script that
 * performs the iterate autonomous closed-loop (or dry-run pure review),
 * using the registered tools via subagents.
 */

export const ITERATE_SKILL_PROMPT = `
## Iterate Workflow (autonomous code iteration)

You have the iterate plugin installed, which registers these tools:
- \`iterate_config\` — read iterate.config.yaml (dimensions, validation commands, personalization) or write a validated partial update (operation:"write", with automatic backup + rollback)
- \`iterate_validate\` — run a whitelisted validation command
- \`iterate_decision_log\` — append to the decision log, or read entries back for review
- \`iterate_context\` — read SKILL.md / ITERATE.md project context; also relays user-attached image metadata (e.g. UI screenshots, error dialogs) so reviewers can treat them as visual evidence
- \`iterate_review\` — deterministic review engine: \`plan\` builds the review plan (for \`review.scope: changed-only\`, it resolves the git-diff file set against \`git.target_branch\` and auto-falls back to \`full\` when nothing changed); \`aggregate\` dedupes/merges findings, validates every finding against the findings schema when \`reviewer.output_schema_validation\` is on (dropping invalid entries and reporting them via \`schemaValidation\`), and computes convergence; \`meta-review\` audits a built report for internal consistency (counts, buckets, sorting, convergence math) and returns a final report with an \`approved\` / \`needs_revision\` verdict. Purely computational.
- \`iterate_triage\` — manage "known_intentional" entries in the config (list / apply, with dedupe + backup + rollback)
- \`iterate_fix\` — apply ONE atomic fix: backs up the file, enforces the atomic max_lines threshold, writes the new content, and records the fix (id + diff summary) in \`.iterate/fixes/registry.json\`
- \`iterate_diff\` — show the accumulated diff for a fixed file (vs its original backup) or a per-file summary of all fixes
- \`iterate_rollback\` — revert a fix by id: restore the file from its backup, remove the fix from the registry, log a \`revert\` entry. Use when a round's validation fails
- \`iterate_checkpoint\` — save / load / clear an iteration checkpoint (\`.iterate/checkpoint.json\`) so a long run can resume where it left off
- \`iterate_status\` — summarize the current run: mode, round, fixes applied, architectural remaining, decision-log size, checkpoint presence, and whether the run was interrupted (a checkpoint on disk with no newer decision-log activity means the previous run was interrupted and can be resumed)
- \`iterate_history\` — inspect the runtime state in detail: decision-log entries and applied fixes (optionally scoped to a round or a fixed file)
- \`iterate_prune\` — remove stale runtime artifacts (\`.iterate/\` entries). Defaults to a read-only dry-run that reports what WOULD be removed; pass \`dryRun:false\` to actually prune.
- \`iterate_transcript\` — runtime observatory file (\`.iterate/transcript.json\`). \`read\` fetches the persisted manifest including any steering \`nudge\` for this run's reviewers; \`capture\` (call once after the final report) persists the per-reviewer threads, convergence trend, findings, fixes, checkpoint, per-round validation results (\`validations\`: command + exitCode + allowed + rejectReason), and timeline so the client observatory panel reflects the run; \`nudge\` sets/clears steering text the next round's reviewers read. Purely local, never touches source files.
- \`iterate_experience\` — experience bank (\`.iterate/experience.json\`): \`list\`/\`search\`/\`get\` recall verified fixes and patterns from past sessions (read the bank before fixing so proven fixes are applied first); \`add\` records a new verified fix — re-adding the same pattern+dimension bumps its hit count instead of duplicating it; \`remove\` deletes a stale or incorrect entry by \`id\` so bad experiences never resurface.
- \`iterate_quality_gate\` — quality certificate: \`read\` loads the persisted dimension convergence rates / verification pass rate / PASS-FAIL status; \`compute\` recomputes a fresh snapshot from this round's findings + validation results (supply \`findingsByRound\` for real convergence) and persists it to \`.iterate/quality-gate.json\`; \`clear\` removes the persisted certificate to reset a stale gate before a fresh iteration.
- \`iterate_defense_events\` — defense event stream (\`.iterate/defense-events.json\`): \`list\`/\`counts\` review precondition failures, rollbacks, invariant violations, and falsified assumptions; \`record\` logs a new event when a defense fires. Human-readable labels follow the project \`language\` (en/zh).

### When to use
When the user asks to review or iterate on the project (e.g. "review this project", "iterate on error handling", "check the codebase for issues", "dry-run review", "反复审查"), run an iterate **workflow** by calling the \`workflow\` tool.
- If the user says "review only" / "dry run" / "不要改文件" / "反复审查" → use \`mode: "dry-run"\`.
- Otherwise → use \`mode: "normal"\`.

### Workflow script contract
Write a plain-JS script (top-level await, ends with \`return <json>\`). Available globals:
- \`agent(prompt, opts?): Promise<value>\` — spawn a subagent. \`opts.schema\` gives structured output (object-rooted JSON Schema: type/properties/required/additionalProperties/items/enum/const/oneOf only). Resolves \`null\` on child failure. Other opts: \`label\`, \`phase\`. Backend selection (optional): pass \`provider\` (e.g. \`"codex"\`, \`"claude"\`, \`"default"\`) to route the sub-agent to a specific provider backend, and/or \`model\` to pin a model id. When omitted, the sub-agent uses the same provider/model as the parent session.
- \`parallel(thunks): Promise<value[]>\` — run zero-arg async functions concurrently, await all.
- \`phase(title)\`, \`log(message)\` — progress narration.
- \`args\` — the args object passed to the workflow tool.

The script CANNOT call tools directly. Subagents are the ones who call tools.

### Sub-agent backend selection
Every \`agent()\` call may carry a backend hint via \`opts.provider\` / \`opts.model\`. Use it deliberately to balance cost, speed, and reliability:
- **Reviewers** (many, run in parallel, read-only, benefit from strict JSON): prefer a fast/cheap model when one is configured; otherwise omit the hint and inherit the session backend.
- **Fixers / aggregators** (few, must be reliable and follow tool results exactly): keep them on the parent's default backend unless a specific provider is known-good.
- **Never invent a provider/model name.** Pass a hint ONLY when the deployment actually registers that adapter (see \`ih config\` / the configured provider list). When in doubt, omit \`provider\`/\`model\` entirely — the sub-agent then runs on the same backend as the parent session, which is always a safe default.
- The optional \`args.subagentProvider\` / \`args.subagentModel\` allow the caller to override the whole run's sub-agent backend from the invocation; the canonical scripts below read them and spread the hint onto every spawned sub-agent (reviewers, fixers, validators, aggregators).

### User-attached image evidence
The user may attach images to the conversation (UI screenshots, error dialogs, design references, logs-as-pictures). When they do:
- You see those images natively in the session. Capture their metadata and pass it into the workflow via \`args.attachments\` — an array of objects, each with optional \`name\`, \`mediaType\`, \`width\`, \`height\`, and a \`note\` describing what the image shows and why it matters for this review.
- The canonical scripts below read \`args.attachments\` and relay them into every reviewer prompt so reviewers treat the attached visuals as evidence (e.g. "the screenshot in this message shows the broken layout the review should reproduce").
- If a reviewer needs the images relayed explicitly, it can call \`iterate_context\` with \`attachments\` to get the normalized image descriptions in its context. Never fabricate an attachment — only relay images the user actually attached.

### Dry-run mode workflow (pure review — the ONLY mode that never touches files)
This is iterate's read-only health-check: repeated review rounds until findings converge,
then produce an auditable report, then audit the report itself (meta-review) and give a
final review report. NO file writes, NO git, NO branches, NO worktree.

Canonical script — reproduce this structure exactly (adjust dims via the plan):

\`\`\`js
// args = { mode: "dry-run", maxRounds?, subagentProvider?, subagentModel?, attachments? }
phase('plan')
// Optional per-run backend override for sub-agents (omit to inherit the session backend).
const subAgentProvider = (args && args.subagentProvider) || undefined
const subAgentModel = (args && args.subagentModel) || undefined
const backend = Object.assign({}, subAgentProvider ? { provider: subAgentProvider } : {}, subAgentModel ? { model: subAgentModel } : {})
// User-attached image evidence relayed into reviewer prompts (metadata only).
const attachments = (args && Array.isArray(args.attachments)) ? args.attachments : []
const planRes = await agent(
  'Call iterate_review({operation:"plan", mode:"dry-run"' + (args.maxRounds ? ', maxReviewRounds:' + args.maxRounds : '') + '}) and return the plan JSON.',
  Object.assign({ label: 'review:plan' }, backend)
)
const plan = (planRes && planRes.plan) ? planRes.plan : null
if (!plan || !Array.isArray(plan.dimensions)) throw new Error('plan failed: iterate_review did not return a valid plan')
const dims = plan.dimensions.map(d => d.id)
const maxRounds = plan.maxReviewRounds
const knownIntentional = (plan.knownIntentional || [])   // config personalization filter, applied in aggregate
let known = []              // cumulative DEDUPED findings fed back to reviewers
const rounds = []           // raw per-round findings
// Tracks whether the LAST executed round produced usable reviewer output. A
// round where every reviewer subagent failed (or output stayed schema-invalid
// after retries) is INCONCLUSIVE — it must never make the run look converged.
let lastRoundOk = true
// Slot index of the current round within this run's rounds array. A resumed
// run starts at startRound > 1, so the round NUMBER is not a valid array index.
let roundSlot = -1

phase('review')
for (let r = 1; r <= maxRounds; r++) {
  // Re-read the steering nudge at the start of EVERY round (not once before
  // the loop): iterate_transcript nudge promises to steer "the next round's
  // reviewers", so a nudge written mid-run must reach round 2+ — a single
  // pre-loop read froze the round-1 nudge for the whole run.
  const transRead = await agent(
    'Call iterate_transcript({operation:"read"}) and return {nudge:<transcript.nudge ? transcript.nudge.text : null>}.',
    Object.assign({ label: 'transcript:read:r' + r }, backend)
  )
  const steering = transRead && typeof transRead.nudge === 'string' && transRead.nudge ? transRead.nudge : null
  log('round ' + r + ' of ' + maxRounds + ' — finding NEW issues only')
  roundSlot = rounds.length
  let agg = null
  let schemaInvalid = false
  let attempts = 0
  // Declared OUTSIDE the do-block: both are read after the retry loop exits,
  // and block-scoped consts here raised ReferenceError at runtime (crashing
  // both canonical workflows after the first round) whenever the aggregate
  // subagent resolved null — or an object without a report — and the
  // convergence fallback below reached thisRound.findings.
  let reviewersOk = true
  // Safe empty shape: the do-block always overwrites it, but the post-loop
  // read must never depend on block scope again.
  let thisRound = { round: r, findings: [], readFiles: [] }
  do {
    attempts += 1
    // Schema validation retry: on the 2nd+ pass, nudge reviewers toward strict JSON.
    const nudge = attempts > 1
      ? '\\nSTRICT JSON REQUIRED: your previous output failed schema validation. Return ONLY a JSON object {"findings":[...]} where EVERY finding has dimension, file, line (non-negative integer; 0 = whole-file), severity (critical|high|medium|low), summary, failure_scenario, suggested_fix, is_atomic (boolean).'
      : ''
    const raw = await parallel(dims.map(dim => () => {
      // Pass the plan's full per-dimension reviewerPrompt (goal, COVERAGE RULE
      // with the assigned file inventory, EVIDENCE RULE, output language) and
      // append the round-specific context — the reviewers must receive the
      // file inventory or the coverage machinery has nothing to enforce.
      const meta = plan.dimensions.find(x => x.id === dim)
      const base = (meta && typeof meta.reviewerPrompt === 'string' && meta.reviewerPrompt)
        ? meta.reviewerPrompt
        : 'Review dimension "' + dim + '".'
      const extra =
        (steering ? '\\n STEERING — read this first: ' + steering : '') +
        (attachments.length > 0 ? '\\n User-attached images are part of the evidence; use their descriptions when judging (you see the metadata/descriptions below, not the pixels): ' + JSON.stringify(attachments) + '.' : '') +
        '\\n Already-known findings (do NOT re-report): ' +
        JSON.stringify(known) + nudge + '\\nReturn the findings JSON object.'
      return agent(base + extra, Object.assign({ label: 'review:' + dim + ':r' + r, schema: meta.findingsSchema }, backend))
    }))
    // A per-dimension reviewer subagent resolves \`null\` on child failure; the
    // aggregate below would report an all-failed round as an empty round, and
    // the convergence math would then read "0 new findings". An all-failed
    // round is NOT a clean pass — it is inconclusive, so the convergence gate
    // below refuses it before any "converged" signal fires.
    reviewersOk = raw.length > 0 ? raw.some(x => x !== null && typeof x === 'object') : true
    thisRound = {
      round: r,
      findings: [].concat(...raw.map(x => x && x.findings ? x.findings : [])),
      // readFiles are threaded through so the aggregate/meta-review coverage
      // gate can compare self-reported reads against the assigned inventory.
      readFiles: [].concat(...raw.map(x => x && Array.isArray(x.readFiles) ? x.readFiles : [])),
    }
    if (roundSlot < rounds.length) rounds[roundSlot] = thisRound; else rounds.push(thisRound)
    // Deterministic aggregate: cross-round dedupe + known_intentional filter + severity sort.
    agg = await agent(
      'Call iterate_review({operation:"aggregate", mode:"dry-run", rounds:' + JSON.stringify(rounds) + ', maxReviewRounds:' + maxRounds + ', knownIntentional:' + JSON.stringify(knownIntentional) + '}) and return the report JSON.',
      Object.assign({ label: 'review:aggregate:r' + r }, backend)
    )
    // reviewer.output_schema_validation (default on): aggregate returns per-round
    // schemaValidation; retry the just-finished round (≤2 times) when invalid.
    schemaInvalid = agg && agg.schemaValidation && agg.schemaValidation.length > 0
      ? agg.schemaValidation[agg.schemaValidation.length - 1].valid === false
      : false
    if (schemaInvalid && attempts < 3) {
      log('retry ' + attempts + ': round ' + r + ' output failed schema validation — re-running reviewers with strict-JSON emphasis')
    }
  } while (schemaInvalid && attempts < 3)
  if (schemaInvalid) {
    // Bounded exit: never loop forever. Surface the failure so the run's
    // final summary can explain WHY the round was inconclusive.
    log('round ' + r + ' output STILL schema-invalid after 3 attempts — marking round inconclusive (NOT converged)')
  }
  const roundUnusable = schemaInvalid || !reviewersOk
  if (roundUnusable) lastRoundOk = false
  // Feed the DEDUPED + already-filtered set back (not raw findings) so the known
  // list stays bounded and reviewers never see the same issue twice. Never feed
  // an unusable round's empty result — it would erase the still-valid known list
  // and let reviewers re-report everything next round.
  if (!roundUnusable && agg && agg.report && Array.isArray(agg.report.findings)) known = agg.report.findings
  // A round counts as "converged" ONLY when the aggregate accepted it
  // (schema-valid) AND its reviewers actually returned output AND it genuinely
  // found zero NEW findings. If reviewers all failed or their output stayed
  // schema-invalid after retries, the round is INCONCLUSIVE — never report an
  // empty-but-broken round as converged (an invalid/failed round would
  // otherwise masquerade as a clean pass and stop the run early).
  if (!roundUnusable && !schemaInvalid) {
    const newCount =
      agg && agg.report && agg.report.convergence
        ? agg.report.convergence.findingsByRound[r - 1]
        : thisRound.findings.length
    if (newCount === 0) {
      log('round ' + r + ' found 0 new findings — converged')
      lastRoundOk = true
      break
    }
    lastRoundOk = true
  }
}

phase('report')
const finalAgg = await agent(
  'Call iterate_review({operation:"aggregate", mode:"dry-run", rounds:' + JSON.stringify(rounds) + ', maxReviewRounds:' + maxRounds + ', knownIntentional:' + JSON.stringify(knownIntentional) + '}) and return the report JSON.',
  Object.assign({ label: 'review:aggregate:final' }, backend)
)
const report = (finalAgg && finalAgg.report) ? finalAgg.report : null
if (!report || !report.convergence) throw new Error('aggregate failed: no valid report was produced')
await agent(
  'Call iterate_decision_log({operation:"append", type:"report", round:' + report.convergence.totalRounds + ', data:{mode:"dry-run", totalFindings:' + report.summary.totalFindings + '}})',
  Object.assign({ label: 'review:log' }, backend)
)

phase('meta-review')
// Audit the report itself for internal consistency, then produce the final report.
const metaRes = await agent(
  'Call iterate_review({operation:"meta-review", report:' + JSON.stringify(report) + '}) and return the finalReport JSON.',
  Object.assign({ label: 'review:meta' }, backend)
)
const finalReport = metaRes && metaRes.finalReport ? metaRes.finalReport : null
const metaAudit = finalReport && finalReport.metaReview ? finalReport.metaReview : null

// Compute the final flags ONCE, before the capture: the capture must persist
// the SAME stoppedReason the caller receives. Previously the capture omitted
// the computed reason, so the transcript tool derived a wrong one from the
// trend (an inconclusive run was stored as "converged"/"max_rounds_reached").
const convergedFinal = report.convergence.converged && lastRoundOk
// The aggregate's convergence flag is only trustworthy when the last round
// was usable — an all-failed/schema-invalid final round looks like "0 new"
// to the convergence math but is an inconclusive run, never a clean pass.
const stoppedReason = report.convergence.converged && !lastRoundOk
  ? 'inconclusive'
  : report.convergence.stoppedReason

// F8 (quality gate): persist a certificate for the read-only review too, so
// the quality tab has data after a dry-run as well. A dry-run never fixes
// anything (fixedByDimension omitted → 0) and never executes a validation
// command (validationResults omitted → verification 0/0, never a fabricated
// check) — the snapshot reflects review findings + convergence only.
const drySeries = Object.create(null)
for (const dim of dims) drySeries[dim] = new Array(rounds.length).fill(0)
for (let i = 0; i < rounds.length; i++) {
  for (const f of (rounds[i].findings || [])) {
    if (f && typeof f === 'object') {
      const s = drySeries[String(f.dimension)]
      if (Array.isArray(s) && i < s.length) s[i] += 1
    }
  }
}
await agent(
  'Call iterate_quality_gate({operation:"compute", dimensions:' + JSON.stringify(dims) +
  ', findings:' + JSON.stringify(Array.isArray(report.findings) ? report.findings : known) +
  ', findingsByRound:' + JSON.stringify(drySeries) + '}) and return {ok, snapshot, warnings}.',
  Object.assign({ label: 'quality-gate:compute' }, backend)
)

// Persist the run's observatory transcript (reviewer threads, trend, findings)
// so the client observatory panel reflects this review. Writes ONLY .iterate/transcript.json.
// A dry-run executes no validation commands, so its \`validations\` is always [].
await agent(
  'Call iterate_transcript({operation:"capture", mode:"dry-run", goal:' + JSON.stringify(report.goal) + ', maxRounds:' + maxRounds + ', roundsExecuted:' + report.convergence.totalRounds + ', findingsByRound:' + JSON.stringify(report.convergence.findingsByRound || []) + ', stoppedReason:"' + stoppedReason + '", validations:[], rounds:' + JSON.stringify(rounds.map(rr => ({ round: rr.round, findings: rr.findings, readFiles: rr.readFiles }))) + '}). Return {operation:"ok"}.',
  Object.assign({ label: 'transcript:capture' }, backend)
)

return {
  mode: 'dry-run',
  goal: report.goal,
  rounds: rounds.length,
  converged: convergedFinal,
  stoppedReason: stoppedReason,
  findingsByRound: report.convergence.findingsByRound,
  totalFindings: report.summary.totalFindings,
  bySeverity: { critical: report.summary.critical, high: report.summary.high, medium: report.summary.medium, low: report.summary.low },
  byDimension: report.summary.byDimension,
  report,
  metaReview: metaAudit ? { verdict: finalReport.verdict, issues: metaAudit.issues || [], checksRun: metaAudit.checksRun || 0 } : null,
  finalReport
}
\`\`\`

Key rules for dry-run:
- **NEVER call a fixer / never edit files / never create branches or worktree.** Reviewers read only.
- **Every reviewer MUST actually read each file it reports on (read_file) BEFORE judging it, and anchor every finding to a real location. Fabricated file paths or invented line numbers are poisoned evidence and fail the run.** Subagents never report on code they didn't inspect.
- Each round feeds the already-known findings to reviewers so they hunt NEW issues only → that is what drives convergence.
- **Schema validation & retry**: when \`reviewer.output_schema_validation\` is on (default), \`aggregate\` validates every finding against the findings schema and returns \`schemaValidation\` (per-round {round, valid, issues}). If the just-finished round is invalid, retry its reviewers up to 2 times with the strict-JSON nudge (see the loop above), then re-aggregate. Schema-invalid findings are dropped by \`aggregate\` and must NEVER be fed back as known findings or reported as converged.
- Stop when a round reports 0 new findings (converged) or maxReviewRounds is reached.
- The report (with per-round convergence stats + suggested fix priorities) is the deliverable.
- **Meta-review**: after building the report, audit it with \`iterate_review({operation:"meta-review"})\` for internal consistency (counts, severity buckets, dimension sums, sort order, convergence math). The meta-review ALSO runs the hard code-evidence gate (default on): every finding's file/line is validated against real files on disk, so any fabricated location surfaces as a critical \`EVIDENCE_VIOLATION\` and flips the verdict to \`needs_revision\`. The \`finalReport.verdict\` is \`approved\` only when the report passes every check AND every finding anchors to real, read code; otherwise \`needs_revision\`. Surface the final report and its verdict as the closing deliverable.
- Only a single \`report\` entry may be appended to the decision log; nothing else is written to source files. The final \`iterate_transcript capture\` writes ONLY the observatory file (\`.iterate/transcript.json\`) so the client panel reflects the run — it is not a source-code write. The capture carries the computed \`stoppedReason\` (e.g. \`inconclusive\` for a run whose last round was unusable) so the panel shows why the run actually ended instead of the tool guessing from the trend.

### Normal-mode workflow (autonomous closed loop)
Set \`args.mode = "normal"\`. Loop: resume → plan → parallel review ×N → atomic fixes via \`iterate_fix\` → validate → rollback on failure → checkpoint → loop → auto-stop when zero findings remain.
Canonical script — reproduce this structure exactly (adjust dims via the plan):

\`\`\`js
// args = { mode: "normal", maxRounds?, subagentProvider?, subagentModel?, attachments? }
// Optional per-run backend override for sub-agents (omit to inherit the session backend).
const subAgentProvider = (args && args.subagentProvider) || undefined
const subAgentModel = (args && args.subagentModel) || undefined
const backend = Object.assign({}, subAgentProvider ? { provider: subAgentProvider } : {}, subAgentModel ? { model: subAgentModel } : {})
// User-attached image evidence relayed into reviewer prompts (metadata only).
const attachments = (args && Array.isArray(args.attachments)) ? args.attachments : []
phase('preflight')
// PREFLIGHT (#2): with NO configured validation.commands this loop would run
// zero validations every round and still report green (fails OPEN). Read the
// config BEFORE any work and stop with an actionable message — unless the
// caller explicitly opted into an unverified run (args.unverified === true).
const preCfgRes = await agent(
  'Call iterate_config({}) and return the config JSON.',
  Object.assign({ label: 'config:preflight' }, backend)
)
const preCfg = (preCfgRes && preCfgRes.config) ? preCfgRes.config : null
const validationCmds = []
const cfgCommands = preCfg && preCfg.validation && preCfg.validation.commands
if (cfgCommands && typeof cfgCommands === 'object') {
  for (const group of Object.values(cfgCommands)) {
    if (Array.isArray(group)) {
      for (const c of group) { if (typeof c === 'string' && c.trim()) validationCmds.push(c) }
    }
  }
}
// Explicit USER opt-in: proceed knowing nothing will be verified (UNVERIFIED).
const unverified = !!(args && args.unverified === true)
if (validationCmds.length === 0 && !unverified) {
  throw new Error(
    'preflight failed: iterate.config.yaml has NO validation.commands — this iteration would be protected by NO test. ' +
    'Configure at least one trusted command with iterate_config({operation:"write", updates:{validation:{commands:{test:["<command>"]}}}}) ' +
    '(e.g. "npm test"), then re-run; or pass args.unverified:true to proceed WITHOUT verification — the run will then be reported as UNVERIFIED (zero-validation), never as a verified pass.'
  )
}
if (validationCmds.length === 0) {
  log('preflight: no validation.commands configured — proceeding as an EXPLICIT unverified run (args.unverified); every round is UNVERIFIED')
}
phase('resume')
// If a previous run was interrupted, resume from its checkpoint instead of restarting.
// Use operation:"resume" (NOT plain "load"): the tool loads, bumps AND PERSISTS
// resumeCount itself, so a run that is interrupted again before its first save
// still counts this resumption — and re-adding +1 here on top of the tool's
// bump would double-count. A failed resume (fresh run with no checkpoint, or a
// persist error on a real one) falls back to a plain "load" so the state is
// never lost.
const resumeRes = await agent(
  'Call iterate_checkpoint({ operation: "resume" }) and return {ok, checkpoint, error}.',
  Object.assign({ label: 'checkpoint:resume' }, backend)
)
let checkpoint = (resumeRes && resumeRes.ok !== false && resumeRes.checkpoint) ? resumeRes.checkpoint : null
if (!checkpoint) {
  const loadRes = await agent(
    'Call iterate_checkpoint({ operation: "load" }) and return the checkpoint JSON.',
    Object.assign({ label: 'checkpoint:load' }, backend)
  )
  checkpoint = (loadRes && loadRes.checkpoint) ? loadRes.checkpoint : null
}
const startRound = (checkpoint && typeof checkpoint.round === 'number') ? checkpoint.round + 1 : 1
// Already-bumped count returned by the tool's resume (0 when there was nothing to resume).
const effectiveResumeCount = (checkpoint && typeof checkpoint.resumeCount === 'number') ? checkpoint.resumeCount : 0
if (checkpoint) {
  // A previous run left a checkpoint — record the recovery so the decision log
  // shows the resume, then continue where it left off.
  await agent(
    'Call iterate_decision_log({operation:"append", type:"resume", round:' + startRound + ', data:{resumedFromRound:' + checkpoint.round + ', resumeCount:' + effectiveResumeCount + '}})',
    Object.assign({ label: 'log:resume' }, backend)
  )
}

phase('plan')
const configRes = await agent(
  'Call iterate_config({}) and return the config JSON.',
  Object.assign({ label: 'config:read' }, backend)
)
const cfg = (configRes && configRes.config) ? configRes.config : null
const atomicMaxLines = (cfg && cfg.atomic && cfg.atomic.max_lines) ? cfg.atomic.max_lines : 20
const planRes = await agent(
  'Call iterate_review({operation:"plan", mode:"normal"' + (args.maxRounds ? ', maxReviewRounds:' + args.maxRounds : '') + '}) and return the plan JSON.',
  Object.assign({ label: 'review:plan' }, backend)
)
const plan = (planRes && planRes.plan) ? planRes.plan : null
if (!plan || !Array.isArray(plan.dimensions)) throw new Error('plan failed: iterate_review did not return a valid plan')
const knownIntentional = (plan.knownIntentional || [])   // config personalization filter, applied in aggregate
const dims = plan.dimensions.map(d => d.id)
const maxRounds = plan.maxReviewRounds
const rounds = []          // findings per review round (each on the then-current code state)
// Per-round AGGREGATE findings (deduped / known_intentional-filtered /
// schema-validated — the same set \`atomic\`/\`remaining\` act on). F8's quality
// certificate is computed from these, never from raw reviewer output.
const roundReports = []
// Restore previously-unfixed architectural findings when resuming an interrupted run.
const architectural = (checkpoint && Array.isArray(checkpoint.findings)) ? checkpoint.findings : []   // findings deliberately left unfixed (reported at the end)
let fixedCount = (checkpoint && typeof checkpoint.fixedCount === 'number') ? checkpoint.fixedCount : 0
let converged = false
let abortedByValidation = false
let schemaFailed = false        // last round produced no usable reviewer output (schema-invalid after retries / all reviewers failed)
let validationUnavailable = false // the validate subagent itself failed (null / no results) — validation could not run, so the round is UNVERIFIED
let failedCommands = []
let configErrors = []          // validation commands NOT in validation.commands (config gap, no rollback)
const fixRecords = []        // observatory fix records collected round by round
// Every validation outcome captured for the transcript (round + command +
// exitCode + allowed) — persisted via \`iterate_transcript capture\` so the run
// console can show WHICH commands ran and whether they passed (#6).
const validationRecords = []
// F10 (defense events): rollbacks / precondition failures fire during the
// loop; \`recordDefense\` logs each one to \`.iterate/defense-events.json\`.
// Labels follow the project \`language\` inside the tool.
const recordDefense = (type, roundNo, description, defense, outcome) =>
  agent(
    'Call iterate_defense_events({operation:"record", type:' + JSON.stringify(type) +
    ', round:' + roundNo +
    ', severity:' + (type === 'rollback' ? '"high"' : '"medium"') +
    ', description:' + JSON.stringify(description) +
    ', defense:' + JSON.stringify(defense) +
    ', outcome:' + JSON.stringify(outcome) + '}). Return {operation:"ok"}.',
    Object.assign({ label: 'defense:' + type + ':r' + roundNo }, backend)
  )
// Slot index of the current round within this run's rounds array. A resumed
// run starts at startRound > 1, so the round NUMBER is not a valid array index.
let roundSlot = -1
// Highest round number actually executed by THIS run (carried so a resumed run
// reports its true round, not the count of rounds it happened to run).
let lastRound = startRound - 1

phase('loop')
for (let r = startRound; r <= maxRounds; r++) {
  // Re-read the steering nudge at the start of EVERY round (not once before
  // the loop): iterate_transcript nudge promises to steer "the next round's
  // reviewers", so a nudge written mid-run must reach round 2+ — a single
  // pre-loop read froze the round-1 nudge for the whole run.
  const transRead = await agent(
    'Call iterate_transcript({operation:"read"}) and return {nudge:<transcript.nudge ? transcript.nudge.text : null>}.',
    Object.assign({ label: 'transcript:read:r' + r }, backend)
  )
  const steering = transRead && typeof transRead.nudge === 'string' && transRead.nudge ? transRead.nudge : null
  log('round ' + r + ' of ' + maxRounds + ' — review current state, fix atomics via iterate_fix, validate')
  roundSlot = rounds.length
  lastRound = r
  // Audit-trail: record the round start (SKILL.md Phase 4 requires per-round records).
  await agent(
    'Call iterate_decision_log({operation:"append", type:"round_start", round:' + r + ', data:{maxRounds:' + maxRounds + ', fixedSoFar:' + fixedCount + '}})',
    Object.assign({ label: 'log:start:r' + r }, backend)
  )
  let agg = null
  let schemaInvalid = false
  let attempts = 0
  // Declared OUTSIDE the do-block: both are read after the retry loop exits,
  // and block-scoped consts here raised ReferenceError at runtime (crashing
  // both canonical workflows after the first round) whenever the aggregate
  // subagent resolved null — the findings fallback below read thisRound.
  let reviewersOk = true
  // Safe empty shape: the do-block always overwrites it, but the post-loop
  // read must never depend on block scope again.
  let thisRound = { round: r, findings: [], readFiles: [] }
  do {
    attempts += 1
    // Schema validation retry: on the 2nd+ pass, nudge reviewers toward strict JSON.
    const nudge = attempts > 1
      ? '\\nSTRICT JSON REQUIRED: your previous output failed schema validation. Return ONLY a JSON object {"findings":[...]} where EVERY finding has dimension, file, line (non-negative integer; 0 = whole-file), severity (critical|high|medium|low), summary, failure_scenario, suggested_fix, is_atomic (boolean).'
      : ''
    const raw = await parallel(dims.map(dim => () => {
      // Pass the plan's full per-dimension reviewerPrompt (COVERAGE RULE with
      // the assigned file inventory, EVIDENCE RULE, output language) plus the
      // round-specific context.
      const meta = plan.dimensions.find(x => x.id === dim)
      const base = (meta && typeof meta.reviewerPrompt === 'string' && meta.reviewerPrompt)
        ? meta.reviewerPrompt
        : 'Review dimension "' + dim + '" on the CURRENT code state (previous atomic findings are fixed).'
      const extra =
        (steering ? '\\n STEERING — read this first: ' + steering : '') +
        (attachments.length > 0 ? '\\n User-attached images are part of the evidence; use their descriptions when judging (you see the metadata/descriptions below, not the pixels): ' + JSON.stringify(attachments) + '.' : '') +
        '\\n Do NOT re-report already-known architectural findings: ' + JSON.stringify(architectural) + nudge + '\\nReturn the findings JSON object.'
      return agent(base + extra, Object.assign({ label: 'review:' + dim + ':r' + r, schema: meta.findingsSchema }, backend))
    }))
    // ALL reviewers returning null (child failures) means this round produced
    // no usable output — an empty aggregate must not read like a clean
    // "nothing to fix" convergence. Gate the loop exit + convergence on it.
    reviewersOk = raw.length > 0 ? raw.some(x => x !== null && typeof x === 'object') : true
    thisRound = {
      round: r,
      findings: [].concat(...raw.map(x => x && x.findings ? x.findings : [])),
      readFiles: [].concat(...raw.map(x => x && Array.isArray(x.readFiles) ? x.readFiles : [])),
    }
    if (roundSlot < rounds.length) rounds[roundSlot] = thisRound; else rounds.push(thisRound)

    // Deterministic dedupe / known_intentional filter / severity sort for this round.
    // \`fixedCount\` is threaded into the report summary so the client dashboard can
    // show a running "fixes applied" metric for normal mode.
    agg = await agent(
      'Call iterate_review({operation:"aggregate", mode:"normal", rounds:' + JSON.stringify([thisRound]) + ', knownIntentional:' + JSON.stringify(knownIntentional) + ', fixedCount:' + fixedCount + '}) and return the report JSON.',
      Object.assign({ label: 'review:aggregate:r' + r }, backend)
    )
    // reviewer.output_schema_validation (default on): aggregate returns per-round
    // schemaValidation; retry the just-finished round (≤2 times) when invalid.
    schemaInvalid = agg && agg.schemaValidation && agg.schemaValidation.length > 0
      ? agg.schemaValidation[agg.schemaValidation.length - 1].valid === false
      : false
    if (schemaInvalid && attempts < 3) {
      log('retry ' + attempts + ': round ' + r + ' output failed schema validation — re-running reviewers with strict-JSON emphasis')
    }
  } while (schemaInvalid && attempts < 3)
  // Freeze the round's aggregate findings for the final F8 gate — the raw
  // reviewer output above may still hold duplicates the aggregate dropped.
  roundReports[roundSlot] = (agg && agg.report && Array.isArray(agg.report.findings))
    ? agg.report.findings
    : thisRound.findings
  if (schemaInvalid || !reviewersOk) {
    // Bounded exit: never loop forever, and never let an all-failed/empty round
    // read like a clean convergence. Stop the run WITHOUT applying fixes for
    // this round, record the failure in the audit trail, and leave the
    // checkpoint in place so a user/DM can resume or re-roll after fixing the
    // reviewer configuration.
    schemaFailed = true
    log('round ' + r + ' produced NO usable reviewer output (schema-invalid after retries or all reviewers failed) — stopping run (NOT converged)')
    await agent(
      'Call iterate_decision_log({operation:"append", type:"round_failed", round:' + r + ', data:{reason:"' + (schemaInvalid ? 'schema_invalid' : 'no_usable_reviewer_output') + '", rolledBack:0}})',
      Object.assign({ label: 'log:schemaFailed:r' + r }, backend)
    )
    // F10: an unusable round is a precondition failure the gate could not clear.
    await recordDefense('precondition_failed', r, 'reviewer output unusable: ' + (schemaInvalid ? 'schema-invalid after 3 attempts' : 'all reviewers failed'), 'reviewer output schema gate', 'round inconclusive; run stopped WITHOUT fixes (never reported as converged)')
    break
  }
  const findings = (agg && agg.report && agg.report.findings) ? agg.report.findings : thisRound.findings
  const atomic = findings.filter(f => f.is_atomic === true)
  const remaining = findings.filter(f => f.is_atomic !== true)

  const roundFixIds = []
  if (atomic.length > 0) {
    // Group atomic fixes by file. One fixer agent handles a whole file serially —
    // calling iterate_fix per finding (the ONLY sanctioned writer), then
    // iterate_diff to verify — so the same file is never edited concurrently;
    // different files still run in parallel.
    // Null-prototype map: f.file is MODEL-CONTROLLED, and on a plain {} a
    // finding with file "__proto__" or "constructor" resolves to
    // Object.prototype/Object — the "|| []" keeps that inherited object and
    // ".push(f)" then throws TypeError, killing the whole run. With
    // Object.create(null) every key is an own property, and Object.keys(byFile)
    // (the only downstream usage) works unchanged.
    const byFile = Object.create(null)
    atomic.forEach(f => { (byFile[f.file] = byFile[f.file] || []).push(f) })
    const fixRes = await parallel(Object.keys(byFile).map(file => () => agent(
      'Apply the fixes for ' + JSON.stringify(file) + ' using iterate_fix. For EACH finding in this list, ' +
      'read the current file, compute the edited full content (change <= ' + atomicMaxLines + ' lines), and call ' +
      'iterate_fix({ file: ' + JSON.stringify(file) + ', content: <full new file content>, finding: <that finding>, round: ' + r + ' }). ' +
      'Apply the findings IN ORDER. After all fixes, call iterate_diff({ file: ' + JSON.stringify(file) + ' }) to verify the accumulated diff and ' +
      'read its line statistics (lines added/removed). ' +
      'Findings: ' + JSON.stringify(byFile[file]) + '. Return the array of {id, ok, error, file, linesAdded, linesRemoved} per iterate_fix call ' +
      '(id/ok required; put the file-wide line stats from iterate_diff on each record, or on the last record and 0 elsewhere).',
      Object.assign({ label: 'fix:' + file, phase: 'fix', schema: {
        type: 'object', additionalProperties: false,
        properties: {
          fixes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' }, file: { type: 'string' }, linesAdded: { type: 'integer' }, linesRemoved: { type: 'integer' } }, required: ['id', 'ok'] } }
        },
        required: ['fixes'] } }, backend)
    )))
    for (const res of fixRes) {
      if (res && Array.isArray(res.fixes)) {
        for (const fx of res.fixes) {
          if (fx && fx.ok === true) { fixedCount += 1; roundFixIds.push(fx.id) }
          // Collect fix records for the observatory transcript (defensive defaults).
          const fixFileKeys = Object.keys(byFile)
          fixRecords.push({
            id: fx && typeof fx.id === 'string' ? fx.id : '',
            file: fx && typeof fx.file === 'string' ? fx.file : (fixFileKeys.length === 1 ? fixFileKeys[0] : ''),
            round: r,
            summary: '',
            linesAdded: fx && typeof fx.linesAdded === 'number' ? fx.linesAdded : 0,
            linesRemoved: fx && typeof fx.linesRemoved === 'number' ? fx.linesRemoved : 0,
            success: !!(fx && fx.ok === true),
          })
        }
      }
    }
    // F10: a fix iterate_fix REFUSED (at this point in the round success:false
    // can only mean the tool refused it — rollbacks flip records later) means
    // the reviewer's \`is_atomic\` assumption was wrong: the change did not fit
    // the atomic limit. That is a falsified assumption, not a code failure.
    const refusedFixes = fixRecords.filter(fr => fr.round === r && fr.success === false)
    if (refusedFixes.length > 0) {
      await recordDefense('assumption_falsified', r, refusedFixes.length + ' finding(s) marked atomic could not be applied by iterate_fix', 'finding judged is_atomic (change ≤ ' + atomicMaxLines + ' lines in one file)', 'fix refused — the atomicity assumption was wrong for these findings; they stay open for a follow-up round')
    }
  }

  // Cross-round dedupe of architectural findings before accumulating.
  const seenKeys = architectural.map(a => a.file + '|' + a.dimension + '|' + a.summary)
  for (const f of remaining) {
    const key = f.file + '|' + f.dimension + '|' + f.summary
    if (seenKeys.indexOf(key) < 0) { architectural.push(f); seenKeys.push(key) }
  }

  // Validate every configured command; on ANY *executed* failure roll back this
  // round's fixes. iterate_validate returns \`allowed:false\` + \`rejectReason\`
  // when a command is NOT in validation.commands (a config gap, NOT a code
  // failure) — those abort the run WITHOUT rolling back (the code changes are
  // fine; the trust list just needs fixing).
  let valResults = []
  if (unverified) {
    // Explicit user opt-in chosen at the preflight above: NOTHING is configured
    // to validate, so validation is skipped DELIBERATELY — never silently.
    // The round runs UNVERIFIED and the final report/stoppedReason carry
    // zeroValidation so it can never read as a verified pass.
    log('round ' + r + ' UNVERIFIED (args.unverified, no validation.commands) — skipping validation for this round')
  } else {
    const valRes = await agent(
      'Read iterate.config.yaml validation.commands, then call iterate_validate({ command: <cmd> }) for EACH configured command ' +
      '(one tool call per command). Return all results as {command, exitCode, allowed, rejectReason} entries — include \`allowed\` and \`rejectReason\` exactly as returned by iterate_validate (allowed:false means the command is not in validation.commands).',
      Object.assign({ label: 'validate:r' + r, phase: 'validate', schema: {
        type: 'object', additionalProperties: false,
        properties: {
          results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { command: { type: 'string' }, exitCode: { type: 'integer' }, allowed: { type: 'boolean' }, rejectReason: { type: 'string' } }, required: ['command', 'exitCode'] } }
        },
        required: ['results'] } }, backend)
    )
    if (!valRes || !Array.isArray(valRes.results)) {
      // A FAILED validate subagent (null / missing results) must abort the run
      // exactly like a validation failure: collapsing it to [] would mark every
      // command as passed, skip the failure branch below, and continue as if the
      // round were verified (fails OPEN). Stop here — before the checkpoint save
      // and the next round — keeping the round's fixes on disk (they may be
      // fine) but UNVERIFIED, with the checkpoint left in place for a resume.
      validationUnavailable = true
      abortedByValidation = true
      log('round ' + r + ' validation could NOT run (iterate_validate subagent failed) — stopping run; fixes from this round are kept but UNVERIFIED')
      await agent(
        'Call iterate_decision_log({operation:"append", type:"round_failed", round:' + r + ', data:{reason:"validation_unavailable", rolledBack:0}})',
        Object.assign({ label: 'log:valUnavailable:r' + r }, backend)
      )
      await recordDefense('precondition_failed', r, 'validation subagent failed — no command could run', 'validate subagent unavailable', 'round stopped with fixes kept UNVERIFIED (no rollback)')
      break
    }
    valResults = valRes.results
    if (valResults.length === 0) {
      // ZERO results (#2): the validator returned an EMPTY set, so NO
      // configured command was actually executed this round. An empty result
      // is NOT a pass — treat it exactly like a failed validator (fail CLOSED)
      // instead of letting a zero-verification round look green. The preflight
      // above already blocks the "no commands configured" case, so reaching
      // here means the run simply verified nothing.
      validationUnavailable = true
      abortedByValidation = true
      log('round ' + r + ' validation produced ZERO results — stopping run (a round with no executed validation is never a pass)')
      await agent(
        'Call iterate_decision_log({operation:"append", type:"round_failed", round:' + r + ', data:{reason:"zero_validation_results", rolledBack:0}})',
        Object.assign({ label: 'log:zeroValidation:r' + r }, backend)
      )
      await recordDefense('precondition_failed', r, 'validation produced zero results — no command ran', 'validation result gate', 'round stopped with fixes kept UNVERIFIED (no rollback)')
      break
    }
    // Persist every outcome for the transcript console (#6): command, exit
    // code, allow-list verdict, and the reject reason when the list refused it.
    for (const v of valResults) {
      if (v && typeof v === 'object') {
        validationRecords.push({
          round: r,
          command: typeof v.command === 'string' ? v.command : '',
          exitCode: typeof v.exitCode === 'number' && isFinite(v.exitCode) ? Math.floor(v.exitCode) : null,
          allowed: v.allowed === true,
          rejectReason: (typeof v.rejectReason === 'string' && v.rejectReason) ? v.rejectReason : undefined
        })
      }
    }
  }
  configErrors = valResults.filter(v => v.allowed === false).map(v => v.rejectReason || (v.command + ' was rejected'))
  failedCommands = valResults.filter(v => !(v.allowed === false) && v.exitCode !== 0).map(v => v.command)
  if (configErrors.length > 0) {
    log('round ' + r + ' validation CONFIG error (not in validation.commands): ' + configErrors.join(' | ') + ' — aborting WITHOUT rollback (code changes are kept; the command trust list needs updating)')
    abortedByValidation = true
    await agent(
      'Call iterate_decision_log({operation:"append", type:"round_failed", round:' + r + ', data:{configErrors:' + JSON.stringify(configErrors) + ', rolledBack:0, reason:"command not in validation.commands"}})',
      Object.assign({ label: 'log:configError:r' + r }, backend)
    )
    await recordDefense('precondition_failed', r, 'command not in validation.commands: ' + configErrors.join(' | '), 'validation command allow-list', 'run aborted WITHOUT rollback; the trust list needs updating')
    break
  }
  if (failedCommands.length > 0) {
    log('round ' + r + ' validation FAILED on: ' + failedCommands.join(', ') + ' — rolling back this round')
    abortedByValidation = true
    if (roundFixIds.length > 0) {
      await agent(
        'Call iterate_rollback({ id: <id> }) for EACH of these fix ids (one call per id): ' + JSON.stringify(roundFixIds) + '. Return the array of {id, ok, error}.',
        Object.assign({ label: 'rollback:r' + r, phase: 'rollback', schema: {
          type: 'object', additionalProperties: false,
          properties: {
            results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' } }, required: ['id', 'ok'] } }
          },
          required: ['results'] } }, backend)
      )
      // The round's fixes were reverted on disk — the observatory records and
      // the running fixedCount must stop counting them as applied, otherwise
      // findingsFixed / the final capture would report rolled-back work as
      // done. Each roundFixId was pushed with success:true exactly once, so
      // the guard keeps the decrement single-shot per fix.
      for (const rec of fixRecords) {
        if (rec.round === r && rec.success && roundFixIds.indexOf(rec.id) >= 0) {
          rec.success = false
          fixedCount -= 1
        }
      }
    }
    await agent(
      'Call iterate_decision_log({operation:"append", type:"round_failed", round:' + r + ', data:{failedCommands:' + JSON.stringify(failedCommands) + ', rolledBack:' + roundFixIds.length + '}})',
      Object.assign({ label: 'log:failed:r' + r }, backend)
    )
    // F10: every rollback is a defense event the F10 tab surfaces as a count.
    await recordDefense('rollback', r, 'validation failed on: ' + failedCommands.join(', '), 'iterate_rollback reverted the round-' + r + ' fixes', roundFixIds.length + ' fix(es) reverted; run stopped (checkpoint kept for resume)')
    break
  }

  // F9 (experience bank): validation PASSED for this round, so these fixes are
  // VERIFIED — bank them before moving on. An UNVERIFIED run banks NOTHING:
  // with no validation command executed there is no proof the fix worked.
  // \`iterate_experience add\` dedupes on
  // pattern+dimension (repeat = hit count bump), so a re-discovered finding
  // never floods the bank. Each successful fix record is paired with the next
  // unused atomic finding of the same file (fixes are per-file, in order).
  if (roundFixIds.length > 0 && !unverified) {
    const expByFile = Object.create(null)
    for (const f of atomic) { (expByFile[f.file] = expByFile[f.file] || []).push(f) }
    const expUsed = Object.create(null)
    const expEntries = []
    for (const rec of fixRecords) {
      if (rec.round !== r || !rec.success || roundFixIds.indexOf(rec.id) < 0) continue
      const pool = expByFile[rec.file] || []
      let finding = null
      for (let i = 0; i < pool.length; i++) {
        const key = rec.file + '#' + i
        if (!expUsed[key]) { expUsed[key] = true; finding = pool[i]; break }
      }
      if (!finding) continue
      expEntries.push({
        pattern: String(finding.summary || finding.dimension || 'atomic fix'),
        dimension: String(finding.dimension || 'general'),
        description: String(finding.failure_scenario || finding.summary || 'Verified atomic fix from this iteration.'),
        verifiedFix: String(finding.suggested_fix || finding.summary || 'Applied via iterate_fix.'),
        findingSummary: String(finding.summary || ''),
        severity: (finding.severity === 'critical' || finding.severity === 'high' || finding.severity === 'medium' || finding.severity === 'low') ? finding.severity : 'medium',
        files: [rec.file],
        tags: ['iterate', 'round-' + r],
      })
    }
    if (expEntries.length > 0) {
      await agent(
        'Fixes from round ' + r + ' PASSED validation. For EACH entry below call ' +
        'iterate_experience({operation:"add", entry:<that entry>}) (the tool dedupes on pattern+dimension — a repeat bumps its hit count). ' +
        'Entries: ' + JSON.stringify(expEntries) + '. Return {added:<number of entries the tool reported as new>}.',
        Object.assign({ label: 'experience:add:r' + r }, backend)
      )
    }
  }

  await agent(
    'Call iterate_decision_log({operation:"append", type:"review_result", round:' + r +
    ', data:{atomic:' + atomic.length + ', architectural:' + remaining.length + ', fixedSoFar:' + fixedCount + '}})',
    Object.assign({ label: 'log:r' + r }, backend)
  )

  // Persist progress so an interrupted run can resume from the next round.
  await agent(
    'Call iterate_checkpoint({ operation: "save", mode: "normal", round:' + r + ', maxRounds:' + maxRounds + ', fixedCount:' + fixedCount + ', architecturalCount:' + architectural.length + ', resumeCount:' + effectiveResumeCount + ', findings:' + JSON.stringify(architectural) + ' }) and return the checkpoint JSON.',
    Object.assign({ label: 'checkpoint:save:r' + r }, backend)
  )

  if (atomic.length === 0 && remaining.length === 0 && !schemaInvalid) {
    log('round ' + r + ' found nothing to fix — converged')
    converged = true
    break
  }
}

phase('report')
await agent(
  'Call iterate_decision_log({operation:"append", type:"report", round:' + lastRound +
  ', data:{mode:"normal", fixed:' + fixedCount + ', architectural:' + architectural.length + '}})',
  Object.assign({ label: 'report:log' }, backend)
)
const statusRes = await agent(
  'Call iterate_status() and return the status JSON.',
  Object.assign({ label: 'status:final' }, backend)
)
const status = (statusRes && statusRes.ok) ? statusRes : null
// F8 (quality gate): persist the run's quality certificate so the command
// panel shows PASS/FAIL + per-dimension scores instead of an empty tab.
// Inputs are assembled defensively:
//   - \`gateFindings\` holds only what is still OPEN on disk: architectural
//     findings (never auto-fixed) plus round findings no successful fix closed
//     (same round + file, paired in order). A finding that was fixed and stayed
//     fixed must NOT fail the final gate.
//   - \`gateSeries\` is the per-dimension NEW-finding series, pre-zeroed to the
//     number of executed rounds so a round that found nothing in a dimension
//     still advances its convergence reading.
//   - \`gateValidation\` maps a null exitCode (command never produced one) to 1 —
//     fail CLOSED, never as a pass.
const gateAll = []
for (let si = 0; si < rounds.length; si++) {
  const roundNo = rounds[si] && typeof rounds[si].round === 'number' ? rounds[si].round : si + 1
  const perFile = Object.create(null)
  for (const f of (roundReports[si] || [])) {
    if (!f || typeof f !== 'object') continue
    const fk = (typeof f.file === 'string') ? f.file : ''
    const idx = perFile[fk] || 0
    perFile[fk] = idx + 1
    gateAll.push({ f: f, key: roundNo + '#' + fk + '#' + idx })
  }
}
const gateClosed = Object.create(null)
for (const rec of fixRecords) {
  if (!rec.success) continue
  const prefix = rec.round + '#' + rec.file + '#'
  for (let i = 0; i < gateAll.length; i++) {
    if (!gateClosed[gateAll[i].key] && gateAll[i].key.indexOf(prefix) === 0) { gateClosed[gateAll[i].key] = true; break }
  }
}
const gateFindings = []
const gateSeen = Object.create(null)
const gatePush = (f) => {
  if (!f || typeof f !== 'object') return
  const key = String(f.file || '') + '|' + String(f.dimension || '') + '|' + String(f.summary || '')
  if (gateSeen[key]) return
  gateSeen[key] = true
  gateFindings.push(f)
}
for (const a of architectural) gatePush(a)
for (const e of gateAll) if (!gateClosed[e.key]) gatePush(e.f)
const gateSeries = Object.create(null)
for (const dim of dims) gateSeries[dim] = new Array(rounds.length).fill(0)
for (let i = 0; i < rounds.length; i++) {
  for (const f of (roundReports[i] || [])) {
    if (f && typeof f === 'object') {
      const s = gateSeries[String(f.dimension)]
      if (Array.isArray(s) && i < s.length) s[i] += 1
    }
  }
}
const gateFixed = Object.create(null)
const gateFixedSeen = Object.create(null)
for (const e of gateAll) {
  if (!gateClosed[e.key]) continue
  const key = String(e.f.file || '') + '|' + String(e.f.dimension || '') + '|' + String(e.f.summary || '')
  if (gateFixedSeen[key]) continue
  gateFixedSeen[key] = true
  const d = String(e.f.dimension || '')
  if (d) gateFixed[d] = (gateFixed[d] || 0) + 1
}
const gateValidation = validationRecords.map(v => ({
  command: v.command,
  exitCode: (typeof v.exitCode === 'number' && isFinite(v.exitCode)) ? Math.floor(v.exitCode) : 1,
}))
await agent(
  'Call iterate_quality_gate({operation:"compute", dimensions:' + JSON.stringify(dims) +
  ', findings:' + JSON.stringify(gateFindings) +
  ', findingsByRound:' + JSON.stringify(gateSeries) +
  ', fixedByDimension:' + JSON.stringify(gateFixed) +
  ', validationResults:' + JSON.stringify(gateValidation) + '}) and return {ok, snapshot, warnings}.',
  Object.assign({ label: 'quality-gate:compute' }, backend)
)
if (!abortedByValidation && !schemaFailed && !validationUnavailable) {
  // Iteration finished cleanly → clear the checkpoint so the next run starts fresh.
  await agent(
    'Call iterate_checkpoint({ operation: "clear" }) and return {ok, existed}.',
    Object.assign({ label: 'checkpoint:clear' }, backend)
  )
}
// Persist the run's observatory transcript (threads, trend, fixes, checkpoint)
// so the client observatory panel reflects the run. Writes ONLY .iterate/transcript.json.
// The checkpoint survives on disk for aborted runs (that is how resumption
  // works), so the transcript must mirror that reality — a null checkpoint here
  // would hide the very thing F5 is meant to resume. Reflect what is on disk.
  const obsCheckpoint = {
    mode: 'normal',
    round: lastRound,
    maxRounds: maxRounds,
    fixedCount: fixedCount,
    resumeCount: effectiveResumeCount,
  }
  const stopReason = schemaFailed
    ? 'schema_invalid'
    : abortedByValidation
      ? (configErrors.length > 0 ? 'aborted_by_config' : 'aborted_by_validation')
      // Clean stop with ZERO recorded validations = an UNVERIFIED run (the
      // explicit args.unverified opt-in from preflight). Never report it as a
      // verified \`converged\`/\`max_rounds_reached\` — the suffix marks that no
      // test ever ran (#2).
      : (validationRecords.length === 0
          ? (converged ? 'converged_unverified' : 'max_rounds_unverified')
          : (converged ? 'converged' : 'max_rounds_reached'))
  await agent(
    'Call iterate_transcript({operation:"capture", mode:"normal", goal:' + JSON.stringify(plan.goal) + ', maxRounds:' + maxRounds + ', roundsExecuted:' + lastRound + ', findingsByRound:' + JSON.stringify(rounds.map(rr => (rr.findings && rr.findings.length) ? rr.findings.length : 0)) + ', stoppedReason:"' + stopReason + '", fixes:' + JSON.stringify(fixRecords) + ', checkpoint:' + JSON.stringify(obsCheckpoint) + ', validations:' + JSON.stringify(validationRecords) + ', rounds:' + JSON.stringify(rounds.map(rr => ({ round: rr.round, findings: rr.findings, readFiles: rr.readFiles }))) + '}). Return {operation:"ok"}.',
    Object.assign({ label: 'transcript:capture' }, backend)
  )
return {
  mode: 'normal',
  goal: plan.goal,
  roundsExecuted: lastRound,
  maxRounds: maxRounds,
  converged: converged,
  abortedByValidation: abortedByValidation,
  schemaFailed: schemaFailed,
  validationUnavailable: validationUnavailable,
  failedCommands: failedCommands,
  configErrors: configErrors,
  stoppedReason: stopReason,
  // #2 close-out: the caller/UI can tell a verified run from one where no
  // validation command ever executed, and which commands were in play.
  zeroValidation: validationRecords.length === 0,
  unverified: unverified,
  validationCommands: validationCmds,
  validations: validationRecords,
  findingsFixed: fixedCount,
  remainingArchitecturalCount: architectural.length,
  remainingArchitectural: architectural,
  status: status ? {
    currentRound: status.currentRound,
    totalRounds: status.totalRounds,
    fixedCount: status.fixedCount,
    architecturalCount: status.architecturalCount,
    findingsCount: status.findingsCount,
    hasCheckpoint: status.hasCheckpoint
  } : null
}
\`\`\`

Key rules for normal mode:
- **Preflight before ANY work**: read \`validation.commands\` via \`iterate_config({})\` and abort with the actionable message when it is empty/missing (it points at \`iterate_config({operation:"write"...})\`) — unless the caller explicitly passed \`args.unverified === true\`. An unverified run is labelled everywhere (log line, \`unverified:true\`/\`zeroValidation:true\` in the return, \`*_unverified\` stoppedReason). "No commands configured" must NEVER read as a green, converged run.
- Fixers are the ONLY agents allowed to write files, and they must go through \`iterate_fix\` — never edit files directly. That is what gives every change a backup, a diff, and a rollback path. Reviewers read only. Architectural findings are reported, never auto-fixed.
- Aggregate the current round deterministically (\`report.findings\`) before fixing, so fixes act on deduped/filtered/sorted findings.
- **Schema validation & retry**: when \`reviewer.output_schema_validation\` is on (default), retry the round's reviewers up to 2 times (3 attempts total) when \`aggregate\` reports \`schemaValidation\` valid=false for it, then re-aggregate. Never forward schema-invalid findings into \`iterate_fix\`. If the output is still schema-invalid after the 3rd attempt — or every reviewer subagent failed outright (no usable output at all) — the round is INCONCLUSIVE: \`break\` the loop, log a \`round_failed\` entry, set \`schemaFailed = true\`, and report \`stoppedReason:"schema_invalid"\`/\`"no_usable_reviewer_output"\`. Never report an inconclusive round as a clean convergence, and keep the checkpoint so the run can be resumed after the reviewer configuration is fixed.
- Apply atomic fixes **per file**: one fixer agent handles all findings for a given file serially (so the same file is never edited concurrently); different files are fixed in parallel.
- **Resume**: read the checkpoint with \`operation:"resume"\` (the tool loads it, bumps \`resumeCount\` AND persists it back — that is what keeps a run interrupted again before its first save counted; never add +1 yourself on top of the tool's bump); fall back to a plain \`operation:"load"\` only when there is no checkpoint to resume. If a previous run left one, continue from \`checkpoint.round + 1\` (its \`fixedCount\` and deduped \`findings\` are carried forward).
- **Validate after every round** of fixes; on ANY validation failure, roll back the round's fixes via \`iterate_rollback\` and stop (the checkpoint is left in place so the run can be resumed). A rollback must also flip that round's fix records to \`success:false\` and decrement \`fixedCount\`, so \`findingsFixed\` and the final capture never count rolled-back work as applied. EXCEPTION: \`iterate_validate\` returning \`allowed:false\` means the command is simply not in \`validation.commands\` — a config gap, not broken code. In that case abort WITHOUT rolling back the round's fixes and surface the missing command + file so the user can fix the trust list. And if the validate SUBAGENT itself fails (resolves null / no \`results\`), validation did NOT run: stop with \`validationUnavailable = true\` (and \`abortedByValidation = true\`) BEFORE the checkpoint save — never collapse a failed validator into an empty, apparently-passing result. The SAME fail-closed rule applies to an EMPTY result set (\`results: []\`): zero commands executed means zero verification, so log \`reason:"zero_validation_results"\`, set \`validationUnavailable = true\`, record the defense event, and stop — an empty result is not a pass.
- **Checkpoint after every round**; clear it only when the iteration completes cleanly (never after a validation, schema, or unavailable-validator abort — the checkpoint must stay for a resume).
- Stop when a round produces nothing to fix (converged), maxReviewRounds is reached, validation aborts the run (including an unavailable validator: \`stoppedReason:"aborted_by_validation"\` with \`validationUnavailable:true\`), or a round yields no usable reviewer output (\`stoppedReason:"schema_invalid"\`). A run that ends cleanly having executed ZERO validation commands reports \`stoppedReason:"converged_unverified"\`/\`"max_rounds_unverified"\` — never a plain \`converged\`/\`"max_rounds_reached"\`.
- Every round, every rollback, and the final report go to the append-only decision log.
- **Close-out for the command-center tabs (F8/F9/F10)**: after the report compute the quality certificate with \`iterate_quality_gate({operation:"compute", dimensions, findings, findingsByRound, fixedByDimension, validationResults})\` (label \`quality-gate:compute\`) — pass only findings still OPEN (architectural + findings no successful fix closed), the per-dimension series, and the recorded validations (a null exitCode counts as failed). During the loop: every validation-passed fix batch is banked via \`iterate_experience add\` (the tool dedupes pattern+dimension into hit counts), and every rollback / precondition failure (validator failed, zero results, allow-list gap, schema-invalid round) or falsified assumption (a fix \`iterate_fix\` refused) is recorded with \`recordDefense\`. Dry-run computes ONLY the quality gate — it applies no fixes (no F9) and triggers no defenses (no F10), because it writes nothing outside the transcript.
- Close with \`iterate_status\` metrics and surface the convergence indicators (fixed count, remaining architectural count, abort reason, verified vs UNVERIFIED) in the final summary.

### Finding schema (for reviewer agents)
{ "dimension": string, "file": string (relative path), "line": number (REQUIRED for line-targeted issues — the exact line you READ; use 0 for whole-file/module-level issues),
  "severity": "critical" | "high" | "medium" | "low", "summary": string (one line),
  "failure_scenario": string (how/when it fails), "suggested_fix": string (the concrete fix),
  "is_atomic": boolean (true if fix ≤ max_lines within a single file/function) }
Atomic = is_atomic true (single file, single function, ≤ config.atomic.max_lines lines change). Architectural = everything else.
Every finding MUST reference a file the reviewer actually read (read_file) and a real location — never speculate about code that was never inspected. Fabricated paths/lines are poisoned evidence and fail the meta-review evidence gate.

### Workflow meta
Always pass \`meta: { name: "iterate", description: "Autonomous iterate loop" }\`.

Always end with a clear summary: total findings, count by severity, fixes applied (normal) or convergence stats (dry-run), and remaining architectural findings.
`

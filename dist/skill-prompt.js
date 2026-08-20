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
- \`iterate_status\` — summarize the current run: mode, round, fixes applied, architectural remaining, decision-log size, checkpoint presence, and whether the run was interrupted (a checkpoint left on disk means the previous run was interrupted and can be resumed)
- \`iterate_history\` — inspect the runtime state in detail: decision-log entries and applied fixes (optionally scoped to a round or a fixed file)
- \`iterate_prune\` — remove stale runtime artifacts (\`.iterate/\` entries). Defaults to a read-only dry-run that reports what WOULD be removed; pass \`dryRun:false\` to actually prune.

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
phase('plan')
// Optional per-run backend override for sub-agents (omit to inherit the session backend).
const subAgentProvider = (args && args.subagentProvider) || undefined
const subAgentModel = (args && args.subagentModel) || undefined
const backend = Object.assign({}, subAgentProvider ? { provider: subAgentProvider } : {}, subAgentModel ? { model: subAgentModel } : {})
// User-attached image evidence relayed into reviewer prompts (metadata only).
const attachments = (args && Array.isArray(args.attachments)) ? args.attachments : []
const planRes = await agent(
  'Call iterate_review({operation:"plan", mode:"dry-run"}) and return the plan JSON.',
  Object.assign({ label: 'review:plan' }, backend)
)
const plan = (planRes && planRes.plan) ? planRes.plan : null
if (!plan || !Array.isArray(plan.dimensions)) throw new Error('plan failed: iterate_review did not return a valid plan')
const dims = plan.dimensions.map(d => d.id)
const maxRounds = plan.maxReviewRounds
const knownIntentional = (plan.knownIntentional || [])   // config personalization filter, applied in aggregate
let known = []              // cumulative DEDUPED findings fed back to reviewers
const rounds = []           // raw per-round findings

phase('review')
for (let r = 1; r <= maxRounds; r++) {
  log('round ' + r + ' of ' + maxRounds + ' — finding NEW issues only')
  let agg = null
  let schemaInvalid = false
  let retries = 0
  do {
    // Schema validation retry: on the 2nd+ pass, nudge reviewers toward strict JSON.
    const nudge = retries > 0
      ? '\\nSTRICT JSON REQUIRED: your previous output failed schema validation. Return ONLY a JSON object {"findings":[...]} where EVERY finding has dimension, file, line (non-negative integer; 0 = whole-file), severity (critical|high|medium|low), summary, failure_scenario, suggested_fix, is_atomic (boolean).'
      : ''
    const raw = await parallel(dims.map(dim => () => agent(
      'Review dimension "' + dim + '".' +
      (attachments.length > 0 ? ' User-attached images are part of the evidence (reproduce/verify against them): ' + JSON.stringify(attachments) + '.' : '') +
      ' Already-known findings (do NOT re-report): ' +
      JSON.stringify(known) + nudge + '\\nReturn the findings JSON object.',
      Object.assign({ label: 'review:' + dim + ':r' + r, schema: plan.dimensions.find(x => x.id === dim).findingsSchema }, backend)
    )))
    const thisRound = { round: r, findings: [].concat(...raw.map(x => x && x.findings ? x.findings : [])) }
    if (rounds.length >= r) rounds[r - 1] = thisRound; else rounds.push(thisRound)
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
    if (schemaInvalid && retries < 2) {
      retries += 1
      log('retry ' + retries + ': round ' + r + ' output failed schema validation — re-running reviewers with strict-JSON emphasis')
    }
  } while (schemaInvalid && retries <= 2)
  // Feed the DEDUPED + already-filtered set back (not raw findings) so the known
  // list stays bounded and reviewers never see the same issue twice.
  if (agg && agg.report && Array.isArray(agg.report.findings)) known = agg.report.findings
  if (agg && agg.report && agg.report.convergence && agg.report.convergence.findingsByRound[r-1] === 0) {
    log('round ' + r + ' found 0 new findings — converged')
    break
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

return {
  mode: 'dry-run',
  goal: report.goal,
  rounds: rounds.length,
  converged: report.convergence.converged,
  stoppedReason: report.convergence.stoppedReason,
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
- Only a single \`report\` entry may be appended to the decision log; nothing else is written.

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
phase('resume')
// If a previous run was interrupted, resume from its checkpoint instead of restarting.
const ckRes = await agent(
  'Call iterate_checkpoint({ operation: "load" }) and return the checkpoint JSON.',
  Object.assign({ label: 'checkpoint:load' }, backend)
)
const checkpoint = (ckRes && ckRes.checkpoint) ? ckRes.checkpoint : null
const startRound = (checkpoint && typeof checkpoint.round === 'number') ? checkpoint.round + 1 : 1
// Track how many times this checkpoint has already been resumed (interruption recovery).
const resumeCount = (checkpoint && typeof checkpoint.resumeCount === 'number') ? checkpoint.resumeCount : 0
if (checkpoint) {
  // A previous run left a checkpoint — record the recovery so the decision log
  // shows the resume, then continue where it left off.
  await agent(
    'Call iterate_decision_log({operation:"append", type:"resume", round:' + startRound + ', data:{resumedFromRound:' + checkpoint.round + ', resumeCount:' + (resumeCount + 1) + '}})',
    Object.assign({ label: 'log:resume' }, backend)
  )
}

phase('plan')
const configRes = await agent(
  'Call iterate_config({ validate: true }) and return the config JSON.',
  Object.assign({ label: 'config:read' }, backend)
)
const cfg = (configRes && configRes.config) ? configRes.config : null
const atomicMaxLines = (cfg && cfg.atomic && cfg.atomic.max_lines) ? cfg.atomic.max_lines : 20
const planRes = await agent(
  'Call iterate_review({operation:"plan", mode:"normal", maxReviewRounds:' + (args.maxRounds || 3) + '}) and return the plan JSON.',
  Object.assign({ label: 'review:plan' }, backend)
)
const plan = (planRes && planRes.plan) ? planRes.plan : null
if (!plan || !Array.isArray(plan.dimensions)) throw new Error('plan failed: iterate_review did not return a valid plan')
const knownIntentional = (plan.knownIntentional || [])   // config personalization filter, applied in aggregate
const dims = plan.dimensions.map(d => d.id)
const maxRounds = plan.maxReviewRounds
const rounds = []          // findings per review round (each on the then-current code state)
const architectural = []   // findings deliberately left unfixed (reported at the end)
let fixedCount = (checkpoint && typeof checkpoint.fixedCount === 'number') ? checkpoint.fixedCount : 0
let converged = false
let abortedByValidation = false
let failedCommands = []

phase('loop')
for (let r = startRound; r <= maxRounds; r++) {
  log('round ' + r + ' of ' + maxRounds + ' — review current state, fix atomics via iterate_fix, validate')
  let agg = null
  let schemaInvalid = false
  let retries = 0
  do {
    // Schema validation retry: on the 2nd+ pass, nudge reviewers toward strict JSON.
    const nudge = retries > 0
      ? '\\nSTRICT JSON REQUIRED: your previous output failed schema validation. Return ONLY a JSON object {"findings":[...]} where EVERY finding has dimension, file, line (non-negative integer; 0 = whole-file), severity (critical|high|medium|low), summary, failure_scenario, suggested_fix, is_atomic (boolean).'
      : ''
    const raw = await parallel(dims.map(dim => () => agent(
      'Review dimension "' + dim + '" on the CURRENT code state (previous atomic findings are fixed). ' +
      (attachments.length > 0 ? ' User-attached images are part of the evidence (reproduce/verify against them): ' + JSON.stringify(attachments) + '.' : '') +
      'Do NOT re-report already-known architectural findings: ' + JSON.stringify(architectural) + nudge + '\\nReturn the findings JSON object.',
      Object.assign({ label: 'review:' + dim + ':r' + r, schema: plan.dimensions.find(x => x.id === dim).findingsSchema }, backend)
    )))
    const thisRound = { round: r, findings: [].concat(...raw.map(x => x && x.findings ? x.findings : [])) }
    if (rounds.length >= r) rounds[r - 1] = thisRound; else rounds.push(thisRound)

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
    if (schemaInvalid && retries < 2) {
      retries += 1
      log('retry ' + retries + ': round ' + r + ' output failed schema validation — re-running reviewers with strict-JSON emphasis')
    }
  } while (schemaInvalid && retries <= 2)
  const findings = (agg && agg.report && agg.report.findings) ? agg.report.findings : thisRound.findings
  const atomic = findings.filter(f => f.is_atomic === true)
  const remaining = findings.filter(f => f.is_atomic !== true)

  const roundFixIds = []
  if (atomic.length > 0) {
    // Group atomic fixes by file. One fixer agent handles a whole file serially —
    // calling iterate_fix per finding (the ONLY sanctioned writer), then
    // iterate_diff to verify — so the same file is never edited concurrently;
    // different files still run in parallel.
    const byFile = {}
    atomic.forEach(f => { (byFile[f.file] = byFile[f.file] || []).push(f) })
    const fixRes = await parallel(Object.keys(byFile).map(file => () => agent(
      'Apply the fixes for ' + file + ' using iterate_fix. For EACH finding in this list, ' +
      'read the current file, compute the edited full content (change <= ' + atomicMaxLines + ' lines), and call ' +
      'iterate_fix({ file: "' + file + '", content: <full new file content>, finding: <that finding>, round: ' + r + ' }). ' +
      'Apply the findings IN ORDER. After all fixes, call iterate_diff({ file: "' + file + '" }) to verify the accumulated diff. ' +
      'Findings: ' + JSON.stringify(byFile[file]) + '. Return the array of {id, ok, error} per iterate_fix call.',
      Object.assign({ label: 'fix:' + file, phase: 'fix', schema: {
        type: 'object', additionalProperties: false,
        properties: {
          fixes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' } }, required: ['id', 'ok'] } }
        },
        required: ['fixes'] } }, backend)
    )))
    for (const res of fixRes) {
      if (res && Array.isArray(res.fixes)) {
        for (const fx of res.fixes) {
          if (fx && fx.ok === true) { fixedCount += 1; roundFixIds.push(fx.id) }
        }
      }
    }
  }

  // Cross-round dedupe of architectural findings before accumulating.
  const seenKeys = architectural.map(a => a.file + '|' + a.dimension + '|' + a.summary)
  for (const f of remaining) {
    const key = f.file + '|' + f.dimension + '|' + f.summary
    if (seenKeys.indexOf(key) < 0) { architectural.push(f); seenKeys.push(key) }
  }

  // Validate every configured command; on ANY failure roll back this round's fixes.
  const valRes = await agent(
    'Read iterate.config.yaml validation.commands, then call iterate_validate({ command: <cmd> }) for EACH configured command ' +
    '(one tool call per command). Return all results as {command, exitCode} entries.',
    Object.assign({ label: 'validate:r' + r, phase: 'validate', schema: {
      type: 'object', additionalProperties: false,
      properties: {
        results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { command: { type: 'string' }, exitCode: { type: 'integer' } }, required: ['command', 'exitCode'] } }
      },
      required: ['results'] } }, backend)
  )
  failedCommands = (valRes && Array.isArray(valRes.results)) ? valRes.results.filter(v => v.exitCode !== 0).map(v => v.command) : []
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
    }
    await agent(
      'Call iterate_decision_log({operation:"append", type:"round_failed", round:' + r + ', data:{failedCommands:' + JSON.stringify(failedCommands) + ', rolledBack:' + roundFixIds.length + '}})',
      Object.assign({ label: 'log:failed:r' + r }, backend)
    )
    break
  }

  await agent(
    'Call iterate_decision_log({operation:"append", type:"review_result", round:' + r +
    ', data:{atomic:' + atomic.length + ', architectural:' + remaining.length + ', fixedSoFar:' + fixedCount + '}})',
    Object.assign({ label: 'log:r' + r }, backend)
  )

  // Persist progress so an interrupted run can resume from the next round.
  await agent(
    'Call iterate_checkpoint({ operation: "save", mode: "normal", round:' + r + ', maxRounds:' + maxRounds + ', fixedCount:' + fixedCount + ', architecturalCount:' + architectural.length + ', resumeCount:' + resumeCount + ', findings:' + JSON.stringify(architectural) + ' }) and return the checkpoint JSON.',
    Object.assign({ label: 'checkpoint:save:r' + r }, backend)
  )

  if (atomic.length === 0 && remaining.length === 0) {
    log('round ' + r + ' found nothing to fix — converged')
    converged = true
    break
  }
}

phase('report')
await agent(
  'Call iterate_decision_log({operation:"append", type:"report", round:' + rounds.length +
  ', data:{mode:"normal", fixed:' + fixedCount + ', architectural:' + architectural.length + '}})',
  { label: 'report:log' }
)
const statusRes = await agent(
  'Call iterate_status() and return the status JSON.',
  { label: 'status:final' }
)
const status = (statusRes && statusRes.ok) ? statusRes : null
if (!abortedByValidation) {
  // Iteration finished cleanly → clear the checkpoint so the next run starts fresh.
  await agent(
    'Call iterate_checkpoint({ operation: "clear" }) and return {ok, existed}.',
    { label: 'checkpoint:clear' }
  )
}
return {
  mode: 'normal',
  goal: plan.goal,
  roundsExecuted: rounds.length,
  maxRounds: maxRounds,
  converged: converged,
  abortedByValidation: abortedByValidation,
  failedCommands: failedCommands,
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
- Fixers are the ONLY agents allowed to write files, and they must go through \`iterate_fix\` — never edit files directly. That is what gives every change a backup, a diff, and a rollback path. Reviewers read only. Architectural findings are reported, never auto-fixed.
- Aggregate the current round deterministically (\`report.findings\`) before fixing, so fixes act on deduped/filtered/sorted findings.
- **Schema validation & retry**: when \`reviewer.output_schema_validation\` is on (default), retry the round's reviewers up to 2 times when \`aggregate\` reports \`schemaValidation\` valid=false for it, then re-aggregate. Never forward schema-invalid findings into \`iterate_fix\`.
- Apply atomic fixes **per file**: one fixer agent handles all findings for a given file serially (so the same file is never edited concurrently); different files are fixed in parallel.
- **Resume**: load the checkpoint first; if a previous run left one, continue from \`checkpoint.round + 1\` (its \`fixedCount\` and deduped \`findings\` are carried forward).
- **Validate after every round** of fixes; on ANY validation failure, roll back the round's fixes via \`iterate_rollback\` and stop (the checkpoint is left in place so the run can be resumed).
- **Checkpoint after every round**; clear it only when the iteration completes cleanly.
- Stop when a round produces nothing to fix (converged) or maxReviewRounds is reached.
- Every round, every rollback, and the final report go to the append-only decision log.
- Close with \`iterate_status\` metrics and surface the convergence indicators (fixed count, remaining architectural count, abort reason) in the final summary.

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
`;

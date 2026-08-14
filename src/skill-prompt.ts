/**
 * The iterate skill prompt injected into the system prompt.
 *
 * This teaches the model how to write a correct `workflow` script that
 * performs the iterate autonomous closed-loop (or dry-run pure review),
 * using the 5 registered tools via subagents.
 */

export const ITERATE_SKILL_PROMPT = `
## Iterate Workflow (autonomous code iteration)

You have the iterate plugin installed, which registers these tools:
- \`iterate_config\` — read iterate.config.yaml (dimensions, validation commands, personalization)
- \`iterate_validate\` — run a whitelisted validation command
- \`iterate_decision_log\` — append to the decision log
- \`iterate_context\` — read SKILL.md / ITERATE.md project context
- \`iterate_review\` — deterministic review engine: \`plan\` builds the review plan; \`aggregate\` dedupes/merges findings and computes convergence. Purely computational.

### When to use
When the user asks to review or iterate on the project (e.g. "review this project", "iterate on error handling", "check the codebase for issues", "dry-run review", "反复审查"), run an iterate **workflow** by calling the \`workflow\` tool.
- If the user says "review only" / "dry run" / "不要改文件" / "反复审查" → use \`mode: "dry-run"\`.
- Otherwise → use \`mode: "normal"\`.

### Workflow script contract
Write a plain-JS script (top-level await, ends with \`return <json>\`). Available globals:
- \`agent(prompt, opts?): Promise<value>\` — spawn a subagent. \`opts.schema\` gives structured output (object-rooted JSON Schema: type/properties/required/additionalProperties/items/enum/const/oneOf only). Resolves \`null\` on child failure. Other opts: \`label\`, \`phase\`.
- \`parallel(thunks): Promise<value[]>\` — run zero-arg async functions concurrently, await all.
- \`phase(title)\`, \`log(message)\` — progress narration.
- \`args\` — the args object passed to the workflow tool.

The script CANNOT call tools directly. Subagents are the ones who call tools.

### Dry-run mode workflow (pure review — the ONLY mode that never touches files)
This is iterate's read-only health-check: repeated review rounds until findings converge,
then produce an auditable report, then audit the report itself (meta-review) and give a
final review report. NO file writes, NO git, NO branches, NO worktree.

Canonical script — reproduce this structure exactly (adjust dims via the plan):

\`\`\`js
phase('plan')
const planRes = await agent(
  'Call iterate_review({operation:"plan", mode:"dry-run"}) and return the plan JSON.',
  { label: 'review:plan' }
)
const plan = (planRes && planRes.plan) ? planRes.plan : null
if (!plan || !Array.isArray(plan.dimensions)) throw new Error('plan failed: iterate_review did not return a valid plan')
const dims = plan.dimensions.map(d => d.id)
const maxRounds = plan.maxReviewRounds
const known = []            // cumulative deduped findings across rounds
const rounds = []           // raw per-round findings

phase('review')
for (let r = 1; r <= maxRounds; r++) {
  log('round ' + r + ' of ' + maxRounds + ' — finding NEW issues only')
  const raw = await parallel(dims.map(dim => () => agent(
    'Review dimension "' + dim + '". Already-known findings (do NOT re-report): ' +
    JSON.stringify(known) + '\\nReturn the findings JSON object.',
    { label: 'review:' + dim + ':r' + r, schema: plan.dimensions.find(x => x.id === dim).findingsSchema }
  )))
  const thisRound = { round: r, findings: [].concat(...raw.map(x => x && x.findings ? x.findings : [])) }
  rounds.push(thisRound)
  known.push(...thisRound.findings)   // rough accumulation; final dedupe is deterministic in aggregate
  // Check convergence deterministically
  const agg = await agent(
    'Call iterate_review({operation:"aggregate", mode:"dry-run", rounds:' + JSON.stringify(rounds) + ', maxReviewRounds:' + maxRounds + '}) and return the report JSON.',
    { label: 'review:aggregate:r' + r }
  )
  if (agg && agg.report && agg.report.convergence.findingsByRound[r-1] === 0) {
    log('round ' + r + ' found 0 new findings — converged')
    break
  }
}

phase('report')
const finalAgg = await agent(
  'Call iterate_review({operation:"aggregate", mode:"dry-run", rounds:' + JSON.stringify(rounds) + ', maxReviewRounds:' + maxRounds + '}) and return the report JSON.',
  { label: 'review:aggregate:final' }
)
const report = (finalAgg && finalAgg.report) ? finalAgg.report : null
if (!report || !report.convergence) throw new Error('aggregate failed: no valid report was produced')
await agent(
  'Call iterate_decision_log({operation:"append", type:"report", round:' + report.convergence.totalRounds + ', data:{mode:"dry-run", totalFindings:' + report.summary.totalFindings + '}})',
  { label: 'review:log' }
)

phase('meta-review')
// Audit the report itself for internal consistency, then produce the final report.
const metaRes = await agent(
  'Call iterate_review({operation:"meta-review", report:' + JSON.stringify(report) + '}) and return the finalReport JSON.',
  { label: 'review:meta' }
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
- Each round feeds the already-known findings to reviewers so they hunt NEW issues only → that is what drives convergence.
- Stop when a round reports 0 new findings (converged) or maxReviewRounds is reached.
- The report (with per-round convergence stats + suggested fix priorities) is the deliverable.
- **Meta-review**: after building the report, audit it with \`iterate_review({operation:"meta-review"})\` for internal consistency (counts, severity buckets, dimension sums, sort order, convergence math). The \`finalReport.verdict\` is \`approved\` only when the report passes every check; otherwise \`needs_revision\`. Surface the final report and its verdict as the closing deliverable.
- Only a single \`report\` entry may be appended to the decision log; nothing else is written.

### Normal-mode workflow (autonomous closed loop)
Set \`args.mode = "normal"\`. Loop: plan → parallel review ×N → fix atomic issues → validate → loop → auto-stop when zero findings remain.
Canonical script — reproduce this structure exactly (adjust dims via the plan):

\`\`\`js
// args = { mode: "normal", maxRounds? }
phase('plan')
await agent(
  'Call iterate_config({ validate: true }) and return the config JSON.',
  { label: 'config:read' }
)
const planRes = await agent(
  'Call iterate_review({operation:"plan", mode:"normal", maxReviewRounds:' + (args.maxRounds || 3) + '}) and return the plan JSON.',
  { label: 'review:plan' }
)
const plan = (planRes && planRes.plan) ? planRes.plan : null
if (!plan || !Array.isArray(plan.dimensions)) throw new Error('plan failed: iterate_review did not return a valid plan')
const dims = plan.dimensions.map(d => d.id)
const maxRounds = plan.maxReviewRounds
const rounds = []          // findings per review round (each on the then-current code state)
const architectural = []   // findings deliberately left unfixed (reported at the end)
let fixedCount = 0
let converged = false

phase('loop')
for (let r = 1; r <= maxRounds; r++) {
  log('round ' + r + ' of ' + maxRounds + ' — review current state, fix atomics, validate')
  const raw = await parallel(dims.map(dim => () => agent(
    'Review dimension "' + dim + '" on the CURRENT code state (previous atomic findings are fixed). ' +
    'Do NOT re-report already-known architectural findings: ' + JSON.stringify(architectural) + '\\nReturn the findings JSON object.',
    { label: 'review:' + dim + ':r' + r, schema: plan.dimensions.find(x => x.id === dim).findingsSchema }
  )))
  const thisRound = { round: r, findings: [].concat(...raw.map(x => x && x.findings ? x.findings : [])) }
  rounds.push(thisRound)

  // Deterministic dedupe / known_intentional filter / severity sort for this round.
  const agg = await agent(
    'Call iterate_review({operation:"aggregate", mode:"normal", rounds:' + JSON.stringify([thisRound]) + '}) and return the report JSON.',
    { label: 'review:aggregate:r' + r }
  )
  const findings = (agg && agg.report && agg.report.findings) ? agg.report.findings : thisRound.findings
  const atomic = findings.filter(f => f.is_atomic === true)
  const remaining = findings.filter(f => f.is_atomic !== true)

  if (atomic.length > 0) {
    await parallel(atomic.map(f => () => agent(
      'Fix this finding with the smallest possible change (single file, single function, <=20 lines). ' +
      JSON.stringify(f) + '. Verify the edit locally before finishing.',
      { label: 'fix:' + f.file + ':' + (f.line || 0), phase: 'fix' }
    )))
    fixedCount += atomic.length
  }
  architectural.push(...remaining)

  await agent(
    'Call iterate_validate for each command in iterate.config.yaml validation.commands and return all {command, exitCode} results.',
    { label: 'validate:r' + r, phase: 'validate' }
  )
  await agent(
    'Call iterate_decision_log({operation:"append", type:"review_result", round:' + r +
    ', data:{atomic:' + atomic.length + ', architectural:' + remaining.length + ', fixedSoFar:' + fixedCount + '}})',
    { label: 'log:r' + r }
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
return {
  mode: 'normal',
  goal: plan.goal,
  roundsExecuted: rounds.length,
  maxRounds: maxRounds,
  converged: converged,
  findingsFixed: fixedCount,
  remainingArchitecturalCount: architectural.length,
  remainingArchitectural: architectural
}
\`\`\`

Key rules for normal mode:
- Fixers are the ONLY agents allowed to write files; reviewers read only. Architectural findings are reported, never auto-fixed.
- Aggregate the current round deterministically (\`report.findings\`) before fixing, so fixes act on deduped/filtered/sorted findings.
- Validate after every round of fixes; validation results are logged, not silently dropped.
- Stop when a round produces nothing to fix (converged) or maxReviewRounds is reached.
- Every round and the final report go to the append-only decision log.

### Finding schema (for reviewer agents)
{ "dimension": string, "file": string (relative path), "line": number (optional),
  "severity": "critical" | "high" | "medium" | "low", "summary": string (one line),
  "failure_scenario": string (how/when it fails), "suggested_fix": string (the concrete fix),
  "is_atomic": boolean (true if fix ≤ max_lines within a single file/function) }
Atomic = is_atomic true (single file, single function, ≤20 lines change). Architectural = everything else.

### Workflow meta
Always pass \`meta: { name: "iterate", description: "Autonomous iterate loop" }\`.

Always end with a clear summary: total findings, count by severity, fixes applied (normal) or convergence stats (dry-run), and remaining architectural findings.
`

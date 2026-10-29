/**
 * src/client/i18n.ts — the plugin UI's bilingual string layer.
 *
 * The panels used to hardcode Chinese copy while the project config (and the
 * model-facing review output) already supported `language: zh | en` — an
 * English reader following README.md got a UI they could not read. This module
 * makes every piece of UI chrome bilingual:
 *
 *   - `t('中文')`   → returns the same string for zh, the `EN` entry for en.
 *   - `tf('模板 {a0}', { a0 })` → the same, plus `{name}` substitution, for the
 *     interpolated strings (round numbers, counts, phase names …).
 *
 * Design constraints:
 *   - **Pure / dependency-free**: no React, no DOM, no `require`. It is the
 *     one client module the unit tests can import directly, so the dictionary
 *     itself is testable (coverage, placeholder parity, no dead entries).
 *   - **Chinese is the key**: the call site stays readable (`t('已复制')`), an
 *     untranslated string degrades to its Chinese original instead of blank UI,
 *     and there is no second bookkeeping list of ids to drift out of sync.
 *   - **Persistence goes through an injected storage port** — the real
 *     localStorage wrapper lives in index.ts (it degrades to a Map in private
 *     mode); this module only asks for `get`/`set`.
 *
 * Model-facing copy — the `build*Instruction` payloads pasted back into the
 * chat — deliberately stays Chinese: it is contract text that mirrors the
 * SKILL.md workflow the model was primed with, and translating it would fork
 * that contract. Only UI chrome is localized.
 */

/** UI language. */
export type Lang = 'zh' | 'en'

/** localStorage key holding the user's explicit language choice. */
export const LANG_STORAGE_KEY = 'iterate-ui-lang'

/**
 * Self-names, shown in the language switcher. A language is always listed in
 * its OWN script (that is the point of the switch), so these deliberately do
 * not go through `t()` — they are the one string per language that never
 * translates.
 */
export const LANG_NAMES: Record<Lang, string> = {
  zh: '简体中文',
  en: 'English',
}

/** Minimal storage port (the client's safe localStorage wrapper satisfies it). */
export interface LangStorage {
  get(key: string): string | null
  set(key: string, value: string): void
}

/**
 * Chinese → English UI copy.
 *
 * Keys are the exact Chinese literals used at the call sites, and interpolated
 * strings keep their `{aN}` placeholder names in both languages —
 * `test/client-i18n.test.ts` enforces that every key used in the client has an
 * entry here, that every entry is used, and that the placeholder sets match.
 */
export const EN: Record<string, string> = {
  // ── run state / dashboard ────────────────────────────────────────────────
  运行中: 'Running',
  已结束: 'Finished',
  'Round {a0}：{a1} 项': 'Round {a0}: {a1} findings',
  '各轮发现数量趋势：{a0}': 'Findings per round: {a0}',
  完整迭代: 'Full iteration',
  '复制启动指令：完整「审查 → 修复 → 验证 → 复盘」闭环（粘贴给模型即可）':
    'Copy the start instruction: the full "review → fix → validate → debrief" loop (paste it to the model)',
  仅评审: 'Review only',
  '复制启动指令：只审查不修改（dry-run）（粘贴给模型即可）':
    'Copy the start instruction: review without changing anything (dry-run) — paste it to the model',
  '第 {a0} 轮进行中{a1}——首轮汇总报告落地后，这里会显示收敛进度与发现统计。':
    'Round {a0} in progress{a1} — convergence progress and finding stats appear here once the first aggregated report lands.',
  ' · 阶段「{a0}」': ' · phase "{a0}"',
  '上次迭代在第 {a0} 轮后停止{a1}，但没有可展示的汇总报告。':
    'The last iteration stopped at round {a0}{a1}, but there is no report to show.',
  '运行一次评审后，这里会显示收敛进度与发现统计。':
    'Run a review and convergence progress and finding stats will show up here.',
  本次迭代从上一次中断的断点继续执行: 'This run resumed from the previous interrupted checkpoint',
  '已中断恢复 ×{a0}': 'Resumed ×{a0}',
  '会话中检测到用户附带的图片，评审将作为视觉证据参考':
    'Images attached by the user were detected in this session; the review treats them as visual evidence',
  '附件图片 {a0}': 'Attached images {a0}',
  '当前处于「{a0}」阶段（运行中）': 'Currently in the "{a0}" phase (running)',
  '最近一次执行停留在「{a0}」阶段（已结束）': 'The last run stopped in the "{a0}" phase (finished)',
  '代码模式：直接修改文件': 'Code mode: edits files directly',
  '迭代模式：审查-修复循环': 'Iterate mode: review → fix loop',
  '+{a0} 更多': '+{a0} more',
  '本轮已应用的原子修复数（正常模式）': 'Atomic fixes applied this round (normal mode)',
  '审查已收敛：最后一轮未发现新问题': 'Review converged: the final round found nothing new',
  '✓ 已收敛': '✓ Converged',
  '首轮 {a0} → 末轮 {a1} 项，降幅 {a2}%{a3}': 'Round {a0} → round {a1} findings, down {a2}%{a3}',
  '，已收敛': ', converged',
  'Iterate · 收敛统计': 'Iterate · Convergence stats',
  收起历史: 'Collapse history',
  '历史 / 趋势': 'History / trend',
  轮次: 'Round',
  发现: 'Findings',
  请继续执行下一轮迭代审查: 'Please continue with the next review round',
  '请回滚上一轮迭代的修复：调用 `iterate_history` 查看本轮 fix id，再用 `iterate_rollback` 逐个撤销这些修复':
    'Please roll back the fixes from the last round: call `iterate_history` for this round’s fix ids, then `iterate_rollback` to undo them one by one',
  'y 修复': 'y fix',
  '保留该 finding，进入修复': 'Keep this finding and move it to fixing',
  'n 跳过': 'n skip',
  '跳过该 finding': 'Skip this finding',
  'a 已知有意': 'a known-intentional',
  '标记为已知有意并写入 known_intentional': 'Mark as known-intentional and write it into known_intentional',

  // ── triage panel ─────────────────────────────────────────────────────────
  'Iterate · Findings 分诊 ({a0}/{a1})': 'Iterate · Findings triage ({a0}/{a1})',
  'y=修复 · n=跳过 · a=已知有意 · ↑/↓ 选择': 'y=fix · n=skip · a=known-intentional · ↑/↓ to move',
  按严重度筛选: 'Filter by severity',
  全部严重度: 'All severities',
  按维度筛选: 'Filter by dimension',
  全部维度: 'All dimensions',
  '搜索文件 / 摘要…': 'Search file / summary…',
  搜索文件或摘要: 'Search file or summary',
  '清除筛选（显示 {a0}）': 'Clear filters (showing {a0})',
  '共 {a0} 项': '{a0} in total',
  '批量作用于：': 'Batch applies to:',
  '批量按钮仅作用于当前筛选可见的 findings': 'Batch buttons only apply to the findings visible under the current filter',
  '可见 {a0}': 'Visible {a0}',
  '批量按钮作用于全部 findings': 'Batch buttons apply to every finding',
  '全部 {a0}': 'All {a0}',
  '把所有判定恢复为默认 y（修复）': 'Reset every verdict to the default y (fix)',
  重置: 'Reset',
  'y {a0} · n {a1} · a {a2} · 待写回 known_intentional：{a3} 条':
    'y {a0} · n {a1} · a {a2} · pending known_intentional write-back: {a3}',
  '当前没有标记为「已知有意」的 finding': 'No finding is marked known-intentional yet',
  '复制应用指令：粘贴后模型会调用 iterate_triage apply（校验、去重、写入前备份、失败自动回滚）':
    'Copy the apply instruction: once pasted, the model calls iterate_triage apply (validates, dedupes, backs up before writing, rolls back on failure)',
  '生成应用指令{a0}': 'Generate apply instruction{a0}',
  '只复制 known_intentional YAML 片段（需自行粘到 iterate.config.yaml 的 personalization.known_intentional 下）':
    'Copy only the known_intentional YAML fragment (you must paste it under personalization.known_intentional in iterate.config.yaml yourself)',
  '仅复制 YAML 片段': 'Copy YAML fragment only',
  '复制 iterate_triage list 指令，核对已经写入的 known_intentional 条目（写回闭环确认）':
    'Copy the iterate_triage list instruction to check which known_intentional entries actually landed (write-back → readback)',
  回读已写入条目: 'Read back written entries',
  '已复制应用指令——粘贴回会话，模型将调用 iterate_triage apply 并回报写入条数。':
    'Apply instruction copied — paste it back into the chat and the model will call iterate_triage apply and report how many entries were written.',
  '已复制回读指令——粘贴回会话可列出当前已写入的 known_intentional。':
    'Readback instruction copied — paste it back to list the known_intentional entries currently written.',

  // ── command actions ──────────────────────────────────────────────────────
  指挥操作: 'Command actions',
  '批准架构修复（复制指令文本：iterate_fix force:true，含全部必填参数）':
    'Approve the architectural fix (copies the instruction text: iterate_fix with force:true and every required argument)',
  批准架构修复: 'Approve architectural fix',
  触发新一轮迭代审查: 'Trigger the next review round',
  触发新一轮: 'New round',
  '指派全部 {a0} 个 findings 修复（逐个 iterate_fix）':
    'Assign all {a0} findings for fixing (one iterate_fix each)',
  '指派当前可见 {a0} 个 findings 修复（逐个 iterate_fix）':
    'Assign the {a0} visible findings for fixing (one iterate_fix each)',
  指派修复: 'Assign fixes',
  回滚到上一个检查点: 'Roll back to the previous checkpoint',
  回滚检查点: 'Rollback to checkpoint',

  // ── verdict banner / stats card ──────────────────────────────────────────
  报告已批准: 'Report approved',
  报告需修订: 'Report needs revision',
  项发现: ' findings',
  轮: ' rounds',
  项审查: ' reviews',
  报告通过全部一致性检查: 'The report passed every consistency check',
  处报告缺陷: ' report defects found',
  已收敛: 'Converged',
  未收敛: 'Not converged',
  'Round {a0} 完成 · 已收敛': 'Round {a0} complete · converged',
  'Round {a0} 完成': 'Round {a0} complete',

  // ── settings ─────────────────────────────────────────────────────────────
  '已清除 {a0} 条': 'Cleared {a0}',
  再次点击以确认清除全部判定: 'Click again to confirm clearing every verdict',
  '清除所有分诊判定记录（需要二次确认）': 'Clear every triage verdict (requires a second click)',
  '确认清除？': 'Confirm clear?',
  清除分诊: 'Clear triage',
  迭代主题: 'Iterate theme',
  '启用暖琥珀配色的 iterate 专属皮肤，覆盖 dsh 默认主题令牌。':
    'Enables the warm-amber iterate skin, overriding the default dsh theme tokens.',
  已启用: 'Enabled',
  已关闭: 'Off',
  '开关 iterate 主题': 'Toggle the iterate theme',
  分诊持久化: 'Triage persistence',
  'y / n / a 判定保存在本地浏览器（localStorage），刷新会话后仍保留。':
    'y / n / a verdicts are stored in your browser (localStorage) and survive a session refresh.',
  本地保存: 'Stored locally',
  配置管理: 'Configuration',
  '目标 / 维度 / 最大轮数 / validation.commands 写在项目的 iterate.config.yaml，复制指引可让模型按需调整。':
    'Goal / dimensions / max rounds / validation.commands live in the project’s iterate.config.yaml; copy the guide to let the model adjust them on demand.',
  复制指引: 'Copy guide',
  收起: 'Collapse',
  展开: 'Expand',
  选择要修改的配置字段: 'Pick the config field to edit',
  '生成并复制该字段的 iterate_config 写入指令（写入前自动备份、失败自动回滚）':
    'Build and copy the iterate_config write instruction for this field (backs up first, rolls back on failure)',
  生成写入指令: 'Build write instruction',
  '剪贴板被拒绝——指令已展示在下方，请手动复制。':
    'The clipboard write was refused — the instruction is shown below, copy it manually.',
  '写入指令（粘贴给模型）': 'Write instruction (paste to the model)',
  '尚未回读当前配置——点「回读当前配置」复制指令发给模型，回显后即可在此看到当前值。':
    'No config read back yet — press “Read back current config”, send the instruction to the model, and the current value shows up here.',
  '当前值 {a0}：{a1}': 'Current value for {a0}: {a1}',
  '回读结果中没有 {a0}（该字段可能尚未写入配置文件）。':
    'The read-back does not contain {a0} (it may not have been written to the config file yet).',
  '复制回读指令：让模型调用 iterate_config(operation:"read") 并回显结果':
    'Copy the read-back instruction: have the model call iterate_config(operation:"read") and echo the result',
  回读当前配置: 'Read back current config',
  '回读指令（粘贴给模型）': 'Read-back instruction (paste to the model)',
  复制: 'Copy',
  'iterate.config.yaml 可编辑字段': 'Editable iterate.config.yaml fields',
  '中文（粘贴给模型的契约文案）': 'Chinese (contract text to paste to the model)',
  状态概览: 'Runtime status',
  '查看运行时产物布局与清理指引。iterate_status / iterate_history / iterate_prune 工具用于查看和管理。':
    'The runtime artifact layout and cleanup guide. Use iterate_status / iterate_history / iterate_prune to inspect and manage them.',
  拉取磁盘快照: 'Pull disk snapshot',
  运行时布局与清理: 'Runtime layout & cleanup',
  '为每次代码评审生成 Review 报告与交互式分诊视图，专注 AI 自我审查与修正。':
    'Generates a review report and an interactive triage view for every code review, focused on AI self-review and correction.',
  就绪: 'Ready',
  'iterate 设置': 'iterate settings',
  '剪贴板写入被拒绝，复制未生效——请展开对应区块手动选中文本复制。':
    'The clipboard write was refused, so nothing was copied — expand the section and copy the text manually.',
  '界面语言': 'Interface language',
  '\u9762\u677f\u6587\u6848\u7684\u663e\u793a\u8bed\u8a00\uff1b\u590d\u5236\u7ed9\u6a21\u578b\u7684\u6307\u4ee4\u4fdd\u6301\u4e2d\u6587\uff0c\u4e0e SKILL.md 的工作流契约一致。':
    'The language of the panel copy. Instructions copied for the model stay Chinese — they mirror the SKILL.md workflow contract.',
  '切换界面语言': 'Switch the interface language',

  // ── observatory shell / live feed ────────────────────────────────────────
  '{a0} 页 · 按 1-9/0 切 Fn、- 回实时流': '{a0} tabs · keys 1-9/0 switch Fn, - returns to the live feed',
  '复制拉取磁盘快照指令：让模型逐个调用 {a0} 并回显完整结果':
    'Copy the disk-snapshot instruction: have the model call {a0} and echo the full results',
  'iterate 观测台': 'iterate observatory',
  '暂无运行时观测数据 · {a0}': 'No runtime observations yet · {a0}',
  '复制拉取磁盘快照指令：磁盘上可能已有历史产物，回显进会话后观测台即可填充':
    'Copy the disk-snapshot instruction: older artifacts may already be on disk; once echoed back into the chat the observatory fills up',
  '实时活动流仅在运行期间记录，当前已完成。':
    'The live activity stream is only recorded while a run is active; this run has finished.',
  查看审查线程: 'View review threads',
  查看发现: 'View findings',
  暂无实时活动: 'No live activity yet',
  实时活动: 'Live activity',
  按活动类型筛选: 'Filter by activity type',
  全部活动: 'All activity',
  无匹配的实时活动: 'No matching live activity',
  复制未成功: 'Copy failed',
  '剪贴板写入被拒绝，请手动选中下方指令复制':
    'The clipboard write was refused — select the instruction below and copy it manually',
  关闭复制失败提示: 'Dismiss the copy-failure notice',
  关闭: 'Dismiss',
  '将观测台全部数据导出为 JSON（优先下载，失败则复制）':
    'Export every observatory panel as JSON (downloads first, falls back to copying)',
  已导出: 'Exported',
  '导出 JSON': 'Export JSON',
  '导出报告': 'Export report',
  '导出可粘贴进 PR 的 Markdown 运行报告（优先下载，失败则复制）':
    'Export a PR-pasteable Markdown run report (download first, copy on failure)',
  '导出 SARIF': 'Export SARIF',
  '导出 SARIF 2.1.0（供 CI / GitHub Code Scanning 消费）':
    'Export SARIF 2.1.0 for CI / GitHub Code Scanning',
  '导出 JSON 报告': 'Export JSON report',
  '导出完整运行模型的 JSON（供 CI 仪表盘 / PR 机器人消费，无损格式）':
    'Export the complete run model as JSON (lossless, for CI dashboards / PR bots)',
  '观测台页签（快捷键 1-9 / 0 / -）': 'Observatory tabs (keys 1-9 / 0 / -)',
  '{a0}（按 {a1} 切换）': '{a0} (press {a1})',
  '{a0}（按 - 切换）': '{a0} (press -)',

  // ── F1 review threads ────────────────────────────────────────────────────
  暂无审查线程: 'No review threads yet',
  审查线程: 'Review threads',
  展开全部线程: 'Expand all threads',
  全部展开: 'Expand all',
  收起全部线程: 'Collapse all threads',
  全部收起: 'Collapse all',
  '{a0} · {a1} 轮': '{a0} · {a1} rounds',
  自由切换: 'Mixed',
  本轮无线程: 'No threads in this round',
  未命名维度: 'Unnamed dimension',
  收起线程: 'Collapse thread',
  展开线程: 'Expand thread',
  叙述: 'Narration',
  '{a0} 条': '{a0}',
  无线索叙述: 'No narration recorded',
  读取文件: 'Files read',
  本线程无发现: 'This thread found nothing',
  '{a0} 线程': '{a0} threads',

  // ── F2 convergence trend ─────────────────────────────────────────────────
  暂无收敛数据: 'No convergence data yet',
  已修复: 'Fixed',
  严重度分布: 'Severity mix',
  验证: 'Validation',
  '{a0}/{a1} 通过{a2}': '{a0}/{a1} passed{a2}',
  '（含失败）': ' (failures included)',
  '各轮发现数量：{a0}{a1}': 'Findings per round: {a0}{a1}',
  ' · 当前 Round {a0}': ' · current round {a0}',
  '跨轮对比（本会话）': 'Cross-round comparison (this session)',
  '跨会话对比：本表只覆盖当前会话；点「拉取磁盘快照」让模型回显 iterate_history，再用「导出 JSON」并排比较两次运行':
    'Cross-session comparison: this table only covers the current session — click "Pull disk snapshot" to have the model echo iterate_history, then use "Export JSON" to compare two runs side by side',

  // ── F3 finding locations ─────────────────────────────────────────────────
  暂无发现: 'No findings',
  '{a0}（{a1} 项）': '{a0} ({a1} findings)',
  '搜索发现…': 'Search findings…',
  搜索发现: 'Search findings',
  清除全部筛选: 'Clear all filters',
  清除筛选: 'Clear filters',
  已确认: 'Acknowledged',
  '复制该 finding 的建议修复文本': 'Copy this finding’s suggested fix text',
  '复制 suggested_fix': 'Copy suggested_fix',
  '复制 iterate_triage 指令文本（标记为 known_intentional）':
    'Copy the iterate_triage instruction text (mark as known_intentional)',
  '复制 iterate_fix 指令文本': 'Copy the iterate_fix instruction text',
  复制修复指令: 'Copy fix instruction',
  无匹配的发现: 'No matching findings',

  // ── F4 fixes & rollback ──────────────────────────────────────────────────
  暂无修复记录: 'No fixes recorded yet',
  成功: 'Success',
  失败: 'Failed',
  '复制 iterate_rollback 指令文本': 'Copy the iterate_rollback instruction text',
  回滚: 'Rollback',

  // ── F5 checkpoint ────────────────────────────────────────────────────────
  断点: 'Checkpoint',
  '复制 iterate_checkpoint resume 指令文本（加载断点并计数一次恢复）':
    'Copy the iterate_checkpoint resume instruction (loads the checkpoint and counts one resume)',
  复制恢复指令: 'Copy resume instruction',
  '复制 iterate_checkpoint clear 指令文本（清除当前断点，供重新开始）':
    'Copy the iterate_checkpoint clear instruction (drops the current checkpoint so you can start over)',
  清除断点: 'Clear checkpoint',

  // ── F6 run console ───────────────────────────────────────────────────────
  询问用户: 'Ask the user',
  拒绝: 'Deny',
  直接执行: 'Run directly',
  '请调用 `iterate_transcript` 写入 nudge 指令：\n\n```json\n{a0}\n```':
    'Please call `iterate_transcript` to write this nudge instruction:\n\n```json\n{a0}\n```',
  '请调用 `iterate_transcript` 清除当前 nudge：\n\n```json\n{a0}\n```':
    'Please call `iterate_transcript` to clear the current nudge:\n\n```json\n{a0}\n```',
  通过: 'Passed',
  导致中止: ' aborted the run',
  验证结果: 'Validation results',
  本轮尚无验证记录: 'No validation was recorded in this round',
  '{a0} 条命令': '{a0} commands',
  因验证失败中止: 'Stopped because validation failed',
  '尚未拉取验证结果：数据在磁盘 transcript 里，点「拉取磁盘快照」复制指令发回会话即可回填。':
    'Validation results have not been pulled yet: they live in the transcript on disk — click "Pull disk snapshot", paste the instruction back into the chat, and this panel fills.',
  运行控制台: 'Run console',
  '批准策略：{a0}': 'Approval policy: {a0}',
  '当前 nudge': 'Current nudge',
  '复制清除 nudge 指令（写 text:null），在运行控制台提示清除已持久化的 nudge':
    'Copy the clear-nudge instruction (writes text:null) to ask the model to drop the persisted nudge',
  已复制清除指令: 'Clear instruction copied',
  复制清除指令: 'Copy clear instruction',
  '起草一条 nudge 方向指令…': 'Draft a nudge to steer the run…',
  'nudge 草稿': 'Nudge draft',
  '复制 iterate_transcript nudge 指令文本': 'Copy the iterate_transcript nudge instruction text',
  '复制 nudge 指令': 'Copy nudge instruction',

  // ── F7 decision timeline ─────────────────────────────────────────────────
  暂无时间线条目: 'No timeline entries yet',
  时间线: 'Timeline',
  按时间线类型筛选: 'Filter the timeline by type',
  全部类型: 'All types',
  按轮次筛选: 'Filter by round',
  全部轮次: 'All rounds',
  '搜索时间线…': 'Search timeline…',
  搜索时间线: 'Search timeline',
  清除: 'Clear',
  无匹配的时间线条目: 'No matching timeline entries',

  // ── F8 quality gate ──────────────────────────────────────────────────────
  质量门禁: 'Quality gate',
  '复制 iterate_quality_gate 查询指令（含 JSON 参数）':
    'Copy the iterate_quality_gate query instruction (JSON arguments included)',
  查询门禁: 'Query gate',
  '复制 iterate_quality_gate clear 指令文本（重置陈旧的 FAIL 证书）':
    'Copy the iterate_quality_gate clear instruction (resets a stale FAIL certificate)',
  清除门禁: 'Clear gate',
  '复制拉取磁盘快照指令：让模型回显 .iterate/ 下的门禁、经验、防御事件与 transcript':
    'Copy the disk-snapshot instruction: have the model echo the gate, experience, defense events and transcript artifacts under .iterate/',
  质量门禁视图: 'Quality gate view',
  质量门禁证书: 'Quality gate certificate',
  '质量门禁显示各维度收敛度、验证通过率和整体 PASS/FAIL 状态。':
    'The quality gate shows per-dimension convergence, the validation pass rate and the overall PASS/FAIL state.',
  复制查询指令: 'Copy query instruction',
  复制拉取磁盘快照指令: 'Copy disk-snapshot instruction',
  '整体评分 {a0} · 验证 {a1}/{a2} · 通过率 {a3}%': 'Overall score {a0} · validation {a1}/{a2} · pass rate {a3}%',
  '{a0} · 收敛 {a1}% · 评分 {a2}': '{a0} · convergence {a1}% · score {a2}',
  '评分 {a0} · 发现 {a1} · 已修复 {a2}': 'Score {a0} · findings {a1} · fixed {a2}',
  '失败原因：{a0}': 'Failure reason: {a0}',

  // ── F9 experience bank ───────────────────────────────────────────────────
  '请调用 `iterate_experience` 搜索经验：\n\n```json\n{a0}\n```':
    'Please call `iterate_experience` to search the experience bank:\n\n```json\n{a0}\n```',
  '请调用 `iterate_experience` 采纳经验并应用已验证修法：\n\n```json\n{a0}\n```':
    'Please call `iterate_experience` to adopt this entry and apply its verified fix:\n\n```json\n{a0}\n```',
  '命中 {a0} 次': 'Hit {a0} times',
  '复制采纳指令（查询该经验并应用到当前上下文）':
    'Copy the adopt instruction (queries this entry and applies it to the current context)',
  采纳: 'Adopt',
  经验银行: 'Experience bank',
  '会话内 {a0} 条': '{a0} in this session',
  '复制列出经验指令（含 JSON 参数）': 'Copy the list-experience instruction (JSON arguments included)',
  列出经验: 'List experiences',
  '复制拉取磁盘快照指令：把 .iterate/ 下的经验银行等产物回显进会话':
    'Copy the disk-snapshot instruction: echo the experience bank and other .iterate/ artifacts back into the chat',
  '搜索经验模式…': 'Search experience patterns…',
  搜索经验: 'Search experiences',
  复制搜索指令: 'Copy search instruction',
  搜索: 'Search',
  '没有匹配「': 'No experience matches “',
  '」的经验': '”',
  '也可点「列出经验」查询磁盘上的全部历史经验。':
    'You can also click "List experiences" to query every historical entry on disk.',

  // ── F10 defense events ───────────────────────────────────────────────────
  '请调用 `iterate_defense_events` 查询防御事件：\n\n```json\n{a0}\n```':
    'Please call `iterate_defense_events` to query defense events:\n\n```json\n{a0}\n```',
  前置校验失败: 'Precondition failed',
  不变量违反: 'Invariant violated',
  假设被证伪: 'Assumption falsified',
  防御事件: 'Defense events',
  '会话内 {a0} 条 / 累计 {a1}': '{a0} in this session / {a1} total',
  '复制列出防御事件指令（含 JSON 参数）':
    'Copy the list-defense-events instruction (JSON arguments included)',
  列出事件: 'List events',
  '复制拉取磁盘快照指令：把 .iterate/ 下的防御事件流回显进会话':
    'Copy the disk-snapshot instruction: echo the defense event stream under .iterate/ back into the chat',
  '请调用 `iterate_defense_events` 查询事件统计：\n\n```json\n{a0}\n```':
    'Please call `iterate_defense_events` for the event counts:\n\n```json\n{a0}\n```',
  '复制统计指令（含 JSON 参数）': 'Copy the counts instruction (JSON arguments included)',
  统计: 'Counts',
  '请调用 `iterate_defense_events` 清除防御事件流：\n\n```json\n{a0}\n```':
    'Please call `iterate_defense_events` to clear the defense event stream:\n\n```json\n{a0}\n```',
  '复制 iterate_defense_events clear 指令文本（重置陈旧事件流）':
    'Copy the iterate_defense_events clear instruction (resets a stale event stream)',
  清除事件: 'Clear events',
  防御事件流: 'Defense event stream',
  '防御事件包括：前置校验失败、回滚、不变量违反、假设被证伪。':
    'Defense events cover failed preconditions, rollbacks, violated invariants and falsified assumptions.',
  按事件类型筛选: 'Filter by event type',
  清除类型筛选: 'Clear type filter',
  '防线：{a0}': 'Defense: {a0}',
  没有匹配该类型的防御事件: 'No defense events of this type',

  // ── F11 preflight ────────────────────────────────────────────────────────
  开跑预检: 'Preflight',
  待预检: 'Not run yet',
  未就绪: 'Not ready',
  '复制 iterate_preflight 预检指令（含 JSON 参数）':
    'Copy the iterate_preflight readiness instruction (JSON arguments included)',
  运行预检: 'Run preflight',
  开跑预检清单: 'Preflight checklist',
  预检结果: 'Preflight result',
  '开跑前先预检：确认验证命令、Git、工作区、陈旧门禁与中断断点都已就绪，避免开跑后才发现环境问题。':
    'Run preflight first: confirm validation commands, git, the working tree, a stale gate and an interrupted checkpoint are ready, so you do not discover an environment problem mid-run.',
  复制预检指令: 'Copy preflight instruction',
  验证命令: 'Validation commands',
  '已配置 {a0} 条验证命令': '{a0} validation command(s) configured',
  '未配置 validation.commands —— 本轮无法证明修复，属阻断项':
    'validation.commands is not configured — the run cannot prove fixes (blocking)',
  'Git 仓库': 'Git repository',
  '已检测到 Git 仓库': 'Git repository detected',
  '不是 Git 仓库 —— changed-only 范围与 iterate_diff 需要它':
    'Not a git repository — changed-only scope and iterate_diff need one',
  工作区: 'Working tree',
  '未提交改动：未知': 'Uncommitted changes: unknown',
  '{a0} 个未提交/未跟踪文件 —— 建议先 commit 或 stash':
    '{a0} uncommitted/untracked file(s) — commit or stash first',
  工作区干净: 'Working tree clean',
  陈旧门禁: 'Stale gate',
  '磁盘上残留 FAIL 质量门禁 —— 开新轮前先清除':
    'A stale FAIL quality gate is persisted — clear it before a fresh run',
  '质量门禁：{a0}': 'Quality gate: {a0}',
  无持久化质量门禁: 'No persisted quality gate',
  中断断点: 'Interrupted checkpoint',
  '存在中断断点（已恢复 {a0} 次）—— 恢复或清除后再开跑':
    'An interrupted checkpoint is waiting (resumed {a0}x) — resume or clear it first',
  无中断断点: 'No interrupted checkpoint',
  配置验证命令: 'Configure validation',
  恢复断点: 'Resume checkpoint',
  '阻断 {a0} · 警告 {a1}': 'Blocking {a0} · warnings {a1}',
  '预检失败：{a0}': 'Preflight failed: {a0}',
  '预检只读，不会修改配置或文件。': 'Preflight is read-only; it never modifies config or files.',

  // ── copy feedback ────────────────────────────────────────────────────────
  已复制: 'Copied',
  复制失败: 'Copy failed',
}
let current: Lang = 'zh'
let storage: LangStorage | null = null
const listeners = new Set<(lang: Lang) => void>()

/** The active UI language. */
export function getLang(): Lang {
  return current
}

/** Switch the UI language: persists the choice and repaints subscribers.
 *
 *  `persist: false` is for the STARTUP resolution (an auto-detected language
 *  must not overwrite the user's explicit choice — or create one they never
 *  made); only an explicit switch writes the preference. */
export function setLang(next: Lang, persist = true): void {
  if (next !== current) {
    current = next
    if (persist) {
      try {
        storage?.set(LANG_STORAGE_KEY, next)
      } catch {
        /* persistence is best-effort */
      }
    }
    for (const listener of [...listeners]) {
      try {
        listener(next)
      } catch {
        /* one bad subscriber must not break the switch */
      }
    }
  }
}

/** Subscribe to language changes; returns the unsubscribe function. */
export function subscribeLang(listener: (lang: Lang) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Hand the module a storage port (called once from `apply()`). */
export function configureLangStorage(next: LangStorage | null): void {
  storage = next
}

/**
 * Resolve the startup language: an explicit stored choice always wins, then
 * the browser locale (a zh* locale gets Chinese, everything else English —
 * which is also what the default `language: 'en'` config assumes).
 */
export function detectLang(stored: string | null | undefined, navigatorLanguage?: string | null): Lang {
  if (stored === 'en' || stored === 'zh') return stored
  return /^zh\b/i.test(navigatorLanguage ?? '') ? 'zh' : 'en'
}

/** Translate a static UI string. */
export function t(key: string): string {
  return current === 'en' ? (EN[key] ?? key) : key
}

/**
 * Translate an interpolated UI string, then substitute `{name}` placeholders.
 * Unknown placeholders are left verbatim (so a translation typo degrades to a
 * readable string rather than `undefined`).
 */
export function tf(template: string, params: Record<string, unknown> = {}): string {
  const translated = current === 'en' ? (EN[template] ?? template) : template
  return translated.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  )
}

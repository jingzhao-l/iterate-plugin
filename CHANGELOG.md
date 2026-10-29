# Changelog

All notable changes to iterate-plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.12.0] - 2026-10-29

开跑预检（Preflight）。新增一个用户可感知的净功能：开始一轮迭代**之前**就把环境
问题摆到桌面上并给出精确修复指令，而不是让模型花掉一轮才发现。按语义化版本是一次 minor。

### Added

- **`iterate_preflight`（新工具，第 19 个）** —— 只读开跑前预检。返回结构化清单：
  - `validation`（**阻断项**）—— `validation.commands` 为空意味着本轮无法证明修复，
    与产品 fail-closed 哲学一致，是唯一会 `blocking` 的检查；
  - `git` —— 是否 Git 仓库（changed-only 范围与 `iterate_diff` 需要它）；
  - `dirty-tree` —— 未提交/未跟踪文件数（git 不可用时降级为"未知"而非误报警告）；
  - `stale-gate` —— 磁盘上残留 FAIL 质量门禁（开新轮前先清除）；
  - `interrupted-checkpoint` —— 存在中断断点（恢复或清除后再开跑）。
  每项都携带结构化事实（`{ id, status: pass|warn|fail, detail }`），`render` 只产出
  model 面向的英文文本；绝不修改配置、文件或产物。
- **观测台新增 F11「开跑预检」页签**（第 12 页，仅点击进入，数字键 1-9/0/- 映射不变）
  —— 扫描会话流中最近一次 `iterate_preflight` 结果并渲染真实数据：就绪/未就绪徽章 +
  阻断/警告计数 + 每项 PASS/WARN/FAIL 芯片。每个 warn/fail 行都给出**精确修复指令**
  （配置 `validation.commands`、清除陈旧门禁、恢复断点），复制即用。空态区分
  "尚未拉取"与"已拉取为空"；`ok:false` 渲染失败信息而非误导性的"就绪"摘要。
  F8/F9/F10 已有的「拉取磁盘快照」模式保持一致，但预检是独立工具调用，不走快照。
- **完成摘要修正** —— `buildCompletionSummary` 此前把一切未收敛的运行都描述为
  "已达最大轮数"；现在读取真实的 `stoppedReason`（验证失败回滚 / 验证命令未白名单 /
  轮次结论不明 / schema 失败 / 无可用审查输出分别给出准确措辞），未知原因降级为原值。

### Changed

- 工具总数 18 → 19；观测台 11 → 12 页签（README 中英双语文档同步）。
- 无上游 dsh 新版本（最新仍为 `0.2.2-alpha.2`，已声明 compatible），本轮为插件自有
  能力，未转化新 dsh 能力。

### Tests

- 新增 `test/preflight.test.ts`（12 例：纯函数决策 + 工具注册 + 真实临时目录的
  execute，含 git init / 脏工作区 / 陈旧门禁 / 中断断点 / git 不可用降级）。
- `test/parse.test.ts` 新增 `scanSessionForPreflight` / `normalizePreflightReport` /
  `isPreflightReport` 共 5 例 + `buildCompletionSummary` stoppedReason 修正 1 例。
- `test/client-render.test.ts` 新增 F11 渲染 3 例（真实清单、空态指令、失败态）。
- `test/index.test.ts` / `test/package-contract.test.ts` 工具计数 18 → 19。
- 全套 `npm run typecheck`（tsc ×3 程序）0 错误；`npm test` 1340 passed / 0 failed
  （基线 1319 → 1340，+21）。

## [3.11.0] - 2026-10-28

无损报告 JSON + 上游兼容追到 `0.2.2-alpha.2`。新增一个用户可感知的导出格式
（v3.9 的 Markdown / SARIF 之外补上**机器可读的完整归一化模型**），按语义化版本是一次 minor。

### Added

- **`iterate_report` 新增 `format:"json"`** —— 产出**完整归一化运行模型**（`RunReportJson`，
  `$schema: "iterate-run-report/1"`）：项目、目标、模式、轮次、收敛率、严重度分布、发现、
  修复、验证、质量门禁、经验银行、防御事件，全部是结构化数据。这是**唯一无损格式**：
  Markdown 是给人看的投影，SARIF 只携带发现（作为 code-scanning 结果），JSON 把人类报告
  展示的每一条事实原样交给 CI 仪表盘 / PR 机器人，无需反解析人类报告。缺失或中断的运行
  依然产出合法文档（空数组、null 存储）——导出永不因运行中断而失败。
- **观测台新增「导出 JSON 报告」按钮**（F8 报告区，与导出报告 / 导出 SARIF 并列），
  与 `iterate_report` 工具共用同一份数据模型，优先下载、失败回退复制。
- **peer 兼容性追到 `@deepseek-ai/*@0.2.1-rc.4` 与 `@deepseek-ai/*@0.2.2-alpha.2`**。
  rc.4（上游 10-28 发布）只修 ACP 模式下诊断输出混入 stdout，无插件面 API 变动；
  0.2.2-alpha.2（同日发布）是 0.2.2 系列首个 alpha，含若干**插件面破坏性变更**
  （`tools.resolve/executable` 与提示词组装接口迁移、会话投影句柄改异步、`agent/request`
  不再允许改路由、Cordis Timer 返回值适配、DSH 最低 Node 提升至 24.9），但本插件只从
  `dsh-tools` 导入 `defineTool`、从 `dsh-jobs` 导入类型，**不触及其任何被迁移的接口**，
  因此按现状声明 `compatible` 并在 `devDependencies` 钉到 `0.2.2-alpha.2` 实测
  （typecheck + 1314 测试全绿，仅 package-contract 表因 dshReleases 登记而先行更新）。
  `dshReleases` 表 25 → 27 个版本；`@deepseek-ai/cordis` peer 扩为
  `^4.0.5-alpha.2 || ~4.0.6-alpha.1`（0.2.2-alpha.2 要求 `~4.0.6-alpha.1`）。

### Fixed

- （无；本批为纯新增 + 兼容性维护。）

测试：套件 **1314 passed / 0 failed / 0 skipped**（`npm test`，`tsx --test`）；
`test/report.test.ts` 新增 5 条 JSON 用例（完整模型、发现证据字段、junk 输入容错、
工具层 `json` 渲染、`.iterate/report.json` 持久化）；`npx tsc --noEmit` 与
`npm run typecheck` 干净；`npm run build` / `build:client` 同步重建 `dist/` 与 `lib/client.js`。

## [3.10.0] - 2026-10-25

写侧翻转（双向集成场景③的 TS 半边）。这一批改了**落盘格式**并新增一个运行时依赖，
按语义化版本是一次 minor，不是补丁。

### Changed

- **`.iterate/decision-log.jsonl` 写出去的就是内核的哈希链条目**，不再是本插件的私有形状。
  行的字节即条目的规范形式，`prevEntryHash = sha256(上一行)`，创世为空串；可选字段**缺席而不是
  null**（一个 `"dimension": null` 会改字节、改摘要，两个生态就会把同一段历史迁成两条不同的链）。
- **kind 的合法性改成内核的语法**（`DECISION_KIND_PATTERN` 从 `iterate-kernel/decision-log-entry`
  **导入**而不是重述）。本插件原来的 10 项固定清单与 Python 侧的 8 项清单之争到此结束：
  `KNOWN_DECISION_KINDS` 现在只出现在说明文字里，不再裁决任何一次写入。
- **`prune` 不再重编号。** 一条哈希链不能"整理"：删一行或改 `sequence` 会作废其后每一行的
  `prevEntryHash`。旧的改写路径被移除，并点名两条合法动作；链开始之后混进 legacy 行＝
  **contested**，由 `archive` 走人工选择的归档重启（重命名为 `…contested-<stamp>.jsonl`，0600）。
- 新增运行时依赖 `iterate-kernel@0.1.9`（精确版本，与 `js-yaml` 同一条纪律），`package-lock.json`
  随之；`dist/` 与 `src/` 同步重建。
- **peer 兼容性追到 `@deepseek-ai/*@0.2.1-rc.3`**（上游 10-23 发布：新增左/右栏「更多」菜单、
  会话切换不再丢未发送草稿、DeepSeek API Key 适配器对齐账号登录的模型列表更新方式）。
  全部是宿主侧 UI 与流程修正，无插件面 API 变动；`dshReleases` 表同步登记 rc.3。

### Fixed

- **一条原本不可能失败的对照**：`archive-and-restart … at 0600` 断的是归档文件的模式，而被重命名
  的那份台账本来就是 0600——那句 `chmodSync(archive, 0o600)` 没有任何测试驱动它。测试里先把台账
  建成 0644 再归档；主代理独立复算过因果：摘掉那句 chmod，**这条具名用例变红**，装回后 86/86。
- 补上"可选字段缺席而不是 null"此前**零覆盖**的一条，同时钉住 payload 里那个非法 dimension id
  不会被升级成条目级字段。

测试：套件 **1314 passed / 0 failed / 0 skipped**（`npm test`，`tsx --test`；此前 1281），
`test/decision-log.test.ts` 45 条，`npx tsc --noEmit` 与 `npm run typecheck` 干净。
变异电池（每条都必须让**具名**用例变红，之后按 sha256 核回源文件）：创世 prevHash 改成常量、
contested 判定恒 null、kind 截到 32、pattern 本地重述成 `{0,63}`、归档不 chmod、备份写成 0644、
`.iterate` 建成 0755、draft 带显式 null。

## [3.9.2] - 2026-10-18

Patch release: completing the unlocked read-modify-write sweep. Tests: 1280 → **1281**.

### Fixed

- **`markFixRolledBackInTranscript` performed an unlocked read-modify-write.**
  A rollback re-read `.iterate/transcript.json`, rehydrated it and wrote it back
  with no cross-process lock — the same class of lost update fixed for
  `iterate_transcript nudge` in 3.9.1 (two concurrent rollbacks each read the
  same base and the second write silently discarded the first's flag). It now
  takes the shared `transcript` lock, held across the awaits. `appendLive`'s
  byte-capped activity feed remains deliberately lock-free: it is an
  append-only, self-healing projection where a per-event cross-process lock
  would risk a bounded-wait stall on the tool-call hot path.

## [3.9.1] - 2026-10-18

Patch release: a full implementation audit of the plugin surfaced 11 concrete
defects (concurrency, silent data loss, boundary handling, report correctness),
all fixed here with a regression test each. No new user-facing feature.
Tests: 1262 → **1280**.

### Fixed

- **The cross-process transcript lock was released before the read-modify-write
  finished.** `iterate_transcript nudge` passed an `async` callback to the
  *synchronous* `withProjectLock`, whose `finally` released the lock the moment
  the callback returned its pending promise — i.e. at the first `await` — so two
  processes could still overwrite each other's steering text. `withProjectLock`
  now holds the lock until a promise-returning callback settles (sync callers
  are unchanged).
- **`nudge` / rollback re-persist silently erased the run's top-level findings,
  phase breadcrumbs and round marker.** `rehydrateBuilder` rebuilt the per-round
  threads but never the global findings list, `phases`, or a `round` that
  outran the captured rows — so one nudge blanked the observatory findings tab
  and the stage tracker. It now replays `phases`, refills the global findings
  (new `ReviewTranscriptBuilder.restoreFindings`) and advances the round marker;
  a `null` round/thread row is skipped instead of discarding the whole manifest.
- **A freshly created lock could be stolen from its live holder.** The
  create→stamp window left the lock file empty, and `Number('') === 0` read as a
  dead owner, letting a contender unlink a live lock and enter the same critical
  section. An unparseable pid stamp now falls back to the mtime staleness test
  instead of an immediate steal.
- **`runGit` rejected instead of degrading** when `execFile` threw
  synchronously (e.g. a NUL byte in a config-supplied branch name); it now
  resolves a structured failure so `iterate_review` cannot crash on it.
- **Session-record hardening:** a future fractional record version (`1.9`) is no
  longer floored down to the accepted current version, a failed/absent
  `@deepseek-ai/dsh-session` import is no longer memoized for the whole process
  (the next call retries), and the record's `qualityStatus` is now actually
  populated from the current quality gate.
- **Report correctness:** SARIF `executionSuccessful` no longer counts an
  unknown (`null`) validation exit code as a failure; the Markdown report now
  emits the location for line 1 and floors a fractional line (a valid SARIF
  `startLine` instead of `1.5`); and a missing/empty transcript no longer renders
  as a live "running" run.

### Changed

- Internal only: `withProjectLock` gained a promise-returning overload,
  `ReviewTranscriptBuilder` gained `restoreFindings`, and `session-record.ts`
  gained a test-only module-loader seam. Public tool surfaces are unchanged.

## [3.9.0] - 2026-10-18

### Added

- **Session-linked run records** (`iterate_transcript` `recall`). Adopted the
  dsh `0.2.1-rc.1` **Session state-record API** (`appendPluginRecord` /
  `pluginRecordOf` from `@deepseek-ai/dsh-session`):
  - `capture` appends a compact, ignorable `plugin:iterate/run` record to the
    dsh session log and returns `sessionRecord` (the session-linked copy of the
    run's converged state);
  - `recall` lists this session's run records (newest first) so a run stays
    traceable after `.iterate/` is wiped;
  - `read` **recovers a summary manifest** (`recovered:true`) from the newest
    run record when `.iterate/transcript.json` is missing or malformed.
  - Fail-safe by construction: lazy dynamic `import()`, structural typing, and
    a `supported:false` degradation on hosts without the API; a best-effort
    record write never fails a capture.
- **`iterate_report` tool + observatory report export.** One shared,
  dependency-free data model (`src/report-render.ts`, imported by both the tool
  and the client bundle so they can never drift) renders:
  - `format:"markdown"` — a PR-pasteable run report (header, quality gate,
    findings, fixes, validations, defense events, experience bank);
  - `format:"sarif"` — a SARIF 2.1.0 log for CI / GitHub Code Scanning (one
    rule per review dimension, severity → error/warning/note, file+line
    locations, suggested fix attached).
  New observatory buttons **导出报告** (Markdown) and **导出 SARIF**
  (download-first, copy fallback) render the same model.

### Changed

- **Upgraded upstream dsh to `0.2.1-rc.2`** — devDependencies pinned to
  `0.2.1-rc.2` and `@deepseek-ai/cordis` to the stable `4.0.5` (the `~4.0.5`
  peer required by every `0.2.1-rc.2` package). `dsh.compatibility.dshReleases`
  now also declares `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`
  (24 releases, mirrored verbatim in both READMEs). `engines.dsh` is unchanged
  (`>=0.1.1-rc.1`).
- Added `@deepseek-ai/dsh-session` as an **optional** peer dependency (the
  session-record API), so installs on older hosts are unaffected.

## [3.8.0] - 2026-10-16

### Changed

- **Upgraded upstream dsh to `v0.2.1-alpha.4`** (released 2026-10-15) — all
  five `@deepseek-ai/*` packages pinned to the exact `0.2.1-alpha.4`, and
  `@deepseek-ai/cordis` moved to `4.0.5-alpha.2` (the `~4.0.5-alpha.2` peer
  required by every dsh package at alpha.4). `dsh.compatibility.dshReleases`
  now declares `0.2.1-alpha.3: compatible` and `0.2.1-alpha.4: compatible`
  (21 releases, mirrored verbatim in both READMEs).
  - **Adopted: the `engines.dsh` compatibility contract.** As of
    `0.2.1-alpha.4` the dsh runtime decides a third-party plugin's
    compatibility from `engines.dsh` when it is declared, ignoring
    `peerDependencies`; when it is absent the runtime falls back to checking
    the exact `@deepseek-ai/dsh-*` peer versions. The plugin now declares
    `engines.dsh: ">=0.1.1-rc.1"` (the same lower bound as the oldest
    `dshReleases` entry), so a current runtime loads the plugin without
    flagging the exact-pinned peer list; every host capability stays
    feature-detected. The peer versions are extended through `0.2.1-alpha.4`
    for earlier runtimes that still use the peer fallback.
  - **`0.2.1-alpha.3` / `0.2.1-alpha.4` are otherwise host-level releases** —
    Web sign-in, secret/token masking, minimal-mode image reading, `/compact`,
    plugin hot-reload, custom plugin index sources, and per-model
    reasoning-level UI. None expose a tool/agent/session API this plugin
    consumes (`defineTool`, `JsonValue`, `exec.*`, `tools/pre-execute`,
    `presentCall`), so no further adoption is required this cycle.

### Fixed

- **`iterate_config write` and `iterate_triage apply` were unlocked read-
  modify-write cycles.** Both wrote `iterate.config.yaml` by reading a base,
  merging, and writing back with no mutex — two sessions on the same project
  each read a stale base and the second merge silently discarded the first's
  update (lost update), and the backup/rollback chain only reflected the
  version each process had read. Both cycles now run inside the shared
  `withProjectLock(projectRoot, 'config-write', …)`, so the two writers are
  mutually exclusive and the lock spans read → merge → validate → backup →
  write → backup-prune.
- **`stoppedReasonLabel` could return an object instead of a string and crash
  the client.** The badge keyed off the manifest's `stoppedReason` with a
  plain object index (`zh[reason]`); a value of `__proto__` / `constructor` /
  `toString` resolves through the prototype chain to `Object.prototype` or a
  function — and the client rendered that return value as a React child,
  throwing `Objects are not valid as a React child` and taking down the whole
  observatory/dashboard. The label now requires an own-key hit
  (`Object.hasOwn`) before returning a table value, degrades any other value
  to a plain text label, and coerces non-strings; `iterate_transcript
  capture` also gained an `enum` guard on `stoppedReason` (defense for the
  seven documented values — the `Object.hasOwn` fix is the one that protects
  hand-edited manifests).
- **The cross-round comparison table's "已修复" column was always 0.**
  `buildRoundComparison` read `finding.status === 'fixed'`, but the review
  findings schema carries no `status` field, so the column never reflected
  anything. `fixed` is now counted from the transcript's applied fixes
  (`{ round, success }`, successful only) and the client passes the manifest's
  `fixes` — the column shows real data.
- **Stale config-edit copy contradicted the fail-closed contract.** The
  settings guide still told users that an empty validation result is treated as
  a pass; the actual contract aborts the run (`converged_unverified` /
  `aborted_by_config`, never a plain `converged`). The text now matches.
- **Triage-panel keyboard shortcuts silently died on the 2nd+ panel.** Every
  turn with a report mounts its own triage panel, but the keydown handler
  resolved `document.querySelector('[data-iterate="triage"]')` — only the
  first one — so y/n/a and ↑/↓ did nothing whenever focus sat in a later
  panel, with no indication. The handler now uses a per-instance ref.
- **Opening a session popped a stale "Round X 完成" pulse.** The dashboard
  effect keyed on the report hash fires on mount, so opening a session that
  already had a report emitted a completion pulse for work that did not just
  complete. The first report an instance sees is now recorded without a pulse;
  only a subsequent round progression pulses.
- **Review-prompt builder used a guarded `meta` and then dereferenced it
  unguarded.** `agent(base, { schema: meta.findingsSchema })` would have thrown
  on an undefined `meta` while the line above handled it gracefully; both sites
  now use `meta?.findingsSchema`.
- **A nudge with no manifest yet recorded `mode: 'normal'`.** Recording a
  concrete mode before `capture` would rewrite a dry-run run into a `normal`
  one in the status/badge until capture landed. The fallback now records
  `null` ("not captured yet"), matching the manifest-level rule. Checkpoint
  `mode` is also nullable now, so a hand-corrupted checkpoint is reported as
  unknown instead of silently labelled `normal`.
- **Lock release had a read-then-unlink TOCTOU, and the wait budget blocked the
  event loop for up to 5 s.** The release re-read the pid stamp and unlinked by
  path; a lock stolen from a live owner between the read and the unlink could
  be reassigned, turning our release into a double-release that admitted a third
  process into a "held" critical section. The acquisition now captures the
  created inode and the release verifies the inode is still the one at the
  path before unlinking. The bounded wait is 1000 ms instead of 5000 ms
  (healthy holders release in microseconds; the degrade-to-unlocked fallback is
  unchanged).
- **`decision-log.ts` hand-rolled a second copy of the project lock.** Its
  acquire/steal/wait/pid-alive/sleep logic duplicated `file-lock.ts` with a
  separate stale/wait parameter set that could drift. `acquireLogLockChecked`
  is now a thin wrapper over the shared `acquireProjectLockChecked` with lock
  name `decision-log` (`.iterate/.decision-log.lock`), keeping the
  `acquired` flag the prune rewrite needs.
- **The `changed-only` review scope admitted out-of-bounds symlinks.**
  `filterExistingFiles` used `existsSync`/`statSync`, which follow symlinks, so
  a git entry that is a link to a file OUTSIDE the project passed the path-only
  containment check and entered the scope. Every finding on it then failed the
  evidence gate (`file_not_found`) and was permanently `EVIDENCE_VIOLATION` —
  an unresolvable false positive for repos with dotfile or shared-config links.
  The scope now uses `lstatSync`/`realpathSync` and drops links whose real
  target escapes the project root.
- **`iterate_transcript nudge` and `iterate_checkpoint resume` were unlocked
  read-modify-writes.** A concurrent call in a sibling process could drop the
  other's steering text or lose the other's `resumeCount` increment. Both now
  serialize on the shared advisory lock (`transcript` / `checkpoint`).

### Tests

- 1219 tests (from 1216): `engines.dsh` contract (range + lower bound), the
  `fixed`-count wiring from transcript fixes, the `stoppedReasonLabel`
  prototype-key guard, and the nudge/checkpoint mode fallback. Typecheck clean
  across all three programs (server + tests + client), `dist/` and
  `lib/client.js` rebuilt in step with `src/`.

## [3.7.1] - 2026-10-15

### Fixed

- **DSH host modules moved out of `dependencies` into optional
  `peerDependencies`.** `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools` and
  `@deepseek-ai/dsh-util-values` are now declared as optional peers, so the
  `dsh` host's own copies are used instead of a second one installed alongside
  the plugin (a plugin-local copy makes `dsh` boot two module instances of
  Cordis / `dsh-tools` and fails the host preflight). The three stay pinned in
  `devDependencies` for local builds and tests, in lockstep with the newest
  `dsh.compatibility.dshReleases` entry; `js-yaml` remains the only runtime
  `dependency`.
- **`repository` / `homepage` / `bugs` repointed at the standalone plugin repo
  `jingzhao-l/iterate-plugin`** (no `directory` subpath), reversing the
  monorepo form adopted in `v3.3.1`. `npm-publish.yml` documents that
  `npm publish --provenance` requires the package's `repository` to match the
  Trusted Publisher repo (`jingzhao-l/iterate-plugin`), and npm-download
  registries link an npm package to a GitHub listing through that same field —
  pointing at `iterate-skill` with a `directory` path dropped both the
  provenance origin and the registry's npm-download link.

## [3.7.0] - 2026-10-13

### Changed

- **Upgraded upstream dsh to `v0.2.1-alpha.2`** (released 2026-10-09) — all
  five `@deepseek-ai/*` packages pinned to the exact `0.2.1-alpha.2`
  (`dsh-tools` / `dsh-util-values` runtime, `dsh-agent` / `dsh-jobs` /
  `dsh-session` dev); `@deepseek-ai/cordis` stays `4.0.5-alpha.1`.
  `dsh.compatibility.dshReleases` now declares `0.2.1-alpha.2: compatible`
  (19 releases, mirrored verbatim in both READMEs).
  - **Adopted: the mutable session working directory.** New
    `src/working-directory.ts` feature-detects `ctx.get('workingDirectory')`
    and resolves the project root from the *current* session directory — as of
    alpha.2 the immutable `Session.header.cwd` keeps the ORIGINAL project by
    design, so reading it after a directory switch would anchor reviews, fixes
    and the approval policy to the wrong checkout. Every failure mode (no
    service, throwing service, hostile getters, non-string result) falls back
    to `header.cwd`. Wired into `index.ts`, `config-loader.ts`,
    `session-hooks.ts` and `live.ts` (+14 unit tests, incl. a security case).
  - **Evaluated, not adopted**: the session state-record APIs (fragile
    private-field access to shell-owned records), the shared `AGENTS.md`
    agents directory (`DSH_AGENTS_HOME`, a host-level instruction concern), the
    experimental Git Worktrees plugin (unrelated to the plugin's own
    `git.use_worktree` config), the removed `both` tool-presentation mode (the
    plugin never set one — it renders `presentCall` cards), and installing the
    dsh CLI globally (disk cost for a plugin that never shells out).
- **Type-check split into three programs.** The root `tsconfig.json` stays
  server-only with a DOM-free `lib` (so a stray `window` in server code remains
  a type error), new `tsconfig.test.json` covers the test program with DOM
  (the render tests legitimately mount browser components), and
  `npm run typecheck` now runs server + tests + client.

### Added

- **Bilingual UI (简体中文 / English)** — new `src/client/i18n.ts` dictionary
  (≈290 keys) with `t()` / `tf()`; every piece of UI chrome in
  `src/client/index.ts` is localized (panels, empty states, observatory tabs,
  badges, severity/stop-reason/completion labels, settings). A
  **界面语言 / Interface language** card in Settings switches the language and
  persists it in `localStorage` (`iterate-ui-lang`); with no stored choice the
  language is detected from `navigator.language` (a stored choice always wins,
  and detection never writes a preference). Slot components are wrapped once
  at module scope (`withLang`) so a switch repaints without remounting and
  keeps panel state. **Model-facing copy stays Chinese by design** — the
  `build*Instruction` payloads and copy-paste guides are contract text mirroring
  `SKILL.md`; the two expanded guides now carry a
  「中文（粘贴给模型的契约文案）」 chip so an English reader is told why.
  - `lib/parse.js` UI labels gained an optional `lang` param (`zh` default):
    `stoppedReasonLabel`, `diskEmptyStateText`, `buildCompletionSummary`, and
    `CONFIG_EDIT_FIELDS` label/hint became `{ zh, en }` pairs (guide and
    instruction builders keep reading `.zh`).
  - Enforced by `test/client-i18n.test.ts` (12 tests): every Chinese literal in
    the client needs an English entry or an inline `{zh,en}` pair, no dead
    entries, `{aN}` placeholder parity between languages, and the
    detect/switch/persist behavior itself.
- **Config read-back loop (settings)** — the write instruction had no
  counterpart: new `buildConfigReadInstruction()` + `scanSessionForConfigRead()`
  + `configValueByPath()` in `lib/parse.js`, and the settings card now shows
  the **current value of the selected field** once the model echoes an
  `iterate_config` read (write results carry the post-write config too). Three
  states are told apart: not read back yet / the value / read back but the
  field is absent. New `src/client/session-cache.ts` carries the session from
  the session-scoped slots to the ROOT-scoped settings slot
  (`useSyncExternalStore`), because `settings.section` gets no session prop.
  A refused clipboard reveals the instruction for manual copy — the button is
  never a dead end.
- **Browser-half render coverage** (previously untestable — the client's
  `react` arrives through an injected `require`): `test/client-render.test.ts`
  boots `apply()` with a fake `ClientContext` inside jsdom and mounts every
  registered slot — bootstrap contract, degraded services, dashboard
  empty/running/report/converged states, triage panel, observatory
  compact→expanded tabs + F8 hotkey, settings cards incl. the destructive
  confirm, the config read-back states, and both languages (24 tests).
  devDeps added: `react` / `react-dom` `19.2.2`, `jsdom` `26.1.0`.
- **Bundle-integrity coverage** — `test/package-contract.test.ts` (16 tests)
  plus a recursive `scripts/client-digest.mjs` over `src/client/**` and
  `lib/parse.js`, so a stale committed `lib/client.js` / `dist/` fails the
  suite instead of shipping; `test/present-helpers.test.ts` (22 tests) covers
  the previously untested `present` helpers.

### Fixed

- **`isReviewReport` accepted a transcript manifest** (`typeof [] === 'object'`
  is `true`), so a running iteration rendered a bogus "Round 0 / 0" report
  strip instead of the running state — convergence must now be a non-array
  record (regression test in `test/parse.test.ts`).
- **Session scanners only read tool-call envelopes** — `scanSessionForTranscript`
  / `scanSessionForQualityGate` / `scanSessionForExperienceBank` /
  `scanSessionForDefenseEvents` now fall back to a deep scan
  (`findFirstInObject`) over the whole tree, so a restored transcript or a host
  that surfaces artifacts directly still fills the panels instead of claiming
  "not pulled yet".
- **Decision-log lock ownership** — `makeLockRelease` in `src/file-lock.ts`
  (used by `src/tools/decision-log.ts`) never removes a lock another process
  owns (+6 tests).

## [3.6.0] - 2026-10-06

### Changed

- **Upgraded upstream dsh to `v0.2.1-alpha.1`** (released 2026-10-03) — the
  four dsh packages `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-util-values`
  (runtime deps) and `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-jobs`
  (devDeps, plus `@deepseek-ai/dsh-session`) are all aligned on
  `0.2.1-alpha.1`, with `@deepseek-ai/cordis` at `4.0.5-alpha.1`.
  `dsh.compatibility.dshReleases` expanded to declare `0.2.0-rc.1` /
  `0.2.0-rc.2` / `0.2.1-alpha.1: compatible`. The `dshReleases` field in
  `package.json` is the single source of truth for release compatibility, and
  both READMEs now mirror it verbatim.

### Added

- **All 15 UX gaps implemented** (P0 / P1 / P2 from the read-only UX review):
  - **P0**: registered startup instructions — the empty dashboard's
    "复制启动指令" buttons now copy natural-language instructions
    (`START_INSTRUCTIONS`, test-locked) instead of a never-registered `/iterate`
    slash command; zero-verification preflight is fail-closed — empty
    `validation.commands` aborts before the loop (or runs an explicit
    `args.unverified` opt-in) and zero validate results are never treated as a
    pass (`validationUnavailable`; runs end `converged_unverified` /
    `max_rounds_unverified`, never a plain `converged`); F8 / F9 / F10 are
    wired into the workflow close-out (quality-gate `compute` after the
    report, `iterate_experience add` for verified fixes,
    `iterate_defense_events record` for rollbacks / defenses).
  - **P1**: disk-snapshot pull instruction — the read-side tools echo
    `.iterate/` artifacts into the session stream so the panels fill in a
    fresh session, and empty states distinguish "no data on disk" from "not
    pulled yet"; running-iteration dashboard state (round + phase chips while
    `active`, start buttons hidden); per-round `validations` captured into
    `iterate_transcript` and rendered in the UI; triage write-back closed loop
    (schema-aligned `iterate_triage apply` instruction is the primary button,
    plus an `iterate_triage list` readback); config-edit guide now covers
    `validation.commands` / `language` / `personalization.known_intentional`
    with an explicit "empty validation.commands = unprotected" warning, and a
    field picker generates the matching `iterate_config write` instruction;
    bilingual approval reasons; copy payloads aligned to the target tools'
    schemas (`iterate_fix` naming `content`/`round`, checkpoint resume without
    junk `maxRounds: null`, JSON-shaped F8 query).
  - **P2**: observatory export now includes `qualityGate` / `experienceBank` /
    `defenseEvents` / `report` alongside manifest + live; F2 cross-round
    comparison table (per-round findings / fixed / severity mix / validation
    outcomes); F1–F10 tab labels plus number-key shortcuts (`1-9` / `0` / `-`);
    README (EN + zh) and DESIGN doc sync (compatibility list, tab count, new
    "Using the UI in dsh" section, `iterate_history` filter surface).
- **`ask.displayReason` adoption** — the approval gate now returns dsh 0.2.x's
  `displayReason` (localized `en` / `zh` prompt text) alongside the structured
  machine-readable `reason`; human-facing text follows `language`, structured
  fields stay English.
- **`presentResult` / `presentCall` card completion** — review
  (plan / aggregate / meta-review), checkpoint, quality-gate, experience-bank
  and defense-events results render as dsh cards instead of raw JSON, sharing
  a new `src/tools/present.ts` helper (long lines clamped, no new card
  protocols).

### Fixed

- **~120 findings from a full code review (critical / major / minor)** —
  including: evidence-gate integer line-number handling; meta-review
  `ROUND_GAP` denial-of-service; strict `iterate.config.yaml` validation plus
  approval gating for `iterate_config write`; symlink-aware
  `resolveProjectRoot` folding (macOS `/etc` → `/private/etc`, symlinked
  session cwd); `iterate_prune` / checkpoint data preservation (no destruction
  of live data, `readdirSync` guards); transcript normalization and `validations`
  capture; atomic-write hardening and resource-release leaks. The unit suite
  grew from ~677 to **1100+ unit tests, all green** (typecheck clean).

## [3.5.7] - 2026-09-25

### Changed

- **Upgraded DSH runtime deps to `0.1.7-rc.2`** — `@deepseek-ai/dsh-tools` /
  `@deepseek-ai/dsh-util-values` (deps) and `@deepseek-ai/dsh-agent` /
  `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-jobs` (devDeps) moved from
  `0.1.7-rc.1` to `0.1.7-rc.2` (clean reinstall after removing the old
  lockfile + node_modules, which otherwise hit ERESOLVE on the stale rc.1 pin).
  `dsh.compatibility.dshReleases` now declares `0.1.7-rc.2: compatible`.
  **0.1.7-rc.2 assessment**: the rc.1→rc.2 diff is purely additive and
  non-breaking for the plugin — `dsh-tools` adds approval `ask.displayReason`
  localization; `dsh-session` adds a `toolHistory()` method + tool-history
  types. Neither surface is on the plugin's integration path (the approval gate
  returns plain-string reasons and never calls `toolHistory`), so no adoption
  is required.

### Fixed

- **Critical: both canonical workflow scripts crashed with a `ReferenceError`**
  — the dry-run and normal-mode scripts in `src/skill-prompt.ts` declared
  `const reviewersOk` INSIDE the `do { … }` block but read it after the retry
  loop exited, so every run (dry-run AND normal) threw
  `ReferenceError: reviewersOk is not defined` immediately after the first
  review round. Verified by executing the extracted scripts in a `node:vm`
  sandbox (both threw, the dry-run one at `const roundUnusable =
  schemaInvalid || !reviewersOk`). The variable is now hoisted (`let
  reviewersOk`) so the round-usable gate actually runs.
- **Normal-mode resume round accounting** — the canonical script indexed
  `rounds` with `rounds.length >= r` (fine from round 1, but wrong when
  resuming a checkpoint at `startRound > 1`: a schema-retried round would be
  pushed twice instead of replacing its slot, and `roundsExecuted` /
  `obsCheckpoint.round` / the `report` round under-reported the true last
  round). Replaced with a `roundSlot` cursor plus a `lastRound` counter so a
  resumed run reports its real round number (e.g. resuming at round 4 that
  converges immediately reports `roundsExecuted: 4`, not `1`).
- **Decision-log entry-count cache staleness** — the append-side
  `entryCountCache` (keyed by log path, assuming "same byte size ⇒ same entry
  count") was never invalidated when `iterate_prune` rewrote the log via
  temp+atomic-rename, so a rewrite landing on the same byte size would make the
  next `append` report a wrong `entryCount`. Added
  `invalidateLogCountCache()` and call it from the prune rewrite loop.
- **New unit tests** (677 total, +6): runtime execution of both canonical
  workflow scripts under a `node:vm` sandbox with stubbed `agent`/`parallel`
  globals — dry-run converges, normal fresh run converges + clears the
  checkpoint, a resumED run reports the true last round (the regression guard
  for the accounting fix), and a schema-retry path re-runs without corrupting
  round bookkeeping; plus a deterministic same-byte-size decision-log rewrite
  cache regression test.

## [3.5.6] - 2026-09-25

### Changed

- **Upgraded DSH runtime deps to `0.1.7-rc.1`** — `@deepseek-ai/dsh-tools` /
  `@deepseek-ai/dsh-util-values` (devDep sources) and `@deepseek-ai/cordis`
  pinned to `4.0.4`; devDependencies `@deepseek-ai/dsh-agent` /
  `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-jobs` moved to `0.1.7-rc.1`
  (clean reinstall; `dshReleases` already declared
  `0.1.7-alpha.1/alpha.2/rc.1: compatible`). **0.1.7 assessment**: the surfaces
  the plugin consumes (defineTool schema, `tools/pre-execute` cancel + deny.info,
  `tools/result`, `isConcurrencySafe`) are unchanged; the new 0.1.7 exports
  (scope-filtered dispatch, `tools/around`/`guard`/`post`, PTC mode, JSON-schema
  helpers, tools invariants) have no applicable plugin need this cycle — no
  adoption required.

### Added

- **reasoning_effort reaches the review plan** — `buildReviewPlan` now carries
  `reasoningEffort` (`'low' | 'medium' | 'high' | null`) derived from
  `config.reasoning_effort`, and injects an effort directive
  ("Reasoning effort for this review pass: …") into every dimension's reviewer
  prompt so the orchestrator can honor it per reviewer subagent. The
  configuration guide (`CONFIG_EDIT_FIELDS`) surfaces the key with a
  `low/medium/high` hint, and `iterate_config` write validation already
  accepted only those values. The plugin never touches the provider request
  body directly.
- **Chinese badges for the schema-retry stop reasons** — `stoppedReasonLabel`
  moved to `lib/parse.js` (shared single source of truth between the client
  observatory badge and Node tests) with labels for `inconclusive` /
  `schema_invalid` / `no_usable_reviewer_output`; previously these rendered as
  raw English in the badge.
- **New unit tests**: `MAX_FIX_CONTENT_CHARS` guard (oversized content rejected
  before any disk write), `registerLiveCapture` tools/result wiring, lock
  release for the decision-log advisory lock, `iterate_decision_log` append/read
  e2e, `resolveProjectRootForExec` tri-path, `runGit` success/failure, runCommand
  spawn-failure non-throw, `stoppedReasonLabel` mappings,
  `buildReviewPlan.reasoningEffort` carry-through + defensive out-of-range
  value.

### Fixed

- **Step-3 review round-up (8 items)**: review fold of over-cap rounds into the
  last slot; meta-review clamp for fold-round indexes; integer line normalization
  in the transcript; `'other'` overflow thread for reviewer-start caps; restore
  of dropped transcript threads on rehydrate; evidence line-number integer gate;
  config-loader project-root realpath collapse (+ symlink-safe `resolveProjectRoot`
  contract); prune checkpoint age gate — a FRESH checkpoint is a resume point and
  is now kept (`checkpointStale`), stale ones are swept and reported
  "yes (stale)"; checkpoint `interrupted` freshness semantics (exists but nothing
  new in the decision log); decision-log/history order fix (doc corrected to
  "newest window in chronological order", code unchanged); `iterate_config` write
  validation branches for `reviewer` and `reasoning_effort`; schema-retry loop
  fixes in the skill prompt (dry-run convergence gate, normal-mode
  `schema_invalid` stop reason, bounded `maxRounds` pass-through).
- **Theme listener cleanup (client)** — `registerThemeListener` tolerates a
  `ctx.on` that returns no unsubscribe handle (`void | (() => void)`) instead of
  misassigning a `void`; duplicate-definition removal ensured a single
  `stoppedReasonLabel` source in the client source.
- **Transcript/status docs now list the extended stop reasons** —
  `iterate_transcript` `stoppedReason` description includes
  `schema_invalid` / `no_usable_reviewer_output` / `inconclusive` /
  `aborted_by_config`, matching what the skill prompt can emit.

## [3.5.5] - 2026-09-22

### Changed

- **Upgraded DSH runtime deps to `0.1.6-alpha.2`** — `@deepseek-ai/dsh-tools` /
  `@deepseek-ai/dsh-util-values` (deps) and `@deepseek-ai/dsh-jobs`
  (devDep, `^0.1.6-alpha.2`) plus `@deepseek-ai/dsh-agent` /
  `@deepseek-ai/dsh-session` (devDeps) moved from `0.1.6-alpha.1` to
  `0.1.6-alpha.2`. Diff vs alpha.1 is non-breaking for the plugin (tool/agent/
  jobs types untouched; dsh-util-values only adds `WeakMapWithValues`;
  dsh-session only adds a `workspace/changes` event type this plugin does not
  consume). `dsh.compatibility.dshReleases` now declares
  `0.1.6-alpha.2: compatible`.

### Fixed

- **Decision-log cross-process rewrite race (F19)** — the prune rewrite
  (temp + atomic rename) could silently discard an audit line appended by a
  concurrent process whose fd was bound to the pre-rename inode. `append` and
  the prune rewrite now serialize on a tiny advisory lock file
  (`.iterate/.decision-log.lock`, exclusive-create + pid stamp + stale steal
  with `process.kill(pid,0)` liveness and mtime timeout, `Atomics.wait`
  backoff). Contention timeouts degrade to "proceed unlocked" — never a crash —
  and the lock file is not swept by `iterate_prune` (guards a live append).
- **Decision-log append count no longer re-reads the whole file per append
  (F10)** — a size/count cache keyed by log path collapses the count to a +1
  when the file is byte-identical to our last append; falls back to a full
  re-count only when stale. Large sessions no longer pay an O(n) re-read per
  audit write.
- **Audit-trail write failures are surfaced, not dropped (F2)** — `iterate_fix`
  and `iterate_rollback` now return a `warning` field carrying a decision-log
  append failure (the mutation still succeeds); `iterate_prune` pushes it into
  `result.errors`. A silent audit miss can no longer masquerade as recorded.
- **Content-identical no-op fixes are rejected (F1)** — a fixer that re-sends
  the file unchanged (same `added===0 && removed===0`) now fails with
  "no changes … apply a real edit" instead of burning a backup, a write, and a
  registry/success record; `force:true` does NOT bypass the guard, and the check
  sits after the "already fixed this run" registry check so duplicate resends
  keep their existing message.
- **Hostile-input hardening (F12 and friends)** — YAML **array roots** are
  rejected everywhere a mapping is expected (`loadConfig` /
  `validateConfig` returns `['root']`, `config-write readRawConfig`, triage
  `readConfigFile`) so a `- foo` list never masquerades as a config object;
  `resolveProjectRoot` treats a non-string `path` input as "no explicit path"
  (no crash on `.trim()`); `verifyFinding` fails closed as `file_not_found` for
  null/non-object findings and non-string `file` (no ERR_INVALID_ARG_TYPE, and
  an empty '' resolves to the root so it is reported as not-found rather than
  line_out_of_range); `sortFindings`, `meta-review` dimension scan and final
  report all tolerate null list elements.
- **`normalizePath` no longer folds a leading `../..` traversal into a bare
  filename** — consecutive leading `..` segments are preserved (mirrors Python
  `os.path.normpath`), so `../../evil.ts` stays scoped OUT of a changed-only
  review inventory instead of leaking in as `evil.ts`.
- **NUL-mode git scope no longer corrupts whitespace filenames** — `git diff
  --name-only -z` emits exact names, so `parseChangedFiles` drops the `.trim()`
  in NUL mode; a name that legitimately starts/ends with a space survives.
  `runGit`/`resolveChangedFiles` also accept an optional `AbortSignal`.
- **Atomic writes clean up temp files on write failure too** — `writeTextAtomic`
  / `writeTextAtomicAsync` previously only cleaned the temp when the *rename*
  failed; a failing `writeFileSync`/`writeFile` now also removes the partial
  temp before propagating.
- **Config numeric bounds + backup accumulation bound** — `iterate_config`
  rejects absurd `max_rounds` (>100), `atomic.max_lines` (>10000) and
  `atomic.max_adjacent_methods` (>200) as a config-bomb guard; each successful
  demonstrated write prunes to the newest 5 `iterate.config.yaml.bak-*`
  snapshots so a long-lived project never collects an unbounded backup pile.
- **Live feed appends are serialized in-process** — the byte-cap trim
  (read+rewrite+append) is a read-modify-write; concurrent `tools/result`
  captures could interleave and one rewrite would drop the other's fresh line.
  Appends now chain on one module-level promise queue.
- **Transcript finding caps are enforced with newest-wins eviction** — per-thread
  findings cap at `MAX_FINDINGS_PER_THREAD` (100) and the global list at
  `MAX_FINDINGS_TOTAL` (2000), both dropping the OLDEST entries, matching the
  documented "newest wins" contract instead of the previous rebuild that could
  keep stale oldest findings. Decision-timeline payloads are deep-cloned on
  ingest so a caller mutating its own object can never alias into the manifest.
- **`ctx.jobs` reads are Proxy-safe** — the dsh plugin context can be a Proxy
  whose `jobs` getter throws when no registry is present; `runWithJob` now
  degrades to plain execution instead of crashing the tool call.
- **Named-file injection in the fixer prompt** — file paths interpolated into
  the built `iterate_fix` / `iterate_diff` instructions are now
  `JSON.stringify`-quoted instead of hard-quoted, so a path containing a quote
  or backslash can no longer break out of the instruction text.

### Fixed (UX parity)

- **Observatory `stoppedReason` badge now renders the stop reason** —
  `lib/parse.js normalizeTranscript` dropped `stoppedReason` on the floor, so a
  run that converged / hit the round cap / aborted showed a bare "已结束". It is
  now carried through to the client badge label (converged / max_rounds_reached
  / aborted_by_validation / aborted_by_config), matching the 3.5.4
  stopped-reason feature's intent.

## [3.5.4] - 2026-09-18

### Changed

- **Upgraded DSH runtime deps to `0.1.6-alpha.1`** — `@deepseek-ai/dsh-tools` /
  `@deepseek-ai/dsh-util-values` (deps) and `@deepseek-ai/dsh-jobs` /
  `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-agent` (devDeps) moved from
  `0.1.5-rc.2` to `0.1.6-alpha.1` (dsh-jobs peer requires dsh-agent, so the
  agent runtime is now a declared devDependency), with a clean reinstall.
  `dsh.compatibility.dshReleases` now declares `0.1.6-alpha.1: compatible`.
- **Adopted `0.1.6-alpha.1` `PreToolDecision.cancel` + `deny.info`** in the
  approval gate (`src/session-hooks.ts`) — a destructive iterate call whose
  caller already aborted before dispatch now resolves to the canonical
  `{kind:'cancel'}` (never prompting for consent or running `next()`'s allow on
  a dead request), and every policy denial now carries structured
  `ToolErrorInfo` (`name: iterate-approval-gate`, `code: APPROVAL_DENIED`, plus
  the human-readable `reason`) so durable projections can route it distinctly
  from a normal tool failure.
- **Schema-validation retry is now bounded (skill-prompt)** — the two `do…while`
  reviewer-retry loops (dry-run and normal modes) incremented a `retries`
  counter only while `< 2` but looped while `<= 2`, so the 3rd pass stayed true
  forever: a persistently schema-invalid reviewer output caused an INFINITE
  loop. Both loops now use an unconditional attempt counter and exit after 3
  attempts, logging a visible "still schema-invalid — round inconclusive" line
  (never reporting a broken round as a clean convergence).

### Added

- **`stoppedReason` in the observatory manifest** — `iterate_transcript
  capture` accepts an explicit `stoppedReason` (`converged` /
  `max_rounds_reached` / `aborted_by_validation` / `aborted_by_config`), and
  derives `converged` / `max_rounds_reached` when omitted; the builder/finish
  persist and rehydrate it; the client observatory badge now renders the reason
  (`已收敛（无新发现）` / `达到轮数上限` / `验证失败后回滚停止` /
  `验证命令不在白名单（配置需修复）`) instead of a bare "运行中" for dead runs.
- **Checkpoint/transcript consistency on validation abort** — the normal-mode
  final transcript no longer records `checkpoint: null` for an aborted run;
  since the checkpoint is intentionally left on disk for resumption (F5), the
  transcript now mirrors the on-disk checkpoint so the panel and the resume
  affordance agree.
- **Config-gap validation abort (UX-5)** — the normal-mode validator schema now
  carries `allowed` + `rejectReason` from `iterate_validate`. A command NOT in
  `validation.commands` (`allowed:false`) is a config gap, NOT broken code: the
  run aborts WITHOUT rolling back the round's fixes and reports
  `configErrors` + `aborted_by_config` so the user can fix the trust list.
  Real command failures still roll back via `iterate_rollback` as before.

### Fixed

- **Normal-mode round counter stuck at 1 in the client** (lib/parse.js) —
  `getCurrentRound` / `computeConvergenceProgress` used `report.rounds.length`,
  but normal-mode aggregates ship ONLY the live round (one element), so a run
  on round 3 displayed "Round 1". Both now use the highest per-round `round`
  number (correct for both normal single-round and dry-run cumulative reports),
  with array-length fallback for missing round fields.
- **Defense/experience concurrency + store semantics** — `captureTool` writers
  now declare `isConcurrencySafe` on the store mutation paths; the
  experience/defense stores apply field spreads AFTER the defaults/normalizers
  so hand-edited values cannot clobber invariants; adding an entry with an
  explicit `id` updates that entry (documentation contract "update a specific
  entry via add") while hitCount/timestamp/lastHitAt always stay store-owned;
  deterministic ids are derived for `iterate_defense_events newest-first`
  sorting and hand-edited malformed entries.
- **Meta-review changed-only coverage** mirrors the plan fallback — when
  `review.scope: changed-only` yields an empty diff, `meta-review`'s
  coverage-gate now falls back to a full review inventory exactly like the plan
  phase does (integration-tested against a real git repo, including a
  git-unavailable fallback).
- **Transcript nudge fallback preserves run identity** — a malformed persisted
  manifest no longer loses `mode`/`taskMode`/`goal`/`maxRounds`; a missing
  manifest still defaults to a fresh normal-mode run.
- **`iterate_triage` backup cap** — `pruneOldConfigBackups` keeps only the
  newest `MAX_TRIAGE_BACKUPS` config backups (documented behavior) instead of
  never removing the timestamps.
- **Prune sweeps** — `sweepExperienceBank` / `sweepDefenseEvents` keep the
  newest `MAX_EXPERIENCE_ENTRIES` / drop old defense events and recompute
  counts, wired into the inspect/execute/render paths.
- **Decision-log rewrite TOCTOU** — pruning the decision log now re-reads and
  compare-and-appends for any concurrent fresh entries, with a bounded retry
  (`MAX_LOG_REWRITE_RETRIES = 3`); a rewrite that races a new entry no longer
  silently drops it.

### Tests

- Added 34 tests: bounded schema-retry termination is prompt-level; parse round
  counter (single-round normal, gapped cumulative, missing-round fallback);
  transcript `stoppedReason` (explicit/derived/empty, rehydrate preservation,
  capture tool round-trips); session-hooks `cancel` (pre-dispatch abort
  short-circuits, live calls unaffected) + `deny.info` structure; meta-review
  changed-only coverage with a real git repo; defense/experience concurrency +
  deterministic ids + explicit-id update + forged metadata; triage backup cap;
  prune sweeps + decision-log rewrite; nudge identity fallback; context
  `skillDir` realpath resolution (environment-independent assertions). 610 tests
  total, typecheck + typecheck:client + build + build:client clean, full suite
  green.

## [3.5.3] - 2026-09-16

### Added

- **`iterate_defense_events` `clear` operation** — reset the persisted
  `.iterate/defense-events.json` stream so a fresh iteration does not carry
  stale defensive data (mirrors `iterate_quality_gate clear` /
  `clearQualityGate`). The store helper `clearDefenseEvents` reports `existed`
  and is idempotent; the tool returns the fresh empty counts and renders a
  clear-summary card.
- **Observatory client actions for the previously-unreachable reset ops** —
  F5 checkpoint now offers a danger-styled **清除断点** copy-to-command button
  (`iterate_checkpoint {operation:"clear"}`), F8 quality gate a **清除门禁**
  button (`iterate_quality_gate {operation:"clear"}`), and F10 defense events a
  **清除事件** button (`iterate_defense_events {operation:"clear"}`). Settings
  status guide (`buildRuntimeStatusGuide`) now documents all three reset ops
  alongside `iterate_prune`.

### Fixed

- **Transcript builder unbounded-array OOM** (src/transcript.ts) —
  `roundStart(1e9)` / `snapshotConvergence(1e9)` preallocated arrays of that
  size from model-authored JSON (a resumed/malformed round number); both are
  now clamped to `MAX_ROUNDS` (1000) so a single hostile value cannot OOM the
  host. `fix()`/`decision()` also reject NaN round numbers.
- **Transcript tool round/NaN guards** (src/tools/transcript.ts) —
  `captureRound`/`normalizeCheckpoint`/`normalizeFix` used `round <= 0` gates
  that NaN values (for which both comparisons are false) slipped through to
  collapse a malformed round into round 1. All now use `Number.isFinite`.
- **Transcript nudge/capture disk-failure handling** — `nudge` and `capture`
  awaited `persist(...)` unguarded, so a permission/disk-full failure rejected
  the whole tool call. Both now go through `persistChecked` and return the
  structured `{ok:false, error}` contract like every other write op; `nudge`
  also degrades to a fresh builder when a parsed-but-malformed manifest would
  make `rehydrateBuilder` throw.
- **Store-level normalization for hand-edited files** — `readDefenseEvents`
  now shape-normalizes every event (string timestamp / finite round / valid
  severity) so the list's `b.timestamp.localeCompare(...)` sort can never throw
  on a missing timestamp; `readExperienceBank` normalizes entries (arrays for
  `files`/`tags`, finite `hitCount`, valid severity, `totalHits` coerced) so the
  render's `.join(', ')` and the search spread can never throw; `readRegistry`
  now drops records lacking `id`/`finding` so `findFixRecord` /
  `recordsForFile` / `iterate_diff` can never crash or sum NaN.
- **Numeral hardening in summaries** — `computeStatus` /
  `summarizeFixRegistry` / the `iterate_diff` accumulation coerce registry
  counts so a hand-edited round missing `fixedCount`/`failedCount` stays finite
  instead of emitting NaN.
- **`iterate_config` write on a fresh project** (src/tools/config.ts) — a
  partial update like `{max_rounds: 5}` previously failed schema validation
  with a misleading "missing goal" because the merge base was `{}`. It now
  merges against the built-in defaults when no `iterate.config.yaml` exists, so
  the documented partial-update contract works out of the box (and materializes
  a complete, default-merged config file).
- **`validateCheckpoint` round cap** (src/tools/checkpoint.ts) — a save with
  `round > maxRounds` is rejected instead of persisting an inconsistent
  `Round X / Y` state; `readCheckpoint` also normalizes hand-edited numeric
  fields (string `maxRounds`, missing counts) and caps the persisted `findings`
  payload; `prune` no longer throws when `.iterate/fixes` or `.iterate` exists
  as a non-listable entry (`readdirSync` guarded); the quality gate now reports
  `pending` (not FAIL) for an empty review with nothing to gate, and
  `iterate_quality_gate`/`iterate_defense_events` list language falls back to
  `en` for a non-zh/en config `language`.

### Tests

- Added 23 tests: transcript round-cap OOM guard + NaN round handling; nudge
  malformed-manifest survival + structured persist failure; defense-store
  clear + normalized hand-edited streams + clear tool round-trips; experience
  store normalization/search guards; registry malformed-round normalization;
  checkpoint round(>max) rejection + hand-edited normalization + findings cap +
  NaN registry coercion; history count coercion; prune non-listable paths;
  quality-gate empty-review `pending`; config-write partial update on a fresh
  project. 576 tests total, typecheck + typecheck:client + build + build:client
  clean.

## [3.5.2] - 2026-09-13

### Changed

- **Upgraded DSH runtime deps to `0.1.5-rc.2`** — `@deepseek-ai/dsh-tools`,
  `@deepseek-ai/dsh-util-values` (deps) and `@deepseek-ai/dsh-jobs`,
  `@deepseek-ai/dsh-session` (devDeps) moved from `0.1.2-rc.1` to `0.1.5-rc.2`
  so the plugin aligns with the current harness release. Verified in a clean
  sandbox: typecheck against the rc.2 type declarations passes unchanged and
  the full test suite passes; the plugin does not reference the renamed
  `tool/ptc-dispatch-*` events. `dsh.compatibility.dshReleases` now declares
  `0.1.5-rc.2: compatible`.

### Fixed

- **`resolveProjectFile` symlink escape via nonexistent target** (fix.ts) —
  symlink containment only ran when the target file existed, so a fix creating
  a NEW file under a symlinked parent directory could write outside the
  project root. The containment check now walks up to the nearest existing
  ancestor (stopping at the harness-provided project root) and validates its
  real path.
- **Non-atomic restore in `iterate_rollback` and fix compensating-restore**
  (fix.ts) — rollback and the registry-write-failure rollback used raw
  `copyFileSync`, which could leave a truncated source file on crash. Both now
  restore via `writeTextAtomic`, matching the atomic-write guarantee used
  everywhere else.
- **`skillDir` arbitrary-path content injection** (context.ts) — the
  model-controlled `skillDir` argument was honored for ANY existing directory,
  letting e.g. `/etc` contents be injected wholesale into the review context.
  New exported helper `isAllowedSkillDir` only honors it when its real path
  (symlinks resolved) sits inside the project root or the plugin directory.
- **Decision-log structural validation** (decision-log.ts) —
  `readDecisionLogDetailed` now rejects parsed-but-malformed lines (non-object
  JSON or entries missing `timestamp`/`type`) as `invalidLines` instead of
  letting them flow into entries, where a missing `timestamp` previously made
  prune retention comparisons never fire (bad entries could never be pruned).

### Tests

- Added 12 tests: symlink-escape rejection (existing target, new-file parent),
  plain nonexistent in-project paths accepted, atomic registry-failure restore,
  decision-log structural validation (malformed shapes counted, legacy entries
  kept), and `isAllowedSkillDir` acceptance/rejection incl. symlinked dirs.

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
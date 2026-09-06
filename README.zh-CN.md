# iterate-plugin for DeepSeek Harness (dsh)

> dsh 桌面端的 iterate 质量指挥中心 + 经验银行插件（v3.2）。把 iterate 生态的同一套 review/fix loop 直接搬进 dsh 界面，新增质量门禁、经验银行、防御事件流与原生指挥操作。

<p align="center">
  <a href="README.md"><strong>English</strong></a> ·
  <a href="README.zh-CN.md"><strong>简体中文</strong></a>
</p>

> **开发与评审在 [iterate-skill 主仓库](https://github.com/jingzhao-l/iterate-skill) 完成**：插件代码由主仓库统一维护，通过 `git subtree` 同步到本仓库；**版本发版与 npm 发布在本仓库（插件仓库）进行**，作为 dsh 生态的正式发布位。欢迎 **star / fork 主仓库** 并在 [主仓库 Issues](https://github.com/jingzhao-l/iterate-skill/issues) 反馈问题。

<p align="center">
  <a href="https://github.com/jingzhao-l/iterate-plugin"><img src="https://img.shields.io/github/stars/jingzhao-l/iterate-plugin?style=social&label=Star" alt="Stars"></a>
  <a href="https://github.com/jingzhao-l/iterate-skill"><img src="https://img.shields.io/github/stars/jingzhao-l/iterate-skill?style=social&label=主仓库%20Star" alt="主仓库 Stars"></a>
  <a href="https://www.npmjs.com/package/iterate-plugin"><img src="https://img.shields.io/npm/dt/iterate-plugin?label=Downloads&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow" alt="License"></a>
  <a href="https://github.com/jingzhao-l/iterate-plugin/releases"><img src="https://img.shields.io/github/v/release/jingzhao-l/iterate-plugin" alt="GitHub release"></a>
</p>

> ⭐ 如果这个插件对你的 dsh 工作流有帮助，欢迎为主仓库点亮 Star，这是对开源维护最大的支持！

---

## iterate 生态一览 / The iterate Ecosystem

**iterate 不是一个独立的工具，而是一套附着在现有 AI 助手之上的技能生态。** 它不会替换你的 IDE 或 AI 工具，而是在你已有的工作流里，叠加一层"严格的代码收尾与把关"。整个生态由**三个可互换组件构成，共用同一套 `iterate.config.yaml` 与同一套 9 维度审查体系**：

- **[Core Skill + CLI / 核心技能与命令行](https://github.com/jingzhao-l/iterate-skill)** — 可移植 AI 技能 `/iterate` + `iterate` CLI。在 Trae / Claude Code / Cursor / Copilot / Codex 等 25+ 助手中以对话方式进行多轮迭代。
- **[iterate-harness / 无头引擎](https://github.com/jingzhao-l/iterate-harness)** — 独立无头引擎，命令 `ih`（npm: `iterate-harness`）。在终端 / CI / Git 钩子里**脱离对话式助手**，运行同一套闭环。
- **iterate-plugin / dsh 桌面插件（本仓库）** — dsh 桌面客户端插件（npm: `iterate-plugin`）。把 harness 运行时**直接接入 dsh 界面**：收敛看板、分诊面板、轮次进度，均以原生 dsh 控件形式展示。

三者关系：**Core Skill** 是最通用的跨助手审查/修复引擎（"大脑"）；**iterate-harness** 是同一引擎封装为无头 CLI + WebUI，适合跑在无需交互的场景；**iterate-plugin**（本仓库）把 harness 运行时进一步封装为 dsh 插件，直接在 dsh 桌面客户端内渲染分诊 UI 与收敛看板。配置（`iterate.config.yaml`）与 9 维度审查体系**三者完全一致**——理解其一，即可举一反三。

生态其余组件的快速安装/入口：

```bash
# Core Skill + CLI（一键安装到 25+ AI 编程助手）
npx iterate-skill-installer

# iterate-harness：无头引擎（npm 包装器，最简）
npm install -g iterate-harness
curl -fsSL https://raw.githubusercontent.com/jingzhao-l/iterate-harness/main/scripts/install.sh | bash
ih iterate init && ih iterate review

# iterate-plugin：dsh 桌面插件（本仓库，安装命令在下文「安装」一节重复列出）
dsh plugin --profile web add iterate-plugin
```

> 本文档从下一节开始聚焦 **iterate-plugin（本仓库）**。核心技能文档见 [iterate-skill 主仓库](https://github.com/jingzhao-l/iterate-skill)，无头引擎文档见 [iterate-harness 独立仓库](https://github.com/jingzhao-l/iterate-harness)。

---

## 这是什么 / About This Plugin

**iterate** 是一个让 AI 编程助手具备多轮自主代码审查与修复能力的开源项目。它解决很具体的痛点：

> AI 助手往往"说得多、做得浅"：一次对话只改几行、看过一个文件就不再管全局，也很少回头复核自己改坏的东西。iterate 把这些收尾工作——逐项审查、分维度排查、修复、验证、再迭代——自动化，让 AI 真正像资深工程师一样把改动做完、做对。

`iterate-plugin` 是 [iterate](https://github.com/jingzhao-l/iterate-skill) 项目在 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 桌面客户端中的落地插件。它把 iterate 的审查闭环（review → triage → fix → validate → 收敛）直接带进 dsh 的界面：提供**自治闭环代码迭代**（normal 模式）与 **dry-run 纯多轮审查**（只读）两种能力。

**v3.2 质量指挥中心**：插件已从"被动观察面板"升级为"主动指挥中心 + 知识库"。新增质量门禁读取与可写计算（compute）、经验银行（检索 / 采纳 / 新增 add）、防御事件流（记录 + 中英双语标签）、原生命令按钮与 `task_mode` 指示器。

除 17 个纯函数工具外，还内置一套**免构建的 Web UI 层**（收敛看板、分诊面板、统计卡片、10 标签页运行时观测台、主题皮肤等），直接挂在 dsh 客户端的既有 UI 槽位上。配置方式（`iterate.config.yaml` 与审查维度）与迭代生态的另外两个组件（[技能](https://github.com/jingzhao-l/iterate-skill) / [无头引擎](https://github.com/jingzhao-l/iterate-harness)）完全一致，迁移零成本。

---

## 📑 目录

- [✨ 特性](#-特性)
- [📦 安装](#-安装)
- [💬 使用](#-使用)
- [⚙️ 项目配置](#️-项目配置)
- [🔧 注册工具](#-注册工具)
- [📁 运行时产物布局](#-运行时产物布局)
- [🎨 设计](#-设计)
- [🧪 运行测试](#-运行测试)
- [⚠️ 免责声明与许可](#️-免责声明与许可)

---

## ✨ 特性

### 两种运行模式

插件与生态其他组件运行同一套 iterate 引擎，要么完全只读、要么作为自治修复闭环：

- **dry-run（只读）** — 反复多维度审查直到收敛，**零文件修改**。
- **normal（自治）** — 审查 → 原子修复 → 每轮验证 → 失败回滚 → 循环直到收敛。

两种模式共通：

- 多轮收敛反复审查
- 并行维度评审
- 确定性聚合 / 去重 / 排序
- meta-review 报告一致性审计
- 达标自停
- 断点保存 / 恢复（长迭代续跑）

`normal` 模式额外提供：

- **只修改 atomic 问题**（architectural 问题保留待后续批准）
- 每轮修复后验证
- 修复失败自动回滚

### UI 层（客户端免构建槽位，v3.2：10 个标签页）

- **收敛看板 `ConvergenceDashboard`**（`conversation.input.dock`）— 输入框上方实时显示轮次进度条、严重度统计、维度徽章、趋势迷你图；normal 模式另显示修复计数徽章；还有运行阶段芯片（当前工作流阶段 + 运行中/已结束）与 **v3.2 task_mode 指示器（code / iterate）**。
- **运行时观测台 `ObservatoryPanel`**（`conversation.input.dock`）— 输入框下方**十个标签页**运行时观测台：实时活动流（支持按活动类型筛选）、审查线程（支持全部展开/全部收起）、收敛趋势、发现定位（支持按严重度/维度/关键词筛选）、修复与回滚、断点恢复、决策时间线（支持按类型/轮次筛选与关键词搜索）。**v3.2 新增标签：质量门禁（F8）、经验银行（F9）、防御事件（F10）**；支持一键导出全部观测数据为 JSON（优先下载，失败回退复制）。
- **Findings 分诊面板 `TriagePanel`**（`conversation.chat.turnTail`）— 逐条 y/n/a 判定，支持筛选、批量（含一键全选所有 findings）、键盘快捷键、localStorage 持久化、复制 YAML / 应用指令。**v3.2：原生命令按钮**（批准架构修复、触发新一轮、回滚到断点）。
- **收敛统计卡片 `StatsCard`**（`conversation.chat.turnTail`）— 无 findings 时显示收敛统计、历史轮次、趋势图、完成摘要。
- **iterate 主题皮肤**（`theme.overrideTokens`）— 暖琥珀配色的 13 个 `--dsw-*` token 覆盖，明暗双模式，可在设置页开关。
- **进度胶囊 `ProgressCapsule`**（`shell.overlay`）— 每轮完成 / 收敛时右下角弹出通知（含收敛确认）。
- **iterate 设置区 `SettingsPanel`**（`settings.section`）— 主题开关、分诊持久化说明、配置管理指引、运行时状态概览（产物布局 + 查看/清理工具指引）、一键清空分诊数据。

UI 层为**防御式设计**：`slots` / `theme` / `React` 任一不可用时自动降级，不会崩溃客户端。

### 工具之外的闭环行为

除 17 个注册工具（完整参考见下文）外，插件还端到端打通了几条关键闭环：

- **findings 分诊闭环** — 审查 → UI 分诊（y/n/a）→ `iterate_triage` 写回 `known_intentional` → 下一轮自动过滤
- **结构化修复系统** — 每次修复先备份、写注册表、记录 diff，验证失败可 `iterate_rollback` 还原
- **断点续跑** — 长迭代在每轮开头保存 checkpoint，中断后可恢复进度
- **历史审计** — `iterate_history` 读取决策日志（按类型/时间/数量过滤）与修复注册表汇总，审查运行过程与修复明细
- **运行时清理** — `iterate_prune` 清理过期的决策日志条目、陈旧断点、孤儿修复备份与空轮次；默认 dry-run 只报告不删除，显式 `dryRun:false` 才真正清理，每次清理写入决策日志
- **配置读写** — `iterate_config` 支持带校验、备份、回滚的局部写入
- **v3.2 经验银行** — `iterate_experience` 以检索 / 过滤 / 采纳查阅历史修复与模式，并可 `add` 持久化新的已验证修复——重复添加同一 pattern + dimension 时累加命中次数而非重复写入
- **v3.2 质量门禁** — `iterate_quality_gate` 读取质量门禁状态（各维度收敛率 + PASS/FAIL），并可基于本轮 findings / 验证结果 `compute` 重新计算并持久化一份新的质量凭证（收敛率来自 `findingsByRound` 的真实收敛序列）
- **v3.2 防御事件流** — `iterate_defense_events` 查询防御事件（前置条件失败、回滚、不变量违反、假设证伪），并可 `record` 记录新事件；可读标签跟随项目语言（en / zh）

---

## 📦 安装

### 从 npm 安装

```bash
dsh plugin --profile web add iterate-plugin
# 或
pnpm add iterate-plugin
```

### 从 GitHub 安装（dsh 生态第三方安装方式）

dsh 官方支持从 GitHub 插件仓库直接安装：`dsh plugin --profile web add "github:owner/repo#ref"`（仓库根即插件，声明 `dsh.bundle` 后自动启用）。本插件在 [iterate-plugin 独立仓库](https://github.com/jingzhao-l/iterate-plugin) 维护仓库根即插件的发布位，由主仓库通过 `git subtree` 同步，内容与 npm 包一致：

```bash
dsh plugin --profile web add "github:jingzhao-l/iterate-plugin#main"
```

安装完成后需重启 dsh 服务（建议 `dsh web --patch`）并刷新页面，宿主与客户端 UI 层才会加载。

### 本地开发 / 源码挂载

```bash
dsh plugin --profile web add /path/to/iterate-skill/harness/iterate-plugin
# 或
pnpm add /path/to/iterate-skill/harness/iterate-plugin
```

然后在你的 profile `cordis.patch.yml` 添加：

```yaml
- insert:
  - id: iterate-plugin
    name: 'iterate-plugin'
```

> 插件包自带 `dsh.bundle.patch`（即 `cordis.patch.yml`），npm 包内 `files` 已白名单化（`src` / `lib` / `dist` / `cordis.patch.yml` / `README.md` / `LICENSE`）。其中 `dist/` 为 TypeScript 服务端逻辑的编译产物，随包分发以兼容 dsh 的 `github:owner/repo#ref` git-clone 安装方式（Node 不擦除 `node_modules` 下的 TS 类型）。

---

## 💬 使用

### dry-run 模式（纯反复审查，不修改文件）

当你想要"只是反复审查，不修改文件"，prompt 示例：

```
dry-run review this project, find all issues across all dimensions
```

插件会自动触发 iterate 工作流：

1. `plan` → 读取配置，生成评审计划
2. `loop` → 每轮并行评审，只找新问题 → 确定性聚合去重 → 统计收敛 → 无新问题则停止
3. `meta-review` → 审计报告一致性
4. `report` → 输出最终结果

### normal 模式（自治闭环迭代）

当你想要"iterate this project / fix the issues found"，prompt 示例：

```
iterate on this project, fix all atomic issues
```

工作流：

1. `plan` → 读取配置
2. `loop` → 并行评审 → 聚合去重 → 原子问题并行修复 → 执行验证命令 → 验证失败则回滚 → 记录日志 → 无新问题则停止
3. `report` → 输出修复统计

---

## ⚙️ 项目配置

在项目根目录放 `iterate.config.yaml`：

```yaml
# 评审目标（例如 "提高代码质量，修复潜在bug，改善可维护性"）
goal: "Improve code quality of the project"
# 评审维度（从本插件预定义维度选或自定义）
dimensions:
  - correctness
  - security
  - performance
  - maintainability
  - code-style
# 最大评审轮次
max_rounds: 3
# 评审范围
review:
  scope: full  # full = 全项目，changed-only = 只看变更文件
# 原子修复阈值（单次修复允许改动的最大行数，超过需 force）
atomic:
  max_lines: 20
# 已知故意不修复的问题（评审会过滤掉，不再重复报告）
personalization:
  known_intentional:
    - file: src/example.ts
      line: 42
      dimension: security
      reason: "Intentional for demonstration"
# 验证命令（修复后自动跑，结果记入日志）
validation:
  commands:
    - npm test
    - npm run typecheck
```

> 配置可通过 `iterate_config` 工具读取与**校验式局部写入**（自动备份，写入失败自动回滚）。

---

## 🔧 注册工具（v3.2：17 个）

- `iterate_config` — 读取 / 写入 `iterate.config.yaml`。`operation=read` 返回完整配置或指定 section；`operation=write` 做 schema 校验、备份后局部合并写入，失败自动回滚
- `iterate_validate` — 运行白名单验证命令，返回结果
- `iterate_decision_log` — 追加决策日志（只追加，不改旧），存储于 `.iterate/decision-log.jsonl`
- `iterate_context` — 读取 `SKILL.md` / `ITERATE.md` 上下文
- `iterate_review` — 确定性评审引擎：`plan` 生成计划，`aggregate` 聚合去重 + 收敛统计，`meta-review` 审计报告一致性。纯计算，不触碰文件系统
- `iterate_triage` — 管理 `personalization.known_intentional`：`apply` 校验、去重（file|dimension|line）、备份后写回配置；`list` 读回当前条目。是浏览器分诊面板写回配置的唯一通道
- `iterate_fix` — 应用**一个原子修复**：校验相对路径、备份原文件、按 `atomic.max_lines` 强制原子性（可 `force` 跳过）、写入新内容、记录 FixRecord 与 `atomic_fix` 日志。normal 模式唯一合法的改文件入口
- `iterate_diff` — 查看修复累积变更：指定 `file` 返回相对首个备份的 unified diff；省略则返回每个已修复文件的汇总
- `iterate_rollback` — 回滚一个已应用的修复：从备份还原文件、从注册表移除该 FixRecord、追加 `revert` 日志。用于某轮验证失败后
- `iterate_checkpoint` — 迭代断点：`save` 保存当前进度到 `.iterate/checkpoint.json`，`load` 读回，`resume` 加载并累加恢复计数（中断恢复），`clear` 清除。长迭代可中断续跑
- `iterate_status` — 汇总当前迭代状态：模式、当前轮/总轮、已修复数、剩余 architectural、决策日志条数、是否存在 checkpoint；**v3.4：同时返回持久化的质量门禁快照、经验银行摘要与防御事件摘要**（`qualityGate` / `experienceBank` / `defenseEvents`）
- `iterate_history` — 读取迭代历史（只读）：决策日志条目（可按 `type` / `since` / `limit` 过滤，默认取最新 50 条，上限 200 条）+ 修复注册表汇总（各轮 fixed/failed 计数）。用于审查运行过程、审计日志、盘点修复
- `iterate_prune` — 清理运行时产物：过期决策日志条目（按 `retainDays`，默认 30 天）、陈旧断点、孤儿修复备份、空轮次。默认 dry-run 只报告不删除；`dryRun:false` 才真正清理，每次清理写入决策日志
- `iterate_transcript` — 运行时观测台：把审查转录、线程、修复与 nudge 指令持久化到 `.iterate/transcript.json`，供客户端观测台读取
- `iterate_experience` — **v3.2** 查询经验银行（list / search / get），或 `add` 一条新的已验证修复：重复添加同一 pattern + dimension 累加命中次数而非重复写入。持久化到 `.iterate/experience.json`
- `iterate_quality_gate` — **v3.2** 读取质量凭证（`read`），或基于 findings、验证结果、`findingsByRound` 与 `fixedByDimension` 重新计算并持久化一份新凭证（`compute`）。真实的逐维度收敛率
- `iterate_defense_events` — **v3.2** 查询防御事件（list / counts），或 `record` 记录一条新事件。可读标签跟随项目语言（en / zh）

---

## 📁 运行时产物布局

所有运行时状态都落在项目根目录的 `.iterate/` 下（可由 `.gitignore` 排除）：

```
.iterate/
  decision-log.jsonl      # 追加式决策日志（plan/review/fix/revert…）
  checkpoint.json         # 迭代断点（断点续跑）
  transcript.json         # 运行时观测台清单（各 reviewer 线程、趋势、修复、时间线、nudge）
  transcript-live.ndjson  # 追加式近实时 reviewer 活动流（read/fix/rollback/validate…），带字节上限
  experience.json         # v3.2：经验银行（跨会话积累的历史修复与模式）
  quality-gate.json       # v3.2：质量门禁快照（维度收敛率、验证通过率、PASS/FAIL）
  defense-events.json     # v3.2：防御事件流（前置条件失败、回滚、不变量违反、假设证伪）
  fixes/
    registry.json         # 修复注册表（FixRecord 列表，按轮次组织）
    <fix-id>_<ts>.bak     # 每次修复前的原文件备份
```

---

## 🔐 权限、依赖与兼容性

### Node.js / DSH 兼容范围

- **Node.js**：`>=20`（`package.json` 的 `engines.node`）。
- **DSH**：在 `dsh.compatibility.dshReleases` 中声明官方 `0.1.2-alpha.4`、
  `0.1.2-alpha.5`、`0.1.2-rc.1` 三个版本为 `compatible`。插件基于
  `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-util-values` `0.1.2-rc.1` 构建，
  只使用公开契约（工具注册、客户端 slots + theme、bundle patch）。

### 运行时权限（保守披露）

插件与 DSH 宿主共享同一进程能力，涉及以下能力；具备高权限意味着 DSH Profile
安装仍需 `user-reviewed`/守卫，不会自动放行：

- **文件（files）** — 读写 `<projectRoot>/.iterate/` 下的项目本地状态（决策日志、
  检查点、transcript、修复备份/注册表、质量门禁、经验银行、防御事件）。
  `iterate_fix` / `iterate_triage` 还会就地修改用户源码（路径遍历防护限定在解析后
  的项目根目录内，每次修复前备份、失败回滚）。客户端侧把分诊判定持久化到 `localStorage`。
- **命令（commands）** — 插件只注册模型可调用工具；模型要执行的任何 shell 操作
  （build / test / `git`）都由**宿主**执行，不是本插件。客户端"指挥按钮"只复制可粘贴
  的指令文本，不启动任何进程。
- **凭据（credentials）** — 本插件运行时**不**读取或传输凭据。同生态的
  **iterate-skill / iterate-harness** 组件在用户自行执行 Git/API 操作时可能读取
  git 凭据 / GitHub token；它们是独立包，本插件从不加载它们。
- **网络（network）** — 运行时无任何网络访问（全部本地）。

### 依赖

运行时依赖：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、
`@deepseek-ai/dsh-util-values`、`js-yaml`——全部精确锁版。无安装期生命周期脚本
（`preinstall`/`install`/`postinstall`/`prepare`）；仅 `prepublishOnly`（构建）在发布时运行。

### 失败边界

- 所有写入都是原子的（临时文件 + rename），且限定在 `.iterate/` 下；写入中途崩溃
  不会损坏 checkpoint / transcript。
- 持久化失败以结构化 `{ ok: false, error }` 返回，而不是静默成功。
- 修复编辑先备份再应用，验证失败自动回滚。
- 某个 slot / 服务不可用时 UI 优雅降级。

---

## 🎨 设计

插件遵循 dsh "everything-is-a-plugin" 架构：

- **只做两件事** — 注入系统 prompt 教模型写 iterate workflow + 注册 17 个纯函数工具
- **所有 orchestration 通过 dsh 原生 `workflow` + `agent` + `parallel` 完成**
- **核心逻辑全部纯函数**（去重 / 过滤 / 排序 / 收敛 / meta-audit / diff 计算 / 历史过滤 / 清理报告），可单元测试，无 I/O
- **安全模型** — 文件写入限定在解析后的项目根目录内（路径遍历防护）；写文件前必备份，失败回滚；配置写入同样备份 + 回滚；`iterate_prune` 默认 dry-run、只清理 `.iterate/` 下产物、每次清理写日志；`iterate_fix` 对 content 设字符上限、`iterate_triage` 对 entries 设数量上限，防止异常超大负载
- **UI 免构建** — `lib/client.js` 用 `React.createElement` 树 + 注入 `<style>` 标签，全部颜色走 `--dsw-*` 令牌，缺服务自动降级
- **v3.2 质量指挥中心** — 把插件从"被动观察面板"升级为"主动指挥中心 + 知识库"——质量门禁（读 + compute）、经验银行（读 + add）、防御事件（读 + record）与原生指挥按钮
- 遵循 iterate 原技能的设计原则：确定性收敛，可审计，最小权限

---

## 🧪 运行测试

```bash
cd harness/iterate-plugin
npm install
npm run typecheck
npm test
```

所有测试通过：

- **466 个单元测试全绿**，类型检查通过
- 覆盖：去重、过滤、排序、多轮收敛、meta-review 审计、路径安全、超时钳制、配置读写与回滚、triage 合并、diff 计算、checkpoint 校验、修复注册表、历史读取与过滤、prune 清理报告与 dry-run 语义、UI 纯函数（select-all 键、运行时状态指引）、**v3.2：经验银行、质量门禁、防御事件、审批门禁 fail-open 路径**等

---

## ⚠️ 免责声明与许可

### 免责声明

本项目按「现状」（AS IS）提供，不附带任何明示或暗示的担保，包括但不限于对适销性、特定用途适用性及不侵权性的担保。

**自动化的代码审查与修复存在固有风险。** normal 模式下产生的改动均由 AI 模型生成，可能引入缺陷、回归或非预期行为。在合并改动前，你应当：

- 在应用到主分支或推送前，逐条 review 每一处 diff。
- 确保项目处于 git 版本控制之下，并可随时回滚（`git restore`、revert 或从备份恢复）。
- 在每轮修复后运行项目自身的测试与构建检查。
- 切勿在密钥、凭证、`.env` 或任何不允许修改的文件上运行本项目；请在配置中设置 `protected_paths` 予以保护。

使用者需为本项目使用过程中所产生、修改或提交的代码负全部责任。使用本项目即表示你同意：维护者与贡献者不对因使用本项目而导致的任何损失、损害或法律后果承担责任。

### License

MIT
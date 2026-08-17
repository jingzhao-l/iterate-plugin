# iterate-plugin for DeepSeek Harness (dsh)

> **开发与评审在 [iterate-skill 主仓库](https://github.com/jingzhao-l/iterate-skill) 完成**：插件代码由主仓库统一维护，通过 `git subtree` 同步到本仓库；**版本发版与 npm 发布在本仓库（插件仓库）进行**，作为 dsh 生态的正式发布位。欢迎 **star / fork 主仓库** 并在 [主仓库 Issues](https://github.com/jingzhao-l/iterate-skill/issues) 反馈问题。

`iterate-plugin` 是 [iterate](https://github.com/jingzhao-l/iterate-skill) 技能的 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件，提供**自治闭环代码迭代**和 **dry-run 纯多轮审查**能力。除 13 个纯函数工具外，还内置一套**免构建的 Web UI 层**（分诊面板、收敛看板、统计卡片、主题皮肤等），直接挂在 dsh 客户端的既有 UI 槽位上。

## 特性

### 两种运行模式

| 功能 | dry-run 模式 | normal 模式 |
|------|-------------|------------|
| 多轮收敛反复审查 | ✅ | ✅ |
| 并行维度评审 | ✅ | ✅ |
| 确定性聚合去重/排序 | ✅ | ✅ |
| meta-review 报告一致性审计 | ✅ | ✅ |
| 零文件修改（只读） | ✅ | ❌ |
| 原子问题自动修复 | ❌ | ✅ |
| 每轮修复后验证 | ❌ | ✅ |
| 修复失败回滚 | ❌ | ✅ |
| 达标自停 | ✅ | ✅ |
| 只修改 atomic 问题，保留 architectural 留待后续 | ❌ | ✅ |
| 断点保存 / 恢复（长迭代续跑） | ✅ | ✅ |

### 工具层

- **13 个注册工具**：`iterate_config` / `iterate_validate` / `iterate_decision_log` / `iterate_context` / `iterate_review` / `iterate_triage` / `iterate_fix` / `iterate_diff` / `iterate_rollback` / `iterate_checkpoint` / `iterate_status` / `iterate_history` / `iterate_prune`
- **findings 分诊闭环**：审查 → UI 分诊（y/n/a）→ `iterate_triage` 写回 `known_intentional` → 下一轮自动过滤
- **结构化修复系统**：每次修复先备份、写注册表、记录 diff，验证失败可 `iterate_rollback` 还原
- **断点续跑**：长迭代在每轮开头保存 checkpoint，中断后可恢复进度
- **历史审计**：`iterate_history` 读取决策日志（按类型/时间/数量过滤）与修复注册表汇总，审查运行过程与修复明细
- **运行时清理**：`iterate_prune` 清理过期的决策日志条目、陈旧断点、孤儿修复备份与空轮次；默认 dry-run 只报告不删除，显式 `dryRun:false` 才真正清理，每次清理写入决策日志
- **配置读写**：`iterate_config` 支持带校验、备份、回滚的局部写入

### UI 层（客户端免构建槽位）

| UI 组件 | 挂载槽位 | 功能 |
|---------|---------|------|
| 收敛看板 `ConvergenceDashboard` | `conversation.input.dock` | 输入框上方实时显示轮次进度条、严重度统计、维度徽章、趋势迷你图，normal 模式另显示修复计数徽章 |
| Findings 分诊面板 `TriagePanel` | `conversation.chat.turnTail` | 逐条 y/n/a 判定，支持筛选、批量（含一键全选所有 findings）、键盘快捷键、localStorage 持久化、复制 YAML/应用指令 |
| 收敛统计卡片 `StatsCard` | `conversation.chat.turnTail` | 无 findings 时显示收敛统计、历史轮次表、趋势图、完成摘要 |
| iterate 主题皮肤 | `theme.overrideTokens` | 暖琥珀配色的 13 个 dsw token 覆盖，明暗双模式，可在设置页开关 |
| 进度胶囊 `ProgressCapsule` | `shell.overlay` | 每轮完成/收敛时右下角弹出通知（含收敛确认） |
| iterate 设置区 `SettingsPanel` | `settings.section` | 主题开关、分诊持久化说明、配置管理指引、运行时状态概览（产物布局 + 查看/清理工具指引）、一键清空分诊数据 |

UI 层为**防御式设计**：`slots` / `theme` / `React` 任一不可用时自动降级，不会崩溃客户端。

## 安装

### 从 npm 安装

```bash
dsh plugin --profile web add iterate-plugin
# 或
pnpm add iterate-plugin
```

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

> 插件包自带 `dsh.bundle.patch`（即 `cordis.patch.yml`），npm 包内 `files` 已白名单化（`src` / `lib` / `cordis.patch.yml` / `README.md` / `LICENSE`）。

## 使用

### dry-run 模式（纯反复审查，不修改文件）

当你想要 "只是反复审查，不修改文件"，prompt 示例：

```
dry-run review this project, find all issues across all dimensions
```

插件会自动触发 iterate 工作流：

1. `plan` → 读取配置，生成评审计划
2. `loop` → 每轮并行评审，只找新问题 → 确定性聚合去重 → 统计收敛 → 无新问题则停止
3. `meta-review` → 审计报告一致性
4. `report` → 输出最终结果

### normal 模式（自治闭环迭代）

当你想要 "iterate this project / fix the issues found"，prompt 示例：

```
iterate on this project, fix all atomic issues
```

工作流：

1. `plan` → 读取配置
2. `loop` → 并行评审 → 聚合去重 → 原子问题并行修复 → 执行验证命令 → 验证失败则回滚 → 记录日志 → 无新问题则停止
3. `report` → 输出修复统计

## 项目配置

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

## 注册工具（13 个）

| 工具 | 功能 |
|------|------|
| `iterate_config` | 读取 / 写入 `iterate.config.yaml`。`operation=read` 返回完整配置或指定 section；`operation=write` 做 schema 校验、备份后局部合并写入，失败自动回滚 |
| `iterate_validate` | 运行白名单验证命令，返回结果 |
| `iterate_decision_log` | 追加决策日志（只追加，不改旧），存储于 `.iterate/decision-log.jsonl` |
| `iterate_context` | 读取 `SKILL.md` / `ITERATE.md` 上下文 |
| `iterate_review` | 确定性评审引擎：`plan` 生成计划，`aggregate` 聚合去重 + 收敛统计，`meta-review` 审计报告一致性。纯计算，不触碰文件系统 |
| `iterate_triage` | 管理 `personalization.known_intentional`：`apply` 校验、去重（file\|dimension\|line）、备份后写回配置；`list` 读回当前条目。是浏览器分诊面板写回配置的唯一通道 |
| `iterate_fix` | 应用**一个原子修复**：校验相对路径、备份原文件、按 `atomic.max_lines` 强制原子性（可 `force` 跳过）、写入新内容、记录 FixRecord 与 `atomic_fix` 日志。normal 模式唯一合法的改文件入口 |
| `iterate_diff` | 查看修复累积变更：指定 `file` 返回相对首个备份的 unified diff；省略则返回每个已修复文件的汇总 |
| `iterate_rollback` | 回滚一个已应用的修复：从备份还原文件、从注册表移除该 FixRecord、追加 `revert` 日志。用于某轮验证失败后 |
| `iterate_checkpoint` | 迭代断点：`save` 保存当前进度到 `.iterate/checkpoint.json`，`load` 读回，`clear` 清除。长迭代可中断续跑 |
| `iterate_status` | 汇总当前迭代状态：模式、当前轮/总轮、已修复数、剩余 architectural、决策日志条数、是否存在 checkpoint |
| `iterate_history` | 读取迭代历史（只读）：决策日志条目（可按 `type` / `since` / `limit` 过滤，默认取最新 50 条，上限 200 条）+ 修复注册表汇总（各轮 fixed/failed 计数）。用于审查运行过程、审计日志、盘点修复 |
| `iterate_prune` | 清理运行时产物：过期决策日志条目（按 `retainDays`，默认 30 天）、陈旧断点、孤儿修复备份、空轮次。默认 dry-run 只报告不删除；`dryRun:false` 才真正清理，每次清理写入决策日志 |

## 运行时产物布局

所有运行时状态都落在项目根目录的 `.iterate/` 下（可由 `.gitignore` 排除）：

```
.iterate/
  decision-log.jsonl      # 追加式决策日志（plan/review/fix/revert…）
  checkpoint.json         # 迭代断点（断点续跑）
  fixes/
    registry.json         # 修复注册表（FixRecord 列表，按轮次组织）
    <fix-id>_<ts>.bak     # 每次修复前的原文件备份
```

## 设计

插件遵循 dsh "everything-is-a-plugin" 架构：

- **只做两件事**：注入系统 prompt 教模型写 iterate workflow + 注册 13 个纯函数工具
- **所有 orchestration 通过 dsh 原生 `workflow` + `agent` + `parallel` 完成**
- **核心逻辑全部纯函数**（去重/过滤/排序/收敛/meta-audit/diff 计算/历史过滤/清理报告），可单元测试，无 I/O
- **安全模型**：文件写入限定在解析后的项目根目录内（路径遍历防护）；写文件前必备份，失败回滚；配置写入同样备份 + 回滚；`iterate_prune` 默认 dry-run、只清理 `.iterate/` 下产物、每次清理写日志；`iterate_fix` 对 content 设字符上限、`iterate_triage` 对 entries 设数量上限，防止异常超大负载
- **UI 免构建**：`lib/client.js` 用 `React.createElement` 树 + 注入 `<style>` 标签，全部颜色走 `--dsw-*` 令牌，缺服务自动降级
- 遵循 iterate 原技能的设计原则：确定性收敛，可审计，最小权限

## 运行测试

```bash
cd harness/iterate-plugin
npm install
npm run typecheck
npm test
```

所有测试通过：

- **212 个单元测试全绿**，类型检查通过
- 覆盖：去重、过滤、排序、多轮收敛、meta-review 审计、路径安全、超时钳制、配置读写与回滚、triage 合并、diff 计算、checkpoint 校验、修复注册表、历史读取与过滤、prune 清理报告与 dry-run 语义、UI 纯函数（select-all 键、运行时状态指引）等

## License

MIT

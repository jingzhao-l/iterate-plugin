# iterate-plugin for DeepSeek Harness (dsh)

`iterate-plugin` 是 [iterate](https://github.com/iterate-skill/iterate-skill) 技能的 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件，提供**自治闭环代码迭代**和**dry-run 纯多轮审查**能力。

## 特性

| 功能 | dry-run 模式 | normal 模式 |
|------|-------------|------------|
| 多轮收敛反复审查 | ✅ | ✅ |
| 并行维度评审 | ✅ | ✅ |
| 确定性聚合去重/排序 | ✅ | ✅ |
| meta-review 报告一致性审计 | ✅ | ✅ |
| 零文件修改（只读） | ✅ | ❌ |
| 原子问题自动修复 | ❌ | ✅ |
| 每轮修复后验证 | ❌ | ✅ |
| 达标自停 | ✅ | ✅ |
| 只修改 atomic 问题，保留 architectural 留待后续 | ❌ | ✅ |

## 安装

### 从 npm 安装（发布后）

```bash
dsh plugin --profile web add iterate-plugin
# 或
pnpm add iterate-plugin
```

### 本地开发 / 源码挂载

```bash
dsh plugin --profile web add /Volumes/Eng-Dev/iterate-skill/harness/iterate-plugin
# 或
pnpm add /path/to/iterate-skill/harness/iterate-plugin
```

然后在你的 profile `cordis.patch.yml` 添加：

```yaml
- insert:
  - id: iterate-plugin
    name: 'iterate-plugin'
```

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
2. `loop` → 并行评审 → 聚合去重 → 原子问题并行修复 → 执行验证命令 → 记录日志 → 无新问题则停止
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

## 注册工具

插件注册了 5 个工具：

| 工具 | 功能 |
|------|------|
| `iterate_config` | 读取并验证 `iterate.config.yaml` |
| `iterate_validate` | 运行白名单验证命令，返回结果 |
| `iterate_decision_log` | 追加决策日志（只追加，不改旧） |
| `iterate_context` | 读取 `SKILL.md` / `ITERATE.md` 上下文 |
| `iterate_review` | 确定性评审引擎：`plan` 生成计划，`aggregate` 聚合结论，`meta-review` 审计报告 |

## 设计

插件遵循 dsh "everything-is-a-plugin" 架构：
- 只做一件事：注入系统 prompt 教模型写 iterate workflow + 注册 5 个纯函数工具
- 所有 orchestration 通过 dsh 原生 `workflow` + `agent` + `parallel` 完成
- 核心逻辑（去重/过滤/排序/收敛/meta-audit）全部纯函数，可单元测试，无 I/O
- 遵循 iterate 原技能的设计原则：确定性收敛，可审计，最小权限

## 运行测试

```bash
cd harness/iterate-plugin
npm install
npm run typecheck
npm test
```

所有测试通过：
- 31 个单元测试全绿
- 覆盖去重、过滤、排序、多轮收敛、meta-review 审计
- 类型检查通过

## License

MIT

# progress 模板(会话级,实例化于会话/PR 描述,不提交实例进仓库)

> 用法见 [`../AI_HARNESS_DESIGN.md §4`](../AI_HARNESS_DESIGN.md)。长期进度的权威源是 [`docs/current-state.md`](../../current-state.md),本模板只承载**单次会话/任务**的工作状态,便于中断恢复与交接。

```markdown
## Progress — <任务一句话标题>

- **当前任务**:<任务说明的复述 + 档位(A/B/C/D/E)>
- **当前分支 / worktree**:<branch>(base: main @ <sha>)
- **当前阶段**:②门禁 / ③定位 / ④计划 / (拍板等待) / ⑤实施 / ⑥检查 / ⑦修复(第 N 轮,≤2) / ⑧报告
- **修改范围白名单**(④阶段冻结):
  - <path/glob 1>
  - <path/glob 2>

### 已完成
- [x] <步骤 + 证据(命令/输出摘要/文件:行号)>

### 未完成
- [ ] <步骤>

### 已修改文件
| 文件 | 类型(新增/修改) | 是否在白名单内 |
|---|---|---|

### 已运行命令与结果
| 命令 | 结果 | 备注 |
|---|---|---|
| pnpm agent:preflight | ✅/❌ | |
| pnpm agent:check:<quick/api/full> | ✅/❌ | 失败摘要 |

### 风险
<指向本会话 risk-register 实例的条目编号,或"无">

### 人工确认点
- [ ] <HUMAN_REVIEW_RULES §1 第 N 条:状态(待提交/已提交待拍板/已拍板)>

### 下一步建议(不自动启动)
- <建议 1>

### 本次未做(显式)
- <刻意不做的范围,沿 process.md §8>
```

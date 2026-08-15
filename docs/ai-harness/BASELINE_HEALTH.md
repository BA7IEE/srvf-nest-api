# BASELINE_HEALTH

> Phase 0 的健康基线是观测记录，不是可再生的登记表。它只描述一次主分支冷跑；后续治理以此作为 “zero-new-red” 的对照起点。

## 取证来源

| 项目            | 值                                                                                  |
| --------------- | ----------------------------------------------------------------------------------- |
| 主分支 revision | `65475504533ba84fcb7a00a8fa835779f70705e9`                                          |
| CI              | [CI #31318061317](https://github.com/BA7IEE/srvf-nest-api/actions/runs/31318061317) |
| 事件 / 结论     | `push` / `success`                                                                  |
| 创建 / 完成     | 2026-08-09T14:17:35Z / 2026-08-09T14:30:30Z                                         |
| 口径            | GitHub Actions 最近一次成功的 `main` 冷跑；测试数取 job 日志                        |
| 本机 E2E        | 未运行（Phase 0 禁止在本机跑全量 E2E）                                              |

## 检查结果（三数 = 总 / 过 / 败）

| 检查          | 三数                     | 补充                              |
| ------------- | ------------------------ | --------------------------------- |
| unit          | 5,186 / 5,113 / 0        | 196 / 196 suites；73 todo         |
| contract      | 875 / 875 / 0            | 1 / 1 suite；2 / 2 snapshots      |
| E2E           | 4,861 / 4,861 / 0        | 两分片 134 + 133；合计 267 suites |
| lint（冷跑）  | 1 / 1 / 0                | Fast checks 的 `Lint` 步骤        |
| lint（缓存）  | 未观测 / 未观测 / 未观测 | 此取证源是冷跑，不能臆造缓存口径  |
| OpenAPI check | 1 / 1 / 0                | `docs:openapi:check`              |

## Required checks 快照

- `Lint / Typecheck / E2E`
- `Docker image build`
- `Diff guards`
- `Red-zone (trusted)`

`strict=false`，来源为 GitHub `main` 分支保护的 `required_status_checks`。

## Job 耗时

| Job                            | 耗时 | 结论    |
| ------------------------------ | ---: | ------- |
| Docker image build             |  72s | success |
| Diff guards                    |  18s | success |
| Change set                     |   6s | success |
| Contract + E2E (1)             | 758s | success |
| Contract + E2E (2)             | 727s | success |
| Fast checks                    | 578s | success |
| Lint / Typecheck / E2E（聚合） |   2s | success |

## CI job 耗时趋势（增补观测，2026-08-15）

> ⚠️ 本节是**增补**，不替代上面那份 Phase 0 一次性冷跑快照。上表的 `Fast checks 578s` 刻意保持原值不动 ——
> 这次增长正是靠它当对照才被发现的；把它就地改成新数字，就等于拆掉下一次发现同类问题的唯一支点。

`Fast checks` 在 5 天内从 574s 涨到 876s（+53%），一度贴着 15 分钟上限跑并自行 cancel 两次
（run 31830677807 15m01s、31813727597 15m15s）。逐步骤对照（两次均为 `main` 上非 docs-only 的完整跑）：

| 步骤                       | 08-09 [#31318061317][r1] | 08-14 [#31812869850][r2] |     Δ |
| -------------------------- | -----------------------: | -----------------------: | ----: |
| Lint                       |                     130s |                     124s |   −6s |
| Typecheck                  |                      74s |                      71s |   −3s |
| Docs guards                |                      25s |                      26s |   +1s |
| A-metadata gate            |                        — |                      22s |  新增 |
| **Harness selftests**      |                 **147s** |                 **318s** | +171s |
| **Replay incidents**       |                 **110s** |                 **230s** | +120s |
| Build                      |                      26s |                      26s |     0 |
| Unit tests                 |                      46s |                      43s |   −3s |
| **Fast checks（job 总计）**|                 **574s** |                 **876s** | +302s |

[r1]: https://github.com/BA7IEE/srvf-nest-api/actions/runs/31318061317
[r2]: https://github.com/BA7IEE/srvf-nest-api/actions/runs/31812869850

**归因**：+302s 里有 291s 来自那两步，其余全部持平。增量来自 R8 治理线（#996 typed-AST、#997
self-by-construction、#1002），是**正当的能力增长** —— 所以处置方向是把它们移出关键路径，不是删检查。

**处置（2026-08-15）**：两步拆成 `Harness selftests` / `Incident replay` 两个并行 job，折进 `gate` 的
`needs`。**不新增 required context**（上节四条快照不变）—— 新 context 会卡死所有 base 上没有它的在飞分支。
关键路径本就是 `Contract + E2E`（892s），三者与它并行 ⇒ harness 线离开关键路径、超时风险归零。
（不写「全程墙钟不变」：E2E 自身单次方差就有 ±5%（909s / 1187s / 892s 三次读数），
拆分对总墙钟的影响被它淹没,量不出来 —— 能证的是**harness 线不再是瓶颈**,不是「总时长恒等」。）

拆分实测(#1007 合入后 `main` 冷跑 [run 31867976145][r3],非 docs-only):

| Job                | 拆分前 | 预期  | **拆分后实测** | 偏差 |
| ------------------ | -----: | ----: | -------------: | ---: |
| Fast checks        |   876s | ~328s |       **344s** |  +5% |
| Harness selftests  |      — | ~331s |       **363s** | +10% |
| Incident replay    |      — | ~243s |       **253s** |  +4% |
| Contract + E2E (1) |   892s |  不变 |           909s |  +2% |

[r3]: https://github.com/BA7IEE/srvf-nest-api/actions/runs/31867976145

**到期条件已闭合**:三项均落在 ±10% 内,推算模型(拆分前步骤读数 + 各 job ~13s 固定开销)成立。
`Fast checks` 876s → 344s(**−61%**),对 15 分钟上限有 2.6x 余量;三个 job 的最大值 363s
远低于关键路径 `Contract + E2E`(本次两片 909s / 1187s)⇒ harness 线已彻底离开关键路径。

> ⚠️ 单次读数,runner 方差不可忽略:同一 commit 的 PR 冷跑里 `Incident replay` 只有 184s(−24%),
> 而 `main` 两次分别是 253s / 263s。**别把任何单次读数当基线**;上表取的是 `main` 冷跑口径,
> 与 08-09 / 08-14 两列同源(均为 `main` push),这才是可比的。

**docs-only 行为已正面验证**([run 31868312301][r4],纯文档合并):
`Fast checks` 54s(lint/typecheck/build/unit 合法跳过)、`Contract + E2E` 与 `Golden journeys` 跳过,
而 **`Harness selftests` 283s 与 `Incident replay` 263s 照常跑满** —— 与拆分前它们在 `fast` 里
不带 `if: docs_only` 的行为逐字一致。这条是**拆分没有偷偷放松触发条件**的正面证据,
不是从「gate 绿了」反推的。

[r4]: https://github.com/BA7IEE/srvf-nest-api/actions/runs/31868312301

**两个已知热点**（拆分刀当时刻意未动，各自另立一刀）：

1. **仍未处置。** `harness:replay` 的 `eslint-rules-live` 探针会整份重跑
   `scripts/harness-eslint.selftest.ts`（本机实测 replay 155.5s 中 127.6s 是这次重跑 = 82%）。
   拆成两个 job 后这份重复变成并行，墙钟代价归零，但总算力仍付两遍。
2. ~~R8 探针循环每个探针重建一次完整 `ts.Program`~~ → **已修（2026-08-15）**。
   原状：30 个探针逐个重写同一个探针文件、每轮换一个 `cacheKey`，于是每轮**必须**重建全仓
   `ts.Program`。**这不是「缓存没写好」**：`eslint-rules/authz-declaration-closure.mjs` 的
   `SOURCE_INDEX_CACHE_LIMIT = 2` 是刻意的，其注释写明 ~30 个 key 同时驻留正是堆耗尽的成因。
   处置：30 个探针一次性写出、共用一个 `cacheKey`，一次 `scanRouteAuthzClosure` + 一次
   `lintFiles` 收结果；全仓首扫移到探针之前（此时 `src/` 还干净），两者各占一个 `cacheKey`。
   `SOURCE_INDEX_CACHE_LIMIT` **未动**。

   | 读数（本机交叉 A/B，两轮交替跑，同一 commit 同一会话） | 修复前 | 修复后 |
   | ------------------------------------------------------ | -----: | -----: |
   | 一次自测的 `ts.Program` 构建次数                       | **32** |  **2** |
   | `scripts/harness-eslint.selftest.ts` 墙钟（两轮）      | 181.0s / 133.0s | **60.8s / 59.0s** |
   | 峰值常驻内存 maximum RSS（两轮）                       | 3.22GB / 3.28GB | **2.97GB / 3.07GB** |
   | 自测计数                                               | 129 passed / 0 failed | 131 passed / 0 failed |

   构建次数是**机器读数**不是耗时推算：规则导出 `authzTypedProgramBuilds()`，自测断言整段 R8
   的构建次数 ∈ [1, 2]（下界防「计数器被摘掉后恒 0 也算通过」）。把其中一个 `cacheKey` 改回
   修复前的写法即变红（实测 3 次、且是**唯一**一条红）—— 这条闸自己也做过阳性对照。
   逐探针变异 A/B 见 [PR #1019][r5]：30 条各自变异一次，红集恒为它自己那一条，无交叉。

[r5]: https://github.com/BA7IEE/srvf-nest-api/pull/1019

   ⚠️ 连带影响：第 1 条里那个 127.6s 的分量随之缩到 ~60s，**但该条本身仍未处置**
   （总算力仍付两遍），此处只更新事实、不改它的状态。

## 已知 flaky 观察清单

以下三项按 v4 起步要求登记为 watchlist。本次冷跑整体通过；这不能推出它们已不再 flaky，也未对历史频率作断言。

| 项                           | 本次观察             |
| ---------------------------- | -------------------- |
| auth-jwt-guard               | aggregate run passed |
| users-last-super-admin       | aggregate run passed |
| attendances-state-transition | aggregate run passed |

## 长期红项与失败归类

本次取证范围内没有长期红项。按此次成功冷跑归类：infra 0、flake 0、regression 0、environment 0、unclassified 0。上述零值只说明此 run，没有把历史失败率写成零。

结构化原始记录见 [`harness/baseline-health.json`](../../harness/baseline-health.json)。

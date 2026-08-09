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

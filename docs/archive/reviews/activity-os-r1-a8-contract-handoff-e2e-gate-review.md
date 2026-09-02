# Activity OS R1 / A8：contract、handoff、No-AI E2E 与 Gate 收口评审与授权清单

> **状态：评审草案，未获实施授权。** 本稿只冻结 A8 的最小范围、风险、探针和授权边界；维护者确认方案前，不修改 `package.json`、测试、契约、交接文档或任何运行时 Gate。
>
> **上游合同**：[Activity OS T0-A 终态合同](activity-os-t0-terminal-review.md) §9、§10、§11、§12；其中 §9 明确指定 `pnpm test:business:no-ai`，§11 将 A8 固定为 Release 1 的 contract / handoff / E2E / gate 单轴。A1 至 A7 已分别合入 #1237、#1239、#1241、#1244、#1246、#1248、#1251；本刀不重开此前决策。

## 1. 维护者最低阅读量

### 人话简报

- **做什么**：补一个可单独执行的 No-AI 验收命令，把已落地的结构边界、真实 HTTP 手工链和 A7 Series 链串行验收；同时让 A7 E2E 明确运行在 Activity v1.1 与 Integration 都关闭的一侧。
- **不做会怎样**：冻结合同点名的验收入口仍不存在，A7 对两个生产 Gate 的关闭状态只依赖测试环境默认值；以后改配置或调用方式时，可能把“默认关闭”误当成“已经验证关闭”。
- **最坏情况与回退**：错误的脚本可能漏掉一条验收链或让运行时间失控；撤回只需删除新增脚本和两处 test env 赋值，无数据、API、schema 或生产状态需要回滚。
- **推荐方案**：方案 A。新增精确的串行命令，并在 A7 创建 Nest 应用前显式设两个 Gate 为 `false`、结束后恢复原值。

### 需要维护者拍板

回复 **`确认 A8 方案 A`** 即表示只批准下述实施范围；随后仍须在 A8 实施工作树中亲自发放 `package.json` 的精确红区授权。该确认不授权依赖、Jest 配置、CI workflow、API、schema、migration、权限、运行时 Gate 或生产操作。

## 2. 已核验事实

| 事实 | 证据 | 对 A8 的结论 |
| --- | --- | --- |
| 冻结合同指定的入口是 `pnpm test:business:no-ai`，但 T0-A 当时明确不新增命令或测试 | `activity-os-t0-terminal-review.md:268` | A8 应补精确入口，不改冻结合同正文。 |
| 现有 `test:journeys` 只跑 journey 目录；`package.json` 尚无该命令 | `package.json:29-35`；`test/jest-journeys.config.ts:12-36` | 新入口必须显式选中 No-AI Journey，不能把整个 journey 集合误称为它。 |
| No-AI Journey 在真实 Nest 启动中覆盖创建、发布、报名、审批、签到 | `test/journeys/activity-os-no-ai.e2e-spec.ts:1-36` | 保留原断言；它覆盖已存在的 HTTP 手工链。 |
| 核心无 AI 依赖已有结构裁判，且四类正对照都在 unit runner 内 | `src/ai-dependency-boundary.criteria.spec.ts:1-71` | 新入口先运行此判据，证明当前无 Provider 包、AiModule import、AppModule 注册或依赖声明越界。 |
| A7 是内部 Series façade，没有 HTTP / DTO / Swagger / route / Integration 入口 | `docs/ai-harness/FROZEN_DRAFTS.md` 的 A7 记录；A7 E2E | 新入口需将 A7 真实 E2E 纳入；不为它虚构前端 handoff。 |
| Activity v1.1 与 Integration 在 test 环境空值默认 `false`，生产 / smoke 才强制显式 | `src/config/app.config.ts:527-542`；`src/config/integration-auth.config.ts:37-49` | 默认关闭不足以防环境漂移；A7 spec 应在建 app 前显式置 `false` 并恢复。 |
| A7 仅显式打开责任 workflow，随后创建两个 Nest 应用；九个用例含真实双 pool 并发 | `test/e2e/activity-os-r1-a7-series-generation.e2e-spec.ts:112-148,316-660` | 只补两个关闭 Gate 的 setup / teardown，不删、改弱或重写既有九个断言。 |
| handoff 只记录契约表达不了的任务→端点图；无新增 API 时不得复制或捏造 endpoint 事实 | `docs/handoff/README.md:7-43,70-100` | A8 的 handoff 结果是零文档差异；用 contract / OpenAPI / client 守护证明，而不是新增空白条目。 |

本评审工作树已完成三条定向基线探针：

- `pnpm test -- src/ai-dependency-boundary.criteria.spec.ts`：1 suite、5 tests 通过；
- `pnpm test:journeys -- activity-os-no-ai.e2e-spec.ts`：1 suite、1 test 通过；
- `JEST_MAX_WORKERS=1 pnpm test:e2e -- activity-os-r1-a7-series-generation.e2e-spec.ts`：1 suite、9 tests 通过。

三条命令必须串行。两个 Jest 入口若并发启动，会争用同一 worktree 模板测试库的首次建库；这不是业务断言可并行化的依据。

## 3. 方案 A（推荐）

### 3.1 精确 No-AI 验收入口

只在 `package.json` 新增以下 script，不增依赖、不改 lockfile、Jest config 或 CI workflow：

```json
"test:business:no-ai": "pnpm test -- src/ai-dependency-boundary.criteria.spec.ts && pnpm test:journeys -- activity-os-no-ai.e2e-spec.ts && JEST_MAX_WORKERS=1 pnpm test:e2e -- activity-os-r1-a7-series-generation.e2e-spec.ts"
```

三段分别证明：核心没有可执行 AI 依赖、既有 HTTP 金路径不依赖 AI Runtime、A7 的 Series 生成仍在两个业务 Gate 关闭时运行。这里没有假装“已覆盖未来尚未落地的表单、资格、候补、时长、贡献、成果、更正或报表链”；这些正式链路后续落地时，必须各自把无 AI 手工路径加入本入口或同级 Journey。

当前仓没有 `AiModule` 或 Provider，结构判据又禁止核心引入它们，因此该入口验证的是合同允许的“未注册 AiModule、AI Assist 完全不可用”分支。它不读取、打印或伪造任何 AI Key；也不把一个无真实 Provider 的网络黑洞测试伪装成外网故障证明。将来若单独批准可选 Assist，必须重新立项其 Noop Adapter / 网络故障验收，不能沿用本结论。

`JEST_MAX_WORKERS=1` 仅限制该单一 A7 spec 的 Jest worker 数；A7 用例内部仍创建两个独立 Nest / Prisma pool 做真实竞争，不会被串行 runner 降级。

### 3.2 Gate 关闭态变为显式证据

在 `test/e2e/activity-os-r1-a7-series-generation.e2e-spec.ts`：

1. 保存 `ACTIVITY_V11_WORKFLOW_ENABLED` 与 `INTEGRATION_API_ENABLED` 的既有值；
2. 保留责任 workflow 为 `true` 的现有安排，并在两次 `createTestApp()` 前把上述两个 Gate 精确设为 `false`；
3. 在 `afterAll` 先关闭两个 app，再逐个恢复三个环境变量的原值；
4. 九个既有业务 / 并发 / 回滚 / migration / resetDb 断言逐字不动。

这只是让测试声明自己位于哪一侧 Gate，不改变 Gate 定义、默认值、生产配置、Controller、Service 或运行时行为。

### 3.3 contract 与 handoff 的零差异验收

本刀不改 `test/contract/**`、OpenAPI snapshot、`EXPECTED_ROUTES`、`docs/handoff/**` 或生成 client。实施后必须运行 `pnpm test:contract`、`pnpm docs:openapi:check` 与 `pnpm docs:feclient:check`。三者都绿才证明没有新增 / 删除路由或契约产物；由此确认 handoff 没有增量是正确结果，而不是遗漏。

## 4. 方案比较

| 方案 | 内容 | 结论 |
| --- | --- | --- |
| A（推荐） | 精确 script + A7 显式双 Gate 关闭 / 恢复 + contract / handoff 零差异验收 | 满足冻结合同命名入口，覆盖已落地范围，且不改变业务行为。 |
| B | 不加 script，只继续用 `pnpm test:journeys`，并依赖 test 默认关闭 Gate | 拒绝：合同点名的入口仍缺失，A7 对关闭态没有显式执行位。 |
| C | 为 A7 新增 HTTP endpoint 或 handoff 能力图行 | 拒绝：A7 是内部 façade；人为扩大 API surface 违反单轴边界。 |

## 5. 档位、写集与禁止域

本刀按 **D 档降速** 管理：虽无数据模型和业务行为变更，但 `package.json` 属 CI control plane 红区，必须独立评审、精确授权和 CI 冷跑。

实施 PR 的唯一业务写集：

- `package.json`：只新增 `test:business:no-ai`，不改任何既有 script、dependency、lockfile、版本或 package manager；
- `test/e2e/activity-os-r1-a7-series-generation.e2e-spec.ts`：只补双 Gate 的保存、显式关闭与恢复；
- `changelog.d/activity-os-r1-a8-contract-handoff-e2e-gate.md`：仅登记 A8 待发布说明。

明确禁止：`pnpm-lock.yaml`、Jest config、`.github/workflows/**`、`src/**`、Controller、DTO、Swagger、route contract、`docs/handoff/**`、schema、migration、seed、权限、审计事件、cron、AI / Integration 入口、任何运行时 Gate、生产入口、部署和数据操作。

本评审草案本身只新增归档稿并登记台账；归档规则的 `allowCreate` 允许新文件，`harness:needs` 在预算阶段会保守地把它报为需授权，不能把该静态预报误读为实际创建被拒。

## 6. 维护者授权清单（仅方案 A 获确认后）

创建 A8 实施 worktree 并完成 `pnpm agent:preflight --lane activity-os-r1-a8` 后，维护者在该 worktree 执行：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api-activity-os-r1-a8-contract-handoff-e2e-gate
pnpm harness:grant 'package.json' --reason "Activity OS R1/A8：维护者确认方案 A；新增精确 No-AI 验收命令，不改依赖、Jest 配置或 CI 工作流"
```

`test/e2e/activity-os-r1-a7-series-generation.e2e-spec.ts` 与 changelog fragment 经逐文件 `pnpm harness:needs` 确认不需要授权。授权只在该 worktree 生效；实施完成、所有写操作结束后再走 CI 的红区审批，不能拿旧 SHA 的审批继续使用。

## 7. DoD 与验证队列

1. `test:business:no-ai` 恰好运行本稿指定的三段，顺序固定为结构判据 → HTTP Journey → A7 E2E；
2. A7 只在显式 `ACTIVITY_V11_WORKFLOW_ENABLED=false`、`INTEGRATION_API_ENABLED=false` 下创建 app，结束后环境完全恢复；
3. `pnpm agent:check:quick`、`pnpm test:business:no-ai`、`pnpm test:contract`、`pnpm docs:openapi:check`、`pnpm docs:feclient:check`、`git diff --check` 均通过；
4. PR diff 只落在本稿写集；OpenAPI、route、handoff、client、权限、migration 和 Gate runtime 无差异；
5. PR CI 冷跑全绿，且 package 红区审批针对最终 SHA 完成；
6. 不执行 `prisma migrate dev`、`migrate reset`、`db push`、production deploy 或任何数据删除。

## 8. 本刀明确未做

- 不把 A8 当作未来 Activity OS 全链路都已验收的声明；
- 不新增 AI 模块、Provider、SDK、Noop Adapter、网络 mock、Redis、queue、cron 或缓存；
- 不开启、重命名、拆分或修改任何 Gate；
- 不以“无 API”之名跳过 contract 检查，也不以“要 handoff”之名发明前端接口；
- 不改已经合入的 A1 至 A7 评审稿、迁移、审计或生产状态。

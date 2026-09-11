# Activity OS Release 4 / D2：中性参与服务段 Facade 精确实施计划与授权清单

> **当前状态（2026-09-11）**：基点为 main `2af40878090e44b33c8dce7f68a1ff78c7c18fb9`。D2 方向评审已随 [#1317](https://github.com/BA7IEE/srvf-nest-api/pull/1317) 合入，合并后 [main CI 34584472085](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34584472085) completed/success。本稿只把已确认方向收敛为后续实施的精确写集、数据合同、探针和授权项；它不是 implementation 授权，不操作数据库、不启用 Gate、不删除业务数据或合并 PR。

> **文档 PR 授权（2026-09-11）**：维护者已确认方案 A，允许补充 changelog、提交、推送并创建本计划 PR；不合并、不实施、不操作数据库、不启用 Gate。该授权不改变 §6 的未来 implementation 授权要求。

## 1. 这次 D2 真正要交付什么

D2 只增加一个考勤域内部的只读边界：`ParticipationSegmentFacade`。它从既有 `ParticipantServiceSegmentRevision` 读取某活动的**当前**参与段，并把段自身、参与身份和来源打卡锚点以强类型结果交给未来 D3。

它不是第二套参与事实，不是时长类别计算器，也不是对外查询接口。D3 才会决定哪些段可分配、如何依 TimePolicy 分类和如何在锁后写入 allocation revision；D4–D8、结算、账本、成果、证明和现有考勤 UI 都不在本批。

本批完成的 DoD：

1. 考勤模块公开一个仅供内部模块注入的、显式传入 `Prisma.TransactionClient` 的 Facade；它不自行开事务、不写库、不缓存。
2. 读取只返回当前非 `superseded` 段，稳定排序、上限拒绝截断，并保留 `valid`、`early_departure_zero`、`voided`、`replaced` 和开放段的原始区别。
3. 每条返回值都经 identity / activity / session / member 与来源事件锚的同链校验；跨链或不完整事实 fail-closed，而不是静默过滤。
4. Facade 不选用、返回或重算 legacy `serviceHours`，不暴露地点、坐标、操作人、reason、附件、用户信息或完整 PunchEvent 原文。
5. 不迁移任何现有生产消费者；新 Facade 暂无生产调用方，D3 是首个计划中的消费者。现有重建、结算、账本、更正、封场、成果候选和考勤读面行为保持原样。

## 2. 已核验的事实与边界

| 已核验位置 | 事实 | 对 D2 的约束 |
| --- | --- | --- |
| [T0 合同 §7.1](../archive/reviews/activity-os-t0-terminal-review.md#71-单一参与事实与-timepolicy) | `AttendancePunchEvent → ParticipantServiceSegmentRevision` 是唯一参与段事实；D2 在 D1 后、D3 前。 | 不建 `ParticipationSegment` 表、不双写、不偷跑 allocation / ledger。 |
| `prisma/schema.prisma:5905-5961` | 当前键是 `(participationIdentityId, segmentKey)` 的非 `superseded` 修订；数据库只保证点唯一，不保证时段不重叠。 | Facade 不声称解决写链并发或重叠；它只如实读 current，未来写命令仍须持锁后重读。 |
| `prisma/schema.prisma:4986-5027` | identity 绑定 activity、session、member；`currentPositionId` 只是当前岗位快捷指针。 | 返回岗位锚必须取来源 check-in 事件的 `positionId`，不能把可变的 `currentPositionId` 当作历史事实。 |
| `prisma/schema.prisma:5727-5740` 与 `5905-5941` | 段到来源事件是单列 FK，数据库不替 D2 保证来源事件与段 identity/activity/session/member 一致。 | 查询后必须逐段验证这条链；不能用附加 `where` 偷偷滤掉坏关联。 |
| `attendance-punch-segment-revision.service.ts:66-142` | 重建先 supersede 旧修订、再 append 当前草稿；`replace` / `void` 保留原来源锚。 | 不改写链，不要求来源事件自身仍是字面 `check_in` / `check_out`。 |
| `settlement-segment-projector.ts:116-143, 198-233` 与 `correction-application.service.ts:1655-1665` | replace 可借被替代事件的角色投影；更正可沿用 check-in 锚但改变识别区间，且可没有 close 锚。 | D2 只校验来源归属，不把 eventType、事件发生时间或 `sourceCloseEventId` 与 `checkOutAt` 的配对当成新不变量。 |
| `activity-metric-rule.ts:10-16` | 已验证的有界参与读面为 2,000 身份、10,000 段。 | D2 使用相同数量级，但不导入 C3 指标规则，也不承担指标语义。 |
| `attendances.module.ts:80-162` | AttendancesModule 已经受控地 `forwardRef` ActivitiesModule，并只导出少数公开属主边界。 | 新 provider 落在 attendances，新增精确 export；不新建共享模块、不深引 writer/projector 私有实现。 |

## 3. 方案 A：精确读取合同

### 3.1 新文件、类型和公开方法

新增 `src/modules/attendances/participation-segment.facade.ts`，只导出：

```ts
export const PARTICIPATION_SEGMENT_FACADE_LIMITS = Object.freeze({
  identities: 2000,
  segments: 10000,
});

export interface CurrentParticipationSegment {
  readonly id: string;
  readonly activityId: string;
  readonly sessionId: string;
  readonly participationIdentityId: string;
  readonly memberId: string;
  readonly sourcePositionId: string | null;
  readonly segmentKey: string;
  readonly revision: number;
  readonly sourceCheckInEventId: string;
  readonly sourceCloseEventId: string | null;
  readonly resultCode: 'valid' | 'early_departure_zero' | 'voided' | 'replaced';
  readonly statusCode: 'draft' | 'committed';
  readonly checkInAt: Date;
  readonly checkOutAt: Date | null;
  readonly lateFlag: boolean;
  readonly earlyLeaveFlag: boolean;
  readonly exceptionFlagsJson: Prisma.JsonValue | null;
}

async readActivityCurrentSegmentsTrusted(
  tx: Prisma.TransactionClient,
  activityId: string,
): Promise<readonly CurrentParticipationSegment[]>;
```

`Trusted` 的意思是调用方已完成活动访问资格检查；未来任何“读段后写认定”的命令还须自己持有既有 Activity 锁并在锁后调用本方法。Facade 不接收任意 `identityIds`、Member、组织或岗位组合，避免把跨活动组合的判定责任藏进 reader；identity 从每条持久段的关系中取回。

方法对空 `activityId` 先抛 `TypeError`，不发查询；不存在活动或没有段时返回空数组。它不查询 `Activity` 本身，也不替未来 D3 作活动状态、资格或锁判断。

### 3.2 查询、上限和稳定顺序

唯一查询固定为 `tx.participantServiceSegmentRevision.findMany`：

- `where` 为 `identity: { activityId }` 加 `statusCode: { not: 'superseded' }`；这是 current 的既有语义，不能改成只读 `draft` 或只读 `committed`。
- `take` 固定 `PARTICIPATION_SEGMENT_FACADE_LIMITS.segments + 1`，即 10,001；多于 10,000 条时抛 `RangeError`，绝不截断、分页或返回部分参与事实。
- `orderBy` 固定为 `participationIdentityId ASC`、`segmentKey ASC`、`revision ASC`。不能按随机 id 或当前岗位排序。
- 取回后计算不同 `participationIdentityId` 数；超过 2,000 时抛 `RangeError`。这与段上限独立，不能只以总段数代替成员边界。

select 仅含段的 `id`、`participationIdentityId`、`segmentKey`、`revision`、两个来源事件 ID、`resultCode`、`statusCode`、`checkInAt`、`checkOutAt`、`lateFlag`、`earlyLeaveFlag`、`exceptionFlagsJson`；identity 的 `id/activityId/sessionId/memberId`；check-in 来源事件的 `id/activityId/sessionId/participationIdentityId/memberId/positionId`；以及可空 close 来源事件的 `id/activityId/sessionId/participationIdentityId/memberId`。

明确不 select、也不写入 `serviceHours`、`effectiveBatchId`、`baseRevisionId`、`createdAt`、`updatedAt`、事件坐标、operator、reason、设备、附件或身份关系之外的资料。`serviceHours` 保留在旧链供兼容读面使用，但绝不能成为 D2 或 D3 的时间真相输入。

### 3.3 Fail-closed 同链校验和返回映射

每条 query row 必须依次验证：

1. `participationIdentityId === identity.id`，identity 的 `activityId ===` 入参；`sessionId` 和 `memberId` 不为空。
2. `statusCode` 只能是 `draft` / `committed`，`resultCode` 只能是数据库已冻结的四态；出现未知状态不以“非 superseded”放行。
3. check-in relation 的 ID 和 `participationIdentityId/activityId/sessionId/memberId` 均与 identity 相等。
4. 若 `sourceCloseEventId` 非空，close relation 必须存在，且其 ID 和四个归属字段同样全部相等；若 sourceCloseEventId 为空，不要求 `checkOutAt` 也为空。

任一不符都抛 `TypeError`，并且整个调用无缓存、无补救重试、无静默行过滤。D2 不检查来源事件的 `eventTypeCode`，也不要求来源事件 `occurredAt` 等于识别修订的 `checkInAt/checkOutAt`：replace 和受控更正的现行事实允许这些表面差异，Facade 不得重写已有修订语义。

返回值的 `sourcePositionId` 只来自已验证的 check-in 锚；它不返回 identity 的 `currentPositionId`。返回顺序与查询顺序一致，返回对象不可附加原始 Prisma row 或未列字段。

## 4. 精确未来写集

后续 implementation PR 固定为下列 10 个路径；任何额外路径先停下单列原因，不把“D2”当通配授权。

| 路径 | 动作 | 边界 |
| --- | --- | --- |
| `src/modules/attendances/participation-segment.facade.ts` | 新增 | 上述只读事务 Facade、类型、限额、查询与同链校验。 |
| `src/modules/attendances/participation-segment.facade.spec.ts` | 新增 | 精确 query shape、上限、排序、链校验、无写入/无自开事务的单元测试。 |
| `src/modules/attendances/attendances.module.ts` | 修改 | 仅新增该 Facade 的 import/provider/export；不调整既有 imports、controllers 或任何既有 provider 行为。 |
| `test/e2e/activity-os-r4-d2-participation-segment-facade.e2e-spec.ts` | 新增 | 隔离库中的 Facade 集成/事务探针。 |
| `CODEMAP.md` | 生成更新 | 反映新增考勤源文件与测试，不手工编造摘要。 |
| `docs/ai-harness/NEXT_TASKS.md` | 修改 | D2 计划/实施状态和未做项。 |
| `docs/ai-harness/FROZEN_DRAFTS.md` | 修改 | T0-A 落地度索引。 |
| `docs/plans/activity-os-r4-d2-participation-segment-facade-review.md` | 修改 | 将评审稿链接和状态订正为实施计划已获确认后可执行。 |
| `docs/plans/activity-os-r4-d2-participation-segment-facade-implementation-plan.md` | 修改 | 记录实际 commit、验证证据与最终未做项；不事前写成已完成。 |
| `changelog.d/activity-os-r4-d2-participation-segment-facade-implementation.md` | 新增 | 只说明新增内部只读边界及不改变外部 API。 |

明确排除：`prisma/schema.prisma`、`prisma/migrations/**`、任何既有服务段 writer/reader、ActivitiesModule、controller、DTO、OpenAPI/contract snapshot、权限码/seed、Audit event、BizCode、Gate、Storage、测试全局 setup、旧 migration、客户端/handoff、生产和真实业务数据。现有 11 个直接消费者均不迁移：考勤命令、重建 writer、结算草稿/提交、账本准备/入账、更正、封场、evidence seal、结算 HTTP 读面、成果候选 source query 均保持原样。

## 5. 实施探针与验证顺序（未来执行，不是本轮结果）

### 5.1 单元探针

`participation-segment.facade.spec.ts` 必须逐项证明：

1. 使用调用者传入的 tx，精确发出 §3.2 的 `findMany`；不存在 `$transaction`、create/update/delete 或 PrismaService 注入。
2. 空活动 ID query-free；10,000 段与 2,000 identity 边界成功，10,001 段或第 2,001 个 identity 失败且不截断。
3. `draft` / `committed` 保留、`superseded` 不返回，四种 resultCode 与开放段 `checkOutAt=null` 原样保留，稳定排序不依赖 id。
4. check-in / close 的 activity、session、identity、member 任一错配，或非空 close ID 没有 relation，均 fail-closed；不得用 where 条件把它伪装成正常空结果。
5. `sourcePositionId` 来自 check-in event，不从 `identity.currentPositionId`、`serviceHours` 或现行结算值推断；replace / correction 形态不因 eventType、事件时间或 null close anchor 被误拒。

### 5.2 隔离 E2E 探针

新增 E2E 只用获维护者当场许可的 `app_test_w98` 及其 worker 隔离库。它沿既有 E2E 形态先 `createTestApp()`、取得 `PrismaService`，以 `assertConnectedTestDatabase(prisma)` 确认真实连接目标后才调用 `resetDb(app)`；不修改 `test/setup/**`，也不以环境变量名称或裸 SQL 猜测数据库安全。随后以真实 Nest 容器 `app.get(ParticipationSegmentFacade)` 调用，并覆盖：

- 同一活动多个 identity / 段、替换后的旧 revision、开放段、early-zero、voided、replaced；断言只读到 current 且字段/排序完整。
- 已变更的 identity 当前岗位与历史 check-in 岗位不同；断言返回后者。
- 通过受控测试夹具构造跨 identity/activity/session/member 的来源锚错误；断言 reader 失败而不是遗漏该行。
- 同一 tx 内新写可见，回滚后无新增 read result；Facade 不产生镜像行或任何持久副作用。
- 运行既有 `app-managed-activity-attendances.e2e-spec.ts` 与 `activity-service-segment-correction-lifecycle.e2e-spec.ts` 作为不改既有考勤/更正契约的定向回归。旧测试文件不修改。

本地验证顺序为：`pnpm agent:check:quick`、冷 `pnpm lint`、新增单元 spec、上述三个定向 E2E、`pnpm test:contract`、`pnpm docs:codemap` 后全部 docs check。全量 E2E/`agent:check:full` 的权威执行体是 PR CI 冷跑；不在本机连续榨干测试库后把假红当应用结论。合并后再独立核验 main CI。任何 query budget、同链或历史兼容探针失败时，停止并报告；不删断言、不放宽校验、不改 Gate 取绿。

## 6. 档位、授权与回退

预计是 **B 档**：只新增内部只读代码、模块 provider/export 和测试，不增加 endpoint、DTO、schema、migration、权限、审计、错误码或外部行为。对 §4 的 10 个精确未来路径已运行 `pnpm harness:needs`，结果为 0 个需要 grant；这只说明不触碰机器红区，**不**构成业务实施、数据库重建、提交、PR、合并或 Gate 授权。

未来实施开始前仍需维护者单独确认：

> 确认 D2 implementation 方案 A，按本稿 10 个精确路径执行；允许 `app_test_w98` 隔离验证及测试夹具重建；验证通过后提交、推送并创建 PR。不合并、不操作生产、不启用 Gate、不删除业务数据。

即使没有 migration，隔离 E2E 的测试库初始化/重建仍须由维护者按当时的实时许可执行；AI 不自动运行 `prisma migrate dev`、`migrate reset` 或 `db push`。若 main 在实施前变化，先重新跑 preflight、核对基点和全部 10 条 `harness:needs`；任何新增路径另行报批。

回退是停止新 Facade 的未来调用并回退代码；既有 PunchEvent、服务段修订及任何历史数据永久保留，不删库、不回填、不重算 `serviceHours`。

## 7. 本次未做

本轮只处理本计划、关联台账和计划 changelog；没有新增 Facade、模块 provider、测试，没有连接、迁移、重建数据库，没有修改 schema、现有生产消费者、API、DTO、权限、审计、Gate、客户端或部署，也没有删除业务数据。按顶部授权可提交、推送并创建计划 PR；D2 implementation、D3–D8、生产部署、Gate 和整体跨模型复审仍未完成。

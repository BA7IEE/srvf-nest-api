# attendances — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## 本地事实

- `attendances.service.ts` 是 **god-service(1157 行)**;`attendance-sheet-state-machine.ts` / `attendance-audit-recorder.ts` / `time-overlap-policy.ts` / `contribution-calculator.ts` 已抽离。
- `attendance_sheets` **5 态**(含终审);`attendance_records` 子表。
- 状态变更必须经过 `attendance-sheet-state-machine.ts`,**不**在 service 内裸写态迁移。
- 业务写路径必须走 `attendance-audit-recorder.ts` 写入 `AuditLogEvent`。

## 不要做(踩雷区)

- ❌ **不**主动拆 `attendances.service.ts`(characterization tests 已落地,但拆分本身需单独立项,沿 [`/docs/current-state.md §3`](../../../docs/current-state.md))。
- ❌ **不**主动启动 `attendances.controller.ts` 同文件 3 controller 物理拆分(**P1-C 第四步**,未启动,沿 [`/docs/api-surface-policy.md §7`](../../../docs/api-surface-policy.md))。
- ❌ **不**新增 Mixed Controller(class-level + 方法级双 `@ApiTags`)。
- ❌ **不**绕过 state-machine / audit-recorder 直接改 sheet 状态。
- ❌ **不**把 admin DTO 用 `extends` / `Pick` / `Omit` 派生为 App DTO(沿 §19.7 D-6);App DTO 进 `dto/app/`。
- ❌ App 视角 endpoint 进 `controllers/app-*.controller.ts`,where 子句永远用 `currentUser.memberId` 锁定本人。

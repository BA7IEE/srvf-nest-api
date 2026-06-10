# attendances — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## 本地事实

- `attendances.service.ts` 是 **god-service(1100 行,P1-4 第一刀后)**;`attendance-sheet-state-machine.ts` / `attendance-audit-recorder.ts` / `time-overlap-policy.ts` / `contribution-calculator.ts` / `attendance-presenter.ts`(P1-4 第一刀,2026-06-10)已抽离。
- 响应序列化必须走 `attendance-presenter.ts`(Sheet 详情 / 列表项 / Record 含 member 摘要 / Decimal→string),**不**在 service 内重新手写字段映射;select 查询策略仍留 service(归未来 QueryService 议题,第二刀另行立项)。
- `attendance_sheets` **5 态**(含终审);`attendance_records` 子表。
- 状态变更必须经过 `attendance-sheet-state-machine.ts`,**不**在 service 内裸写态迁移。
- 业务写路径必须走 `attendance-audit-recorder.ts` 写入 `AuditLogEvent`。

## 不要做(踩雷区)

- ❌ **不**主动拆 `attendances.service.ts`(characterization tests 已落地,但拆分本身需单独立项,沿 [`/docs/current-state.md §3`](../../../docs/current-state.md))。
- **Controller 现状**:`attendances.controller.ts` 仅 2 个 Admin class(`AttendanceSheetsCollectionController` + `AttendanceSheetsResourceController`,前缀 `admin/v1/*`);队员自助考勤记录(原 `/v2/users/me/attendance-records`)现位于 [`controllers/app-my-attendance-records.controller.ts`](controllers/app-my-attendance-records.controller.ts)(`@Controller('app/v1/my')`,`GET /attendance-records`)。历史 legacy controller(`attendances-me-records-legacy.controller.ts`)已于 Route B Phase 4d2 删除。
- ❌ **不**借此继续移动 Admin controller(`AttendanceSheetsCollectionController` / `AttendanceSheetsResourceController` 留在 `attendances.controller.ts`),除非另有设计决议。
- ❌ **不**改 App endpoint `GET /api/app/v1/my/attendance-records` 的 path / method / tag / roles / DTO / service call(contract-locked;改任一项升档并须显式更新 snapshot)。
- ❌ **不**借此启动 `attendances.service.ts` 拆分(沿上一条 god-service 禁条与 [`/docs/api-surface-policy.md §8`](../../../docs/api-surface-policy.md))。
- ❌ **不**在无 contract 审批下改 OpenAPI snapshot(沿 [`/docs/api-surface-policy.md §8`](../../../docs/api-surface-policy.md);改 path / DTO / schema 必须显式更新 snapshot 并升档)。
- ❌ **不**新增 Mixed Controller(class-level + 方法级双 `@ApiTags`)。
- ❌ **不**绕过 state-machine / audit-recorder 直接改 sheet 状态。
- ❌ **不**把 admin DTO 用 `extends` / `Pick` / `Omit` 派生为 App DTO(沿 §19.7 D-6);App DTO 进 `dto/app/`。
- ❌ App 视角 endpoint 进 `controllers/app-*.controller.ts`,where 子句永远用 `currentUser.memberId` 锁定本人。

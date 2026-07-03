# member-departments — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);终态 scoped-authz PR2 冻结稿 [`org-position-scoped-authz-terminal-design-review.md §3.1/§7.1/§8.1`](../../../docs/archive/reviews/org-position-scoped-authz-terminal-design-review.md);第二轮全仓 review G5 [`full-repo-systematic-review-v0.34.0.md`](../../../docs/archive/reviews/full-repo-systematic-review-v0.34.0.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

本目录物理上承载**两个面**,共写同一张表 `member_organization_memberships`:

- **`memberships.*`(新面,终态全归属面)**:沿队员轴嵌套 `admin/v1/members/:memberId/memberships`,显式承载 `membershipType`(PRIMARY/SECONDARY/TEMPORARY/SUPPORT)/ 任期 / `status`;PRIMARY 唯一由 partial unique 兜底,其余类型可并存多条。
- **`member-departments.*`(旧面,deprecated 但契约锁定)**:`admin/v1/members/:memberId/department`,重指向到 `memberships` 表的 **active PRIMARY** 行,GET/PUT/DELETE 响应 shape / 错误码逐字锁定不变。旧 `MemberDepartment` 表已 DROP(冻结表 cleanup,第 39 migration,2026-07-03)。

两面各自独立 `service`/`controller`/`dto` 文件(`memberships.*.ts` / `member-departments.*.ts`),**不互相调用**(旧面重指向的是底层表,不是新面的 service 方法)。

## Local facts

- **audit 留痕(review #484 G5,2026-07-03)**:4 个写点 inline-in-transaction 接入 `AuditLogsService`(沿 `position-assignments`/`supervision-assignments` 范式,`resourceType='membership'`):
  - `memberships.create` → `membership.set`(`extra.viaPath='membership', operation='create'`)
  - `memberships.end` → `membership.end`(`extra.viaPath='membership', operation='end'`)
  - `member-departments.set` → `membership.set`(`extra.viaPath='department', operation='set'`;仅真实发生状态变更的两分支〔首次建 / 换部门〕写,**幂等分支〔同 organizationId,无 DB 写〕不写**)
  - `member-departments.remove` → `membership.end`(`extra.viaPath='department', operation='remove'`)
  - 两个事件复用同一 `AuditLogEvent` 联合(`audit-logs.types.ts`),`extra.viaPath ∈ {membership, department}` 是区分两入口的唯一字段(伞事件范式,沿 `role-binding.*`)。
- **`memberships.update`(PATCH)不写 audit** —— 沿 `role-binding.update` / `supervision-assignment.update` 既有先例:PATCH 只改类型 / 任期 / 原因等非建 / 终字段,不构成建 / 终事件。**这是设计决定,不是遗漏**,未来若发现"PATCH 没有 audit"不要顺手加上,先确认是否有新的建 / 终语义混进 PATCH。
- 旧面 `MemberDepartmentsService` 与新面 `MembershipsService` 构造器均已注入 `AuditLogsService`(模块 `imports` 含 `AuditLogsModule`);两 service 各自定义本地 `AUDIT_RESOURCE_TYPE = 'membership'` 常量(不抽共享类,沿本仓 service 自包含范式)。

## Risk points(不要做)

- ❌ **不**给 `memberships.update`(PATCH)加 audit,除非有新设计决议(见上"Local facts")。
- ❌ **不**给 `member-departments.set` 的幂等分支(`current.organizationId === dto.organizationId` 直接 `return`)加 audit——该分支无 DB 写,加了就是记录"什么都没发生"的假事件。
- ❌ **不**给旧 `MemberDepartment` 表补任何读写代码(该表已物理 DROP,第 39 migration;本模块两 service 只读写 `member_organization_memberships`)。
- ❌ **不**把旧面 `member-departments.*` 端点的响应 shape / 错误码当作可自由调整项——PUT/GET/DELETE 三端点行为逐字锁定(重指向兼容层),真要变更走新面 `memberships.*`。
- ❌ 新增第三个写入口(若未来出现)务必同样接入 audit 并选一个新的 `extra.viaPath` 值,不要复用 `membership`/`department` 覆盖已有语义。

## Validation

- `pnpm test -- member-departments` — 两 service 的构造校验 / P2002 兜底 / audit 调用与否(create/end/set/remove 写,update/幂等分支不写)
- `pnpm test:e2e -- memberships\\.e2e-spec member-departments\\.e2e-spec` — 两面 HTTP 端点主成功 + 关键失败(权限边界 / NOT_FOUND / INACTIVE / 唯一约束)
- `pnpm test:e2e -- memberships-audit-characterization` — 4 写点 audit payload 形状(event/viaPath/before-after)+ PATCH 与幂等分支零 audit + 4 处 audit 写失败 → `$transaction` 回滚

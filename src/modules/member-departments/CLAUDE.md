# member-departments — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);终态 scoped-authz PR2 冻结稿 [`org-position-scoped-authz-terminal-design-review.md §3.1/§7.1/§8.1`](../../../docs/archive/reviews/org-position-scoped-authz-terminal-design-review.md);第二轮全仓 review G5 [`full-repo-systematic-review-v0.34.0.md`](../../../docs/archive/reviews/full-repo-systematic-review-v0.34.0.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

本目录物理上承载**两个面**,共写同一张表 `member_organization_memberships`:

- **`memberships.*`(新面,终态全归属面)**:沿队员轴嵌套 `admin/v1/members/:memberId/memberships`,显式承载 `membershipType`(PRIMARY/SECONDARY/TEMPORARY/SUPPORT)/ 任期 / `status`;PRIMARY 唯一由 partial unique 兜底,其余类型可并存多条。
- **`member-departments.*`(旧面,deprecated 但契约锁定)**:`admin/v1/members/:memberId/department`,重指向到 `memberships` 表的 **active PRIMARY** 行,GET/PUT/DELETE 响应 shape / 错误码逐字锁定不变。旧 `MemberDepartment` 表已 DROP(冻结表 cleanup,第 39 migration,2026-07-03)。

两面各自独立 `service`/`controller`/`dto` 文件(`memberships.*.ts` / `member-departments.*.ts`),**不互相调用**(旧面重指向的是底层表,不是新面的 service 方法)。

- **F4「D 组」扁平/组织轴增强面(2026-07-04;路线图 `admin-api-fe-integration-roadmap.md §4`)**:`MembershipsAdminController`(`@Controller('admin/v1')` 跨 memberships / organizations 两根)—— 分页总表(`GET /memberships`,过滤 + `expand=member,organization`〔D6 缺省不展开〕)/ detail(`GET /memberships/:id`,`membership.read.record` 预埋孤码实装)/ conflicts 只读诊断(`GET /memberships/conflicts`,4 类闭集:多 ACTIVE PRIMARY〔约束外 legacy 兜底〕/悬空队员/悬空组织/停用组织)/ **transfer 唯一写端点**(`POST /memberships/transfer`,单事务 end 旧 + create 新;先 end 后 create 释放 PRIMARY 唯一槽位;**源组织不做存在性/ACTIVE 校验** —— 迁出已软删/停用组织正是 conflicts 治理场景;源=目标 → 通用 400;新码 `membership.transfer.record` 绑 **biz-admin**)/ 组织轴归属分页(`GET /organizations/:orgId/memberships`)/ 组织轴队员下拉(`GET /organizations/:orgId/members/options`,**复用 `MembersService.options()` 同一份投影**,模块 imports += MembersModule/OrganizationsModule)。既有队员轴 4 端点逐字不动;静态段(conflicts/transfer)先于 GET :id 声明。

## Local facts

- **Membership 任期状态机(2026-07-18,原始风险 #8 收口)**:[`membership-term-state-machine.ts`](membership-term-state-machine.ts) 是唯一纯决策源。不支持定时生效/定时结束:ACTIVE 必须 `startedAt<=now AND endedAt=null`;ENDED 必须 `startedAt<=endedAt<=now`;SUSPENDED 必须 `endedAt=null` 且永不是当前有效源。结束仅 ACTIVE→ENDED，所有写入先锁 Member 行；第 59 migration 锁表审计后对存量异常 fail-fast，仅加 CHECK，零回填/零修数。
- **audit 留痕(review #484 G5,2026-07-03)**:4 个写点 inline-in-transaction 接入 `AuditLogsService`(沿 `position-assignments`/`supervision-assignments` 范式,`resourceType='membership'`):
  - `memberships.create` → `membership.set`(`extra.viaPath='membership', operation='create'`)
  - `memberships.end` → `membership.end`(`extra.viaPath='membership', operation='end'`)
  - `member-departments.set` → `membership.set`(`extra.viaPath='department', operation='set'`;仅真实发生状态变更的两分支〔首次建 / 换部门〕写,**幂等分支〔同 organizationId,无 DB 写〕不写**;set 的 audit `before`/`after` 仅含 id/memberId/organizationId,**不含 status/deletedAt** → v0.40.0 ENDED 收敛不影响 set audit 载荷)
  - `member-departments.remove` → `membership.end`(`extra.viaPath='department', operation='remove'`;**v0.40.0 参与域生命周期收口⑥:audit `after` 载荷由 `deletedAt` 翻面为 `{status:ENDED, endedAt, endedByUserId}`**)
- **v0.40.0 参与域生命周期收口⑥(归属结束语义收敛 ENDED)**:旧面 `set`(换部门分支)+ `remove` 两个写点由**软删**(`deletedAt=now`)收敛为 **`status=ENDED + endedAt + endedByUserId`**(对齐新面 `end`;镜像 transfer「先 end 后 create 释放 PRIMARY 唯一槽位」)。**旧面不再产生软删痕**——ENDED 历史行留在表内、`deletedAt=null`,新面 `GET members/:id/memberships`(`where deletedAt=null`,不过滤 status)可见该历史行(本刀存在的理由)。**对外契约逐字不变**:`primaryMembershipSelect` 不含 status/deletedAt/endedAt;`activePrimaryWhere` 同查 `deletedAt=null AND status=ACTIVE`(ENDED 行不匹配),故 DELETE 后 GET 仍返 null、旧面响应/错误码零变;partial unique 仅约束 ACTIVE 故槽位释放正常。**白盒 DB 断言随收敛翻面**(member-departments.e2e:`deletedAt not null` → `status=ENDED`;`count(deletedAt:null)` 须补 `status:ACTIVE` 过滤才仍是 active 计数),非对外契约翻面(维护者 2026-07-11 拍板确认)。
  - 两个事件复用同一 `AuditLogEvent` 联合(`audit-logs.types.ts`),`extra.viaPath ∈ {membership, department}` 是区分两入口的唯一字段(伞事件范式,沿 `role-binding.*`)。
  - **F4(2026-07-04)第三写入口 transfer** → 新事件 `membership.transfer`(goal 显式预授权的唯一 +1 AuditLogEvent;`extra.viaPath='membership-transfer'` 沿下方「新写入口取新 viaPath 值」铁律;resourceId=新行,extra 带 from/toOrganizationId + endedMembershipId)。**一次迁移一条留痕**:transfer 的 end+create 两腿**不**再各写 `membership.set`/`membership.end`(与逐条操作的审计语义刻意区分,查账时一条 transfer 即完整因果)。
- **`memberships.update`(PATCH)不写 audit** —— 沿 `role-binding.update` / `supervision-assignment.update` 既有先例:PATCH 只改类型 / 任期 / 原因等非建 / 终字段,不构成建 / 终事件。**这是设计决定,不是遗漏**,未来若发现"PATCH 没有 audit"不要顺手加上,先确认是否有新的建 / 终语义混进 PATCH。
- 旧面 `MemberDepartmentsService` 与新面 `MembershipsService` 构造器均已注入 `AuditLogsService`(模块 `imports` 含 `AuditLogsModule`);两 service 各自定义本地 `AUDIT_RESOURCE_TYPE = 'membership'` 常量(不抽共享类,沿本仓 service 自包含范式)。

## Risk points(不要做)

- ❌ **不**给 `memberships.update`(PATCH)加 audit,除非有新设计决议(见上"Local facts")。
- ❌ **不**给 `member-departments.set` 的幂等分支(`current.organizationId === dto.organizationId` 直接 `return`)加 audit——该分支无 DB 写,加了就是记录"什么都没发生"的假事件。
- ❌ **不**给旧 `MemberDepartment` 表补任何读写代码(该表已物理 DROP,第 39 migration;本模块两 service 只读写 `member_organization_memberships`)。
- ❌ **不**把旧面 `member-departments.*` 端点的响应 shape / 错误码当作可自由调整项——PUT/GET/DELETE 三端点行为逐字锁定(重指向兼容层),真要变更走新面 `memberships.*`。
- ❌ 新增第四个写入口(若未来出现)务必同样接入 audit 并选一个新的 `extra.viaPath` 值,不要复用 `membership`/`department`/`membership-transfer` 覆盖已有语义(第三入口 = F4 transfer,已按此铁律落地)。
- ❌ **不**把 transfer 拆回「调 end() + 调 create()」两段式(会产生两条 audit + 两次独立判权 + 失去单事务原子性;transfer 的一条 `membership.transfer` 留痕与 P2002 整体回滚是拍板语义)。

## Validation

- `pnpm test -- member-departments` — 两 service 的构造校验 / P2002 兜底 / audit 调用与否(create/end/set/remove 写,update/幂等分支不写)
- `pnpm test:e2e -- memberships\\.e2e-spec member-departments\\.e2e-spec` — 两面 HTTP 端点主成功 + 关键失败(权限边界 / NOT_FOUND / INACTIVE / 唯一约束)
- `pnpm test:e2e -- memberships-audit-characterization` — 4 写点 audit payload 形状(event/viaPath/before-after)+ PATCH 与幂等分支零 audit + 4 处 audit 写失败 → `$transaction` 回滚
- `pnpm test:e2e -- memberships-f4-admin` — F4 七端点(分页/detail/conflicts/transfer〔含 audit 落痕 + 17004 原子回滚〕/组织轴两路/tree-with-summary)
- `pnpm test -- membership-term-state-machine member-departments` + `pnpm test:e2e -- memberships memberships-f4-admin authz-resource-resolver` — 任期不变式、真并发 create/transfer/end、槽位释放、权限来源即时失效与回滚

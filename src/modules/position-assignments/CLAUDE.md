# position-assignments — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)。本文件只记录任职执行容易回归的当前事实。

## 单一 policy 与锁序

- [`position-assignment-policy.ts`](position-assignment-policy.ts) 是新任命时职务规则的唯一执行点。`create` 与 `preview` 共用它;preview 不取写锁,只是时点建议,最终以 create 为准。
- 写路径在同一事务内按 `Member → OrganizationPosition → matching OrganizationPositionRule` 锁序执行,然后重读 active assignments 与 holder count。不得改回 count 后裸 insert。
- Member 锁与 offboard/revoke 共用 `lockMemberLifecycle`;同一人跨职务并发任命必须串行。Position 锁按职务全局串行其各组织的人数上限重算。

## 字段执行口径

- 新任命同时要求 Position 与 matching Rule 都是 `ACTIVE`;停用只禁止新任命,不追溯撤销已有 assignment,也不直接翻转 AuthzService 已有任职口径。
- 人数上限是严格交集:`Position.allowMultiple=false` 等价于上限 1,再与 `Rule.maxCount` 取较小值;`maxCount=null` 表示规则层不限。上限命中保持既有 `32023`。
- 兼任是严格交集:新任职的 `Position.allowConcurrent && Rule.allowConcurrent` 必须为真,且每个已有任职的 Position/Rule 也必须允许兼任;任一方禁止就返回既有 `32024`。
- `Rule.requireMembership=true` 按 MembershipTermStateMachine 的“当前有效”口径查本组织或 closure 祖先归属;SUSPENDED/ENDED/未生效归属不算。
- `Rule.required/minCount` 当前是 advisory/reserved:写配置时校验语义一致,但不阻断 revoke/offboard 或人员安全。没有补位/合规工作流前不得伪造下限 enforcement。
- Rule PATCH 在合并现值前先锁定该 Rule 行,避免并发局部更新各自校验通过后组合出非法基数。

## 保持不变的边界

- 本收口不新增 endpoint、DTO 字段、BizCode、Permission、AuditEvent 或 schema/migration。`rank/isLeadership/categoryCode` 仍是排序/元数据;assignment 没有 update 端点。
- `isConcurrent` 仍是公告回填标记,不能用它绕过 Position/Rule 的兼任约束。
- 撤销必须先锁 Member 后重读 assignment;required/minCount 不得被加到撤销或 offboard 守卫。

## Validation

- `pnpm test -- position-assignment-policy position-assignments positions`
- `pnpm test:e2e -- positions\\.e2e-spec position-assignments\\.e2e-spec position-assignment-policy-concurrency members-offboard`
- 真并发 spec 必须保持两套独立 Nest app/Prisma pool 与 PostgreSQL 锁等待编排;不得降级成串行 `Promise.all` 表演。

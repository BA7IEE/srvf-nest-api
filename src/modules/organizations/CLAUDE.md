# organizations — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);终态 scoped-authz PR1 冻结稿 [`org-position-scoped-authz-terminal-design-review.md §8.3/§11 PR1`](../../../docs/archive/reviews/org-position-scoped-authz-terminal-design-review.md);第二轮全仓 review G18 [`full-repo-systematic-review-v0.34.0.md`](../../../docs/archive/reviews/full-repo-systematic-review-v0.34.0.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- `admin/v1/organizations` 7 端点:`list`/`tree`/`create`/`findOne`/`update`/`updateStatus`/`move`/`softDelete`(closure 树形结构管理;V2 第一阶段单根上限 1)。
- `organization_closure` 闭包表维护发生在 `create`(自身 depth-0 + 继承父祖先各 +1)与 `move`(删旧祖先→子树边 + 按新父插入)两处。
- `create()` 含 `DryRunAbort` 沙箱哨兵(`options?: { dryRun?: boolean }`),供 `announcement-import` 批量导入 preview 零写入复用同一份真实校验(镜像 position-assignments/supervision-assignments 同名类,不共享)。

## Local facts

- **audit 留痕(review #484 G18 → NEXT_TASKS P1-16,2026-07-03)**:4 个写点 inline-in-transaction 接入 `AuditLogsService`(沿 `position-assignments`/`supervision-assignments` 范式,`resourceType='organization'`):
  - `create` → `organization.create`(after 快照,before 缺席;**写在 `DryRunAbort` 哨兵之前、同一事务内**——`announcement-import` 预览零写入靠事务整体回滚自动覆盖 audit,不需要为 dryRun 另写分支)
  - `move` → `organization.move`(before/after `parentId`;树结构 + scoped 判权范围变更;**同父幂等 no-op 分支不写**——无实际变更)
  - `updateStatus` → `organization.status-change`(before/after `status`;INACTIVE 会使 `covers()` 拒绝 scoped grant,归 authz 相关状态变更)
  - `softDelete` → `organization.delete`(仅 before 快照,沿 `certificate.delete`/`content.delete` 纯删除既有先例,无 after)
- **`update`(PATCH)不写 audit** —— 沿 `role-binding.update` / `supervision-assignment.update` / `memberships.update` 均不审计的既有先例:只改 `name`/`sortOrder`/`nodeTypeCode` 等非建/终/树结构/授权状态字段,不构成审计事件。**这是设计决定,不是遗漏**,未来若发现"PATCH 没有 audit"不要顺手加上,先确认是否有新的建/终/树结构变更语义混进 PATCH。
- `OrganizationsService` 构造器已注入 `AuditLogsService`(模块 `imports` 含 `AuditLogsModule`);本地定义 `AUDIT_RESOURCE_TYPE = 'organization'` 常量(不抽共享类,沿本仓 service 自包含范式)。
- `announcement-import` 批量导入复用同一个 `create()` 方法(含 `meta` 透传),批量场景因此**自动**获得逐行审计轨迹——不在 `announcement-import` 模块内另造一份 audit 逻辑(沿 review #484 G18 原判)。

## Risk points(不要做)

- ❌ **不**给 `update`(PATCH)加 audit,除非有新设计决议(见上"Local facts")。
- ❌ **不**给 `move` 的同父幂等 no-op 分支(`target.parentId === dto.parentId` 直接 `return`)加 audit——该分支无 DB 写,加了就是记录"什么都没发生"的假事件。
- ❌ **不**把 `create()` 的 audit 调用挪到 `DryRunAbort` 判断之后——必须在同一事务内、哨兵抛出之前,否则 `announcement-import` 预览会真实写入 audit 行(破坏零写入行为锁)。
- ❌ **不**因为新增 `meta` 参数就顺手改变 5 个方法的响应 shape / 错误码 / 校验顺序 / closure 维护逻辑。
- ❌ 新增第五个写入口(若未来出现)务必同样接入 audit,并按其语义归类是否属于「建 / 树结构变更 / 授权相关状态变更 / 终」四类,不要不假思索都审计或都不审计。

## Validation

- `pnpm test:e2e -- organizations-audit-characterization` —— 4 写点 audit payload 形状 + update/幂等 no-op 零 audit + 4 处 audit 写失败 → `$transaction` 回滚
- `pnpm test:e2e -- organizations\.e2e-spec` —— 既有 CRUD / 单根上限 / closure / move 主路径逐字不变
- `pnpm test:e2e -- announcement-import\.e2e-spec` —— preview 零写入断言(含 `auditLog` count)零修改全绿 + execute 批量 audit 行数断言

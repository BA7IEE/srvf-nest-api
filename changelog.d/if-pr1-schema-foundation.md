---
"feat(prisma)": Integration Foundation v1 PR1 —— 第 100 条 migration:六新表+枚举+资格门+双主体审计列(P1-30,纯 schema 零运行时)

- PrincipalType +SERVICE_PRINCIPAL(终态五值);新枚举 ServicePrincipalStatus / DelegationGrantStatus
- 新表:service_principals / service_principal_credentials / delegation_grants /
  delegation_grant_permissions / integration_command_receipts(幂等三键唯一)
- Permission +servicePrincipalAllowed/delegatedAccessAllowed(默认 false 零回填;
  CHECK:delegated ⇒ servicePrincipal)
- AuditLog +4 双主体列 + 3 FK + 4 CHECK(二值表达,三项全 null 放行)
- DelegationGrant:scope 形状闭集 CHECK + endedAt>startedAt CHECK
- e2e 15 用例:每条 CHECK 双向变异对拍(违规 23514 / 合法穿过至 23503);
  枚举五值;零回填;幂等唯一 23505;spec 启动即干净库 100 条全量重放
- domain-map:新域 integration-foundation + 空壳属主模块(PR2 拆四实体模块);
  state-machines 摘要随 schema 刷新;clock-authority 新列分类(startedAt/completedAt 豁免)

BREAKING: 无(纯 schema;零运行时零端点零 seed)

<!-- contract-breaking
operation: GET /api/admin/v1/role-bindings
reason: 列表是双侧面:query 枚举扩值(服务端接受新值,PR2 前传入即 30100 校验拒,不产生新行为)+ 列表项响应枚举加值。枚举源自 Prisma PrincipalType,PR1 为终态五值落地 schema(规格书 §15.2);query:principalType 入参与 data[].principal.type 响应。
impact: 事实读数 —— 前端 srvf-admin-web 尚未上线,无任何线上客户端;且 PR2 之前全仓无任何写路径能产出 SERVICE_PRINCIPAL 绑定 ⇒ 实际影响面双零。潜在影响 = 对 principalType 写穷尽 switch 且无 default 的调用方。
migration: 调用方补 SERVICE_PRINCIPAL 分支(渲染为「服务主体」,PR2 前读不到/传入被拒)或 default 兜底;新值追加在枚举末尾,按下标读的实现不受影响。
rollback: revert 本 PR(代码 + migration 一并回退)。⚠️ ALTER TYPE ADD VALUE 不可逆:生产未 deploy ⇒ 库内恒无该值,revert 重放安全;若已 deploy 且已存在 SERVICE_PRINCIPAL 绑定行再回滚旧二进制,须维护者先清理该类绑定行(规格书 §53.1,不可自动执行)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/role-bindings
reason: 双侧面:入参枚举扩值(PR2 前 SERVICE_PRINCIPAL 会被既有校验拒,无新行为)+ 响应枚举加值。枚举源自 Prisma PrincipalType,PR1 为终态五值落地 schema(规格书 §15.2);body.principalType 入参与响应 principal.type。
impact: 事实读数 —— 前端 srvf-admin-web 尚未上线,无任何线上客户端;且 PR2 之前全仓无任何写路径能产出 SERVICE_PRINCIPAL 绑定 ⇒ 实际影响面双零。潜在影响 = 对 principalType 写穷尽 switch 且无 default 的调用方。
migration: 调用方补 SERVICE_PRINCIPAL 分支(渲染为「服务主体」,PR2 前读不到/传入被拒)或 default 兜底;新值追加在枚举末尾,按下标读的实现不受影响。
rollback: revert 本 PR(代码 + migration 一并回退)。⚠️ ALTER TYPE ADD VALUE 不可逆:生产未 deploy ⇒ 库内恒无该值,revert 重放安全;若已 deploy 且已存在 SERVICE_PRINCIPAL 绑定行再回滚旧二进制,须维护者先清理该类绑定行(规格书 §53.1,不可自动执行)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/role-bindings/{id}
reason: 详情响应枚举加值;PR1 零运行时,PR2 前无产出路径。枚举源自 Prisma PrincipalType,PR1 为终态五值落地 schema(规格书 §15.2);响应 data.principal.type。
impact: 事实读数 —— 前端 srvf-admin-web 尚未上线,无任何线上客户端;且 PR2 之前全仓无任何写路径能产出 SERVICE_PRINCIPAL 绑定 ⇒ 实际影响面双零。潜在影响 = 对 principalType 写穷尽 switch 且无 default 的调用方。
migration: 调用方补 SERVICE_PRINCIPAL 分支(渲染为「服务主体」,PR2 前读不到/传入被拒)或 default 兜底;新值追加在枚举末尾,按下标读的实现不受影响。
rollback: revert 本 PR(代码 + migration 一并回退)。⚠️ ALTER TYPE ADD VALUE 不可逆:生产未 deploy ⇒ 库内恒无该值,revert 重放安全;若已 deploy 且已存在 SERVICE_PRINCIPAL 绑定行再回滚旧二进制,须维护者先清理该类绑定行(规格书 §53.1,不可自动执行)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/role-bindings/{id}
reason: 更新响应连坐加值;本端点语义未变。枚举源自 Prisma PrincipalType,PR1 为终态五值落地 schema(规格书 §15.2);响应 data.principalType 与 data.principal.type 两处。
impact: 事实读数 —— 前端 srvf-admin-web 尚未上线,无任何线上客户端;且 PR2 之前全仓无任何写路径能产出 SERVICE_PRINCIPAL 绑定 ⇒ 实际影响面双零。潜在影响 = 对 principalType 写穷尽 switch 且无 default 的调用方。
migration: 调用方补 SERVICE_PRINCIPAL 分支(渲染为「服务主体」,PR2 前读不到/传入被拒)或 default 兜底;新值追加在枚举末尾,按下标读的实现不受影响。
rollback: revert 本 PR(代码 + migration 一并回退)。⚠️ ALTER TYPE ADD VALUE 不可逆:生产未 deploy ⇒ 库内恒无该值,revert 重放安全;若已 deploy 且已存在 SERVICE_PRINCIPAL 绑定行再回滚旧二进制,须维护者先清理该类绑定行(规格书 §53.1,不可自动执行)。
-->

<!-- contract-breaking
operation: DELETE /api/admin/v1/role-bindings/{id}
reason: 删除回显连坐加值。枚举源自 Prisma PrincipalType,PR1 为终态五值落地 schema(规格书 §15.2);响应(回吐被删绑定)。
impact: 事实读数 —— 前端 srvf-admin-web 尚未上线,无任何线上客户端;且 PR2 之前全仓无任何写路径能产出 SERVICE_PRINCIPAL 绑定 ⇒ 实际影响面双零。潜在影响 = 对 principalType 写穷尽 switch 且无 default 的调用方。
migration: 调用方补 SERVICE_PRINCIPAL 分支(渲染为「服务主体」,PR2 前读不到/传入被拒)或 default 兜底;新值追加在枚举末尾,按下标读的实现不受影响。
rollback: revert 本 PR(代码 + migration 一并回退)。⚠️ ALTER TYPE ADD VALUE 不可逆:生产未 deploy ⇒ 库内恒无该值,revert 重放安全;若已 deploy 且已存在 SERVICE_PRINCIPAL 绑定行再回滚旧二进制,须维护者先清理该类绑定行(规格书 §53.1,不可自动执行)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/role-bindings/page
reason: 分页双侧面同列表。枚举源自 Prisma PrincipalType,PR1 为终态五值落地 schema(规格书 §15.2);query:principalType 入参与分页行响应。
impact: 事实读数 —— 前端 srvf-admin-web 尚未上线,无任何线上客户端;且 PR2 之前全仓无任何写路径能产出 SERVICE_PRINCIPAL 绑定 ⇒ 实际影响面双零。潜在影响 = 对 principalType 写穷尽 switch 且无 default 的调用方。
migration: 调用方补 SERVICE_PRINCIPAL 分支(渲染为「服务主体」,PR2 前读不到/传入被拒)或 default 兜底;新值追加在枚举末尾,按下标读的实现不受影响。
rollback: revert 本 PR(代码 + migration 一并回退)。⚠️ ALTER TYPE ADD VALUE 不可逆:生产未 deploy ⇒ 库内恒无该值,revert 重放安全;若已 deploy 且已存在 SERVICE_PRINCIPAL 绑定行再回滚旧二进制,须维护者先清理该类绑定行(规格书 §53.1,不可自动执行)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/role-bindings/preview
reason: 纯入参扩值;preview 对 SERVICE_PRINCIPAL 的预览在 PR2 前返回零匹配。枚举源自 Prisma PrincipalType,PR1 为终态五值落地 schema(规格书 §15.2);query:principalType。
impact: 事实读数 —— 前端 srvf-admin-web 尚未上线,无任何线上客户端;且 PR2 之前全仓无任何写路径能产出 SERVICE_PRINCIPAL 绑定 ⇒ 实际影响面双零。潜在影响 = 对 principalType 写穷尽 switch 且无 default 的调用方。
migration: 调用方补 SERVICE_PRINCIPAL 分支(渲染为「服务主体」,PR2 前读不到/传入被拒)或 default 兜底;新值追加在枚举末尾,按下标读的实现不受影响。
rollback: revert 本 PR(代码 + migration 一并回退)。⚠️ ALTER TYPE ADD VALUE 不可逆:生产未 deploy ⇒ 库内恒无该值,revert 重放安全;若已 deploy 且已存在 SERVICE_PRINCIPAL 绑定行再回滚旧二进制,须维护者先清理该类绑定行(规格书 §53.1,不可自动执行)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/role-bindings/batch
reason: 批量入参扩值;PR2 前该值过校验即拒,整单回滚,无新行为。枚举源自 Prisma PrincipalType,PR1 为终态五值落地 schema(规格书 §15.2);items[].principalType。
impact: 事实读数 —— 前端 srvf-admin-web 尚未上线,无任何线上客户端;且 PR2 之前全仓无任何写路径能产出 SERVICE_PRINCIPAL 绑定 ⇒ 实际影响面双零。潜在影响 = 对 principalType 写穷尽 switch 且无 default 的调用方。
migration: 调用方补 SERVICE_PRINCIPAL 分支(渲染为「服务主体」,PR2 前读不到/传入被拒)或 default 兜底;新值追加在枚举末尾,按下标读的实现不受影响。
rollback: revert 本 PR(代码 + migration 一并回退)。⚠️ ALTER TYPE ADD VALUE 不可逆:生产未 deploy ⇒ 库内恒无该值,revert 重放安全;若已 deploy 且已存在 SERVICE_PRINCIPAL 绑定行再回滚旧二进制,须维护者先清理该类绑定行(规格书 §53.1,不可自动执行)。
-->

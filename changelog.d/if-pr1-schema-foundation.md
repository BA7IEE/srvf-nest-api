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
operation: GET /api/admin/v1/role-bindings/{id}
reason: 响应 data.principal.type 枚举加值 SERVICE_PRINCIPAL —— 枚举源自 Prisma PrincipalType,PR1 为终态五值落地 schema(规格书 §15.2)。单值枚举无法改写成 additive;值仅在存在 SERVICE_PRINCIPAL 绑定时出现,而 PR1 零运行时,不可能创建此类绑定(控制面是 PR2)。
impact: 事实读数 —— 前端 srvf-admin-web 尚未上线,无任何线上客户端消费本端点;且 PR2 之前全仓无任何写路径能产出 SERVICE_PRINCIPAL 绑定 ⇒ 实际影响面双零。潜在影响 = 将来对 principal.type 写穷尽 switch 且无 default 的调用方。
migration: 调用方为 principal.type 补 SERVICE_PRINCIPAL 分支(渲染为「服务主体」,PR2 前读不到)或 default 兜底;新值追加在枚举末尾,按下标读的实现不受影响。
rollback: revert 本 PR(代码 + migration 一并回退)。⚠️ ALTER TYPE ADD VALUE 不可逆:生产未 deploy ⇒ 库内恒无该值,revert 重放安全;若已 deploy 且已存在 SERVICE_PRINCIPAL 绑定行再回滚旧二进制,须维护者先清理该类绑定行(规格书 §53.1,不可自动执行)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/role-bindings/{id}
reason: 响应 data.principalType 与 data.principal.type 两处枚举连坐同一加值(同 GET);本端点自身语义未变,PR1 也不改任何 principal 校验逻辑。
impact: 同 GET —— 前端未上线 + PR2 前无产出路径,双零;潜在影响 = 穷尽 switch 无 default 的调用方。
migration: 同族处置 —— 补 SERVICE_PRINCIPAL 分支或 default 兜底;枚举新值在末尾。
rollback: revert 本 PR;ALTER TYPE 不可逆边界同 GET 块。
-->

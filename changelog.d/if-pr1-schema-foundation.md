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

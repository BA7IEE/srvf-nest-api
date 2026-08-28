-- ═══════════════════════════════════════════════════════════════════════
-- 第 100 条 migration:Integration Foundation v1 — PR1 Schema 地基
-- (规格书 §27–§33;T0 冻结稿 §8;维护者 2026-08-28 拍板开工)
--
-- 纯 schema 刀:零运行时、零端点、零 seed、零回填(存量 Permission 的两个资格门
-- 沿列默认 false,234 个权限一条也不自动开放给机器)。
--
-- ⚠️ 本 migration 的手写 CHECK(Prisma DSL 表达不了的部分)逐条列出,每条都在
--    e2e `integration-foundation-pr1-schema.e2e-spec.ts` 做**双向变异对拍**
--    (违规行必被 23514 拒 / 合法形状行通过 CHECK 后才落到 FK 检查 23503)——
--    沿 T0 冻结稿 §12.2 红字:「只看 migration 跑通」不算数。
--
-- 不可逆边界(规格书 §53.1):`ALTER TYPE ... ADD VALUE` 不可删(沿
-- add_sms_purpose_login 范式);激活后回滚旧二进制须先清理 SERVICE_PRINCIPAL
-- 绑定行(维护者审批,AI 恒不自动执行)。
-- ═══════════════════════════════════════════════════════════════════════

-- ① PrincipalType 增值(本事务内不使用新值 ⇒ 与既有 ADD VALUE 迁移同样安全)。
ALTER TYPE "PrincipalType" ADD VALUE 'SERVICE_PRINCIPAL';

-- ② 两个新枚举。
CREATE TYPE "ServicePrincipalStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "DelegationGrantStatus" AS ENUM ('ACTIVE', 'REVOKED', 'SUSPENDED');

-- ③ 机器身份表。
CREATE TABLE "service_principals" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ServicePrincipalStatus" NOT NULL DEFAULT 'ACTIVE',
    "ownerOrganizationId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "service_principals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "service_principals_clientId_key" ON "service_principals"("clientId");
CREATE INDEX "service_principals_status_idx" ON "service_principals"("status");
CREATE INDEX "service_principals_ownerOrganizationId_idx" ON "service_principals"("ownerOrganizationId");
CREATE INDEX "service_principals_deletedAt_idx" ON "service_principals"("deletedAt");
ALTER TABLE "service_principals"
  ADD CONSTRAINT "service_principals_ownerOrganizationId_fkey"
    FOREIGN KEY ("ownerOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "service_principals_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ④ 机器凭证表(身份与凭证分离;同 SP ≤2 条 ACTIVE 是 PR2 运行时锁后计数,不是跨行 DB CHECK)。
CREATE TABLE "service_principal_credentials" (
    "id" TEXT NOT NULL,
    "servicePrincipalId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "service_principal_credentials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "service_principal_credentials_secretHash_key" ON "service_principal_credentials"("secretHash");
CREATE INDEX "service_principal_credentials_servicePrincipalId_revokedAt_idx" ON "service_principal_credentials"("servicePrincipalId", "revokedAt");
CREATE INDEX "service_principal_credentials_expiresAt_idx" ON "service_principal_credentials"("expiresAt");
ALTER TABLE "service_principal_credentials"
  ADD CONSTRAINT "service_principal_credentials_servicePrincipalId_fkey"
    FOREIGN KEY ("servicePrincipalId") REFERENCES "service_principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "service_principal_credentials_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "service_principal_credentials_revokedByUserId_fkey"
    FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⑤ Permission 资格门两列:零回填(存量行沿默认 false)。
ALTER TABLE "permissions"
  ADD COLUMN "servicePrincipalAllowed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "delegatedAccessAllowed" BOOLEAN NOT NULL DEFAULT false;

-- CHECK-P1:delegatedAccessAllowed ⇒ servicePrincipalAllowed(规格书 §15.1;
-- 三层守护的第一层,seed 自检与运行时过滤是 PR2/PR4)。
ALTER TABLE "permissions"
  ADD CONSTRAINT "permission_integration_eligibility_check"
  CHECK ("delegatedAccessAllowed" = false OR "servicePrincipalAllowed" = true);

-- ⑥ 委托表。
CREATE TABLE "delegation_grants" (
    "id" TEXT NOT NULL,
    "servicePrincipalId" TEXT NOT NULL,
    "subjectUserId" TEXT NOT NULL,
    "status" "DelegationGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "scopeType" "BindingScopeType" NOT NULL,
    "scopeOrgId" TEXT,
    "scopeActivityId" TEXT,
    "scopeResourceType" TEXT,
    "scopeResourceId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "delegation_grants_pkey" PRIMARY KEY ("id"),
    -- CHECK-D1:endedAt 非空时必须晚于 startedAt(规格书 §30)。
    CONSTRAINT "delegation_grant_period_check"
    CHECK ("endedAt" IS NULL OR "endedAt" > "startedAt"),
    -- CHECK-D2:scope 形状闭集(规格书 §30;RoleBinding 无既有 DB CHECK,这里按
    -- BindingScopeType 六值逐值钉死形状 —— 比存量 RoleBinding 更严,是增量收紧)。
    CONSTRAINT "delegation_grant_scope_shape_check"
    CHECK (
      ("scopeType" = 'GLOBAL' AND "scopeOrgId" IS NULL AND "scopeActivityId" IS NULL AND "scopeResourceType" IS NULL AND "scopeResourceId" IS NULL)
      OR ("scopeType" IN ('ORGANIZATION', 'ORGANIZATION_TREE') AND "scopeOrgId" IS NOT NULL AND "scopeActivityId" IS NULL AND "scopeResourceType" IS NULL AND "scopeResourceId" IS NULL)
      OR ("scopeType" = 'ACTIVITY' AND "scopeActivityId" IS NOT NULL AND "scopeOrgId" IS NULL AND "scopeResourceType" IS NULL AND "scopeResourceId" IS NULL)
      OR ("scopeType" = 'RESOURCE' AND "scopeResourceType" IS NOT NULL AND "scopeResourceId" IS NOT NULL AND "scopeOrgId" IS NULL AND "scopeActivityId" IS NULL)
      OR ("scopeType" = 'SELF' AND "scopeOrgId" IS NULL AND "scopeActivityId" IS NULL AND "scopeResourceType" IS NULL AND "scopeResourceId" IS NULL)
    )
);
CREATE INDEX "delegation_grants_servicePrincipalId_status_idx" ON "delegation_grants"("servicePrincipalId", "status");
CREATE INDEX "delegation_grants_subjectUserId_status_idx" ON "delegation_grants"("subjectUserId", "status");
CREATE INDEX "delegation_grants_endedAt_idx" ON "delegation_grants"("endedAt");
ALTER TABLE "delegation_grants"
  ADD CONSTRAINT "delegation_grants_servicePrincipalId_fkey"
    FOREIGN KEY ("servicePrincipalId") REFERENCES "service_principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "delegation_grants_subjectUserId_fkey"
    FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "delegation_grants_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "delegation_grants_revokedByUserId_fkey"
    FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⑦ 委托权限 allowlist。
CREATE TABLE "delegation_grant_permissions" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "delegation_grant_permissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "delegation_grant_permissions_grantId_permissionId_key" ON "delegation_grant_permissions"("grantId", "permissionId");
CREATE INDEX "delegation_grant_permissions_permissionId_idx" ON "delegation_grant_permissions"("permissionId");
ALTER TABLE "delegation_grant_permissions"
  ADD CONSTRAINT "delegation_grant_permissions_grantId_fkey"
    FOREIGN KEY ("grantId") REFERENCES "delegation_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "delegation_grant_permissions_permissionId_fkey"
    FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⑧ 幂等回执表。
CREATE TABLE "integration_command_receipts" (
    "id" TEXT NOT NULL,
    "servicePrincipalId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "delegationGrantId" TEXT,
    "subjectUserId" TEXT,
    "operation" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "responseSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_command_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "integration_command_receipts_servicePrincipalId_operation_i_key" ON "integration_command_receipts"("servicePrincipalId", "operation", "idempotencyKey");
CREATE INDEX "integration_command_receipts_credentialId_idx" ON "integration_command_receipts"("credentialId");
CREATE INDEX "integration_command_receipts_delegationGrantId_idx" ON "integration_command_receipts"("delegationGrantId");
CREATE INDEX "integration_command_receipts_subjectUserId_idx" ON "integration_command_receipts"("subjectUserId");
CREATE INDEX "integration_command_receipts_createdAt_idx" ON "integration_command_receipts"("createdAt");
ALTER TABLE "integration_command_receipts"
  ADD CONSTRAINT "integration_command_receipts_servicePrincipalId_fkey"
    FOREIGN KEY ("servicePrincipalId") REFERENCES "service_principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "integration_command_receipts_credentialId_fkey"
    FOREIGN KEY ("credentialId") REFERENCES "service_principal_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "integration_command_receipts_delegationGrantId_fkey"
    FOREIGN KEY ("delegationGrantId") REFERENCES "delegation_grants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "integration_command_receipts_subjectUserId_fkey"
    FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⑨ AuditLog 双主体审计:4 列 + 3 FK + 4 CHECK(规格书 §22;T0 冻结稿 §12)。
--    🔴 CHECK 判定全部用 IS NULL / IS NOT NULL 二值表达 —— 不吃 NULL 边界静默失效的亏。
ALTER TABLE "audit_logs"
  ADD COLUMN "actorServicePrincipalId" TEXT,
  ADD COLUMN "actorCredentialId" TEXT,
  ADD COLUMN "onBehalfOfUserId" TEXT,
  ADD COLUMN "onBehalfOfRoleSnap" "Role";

-- CHECK-A1:actorUser 与 actorServicePrincipal 互斥(真人/机器二选一)。
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_log_actor_exclusivity_check"
  CHECK (NOT ("actorUserId" IS NOT NULL AND "actorServicePrincipalId" IS NOT NULL));

-- CHECK-A2:onBehalfOfUser 只能由机器代(真人直接操作没有 onBehalfOf)。
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_log_on_behalf_of_requires_sp_check"
  CHECK ("onBehalfOfUserId" IS NULL OR "actorServicePrincipalId" IS NOT NULL);

-- CHECK-A3:credential 只能作为机器 actor 的证据出现。
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_log_credential_requires_sp_check"
  CHECK ("actorCredentialId" IS NULL OR "actorServicePrincipalId" IS NOT NULL);

-- CHECK-A4:角色快照只属于被代表的真人。
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_log_role_snap_requires_on_behalf_of_check"
  CHECK ("onBehalfOfRoleSnap" IS NULL OR "onBehalfOfUserId" IS NOT NULL);

-- ⚠️ 四条 CHECK 对「三项全 null」全部放行(SRVF 内部系统任务的 12 处现存形态,F-10)。
CREATE INDEX "audit_logs_actorServicePrincipalId_createdAt_idx" ON "audit_logs"("actorServicePrincipalId", "createdAt");
CREATE INDEX "audit_logs_onBehalfOfUserId_createdAt_idx" ON "audit_logs"("onBehalfOfUserId", "createdAt");
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_actorServicePrincipalId_fkey"
    FOREIGN KEY ("actorServicePrincipalId") REFERENCES "service_principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "audit_logs_actorCredentialId_fkey"
    FOREIGN KEY ("actorCredentialId") REFERENCES "service_principal_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "audit_logs_onBehalfOfUserId_fkey"
    FOREIGN KEY ("onBehalfOfUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

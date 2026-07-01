-- 终态 scoped-authz PR6「RoleBinding」(2026-07-01 goal;冻结稿 §3.6 / §8.2 / §7.5 / §4.3 / §11 PR6)。
-- 净新一表 + 3 枚举 + 6 索引 + 2 FK(Restrict)+ 末尾手写 1 partial unique(PG16 NULLS NOT DISTINCT)+ 回填。
--
-- **带 scope 的角色绑定:终态替代 / 兼容 UserRole。** RoleBinding(principalType=USER, scopeType=GLOBAL)
--   = UserRole 的无损升级 = PR6 起判权唯一读源(行为锁);UserRole 表冻结、零生产读写(cleanup PR 再 DROP,本刀不删)。
-- **principalId 多态(沿 Attachment.ownerType/ownerId 范式):** 随 principalType 指向 user/member/position_assignment/system,
--   不建通用 FK,由 service 按 principalType 校验存在性;仅 roleId→roles、scopeOrgId→Organization 是真 FK(Restrict)。
-- **🔴 scoped 绑定可存不判(PR8 边界):** ORGANIZATION/ORGANIZATION_TREE/ACTIVITY/RESOURCE/SELF 各型入库,
--   但 RbacService 只读 scopeType=GLOBAL、绝不判 scoped(判权是 PR8 AuthzService)。

-- CreateEnum
CREATE TYPE "PrincipalType" AS ENUM ('USER', 'MEMBER', 'POSITION_ASSIGNMENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "BindingScopeType" AS ENUM ('GLOBAL', 'ORGANIZATION', 'ORGANIZATION_TREE', 'ACTIVITY', 'RESOURCE', 'SELF');

-- CreateEnum
CREATE TYPE "BindingStatus" AS ENUM ('ACTIVE', 'ENDED', 'SUSPENDED');

-- CreateTable
CREATE TABLE "role_bindings" (
    "id" TEXT NOT NULL,
    "principalType" "PrincipalType" NOT NULL,
    "principalId" TEXT,
    "roleId" TEXT NOT NULL,
    "scopeType" "BindingScopeType" NOT NULL,
    "scopeOrgId" TEXT,
    "scopeActivityId" TEXT,
    "scopeResourceType" TEXT,
    "scopeResourceId" TEXT,
    "status" "BindingStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "role_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_bindings_principalType_principalId_idx" ON "role_bindings"("principalType", "principalId");

-- CreateIndex
CREATE INDEX "role_bindings_roleId_idx" ON "role_bindings"("roleId");

-- CreateIndex
CREATE INDEX "role_bindings_scopeType_scopeOrgId_idx" ON "role_bindings"("scopeType", "scopeOrgId");

-- CreateIndex
CREATE INDEX "role_bindings_scopeActivityId_idx" ON "role_bindings"("scopeActivityId");

-- CreateIndex
CREATE INDEX "role_bindings_status_idx" ON "role_bindings"("status");

-- CreateIndex
CREATE INDEX "role_bindings_deletedAt_idx" ON "role_bindings"("deletedAt");

-- AddForeignKey
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_scopeOrgId_fkey" FOREIGN KEY ("scopeOrgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 手写 partial unique index(Prisma DSL 至 6.x 不支持带 WHERE 的部分唯一索引;
-- 沿 organization_supervision_assignments_active_unique / member_org_membership_active_unique 范式)。
-- 冻结稿 §3.6:同一绑定不重复 —— 全 scope 维度 active 唯一。
--
-- 🔴 **NULLS NOT DISTINCT(PG15+;本库 postgres:16)**:GLOBAL 绑定的 scopeOrgId/scopeActivityId/
--   scopeResourceType/scopeResourceId 全为 NULL;默认 PG 唯一索引把 NULL 视为互不相等 → 同一
--   (USER, userId, roleId, GLOBAL) 可插多条 = 破去重。故用 NULLS NOT DISTINCT 令 NULL scope 列也参与
--   去重,使本 partial unique 对 GLOBAL 绑定同样生效 = **保住 UserRole 旧 @@unique(userId,roleId) 的
--   并发去重行为锁**(区别于 contribution_rules 有意不去重 NULL 档位的选择:此处 NULL 去重是语义必需)。
--   P2002 → ROLE_BINDING_ALREADY_EXISTS(34002);user-roles 面预检兜底 USER_ROLE_ALREADY_EXISTS(30006)。
-- ============================================================================
CREATE UNIQUE INDEX "role_bindings_active_unique"
ON "role_bindings" (
    "principalType", "principalId", "roleId", "scopeType",
    "scopeOrgId", "scopeActivityId", "scopeResourceType", "scopeResourceId"
)
NULLS NOT DISTINCT
WHERE "deletedAt" IS NULL AND "status" = 'ACTIVE';

-- ============================================================================
-- 回填(冻结稿 §8.2):每条 UserRole → RoleBinding(principalType=USER, scopeType=GLOBAL, status=ACTIVE)。
--   - 复用旧 UserRole.id(cuid,1:1 可追溯;user-roles list 面返回的 `id` 对现有行逐字一致 = 额外行为锁);
--   - principalType=USER / principalId=userId / scopeType=GLOBAL / status=ACTIVE(判权读源等价替换);
--   - startedAt = 源 createdAt(授权起 = 原分配时间);createdByUserId = 源 createdBy(SetNull 历史可空原样);
--   - createdAt 原样保留(getEffectiveRoles / user-roles list 的 orderBy createdAt asc 排序逐字不变 = 行为锁);
--   - UserRole 无 updatedAt 列 → updatedAt = createdAt(该行迁移前从未更新);
--   - scopeOrgId/scopeActivityId/scopeResourceType/scopeResourceId/endedAt/note/deletedAt 全 NULL。
-- UserRole @@unique(userId,roleId) 保证 ≤1 行/(user,role),故回填按构造无重复、不撞 NULLS NOT DISTINCT
--   partial unique(GLOBAL 去重键 = (USER,userId,roleId,GLOBAL));若存在脏数据则本 migration 因唯一冲突
--   fail-loud(优于静默污染)。已有库:一次回填全部现有 UserRole;全新库 / seed 阶段:user_roles 为空 → 插 0 行。
-- 自证:迁移后 count(user_roles) == count(role_bindings WHERE principalType='USER' AND scopeType='GLOBAL')。
-- ============================================================================
INSERT INTO "role_bindings" (
    "id", "principalType", "principalId", "roleId", "scopeType", "status",
    "startedAt", "createdByUserId", "createdAt", "updatedAt"
)
SELECT
    "id",
    'USER'::"PrincipalType",
    "userId",
    "roleId",
    'GLOBAL'::"BindingScopeType",
    'ACTIVE'::"BindingStatus",
    "createdAt",
    "createdBy",
    "createdAt",
    "createdAt"
FROM "user_roles";

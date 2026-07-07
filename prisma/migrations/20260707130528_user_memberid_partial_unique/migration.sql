-- DropIndex
DROP INDEX "User_memberId_key";

-- CreateIndex
CREATE INDEX "User_memberId_idx" ON "User"("memberId");

-- ============================================================================
-- 队员账号闭环 v2(评审稿 docs/archive/reviews/member-account-loop-v2-review.md
-- §3.1/E-1):手写 partial unique index(Prisma DSL 至 6.x 不支持 @@unique 内表达
-- WHERE 子句;沿 role_bindings_active_unique / organization_position_assignments_active_unique /
-- member_org_membership_active_unique 等既有范式)。
--
-- 语义:同一 memberId 至多 1 条"活跃"(未软删)User 关联;软删旧号后释放槽位,
-- 供重新绑定 / 开号 / 退号重开取用。现有数据必然满足更严的全量唯一约束
-- ⇒ 天然满足更宽松的 partial 唯一,零冲突、零回填、非破坏性。
-- ============================================================================
CREATE UNIQUE INDEX "User_memberId_active_key" ON "User"("memberId") WHERE "deletedAt" IS NULL;

-- CreateTable
CREATE TABLE "team_join_cycles" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "year" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "team_join_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_join_applications" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "cycleId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "targetOrganizationIds" JSONB NOT NULL,
    "gateMarks" JSONB,
    "selectedOrganizationId" TEXT,
    "evaluatedByUserId" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "evaluationNote" TEXT,
    "evaluationExtendedUntil" TIMESTAMP(3),
    "eliminationStage" TEXT,
    "joinedAt" TIMESTAMP(3),

    CONSTRAINT "team_join_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_join_cycles_year_idx" ON "team_join_cycles"("year");

-- CreateIndex
CREATE INDEX "team_join_cycles_statusCode_idx" ON "team_join_cycles"("statusCode");

-- CreateIndex
CREATE INDEX "team_join_cycles_deletedAt_idx" ON "team_join_cycles"("deletedAt");

-- CreateIndex
CREATE INDEX "team_join_cycles_createdAt_idx" ON "team_join_cycles"("createdAt");

-- CreateIndex
CREATE INDEX "team_join_applications_cycleId_idx" ON "team_join_applications"("cycleId");

-- CreateIndex
CREATE INDEX "team_join_applications_memberId_idx" ON "team_join_applications"("memberId");

-- CreateIndex
CREATE INDEX "team_join_applications_statusCode_idx" ON "team_join_applications"("statusCode");

-- CreateIndex
CREATE INDEX "team_join_applications_selectedOrganizationId_idx" ON "team_join_applications"("selectedOrganizationId");

-- CreateIndex
CREATE INDEX "team_join_applications_deletedAt_idx" ON "team_join_applications"("deletedAt");

-- CreateIndex
CREATE INDEX "team_join_applications_createdAt_idx" ON "team_join_applications"("createdAt");

-- AddForeignKey
ALTER TABLE "team_join_applications" ADD CONSTRAINT "team_join_applications_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "team_join_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_join_applications" ADD CONSTRAINT "team_join_applications_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_join_applications" ADD CONSTRAINT "team_join_applications_selectedOrganizationId_fkey" FOREIGN KEY ("selectedOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 手动追加:入队申请 partial unique(沿 recruitment phase-1 / ActivityRegistration 范式,评审稿 E-J-2)
-- Prisma DSL 至 6.x 不支持 @@unique 内表达带 WHERE 的 partial unique index;Prisma 亦不在
-- schema-diff 中追踪带 WHERE 的 partial index,故此手写索引不会被后续 migrate 判为 drift。
-- 语义:同一 member 在同一入队轮至多一条「活跃」申请(允许 rejected 后同轮重试);
-- service P2002 兜底转 TEAM_JOIN_DUPLICATE_APPLICATION(28203)。
CREATE UNIQUE INDEX "team_join_applications_member_cycle_active_unique"
ON "team_join_applications"("memberId", "cycleId")
WHERE "deletedAt" IS NULL AND "statusCode" <> 'rejected';

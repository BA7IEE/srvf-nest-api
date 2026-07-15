-- 活动评价 F1：纯加一张空表 + 2 FK(Restrict) + 5 普通索引 + 1 手写 partial unique。
-- 无回填、无既有表字段变更、无 enum、无 seed、无数据删除或不可逆业务数据操作。

-- CreateTable
CREATE TABLE "activity_feedbacks" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "activityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,

    CONSTRAINT "activity_feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_feedbacks_activityId_idx" ON "activity_feedbacks"("activityId");

-- CreateIndex
CREATE INDEX "activity_feedbacks_memberId_idx" ON "activity_feedbacks"("memberId");

-- CreateIndex
CREATE INDEX "activity_feedbacks_deletedAt_idx" ON "activity_feedbacks"("deletedAt");

-- CreateIndex
CREATE INDEX "activity_feedbacks_createdAt_idx" ON "activity_feedbacks"("createdAt");

-- CreateIndex
CREATE INDEX "activity_feedbacks_rating_idx" ON "activity_feedbacks"("rating");

-- AddForeignKey
ALTER TABLE "activity_feedbacks" ADD CONSTRAINT "activity_feedbacks_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_feedbacks" ADD CONSTRAINT "activity_feedbacks_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma DSL 6.x 无法表达带 WHERE 的唯一索引；只约束未软删评价，释放软删历史槽位。
CREATE UNIQUE INDEX "activity_feedbacks_activity_member_active_unique"
ON "activity_feedbacks" ("activityId", "memberId")
WHERE "deletedAt" IS NULL;

-- 活动责任闭环 PR1：expand-only schema、兼容回填与新表不变量。
-- 不启用 runtime、不猜测旧活动发起人/负责人、不修改活动或考勤既有状态。

BEGIN;

-- AlterTable
ALTER TABLE "Activity"
ADD COLUMN "initiatorMemberId" TEXT,
ADD COLUMN "workflowRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "attendanceDeclaredCompleteAt" TIMESTAMP(3),
ADD COLUMN "attendanceDeclaredCompleteByUserId" TEXT;

-- AlterTable
ALTER TABLE "AttendanceSheet"
ADD COLUMN "lastSubmittedByUserId" TEXT,
ADD COLUMN "lastSubmittedAt" TIMESTAMP(3),
ADD COLUMN "returnedByUserId" TEXT,
ADD COLUMN "returnedAt" TIMESTAMP(3),
ADD COLUMN "returnNote" TEXT,
ADD COLUMN "returnedFromStageCode" TEXT;

-- 只回填已有真实来源；包含软删历史，不推断任何新业务身份或审核结论。
-- activity-responsibility-expand:attendance-last-submission-backfill:begin
UPDATE "AttendanceSheet"
SET
  "lastSubmittedByUserId" = "submitterUserId",
  "lastSubmittedAt" = "submittedAt"
WHERE
  "lastSubmittedByUserId" IS NULL
  OR "lastSubmittedAt" IS NULL;
-- activity-responsibility-expand:attendance-last-submission-backfill:end

-- CreateTable
CREATE TABLE "activity_publish_reviews" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "requestVersion" INTEGER NOT NULL,
    "baseRevision" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "directPublish" BOOLEAN NOT NULL DEFAULT false,
    "submittedByUserId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activity_publish_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "activity_publish_reviews_request_type_check"
      CHECK ("requestType" IN ('initial', 'change')),
    CONSTRAINT "activity_publish_reviews_request_version_check"
      CHECK ("requestVersion" > 0),
    CONSTRAINT "activity_publish_reviews_base_revision_check"
      CHECK ("baseRevision" >= 0),
    CONSTRAINT "activity_publish_reviews_status_check"
      CHECK ("status" IN ('pending', 'approved', 'returned', 'withdrawn', 'cancelled')),
    CONSTRAINT "activity_publish_reviews_direct_publish_check"
      CHECK (
        NOT "directPublish"
        OR (
          "status" = 'approved'
          AND "reviewedByUserId" IS NOT NULL
          AND "reviewedByUserId" = "submittedByUserId"
        )
      ),
    CONSTRAINT "activity_publish_reviews_return_note_check"
      CHECK (
        "status" <> 'returned'
        OR NULLIF(BTRIM("reviewNote"), '') IS NOT NULL
      )
);

-- CreateTable
CREATE TABLE "activity_responsibility_assignments" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "responsibilityType" TEXT NOT NULL,
    "canManageRegistrations" BOOLEAN NOT NULL,
    "canManageAttendance" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "assignedByUserId" TEXT NOT NULL,
    "endedByUserId" TEXT,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activity_responsibility_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "activity_responsibility_assignments_type_check"
      CHECK ("responsibilityType" IN ('owner', 'collaborator')),
    CONSTRAINT "activity_responsibility_assignments_status_check"
      CHECK ("status" IN ('active', 'ended', 'revoked')),
    CONSTRAINT "activity_responsibility_assignments_source_check"
      CHECK ("source" IN ('publish', 'delegation', 'transfer', 'legacy-claim', 'admin')),
    CONSTRAINT "activity_responsibility_assignments_capability_check"
      CHECK (
        (
          "responsibilityType" = 'owner'
          AND "canManageRegistrations"
          AND "canManageAttendance"
        )
        OR (
          "responsibilityType" = 'collaborator'
          AND ("canManageRegistrations" OR "canManageAttendance")
        )
      ),
    CONSTRAINT "activity_responsibility_assignments_ended_at_check"
      CHECK (
        ("status" = 'active' AND "endedAt" IS NULL)
        OR ("status" IN ('ended', 'revoked') AND "endedAt" IS NOT NULL)
      )
);

-- AddCheckConstraint
ALTER TABLE "Activity"
ADD CONSTRAINT "Activity_workflowRevision_check"
CHECK ("workflowRevision" >= 0);

-- AddCheckConstraint
ALTER TABLE "AttendanceSheet"
ADD CONSTRAINT "AttendanceSheet_returnedFromStageCode_check"
CHECK (
  "returnedFromStageCode" IS NULL
  OR "returnedFromStageCode" IN ('first', 'final')
);

-- CreateIndex
CREATE INDEX "Activity_initiatorMemberId_idx" ON "Activity"("initiatorMemberId");

-- CreateIndex
CREATE INDEX "Activity_attendanceDeclaredCompleteAt_idx" ON "Activity"("attendanceDeclaredCompleteAt");

-- CreateIndex
CREATE INDEX "AttendanceSheet_lastSubmittedByUserId_idx" ON "AttendanceSheet"("lastSubmittedByUserId");

-- CreateIndex
CREATE INDEX "AttendanceSheet_returnedByUserId_idx" ON "AttendanceSheet"("returnedByUserId");

-- CreateIndex
CREATE INDEX "AttendanceSheet_returnedAt_idx" ON "AttendanceSheet"("returnedAt");

-- CreateIndex
CREATE UNIQUE INDEX "activity_publish_reviews_activityId_requestVersion_key"
ON "activity_publish_reviews"("activityId", "requestVersion");

-- CreateIndex
CREATE INDEX "activity_publish_reviews_activityId_status_idx"
ON "activity_publish_reviews"("activityId", "status");

-- CreateIndex
CREATE INDEX "activity_publish_reviews_status_submittedAt_idx"
ON "activity_publish_reviews"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "activity_publish_reviews_submittedByUserId_idx"
ON "activity_publish_reviews"("submittedByUserId");

-- CreateIndex
CREATE INDEX "activity_publish_reviews_reviewedByUserId_idx"
ON "activity_publish_reviews"("reviewedByUserId");

-- CreateIndex
CREATE INDEX "activity_responsibility_assignments_activityId_status_idx"
ON "activity_responsibility_assignments"("activityId", "status");

-- CreateIndex
CREATE INDEX "activity_responsibility_assignments_memberId_status_idx"
ON "activity_responsibility_assignments"("memberId", "status");

-- CreateIndex
CREATE INDEX "activity_responsibility_assignments_assignedByUserId_idx"
ON "activity_responsibility_assignments"("assignedByUserId");

-- Prisma DSL 6.x 无法表达带 WHERE 的唯一索引。
CREATE UNIQUE INDEX "activity_publish_reviews_one_pending_unique"
ON "activity_publish_reviews"("activityId")
WHERE "status" = 'pending';

CREATE UNIQUE INDEX "activity_responsibility_one_active_owner_unique"
ON "activity_responsibility_assignments"("activityId")
WHERE "responsibilityType" = 'owner' AND "status" = 'active';

CREATE UNIQUE INDEX "activity_responsibility_member_active_unique"
ON "activity_responsibility_assignments"("activityId", "memberId")
WHERE "status" = 'active';

-- AddForeignKey
ALTER TABLE "Activity"
ADD CONSTRAINT "Activity_initiatorMemberId_fkey"
FOREIGN KEY ("initiatorMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity"
ADD CONSTRAINT "Activity_attendanceDeclaredCompleteByUserId_fkey"
FOREIGN KEY ("attendanceDeclaredCompleteByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSheet"
ADD CONSTRAINT "AttendanceSheet_lastSubmittedByUserId_fkey"
FOREIGN KEY ("lastSubmittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSheet"
ADD CONSTRAINT "AttendanceSheet_returnedByUserId_fkey"
FOREIGN KEY ("returnedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_publish_reviews"
ADD CONSTRAINT "activity_publish_reviews_activityId_fkey"
FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_publish_reviews"
ADD CONSTRAINT "activity_publish_reviews_submittedByUserId_fkey"
FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_publish_reviews"
ADD CONSTRAINT "activity_publish_reviews_reviewedByUserId_fkey"
FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_responsibility_assignments"
ADD CONSTRAINT "activity_responsibility_assignments_activityId_fkey"
FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_responsibility_assignments"
ADD CONSTRAINT "activity_responsibility_assignments_memberId_fkey"
FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_responsibility_assignments"
ADD CONSTRAINT "activity_responsibility_assignments_assignedByUserId_fkey"
FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_responsibility_assignments"
ADD CONSTRAINT "activity_responsibility_assignments_endedByUserId_fkey"
FOREIGN KEY ("endedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;

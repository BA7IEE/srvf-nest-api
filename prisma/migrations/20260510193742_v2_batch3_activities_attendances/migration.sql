-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "activityTypeCode" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT NOT NULL,
    "description" TEXT,
    "capacity" INTEGER,
    "genderRequirementCode" TEXT,
    "registrationDeadline" TIMESTAMP(3),
    "registrationNotes" TEXT,
    "statusCode" TEXT NOT NULL,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "isPublicRegistration" BOOLEAN NOT NULL DEFAULT true,
    "registrationSchema" JSONB,
    "coverImageUrl" TEXT,
    "galleryImageUrls" JSONB,
    "content" JSONB,
    "locationLongitude" DECIMAL(10,7),
    "locationLatitude" DECIMAL(10,7),

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityRegistration" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "activityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "extras" JSONB,
    "cancelledByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "ActivityRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceSheet" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "activityId" TEXT NOT NULL,
    "submitterUserId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusCode" TEXT NOT NULL,
    "reviewerUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "previousSnapshot" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AttendanceSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceRecord" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "sheetId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "roleCode" TEXT NOT NULL,
    "checkInAt" TIMESTAMP(3) NOT NULL,
    "checkOutAt" TIMESTAMP(3) NOT NULL,
    "serviceHours" DECIMAL(5,2) NOT NULL,
    "attendanceStatusCode" TEXT NOT NULL,
    "note" TEXT,
    "registrationId" TEXT,
    "contributionPoints" DECIMAL(5,2),

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Activity_deletedAt_idx" ON "Activity"("deletedAt");

-- CreateIndex
CREATE INDEX "Activity_createdAt_idx" ON "Activity"("createdAt");

-- CreateIndex
CREATE INDEX "Activity_statusCode_idx" ON "Activity"("statusCode");

-- CreateIndex
CREATE INDEX "Activity_organizationId_idx" ON "Activity"("organizationId");

-- CreateIndex
CREATE INDEX "Activity_activityTypeCode_idx" ON "Activity"("activityTypeCode");

-- CreateIndex
CREATE INDEX "Activity_startAt_idx" ON "Activity"("startAt");

-- CreateIndex
CREATE INDEX "Activity_isPublicRegistration_idx" ON "Activity"("isPublicRegistration");

-- CreateIndex
CREATE INDEX "ActivityRegistration_activityId_idx" ON "ActivityRegistration"("activityId");

-- CreateIndex
CREATE INDEX "ActivityRegistration_memberId_idx" ON "ActivityRegistration"("memberId");

-- CreateIndex
CREATE INDEX "ActivityRegistration_statusCode_idx" ON "ActivityRegistration"("statusCode");

-- CreateIndex
CREATE INDEX "ActivityRegistration_deletedAt_idx" ON "ActivityRegistration"("deletedAt");

-- CreateIndex
CREATE INDEX "ActivityRegistration_createdAt_idx" ON "ActivityRegistration"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityRegistration_registeredAt_idx" ON "ActivityRegistration"("registeredAt");

-- CreateIndex
CREATE INDEX "AttendanceSheet_activityId_idx" ON "AttendanceSheet"("activityId");

-- CreateIndex
CREATE INDEX "AttendanceSheet_submitterUserId_idx" ON "AttendanceSheet"("submitterUserId");

-- CreateIndex
CREATE INDEX "AttendanceSheet_reviewerUserId_idx" ON "AttendanceSheet"("reviewerUserId");

-- CreateIndex
CREATE INDEX "AttendanceSheet_statusCode_idx" ON "AttendanceSheet"("statusCode");

-- CreateIndex
CREATE INDEX "AttendanceSheet_deletedAt_idx" ON "AttendanceSheet"("deletedAt");

-- CreateIndex
CREATE INDEX "AttendanceSheet_createdAt_idx" ON "AttendanceSheet"("createdAt");

-- CreateIndex
CREATE INDEX "AttendanceSheet_submittedAt_idx" ON "AttendanceSheet"("submittedAt");

-- CreateIndex
CREATE INDEX "AttendanceRecord_sheetId_idx" ON "AttendanceRecord"("sheetId");

-- CreateIndex
CREATE INDEX "AttendanceRecord_memberId_idx" ON "AttendanceRecord"("memberId");

-- CreateIndex
CREATE INDEX "AttendanceRecord_registrationId_idx" ON "AttendanceRecord"("registrationId");

-- CreateIndex
CREATE INDEX "AttendanceRecord_attendanceStatusCode_idx" ON "AttendanceRecord"("attendanceStatusCode");

-- CreateIndex
CREATE INDEX "AttendanceRecord_roleCode_idx" ON "AttendanceRecord"("roleCode");

-- CreateIndex
CREATE INDEX "AttendanceRecord_deletedAt_idx" ON "AttendanceRecord"("deletedAt");

-- CreateIndex
CREATE INDEX "AttendanceRecord_createdAt_idx" ON "AttendanceRecord"("createdAt");

-- CreateIndex
CREATE INDEX "AttendanceRecord_memberId_deletedAt_idx" ON "AttendanceRecord"("memberId", "deletedAt");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_cancelledBy_fkey" FOREIGN KEY ("cancelledBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSheet" ADD CONSTRAINT "AttendanceSheet_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSheet" ADD CONSTRAINT "AttendanceSheet_submitterUserId_fkey" FOREIGN KEY ("submitterUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSheet" ADD CONSTRAINT "AttendanceSheet_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "AttendanceSheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ActivityRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Manually appended (v2 batch 3, Q-D4 + Q-D17 v1.2 修订版):
-- ActivityRegistration partial unique index.
-- Prisma DSL 至 6.x 不支持 @@unique 内表达带 WHERE 的 partial unique index;
-- 沿 v0.2.0 MemberDepartment 范式手动追加。
-- WHERE 含 cancelled 排除(Q-D17):允许取消后重新报名;索引名 _active_unique
-- 反映"仅 active 状态唯一"语义。
-- ===========================================================================
CREATE UNIQUE INDEX "activity_registrations_activity_member_active_unique"
ON "ActivityRegistration" ("activityId", "memberId")
WHERE "deletedAt" IS NULL AND "statusCode" != 'cancelled';

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "notificationTypeCode" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "visibilityCode" TEXT NOT NULL,
    "visibleOrganizationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audienceType" TEXT NOT NULL DEFAULT 'broadcast',
    "sourceType" TEXT NOT NULL DEFAULT 'admin',
    "channels" TEXT[] DEFAULT ARRAY['in-app']::TEXT[],
    "readCount" INTEGER NOT NULL DEFAULT 0,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "authorUserId" TEXT,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_reads" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notificationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,

    CONSTRAINT "notification_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_statusCode_idx" ON "notifications"("statusCode");

-- CreateIndex
CREATE INDEX "notifications_visibilityCode_idx" ON "notifications"("visibilityCode");

-- CreateIndex
CREATE INDEX "notifications_notificationTypeCode_idx" ON "notifications"("notificationTypeCode");

-- CreateIndex
CREATE INDEX "notifications_publishedAt_idx" ON "notifications"("publishedAt");

-- CreateIndex
CREATE INDEX "notifications_deletedAt_idx" ON "notifications"("deletedAt");

-- CreateIndex
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- CreateIndex
CREATE INDEX "notifications_statusCode_publishedAt_idx" ON "notifications"("statusCode", "publishedAt");

-- CreateIndex
CREATE INDEX "notification_reads_memberId_idx" ON "notification_reads"("memberId");

-- CreateIndex
CREATE INDEX "notification_reads_notificationId_idx" ON "notification_reads"("notificationId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_reads_notificationId_memberId_key" ON "notification_reads"("notificationId", "memberId");

-- AddForeignKey
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

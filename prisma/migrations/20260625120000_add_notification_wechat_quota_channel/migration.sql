-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notificationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "recipientRef" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT,
    "providerMsgId" TEXT,
    "errCode" TEXT,
    "attemptedAt" TIMESTAMP(3),

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wechat_subscription_quotas" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "memberId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "availableCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wechat_subscription_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wechat_subscribe_templates" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "notificationTypeCode" TEXT NOT NULL,
    "templateId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "remarks" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "wechat_subscribe_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_deliveries_notificationId_idx" ON "notification_deliveries"("notificationId");

-- CreateIndex
CREATE INDEX "notification_deliveries_memberId_channel_idx" ON "notification_deliveries"("memberId", "channel");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_idx" ON "notification_deliveries"("status");

-- CreateIndex
CREATE INDEX "wechat_subscription_quotas_templateId_idx" ON "wechat_subscription_quotas"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "wechat_subscription_quotas_memberId_templateId_key" ON "wechat_subscription_quotas"("memberId", "templateId");

-- CreateIndex
CREATE UNIQUE INDEX "wechat_subscribe_templates_notificationTypeCode_key" ON "wechat_subscribe_templates"("notificationTypeCode");

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

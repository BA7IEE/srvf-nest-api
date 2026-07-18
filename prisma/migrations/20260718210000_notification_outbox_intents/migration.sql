-- D-Outbox(2026-07-18):PostgreSQL durable notification intent storage。
-- 纯 additive 空表；零回填、零 enum、零 drop。worker 通过
-- FOR UPDATE SKIP LOCKED + lease/fencing 支持多实例领取；retention 仅人工执行。

BEGIN;

-- CreateTable
CREATE TABLE "notification_outbox_intents" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadVersion" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "destinationType" TEXT NOT NULL,
    "destinationRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "lockedAt" TIMESTAMPTZ(3),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "preparedAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "lastErrorCode" TEXT,
    "lastErrorClass" TEXT,
    "deadAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_outbox_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_intents_eventKey_key" ON "notification_outbox_intents"("eventKey");

-- CreateIndex
CREATE INDEX "notification_outbox_intents_status_availableAt_leaseExpiresAt_idx"
ON "notification_outbox_intents"("status", "availableAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "notification_outbox_intents_leaseExpiresAt_idx"
ON "notification_outbox_intents"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "notification_outbox_intents_aggregateType_aggregateId_idx"
ON "notification_outbox_intents"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "notification_outbox_intents_status_completedAt_idx"
ON "notification_outbox_intents"("status", "completedAt");

-- CreateIndex
CREATE INDEX "notification_outbox_intents_status_deadAt_idx"
ON "notification_outbox_intents"("status", "deadAt");

-- CreateIndex
CREATE INDEX "notification_outbox_intents_createdAt_idx"
ON "notification_outbox_intents"("createdAt");

-- 同一 notification/member 的微信 child 同时至多一个 active attempt；terminal 后释放，
-- 允许后续真实 re-publish 以新 generation 重试。eventType 收窄避免影响其它 outbox 类型。
CREATE UNIQUE INDEX "notification_outbox_wechat_delivery_active_unique"
ON "notification_outbox_intents"("eventType", "aggregateId", "destinationRef")
WHERE "eventType" = 'notification.wechat-delivery'
  AND "status" IN ('pending', 'processing');

-- admin SMS 每次 confirmation 保留独立 generation/history，但同 notification/member
-- 同时至多一个 active intent；合法 skip / succeeded / dead 后槽位释放。
CREATE UNIQUE INDEX "notification_outbox_admin_sms_active_unique"
ON "notification_outbox_intents"("eventType", "aggregateId", "destinationRef")
WHERE "eventType" = 'notification.admin-sms'
  AND "status" IN ('pending', 'processing');

COMMIT;

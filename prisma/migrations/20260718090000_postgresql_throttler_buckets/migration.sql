-- D-Throttle(2026-07-18):@nestjs/throttler 6.5.0 的 PostgreSQL shared storage。
-- 纯 additive 空表；零回填、零 enum、零 drop。10 个命名 throttler 以
-- (throttlerName, key) 唯一键物理隔离，过期行仅由手动 retention SOP 清理。

-- CreateTable
CREATE TABLE "throttler_buckets" (
    "id" TEXT NOT NULL,
    "throttlerName" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "hitExpiresAt" TIMESTAMPTZ(3)[] NOT NULL DEFAULT ARRAY[]::TIMESTAMPTZ(3)[],
    "windowExpiresAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blockedUntil" TIMESTAMPTZ(3),
    "retentionAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "throttler_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "throttler_buckets_throttlerName_key_key" ON "throttler_buckets"("throttlerName", "key");

-- CreateIndex
CREATE INDEX "throttler_buckets_retentionAt_idx" ON "throttler_buckets"("retentionAt");

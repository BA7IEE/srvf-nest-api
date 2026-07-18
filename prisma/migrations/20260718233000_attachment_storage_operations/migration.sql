-- D-STORAGE-CONSISTENCY Phase 1(2026-07-18):Attachment namespace durable provider ledger。
-- PostgreSQL 与 Provider 不宣称原子；本 migration 只做 additive 建表与可审查回填。
-- 绝不调用 Provider，历史对象绝不直接写 available，零暗修。
-- P0 rollout expand/contract：本 phase 刻意不加 Attachment.key -> StorageObject.key FK，
-- 避免 rollout 期间尚未升级的旧 writer 被新约束阻断。旧 writer 全退场且 backfill gates=0 后，
-- 由后续独立 contract migration 增加 FK RESTRICT。

BEGIN;

-- 锁覆盖存量异常扫描与回填，得到一个可审查的一致快照；commit 后仍允许旧 writer，
-- 新 binary 以运行时 invariant/JIT 补账承接 rollout，DB FK 留后续 contract migration。
LOCK TABLE "attachments" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "storage_settings" IN SHARE MODE;

DO $$
DECLARE
  invalid_key_count BIGINT;
  invalid_size_count BIGINT;
  storage_settings_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO invalid_key_count
  FROM "attachments"
  WHERE "key" IS NULL OR btrim("key") = '';

  IF invalid_key_count <> 0 THEN
    RAISE EXCEPTION
      'D-STORAGE-CONSISTENCY migration refused: % Attachment rows have empty keys',
      invalid_key_count;
  END IF;

  SELECT COUNT(*) INTO invalid_size_count
  FROM "attachments"
  WHERE "size" < 0;

  IF invalid_size_count <> 0 THEN
    RAISE EXCEPTION
      'D-STORAGE-CONSISTENCY migration refused: % Attachment rows have negative size',
      invalid_size_count;
  END IF;

  SELECT COUNT(*) INTO storage_settings_count FROM "storage_settings";
  IF storage_settings_count > 1 THEN
    RAISE EXCEPTION
      'D-STORAGE-CONSISTENCY migration refused: storage_settings singleton drift count=%',
      storage_settings_count;
  END IF;
END $$;

CREATE TABLE "storage_objects" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending_upload',
    "source" TEXT NOT NULL,
    "providerType" "StorageProviderType",
    "bucket" TEXT,
    "region" TEXT,
    "localNamespace" TEXT,
    "expectedSize" BIGINT,
    "actualSize" BIGINT,
    "expectedMime" TEXT,
    "actualMime" TEXT,
    "etag" TEXT,
    "checksum" TEXT,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "unboundExpiresAt" TIMESTAMPTZ(3),
    "lastProviderCheckedAt" TIMESTAMPTZ(3),
    "verifiedAt" TIMESTAMPTZ(3),
    "presentAt" TIMESTAMPTZ(3),
    "deleteRequestedAt" TIMESTAMPTZ(3),
    "absentAt" TIMESTAMPTZ(3),
    "missingAt" TIMESTAMPTZ(3),
    "lastErrorCode" TEXT,
    "lastErrorClass" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "storage_objects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "storage_objects_state_check" CHECK (
      "state" IN (
        'pending_upload',
        'present_unbound',
        'available',
        'delete_pending',
        'delete_failed',
        'absent',
        'missing',
        'integrity_mismatch',
        'legacy_unverified',
        'provider_unknown'
      )
    ),
    CONSTRAINT "storage_objects_source_check" CHECK (
      "source" IN ('attachment_signed_upload', 'attachment_legacy', 'backfill')
    ),
    CONSTRAINT "storage_objects_size_check" CHECK (
      ("expectedSize" IS NULL OR "expectedSize" >= 0)
      AND ("actualSize" IS NULL OR "actualSize" >= 0)
    ),
    CONSTRAINT "storage_objects_version_check" CHECK ("version" >= 0),
    CONSTRAINT "storage_objects_resource_pair_check" CHECK (
      ("resourceType" IS NULL) = ("resourceId" IS NULL)
    ),
    CONSTRAINT "storage_objects_locator_check" CHECK (
      (
        "providerType" = 'COS'
        AND "bucket" IS NOT NULL AND btrim("bucket") <> ''
        AND "region" IS NOT NULL AND btrim("region") <> ''
        AND "localNamespace" IS NULL
      )
      OR (
        "providerType" = 'LOCAL'
        AND "bucket" IS NULL
        AND "region" IS NULL
        AND "localNamespace" IS NOT NULL
        AND btrim("localNamespace") <> ''
      )
      OR (
        -- expand rollout 唯一不完整 locator 例外：migration/JIT 尚无法证明历史
        -- backfill 的 provider。新 signed/legacy 对象与 available 永不走此分支。
        "source" = 'backfill'
        AND "state" = 'provider_unknown'
        AND (
          (
            "providerType" IS NULL
            AND "bucket" IS NULL
            AND "region" IS NULL
            AND "localNamespace" IS NULL
          )
          OR (
            "providerType" = 'LOCAL'
            AND "bucket" IS NULL
            AND "region" IS NULL
            AND "localNamespace" IS NULL
          )
        )
      )
    ),
    CONSTRAINT "storage_objects_state_timestamp_check" CHECK (
      ("state" <> 'available' OR (
        "resourceType" IS NOT NULL
        AND "expectedSize" IS NOT NULL
        AND "actualSize" IS NOT NULL
        AND "verifiedAt" IS NOT NULL
        AND "presentAt" IS NOT NULL
        AND "lastProviderCheckedAt" IS NOT NULL
      ))
      AND ("state" <> 'present_unbound' OR (
        "resourceType" IS NULL
        AND "presentAt" IS NOT NULL
      ))
      AND ("state" NOT IN ('delete_pending', 'delete_failed') OR "deleteRequestedAt" IS NOT NULL)
      AND ("state" <> 'absent' OR "absentAt" IS NOT NULL)
      AND ("state" <> 'missing' OR "missingAt" IS NOT NULL)
      AND ("state" <> 'integrity_mismatch' OR (
        "resourceType" IS NOT NULL
        AND "expectedSize" IS NOT NULL
        AND "actualSize" IS NOT NULL
        AND "verifiedAt" IS NOT NULL
        AND "presentAt" IS NOT NULL
        AND "lastProviderCheckedAt" IS NOT NULL
        AND "lastErrorCode" IS NOT NULL
        AND "lastErrorClass" IS NOT NULL
      ))
    )
);

CREATE TABLE "storage_object_operations" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "storageObjectId" TEXT NOT NULL,
    "replayOfId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "effectState" TEXT NOT NULL DEFAULT 'not_started',
    "payloadVersion" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "requestHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
    "leaseAcquiredAt" TIMESTAMPTZ(3),
    "leaseRenewedAt" TIMESTAMPTZ(3),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "effectStartedAt" TIMESTAMPTZ(3),
    "effectCompletedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "deadAt" TIMESTAMPTZ(3),
    "lastErrorCode" TEXT,
    "lastErrorClass" TEXT,
    "responseSnapshotExpiresAt" TIMESTAMPTZ(3),
    "responsePurgedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "storage_object_operations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "storage_object_operations_kind_check" CHECK (
      "kind" IN (
        'attachment_upload_verify',
        'attachment_delete',
        'orphan_delete',
        'backfill_verify',
        'manual_relocate',
        'manual_attest_absent'
      )
    ),
    CONSTRAINT "storage_object_operations_status_check" CHECK (
      "status" IN ('pending', 'processing', 'succeeded', 'dead')
    ),
    CONSTRAINT "storage_object_operations_effect_state_check" CHECK (
      "effectState" IN (
        'not_started',
        'provider_unknown',
        'provider_present',
        'provider_absent',
        'effect_started',
        'effect_succeeded'
      )
    ),
    CONSTRAINT "storage_object_operations_nonnegative_check" CHECK (
      "attempts" >= 0
      AND "leaseGeneration" >= 0
      AND "payloadVersion" > 0
    ),
    CONSTRAINT "storage_object_operations_request_hash_check" CHECK (
      "requestHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "storage_object_operations_lease_check" CHECK (
      (
        "status" = 'processing'
        AND "leaseOwner" IS NOT NULL
        AND "leaseGeneration" > 0
        AND "leaseAcquiredAt" IS NOT NULL
        AND "leaseExpiresAt" IS NOT NULL
      )
      OR (
        "status" <> 'processing'
        AND "leaseOwner" IS NULL
        AND "leaseAcquiredAt" IS NULL
        AND "leaseRenewedAt" IS NULL
        AND "leaseExpiresAt" IS NULL
      )
    ),
    CONSTRAINT "storage_object_operations_terminal_check" CHECK (
      ("status" IN ('pending', 'processing') AND "completedAt" IS NULL AND "deadAt" IS NULL)
      OR ("status" = 'succeeded' AND "completedAt" IS NOT NULL AND "deadAt" IS NULL)
      OR ("status" = 'dead' AND "completedAt" IS NOT NULL AND "deadAt" IS NOT NULL)
    ),
    CONSTRAINT "storage_object_operations_response_check" CHECK (
      (
        "kind" = 'attachment_delete'
        AND "responseSnapshotExpiresAt" IS NOT NULL
      )
      OR (
        "kind" <> 'attachment_delete'
        AND "responseSnapshotExpiresAt" IS NULL
        AND "responsePurgedAt" IS NULL
      )
    ),
    CONSTRAINT "storage_object_operations_response_purge_time_check" CHECK (
      "responsePurgedAt" IS NULL
      OR "responsePurgedAt" >= "responseSnapshotExpiresAt"
    )
);

ALTER TABLE "storage_object_operations"
ADD CONSTRAINT "storage_object_operations_storageObjectId_fkey"
FOREIGN KEY ("storageObjectId") REFERENCES "storage_objects"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "storage_object_operations"
ADD CONSTRAINT "storage_object_operations_replayOfId_fkey"
FOREIGN KEY ("replayOfId") REFERENCES "storage_object_operations"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "storage_objects_key_key" ON "storage_objects"("key");
CREATE INDEX "storage_objects_state_idx" ON "storage_objects"("state");
CREATE INDEX "storage_objects_source_state_idx" ON "storage_objects"("source", "state");
CREATE INDEX "storage_objects_resourceType_resourceId_idx"
ON "storage_objects"("resourceType", "resourceId");
CREATE INDEX "storage_objects_unboundExpiresAt_idx" ON "storage_objects"("unboundExpiresAt");
CREATE INDEX "storage_objects_createdAt_idx" ON "storage_objects"("createdAt");

CREATE UNIQUE INDEX "storage_object_operations_eventKey_key"
ON "storage_object_operations"("eventKey");
CREATE INDEX "storage_object_operations_status_availableAt_leaseExpiresAt_idx"
ON "storage_object_operations"("status", "availableAt", "leaseExpiresAt");
CREATE INDEX "storage_object_operations_storageObjectId_createdAt_idx"
ON "storage_object_operations"("storageObjectId", "createdAt");
CREATE INDEX "storage_object_operations_kind_status_idx"
ON "storage_object_operations"("kind", "status");
CREATE INDEX "storage_object_operations_leaseExpiresAt_idx"
ON "storage_object_operations"("leaseExpiresAt");
CREATE INDEX "storage_object_operations_responseSnapshotExpiresAt_responsePurgedAt_idx"
ON "storage_object_operations"("responseSnapshotExpiresAt", "responsePurgedAt");
CREATE INDEX "storage_object_operations_createdAt_idx"
ON "storage_object_operations"("createdAt");

-- 每个对象任一时刻至多一条 active operation；terminal history 不互相排斥。
CREATE UNIQUE INDEX "storage_object_operations_one_active_per_object"
ON "storage_object_operations"("storageObjectId")
WHERE "status" IN ('pending', 'processing');

-- 历史 Attachment 只形成候选 ledger。COS 且 bucket/region 完整才是 legacy_unverified；
-- LOCAL 的 root 只能由新 binary 在运行时补全，故 migration 写 provider_unknown。
INSERT INTO "storage_objects" (
  "id",
  "key",
  "state",
  "source",
  "providerType",
  "bucket",
  "region",
  "localNamespace",
  "expectedSize",
  "actualSize",
  "expectedMime",
  "actualMime",
  "etag",
  "checksum",
  "resourceType",
  "resourceId",
  "version",
  "createdAt",
  "updatedAt"
)
SELECT
  'so_' || encode(sha256(convert_to(a."key", 'UTF8')), 'hex'),
  a."key",
  CASE
    WHEN s."providerType" = 'COS'
      AND NULLIF(btrim(s."bucket"), '') IS NOT NULL
      AND NULLIF(btrim(s."region"), '') IS NOT NULL
      THEN 'legacy_unverified'
    ELSE 'provider_unknown'
  END,
  'backfill',
  CASE
    WHEN s."providerType" = 'COS'
      AND NULLIF(btrim(s."bucket"), '') IS NOT NULL
      AND NULLIF(btrim(s."region"), '') IS NOT NULL
      THEN s."providerType"
    WHEN s."providerType" = 'LOCAL' THEN s."providerType"
    ELSE NULL
  END,
  CASE
    WHEN s."providerType" = 'COS'
      AND NULLIF(btrim(s."bucket"), '') IS NOT NULL
      AND NULLIF(btrim(s."region"), '') IS NOT NULL
      THEN NULLIF(btrim(s."bucket"), '')
    ELSE NULL
  END,
  CASE
    WHEN s."providerType" = 'COS'
      AND NULLIF(btrim(s."bucket"), '') IS NOT NULL
      AND NULLIF(btrim(s."region"), '') IS NOT NULL
      THEN NULLIF(btrim(s."region"), '')
    ELSE NULL
  END,
  NULL,
  a."size"::BIGINT,
  NULL,
  a."mime",
  NULL,
  a."etag",
  a."checksum",
  'attachment',
  a."id",
  0,
  a."createdAt",
  CURRENT_TIMESTAMP
FROM "attachments" a
LEFT JOIN "storage_settings" s ON TRUE;

-- 每条历史 Attachment 都有显式 backfill_verify intent；worker 对候选 locator 做 HEAD。
-- 404 转 provider_unknown 并由 runtime 丢弃未验证 locator；timeout/403 只记 error，
-- 绝不由 migration/worker 猜成全局 absent 或 missing。
INSERT INTO "storage_object_operations" (
  "id",
  "eventKey",
  "storageObjectId",
  "kind",
  "status",
  "effectState",
  "payloadVersion",
  "payload",
  "requestHash",
  "attempts",
  "availableAt",
  "leaseGeneration",
  "createdAt",
  "updatedAt"
)
SELECT
  'sop_' || encode(sha256(convert_to('backfill:' || a."id", 'UTF8')), 'hex'),
  'storage.backfill-verify:' || a."id",
  o."id",
  'backfill_verify',
  'pending',
  'not_started',
  1,
  jsonb_build_object('attachmentId', a."id"),
  encode(sha256(convert_to('backfill:' || a."id" || ':' || a."key", 'UTF8')), 'hex'),
  0,
  CURRENT_TIMESTAMP,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "attachments" a
JOIN "storage_objects" o ON o."key" = a."key";

COMMIT;

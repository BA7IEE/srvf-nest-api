-- ============================================================================
-- Activity v1.1 Batch 6: staff / import / offline foundation
--
-- Maintainer-approved supplementary contract v1 supplies the previously absent
-- field tables for OfflinePackage and OfflinePunchReviewItem. This migration is
-- additive only: no existing row is rewritten, deleted, or reinterpreted.
-- ============================================================================

-- CreateTable
CREATE TABLE "OfflinePackage" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "operatorMemberId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "packageVersion" INTEGER NOT NULL,
    "packageKeyVersion" INTEGER NOT NULL DEFAULT 0,
    "statusCode" TEXT NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "ruleSnapshotId" TEXT NOT NULL,
    "ruleSnapshotHash" TEXT NOT NULL,
    "workflowRevision" INTEGER NOT NULL,
    "participantSnapshotHash" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "uploadUntil" TIMESTAMP(3) NOT NULL,
    "sequenceStart" INTEGER NOT NULL,
    "nextExpectedSequence" INTEGER NOT NULL,
    "chainAnchorHash" TEXT NOT NULL,
    "lastAcceptedHash" TEXT NOT NULL,
    "lastAcceptedAt" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "issueOperationKey" TEXT NOT NULL,
    "issueRequestHash" TEXT NOT NULL,
    "revokedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "revokeOperationKey" TEXT,
    "revokeRequestHash" TEXT,

    CONSTRAINT "OfflinePackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflinePackageParticipant" (
    "offlinePackageId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "participationIdentityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "participationRevisionId" TEXT NOT NULL,
    "positionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offline_package_participant_pkey" PRIMARY KEY ("offlinePackageId", "participationIdentityId")
);

-- CreateTable
CREATE TABLE "OfflinePunchReviewItem" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "offlinePackageId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventKey" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "anomalyCode" TEXT NOT NULL,
    "approvalPolicyCode" TEXT NOT NULL,
    "participationIdentityId" TEXT,
    "participationRevisionId" TEXT,
    "actionCode" TEXT,
    "deviceTime" TIMESTAMP(3),
    "longitude" DECIMAL(10,7),
    "latitude" DECIMAL(9,7),
    "accuracy" DECIMAL(8,2),
    "providedPriorHash" TEXT,
    "eventPayloadHash" TEXT,
    "signatureDigest" TEXT,
    "stagedByUserId" TEXT NOT NULL,
    "stagedByMemberId" TEXT,
    "stagedAt" TIMESTAMP(3) NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedByMemberId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "resolutionOperationKey" TEXT,
    "resolutionRequestHash" TEXT,
    "formalPunchEventId" TEXT,

    CONSTRAINT "OfflinePunchReviewItem_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "AttendancePunchEvent"
ADD COLUMN "offlinePackageId" TEXT,
ADD COLUMN "offlineSequence" INTEGER,
ADD COLUMN "offlinePriorHash" TEXT,
ADD COLUMN "offlineEventPayloadHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "offline_package_issue_operation_key_key" ON "OfflinePackage"("issueOperationKey");
CREATE UNIQUE INDEX "offline_package_revoke_operation_key_key" ON "OfflinePackage"("revokeOperationKey");
CREATE UNIQUE INDEX "offline_package_id_activity_session_key" ON "OfflinePackage"("id", "activityId", "sessionId");
CREATE UNIQUE INDEX "offline_package_activity_session_device_version_key" ON "OfflinePackage"("activityId", "sessionId", "deviceId", "packageVersion");
CREATE INDEX "offline_package_activity_session_status_idx" ON "OfflinePackage"("activityId", "sessionId", "statusCode");
CREATE INDEX "offline_package_operator_status_idx" ON "OfflinePackage"("operatorUserId", "statusCode");
CREATE INDEX "offline_package_upload_until_idx" ON "OfflinePackage"("uploadUntil");

CREATE INDEX "offline_package_participant_identity_idx" ON "OfflinePackageParticipant"("participationIdentityId");
CREATE INDEX "offline_package_participant_revision_idx" ON "OfflinePackageParticipant"("participationRevisionId");
CREATE INDEX "offline_package_participant_position_idx" ON "OfflinePackageParticipant"("positionId");

CREATE UNIQUE INDEX "offline_review_item_resolution_operation_key_key" ON "OfflinePunchReviewItem"("resolutionOperationKey");
CREATE UNIQUE INDEX "offline_review_item_formal_punch_event_key" ON "OfflinePunchReviewItem"("formalPunchEventId");
CREATE UNIQUE INDEX "offline_review_item_package_sequence_key" ON "OfflinePunchReviewItem"("offlinePackageId", "sequence");
CREATE INDEX "offline_review_item_activity_session_status_created_idx" ON "OfflinePunchReviewItem"("activityId", "sessionId", "statusCode", "createdAt");
CREATE INDEX "offline_review_item_package_status_idx" ON "OfflinePunchReviewItem"("offlinePackageId", "statusCode");
CREATE INDEX "offline_review_item_identity_idx" ON "OfflinePunchReviewItem"("participationIdentityId");
CREATE INDEX "offline_review_item_revision_idx" ON "OfflinePunchReviewItem"("participationRevisionId");

CREATE UNIQUE INDEX "attendance_punch_event_offline_package_sequence_key"
ON "AttendancePunchEvent"("offlinePackageId", "offlineSequence");
CREATE INDEX "AttendancePunchEvent_offlinePackageId_idx" ON "AttendancePunchEvent"("offlinePackageId");

-- AddForeignKey
ALTER TABLE "OfflinePackage" ADD CONSTRAINT "OfflinePackage_activityId_fkey"
FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePackage" ADD CONSTRAINT "OfflinePackage_activityId_sessionId_fkey"
FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePackage" ADD CONSTRAINT "OfflinePackage_operatorUserId_fkey"
FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePackage" ADD CONSTRAINT "OfflinePackage_operatorMemberId_fkey"
FOREIGN KEY ("operatorMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePackage" ADD CONSTRAINT "OfflinePackage_ruleSnapshotId_fkey"
FOREIGN KEY ("ruleSnapshotId") REFERENCES "ActivityRuleSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePackage" ADD CONSTRAINT "OfflinePackage_revokedByUserId_fkey"
FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_package_anchor_fkey"
FOREIGN KEY ("offlinePackageId", "activityId", "sessionId") REFERENCES "OfflinePackage"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_activityId_fkey"
FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_activity_session_fkey"
FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_identity_fkey"
FOREIGN KEY ("participationIdentityId") REFERENCES "ActivityParticipationIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_member_fkey"
FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_revision_fkey"
FOREIGN KEY ("participationRevisionId") REFERENCES "ActivityParticipationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_position_fkey"
FOREIGN KEY ("positionId") REFERENCES "ActivitySessionPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_package_anchor_fkey"
FOREIGN KEY ("offlinePackageId", "activityId", "sessionId") REFERENCES "OfflinePackage"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_activityId_fkey"
FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_activity_session_fkey"
FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_identity_fkey"
FOREIGN KEY ("participationIdentityId") REFERENCES "ActivityParticipationIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_revision_fkey"
FOREIGN KEY ("participationRevisionId") REFERENCES "ActivityParticipationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_staged_user_fkey"
FOREIGN KEY ("stagedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_staged_member_fkey"
FOREIGN KEY ("stagedByMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_reviewer_user_fkey"
FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_reviewer_member_fkey"
FOREIGN KEY ("reviewedByMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_formal_event_fkey"
FOREIGN KEY ("formalPunchEventId") REFERENCES "AttendancePunchEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_offline_package_anchor_fkey"
FOREIGN KEY ("offlinePackageId", "activityId", "sessionId") REFERENCES "OfflinePackage"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- B6 database invariants. All nullable expressions use CASE / IS NULL forms so
-- PostgreSQL's three-valued CHECK semantics cannot silently admit an invalid row.
-- ============================================================================

ALTER TABLE "OfflinePackage"
ADD CONSTRAINT "offline_package_status_code_check"
CHECK ("statusCode" IN ('active', 'review_required', 'revoked', 'expired'));

ALTER TABLE "OfflinePackage"
ADD CONSTRAINT "offline_package_versions_check"
CHECK ("packageVersion" >= 1 AND "packageKeyVersion" = 0 AND "workflowRevision" >= 0);

ALTER TABLE "OfflinePackage"
ADD CONSTRAINT "offline_package_window_check"
CHECK ("validFrom" < "validUntil" AND "validUntil" < "uploadUntil");

ALTER TABLE "OfflinePackage"
ADD CONSTRAINT "offline_package_sequence_check"
CHECK ("sequenceStart" >= 1 AND "nextExpectedSequence" >= "sequenceStart");

ALTER TABLE "OfflinePackage"
ADD CONSTRAINT "offline_package_required_hashes_check"
CHECK (
  "tokenDigest" ~ '^[0-9a-f]{64}$'
  AND "ruleSnapshotHash" ~ '^[0-9a-f]{64}$'
  AND "participantSnapshotHash" ~ '^[0-9a-f]{64}$'
  AND "chainAnchorHash" ~ '^[0-9a-f]{64}$'
  AND "lastAcceptedHash" ~ '^[0-9a-f]{64}$'
  AND "issueRequestHash" ~ '^[0-9a-f]{64}$'
);

ALTER TABLE "OfflinePackage"
ADD CONSTRAINT "offline_package_optional_revoke_hash_check"
CHECK ("revokeRequestHash" IS NULL OR "revokeRequestHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "OfflinePackage"
ADD CONSTRAINT "offline_package_revoke_shape_check"
CHECK (
  CASE WHEN "statusCode" = 'revoked' THEN
    "revokedByUserId" IS NOT NULL
    AND "revokedAt" IS NOT NULL
    AND "revokeReason" IS NOT NULL
    AND "revokeOperationKey" IS NOT NULL
    AND "revokeRequestHash" IS NOT NULL
  ELSE
    "revokedByUserId" IS NULL
    AND "revokedAt" IS NULL
    AND "revokeReason" IS NULL
    AND "revokeOperationKey" IS NULL
    AND "revokeRequestHash" IS NULL
  END
);

CREATE UNIQUE INDEX "offline_package_live_device_unique"
ON "OfflinePackage"("activityId", "sessionId", "deviceId")
WHERE "statusCode" IN ('active', 'review_required');

ALTER TABLE "OfflinePunchReviewItem"
ADD CONSTRAINT "offline_review_item_status_code_check"
CHECK ("statusCode" IN ('pending', 'approved', 'rejected'));

ALTER TABLE "OfflinePunchReviewItem"
ADD CONSTRAINT "offline_review_item_anomaly_code_check"
CHECK ("anomalyCode" IN (
  'operator_authorization_revoked',
  'package_revoked',
  'package_expired',
  'device_mismatch',
  'sequence_gap',
  'sequence_duplicate',
  'future_time',
  'time_out_of_window',
  'hash_chain_invalid',
  'signature_invalid',
  'participant_snapshot_mismatch'
));

ALTER TABLE "OfflinePunchReviewItem"
ADD CONSTRAINT "offline_review_item_approval_policy_check"
CHECK ("approvalPolicyCode" IN ('approvable', 'reject_only'));

ALTER TABLE "OfflinePunchReviewItem"
ADD CONSTRAINT "offline_review_item_anomaly_policy_check"
CHECK (
  ("anomalyCode" IN (
    'device_mismatch',
    'sequence_gap',
    'sequence_duplicate',
    'hash_chain_invalid',
    'signature_invalid',
    'participant_snapshot_mismatch'
  )) = ("approvalPolicyCode" = 'reject_only')
);

ALTER TABLE "OfflinePunchReviewItem"
ADD CONSTRAINT "offline_review_item_sequence_check"
CHECK ("sequence" >= 1);

ALTER TABLE "OfflinePunchReviewItem"
ADD CONSTRAINT "offline_review_item_optional_hashes_check"
CHECK (
  ("providedPriorHash" IS NULL OR "providedPriorHash" ~ '^[0-9a-f]{64}$')
  AND ("eventPayloadHash" IS NULL OR "eventPayloadHash" ~ '^[0-9a-f]{64}$')
  AND ("signatureDigest" IS NULL OR "signatureDigest" ~ '^[0-9a-f]{64}$')
  AND ("resolutionRequestHash" IS NULL OR "resolutionRequestHash" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "OfflinePunchReviewItem"
ADD CONSTRAINT "offline_review_item_resolution_shape_check"
CHECK (
  CASE "statusCode"
    WHEN 'pending' THEN
      "reviewedByUserId" IS NULL
      AND "reviewedAt" IS NULL
      AND "reviewReason" IS NULL
      AND "resolutionOperationKey" IS NULL
      AND "resolutionRequestHash" IS NULL
      AND "formalPunchEventId" IS NULL
    WHEN 'approved' THEN
      "reviewedByUserId" IS NOT NULL
      AND "reviewedAt" IS NOT NULL
      AND "reviewReason" IS NOT NULL
      AND "resolutionOperationKey" IS NOT NULL
      AND "resolutionRequestHash" IS NOT NULL
      AND "formalPunchEventId" IS NOT NULL
    WHEN 'rejected' THEN
      "reviewedByUserId" IS NOT NULL
      AND "reviewedAt" IS NOT NULL
      AND "reviewReason" IS NOT NULL
      AND "resolutionOperationKey" IS NOT NULL
      AND "resolutionRequestHash" IS NOT NULL
      AND "formalPunchEventId" IS NULL
    ELSE false
  END
);

ALTER TABLE "AttendancePunchEvent"
ADD CONSTRAINT "attendance_punch_event_offline_shape_check"
CHECK (
  CASE WHEN "sourceCode" = 'offline' THEN
    (CASE WHEN "offlinePackageId" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "offlineSequence" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "offlinePriorHash" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "offlineEventPayloadHash" IS NOT NULL THEN 1 ELSE 0 END) = 4
  ELSE
    (CASE WHEN "offlinePackageId" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "offlineSequence" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "offlinePriorHash" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "offlineEventPayloadHash" IS NOT NULL THEN 1 ELSE 0 END) = 0
  END
);

ALTER TABLE "AttendancePunchEvent"
ADD CONSTRAINT "attendance_punch_event_offline_sequence_check"
CHECK ("offlineSequence" IS NULL OR "offlineSequence" >= 1);

ALTER TABLE "AttendancePunchEvent"
ADD CONSTRAINT "attendance_punch_event_offline_hashes_check"
CHECK (
  ("offlinePriorHash" IS NULL OR "offlinePriorHash" ~ '^[0-9a-f]{64}$')
  AND ("offlineEventPayloadHash" IS NULL OR "offlineEventPayloadHash" ~ '^[0-9a-f]{64}$')
);

-- AlterTable
ALTER TABLE "AttendancePunchEvent" ADD COLUMN     "importJobItemId" TEXT;

-- AlterTable
ALTER TABLE "ParticipantServiceSegmentRevision" ADD COLUMN     "effectiveBatchId" TEXT;

-- CreateTable
CREATE TABLE "AttendanceSettlementRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "currentDraftVersion" INTEGER,
    "currentSubmittedVersion" INTEGER,
    "currentPostedVersion" INTEGER,
    "currentClosureRevision" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AttendanceSettlementRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceSettlementVersion" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settlementRunId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "evidenceSealId" TEXT NOT NULL,
    "evidenceRevision" INTEGER NOT NULL,
    "populationRevision" INTEGER NOT NULL,
    "workflowRevision" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "personCount" INTEGER NOT NULL,
    "sessionParticipationCount" INTEGER NOT NULL,
    "serviceSegmentCount" INTEGER NOT NULL,
    "createdByUserId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "statusCode" TEXT NOT NULL,
    "priorVersionId" TEXT,
    "returnFromStage" TEXT,
    "returnReason" TEXT,
    "operationKey" TEXT,
    "requestHash" TEXT,

    CONSTRAINT "AttendanceSettlementVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementReviewAction" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settlementVersionId" TEXT NOT NULL,
    "stageCode" TEXT NOT NULL,
    "actionCode" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "operationKey" TEXT NOT NULL,
    "requestHash" TEXT,

    CONSTRAINT "SettlementReviewAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipantSettlementResultRevision" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settlementVersionId" TEXT NOT NULL,
    "participationIdentityId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "resultCode" TEXT NOT NULL,
    "lateFlag" BOOLEAN NOT NULL DEFAULT false,
    "earlyLeaveFlag" BOOLEAN NOT NULL DEFAULT false,
    "exceptionFlagsJson" JSONB,
    "recognizedServiceHours" DECIMAL(5,2) NOT NULL,
    "recognizedContributionPoints" DECIMAL(5,2) NOT NULL,
    "calculatedServiceHours" DECIMAL(5,2) NOT NULL,
    "calculatedContributionPoints" DECIMAL(5,2) NOT NULL,
    "adjustmentReason" TEXT,
    "statusCode" TEXT NOT NULL,
    "baseResultRevisionId" TEXT,
    "correctionRequestId" TEXT,

    CONSTRAINT "ParticipantSettlementResultRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipantSettlementDay" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resultRevisionId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "ledgerDate" DATE NOT NULL,
    "serviceHours" DECIMAL(5,2) NOT NULL,
    "recognizedPoints" DECIMAL(5,2) NOT NULL,
    "creditedPoints" DECIMAL(5,2) NOT NULL,
    "cappedOutPoints" DECIMAL(5,2) NOT NULL,
    "sequenceStartAt" TIMESTAMP(3) NOT NULL,
    "stableOrderKey" TEXT NOT NULL,

    CONSTRAINT "ParticipantSettlementDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerPostingBatch" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settlementRunId" TEXT NOT NULL,
    "settlementVersionId" TEXT NOT NULL,
    "batchRevision" INTEGER NOT NULL,
    "statusCode" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "baselineJsonHash" TEXT,
    "preparedCount" INTEGER NOT NULL DEFAULT 0,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "preparedAt" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "preparedByUserId" TEXT,
    "committedByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LedgerPostingBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipationLedgerEntry" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postingBatchId" TEXT NOT NULL,
    "entryKey" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "memberId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "participationIdentityId" TEXT NOT NULL,
    "resultRevisionId" TEXT NOT NULL,
    "ledgerDate" DATE NOT NULL,
    "entryTypeCode" TEXT NOT NULL,
    "serviceHoursDelta" DECIMAL(5,2) NOT NULL,
    "recognizedPointsDelta" DECIMAL(5,2) NOT NULL,
    "creditedPointsDelta" DECIMAL(5,2) NOT NULL,
    "cappedOutPointsDelta" DECIMAL(5,2) NOT NULL,
    "reversesEntryId" TEXT,

    CONSTRAINT "ParticipationLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntryReversalClaim" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "originalEntryId" TEXT NOT NULL,

    CONSTRAINT "LedgerEntryReversalClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberContributionDayState" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "memberId" TEXT NOT NULL,
    "ledgerDate" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "committedCreditedPoints" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "latestBatchId" TEXT,

    CONSTRAINT "MemberContributionDayState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceCorrectionRequest" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "settlementRunId" TEXT NOT NULL,
    "participationIdentityId" TEXT,
    "baseSettlementVersionId" TEXT NOT NULL,
    "baseResultRevisionId" TEXT,
    "baseClosureRevision" INTEGER NOT NULL,
    "requestTypeCode" TEXT NOT NULL,
    "requestedChangeJson" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "attachmentIds" JSONB,
    "statusCode" TEXT NOT NULL,
    "submittedByUserId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "operationKey" TEXT,
    "requestHash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AttendanceCorrectionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrectionApplication" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "correctionRequestId" TEXT NOT NULL,
    "newSettlementVersionId" TEXT NOT NULL,
    "newResultRevisionIds" JSONB NOT NULL,
    "newPostingBatchId" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,

    CONSTRAINT "CorrectionApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivitySettlementClosureRevision" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "settlementVersionId" TEXT NOT NULL,
    "postingBatchId" TEXT NOT NULL,
    "evidenceSealId" TEXT NOT NULL,
    "evidenceRevision" INTEGER NOT NULL,
    "populationRevision" INTEGER NOT NULL,
    "workflowRevision" INTEGER NOT NULL,
    "personCount" INTEGER NOT NULL,
    "sessionParticipationCount" INTEGER NOT NULL,
    "resultCountsJson" JSONB NOT NULL,
    "serviceHours" DECIMAL(12,2) NOT NULL,
    "contributionPoints" DECIMAL(12,2) NOT NULL,
    "checksHash" TEXT NOT NULL,
    "checksJson" JSONB NOT NULL,
    "statusCode" TEXT NOT NULL,
    "closedByUserId" TEXT,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "supersededByCorrectionId" TEXT,

    CONSTRAINT "ActivitySettlementClosureRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityBatchJob" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "jobTypeCode" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT,
    "settlementVersionId" TEXT,
    "postingBatchId" TEXT,
    "statusCode" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "payloadVersion" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,

    CONSTRAINT "ActivityBatchJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityBatchJobItem" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "jobId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "safeMessage" TEXT,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "payloadHash" TEXT,
    "resultReference" TEXT,

    CONSTRAINT "ActivityBatchJobItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSettlementRun_activityId_key" ON "AttendanceSettlementRun"("activityId");

-- CreateIndex
CREATE INDEX "attendance_settlement_run_status_idx" ON "AttendanceSettlementRun"("statusCode");

-- CreateIndex
CREATE INDEX "attendance_settlement_version_run_idx" ON "AttendanceSettlementVersion"("settlementRunId");

-- CreateIndex
CREATE INDEX "attendance_settlement_version_status_idx" ON "AttendanceSettlementVersion"("statusCode");

-- CreateIndex
CREATE INDEX "attendance_settlement_version_seal_idx" ON "AttendanceSettlementVersion"("evidenceSealId");

-- CreateIndex
CREATE INDEX "attendance_settlement_version_prior_idx" ON "AttendanceSettlementVersion"("priorVersionId");

-- CreateIndex
CREATE INDEX "attendance_settlement_version_operation_key_idx" ON "AttendanceSettlementVersion"("operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_settlement_version_run_version_key" ON "AttendanceSettlementVersion"("settlementRunId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementReviewAction_operationKey_key" ON "SettlementReviewAction"("operationKey");

-- CreateIndex
CREATE INDEX "settlement_review_action_version_idx" ON "SettlementReviewAction"("settlementVersionId");

-- CreateIndex
CREATE INDEX "settlement_review_action_version_stage_idx" ON "SettlementReviewAction"("settlementVersionId", "stageCode");

-- CreateIndex
CREATE INDEX "settlement_review_action_actor_acted_idx" ON "SettlementReviewAction"("actorUserId", "actedAt");

-- CreateIndex
CREATE INDEX "participant_settlement_result_version_result_idx" ON "ParticipantSettlementResultRevision"("settlementVersionId", "resultCode");

-- CreateIndex
CREATE INDEX "participant_settlement_result_identity_status_idx" ON "ParticipantSettlementResultRevision"("participationIdentityId", "statusCode");

-- CreateIndex
CREATE INDEX "participant_settlement_result_status_idx" ON "ParticipantSettlementResultRevision"("statusCode");

-- CreateIndex
CREATE INDEX "participant_settlement_result_base_idx" ON "ParticipantSettlementResultRevision"("baseResultRevisionId");

-- CreateIndex
CREATE INDEX "participant_settlement_result_correction_idx" ON "ParticipantSettlementResultRevision"("correctionRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "participant_settlement_result_version_identity_key" ON "ParticipantSettlementResultRevision"("settlementVersionId", "participationIdentityId");

-- CreateIndex
CREATE INDEX "participant_settlement_day_member_date_idx" ON "ParticipantSettlementDay"("memberId", "ledgerDate");

-- CreateIndex
CREATE INDEX "participant_settlement_day_result_idx" ON "ParticipantSettlementDay"("resultRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "participant_settlement_day_result_date_key" ON "ParticipantSettlementDay"("resultRevisionId", "ledgerDate");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerPostingBatch_requestKey_key" ON "LedgerPostingBatch"("requestKey");

-- CreateIndex
CREATE INDEX "ledger_posting_batch_status_created_idx" ON "LedgerPostingBatch"("statusCode", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_posting_batch_version_idx" ON "LedgerPostingBatch"("settlementVersionId");

-- CreateIndex
CREATE INDEX "ledger_posting_batch_run_idx" ON "LedgerPostingBatch"("settlementRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_posting_batch_version_revision_key" ON "LedgerPostingBatch"("settlementVersionId", "batchRevision");

-- CreateIndex
CREATE UNIQUE INDEX "ParticipationLedgerEntry_entryKey_key" ON "ParticipationLedgerEntry"("entryKey");

-- CreateIndex
CREATE UNIQUE INDEX "ParticipationLedgerEntry_operationKey_key" ON "ParticipationLedgerEntry"("operationKey");

-- CreateIndex
CREATE INDEX "participation_ledger_entry_member_date_idx" ON "ParticipationLedgerEntry"("memberId", "ledgerDate");

-- CreateIndex
CREATE INDEX "participation_ledger_entry_activity_batch_idx" ON "ParticipationLedgerEntry"("activityId", "postingBatchId");

-- CreateIndex
CREATE INDEX "participation_ledger_entry_batch_result_idx" ON "ParticipationLedgerEntry"("postingBatchId", "resultRevisionId");

-- CreateIndex
CREATE INDEX "participation_ledger_entry_session_idx" ON "ParticipationLedgerEntry"("sessionId");

-- CreateIndex
CREATE INDEX "participation_ledger_entry_identity_idx" ON "ParticipationLedgerEntry"("participationIdentityId");

-- CreateIndex
CREATE INDEX "participation_ledger_entry_type_idx" ON "ParticipationLedgerEntry"("entryTypeCode");

-- CreateIndex
CREATE INDEX "participation_ledger_entry_reverses_idx" ON "ParticipationLedgerEntry"("reversesEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "participation_ledger_entry_batch_result_date_type_key" ON "ParticipationLedgerEntry"("postingBatchId", "resultRevisionId", "ledgerDate", "entryTypeCode");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntryReversalClaim_originalEntryId_key" ON "LedgerEntryReversalClaim"("originalEntryId");

-- CreateIndex
CREATE INDEX "member_contribution_day_state_date_idx" ON "MemberContributionDayState"("ledgerDate");

-- CreateIndex
CREATE INDEX "member_contribution_day_state_batch_idx" ON "MemberContributionDayState"("latestBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "member_contribution_day_state_member_date_key" ON "MemberContributionDayState"("memberId", "ledgerDate");

-- CreateIndex
CREATE INDEX "attendance_correction_request_activity_status_idx" ON "AttendanceCorrectionRequest"("activityId", "statusCode");

-- CreateIndex
CREATE INDEX "attendance_correction_request_identity_status_idx" ON "AttendanceCorrectionRequest"("participationIdentityId", "statusCode");

-- CreateIndex
CREATE INDEX "attendance_correction_request_run_idx" ON "AttendanceCorrectionRequest"("settlementRunId");

-- CreateIndex
CREATE INDEX "attendance_correction_request_base_version_idx" ON "AttendanceCorrectionRequest"("baseSettlementVersionId");

-- CreateIndex
CREATE INDEX "attendance_correction_request_operation_key_idx" ON "AttendanceCorrectionRequest"("operationKey");

-- CreateIndex
CREATE INDEX "correction_application_request_idx" ON "CorrectionApplication"("correctionRequestId");

-- CreateIndex
CREATE INDEX "correction_application_status_idx" ON "CorrectionApplication"("statusCode");

-- CreateIndex
CREATE INDEX "correction_application_new_version_idx" ON "CorrectionApplication"("newSettlementVersionId");

-- CreateIndex
CREATE INDEX "correction_application_new_batch_idx" ON "CorrectionApplication"("newPostingBatchId");

-- CreateIndex
CREATE INDEX "activity_settlement_closure_activity_idx" ON "ActivitySettlementClosureRevision"("activityId");

-- CreateIndex
CREATE INDEX "activity_settlement_closure_status_idx" ON "ActivitySettlementClosureRevision"("statusCode");

-- CreateIndex
CREATE INDEX "activity_settlement_closure_version_idx" ON "ActivitySettlementClosureRevision"("settlementVersionId");

-- CreateIndex
CREATE INDEX "activity_settlement_closure_batch_idx" ON "ActivitySettlementClosureRevision"("postingBatchId");

-- CreateIndex
CREATE INDEX "activity_settlement_closure_seal_idx" ON "ActivitySettlementClosureRevision"("evidenceSealId");

-- CreateIndex
CREATE INDEX "activity_settlement_closure_superseded_by_idx" ON "ActivitySettlementClosureRevision"("supersededByCorrectionId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_settlement_closure_activity_revision_key" ON "ActivitySettlementClosureRevision"("activityId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityBatchJob_operationKey_key" ON "ActivityBatchJob"("operationKey");

-- CreateIndex
CREATE INDEX "activity_batch_job_claim_idx" ON "ActivityBatchJob"("statusCode", "availableAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "activity_batch_job_activity_created_idx" ON "ActivityBatchJob"("activityId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_batch_job_lease_expires_idx" ON "ActivityBatchJob"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "activity_batch_job_type_idx" ON "ActivityBatchJob"("jobTypeCode");

-- CreateIndex
CREATE INDEX "activity_batch_job_session_idx" ON "ActivityBatchJob"("sessionId");

-- CreateIndex
CREATE INDEX "activity_batch_job_version_idx" ON "ActivityBatchJob"("settlementVersionId");

-- CreateIndex
CREATE INDEX "activity_batch_job_batch_idx" ON "ActivityBatchJob"("postingBatchId");

-- CreateIndex
CREATE INDEX "activity_batch_job_item_job_status_idx" ON "ActivityBatchJobItem"("jobId", "statusCode");

-- CreateIndex
CREATE INDEX "activity_batch_job_item_resource_idx" ON "ActivityBatchJobItem"("resourceType", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_batch_job_item_job_key_key" ON "ActivityBatchJobItem"("jobId", "itemKey");

-- CreateIndex
CREATE INDEX "AttendancePunchEvent_importJobItemId_idx" ON "AttendancePunchEvent"("importJobItemId");

-- CreateIndex
CREATE INDEX "participant_service_segment_effective_batch_idx" ON "ParticipantServiceSegmentRevision"("effectiveBatchId");

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_importJobItemId_fkey" FOREIGN KEY ("importJobItemId") REFERENCES "ActivityBatchJobItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantServiceSegmentRevision" ADD CONSTRAINT "ParticipantServiceSegmentRevision_effectiveBatchId_fkey" FOREIGN KEY ("effectiveBatchId") REFERENCES "LedgerPostingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSettlementRun" ADD CONSTRAINT "AttendanceSettlementRun_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSettlementVersion" ADD CONSTRAINT "AttendanceSettlementVersion_settlementRunId_fkey" FOREIGN KEY ("settlementRunId") REFERENCES "AttendanceSettlementRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSettlementVersion" ADD CONSTRAINT "AttendanceSettlementVersion_evidenceSealId_fkey" FOREIGN KEY ("evidenceSealId") REFERENCES "EvidenceSeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSettlementVersion" ADD CONSTRAINT "AttendanceSettlementVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSettlementVersion" ADD CONSTRAINT "AttendanceSettlementVersion_priorVersionId_fkey" FOREIGN KEY ("priorVersionId") REFERENCES "AttendanceSettlementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementReviewAction" ADD CONSTRAINT "SettlementReviewAction_settlementVersionId_fkey" FOREIGN KEY ("settlementVersionId") REFERENCES "AttendanceSettlementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementReviewAction" ADD CONSTRAINT "SettlementReviewAction_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantSettlementResultRevision" ADD CONSTRAINT "ParticipantSettlementResultRevision_settlementVersionId_fkey" FOREIGN KEY ("settlementVersionId") REFERENCES "AttendanceSettlementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantSettlementResultRevision" ADD CONSTRAINT "ParticipantSettlementResultRevision_participationIdentityI_fkey" FOREIGN KEY ("participationIdentityId") REFERENCES "ActivityParticipationIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantSettlementResultRevision" ADD CONSTRAINT "ParticipantSettlementResultRevision_baseResultRevisionId_fkey" FOREIGN KEY ("baseResultRevisionId") REFERENCES "ParticipantSettlementResultRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantSettlementResultRevision" ADD CONSTRAINT "ParticipantSettlementResultRevision_correctionRequestId_fkey" FOREIGN KEY ("correctionRequestId") REFERENCES "AttendanceCorrectionRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantSettlementDay" ADD CONSTRAINT "ParticipantSettlementDay_resultRevisionId_fkey" FOREIGN KEY ("resultRevisionId") REFERENCES "ParticipantSettlementResultRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantSettlementDay" ADD CONSTRAINT "ParticipantSettlementDay_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerPostingBatch" ADD CONSTRAINT "LedgerPostingBatch_settlementRunId_fkey" FOREIGN KEY ("settlementRunId") REFERENCES "AttendanceSettlementRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerPostingBatch" ADD CONSTRAINT "LedgerPostingBatch_settlementVersionId_fkey" FOREIGN KEY ("settlementVersionId") REFERENCES "AttendanceSettlementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerPostingBatch" ADD CONSTRAINT "LedgerPostingBatch_preparedByUserId_fkey" FOREIGN KEY ("preparedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerPostingBatch" ADD CONSTRAINT "LedgerPostingBatch_committedByUserId_fkey" FOREIGN KEY ("committedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipationLedgerEntry" ADD CONSTRAINT "ParticipationLedgerEntry_postingBatchId_fkey" FOREIGN KEY ("postingBatchId") REFERENCES "LedgerPostingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipationLedgerEntry" ADD CONSTRAINT "ParticipationLedgerEntry_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipationLedgerEntry" ADD CONSTRAINT "ParticipationLedgerEntry_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipationLedgerEntry" ADD CONSTRAINT "ParticipationLedgerEntry_activityId_sessionId_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipationLedgerEntry" ADD CONSTRAINT "ParticipationLedgerEntry_participationIdentityId_fkey" FOREIGN KEY ("participationIdentityId") REFERENCES "ActivityParticipationIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipationLedgerEntry" ADD CONSTRAINT "ParticipationLedgerEntry_resultRevisionId_fkey" FOREIGN KEY ("resultRevisionId") REFERENCES "ParticipantSettlementResultRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipationLedgerEntry" ADD CONSTRAINT "ParticipationLedgerEntry_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "ParticipationLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntryReversalClaim" ADD CONSTRAINT "LedgerEntryReversalClaim_originalEntryId_fkey" FOREIGN KEY ("originalEntryId") REFERENCES "ParticipationLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberContributionDayState" ADD CONSTRAINT "MemberContributionDayState_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberContributionDayState" ADD CONSTRAINT "MemberContributionDayState_latestBatchId_fkey" FOREIGN KEY ("latestBatchId") REFERENCES "LedgerPostingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "AttendanceCorrectionRequest_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "AttendanceCorrectionRequest_settlementRunId_fkey" FOREIGN KEY ("settlementRunId") REFERENCES "AttendanceSettlementRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "AttendanceCorrectionRequest_participationIdentityId_fkey" FOREIGN KEY ("participationIdentityId") REFERENCES "ActivityParticipationIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "AttendanceCorrectionRequest_baseSettlementVersionId_fkey" FOREIGN KEY ("baseSettlementVersionId") REFERENCES "AttendanceSettlementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "AttendanceCorrectionRequest_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrectionRequest" ADD CONSTRAINT "AttendanceCorrectionRequest_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionApplication" ADD CONSTRAINT "CorrectionApplication_correctionRequestId_fkey" FOREIGN KEY ("correctionRequestId") REFERENCES "AttendanceCorrectionRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionApplication" ADD CONSTRAINT "CorrectionApplication_newSettlementVersionId_fkey" FOREIGN KEY ("newSettlementVersionId") REFERENCES "AttendanceSettlementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionApplication" ADD CONSTRAINT "CorrectionApplication_newPostingBatchId_fkey" FOREIGN KEY ("newPostingBatchId") REFERENCES "LedgerPostingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySettlementClosureRevision" ADD CONSTRAINT "ActivitySettlementClosureRevision_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySettlementClosureRevision" ADD CONSTRAINT "ActivitySettlementClosureRevision_settlementVersionId_fkey" FOREIGN KEY ("settlementVersionId") REFERENCES "AttendanceSettlementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySettlementClosureRevision" ADD CONSTRAINT "ActivitySettlementClosureRevision_postingBatchId_fkey" FOREIGN KEY ("postingBatchId") REFERENCES "LedgerPostingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySettlementClosureRevision" ADD CONSTRAINT "ActivitySettlementClosureRevision_evidenceSealId_fkey" FOREIGN KEY ("evidenceSealId") REFERENCES "EvidenceSeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySettlementClosureRevision" ADD CONSTRAINT "ActivitySettlementClosureRevision_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySettlementClosureRevision" ADD CONSTRAINT "ActivitySettlementClosureRevision_supersededByCorrectionId_fkey" FOREIGN KEY ("supersededByCorrectionId") REFERENCES "AttendanceCorrectionRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityBatchJob" ADD CONSTRAINT "ActivityBatchJob_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityBatchJob" ADD CONSTRAINT "ActivityBatchJob_activityId_sessionId_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityBatchJob" ADD CONSTRAINT "ActivityBatchJob_settlementVersionId_fkey" FOREIGN KEY ("settlementVersionId") REFERENCES "AttendanceSettlementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityBatchJob" ADD CONSTRAINT "ActivityBatchJob_postingBatchId_fkey" FOREIGN KEY ("postingBatchId") REFERENCES "LedgerPostingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityBatchJob" ADD CONSTRAINT "ActivityBatchJob_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityBatchJobItem" ADD CONSTRAINT "ActivityBatchJobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ActivityBatchJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 手工追加段 —— 活动改造 v1.1 第 1 批第四刀
-- (合同 §3.19 / §3.20 / §3.21 / §3.22 / §3.23 / §3.24 / §3.25 / §3.26 / §3.27)
--
-- 上方骨架由**只读** `prisma migrate diff` 生成,并剥掉两条**与本刀无关的存量**
-- RenameIndex(在 main 上跑同一条 diff 得到逐字相同的两条 ⇒ 长索引名 63 字符截断口径
-- 的存量漂移,沿前三刀 / 证书 PR-4b / 企微 T1 同一处置)。
--
-- 本段全部是 Prisma DSL 表达不了的东西:CHECK 闭集、partial unique、append-only trigger。
--
-- 🔴 NULL 边界纪律(前三刀积累,本刀逐条复用):
--    CHECK 在表达式求值为 **NULL** 时**判通过** ⇒ 静默失效。
--    `FALSE AND NULL = FALSE`(AND 是 FALSE-主导,安全);
--    `FALSE OR  NULL = NULL` (OR 危险,第一刀就栽在这里)。
--    ⇒ 凡用 OR / 算术等式的地方,操作数必须结构上恒二值:
--       判别列 NOT NULL 的 `IN` / `IS [NOT] NULL` / `IS DISTINCT FROM` 恒二值;
--       算术等式**必须**把 `IS NOT NULL` 守卫写在 AND 链最前(见 balance_check)。
-- ============================================================================


-- ============================================================================
-- ⚠️ 刻意不做(一):跨行不变量不进 DB —— 「日合计必须 0..3」(§3.24)
-- ============================================================================
--
-- §3.24 原话:「committed 后递增 version 并更新日合计,**日合计必须 0..3**」。
--
-- 这条**刻意不落任何表级 CHECK、也不落任何 trigger**,不是漏了:
--
--   1. 它是**跨行**不变量 —— 「同一 member 同一 ledgerDate 的多条
--      ParticipationLedgerEntry 的 creditedPointsDelta 之和」。
--      表级 CHECK 只能看**当前这一行的列值**,表达不了跨行求和。
--   2. 用 trigger 伪造跨行求和会在并发下**骗人**:两个并发事务各自 SELECT sum(...)
--      时都看不见对方未提交的行,双方各自判定"没超",提交后合计超标 —— 
--      trigger 会给出"已经守住了"的假象,比没有更危险。
--   3. 正确落点在 **service(第 2 批)**:在**既有** member advisory lock 内,
--      按 `(memberId, ledgerDate)` 排序 `FOR UPDATE` 取 MemberContributionDayState,
--      比对 baseline version 后再决定能否 commit(§3.24 自己就是这么写的)。
--      本刀建的 MemberContributionDayState 正是给那条路径用的持久化日版本行。
--
-- ⚠️ 连带:`MemberContributionDayState.committedCreditedPoints` 上**也不加** 0..3 的
--    单行 range CHECK。该列是**物化的日合计**,单行 range 在语法上写得出来,但
--    DB 无法校验"这个物化值确实等于那些分录之和" —— 加上去会让人误以为日上限
--    已经有 DB 执行位。执行位只有一个,在 service。本刀只落 `version >= 0`
--    (goal DoD 7 对本表点名的恰好就是 unique + version >= 0 两条)。
--
--    (若维护者认为该物化列仍值得一条单行 range CHECK,它是**可独立追加**的一条,
--     不影响本 migration 任何其它约束 —— 已在报告中列为待拍板项。)


-- ===== ① "AttendanceSettlementRun"(§3.19)=====

-- §3.19 明写九值闭集。NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "AttendanceSettlementRun"
ADD CONSTRAINT "attendance_settlement_run_status_code_check"
CHECK ("statusCode" IN (
  'not_started', 'drafting', 'submitted', 'pending_first_review',
  'pending_final_review', 'posting', 'posted', 'correction_open', 'closed'
));

-- CAS 版本号非负(沿前三刀计数器口径)。NULL 边界:version NOT NULL ⇒ 恒二值。
ALTER TABLE "AttendanceSettlementRun"
ADD CONSTRAINT "attendance_settlement_run_version_check"
CHECK ("version" >= 0);

-- 四个 current* 指针非负。四列均可空(尚未产生该阶段版本时为 NULL);
-- NULL 边界:`IS NULL` 为 FALSE 时该列必非空 ⇒ 右 operand 必二值,不存在 FALSE OR NULL 塌陷。
-- 诚实标注:去掉 `IS NULL OR` 守卫后判定完全相同(NULL >= 0 得 NULL,CHECK 亦放行)
-- ⇒ 这一句是**自证文档而非行为**(沿第二刀 / 第三刀同一诚实结论)。
ALTER TABLE "AttendanceSettlementRun"
ADD CONSTRAINT "attendance_settlement_run_pointers_check"
CHECK (
  ("currentDraftVersion" IS NULL OR "currentDraftVersion" >= 0)
  AND ("currentSubmittedVersion" IS NULL OR "currentSubmittedVersion" >= 0)
  AND ("currentPostedVersion" IS NULL OR "currentPostedVersion" >= 0)
  AND ("currentClosureRevision" IS NULL OR "currentClosureRevision" >= 0)
);


-- ===== ② "AttendanceSettlementVersion"(§3.19)=====

-- §3.19 明写五值闭集。NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "AttendanceSettlementVersion"
ADD CONSTRAINT "attendance_settlement_version_status_code_check"
CHECK ("statusCode" IN ('draft', 'submitted', 'returned', 'approved', 'voided'));

-- 版本号与三个 revision 快照非负。NULL 边界:四列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "AttendanceSettlementVersion"
ADD CONSTRAINT "attendance_settlement_version_numbers_check"
CHECK (
  "version" >= 0
  AND "evidenceRevision" >= 0
  AND "populationRevision" >= 0
  AND "workflowRevision" >= 0
);

-- 三个计数快照非负。NULL 边界:三列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "AttendanceSettlementVersion"
ADD CONSTRAINT "attendance_settlement_version_counts_check"
CHECK (
  "personCount" >= 0
  AND "sessionParticipationCount" >= 0
  AND "serviceSegmentCount" >= 0
);

-- 🟡 `returnFromStage` 的取值集合合同**没有单独列**,但 §3.19 的 SettlementReviewAction
--    把审核阶段冻结成 `first/final` 二值 ——「从哪个阶段退回」只能是这两个阶段之一。
--    这是从合同**同节**直接读出的推导,不是发明;已在报告「与合同的偏离」段列出。
-- NULL 边界:可空列,`IS NULL` 为 FALSE 时该列必非空 ⇒ 右 operand 恒二值。
ALTER TABLE "AttendanceSettlementVersion"
ADD CONSTRAINT "attendance_settlement_version_return_stage_check"
CHECK ("returnFromStage" IS NULL OR "returnFromStage" IN ('first', 'final'));


-- ===== ③ "SettlementReviewAction"(§3.19)=====

-- §3.19 明写二值闭集。NULL 边界:两列均 NOT NULL ⇒ IN 恒二值。
ALTER TABLE "SettlementReviewAction"
ADD CONSTRAINT "settlement_review_action_stage_code_check"
CHECK ("stageCode" IN ('first', 'final'));

ALTER TABLE "SettlementReviewAction"
ADD CONSTRAINT "settlement_review_action_action_code_check"
CHECK ("actionCode" IN ('approve', 'return'));

-- §3.19「一版本一阶段只允许**一个生效决定**」。
-- 🟢 键列 settlementVersionId / stageCode **均 NOT NULL** ⇒ 不需要 NULLS NOT DISTINCT。
-- 🟡 谓词取「决定型动作」`actionCode IN ('approve','return')`。诚实说明:在当前
--    actionCode 闭集(恰好就是这两个)下该谓词**恒真**,故本索引在行为上等价于
--    普通 unique —— 写成 partial 是为了让"生效决定"这个语义显式落在谓词里,
--    将来若追加非决定型 action(如 comment)不必改索引定义。
--    它**不是**一条有独立可观测行为的 partial(与第三刀 supersede_target 那条同类诚实标注)。
CREATE UNIQUE INDEX "settlement_review_action_effective_decision_unique"
ON "SettlementReviewAction" ("settlementVersionId", "stageCode")
WHERE "actionCode" IN ('approve', 'return');


-- ===== ④ "ParticipantSettlementResultRevision"(§3.20)=====

-- §3.20 明写十值闭集。NULL 边界:resultCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "ParticipantSettlementResultRevision"
ADD CONSTRAINT "participant_settlement_result_result_code_check"
CHECK ("resultCode" IN (
  'present', 'leave', 'absent', 'cancelled', 'not_selected',
  'waitlist_expired', 'review_expired', 'invitation_expired',
  'exempt', 'early_departure_zero'
));

-- §3.20 明写三值闭集。NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "ParticipantSettlementResultRevision"
ADD CONSTRAINT "participant_settlement_result_status_code_check"
CHECK ("statusCode" IN ('draft', 'committed', 'superseded'));

-- revision 计数器非负。NULL 边界:NOT NULL ⇒ 恒二值。
ALTER TABLE "ParticipantSettlementResultRevision"
ADD CONSTRAINT "participant_settlement_result_revision_number_check"
CHECK ("revision" >= 0);

-- 认定值与计算值均非负(冲回是账本分录的事,结果修订上不出现负时长/负分)。
-- NULL 边界:四列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "ParticipantSettlementResultRevision"
ADD CONSTRAINT "participant_settlement_result_amounts_check"
CHECK (
  "recognizedServiceHours" >= 0
  AND "recognizedContributionPoints" >= 0
  AND "calculatedServiceHours" >= 0
  AND "calculatedContributionPoints" >= 0
);

-- 🔴 §3.20:「`adjustmentReason`:认定与计算不同**必填**」—— 典型 OR 形状。
--
-- NULL 边界(本条是本刀第二高危项,仅次于 balance_check):
--   - 判别用 `IS DISTINCT FROM` 而不是 `<>`:`<>` 在任一侧为 NULL 时求值成 NULL,
--     会让整个 CASE 的 WHEN 落进 ELSE 分支 ⇒ 该必填悄悄失效。
--     `IS DISTINCT FROM` **恒二值**,NULL 也参与比较,结构上不可能塌陷。
--     (本刀四个 amount 列已 NOT NULL,故此刻两种写法判定相同;用 IS DISTINCT FROM
--      是为了让这条 CHECK 在"日后有人把某列放开成可空"时仍然成立 —— 判据不依赖
--      别处的 NOT NULL 声明。)
--   - `THEN` 侧把 `IS NOT NULL` 写在 AND 链最前(AND 是 FALSE-主导)⇒ 恒二值。
--   - 用 CASE ... ELSE TRUE 而不是单条大 OR:显式放行"认定 == 计算"的行,
--     不会像第三刀初版那样误杀合法行。
ALTER TABLE "ParticipantSettlementResultRevision"
ADD CONSTRAINT "participant_settlement_result_adjustment_reason_check"
CHECK (
  CASE
    WHEN "recognizedServiceHours" IS DISTINCT FROM "calculatedServiceHours"
      OR "recognizedContributionPoints" IS DISTINCT FROM "calculatedContributionPoints"
    THEN "adjustmentReason" IS NOT NULL AND length(btrim("adjustmentReason")) > 0
    ELSE TRUE
  END
);


-- ===== ⑤ "ParticipantSettlementDay"(§3.21)=====

-- 🔴 `ledgerDate` 已由上方 CreateTable 落成 PostgreSQL `date`(Prisma `@db.Date`)——
--    §3.21「必须唯一选型」的三处同型之一。混型(date vs timestamp)会让
--    `(memberId, ledgerDate)` 唯一在跨表 join 时静默错位。
--    unique `(resultRevisionId, ledgerDate)` 由上方 Prisma 生成的
--    "participant_settlement_day_result_date_key" 承担。

-- 四个金额列非负(本表是"当日应得"的拆分投影,不承载冲回)。
-- NULL 边界:四列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "ParticipantSettlementDay"
ADD CONSTRAINT "participant_settlement_day_amounts_check"
CHECK (
  "serviceHours" >= 0
  AND "recognizedPoints" >= 0
  AND "creditedPoints" >= 0
  AND "cappedOutPoints" >= 0
);

-- 稳定排序键不得为空白 —— 空键让"日内确定性排序"退化成不确定,
-- 而分配顺序直接决定谁被日上限截掉(沿仓内 length >= 1 类 CHECK 的既有口径)。
-- NULL 边界:stableOrderKey NOT NULL ⇒ 恒二值。
ALTER TABLE "ParticipantSettlementDay"
ADD CONSTRAINT "participant_settlement_day_order_key_check"
CHECK (length(btrim("stableOrderKey")) > 0);


-- ===== ⑥ "LedgerPostingBatch"(§3.22)=====

-- §3.22 明写五值闭集。NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "LedgerPostingBatch"
ADD CONSTRAINT "ledger_posting_batch_status_code_check"
CHECK ("statusCode" IN ('preparing', 'ready', 'committed', 'failed', 'voided'));

-- 批次号、CAS 版本号与三个进度计数非负。NULL 边界:五列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "LedgerPostingBatch"
ADD CONSTRAINT "ledger_posting_batch_counters_check"
CHECK (
  "batchRevision" >= 0
  AND "version" >= 0
  AND "preparedCount" >= 0
  AND "totalCount" >= 0
  AND "failureCount" >= 0
);

-- 🔴 §3.22:「**一个 SettlementVersion 至多一个 committed posting batch**」。
-- 🟢 键列 settlementVersionId **NOT NULL** ⇒ 不需要 NULLS NOT DISTINCT
--    (与第二刀 activity_invitation_active_unique 的处境不同 —— 那条的 sessionId 可空)。
-- 🔴 谓词只认 'committed':preparing / ready / failed / voided 都不占槽,
--    失败重来可以再建批次,而已生效的账不会被第二个 committed 批次重复入账。
CREATE UNIQUE INDEX "ledger_posting_batch_committed_unique"
ON "LedgerPostingBatch" ("settlementVersionId")
WHERE "statusCode" = 'committed';


-- ===== ⑦ "ParticipationLedgerEntry"(§3.23)—— 本刀语义最像钱的一张表 =====

-- §3.23 明写四值闭集。NULL 边界:entryTypeCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "ParticipationLedgerEntry"
ADD CONSTRAINT "participation_ledger_entry_type_code_check"
CHECK ("entryTypeCode" IN (
  'service_credit', 'contribution_credit', 'service_reversal', 'contribution_reversal'
));

-- 🔴 §3.23.4:「reversal entry **必须**带 `reversesEntryId`;普通 credit **不得**带」。
-- NULL 边界:判别列 entryTypeCode NOT NULL ⇒ WHEN 恒二值;`IS [NOT] NULL` 亦恒二值。
-- 用 CASE ... ELSE TRUE 而不是单条大 OR(沿第三刀实测教训:朴素单条 OR 会在
-- 两支路同时为假时误杀合法行;CASE 显式放行未点名的类型,且每侧可独立断言)。
ALTER TABLE "ParticipationLedgerEntry"
ADD CONSTRAINT "participation_ledger_entry_reversal_shape_check"
CHECK (
  CASE
    WHEN "entryTypeCode" IN ('service_reversal', 'contribution_reversal')
      THEN "reversesEntryId" IS NOT NULL
    WHEN "entryTypeCode" IN ('service_credit', 'contribution_credit')
      THEN "reversesEntryId" IS NULL
    ELSE TRUE
  END
);

-- ============================================================================
-- 🔴🔴 §3.23.6:「recognized = credited + cappedOut 对每个**贡献分录**成立」
--
-- 本刀最高危的一条 —— **纯算术等式**,是 NULL 陷阱的教科书形状:
--   若三列任一为 NULL,`a = b + c` 求值成 **NULL**,而 CHECK 在 NULL 时**判通过**
--   ⇒ 约束**静默失效**,而且只在"恰好有 NULL"的那些行上失效,正对照全绿看不出来。
--
-- 两道独立防线,缺一不可:
--   防线 1:三列(连同 serviceHoursDelta 共四列)在 CreateTable 里**全部 NOT NULL**。
--           账本没有"不知道"的余地 —— 冲回写负数,不写 NULL。
--   防线 2:等式**前面**串三条 `IS NOT NULL` 守卫,且它们在 **AND 链最前**。
--           AND 是 FALSE-主导(`FALSE AND NULL = FALSE`)⇒ 任一列为 NULL 时
--           右 operand 整体求值成 **FALSE**(不是 NULL),外层 `OR` 于是得到
--           `FALSE OR FALSE = FALSE` ⇒ **拒绝**,而不是放行。
--           这让本条在"日后有人把 NOT NULL 放开"时**依然拒绝**,判据不依赖别处声明。
--           (已实测:在 scratch 库上 DROP NOT NULL 后插 NULL 行,仍被 23514 拒。)
--
-- 左 operand `entryTypeCode NOT IN (...)`:entryTypeCode NOT NULL ⇒ 恒二值,
-- 不存在 `NULL OR ...` 的塌陷入口。
--
-- ⚠️ 作用域**严格按合同**:只约束**贡献分录**(contribution_credit / contribution_reversal)。
--    service_* 分录不在 §3.23.6 的措辞内,本刀不擅自扩大(沿「合同没给的不发明」)。
--    报告已把"是否要把 service 分录也纳入"列为待拍板项。
-- ============================================================================
ALTER TABLE "ParticipationLedgerEntry"
ADD CONSTRAINT "participation_ledger_entry_balance_check"
CHECK (
  "entryTypeCode" NOT IN ('contribution_credit', 'contribution_reversal')
  OR (
    "recognizedPointsDelta" IS NOT NULL
    AND "creditedPointsDelta" IS NOT NULL
    AND "cappedOutPointsDelta" IS NOT NULL
    AND "recognizedPointsDelta" = "creditedPointsDelta" + "cappedOutPointsDelta"
  )
);

-- 🔴 §3.23.7:「service／points **小数位和范围**有 CHECK」。
--
-- 小数位:四个 delta 列的物理类型是 `numeric(5,2)`(Prisma `@db.Decimal(5,2)`,
--   沿既有 AttendanceRecord.serviceHours / contributionPoints 口径)。
--   ⚠️ **诚实说明**:`numeric(5,2)` 对超出两位的小数是**四舍五入**而不是报错
--   (插 1.005 得 1.00,不会 22003)⇒ "小数位"这一半由**列类型归一**承担,
--   不是"拒绝"。DB 层没有既保留原值又拒绝多余小数位的写法(值在 CHECK 求值前
--   已被类型归一)。若业务要求"多余小数位必须报错",执法位只能在 service/DTO(第 2 批)。
--   这一条已在报告里单列,不假装 DB 已经守住。
--
-- 范围:合同 §3.23.7 只说"有 CHECK",没给数值。下面两条的数值**全部从合同其它条款推导**,
--   不是拍脑袋(已在报告「与合同的偏离」段逐条列出推导链):
--   - 时长 |delta| <= 24:§3.21 按**北京自然日**拆分,一个 ledgerDate 装不下 24 小时以上。
--   - credited |delta| <= 3:§3.24「日合计必须 0..3」⇒ 单条分录的 credited
--     不可能超过日上限本身(超了当场就破坏日合计)。
--   - recognized / cappedOut **不设**magnitude 上界:recognized 是**封顶前**的认定值,
--     天然可以远大于 3(超出部分正是 cappedOut),给它设 3 会误杀合法行。
--     二者只受 `numeric(5,2)` 的 ±999.99 约束。
-- NULL 边界:四列均 NOT NULL ⇒ 全部比较恒二值。
ALTER TABLE "ParticipationLedgerEntry"
ADD CONSTRAINT "participation_ledger_entry_magnitude_check"
CHECK (
  "serviceHoursDelta" >= -24 AND "serviceHoursDelta" <= 24
  AND "creditedPointsDelta" >= -3 AND "creditedPointsDelta" <= 3
);

-- 🔴 §3.23.7「范围」的第二半:**符号必须与分录类型一致**。
--    推导链:四个列名都叫 `*Delta`,而 §3.24 的「日合计」是这些 delta 的**求和**
--    ⇒ 冲回必须是**负 delta**,否则求和永远只增不减,日合计根本回不去。
--    (若把冲回存成正数量级、让类型码承载方向,§3.24 的求和语义就不成立。)
--    零值合法:early_departure_zero 这类结果的 credit 分录四个 delta 都是 0。
-- NULL 边界:判别列 NOT NULL ⇒ WHEN 恒二值;四个 delta NOT NULL ⇒ 比较恒二值。
ALTER TABLE "ParticipationLedgerEntry"
ADD CONSTRAINT "participation_ledger_entry_sign_check"
CHECK (
  CASE
    WHEN "entryTypeCode" IN ('service_credit', 'contribution_credit')
      THEN "serviceHoursDelta" >= 0
       AND "recognizedPointsDelta" >= 0
       AND "creditedPointsDelta" >= 0
       AND "cappedOutPointsDelta" >= 0
    WHEN "entryTypeCode" IN ('service_reversal', 'contribution_reversal')
      THEN "serviceHoursDelta" <= 0
       AND "recognizedPointsDelta" <= 0
       AND "creditedPointsDelta" <= 0
       AND "cappedOutPointsDelta" <= 0
    ELSE TRUE
  END
);

-- ============================================================================
-- 🔴 §3.23.8 append-only:「**只允许 INSERT**;数据库角色层禁止业务账号 UPDATE/DELETE」
--    ⇒ 由 **数据库 trigger** 强制,不只靠权限与"没写端点"。
--    这是本仓第 **三** 组同形状 trigger:
--      trg_insurance_evidence_20_immutable(第 62 migration)
--      trg_attendance_punch_event_10_append_only(第 73 migration / 第三刀)
--      trg_participation_ledger_entry_10_append_only(本条)
--
-- ⚠️ 行级 trigger **不响应 TRUNCATE**(TRUNCATE 只触发 statement 级 BEFORE TRUNCATE
--    trigger)⇒ `test/setup/reset-db.ts` 的 TRUNCATE ... CASCADE 清库不受影响。
--    本表被 CASCADE 带走(它引用 "Activity" / "Member",两者都在 TRUNCATE 列表内)。
--    这条**已实测**(INSERT 放行 / UPDATE 拒 / DELETE 拒 / TRUNCATE 放行且 trigger 存活),
--    不是推理:见配套 spec 的四条判据。
-- ============================================================================
CREATE FUNCTION participation_ledger_entry_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $participation_ledger_entry_append_only$
BEGIN
  RAISE EXCEPTION 'participation ledger entry is append-only'
  USING
    ERRCODE = '55000',
    CONSTRAINT = 'participation_ledger_entry_append_only';
  RETURN NULL;
END;
$participation_ledger_entry_append_only$;

CREATE TRIGGER trg_participation_ledger_entry_10_append_only
BEFORE UPDATE OR DELETE ON "ParticipationLedgerEntry"
FOR EACH ROW EXECUTE FUNCTION participation_ledger_entry_append_only_guard();


-- ===== ⑧ "LedgerEntryReversalClaim"(§3.23.5)=====
--
-- §3.23.5 **点名**这张辅助表,并且只点名一件事:`originalEntryId` unique
-- ——「一条原 entry 至多被一个 committed reversal 逻辑冲回」。
-- 该 unique 由上方 Prisma 生成的 "LedgerEntryReversalClaim_originalEntryId_key" 承担,
-- 本段无需追加。沿 ④:合同没给的其它列一律不发明(「是哪条 reversal 冲的」已由
-- ParticipationLedgerEntry.reversesEntryId 指回,再存一列就是两处真相源)。


-- ===== ⑨ "MemberContributionDayState"(§3.24)=====

-- CAS 版本号非负。NULL 边界:version NOT NULL ⇒ 恒二值。
-- ⚠️ 「日合计 0..3」在本表上**刻意不落 CHECK** —— 见文件顶部「刻意不做(一)」整段。
ALTER TABLE "MemberContributionDayState"
ADD CONSTRAINT "member_contribution_day_state_version_check"
CHECK ("version" >= 0);


-- ===== ⑩ "AttendanceCorrectionRequest"(§3.25)=====

-- §3.25 明写六值闭集。NULL 边界:requestTypeCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "AttendanceCorrectionRequest"
ADD CONSTRAINT "attendance_correction_request_type_code_check"
CHECK ("requestTypeCode" IN (
  'result', 'service', 'time', 'points', 'person_identity', 'other'
));

-- §3.25 明写七值闭集。NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "AttendanceCorrectionRequest"
ADD CONSTRAINT "attendance_correction_request_status_code_check"
CHECK ("statusCode" IN (
  'pending', 'returned', 'approved', 'rejected', 'applying', 'applied', 'voided'
));

-- CAS 版本号与基线关闭版本号非负。NULL 边界:两列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "AttendanceCorrectionRequest"
ADD CONSTRAINT "attendance_correction_request_numbers_check"
CHECK ("version" >= 0 AND "baseClosureRevision" >= 0);

-- 原因不得为空白(§3.25 字段表把 reason 列为必填内容)。
-- NULL 边界:reason NOT NULL ⇒ 恒二值。
ALTER TABLE "AttendanceCorrectionRequest"
ADD CONSTRAINT "attendance_correction_request_reason_check"
CHECK (length(btrim("reason")) > 0);

-- 🔴 §3.25:「partial unique 保证同一 target 同一时刻至多一个
--    pending / returned / approved / applying request」。
--
-- 🔴🔴 **必须带 `NULLS NOT DISTINCT`**(PG15+;沿第二刀 activity_invitation_active_unique
--     与 role_bindings_active_unique 的先例):
--     键含**可空**的 `participationIdentityId`(NULL = **活动级**更正,§3.25 明标 `?`)。
--     PostgreSQL 默认 NULL 互不相等 ⇒ 不带该子句时,同一活动可以被提出**任意多条**
--     并行的活动级更正申请而一条都不被拦 —— 索引恰好在它最该生效的那类行上完全失效;
--     而人员级申请因 participationIdentityId 有值照样被拦,
--     **漏写在只测人员级的用例里完全看不出来**(第二刀就是这么抓到的)。
--     ⇒ 配套 spec 对**活动级**(NULL 键)单独写了一条重复被拒用例,并跑过变异 A/B。
-- 🟢 谓词列 statusCode NOT NULL ⇒ 谓词恒二值。
CREATE UNIQUE INDEX "attendance_correction_request_open_unique"
ON "AttendanceCorrectionRequest" ("activityId", "participationIdentityId")
NULLS NOT DISTINCT
WHERE "statusCode" IN ('pending', 'returned', 'approved', 'applying');


-- ===== ⑪ "CorrectionApplication"(§3.25)=====

-- §3.25 明写四值闭集。NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "CorrectionApplication"
ADD CONSTRAINT "correction_application_status_code_check"
CHECK ("statusCode" IN ('preparing', 'committed', 'failed', 'voided'));


-- ===== ⑫ "ActivitySettlementClosureRevision"(§3.26)=====

-- §3.26 明写三值闭集。NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "ActivitySettlementClosureRevision"
ADD CONSTRAINT "activity_settlement_closure_status_code_check"
CHECK ("statusCode" IN ('active', 'superseded', 'voided'));

-- 关闭版本号与三个 revision 快照非负。NULL 边界:四列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "ActivitySettlementClosureRevision"
ADD CONSTRAINT "activity_settlement_closure_numbers_check"
CHECK (
  "revision" >= 0
  AND "evidenceRevision" >= 0
  AND "populationRevision" >= 0
  AND "workflowRevision" >= 0
);

-- 计数与合计非负。NULL 边界:四列均 NOT NULL ⇒ 恒二值。
-- ⚠️ serviceHours / contributionPoints 是**整活动合计**,精度 numeric(12,2)
--    ——「万人 × 24h」会直接撑爆本刀其它表用的 numeric(5,2),这是刻意异型不是漂移。
ALTER TABLE "ActivitySettlementClosureRevision"
ADD CONSTRAINT "activity_settlement_closure_totals_check"
CHECK (
  "personCount" >= 0
  AND "sessionParticipationCount" >= 0
  AND "serviceHours" >= 0
  AND "contributionPoints" >= 0
);

-- 🔴 §3.26:「partial unique 保证**一活动至多一个 active closure**」
--    (§11.3「必需索引」也点名了这一条)。
-- 🟢 键列 activityId **NOT NULL** ⇒ 不需要 NULLS NOT DISTINCT。
-- 🔴 谓词只认 'active':superseded / voided 让位,更正完成后可以追加新 revision 再关账。
CREATE UNIQUE INDEX "activity_settlement_closure_active_unique"
ON "ActivitySettlementClosureRevision" ("activityId")
WHERE "statusCode" = 'active';


-- ===== ⑬ "ActivityBatchJob"(§3.27)=====

-- §3.27 明写七值闭集。NULL 边界:jobTypeCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "ActivityBatchJob"
ADD CONSTRAINT "activity_batch_job_type_code_check"
CHECK ("jobTypeCode" IN (
  'settlement_prepare', 'bulk_proxy', 'import_preview', 'import_execute',
  'export', 'notification_expand', 'reconciliation'
));

-- §3.27 明写七值闭集。NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "ActivityBatchJob"
ADD CONSTRAINT "activity_batch_job_status_code_check"
CHECK ("statusCode" IN (
  'pending', 'processing', 'succeeded', 'partial_failed',
  'failed', 'cancelled', 'dead'
));

-- 进度计数、重试次数、lease 代际、payload 版本号非负。
-- NULL 边界:七列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "ActivityBatchJob"
ADD CONSTRAINT "activity_batch_job_counters_check"
CHECK (
  "total" >= 0
  AND "succeeded" >= 0
  AND "failed" >= 0
  AND "skipped" >= 0
  AND "attempts" >= 0
  AND "leaseGeneration" >= 0
  AND "payloadVersion" >= 0
);


-- ===== ⑭ "ActivityBatchJobItem"(§3.27)=====

-- 重试次数非负。NULL 边界:attempts NOT NULL ⇒ 恒二值。
ALTER TABLE "ActivityBatchJobItem"
ADD CONSTRAINT "activity_batch_job_item_attempts_check"
CHECK ("attempts" >= 0);

-- 逐项防重键不得为空白(空 itemKey 会让 (jobId,itemKey) 唯一退化成"每个 job 至多一项")。
-- NULL 边界:itemKey NOT NULL ⇒ 恒二值。
ALTER TABLE "ActivityBatchJobItem"
ADD CONSTRAINT "activity_batch_job_item_key_check"
CHECK (length(btrim("itemKey")) > 0);

-- ⚠️ 刻意不做(二):本表 `statusCode` **没有**闭集 CHECK。
--    §3.27 给了 ActivityBatchJob 的七值闭集,却**没有给 Item 的取值集**。
--    沿 ④「合同没给的一律不发明」——(从 Job 的 total/succeeded/failed/skipped 四个
--    计数器可以"猜"出 succeeded/failed/skipped,但那是推测不是合同),
--    已在报告与 PR body 列为**合同缺口**,待补定义后由行为批次补这条 CHECK。

-- ⚠️ 刻意不做(三):本表**没有为异常堆栈 / SQL / 敏感原值预留任何字段**(§3.27 明写)。
--    只有 `lastErrorCode`(错误编码)、`safeMessage`(已脱敏文案)、
--    `payloadHash`(摘要)、`resultReference`(指针)。这条在**建表时**就没有落点,
--    不依赖后续代码自律 —— 想存原值必须先加列,加列会走 D 档 migration 评审。

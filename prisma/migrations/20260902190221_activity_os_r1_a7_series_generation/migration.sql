-- Activity OS Release 1 / A7：周期 Series、冻结 Revision 与按需生成锚。
--
-- 纯 forward expand：只新增四张表及其约束，零 ALTER 既有业务列、零回填、零 seed、零
-- UPDATE / DELETE。Series 保留唯一可变的生命周期；Revision、命令收据与 Occurrence 均由
-- trigger 物理冻结。此文件是待维护者逐行审查的第 105 条草案，未获 A7 3b 重签不得合入或部署。

BEGIN;

-- CreateTable
CREATE TABLE "ActivitySeries" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "statusCode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ActivitySeries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_series_code_shape"
    CHECK ("code" ~ '^[a-z][a-z0-9-]{2,63}$'),
  CONSTRAINT "activity_series_status_code"
    CHECK ("statusCode" IN ('active', 'paused', 'terminated'))
);

-- CreateTable
CREATE TABLE "ActivitySeriesRevision" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "seriesId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "templateVersionId" TEXT NOT NULL,
  "templateDefinitionHash" TEXT NOT NULL,
  "frequencyCode" TEXT NOT NULL,
  "interval" INTEGER NOT NULL,
  "weeklyWeekdayMask" INTEGER NOT NULL,
  "monthlyDay" INTEGER,
  "timeZone" TEXT NOT NULL,
  "localStartDate" DATE NOT NULL,
  "localStartMinute" INTEGER NOT NULL,
  "durationMinutes" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "registrationDeadlineOffsetMinutes" INTEGER,
  "effectiveFromLocalDate" DATE NOT NULL,
  "effectiveToLocalDate" DATE NOT NULL,
  "generationWindowDays" INTEGER NOT NULL,
  "createdByUserId" TEXT NOT NULL,

  CONSTRAINT "ActivitySeriesRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_series_revision_positive_number"
    CHECK ("revision" > 0),
  CONSTRAINT "activity_series_revision_template_hash"
    CHECK (
      char_length("templateDefinitionHash") = 64
      AND "templateDefinitionHash" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "activity_series_revision_schedule_shape"
    CHECK (
      (
        "frequencyCode" = 'daily'
        AND "weeklyWeekdayMask" = 0
        AND "monthlyDay" IS NULL
      )
      OR (
        "frequencyCode" = 'weekly'
        AND "weeklyWeekdayMask" BETWEEN 1 AND 127
        AND "monthlyDay" IS NULL
      )
      OR (
        "frequencyCode" = 'monthly'
        AND "weeklyWeekdayMask" = 0
        AND "monthlyDay" BETWEEN 1 AND 31
      )
    ),
  CONSTRAINT "activity_series_revision_bounds"
    CHECK (
      "interval" BETWEEN 1 AND 365
      AND "timeZone" = 'Asia/Shanghai'
      AND "localStartMinute" BETWEEN 0 AND 1439
      AND "durationMinutes" BETWEEN 1 AND 10080
      AND char_length("title") BETWEEN 1 AND 200
      AND char_length(btrim("title")) > 0
      AND char_length("location") BETWEEN 1 AND 200
      AND char_length(btrim("location")) > 0
      AND (
        "registrationDeadlineOffsetMinutes" IS NULL
        OR "registrationDeadlineOffsetMinutes" BETWEEN 0 AND 43200
      )
      AND "generationWindowDays" BETWEEN 1 AND 366
      AND "effectiveToLocalDate" >= "effectiveFromLocalDate"
      AND "effectiveToLocalDate" - "effectiveFromLocalDate" <= 3660
      AND "localStartDate" <= "effectiveToLocalDate"
    )
);

-- CreateTable
CREATE TABLE "ActivitySeriesCommandReceipt" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "commandCode" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "seriesId" TEXT NOT NULL,
  "revisionId" TEXT,
  "resultRevision" INTEGER,
  "resultStatusCode" TEXT NOT NULL,
  "activityIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  CONSTRAINT "ActivitySeriesCommandReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_series_command_receipt_shape"
    CHECK (
      char_length("operationKey") BETWEEN 8 AND 128
      AND char_length("requestHash") = 64
      AND "requestHash" ~ '^[0-9a-f]{64}$'
      AND "resultStatusCode" IN ('active', 'paused', 'terminated')
      AND (
        (
          "commandCode" = 'set_series_status'
          AND "revisionId" IS NULL
          AND "resultRevision" IS NULL
          AND cardinality("activityIds") = 0
        )
        OR (
          "commandCode" IN ('create_series', 'revise_series')
          AND "revisionId" IS NOT NULL
          AND "resultRevision" IS NOT NULL
          AND "resultRevision" > 0
          AND cardinality("activityIds") = 0
        )
        OR (
          "commandCode" = 'generate_instances'
          AND "revisionId" IS NOT NULL
          AND "resultRevision" IS NOT NULL
          AND "resultRevision" > 0
          AND cardinality("activityIds") > 0
        )
      )
    )
);

-- CreateTable
CREATE TABLE "ActivitySeriesOccurrence" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "seriesId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "occurrenceKey" TEXT NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ActivitySeriesOccurrence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_series_occurrence_key_shape"
    CHECK ("occurrenceKey" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT "activity_series_occurrence_time_order"
    CHECK ("endAt" > "startAt")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivitySeries_code_key"
  ON "ActivitySeries"("code");

-- CreateIndex
CREATE INDEX "ActivitySeries_statusCode_idx"
  ON "ActivitySeries"("statusCode");

-- CreateIndex
CREATE UNIQUE INDEX "ActivitySeriesRevision_seriesId_revision_key"
  ON "ActivitySeriesRevision"("seriesId", "revision");

-- 复合锚点闭合：Receipt / Occurrence 都带 seriesId，Revision 必须属于同一 Series。
CREATE UNIQUE INDEX "activity_series_revision_id_series_key"
  ON "ActivitySeriesRevision"("id", "seriesId");

-- CreateIndex
CREATE INDEX "ActivitySeriesRevision_templateVersionId_idx"
  ON "ActivitySeriesRevision"("templateVersionId");

-- CreateIndex
CREATE INDEX "ActivitySeriesRevision_organizationId_idx"
  ON "ActivitySeriesRevision"("organizationId");

-- CreateIndex
CREATE INDEX "ActivitySeriesRevision_createdByUserId_idx"
  ON "ActivitySeriesRevision"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_series_command_receipt_operation_key_key"
  ON "ActivitySeriesCommandReceipt"("operationKey");

-- CreateIndex
CREATE INDEX "ActivitySeriesCommandReceipt_seriesId_createdAt_idx"
  ON "ActivitySeriesCommandReceipt"("seriesId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivitySeriesCommandReceipt_revisionId_idx"
  ON "ActivitySeriesCommandReceipt"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_series_occurrence_activity_id_key"
  ON "ActivitySeriesOccurrence"("activityId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivitySeriesOccurrence_seriesId_occurrenceKey_key"
  ON "ActivitySeriesOccurrence"("seriesId", "occurrenceKey");

-- CreateIndex
CREATE INDEX "ActivitySeriesOccurrence_revisionId_idx"
  ON "ActivitySeriesOccurrence"("revisionId");

-- CreateIndex
CREATE INDEX "ActivitySeriesOccurrence_startAt_idx"
  ON "ActivitySeriesOccurrence"("startAt");

-- AddForeignKey
ALTER TABLE "ActivitySeriesRevision"
  ADD CONSTRAINT "ActivitySeriesRevision_seriesId_fkey"
  FOREIGN KEY ("seriesId") REFERENCES "ActivitySeries"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySeriesRevision"
  ADD CONSTRAINT "ActivitySeriesRevision_templateVersionId_fkey"
  FOREIGN KEY ("templateVersionId") REFERENCES "ActivityTemplate"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySeriesRevision"
  ADD CONSTRAINT "ActivitySeriesRevision_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySeriesRevision"
  ADD CONSTRAINT "ActivitySeriesRevision_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySeriesCommandReceipt"
  ADD CONSTRAINT "ActivitySeriesCommandReceipt_seriesId_fkey"
  FOREIGN KEY ("seriesId") REFERENCES "ActivitySeries"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySeriesCommandReceipt"
  ADD CONSTRAINT "ActivitySeriesCommandReceipt_revisionId_seriesId_fkey"
  FOREIGN KEY ("revisionId", "seriesId") REFERENCES "ActivitySeriesRevision"("id", "seriesId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySeriesOccurrence"
  ADD CONSTRAINT "ActivitySeriesOccurrence_seriesId_fkey"
  FOREIGN KEY ("seriesId") REFERENCES "ActivitySeries"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySeriesOccurrence"
  ADD CONSTRAINT "ActivitySeriesOccurrence_revisionId_seriesId_fkey"
  FOREIGN KEY ("revisionId", "seriesId") REFERENCES "ActivitySeriesRevision"("id", "seriesId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivitySeriesOccurrence"
  ADD CONSTRAINT "ActivitySeriesOccurrence_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "Activity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Series 只有 statusCode 与 ORM 技术时间戳可以更新；删除任何 Series 都是禁止的。
CREATE FUNCTION activity_series_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $activity_series_lifecycle_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'activity_series_lifecycle_immutable',
      MESSAGE = 'activity_series_lifecycle_immutable: series cannot be deleted';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      CONSTRAINT = 'activity_series_lifecycle_immutable',
      MESSAGE = 'activity_series_lifecycle_immutable: only statusCode and updatedAt may change';
  END IF;

  RETURN NEW;
END;
$activity_series_lifecycle_guard$;

CREATE TRIGGER trg_activity_series_10_lifecycle
BEFORE UPDATE OR DELETE ON "ActivitySeries"
FOR EACH ROW EXECUTE FUNCTION activity_series_lifecycle_guard();

-- Revision、通用命令收据和 Occurrence 都是历史事实；没有“修正后覆盖”的写路径。
CREATE FUNCTION activity_series_history_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $activity_series_history_immutable_guard$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = 'activity_series_history_immutable',
    MESSAGE = 'activity_series_history_immutable: revision, receipt and occurrence cannot be changed or deleted';
  RETURN NULL;
END;
$activity_series_history_immutable_guard$;

CREATE TRIGGER trg_activity_series_revision_10_immutable
BEFORE UPDATE OR DELETE ON "ActivitySeriesRevision"
FOR EACH ROW EXECUTE FUNCTION activity_series_history_immutable_guard();

CREATE TRIGGER trg_activity_series_command_receipt_10_immutable
BEFORE UPDATE OR DELETE ON "ActivitySeriesCommandReceipt"
FOR EACH ROW EXECUTE FUNCTION activity_series_history_immutable_guard();

CREATE TRIGGER trg_activity_series_occurrence_10_immutable
BEFORE UPDATE OR DELETE ON "ActivitySeriesOccurrence"
FOR EACH ROW EXECUTE FUNCTION activity_series_history_immutable_guard();

COMMIT;

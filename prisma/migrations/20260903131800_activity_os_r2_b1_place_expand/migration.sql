-- Activity OS Release 2 / B1：PlacePreset 与 ActivityPlace 的存储地基。
--
-- 纯 forward expand：仅新增两张空表、三条外键、三项查询索引和两组已冻结闭集 CHECK；
-- 零 ALTER 既有 Activity / ActivitySession 地点列、零回填、零 seed、零 DELETE、零 API / writer。
-- 坐标成对、范围、坐标系 / provider 闭集和 checkInEligible / radiusMeters 发布完整性留给 B2 / B4。

BEGIN;

-- CreateTable
CREATE TABLE "PlacePreset" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "name" TEXT NOT NULL,
  "addressText" TEXT NOT NULL,
  "instruction" TEXT,
  "longitude" DECIMAL(10,7),
  "latitude" DECIMAL(10,7),
  "coordinateSystemCode" TEXT,
  "providerCode" TEXT,
  "providerPlaceId" TEXT,
  "checkInEligible" BOOLEAN NOT NULL,

  "radiusMeters" INTEGER,

  CONSTRAINT "PlacePreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityPlace" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "activityId" TEXT NOT NULL,
  "sessionId" TEXT,
  "roleCode" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "addressText" TEXT NOT NULL,
  "instruction" TEXT,
  "longitude" DECIMAL(10,7),
  "latitude" DECIMAL(10,7),
  "coordinateSystemCode" TEXT,
  "providerCode" TEXT,
  "providerPlaceId" TEXT,
  "visibilityCode" TEXT NOT NULL,
  "checkInEligible" BOOLEAN NOT NULL,
  "radiusMeters" INTEGER,
  "sourcePresetId" TEXT,
  "workflowRevision" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "ActivityPlace_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_place_role_code_check"
    CHECK ("roleCode" IN ('primary', 'meeting', 'execution', 'evacuation', 'parking', 'other')),
  CONSTRAINT "activity_place_visibility_code_check"
    CHECK ("visibilityCode" IN ('public', 'accepted', 'staff', 'command'))
);

-- CreateIndex
CREATE INDEX "ActivityPlace_activityId_idx" ON "ActivityPlace"("activityId");

-- CreateIndex
CREATE INDEX "ActivityPlace_sessionId_idx" ON "ActivityPlace"("sessionId");

-- CreateIndex
CREATE INDEX "ActivityPlace_sourcePresetId_idx" ON "ActivityPlace"("sourcePresetId");

-- AddForeignKey
ALTER TABLE "ActivityPlace"
  ADD CONSTRAINT "ActivityPlace_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "Activity"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityPlace"
  ADD CONSTRAINT "ActivityPlace_activityId_sessionId_fkey"
  FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityPlace"
  ADD CONSTRAINT "ActivityPlace_sourcePresetId_fkey"
  FOREIGN KEY ("sourcePresetId") REFERENCES "PlacePreset"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;

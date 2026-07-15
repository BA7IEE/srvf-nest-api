-- CreateTable
CREATE TABLE "activity_check_ins" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "activityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "checkInAt" TIMESTAMP(3) NOT NULL,
    "checkOutAt" TIMESTAMP(3),
    "checkInLongitude" DECIMAL(10,7),
    "checkInLatitude" DECIMAL(10,7),
    "checkInAccuracy" DECIMAL(10,2),
    "checkInDistance" DECIMAL(10,2),
    "checkOutLongitude" DECIMAL(10,7),
    "checkOutLatitude" DECIMAL(10,7),
    "checkOutAccuracy" DECIMAL(10,2),
    "checkOutDistance" DECIMAL(10,2),
    "geoVerified" BOOLEAN NOT NULL,
    "outOfRange" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "activity_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_check_ins_activityId_idx" ON "activity_check_ins"("activityId");

-- CreateIndex
CREATE INDEX "activity_check_ins_memberId_idx" ON "activity_check_ins"("memberId");

-- CreateIndex
CREATE INDEX "activity_check_ins_registrationId_idx" ON "activity_check_ins"("registrationId");

-- CreateIndex
CREATE INDEX "activity_check_ins_checkInAt_idx" ON "activity_check_ins"("checkInAt");

-- CreateIndex
CREATE INDEX "activity_check_ins_deletedAt_idx" ON "activity_check_ins"("deletedAt");

-- CreateIndex
CREATE INDEX "activity_check_ins_createdAt_idx" ON "activity_check_ins"("createdAt");

-- AddForeignKey
ALTER TABLE "activity_check_ins" ADD CONSTRAINT "activity_check_ins_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_check_ins" ADD CONSTRAINT "activity_check_ins_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_check_ins" ADD CONSTRAINT "activity_check_ins_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ActivityRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One live evidence row per registration. Prisma DSL 6.x cannot express
-- partial unique indexes, so keep this reviewed SQL alongside the schema.
CREATE UNIQUE INDEX "activity_check_ins_registration_active_unique"
ON "activity_check_ins" ("registrationId")
WHERE "deletedAt" IS NULL;

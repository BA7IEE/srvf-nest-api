-- CreateTable
CREATE TABLE "MemberProfile" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "realName" TEXT NOT NULL,
    "genderCode" TEXT NOT NULL,
    "birthDate" TIMESTAMP(3) NOT NULL,
    "documentTypeCode" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "ethnicityCode" TEXT,
    "politicalStatusCode" TEXT,
    "isVeteran" BOOLEAN,
    "maritalStatusCode" TEXT,
    "educationCode" TEXT,
    "major" TEXT,
    "workNatureCode" TEXT,
    "residenceArea" TEXT,
    "workArea" TEXT,
    "mobile" TEXT NOT NULL,
    "landline" TEXT,
    "email" TEXT NOT NULL,
    "qq" TEXT,
    "wechat" TEXT,
    "heightCm" INTEGER,
    "weightKg" INTEGER,
    "bloodTypeCode" TEXT,
    "eyesight" TEXT,
    "medicalNotes" JSONB,
    "hasVehicle" BOOLEAN,
    "vehicleType" TEXT,
    "exerciseFrequencyCode" TEXT,
    "exerciseSportCode" TEXT,
    "exerciseMethods" TEXT[],
    "firstAidKnowledgeCode" TEXT,
    "firstAidSkills" TEXT[],
    "otherSkills" TEXT,
    "joinedDate" TIMESTAMP(3) NOT NULL,
    "joinSourceCode" TEXT NOT NULL,
    "noCriminalRecordSigned" BOOLEAN,
    "privacyConsentSigned" BOOLEAN NOT NULL,
    "privacyConsentSignedAt" TIMESTAMP(3),
    "volunteerNo" TEXT,

    CONSTRAINT "MemberProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyContact" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "contactName" TEXT NOT NULL,
    "relationCode" TEXT NOT NULL,
    "phonePrimary" TEXT NOT NULL,
    "phoneBackup" TEXT,
    "address" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EmergencyContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberProfile_memberId_key" ON "MemberProfile"("memberId");

-- CreateIndex
CREATE INDEX "MemberProfile_volunteerNo_idx" ON "MemberProfile"("volunteerNo");

-- CreateIndex
CREATE INDEX "MemberProfile_deletedAt_idx" ON "MemberProfile"("deletedAt");

-- CreateIndex
CREATE INDEX "MemberProfile_createdAt_idx" ON "MemberProfile"("createdAt");

-- CreateIndex
CREATE INDEX "EmergencyContact_memberId_idx" ON "EmergencyContact"("memberId");

-- CreateIndex
CREATE INDEX "EmergencyContact_memberId_priority_idx" ON "EmergencyContact"("memberId", "priority");

-- CreateIndex
CREATE INDEX "EmergencyContact_deletedAt_idx" ON "EmergencyContact"("deletedAt");

-- CreateIndex
CREATE INDEX "EmergencyContact_createdAt_idx" ON "EmergencyContact"("createdAt");

-- AddForeignKey
ALTER TABLE "MemberProfile" ADD CONSTRAINT "MemberProfile_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


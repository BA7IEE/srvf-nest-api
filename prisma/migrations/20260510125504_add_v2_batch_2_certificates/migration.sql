-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "certTypeCode" TEXT NOT NULL,
    "certSubTypeCode" TEXT,
    "issuingOrg" TEXT NOT NULL,
    "certNumber" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiredAt" TIMESTAMP(3),
    "certStatusCode" TEXT NOT NULL,
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifyNote" TEXT,
    "attachmentKey" TEXT,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "supersededByCertId" TEXT,
    "expireNotifyDueAt" TIMESTAMP(3),

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Certificate_memberId_idx" ON "Certificate"("memberId");

-- CreateIndex
CREATE INDEX "Certificate_certTypeCode_idx" ON "Certificate"("certTypeCode");

-- CreateIndex
CREATE INDEX "Certificate_certStatusCode_idx" ON "Certificate"("certStatusCode");

-- CreateIndex
CREATE INDEX "Certificate_expiredAt_idx" ON "Certificate"("expiredAt");

-- CreateIndex
CREATE INDEX "Certificate_deletedAt_idx" ON "Certificate"("deletedAt");

-- CreateIndex
CREATE INDEX "Certificate_createdAt_idx" ON "Certificate"("createdAt");

-- CreateIndex
CREATE INDEX "Certificate_supersededByCertId_idx" ON "Certificate"("supersededByCertId");

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_verifiedBy_fkey" FOREIGN KEY ("verifiedBy") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_supersededByCertId_fkey" FOREIGN KEY ("supersededByCertId") REFERENCES "Certificate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

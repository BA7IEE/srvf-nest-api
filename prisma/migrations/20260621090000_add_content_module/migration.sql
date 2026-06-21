-- CreateTable
CREATE TABLE "contents" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "contentTypeCode" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "visibilityCode" TEXT NOT NULL,
    "visibleOrganizationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coverImageKey" TEXT,
    "coverAttachmentId" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "authorUserId" TEXT,

    CONSTRAINT "contents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contents_statusCode_idx" ON "contents"("statusCode");

-- CreateIndex
CREATE INDEX "contents_visibilityCode_idx" ON "contents"("visibilityCode");

-- CreateIndex
CREATE INDEX "contents_contentTypeCode_idx" ON "contents"("contentTypeCode");

-- CreateIndex
CREATE INDEX "contents_publishedAt_idx" ON "contents"("publishedAt");

-- CreateIndex
CREATE INDEX "contents_deletedAt_idx" ON "contents"("deletedAt");

-- CreateIndex
CREATE INDEX "contents_createdAt_idx" ON "contents"("createdAt");

-- CreateIndex
CREATE INDEX "contents_statusCode_publishedAt_idx" ON "contents"("statusCode", "publishedAt");


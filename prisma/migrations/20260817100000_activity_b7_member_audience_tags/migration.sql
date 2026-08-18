-- Activity B7: member audience tags.
-- Expand-only: existing publish reviews keep NULL audienceTagCodes, which remains the legacy broadcast path.

BEGIN;

-- AlterTable
ALTER TABLE "activity_publish_reviews"
ADD COLUMN "audienceTagCodes" JSONB;

-- CreateTable
CREATE TABLE "member_audience_tag_assignments" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "dictItemId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "member_audience_tag_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_audience_tag_assignments_member_live_idx"
ON "member_audience_tag_assignments"("memberId", "revokedAt");

CREATE INDEX "member_audience_tag_assignments_item_live_idx"
ON "member_audience_tag_assignments"("dictItemId", "revokedAt");

-- Prisma DSL cannot express the live-row partial unique index.
CREATE UNIQUE INDEX "member_audience_tag_assignments_live_member_item_key"
ON "member_audience_tag_assignments"("memberId", "dictItemId")
WHERE "revokedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "member_audience_tag_assignments"
ADD CONSTRAINT "member_audience_tag_assignments_memberId_fkey"
FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "member_audience_tag_assignments"
ADD CONSTRAINT "member_audience_tag_assignments_dictItemId_fkey"
FOREIGN KEY ("dictItemId") REFERENCES "DictItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;

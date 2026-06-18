-- AlterTable
ALTER TABLE "MemberProfile" ADD COLUMN     "idCardImageKey" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- AlterTable
ALTER TABLE "recruitment_cycles" ADD COLUMN     "memberNoSeq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "recruitment_applications" ADD COLUMN     "evaluatedAt" TIMESTAMP(3),
ADD COLUMN     "evaluatedByUserId" TEXT,
ADD COLUMN     "evaluationNote" TEXT,
ADD COLUMN     "promotedMemberId" TEXT,
ADD COLUMN     "thresholdMarks" JSONB;

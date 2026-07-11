-- 招新可用性收口 F1(2026-07-11;评审稿 recruitment-usability-closeout-review.md §2.5/E-U-1):
-- 付费 OCR 调用按 IP × 北京自然日封顶的持久化计数表(纯加空表;无 FK / 无回填 / 无不可逆)。

-- CreateTable
CREATE TABLE "recruitment_ocr_daily_counters" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "recruitment_ocr_daily_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_ocr_daily_counters_ip_dateKey_key" ON "recruitment_ocr_daily_counters"("ip", "dateKey");

-- CreateIndex
CREATE INDEX "recruitment_ocr_daily_counters_dateKey_idx" ON "recruitment_ocr_daily_counters"("dateKey");

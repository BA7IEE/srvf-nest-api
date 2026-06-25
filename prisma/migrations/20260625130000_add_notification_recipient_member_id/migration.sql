-- 统一通知模块 S3 producer 接入 + 派发器 Effect 正式化(评审稿
-- docs/archive/reviews/unified-notification-dispatcher-review.md §2.1/§9.1,S3 切片;migration 第 29)。
-- notifications 加 1 列 recipientMemberId(定向收件人;全 additive,纯加列无破坏,无回填、无 enum、无不可逆):
--   广播行取 NULL(既有行自动 NULL);directed 行挂单一收件人 member。FK onDelete Restrict(沿仓内惯例)。
--   复合索引 (audienceType, recipientMemberId) 服务定向 feed(某 member 的 directed 通知)。

-- AlterTable(notifications 定向收件人列;可空 additive)
ALTER TABLE "notifications" ADD COLUMN     "recipientMemberId" TEXT;

-- CreateIndex(定向 feed:audienceType + recipientMemberId 复合)
CREATE INDEX "notifications_audienceType_recipientMemberId_idx" ON "notifications"("audienceType", "recipientMemberId");

-- AddForeignKey(recipientMemberId → Member;onDelete Restrict 沿 notification_reads 范式)
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientMemberId_fkey" FOREIGN KEY ("recipientMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

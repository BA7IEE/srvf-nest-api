-- 统一通知模块 S5 短信兜底渠道(评审稿
-- docs/archive/reviews/unified-notification-dispatcher-review.md §4,S5 切片;migration 第 30)。
-- sms_settings 加 1 列 templateIdNotification(紧急召集兜底零变量模板 ID;全 additive,纯加列无破坏,
--   无回填、无 enum、无不可逆):既有行自动 NULL(= 该模板未配置,通知短信通道不可发,与 templateIdBirthday 同语义)。
--   provider 侧 templateKey='notification' 的模板映射列,镜像 templateIdBirthday(queue-b 生日批先例)。

-- AlterTable(sms_settings 通知兜底模板列;可空 additive)
ALTER TABLE "sms_settings" ADD COLUMN     "templateIdNotification" TEXT;

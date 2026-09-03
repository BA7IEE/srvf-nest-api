-- Activity OS R2 / B3：模板报名表蓝图的 Field 治理地基（第 108 条 migration）。
--
-- 纯 additive：只给既有 RegistrationFormField 增加五个可空列与一个二值 shape CHECK；
-- 零 default、零回填、零 DML、零 rename、零删除。既有 Field 五列均为 NULL，继续按 legacy
-- canonical definition 读取，旧 schemaHash / 已签发布审核快照不变。AI 不执行生产 migration。
--
-- 新 governed Field 的词表、普通 / 敏感启用门槛及预填禁令均由运行时 canonicalizer 唯一解释。
-- 数据库只负责不让五列处于半填、非空 prefill 或其它不完整形状。

BEGIN;

ALTER TABLE "RegistrationFormField"
  ADD COLUMN "purposeCode" TEXT,
  ADD COLUMN "dataClassCode" TEXT,
  ADD COLUMN "retentionPolicyCode" TEXT,
  ADD COLUMN "maskingPolicyCode" TEXT,
  ADD COLUMN "prefillSourceCode" TEXT;

-- 两支均由 IS NULL / IS NOT NULL 组成，恒二值；不会因 SQL 三值逻辑把半填行静默放行。
ALTER TABLE "RegistrationFormField"
  ADD CONSTRAINT "registration_form_field_governance_shape_check"
  CHECK (
    (
      "purposeCode" IS NULL
      AND "dataClassCode" IS NULL
      AND "retentionPolicyCode" IS NULL
      AND "maskingPolicyCode" IS NULL
      AND "prefillSourceCode" IS NULL
    )
    OR
    (
      "purposeCode" IS NOT NULL
      AND "dataClassCode" IS NOT NULL
      AND "retentionPolicyCode" IS NOT NULL
      AND "maskingPolicyCode" IS NOT NULL
      AND "prefillSourceCode" IS NULL
    )
  );

COMMIT;

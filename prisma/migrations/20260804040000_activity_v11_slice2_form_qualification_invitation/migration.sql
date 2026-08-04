
-- AlterTable
ALTER TABLE "ActivityRegistration" ADD COLUMN     "currentFormVersionId" TEXT,
ADD COLUMN     "currentRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sourceCode" TEXT,
ADD COLUMN     "statusSummaryCode" TEXT;

-- AlterTable
ALTER TABLE "ActivitySessionPosition" ADD COLUMN     "qualificationRuleSetId" TEXT;

-- CreateTable
CREATE TABLE "ActivityRegistrationRevision" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registrationId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "formVersionId" TEXT,
    "answersHash" TEXT,
    "sourceCode" TEXT NOT NULL,
    "submittedByUserId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "requestKey" TEXT,
    "requestHash" TEXT,
    "priorRevisionId" TEXT,
    "reason" TEXT,

    CONSTRAINT "ActivityRegistrationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationFormVersion" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "statusCode" TEXT NOT NULL,
    "workflowRevision" INTEGER NOT NULL DEFAULT 0,
    "schemaHash" TEXT,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "RegistrationFormVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationFormField" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "formVersionId" TEXT NOT NULL,
    "fieldCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "helpText" TEXT,
    "typeCode" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "minValue" DECIMAL(18,6),
    "maxValue" DECIMAL(18,6),
    "minLength" INTEGER,
    "maxLength" INTEGER,
    "maxSelections" INTEGER,
    "optionsJson" JSONB,
    "visibilityCode" TEXT NOT NULL,
    "exportable" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RegistrationFormField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationFormAnswer" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registrationRevisionId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "valueText" TEXT,
    "valueNumber" DECIMAL(18,6),
    "valueDate" TIMESTAMP(3),
    "valueJson" JSONB,
    "attachmentId" TEXT,

    CONSTRAINT "RegistrationFormAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationUploadSession" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "formVersionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "statusCode" TEXT NOT NULL,

    CONSTRAINT "RegistrationUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityQualificationRuleSet" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT,
    "positionId" TEXT,
    "version" INTEGER NOT NULL,
    "statusCode" TEXT NOT NULL,

    CONSTRAINT "ActivityQualificationRuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityQualificationRule" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ruleSetId" TEXT NOT NULL,
    "ruleTypeCode" TEXT NOT NULL,
    "enforcementCode" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "valueJson" JSONB,
    "message" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ActivityQualificationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualificationEvaluationSnapshot" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "identityId" TEXT,
    "registrationRevisionId" TEXT,
    "ruleSetVersionId" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "resultCode" TEXT NOT NULL,
    "detailsJson" JSONB,
    "inputFactsHash" TEXT,

    CONSTRAINT "QualificationEvaluationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityInvitation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "sessionId" TEXT,
    "positionId" TEXT,
    "statusCode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedByUserId" TEXT,
    "respondedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "reason" TEXT,
    "operationKey" TEXT,
    "requestHash" TEXT,

    CONSTRAINT "ActivityInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityVisitor" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organization" TEXT,
    "invitedByMemberId" TEXT,
    "note" TEXT,
    "attendanceCode" TEXT,

    CONSTRAINT "ActivityVisitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityRegistrationRevision_registrationId_idx" ON "ActivityRegistrationRevision"("registrationId");

-- CreateIndex
CREATE INDEX "ActivityRegistrationRevision_formVersionId_idx" ON "ActivityRegistrationRevision"("formVersionId");

-- CreateIndex
CREATE INDEX "ActivityRegistrationRevision_submittedByUserId_idx" ON "ActivityRegistrationRevision"("submittedByUserId");

-- CreateIndex
CREATE INDEX "ActivityRegistrationRevision_submittedAt_idx" ON "ActivityRegistrationRevision"("submittedAt");

-- CreateIndex
CREATE INDEX "ActivityRegistrationRevision_requestKey_idx" ON "ActivityRegistrationRevision"("requestKey");

-- CreateIndex
CREATE INDEX "ActivityRegistrationRevision_priorRevisionId_idx" ON "ActivityRegistrationRevision"("priorRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityRegistrationRevision_registrationId_revision_key" ON "ActivityRegistrationRevision"("registrationId", "revision");

-- CreateIndex
CREATE INDEX "RegistrationFormVersion_activityId_idx" ON "RegistrationFormVersion"("activityId");

-- CreateIndex
CREATE INDEX "RegistrationFormVersion_statusCode_idx" ON "RegistrationFormVersion"("statusCode");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationFormVersion_activityId_version_key" ON "RegistrationFormVersion"("activityId", "version");

-- CreateIndex
CREATE INDEX "RegistrationFormField_formVersionId_idx" ON "RegistrationFormField"("formVersionId");

-- CreateIndex
CREATE INDEX "RegistrationFormField_typeCode_idx" ON "RegistrationFormField"("typeCode");

-- CreateIndex
CREATE INDEX "RegistrationFormField_formVersionId_sortOrder_idx" ON "RegistrationFormField"("formVersionId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationFormField_formVersionId_fieldCode_key" ON "RegistrationFormField"("formVersionId", "fieldCode");

-- CreateIndex
CREATE INDEX "RegistrationFormAnswer_registrationRevisionId_idx" ON "RegistrationFormAnswer"("registrationRevisionId");

-- CreateIndex
CREATE INDEX "RegistrationFormAnswer_fieldId_idx" ON "RegistrationFormAnswer"("fieldId");

-- CreateIndex
CREATE INDEX "RegistrationFormAnswer_attachmentId_idx" ON "RegistrationFormAnswer"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationFormAnswer_registrationRevisionId_fieldId_key" ON "RegistrationFormAnswer"("registrationRevisionId", "fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationUploadSession_tokenHash_key" ON "RegistrationUploadSession"("tokenHash");

-- CreateIndex
CREATE INDEX "RegistrationUploadSession_activityId_idx" ON "RegistrationUploadSession"("activityId");

-- CreateIndex
CREATE INDEX "RegistrationUploadSession_memberId_idx" ON "RegistrationUploadSession"("memberId");

-- CreateIndex
CREATE INDEX "RegistrationUploadSession_formVersionId_idx" ON "RegistrationUploadSession"("formVersionId");

-- CreateIndex
CREATE INDEX "RegistrationUploadSession_statusCode_idx" ON "RegistrationUploadSession"("statusCode");

-- CreateIndex
CREATE INDEX "RegistrationUploadSession_expiresAt_idx" ON "RegistrationUploadSession"("expiresAt");

-- CreateIndex
CREATE INDEX "ActivityQualificationRuleSet_activityId_idx" ON "ActivityQualificationRuleSet"("activityId");

-- CreateIndex
CREATE INDEX "ActivityQualificationRuleSet_sessionId_idx" ON "ActivityQualificationRuleSet"("sessionId");

-- CreateIndex
CREATE INDEX "ActivityQualificationRuleSet_positionId_idx" ON "ActivityQualificationRuleSet"("positionId");

-- CreateIndex
CREATE INDEX "ActivityQualificationRuleSet_statusCode_idx" ON "ActivityQualificationRuleSet"("statusCode");

-- CreateIndex
CREATE INDEX "ActivityQualificationRule_ruleSetId_idx" ON "ActivityQualificationRule"("ruleSetId");

-- CreateIndex
CREATE INDEX "ActivityQualificationRule_ruleTypeCode_idx" ON "ActivityQualificationRule"("ruleTypeCode");

-- CreateIndex
CREATE INDEX "ActivityQualificationRule_ruleSetId_sortOrder_idx" ON "ActivityQualificationRule"("ruleSetId", "sortOrder");

-- CreateIndex
CREATE INDEX "QualificationEvaluationSnapshot_identityId_idx" ON "QualificationEvaluationSnapshot"("identityId");

-- CreateIndex
CREATE INDEX "QualificationEvaluationSnapshot_registrationRevisionId_idx" ON "QualificationEvaluationSnapshot"("registrationRevisionId");

-- CreateIndex
CREATE INDEX "QualificationEvaluationSnapshot_ruleSetVersionId_idx" ON "QualificationEvaluationSnapshot"("ruleSetVersionId");

-- CreateIndex
CREATE INDEX "QualificationEvaluationSnapshot_resultCode_idx" ON "QualificationEvaluationSnapshot"("resultCode");

-- CreateIndex
CREATE INDEX "QualificationEvaluationSnapshot_evaluatedAt_idx" ON "QualificationEvaluationSnapshot"("evaluatedAt");

-- CreateIndex
CREATE INDEX "ActivityInvitation_activityId_idx" ON "ActivityInvitation"("activityId");

-- CreateIndex
CREATE INDEX "ActivityInvitation_memberId_idx" ON "ActivityInvitation"("memberId");

-- CreateIndex
CREATE INDEX "ActivityInvitation_sessionId_idx" ON "ActivityInvitation"("sessionId");

-- CreateIndex
CREATE INDEX "ActivityInvitation_positionId_idx" ON "ActivityInvitation"("positionId");

-- CreateIndex
CREATE INDEX "ActivityInvitation_statusCode_idx" ON "ActivityInvitation"("statusCode");

-- CreateIndex
CREATE INDEX "ActivityInvitation_expiresAt_idx" ON "ActivityInvitation"("expiresAt");

-- CreateIndex
CREATE INDEX "ActivityInvitation_operationKey_idx" ON "ActivityInvitation"("operationKey");

-- CreateIndex
CREATE INDEX "ActivityVisitor_activityId_idx" ON "ActivityVisitor"("activityId");

-- CreateIndex
CREATE INDEX "ActivityVisitor_sessionId_idx" ON "ActivityVisitor"("sessionId");

-- CreateIndex
CREATE INDEX "ActivityVisitor_invitedByMemberId_idx" ON "ActivityVisitor"("invitedByMemberId");

-- CreateIndex
CREATE INDEX "ActivityVisitor_attendanceCode_idx" ON "ActivityVisitor"("attendanceCode");

-- CreateIndex
CREATE INDEX "ActivityRegistration_currentFormVersionId_idx" ON "ActivityRegistration"("currentFormVersionId");

-- CreateIndex
CREATE INDEX "ActivityRegistration_statusSummaryCode_idx" ON "ActivityRegistration"("statusSummaryCode");

-- CreateIndex
CREATE INDEX "ActivitySessionPosition_qualificationRuleSetId_idx" ON "ActivitySessionPosition"("qualificationRuleSetId");

-- AddForeignKey
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_currentFormVersionId_fkey" FOREIGN KEY ("currentFormVersionId") REFERENCES "RegistrationFormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySessionPosition" ADD CONSTRAINT "ActivitySessionPosition_qualificationRuleSetId_fkey" FOREIGN KEY ("qualificationRuleSetId") REFERENCES "ActivityQualificationRuleSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistrationRevision" ADD CONSTRAINT "ActivityRegistrationRevision_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ActivityRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistrationRevision" ADD CONSTRAINT "ActivityRegistrationRevision_formVersionId_fkey" FOREIGN KEY ("formVersionId") REFERENCES "RegistrationFormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistrationRevision" ADD CONSTRAINT "ActivityRegistrationRevision_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistrationRevision" ADD CONSTRAINT "ActivityRegistrationRevision_priorRevisionId_fkey" FOREIGN KEY ("priorRevisionId") REFERENCES "ActivityRegistrationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationFormVersion" ADD CONSTRAINT "RegistrationFormVersion_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationFormField" ADD CONSTRAINT "RegistrationFormField_formVersionId_fkey" FOREIGN KEY ("formVersionId") REFERENCES "RegistrationFormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationFormAnswer" ADD CONSTRAINT "RegistrationFormAnswer_registrationRevisionId_fkey" FOREIGN KEY ("registrationRevisionId") REFERENCES "ActivityRegistrationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationFormAnswer" ADD CONSTRAINT "RegistrationFormAnswer_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "RegistrationFormField"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationFormAnswer" ADD CONSTRAINT "RegistrationFormAnswer_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationUploadSession" ADD CONSTRAINT "RegistrationUploadSession_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationUploadSession" ADD CONSTRAINT "RegistrationUploadSession_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationUploadSession" ADD CONSTRAINT "RegistrationUploadSession_formVersionId_fkey" FOREIGN KEY ("formVersionId") REFERENCES "RegistrationFormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityQualificationRuleSet" ADD CONSTRAINT "ActivityQualificationRuleSet_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityQualificationRuleSet" ADD CONSTRAINT "ActivityQualificationRuleSet_activityId_sessionId_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityQualificationRuleSet" ADD CONSTRAINT "ActivityQualificationRuleSet_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "ActivitySessionPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityQualificationRule" ADD CONSTRAINT "ActivityQualificationRule_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "ActivityQualificationRuleSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualificationEvaluationSnapshot" ADD CONSTRAINT "QualificationEvaluationSnapshot_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "ActivityParticipationIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualificationEvaluationSnapshot" ADD CONSTRAINT "QualificationEvaluationSnapshot_registrationRevisionId_fkey" FOREIGN KEY ("registrationRevisionId") REFERENCES "ActivityRegistrationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualificationEvaluationSnapshot" ADD CONSTRAINT "QualificationEvaluationSnapshot_ruleSetVersionId_fkey" FOREIGN KEY ("ruleSetVersionId") REFERENCES "ActivityQualificationRuleSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityInvitation" ADD CONSTRAINT "ActivityInvitation_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityInvitation" ADD CONSTRAINT "ActivityInvitation_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityInvitation" ADD CONSTRAINT "ActivityInvitation_activityId_sessionId_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityInvitation" ADD CONSTRAINT "ActivityInvitation_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "ActivitySessionPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityInvitation" ADD CONSTRAINT "ActivityInvitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityVisitor" ADD CONSTRAINT "ActivityVisitor_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityVisitor" ADD CONSTRAINT "ActivityVisitor_activityId_sessionId_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ############################################################################
-- 以下全部为**手写**约束(Prisma DSL 6.x 表达不了 CHECK,也表达不了 partial unique
-- 的 WHERE 子句与 NULLS NOT DISTINCT)。沿既有范式:
--   prisma/migrations/20260707130528_user_memberid_partial_unique/migration.sql
--   prisma/migrations/20260701170000_role_bindings/migration.sql(NULLS NOT DISTINCT)
--   prisma/migrations/20260804020000_activity_v11_slice1_sessions_participation_capacity/migration.sql
--
-- 合同:docs/archive/reviews/activity-business-overhaul-v1.1/
--       SRVF_活动业务全流程改造_详细开发文档_v1.1.md §3.6 / §3.7 / §3.12 / §3.13 / §3.14
--
-- 本 migration 是 **expand-only**:零 DROP/RENAME、零既有列语义变更、零回填、零删数。
-- 对既有表 "ActivityRegistration" 只加 4 列(1 列 NOT NULL 带 DEFAULT 0、3 列可空)、
-- 对 "ActivitySessionPosition" 只加 1 列(可空),CHECK **全部只落在这些新列上**
-- —— 存量行在它们下恒真,不可能让既有行为变红。
--
-- ⚠️ 本刀所有 CHECK 都逐条过了「涉及的列为 NULL 时整式算什么」这一问(第一刀的血教训:
-- SQL 三值逻辑下表达式求值为 NULL 时 CHECK **判通过**,约束静默失效)。每条下方注明结论。
-- ############################################################################

-- ===== ① 既有表 "ActivityRegistration" 的新增列约束(§3.6)=====
--
-- 三条全部只读**本刀新加的列**。存量行:currentRevision 读作 DEFAULT 0,
-- statusSummaryCode / sourceCode 均为 NULL ⇒ 三条恒真,零行受影响。

-- NULL 边界:currentRevision 是 NOT NULL DEFAULT 0,**永不为 NULL** ⇒ 整式恒二值。
ALTER TABLE "ActivityRegistration"
ADD CONSTRAINT "activity_registration_current_revision_non_negative_check"
CHECK ("currentRevision" >= 0);

-- §3.6 聚合规则原文给出的取值:active + 四个终态。
-- NULL 边界:该列可空(NULL = 尚未聚合/存量行),故首个析取项 `IS NULL` 必须在 ——
-- 去掉它则 `NULL IN (...)` = NULL ⇒ CHECK 判通过,看着更严实际等价于没约束,
-- 而合法的"尚未聚合"反而会在补写时被拒。两个方向都要靠这一项。
ALTER TABLE "ActivityRegistration"
ADD CONSTRAINT "activity_registration_status_summary_code_check"
CHECK ("statusSummaryCode" IS NULL
       OR "statusSummaryCode" IN ('active', 'completed', 'cancelled', 'not_selected', 'expired'));

-- §3.6 明写闭集 self/admin/invitation/onsite。NULL 边界同上。
ALTER TABLE "ActivityRegistration"
ADD CONSTRAINT "activity_registration_source_code_check"
CHECK ("sourceCode" IS NULL
       OR "sourceCode" IN ('self', 'admin', 'invitation', 'onsite'));

-- ===== ② "ActivityRegistrationRevision"(§3.7)=====

-- NULL 边界:revision NOT NULL ⇒ 恒二值。沿第一刀 participation revision 的 `>= 0` 同口径。
ALTER TABLE "ActivityRegistrationRevision"
ADD CONSTRAINT "activity_registration_revision_number_check"
CHECK ("revision" >= 0);

-- 与 §3.6 头行共用同一 sourceCode 闭集。
-- NULL 边界:本列 NOT NULL(与头行那列不同)⇒ 不需要、也不应该放行 NULL。
ALTER TABLE "ActivityRegistrationRevision"
ADD CONSTRAINT "activity_registration_revision_source_code_check"
CHECK ("sourceCode" IN ('self', 'admin', 'invitation', 'onsite'));

-- §3.7「requestKey/requestHash unique idempotency」。
--
-- ⚠️ 键取 **requestKey 单列**而非 (requestKey, requestHash) 复合 —— 复合唯一恰好放行
-- 「同一个 key 配不同 payload」,而那正是幂等键唯一要拦的冲突(重放同 key 不同体 =
-- 客户端 bug 或攻击)。单列唯一严格蕴含复合唯一,故同时满足合同字面且真的守住语义。
--
-- partial(WHERE requestKey IS NOT NULL)是显式化,不是收窄:PG 普通唯一索引本就把
-- NULL 视为互不相等,不带 key 的写入本来就不受限。写出谓词是为了让读者不必推断
-- ——「无 key 入口不参与幂等去重」是有意的,不是漏的。
CREATE UNIQUE INDEX "activity_registration_revision_request_key_unique"
ON "ActivityRegistrationRevision" ("requestKey")
WHERE "requestKey" IS NOT NULL;

-- ===== ③ "RegistrationFormVersion"(§3.12)=====

-- §3.12 明写闭集。NULL 边界:statusCode NOT NULL ⇒ 恒二值。
ALTER TABLE "RegistrationFormVersion"
ADD CONSTRAINT "registration_form_version_status_code_check"
CHECK ("statusCode" IN ('draft', 'active', 'retired'));

-- 版本号 1 起。NULL 边界:两列均 NOT NULL(workflowRevision 带 DEFAULT 0)⇒ 恒二值。
ALTER TABLE "RegistrationFormVersion"
ADD CONSTRAINT "registration_form_version_number_check"
CHECK ("version" >= 1 AND "workflowRevision" >= 0);

-- 生命周期形状:草稿不可能"已激活",非退役不可能"已退役"。
-- NULL 边界:两个时间列可空,各自被 `IS NULL OR` 守住 ⇒ 每个析取项恒二值,整式不为 NULL。
-- ⚠️ 单向蕴含,不是双向:允许 active 尚未回填 activatedAt(沿第一刀 termination_shape 同口径),
-- 也允许草稿直接退役(弃稿)。
ALTER TABLE "RegistrationFormVersion"
ADD CONSTRAINT "registration_form_version_lifecycle_shape_check"
CHECK (
  ("activatedAt" IS NULL OR "statusCode" IN ('active', 'retired'))
  AND ("retiredAt" IS NULL OR "statusCode" = 'retired')
);

-- §3.12「一活动至多一个 active」。partial 是关键:draft / retired 必须能有多条,
-- 否则活动连第二版草稿都建不出来。
CREATE UNIQUE INDEX "registration_form_version_activity_active_unique"
ON "RegistrationFormVersion" ("activityId")
WHERE "statusCode" = 'active';

-- ===== ④ "RegistrationFormField"(§3.12)=====

-- §3.12 明写八种题型。NULL 边界:typeCode NOT NULL ⇒ 恒二值。
ALTER TABLE "RegistrationFormField"
ADD CONSTRAINT "registration_form_field_type_code_check"
CHECK ("typeCode" IN (
  'short_text', 'long_text', 'number', 'date',
  'single_choice', 'multi_choice', 'file', 'confirmation'
));

-- number 题的取值域:两列各自可空(单边开区间合法),都有值时必须有序。
-- ⚠️ NULL 边界正是这条的要害:前两个析取项**必须**在。
-- 若只写 `"minValue" <= "maxValue"`,任一为 NULL 时整式 = NULL ⇒ CHECK 判通过,
-- 看似"放行了单边区间",实则整条约束在这些行上不存在;而真正要拦的
-- 「min > max 且两者都有值」仍会被拦 —— 于是错误写法在测试里**也会全绿**,
-- 只有专门构造"一边为 NULL"的用例才分得清。这里显式写出。
ALTER TABLE "RegistrationFormField"
ADD CONSTRAINT "registration_form_field_value_range_check"
CHECK ("minValue" IS NULL OR "maxValue" IS NULL OR "minValue" <= "maxValue");

-- 长度域同理,外加各自的符号下界。三个子句各自被 `IS NULL OR` 守住 ⇒ 整式恒二值。
ALTER TABLE "RegistrationFormField"
ADD CONSTRAINT "registration_form_field_length_range_check"
CHECK (
  ("minLength" IS NULL OR "minLength" >= 0)
  AND ("maxLength" IS NULL OR "maxLength" >= 1)
  AND ("minLength" IS NULL OR "maxLength" IS NULL OR "minLength" <= "maxLength")
);

-- multi_choice 可选上限;NULL = 不限。NULL 边界由 `IS NULL OR` 守住。
ALTER TABLE "RegistrationFormField"
ADD CONSTRAINT "registration_form_field_max_selections_check"
CHECK ("maxSelections" IS NULL OR "maxSelections" >= 1);

-- ===== ⑤ "RegistrationFormAnswer"(§3.12)——本刀 NULL 风险最高的一条 =====
--
-- §3.12:「valueText/valueNumber/valueDate/valueJson/attachmentId,exactly-one 由 CHECK 保证」。
--
-- 🔴 **计数式写法,不是 AND/OR 串**。理由是三值逻辑:
--   `IS NOT NULL` 是**二值**谓词(永不返回 NULL),故每个 CASE 恒为整数 1 或 0,
--   五项之和恒为 0..5 的**非 NULL 整数**,`= 1` 恒为 TRUE 或 FALSE。
--   ⇒ 这条 CHECK **在结构上不可能求值成 NULL**,也就不可能出现
--     「表达式为 NULL ⇒ CHECK 判通过 ⇒ 约束静默失效」那个第一刀踩过的坑。
--   而等价的 AND/OR 拼法(如 `(a IS NOT NULL AND b IS NULL AND …) OR (…)`)行数多、
--   分支多,任何一处漏写 IS NOT NULL 都会塌成 NULL 而静默放行 —— 同样的语义,
--   一个形态天然免疫,另一个形态要靠人不出错。选前者。
--
-- 覆盖两个方向:**零个非空**(和为 0)与**两个及以上非空**(和 >= 2)都被拒。
ALTER TABLE "RegistrationFormAnswer"
ADD CONSTRAINT "registration_form_answer_exactly_one_value_check"
CHECK (
  (CASE WHEN "valueText" IS NOT NULL THEN 1 ELSE 0 END
   + CASE WHEN "valueNumber" IS NOT NULL THEN 1 ELSE 0 END
   + CASE WHEN "valueDate" IS NOT NULL THEN 1 ELSE 0 END
   + CASE WHEN "valueJson" IS NOT NULL THEN 1 ELSE 0 END
   + CASE WHEN "attachmentId" IS NOT NULL THEN 1 ELSE 0 END) = 1
);

-- ===== ⑥ "RegistrationUploadSession"(§3.12)=====
--
-- 「expiresAt 必填」由 DDL 的 NOT NULL 承担(见上文建表),不需要也不能用 CHECK 表达
-- —— CHECK 对 NULL 判通过,`CHECK ("expiresAt" IS NOT NULL)` 反而是那个坑的教科书例子。
--
-- 「consumedAt 只在 consumed 态有值」:单向蕴含。
-- NULL 边界:statusCode NOT NULL;consumedAt 为 NULL 时首项 TRUE ⇒ 整式恒二值。
ALTER TABLE "RegistrationUploadSession"
ADD CONSTRAINT "registration_upload_session_consumed_shape_check"
CHECK ("consumedAt" IS NULL OR "statusCode" = 'consumed');

-- ===== ⑦ "ActivityQualificationRuleSet"(§3.13)=====
--
-- ⚠️ 合同**未给**本表 statusCode 闭集(只说"发布审核后 active"),也**未给**任何 unique。
-- 两者一律不自行发明(AGENTS §2);只落版本号符号约束。
-- NULL 边界:version NOT NULL ⇒ 恒二值。
ALTER TABLE "ActivityQualificationRuleSet"
ADD CONSTRAINT "activity_qualification_rule_set_version_check"
CHECK ("version" >= 1);

-- ===== ⑧ "ActivityQualificationRule"(§3.13)=====

-- §3.13 明写 block/warn。NULL 边界:NOT NULL 列 ⇒ 恒二值。
ALTER TABLE "ActivityQualificationRule"
ADD CONSTRAINT "activity_qualification_rule_enforcement_code_check"
CHECK ("enforcementCode" IN ('block', 'warn'));

-- §3.13「支持 grade、organization、certificate、age、training、gender、insurance」七种。
-- 按闭集处理 —— 与 goal DoD 7 对 §3.12「支持类型：…」同样措辞取闭集口径保持一致。
ALTER TABLE "ActivityQualificationRule"
ADD CONSTRAINT "activity_qualification_rule_type_code_check"
CHECK ("ruleTypeCode" IN (
  'grade', 'organization', 'certificate', 'age', 'training', 'gender', 'insurance'
));

-- ===== ⑨ "QualificationEvaluationSnapshot"(§3.13)=====

-- §3.13 明写 pass/warn/fail。NULL 边界:NOT NULL 列 ⇒ 恒二值。
ALTER TABLE "QualificationEvaluationSnapshot"
ADD CONSTRAINT "qualification_evaluation_snapshot_result_code_check"
CHECK ("resultCode" IN ('pass', 'warn', 'fail'));

-- ===== ⑩ "ActivityInvitation"(§3.14)=====

-- §3.14 明写五态闭集。NULL 边界:statusCode NOT NULL ⇒ 恒二值。
ALTER TABLE "ActivityInvitation"
ADD CONSTRAINT "activity_invitation_status_code_check"
CHECK ("statusCode" IN ('pending', 'accepted', 'declined', 'revoked', 'expired'));

-- 撤销形状:**双向** —— revoked 必有 revokedAt,非 revoked 必无。
-- NULL 边界:左边是 NOT NULL 列的比较(二值),右边是 `IS NOT NULL`(二值),
-- 布尔 = 布尔 ⇒ 整式恒二值,不可能为 NULL。
-- ⚠️ 与第一刀 capacity_reservation 那条不同:非法 statusCode 在这里**不会**让本条也失败
-- ('bogus'='revoked' 为 false、revokedAt IS NOT NULL 为 false ⇒ false=false 为真),
-- 故非法 statusCode 只会命中 status_code_check 一条,配套 spec 可以放心断言约束名。
ALTER TABLE "ActivityInvitation"
ADD CONSTRAINT "activity_invitation_revoked_shape_check"
CHECK (("statusCode" = 'revoked') = ("revokedAt" IS NOT NULL));

-- 应答形状:**刻意单向**,不写成双向。
--   - accepted / declined ⇒ 必须有 respondedAt(应答态没有应答时间是脏数据);
--   - pending ⇒ 必须没有 respondedAt(还没应答哪来的应答时间);
--   - revoked / expired ⇒ **不约束** —— "先接受、后被撤销"是真实流程,
--     写成双向会把 revoked 行的 respondedAt 强行清空,等于用约束抹掉事实。
-- NULL 边界:statusCode NOT NULL ⇒ NOT IN / <> 均二值;两个子句各自恒二值。
ALTER TABLE "ActivityInvitation"
ADD CONSTRAINT "activity_invitation_responded_shape_check"
CHECK (
  ("statusCode" NOT IN ('accepted', 'declined') OR "respondedAt" IS NOT NULL)
  AND ("statusCode" <> 'pending' OR "respondedAt" IS NULL)
);

-- §3.14「active partial unique (activityId, memberId, sessionId)」。
--
-- 🔴 **NULLS NOT DISTINCT(PG15+;本库 postgres:16)** —— 沿 role_bindings_active_unique 先例。
-- sessionId **可空**(NULL = 活动级邀请)。PostgreSQL 默认唯一索引把 NULL 视为互不相等,
-- 不加这一句的话:同一个人可以被重复发出**任意多张**活动级邀请而一条都不被拦 ——
-- 而这恰恰是本索引最需要拦的形态(场次级邀请因 sessionId 有值反而天然被拦住)。
-- 也就是说,漏掉 NULLS NOT DISTINCT 会让这条索引在**它最该生效的那一类行上**完全失效。
--
-- 谓词取 statusCode='pending':"active" = 尚未应答、仍占着"你被邀请了"这个位。
-- declined / revoked / expired 必须放行重发(否则一次拒绝就永久锁死改邀),
-- accepted 不入谓词 —— 重复邀请已接受者虽无意义,但真正的兜底是
-- ActivityParticipationIdentity 的 (activityId, sessionId, memberId) 唯一,不在这里重复设闸。
CREATE UNIQUE INDEX "activity_invitation_active_unique"
ON "ActivityInvitation" ("activityId", "memberId", "sessionId")
NULLS NOT DISTINCT
WHERE "statusCode" = 'pending';

-- ===== ⑪ "ActivityVisitor"(§3.14)=====
--
-- 🔴 **刻意零约束、零 Member 外键**,不是漏了。
-- 合同 §3.14 原话:「与 Member、Participation、Ledger 无 relation;禁止通过访客创建贡献分」。
-- invitedByMemberId 是裸留痕列,上文建表段**没有**为它生成外键(可自行核对 AddForeignKey 段:
-- ActivityVisitor 只有 activityId 与 (activityId, sessionId) 两条,均指向活动域,不指向 Member)。
-- 合同未给本表任何闭集或形状约束,故不自行发明。

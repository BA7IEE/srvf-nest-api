-- CreateTable
CREATE TABLE "AttendanceQrCredential" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "actionCode" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL,
    "statusCode" TEXT NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "signingKeyVersion" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "issuedByUserId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "revokedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "operationKey" TEXT,
    "requestHash" TEXT,

    CONSTRAINT "AttendanceQrCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendancePunchEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "positionId" TEXT,
    "participationIdentityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "eventTypeCode" TEXT NOT NULL,
    "sourceCode" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "operatorMemberId" TEXT,
    "reason" TEXT,
    "qrCredentialId" TEXT,
    "deviceId" TEXT,
    "longitude" DECIMAL(10,7),
    "latitude" DECIMAL(10,7),
    "accuracy" DECIMAL(10,2),
    "distance" DECIMAL(10,2),
    "geoVerified" BOOLEAN NOT NULL DEFAULT false,
    "outOfRange" BOOLEAN NOT NULL DEFAULT false,
    "lowAccuracy" BOOLEAN NOT NULL DEFAULT false,
    "eventKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "supersedesEventId" TEXT,
    "evidenceRevision" INTEGER NOT NULL,

    CONSTRAINT "AttendancePunchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvidenceState" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "evidenceRevision" INTEGER NOT NULL DEFAULT 0,
    "populationRevision" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastEvidenceAt" TIMESTAMP(3),
    "lastPopulationAt" TIMESTAMP(3),

    CONSTRAINT "ActivityEvidenceState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceSeal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "sealRevision" INTEGER NOT NULL,
    "evidenceRevision" INTEGER NOT NULL,
    "populationRevision" INTEGER NOT NULL,
    "workflowRevision" INTEGER NOT NULL,
    "allWindowsClosedAt" TIMESTAMP(3) NOT NULL,
    "openSegmentCount" INTEGER NOT NULL,
    "manualReviewPendingCount" INTEGER NOT NULL,
    "populationCountDistinct" INTEGER NOT NULL,
    "populationCountBySession" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "sealedByUserId" TEXT,
    "sealedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceSeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipantServiceSegmentRevision" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "participationIdentityId" TEXT NOT NULL,
    "segmentKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "sourceCheckInEventId" TEXT NOT NULL,
    "sourceCloseEventId" TEXT,
    "resultCode" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "checkInAt" TIMESTAMP(3) NOT NULL,
    "checkOutAt" TIMESTAMP(3),
    "serviceHours" DECIMAL(5,2),
    "lateFlag" BOOLEAN NOT NULL DEFAULT false,
    "earlyLeaveFlag" BOOLEAN NOT NULL DEFAULT false,
    "exceptionFlagsJson" JSONB,
    "baseRevisionId" TEXT,

    CONSTRAINT "ParticipantServiceSegmentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceQrCredential_activityId_idx" ON "AttendanceQrCredential"("activityId");

-- CreateIndex
CREATE INDEX "AttendanceQrCredential_sessionId_idx" ON "AttendanceQrCredential"("sessionId");

-- CreateIndex
CREATE INDEX "AttendanceQrCredential_statusCode_idx" ON "AttendanceQrCredential"("statusCode");

-- CreateIndex
CREATE INDEX "AttendanceQrCredential_validUntil_idx" ON "AttendanceQrCredential"("validUntil");

-- CreateIndex
CREATE INDEX "AttendanceQrCredential_operationKey_idx" ON "AttendanceQrCredential"("operationKey");

-- CreateIndex
CREATE INDEX "AttendanceQrCredential_sessionId_actionCode_statusCode_idx" ON "AttendanceQrCredential"("sessionId", "actionCode", "statusCode");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_qr_credential_session_action_version_key" ON "AttendanceQrCredential"("sessionId", "actionCode", "credentialVersion");

-- CreateIndex
CREATE INDEX "AttendancePunchEvent_activityId_sessionId_occurredAt_idx" ON "AttendancePunchEvent"("activityId", "sessionId", "occurredAt");

-- CreateIndex
CREATE INDEX "attendance_punch_event_identity_occurred_idx" ON "AttendancePunchEvent"("participationIdentityId", "occurredAt");

-- CreateIndex
CREATE INDEX "AttendancePunchEvent_operatorUserId_createdAt_idx" ON "AttendancePunchEvent"("operatorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AttendancePunchEvent_activityId_idx" ON "AttendancePunchEvent"("activityId");

-- CreateIndex
CREATE INDEX "AttendancePunchEvent_sessionId_idx" ON "AttendancePunchEvent"("sessionId");

-- CreateIndex
CREATE INDEX "AttendancePunchEvent_positionId_idx" ON "AttendancePunchEvent"("positionId");

-- CreateIndex
CREATE INDEX "AttendancePunchEvent_memberId_idx" ON "AttendancePunchEvent"("memberId");

-- CreateIndex
CREATE INDEX "AttendancePunchEvent_eventTypeCode_idx" ON "AttendancePunchEvent"("eventTypeCode");

-- CreateIndex
CREATE INDEX "AttendancePunchEvent_qrCredentialId_idx" ON "AttendancePunchEvent"("qrCredentialId");

-- CreateIndex
CREATE INDEX "AttendancePunchEvent_supersedesEventId_idx" ON "AttendancePunchEvent"("supersedesEventId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendancePunchEvent_eventKey_key" ON "AttendancePunchEvent"("eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityEvidenceState_activityId_key" ON "ActivityEvidenceState"("activityId");

-- CreateIndex
CREATE INDEX "EvidenceSeal_activityId_idx" ON "EvidenceSeal"("activityId");

-- CreateIndex
CREATE INDEX "EvidenceSeal_statusCode_idx" ON "EvidenceSeal"("statusCode");

-- CreateIndex
CREATE INDEX "EvidenceSeal_sealedAt_idx" ON "EvidenceSeal"("sealedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceSeal_activityId_sealRevision_key" ON "EvidenceSeal"("activityId", "sealRevision");

-- CreateIndex
CREATE INDEX "participant_service_segment_identity_idx" ON "ParticipantServiceSegmentRevision"("participationIdentityId");

-- CreateIndex
CREATE INDEX "participant_service_segment_identity_status_idx" ON "ParticipantServiceSegmentRevision"("participationIdentityId", "statusCode");

-- CreateIndex
CREATE INDEX "participant_service_segment_status_idx" ON "ParticipantServiceSegmentRevision"("statusCode");

-- CreateIndex
CREATE INDEX "participant_service_segment_result_idx" ON "ParticipantServiceSegmentRevision"("resultCode");

-- CreateIndex
CREATE INDEX "participant_service_segment_checkin_event_idx" ON "ParticipantServiceSegmentRevision"("sourceCheckInEventId");

-- CreateIndex
CREATE INDEX "participant_service_segment_close_event_idx" ON "ParticipantServiceSegmentRevision"("sourceCloseEventId");

-- CreateIndex
CREATE INDEX "participant_service_segment_base_revision_idx" ON "ParticipantServiceSegmentRevision"("baseRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "participant_service_segment_identity_key_revision_key" ON "ParticipantServiceSegmentRevision"("participationIdentityId", "segmentKey", "revision");

-- AddForeignKey
ALTER TABLE "AttendanceQrCredential" ADD CONSTRAINT "AttendanceQrCredential_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceQrCredential" ADD CONSTRAINT "AttendanceQrCredential_activityId_sessionId_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceQrCredential" ADD CONSTRAINT "AttendanceQrCredential_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceQrCredential" ADD CONSTRAINT "AttendanceQrCredential_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_activityId_sessionId_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "ActivitySessionPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_participationIdentityId_fkey" FOREIGN KEY ("participationIdentityId") REFERENCES "ActivityParticipationIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_operatorMemberId_fkey" FOREIGN KEY ("operatorMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_qrCredentialId_fkey" FOREIGN KEY ("qrCredentialId") REFERENCES "AttendanceQrCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_supersedesEventId_fkey" FOREIGN KEY ("supersedesEventId") REFERENCES "AttendancePunchEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvidenceState" ADD CONSTRAINT "ActivityEvidenceState_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceSeal" ADD CONSTRAINT "EvidenceSeal_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceSeal" ADD CONSTRAINT "EvidenceSeal_sealedByUserId_fkey" FOREIGN KEY ("sealedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantServiceSegmentRevision" ADD CONSTRAINT "ParticipantServiceSegmentRevision_participationIdentityId_fkey" FOREIGN KEY ("participationIdentityId") REFERENCES "ActivityParticipationIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantServiceSegmentRevision" ADD CONSTRAINT "ParticipantServiceSegmentRevision_sourceCheckInEventId_fkey" FOREIGN KEY ("sourceCheckInEventId") REFERENCES "AttendancePunchEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantServiceSegmentRevision" ADD CONSTRAINT "ParticipantServiceSegmentRevision_sourceCloseEventId_fkey" FOREIGN KEY ("sourceCloseEventId") REFERENCES "AttendancePunchEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipantServiceSegmentRevision" ADD CONSTRAINT "ParticipantServiceSegmentRevision_baseRevisionId_fkey" FOREIGN KEY ("baseRevisionId") REFERENCES "ParticipantServiceSegmentRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- 活动改造 v1.1 第 1 批第三刀 —— 手工追加的数据库不变量
-- (合同 §3.15 / §3.16 / §3.17 / §3.18;Prisma DSL 表达不了 CHECK / partial unique /
--  trigger,故骨架由只读 `migrate diff` 生成后在此手工追加,沿证书 PR-4b 与前两刀处置)
--
-- 🔬 NULL 边界总纪律(前两刀实测结论,本刀全程照此设计):
--   SQL 三值逻辑下 CHECK **在表达式求值为 NULL 时判通过** ⇒ 一条"看起来很严"的
--   CHECK 可以静默失效。第一刀真正的失效发生在 **OR** 支路:`FALSE OR NULL = NULL`
--   ⇒ 放行;而 AND 支路是 FALSE 主导(`FALSE AND NULL = FALSE`),朴素写法不改行为。
--   本刀凡涉及可空列的判定,一律用下列两种**结构上不可能塌成 NULL** 的写法:
--     (a) 计数式:`(CASE WHEN x IS NOT NULL THEN 1 ELSE 0 END + …) IN (…)`
--         —— `IS NOT NULL` 是二值谓词,求和恒为非 NULL 整数;
--     (b) CASE 判别式:判别列 NOT NULL ⇒ 必定命中某个分支,且各分支体均为二值谓词。
--   凡写成 `x IS NULL OR <关于 x 的比较>` 的,其左operand 为 FALSE 时 x 必非 NULL
--   ⇒ 右operand 也必为二值,故整式恒二值(这类是**自证文档**,不改行为,已如实标注)。
-- ============================================================================

-- ===== ① "AttendanceQrCredential"(§3.15)=====

-- §3.15 字段表原话:「action 为 check_in 或 check_out」⇒ 二值闭集。
-- NULL 边界:actionCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "AttendanceQrCredential"
ADD CONSTRAINT "attendance_qr_credential_action_code_check"
CHECK ("actionCode" IN ('check_in', 'check_out'));

-- §3.15 明写 active/revoked/expired;§4.4 `active → revoked | expired` 不可逆
-- (不可逆是状态机语义,单行 CHECK 表达不了跨版本的迁移方向,归 service 层)。
-- NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "AttendanceQrCredential"
ADD CONSTRAINT "attendance_qr_credential_status_code_check"
CHECK ("statusCode" IN ('active', 'revoked', 'expired'));

-- 作废形状:**双向** —— revoked 必有 revokedAt,非 revoked 必无。
-- NULL 边界:左边是 NOT NULL 列的比较(二值),右边是 `IS NOT NULL`(二值),
-- 布尔 = 布尔 ⇒ 整式恒二值。
-- ⚠️ 沿第二刀 activity_invitation_revoked_shape_check 的实测结论:非法 statusCode
-- **不会**连带命中本条('bogus'='revoked' 为 false、revokedAt IS NOT NULL 为 false
-- ⇒ false=false 为真),故配套 spec 可以放心断言命中的约束名。
ALTER TABLE "AttendanceQrCredential"
ADD CONSTRAINT "attendance_qr_credential_revoked_shape_check"
CHECK (("statusCode" = 'revoked') = ("revokedAt" IS NOT NULL));

-- §3.15「credentialVersion 单调递增」。内容版本号沿第二刀 RegistrationFormVersion
-- 的 `version >= 1` 口径(每次重发建新 version);signingKeyVersion 是**外部**密钥
-- 版本号,合同未给起点,取保守的非负(不猜 1-based / 0-based)。
-- NULL 边界:两列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "AttendanceQrCredential"
ADD CONSTRAINT "attendance_qr_credential_version_check"
CHECK ("credentialVersion" >= 1 AND "signingKeyVersion" >= 0);

-- §3.15「validFrom/validUntil 有效窗口」⇒ 窗口不得倒置或退化为空。
-- NULL 边界:两列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "AttendanceQrCredential"
ADD CONSTRAINT "attendance_qr_credential_validity_window_check"
CHECK ("validFrom" < "validUntil");

-- §3.15 明写:「同一 session/action 至多一个 active credential,**DB partial unique**」。
-- 🟢 键列 sessionId / actionCode **均 NOT NULL** ⇒ 与第二刀 activity_invitation_active_unique
--    不同,本条**不需要** NULLS NOT DISTINCT(那条的键含可空 sessionId,不加就会在
--    活动级邀请上完全失效)。此处没有可空键列,PG 的 NULL 去重语义根本不参与。
CREATE UNIQUE INDEX "attendance_qr_credential_active_unique"
ON "AttendanceQrCredential" ("sessionId", "actionCode")
WHERE "statusCode" = 'active';

-- ===== ② "AttendancePunchEvent"(§3.16)=====

-- §3.16 明写五态闭集。NULL 边界:eventTypeCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "AttendancePunchEvent"
ADD CONSTRAINT "attendance_punch_event_event_type_code_check"
CHECK ("eventTypeCode" IN ('check_in', 'check_out', 'early_departure_close', 'void', 'replace'));

-- §3.16 明写七态闭集。NULL 边界:sourceCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "AttendancePunchEvent"
ADD CONSTRAINT "attendance_punch_event_source_code_check"
CHECK ("sourceCode" IN ('self_qr', 'staff_scan', 'proxy', 'bulk', 'import', 'offline', 'correction'));

-- 🔴 §3.16 的 void/replace 形状。合同原话:「eventType=void/replace 时
--    supersedesEventId 和 reason 必填;**普通签到签退不得带 supersedes**」。
--
-- 拆成**三条**而不是一条大 OR。⚠️ 这里要**诚实**:拆开的理由**不是** NULL 坍塌。
-- 本刀实测核对过 —— 朴素写法
--   (eventTypeCode IN ('void','replace') AND supersedesEventId IS NOT NULL AND reason IS NOT NULL)
--   OR (eventTypeCode IN ('check_in','check_out') AND supersedesEventId IS NULL)
-- 的**每个操作数都恒二值**(判别列 eventTypeCode 是 NOT NULL ⇒ IN 恒二值;
-- `IS [NOT] NULL` 本身恒二值),故它**不可能**塌成 NULL。把它说成"OR 就会塌"
-- 是套用第一刀教训的**误述**,与本表事实不符。
--
-- 真正的理由有两条,其一已用变异实测钉死:
--   ① 朴素单条 OR 会**静默误杀合法行**:early_departure_close 让两条支路**同时为假**
--      ⇒ 整式 false ⇒ 合同从未要求禁止的形态被拒。实测:装上朴素式后,一条带 reason
--      的合法 early_departure_close 立刻被 23514 拒(变异 A/B 见 PR body)。
--   ② 拆开后每一侧有**独立可断言的约束名**,spec 能逐条钉死命中哪条,而不是笼统断言 23514。
--
-- 采用的 CASE 判别式同样恒二值:判别列 NOT NULL ⇒ 必命中某分支;各分支体是
-- `IS NOT NULL` / `IS NULL` 二值谓词或字面 TRUE ⇒ 整式结构上不可能求值为 NULL。
-- 与朴素式的区别在于 ELSE TRUE 显式放行未点名的 eventType,不误杀。

-- (2-a) void/replace ⇒ 必须指向被处理的原事件。
ALTER TABLE "AttendancePunchEvent"
ADD CONSTRAINT "attendance_punch_event_supersede_shape_check"
CHECK (
  CASE
    WHEN "eventTypeCode" IN ('void', 'replace') THEN "supersedesEventId" IS NOT NULL
    ELSE TRUE
  END
);

-- (2-b) 普通签到签退 ⇒ **不得**带 supersedes(合同原话的后半句)。
-- ⚠️ early_departure_close 刻意**不**入本条:合同只说"普通签到签退"不得带,
--    没说特殊闭合能不能带 ⇒ 沿"合同没给的不发明"不替它决定。
ALTER TABLE "AttendancePunchEvent"
ADD CONSTRAINT "attendance_punch_event_plain_no_supersede_check"
CHECK (
  CASE
    WHEN "eventTypeCode" IN ('check_in', 'check_out') THEN "supersedesEventId" IS NULL
    ELSE TRUE
  END
);

-- (2-c) §3.16 reason 列语义:「人工、特殊闭合、作废和替代必填」。
-- ⚠️ 只落**能无歧义映射到编码**的三类:特殊闭合 = early_departure_close、
--    作废 = void、替代 = replace。
--    「人工」在 sourceCode 闭集里**没有唯一对应**(proxy? bulk? correction? 三者
--    都可以被叫作人工),按"合同没给的不发明"不自行选定,留给第 5 批 service 层。
ALTER TABLE "AttendancePunchEvent"
ADD CONSTRAINT "attendance_punch_event_reason_required_check"
CHECK (
  CASE
    WHEN "eventTypeCode" IN ('early_departure_close', 'void', 'replace') THEN "reason" IS NOT NULL
    ELSE TRUE
  END
);

-- §3.16「位置字段成对;不要求定位时允许全部 null」⇒ 经纬度三态中只允许"全空 / 全有",
-- 禁"半有"。**计数式**写法:两个 `IS NOT NULL` 各归一成 0/1 再求和,和恒为非 NULL
-- 整数 ⇒ 整式结构上免疫「表达式为 NULL ⇒ CHECK 判通过」。
-- ⚠️ accuracy / distance **刻意不入成对判定**:它们是伴随测量值而非坐标本身
--    (设备可以给出坐标却给不出精度估计;distance 还需要一个参照点,而"不要求定位"
--     的场次根本没有参照点)。把它们并进来会比合同更严,反而挡住合法行。
ALTER TABLE "AttendancePunchEvent"
ADD CONSTRAINT "attendance_punch_event_coordinate_pair_check"
CHECK (
  (
    (CASE WHEN "longitude" IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN "latitude" IS NOT NULL THEN 1 ELSE 0 END)
  ) IN (0, 2)
);

-- 证据版本号非负(沿前两刀 revision 计数器 `>= 0` 口径)。
-- NULL 边界:evidenceRevision NOT NULL ⇒ 恒二值。
ALTER TABLE "AttendancePunchEvent"
ADD CONSTRAINT "attendance_punch_event_evidence_revision_check"
CHECK ("evidenceRevision" >= 0);

-- §3.16「一条原事件至多被一个**当前有效** void/replace 操作处理」。
-- 取 goal 给的默认形态:supersedesEventId 上按 eventTypeCode 分域的 partial unique。
-- 🟡 supersedesEventId 可空,故按本仓「可空列进 partial unique 须 NULLS NOT DISTINCT」
--    的既有纪律带上该子句。诚实说明:上面的 (2-a) 已强制本索引谓词命中的行
--    (void/replace)必有非空 supersedesEventId ⇒ 索引里**不可能出现 NULL 键**,
--    因此该子句在当前约束集下**没有独立可观测行为**,配套 spec 也就无法为它单独
--    产出一条"被拒"证据。保留它是纵深防御(万一 (2-a) 日后被改动),不是已验证判据。
CREATE UNIQUE INDEX "attendance_punch_event_supersede_target_unique"
ON "AttendancePunchEvent" ("supersedesEventId")
NULLS NOT DISTINCT
WHERE "eventTypeCode" IN ('void', 'replace');

-- 🔴 §3.16 append-only:「不提供 update/delete endpoint」+「生产业务角色不得
--    UPDATE/DELETE」⇒ 由 **数据库 trigger** 强制,不只靠权限与"没写端点"。
--    镜像既有 trg_insurance_evidence_20_immutable(第 62 migration)的函数 + trigger 两段范式。
--
-- ⚠️ 行级 trigger **不响应 TRUNCATE**(TRUNCATE 只触发 statement 级 BEFORE TRUNCATE
--    trigger)⇒ `test/setup/reset-db.ts` 的 TRUNCATE ... CASCADE 清库不受影响。
--    本表被 CASCADE 带走(它引用 "Activity",而 "Activity" 在 TRUNCATE 列表内)。
--    这条**已实测**,不是推理:见配套 spec 的 TRUNCATE 用例。
--    同样的语义在 insurance_eligibility_evidences 上已运行一个多月(reset-db.ts 内有记载)。
CREATE FUNCTION attendance_punch_event_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $attendance_punch_event_append_only$
BEGIN
  RAISE EXCEPTION 'attendance punch event is append-only'
  USING
    ERRCODE = '55000',
    CONSTRAINT = 'attendance_punch_event_append_only';
  RETURN NULL;
END;
$attendance_punch_event_append_only$;

CREATE TRIGGER trg_attendance_punch_event_10_append_only
BEFORE UPDATE OR DELETE ON "AttendancePunchEvent"
FOR EACH ROW EXECUTE FUNCTION attendance_punch_event_append_only_guard();

-- ===== ③ "ActivityEvidenceState"(§3.17)=====
--
-- 「一活动一行」由 "ActivityEvidenceState_activityId_key"(上文 Prisma 生成的 unique)保证。
-- 合同**未给**本表任何状态闭集 ⇒ 不自行发明,只落版本号符号约束。
-- NULL 边界:三列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "ActivityEvidenceState"
ADD CONSTRAINT "activity_evidence_state_revision_check"
CHECK ("evidenceRevision" >= 0 AND "populationRevision" >= 0 AND "version" >= 0);

-- ===== ④ "EvidenceSeal"(§3.17)=====

-- §3.17 明写 active/superseded 二值闭集(§4.6 `unsealed → active seal → superseded`)。
-- NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "EvidenceSeal"
ADD CONSTRAINT "evidence_seal_status_code_check"
CHECK ("statusCode" IN ('active', 'superseded'));

-- 版本号与计数快照非负。NULL 边界:六列均 NOT NULL ⇒ 恒二值。
ALTER TABLE "EvidenceSeal"
ADD CONSTRAINT "evidence_seal_revision_check"
CHECK (
  "sealRevision" >= 0
  AND "evidenceRevision" >= 0
  AND "populationRevision" >= 0
  AND "workflowRevision" >= 0
);

ALTER TABLE "EvidenceSeal"
ADD CONSTRAINT "evidence_seal_counts_check"
CHECK (
  "openSegmentCount" >= 0
  AND "manualReviewPendingCount" >= 0
  AND "populationCountDistinct" >= 0
);

-- ⚠️ 「一活动至多一个 active seal」**刻意不建** partial unique:合同 §3.17 没给,
--    §11.3「必需索引」只给 Closure 点了「partial unique active activity」,Seal 那行
--    (`activityId/sealRevision` unique)没有。沿"合同没给的不发明"。
--    (activityId, sealRevision) 的普通 unique 由上文 Prisma 生成的
--    "EvidenceSeal_activityId_sealRevision_key" 承担。

-- ===== ⑤ "ParticipantServiceSegmentRevision"(§3.18)=====

-- §3.18 明写 resultCode 四态闭集。NULL 边界:resultCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "ParticipantServiceSegmentRevision"
ADD CONSTRAINT "participant_service_segment_result_code_check"
CHECK ("resultCode" IN ('valid', 'early_departure_zero', 'voided', 'replaced'));

-- §3.18 明写 statusCode 三态闭集。NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "ParticipantServiceSegmentRevision"
ADD CONSTRAINT "participant_service_segment_status_code_check"
CHECK ("statusCode" IN ('draft', 'committed', 'superseded'));

-- revision 计数器非负(沿前两刀口径)。NULL 边界:NOT NULL ⇒ 恒二值。
ALTER TABLE "ParticipantServiceSegmentRevision"
ADD CONSTRAINT "participant_service_segment_revision_number_check"
CHECK ("revision" >= 0);

-- 时长非负。NULL 边界:serviceHours 可空,但 `IS NULL` 为 FALSE 时该列必非空
-- ⇒ 右operand 必为二值,不存在 `FALSE OR NULL` 的塌陷路径。
-- 诚实标注:去掉 `IS NULL OR` 守卫后行为**完全相同**(NULL >= 0 得 NULL,CHECK 亦放行),
-- 故这一句是**自证文档而非行为**(沿第二刀同一诚实结论)。
ALTER TABLE "ParticipantServiceSegmentRevision"
ADD CONSTRAINT "participant_service_segment_service_hours_check"
CHECK ("serviceHours" IS NULL OR "serviceHours" >= 0);

-- 签退不得早于签到。NULL 边界同上(checkInAt NOT NULL,checkOutAt 非空时两侧皆二值)。
-- 开放段(checkOutAt IS NULL)放行 —— 见 schema 里对 §4.5 open 态的说明。
ALTER TABLE "ParticipantServiceSegmentRevision"
ADD CONSTRAINT "participant_service_segment_checkout_order_check"
CHECK ("checkOutAt" IS NULL OR "checkOutAt" >= "checkInAt");

-- §3.18「同一 identity 同一时刻至多一个 current non-superseded segment」。
-- 🟢 键列 participationIdentityId / segmentKey **均 NOT NULL** ⇒ 不需要 NULLS NOT DISTINCT。
-- 🔴 谓词取 `statusCode <> 'superseded'`(statusCode NOT NULL ⇒ 谓词恒二值):
--    draft 与 committed 都占"当前"这个位,只有 superseded 让位给后继 revision。
-- ⚠️ 这是**点唯一**,不是**区间不相交** —— §3.18 明写「时间重叠校验在现有 member lock
--    内完成」,故本刀刻意**不**用 exclusion constraint / btree_gist 表达段重叠(见文件头)。
CREATE UNIQUE INDEX "participant_service_segment_current_unique"
ON "ParticipantServiceSegmentRevision" ("participationIdentityId", "segmentKey")
WHERE "statusCode" <> 'superseded';

-- 活动业务改造 v1.1 —— 第 1 批**第五刀**:分配 / 志愿 / 候补 / 预留名额(合同 §3.11)
--
-- expand-only:净新 4 张空表 + 既有表加 **1 列(可空)** + 末尾手工追加约束。
-- 零 DROP / 零 RENAME / 零既有列语义变更 / 零回填 / 零删数 / 零 enum / 零 seed / 零 trigger。
--
-- ⚠️ 骨架由**只读** `prisma migrate diff --from-migrations --to-schema-datamodel` 生成,
--    随后剥掉两条**与本刀无关的存量** RenameIndex
--    (notification_outbox_intents / storage_object_operations 的长索引名 63 字符截断
--     口径漂移;在 main 上跑同一条 diff 得到逐字相同的两条),再手工追加末尾约束。
--
-- ⚠️ 兑现第一刀欠账:`ActivityParticipationRevision.allocationBatchId` 连列带外键补齐
--    (第一刀按「跨切片外键列不提前占位」暂缓,目标表 ActivityAllocationBatch 正是本刀建的)。
--    该列**可空** ⇒ 有存量行的库也安全(本仓生产从未 deploy,存量为空;可空是形态要求)。
--
-- ⚠️ `ActivityAllocationBatch.ruleSnapshotId`(合同 §3.11 字段表第三行)**本刀不建**:
--    它指向 §3.4 的 `ActivityRuleSnapshot`,那张表至今没有建(§14 第 3 批才实现)。
--    沿同一条「跨切片外键列不提前占位」——由建 ActivityRuleSnapshot 的那一刀补齐。

-- AlterTable
ALTER TABLE "ActivityParticipationRevision" ADD COLUMN     "allocationBatchId" TEXT;

-- CreateTable
CREATE TABLE "ActivityPositionPreference" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registrationRevisionId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "preferenceOrder" INTEGER NOT NULL,

    CONSTRAINT "ActivityPositionPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityAllocationBatch" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "positionId" TEXT,
    "modeCode" TEXT NOT NULL,
    "candidateSnapshotHash" TEXT NOT NULL,
    "randomCommitment" TEXT,
    "statusCode" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "createdByUserId" TEXT,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ActivityAllocationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityAllocationCandidate" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "allocationBatchId" TEXT NOT NULL,
    "participationIdentityId" TEXT NOT NULL,
    "qualificationScore" DECIMAL(12,4),
    "tieBreakKey" TEXT NOT NULL,
    "lotteryOrder" INTEGER,
    "resultCode" TEXT,
    "waitlistRank" INTEGER,
    "explanation" JSONB,

    CONSTRAINT "ActivityAllocationCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityReservedQuotaGroup" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "scopeTypeCode" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "qualificationRuleSetId" TEXT,
    "capacity" INTEGER,
    "releaseAt" TIMESTAMP(3) NOT NULL,
    "fallbackMode" TEXT NOT NULL,

    CONSTRAINT "ActivityReservedQuotaGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_position_preference_session_idx" ON "ActivityPositionPreference"("sessionId");

-- CreateIndex
CREATE INDEX "activity_position_preference_position_idx" ON "ActivityPositionPreference"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_position_preference_order_key" ON "ActivityPositionPreference"("registrationRevisionId", "sessionId", "preferenceOrder");

-- CreateIndex
CREATE UNIQUE INDEX "activity_position_preference_position_key" ON "ActivityPositionPreference"("registrationRevisionId", "sessionId", "positionId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_allocation_batch_operation_key_key" ON "ActivityAllocationBatch"("operationKey");

-- CreateIndex
CREATE INDEX "activity_allocation_batch_activity_idx" ON "ActivityAllocationBatch"("activityId");

-- CreateIndex
CREATE INDEX "activity_allocation_batch_session_idx" ON "ActivityAllocationBatch"("sessionId");

-- CreateIndex
CREATE INDEX "activity_allocation_batch_position_idx" ON "ActivityAllocationBatch"("positionId");

-- CreateIndex
CREATE INDEX "activity_allocation_batch_status_idx" ON "ActivityAllocationBatch"("statusCode");

-- CreateIndex
CREATE INDEX "activity_allocation_batch_mode_idx" ON "ActivityAllocationBatch"("modeCode");

-- CreateIndex
CREATE INDEX "activity_allocation_candidate_batch_rank_idx" ON "ActivityAllocationCandidate"("allocationBatchId", "waitlistRank");

-- CreateIndex
CREATE INDEX "activity_allocation_candidate_batch_idx" ON "ActivityAllocationCandidate"("allocationBatchId");

-- CreateIndex
CREATE INDEX "activity_allocation_candidate_identity_idx" ON "ActivityAllocationCandidate"("participationIdentityId");

-- CreateIndex
CREATE INDEX "activity_reserved_quota_group_activity_idx" ON "ActivityReservedQuotaGroup"("activityId");

-- CreateIndex
CREATE INDEX "activity_reserved_quota_group_scope_idx" ON "ActivityReservedQuotaGroup"("scopeTypeCode", "scopeId");

-- CreateIndex
CREATE INDEX "activity_reserved_quota_group_release_idx" ON "ActivityReservedQuotaGroup"("releaseAt");

-- CreateIndex
CREATE INDEX "activity_reserved_quota_group_ruleset_idx" ON "ActivityReservedQuotaGroup"("qualificationRuleSetId");

-- CreateIndex
CREATE INDEX "activity_participation_revision_batch_status_idx" ON "ActivityParticipationRevision"("allocationBatchId", "statusCode");

-- AddForeignKey
ALTER TABLE "ActivityParticipationRevision" ADD CONSTRAINT "ActivityParticipationRevision_allocationBatchId_fkey" FOREIGN KEY ("allocationBatchId") REFERENCES "ActivityAllocationBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityPositionPreference" ADD CONSTRAINT "ActivityPositionPreference_registrationRevisionId_fkey" FOREIGN KEY ("registrationRevisionId") REFERENCES "ActivityRegistrationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityPositionPreference" ADD CONSTRAINT "ActivityPositionPreference_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ActivitySession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityPositionPreference" ADD CONSTRAINT "ActivityPositionPreference_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "ActivitySessionPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityAllocationBatch" ADD CONSTRAINT "ActivityAllocationBatch_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityAllocationBatch" ADD CONSTRAINT "ActivityAllocationBatch_activityId_sessionId_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityAllocationBatch" ADD CONSTRAINT "ActivityAllocationBatch_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "ActivitySessionPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityAllocationBatch" ADD CONSTRAINT "ActivityAllocationBatch_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityAllocationCandidate" ADD CONSTRAINT "ActivityAllocationCandidate_allocationBatchId_fkey" FOREIGN KEY ("allocationBatchId") REFERENCES "ActivityAllocationBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityAllocationCandidate" ADD CONSTRAINT "ActivityAllocationCandidate_participationIdentityId_fkey" FOREIGN KEY ("participationIdentityId") REFERENCES "ActivityParticipationIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityReservedQuotaGroup" ADD CONSTRAINT "ActivityReservedQuotaGroup_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityReservedQuotaGroup" ADD CONSTRAINT "ActivityReservedQuotaGroup_qualificationRuleSetId_fkey" FOREIGN KEY ("qualificationRuleSetId") REFERENCES "ActivityQualificationRuleSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- 以下为**手工追加**的数据库不变量(Prisma DSL 表达不了 CHECK)。
--
-- 🔴 NULL 边界口径(前四刀两次撞上、一次真出事,故每条逐个标注):
--    PostgreSQL 的 CHECK 在表达式求值为 **NULL 时判通过** ⇒ 任何可能塌成 NULL 的
--    表达式都是**静默失效**的护栏。AND 是 FALSE-主导(`FALSE AND NULL = FALSE`,安全);
--    **OR 才是 NULL 泄漏源**(`FALSE OR NULL = NULL` ⇒ 放行)。
--    ⇒ 凡本刀用到 OR 的地方,都在注释里逐个证明**两侧操作数恒为二值**。
-- ============================================================================


-- ===== ① "ActivityPositionPreference"(§3.11)=====
--
-- 两条 unique 已由上方骨架建出(§3.11 明写两条,缺一不可):
--   · activity_position_preference_order_key    (revision, session, preferenceOrder)
--     —— 拦「同一场次里两个岗位抢同一个志愿序位」
--   · activity_position_preference_position_key (revision, session, positionId)
--     —— 拦「同一个岗位被填成两个不同志愿」
-- 🟢 两条的键列**全 NOT NULL** ⇒ **不需要** NULLS NOT DISTINCT
--    (区别于第二刀 activity_invitation_active_unique 与第四刀
--     attendance_correction_request_open_unique:那两条的键含可空列)。
--
-- ⚠️ 刻意不做(一):`preferenceOrder` **没有**范围 CHECK。
--    §3.11 只给了列名,没给起点(0-based 还是 1-based 都说得通),写死任一个
--    都是发明合同没给的口径(④)。姊妹列 `ActivityParticipationRevision.waitlistRank`
--    在第一刀同样没有范围 CHECK ⇒ 本刀保持一致。已在 PR body 登记为待补口径。


-- ===== ② "ActivityAllocationBatch"(§3.11)=====

-- §3.11 明写三值闭集。NULL 边界:modeCode NOT NULL ⇒ IN 恒二值,不可能塌成 NULL。
ALTER TABLE "ActivityAllocationBatch"
ADD CONSTRAINT "activity_allocation_batch_mode_code_check"
CHECK ("modeCode" IN ('first_come', 'qualification_rank', 'lottery'));

-- §3.11 明写三值闭集。NULL 边界:statusCode NOT NULL ⇒ IN 恒二值。
ALTER TABLE "ActivityAllocationBatch"
ADD CONSTRAINT "activity_allocation_batch_status_code_check"
CHECK ("statusCode" IN ('preparing', 'committed', 'voided'));

-- 🔴 本刀**自加**的一条(合同没有逐字要求),理由是**成对的**:
--    我把合同字段表里未标 `?` 的 `committedAt` 放宽成了可空(否则 §3.11 自己的
--    `preparing` 态根本写不进来)。放宽了 NOT NULL,就必须配一道**更窄**的闸把
--    「committed 却没有提交时刻」重新关上 —— 否则这次放宽是净损失。
--    形状沿第一刀 activity_termination_shape_check(terminatedAt ⇒ statusCode)。
--
-- 🔴🔴 NULL 边界 —— **守卫必须前置,本刀实测过,初版写错了**:
--    初版写的是朴素式 `"statusCode" <> 'committed' OR "committedAt" IS NOT NULL`,
--    注释里断言「两侧恒二值 ⇒ 不可能塌成 NULL」。**那句话是有条件的真**:
--    它依赖 statusCode 的 NOT NULL —— 而那是**别处**的列声明,不是本式的结构性质。
--    scratch 库实测(变异 C):`ALTER COLUMN "statusCode" DROP NOT NULL` 之后插
--    `statusCode=NULL, committedAt=NULL`,`NULL <> 'committed'` 求值成 NULL、
--    `NULL OR FALSE = NULL` ⇒ **CHECK 判通过,该行真的入库**。
--    这正是第四刀记下的那条教训(「守卫必须前置,不能靠别处的 NOT NULL 声明兜底」)
--    的同型复发,本刀在合入前抓住并改掉。
--
-- 🟢 改用**守卫前置**式:`IS NOT NULL` 守卫排在 **AND 链最前**。
--    AND 是 FALSE-主导(`FALSE AND NULL = FALSE`)⇒ statusCode 为 NULL 时整式塌成
--    **FALSE 而非 NULL** ⇒ 拒绝。变异 D 实测:同一行(statusCode 仍是可空的)被 23514 拒。
--    ⇒ 本式**结构免疫**,不再依赖列声明兜底。
--
-- ⚠️ **单向蕴含,不写成双条件**:`voided` 的批次完全可能是「先 committed 后作废」
--    (§5.4「重新抽签必须 void 旧 batch」),那种行**应当保留**原来的 committedAt。
ALTER TABLE "ActivityAllocationBatch"
ADD CONSTRAINT "activity_allocation_batch_committed_shape_check"
CHECK (
  "statusCode" IS NOT NULL
  AND ("statusCode" <> 'committed' OR "committedAt" IS NOT NULL)
);

-- 🔴 幂等键唯一已由上方骨架建出,键是 **operationKey 单列**,不是
--    (operationKey, requestHash) 复合:复合唯一恰好**放行**「同一个 key 配不同
--    payload」,而那正是幂等键要拦的冲突(第二刀实测)。单列唯一严格蕴含复合唯一。
-- 🟢 operationKey NOT NULL ⇒ 普通 unique 即可,不涉及 NULL 互不相等问题。
--
-- 🟢 DoD 5 的答复(可空列进唯一索引的 NULLS NOT DISTINCT 问题):
--    本表**唯一的**唯一索引键是 operationKey(NOT NULL);可空的 `positionId`
--    **没有进任何唯一索引** —— §3.11 与 §11.3 都没有为本表要求岗位维度的唯一,
--    按④不发明。⇒ 本刀不需要 NULLS NOT DISTINCT,该子句无处可加也不该加。


-- ===== ③ "ActivityAllocationCandidate"(§3.11)=====
--
-- ⚠️ 刻意不做(二):本表**零 CHECK、零 unique、零 trigger**。逐条理由:
--
-- 🔴 (a) 不装 append-only trigger —— 三条理由,前两条独立成立:
--     ① 先例:§3.11 说的是「结果 **committed 后**不可改」,**没有**像 §3.23.8 那样
--        点名「DB 角色层禁 UPDATE/DELETE」。§3.17 EvidenceSeal(第三刀)与
--        §3.19 SettlementReviewAction(第四刀)都按「合同没点名 ⇒ 不装」处置;
--        **本刀沿的就是这两条先例**。
--     ② 正面理由(比先例更硬):这里是**条件不可变**,不是 append-only。
--        批次 preparing 期正要往候选行里写评分 / 抽签序号 / 结果 / 候补序号,
--        一条无条件 append-only trigger 会把**合法写路径直接堵死** —— 装上就是错的。
--     ③ 那么"按父批次 statusCode 判"的条件 trigger 呢?那是**跨行**判据:
--        行级 trigger 里读父批次在并发下会骗人(两事务互相看不见对方未提交的
--        status 变更),与第四刀「日合计求和 trigger 在并发下骗人」同型。
--        ⇒ 执行位归第 4 批 service(Activity 锁内重读批次状态),
--        本刀**不装一个看着像执行位、实际拦不住的东西**。
--     配套 spec 用两条会变红的用例把"刻意"钉住:preparing 期 UPDATE 必须放行;
--     本表 pg_trigger 必须为空集。
--
-- 🔴 (b) `resultCode` 不落闭集 CHECK:§3.11 说了"最终结果"却**没给取值集**(④)。
--     沿第四刀 ActivityBatchJobItem.statusCode 同一处置,用「任意取值必须放行 +
--     本表零 resultCode CHECK」把**合同缺口**钉成会变红的判据。
--
-- 🔴 (c) 不建 (allocationBatchId, participationIdentityId) unique:
--     §3.11 与 §11.3 对本表**一条唯一约束都没给**(④)。沿第三刀 EvidenceSeal
--     「一活动至多一个 active seal 刻意不建」的处置,用「同批次同 identity 的
--     第二行必须放行」把"刻意不建"钉成判据 —— 哪天有人顺手补上会立刻变红。
--
-- 🟢 §11.4 明写「候补排名由 AllocationCandidate **可索引 rank** 读取」⇒
--    activity_allocation_candidate_batch_rank_idx 是合同点名的,不是盲加。


-- ===== ④ "ActivityReservedQuotaGroup"(§3.11)=====

-- §3.11 的 capacity 与 §3.10 同族口径:null 不限;有值 >= 1(DoD 3)。
-- 形状逐字沿既有 activity_capacity_positive_check / activity_session_capacity_positive_check。
--
-- 🟢 NULL 边界:`"capacity" IS NULL` 是 IS NULL 谓词,**结构上**恒二值;
--    capacity 为 NULL 时左操作数为 TRUE ⇒ `TRUE OR NULL = TRUE`(放行,正确 —— 不限名额);
--    capacity 非空时左为 FALSE、右恒二值 ⇒ `FALSE OR (t/f)`。整式恒不为 NULL。
--    ⚠️ 与上面那条不同,本式的守卫**不依赖任何列声明** ⇒ 结构免疫,无需前置化改写。
--
-- ⚠️⚠️ **一条诚实的负面结论**(变异 E 实测,不要把这条 CHECK 说得比它实际做的更多):
--    `IS NULL OR` 这个守卫在本式里是**自证文档而非行为** —— 换成朴素式
--    `CHECK ("capacity" >= 1)` 后,capacity=NULL 的行**照样入库**(NULL >= 1 求值成
--    NULL ⇒ CHECK 判通过),capacity=0 的行**照样被拒**。两种写法在全部输入上判定相同。
--    保留显式写法的理由只是「读的人一眼看出 NULL 是有意放行的」+ 与既有两条姊妹
--    约束逐字同形,**不是**因为它挡住了什么。
--    (第二刀对 range/length 类 CHECK 记过同型结论;真正会失效的是**上面**那条
--     判别列可空的 OR —— 两者的区别就是守卫是不是 IS [NOT] NULL 谓词本身。)
--
-- ⚠️ DoD 4 的字面要求是「凡涉及可空列的 CHECK,给该列为 NULL 的**拒绝**用例」。
--    本条的 capacity 为 NULL 是**合法**形态(不限名额),没有"NULL 即非法"的读数可取;
--    故本条的 NULL 边界证据 = 「NULL 必须被**接受**」的正对照 + 「0 / 负数必须被
--    **拒绝**」的反对照。本刀真正满足 DoD 4 字面的是上面那条 committed_shape_check。
ALTER TABLE "ActivityReservedQuotaGroup"
ADD CONSTRAINT "activity_reserved_quota_group_capacity_positive_check"
CHECK ("capacity" IS NULL OR "capacity" >= 1);

-- ⚠️ 刻意不做(三):`scopeTypeCode` 与 `fallbackMode` **均不落闭集 CHECK**。
--    §3.11 对这两列一个取值都没给(④)。⚠️ 特别是 scopeTypeCode:照搬 §3.10 的
--    `activity_person / session_participation / position_participation / reserve_group`
--    看着"很自然",但那是**容量桶**的 scope 闭集,把它写进预留组等于替维护者定口径
--    (预留组自己就是 reserve_group,它的 scope 只可能是 activity/session/position,
--     可这仍是推测)。已在 PR body 登记为**合同缺口**,待补定义后由行为批次补 CHECK。
--    配套 spec 用「任意取值必须放行 + 本表零这两列的 CHECK」把缺口钉成判据。

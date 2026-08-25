-- P2-11 收口刀:把离线打卡名册的四条复合锚点外键从 ON UPDATE CASCADE 收成 ON UPDATE RESTRICT
--
-- 维护者 2026-08-25 拍板:「离线打卡名册被上游悄悄改掉这件事,要让机器管;**先只锁编号**。」
--
-- ============================================================================
-- 问题
-- ============================================================================
--
-- `OfflinePackageParticipant` 是离线打卡包生成当时的**人员名册**,业务语义上应当定格。
-- 它的四条复合外键在 schema.prisma 里只写了 `onDelete: Restrict`,**没写 `onUpdate`** ——
-- 而 Prisma 的 `onUpdate` 默认值是 `Cascade`(与被引用列可空与否无关),
-- 于是实际 DDL 全部落到 `ON UPDATE CASCADE`:
--
--   OfflinePackageParticipant_package_anchor_fkey                    -> OfflinePackage(id, activityId, sessionId)
--   OfflinePackageParticipant_activity_session_fkey                  -> ActivitySession(activityId, id)
--   OfflinePackageParticipant_participationIdentityId_activity_fkey  -> ActivityParticipationIdentity(id, activityId, sessionId, memberId)
--   OfflinePackageParticipant_positionId_activityId_sessionId_fkey   -> ActivitySessionPosition(id, activityId, sessionId)
--
-- 后果:任何一处改掉上游主键(改编号),这份名册的对应列会**跟着被改掉**。而本表
-- **只有 `createdAt`、没有 `updatedAt`**、**没有 append-only trigger** ⇒ 改完之后
-- 没有任何一处能看出它变过。名册是离线打卡复核与结算的取数底,静默漂移不可接受。
--
-- ============================================================================
-- 为什么四条一起收、而单列外键不动
-- ============================================================================
--
-- 复合外键携带的正是「同一条业务主链」的锚点(activityId / sessionId / memberId /
-- positionId / offlinePackageId)—— 这些就是拍板说的「编号」。单列外键
-- (`activity` / `member` / `participationRevision`)指向的是链根与全局实体的代理主键,
-- 不在本刀范围内(拍板:「不动其他表的 FK」「先只锁编号」)。
--
-- 这**不是新范式**:schema.prisma 里此前已有 **19 处**显式 `onUpdate: Restrict`
-- (2026-08-26 起刀当日按 model 归属实测:`AuditLog.actorUser` ×1 ·
--  `InsuranceEligibilityEvidence.activityRegistrationRevision` ×1 ·
--  `ActivityAllocationCandidate` ×4 · `ActivityAllocationCommandReceipt` ×2 ·
--  `ActivityAllocationApplicationProjection` ×11),全部落在冻结 / 审计类模型上。
-- 本刀补的是同一族里的一处漏网,加完是 23 处。
--
-- ============================================================================
-- 现有数据 / 可逆性
-- ============================================================================
--
-- · 只改约束,**不加列、不删列、不改可空性、不改列类型**。
-- · `OfflinePackageParticipant` 全仓唯一写者是
--   `src/modules/attendances/attendance-offline-package.service.ts` 的 `createMany`(纯 INSERT);
--   全仓零 `update` / `updateMany` / `delete` / `deleteMany` / `upsert`(另两处是 `findUnique`)。
--   ⇒ 收紧 ON UPDATE 不可能挡住任何既有写路径。
-- · DROP + ADD 是 PostgreSQL 改外键引用动作的**唯一**办法(不能就地 ALTER)。
--   四条约束名**逐字保持不变** —— `test/e2e/activity-v11-batch6-staff-import-offline-schema-constraints`
--   按名断言 `OfflinePackageParticipant_package_anchor_fkey`,
--   `test/e2e/activity-v11-batch4-allocation-command-replay-migration` 的
--   `EXPECTED_PRISMA_CURRENT_DIFF` 里也逐字钉着其中两条的已知改名漂移;改名会当场打挂它们。
-- · **可逆**。回滚 SQL(把四条改回 ON UPDATE CASCADE,即本 migration 之前的状态):
--
--     ALTER TABLE "OfflinePackageParticipant" DROP CONSTRAINT "OfflinePackageParticipant_package_anchor_fkey";
--     ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_package_anchor_fkey" FOREIGN KEY ("offlinePackageId", "activityId", "sessionId") REFERENCES "OfflinePackage"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;
--     ALTER TABLE "OfflinePackageParticipant" DROP CONSTRAINT "OfflinePackageParticipant_activity_session_fkey";
--     ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_activity_session_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
--     ALTER TABLE "OfflinePackageParticipant" DROP CONSTRAINT "OfflinePackageParticipant_participationIdentityId_activity_fkey";
--     ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_participationIdentityId_activity_fkey" FOREIGN KEY ("participationIdentityId", "activityId", "sessionId", "memberId") REFERENCES "ActivityParticipationIdentity"("id", "activityId", "sessionId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;
--     ALTER TABLE "OfflinePackageParticipant" DROP CONSTRAINT "OfflinePackageParticipant_positionId_activityId_sessionId_fkey";
--     ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_positionId_activityId_sessionId_fkey" FOREIGN KEY ("positionId", "activityId", "sessionId") REFERENCES "ActivitySessionPosition"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;
--
--   (回滚只改约束,零数据变更;生产尚未 deploy。)
--
-- ============================================================================
-- 机器执法
-- ============================================================================
--
-- 本刀之后由 `scripts/check-composite-anchor-closure.ts` 的**冻结记录改号锁**判据把关:
-- 「冻结记录(持 ≥2 业务锚点 · 有 createdAt 无 updatedAt)+ 同链复合外键」这个集合里,
-- 不允许出现**既无 `onUpdate: Restrict` 又无 append-only / immutable trigger** 的成员。
-- 扫描面动态取自 schema.prisma 与 prisma/migrations/**,不写死表名单。

-- DropForeignKey
ALTER TABLE "OfflinePackageParticipant" DROP CONSTRAINT "OfflinePackageParticipant_package_anchor_fkey";

-- DropForeignKey
ALTER TABLE "OfflinePackageParticipant" DROP CONSTRAINT "OfflinePackageParticipant_activity_session_fkey";

-- DropForeignKey
ALTER TABLE "OfflinePackageParticipant" DROP CONSTRAINT "OfflinePackageParticipant_participationIdentityId_activity_fkey";

-- DropForeignKey
ALTER TABLE "OfflinePackageParticipant" DROP CONSTRAINT "OfflinePackageParticipant_positionId_activityId_sessionId_fkey";

-- AddForeignKey
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_package_anchor_fkey" FOREIGN KEY ("offlinePackageId", "activityId", "sessionId") REFERENCES "OfflinePackage"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_activity_session_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_participationIdentityId_activity_fkey" FOREIGN KEY ("participationIdentityId", "activityId", "sessionId", "memberId") REFERENCES "ActivityParticipationIdentity"("id", "activityId", "sessionId", "memberId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_positionId_activityId_sessionId_fkey" FOREIGN KEY ("positionId", "activityId", "sessionId") REFERENCES "ActivitySessionPosition"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

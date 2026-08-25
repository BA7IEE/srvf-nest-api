-- 活动归档动作(合同 §6.6 + AC-004 / AC-064;维护者 2026-08-25 拍板三问)。
--
-- 拍板:①「草稿归档」与「结算完归档」是**同一个标记、两套开工条件**;
--       ② 归档后列表**默认不显示**,可勾「显示已归档」看到;
--       ③ **能取消归档,但要留痕**(谁归的、谁撤的、什么时候)。
--
-- expand-only:`Activity` 加**十列全部可空** + 两条单列 unique。
-- 零 default、零回填、零 DROP、零 RENAME、零既有行重解释 —— 存量活动十列一律取 NULL,
-- 读作「从未归档过」,行为与本刀之前逐字相同。
--
-- ## 「同一个标记」落在哪
--
-- 落在 `Activity.statusCode` 的闭集上:新增第 6 值 `archived`
-- (原五值 draft / published / completed / cancelled / terminated)。
-- ⚠️ `Activity.statusCode` 在 DB 层**本来就没有 CHECK**(闭集只由 TS 状态机守,
--    见 harness/state-machines.json 该条 governedBlockers = ["no-db-check"]);
--    本刀**刻意不新加** CHECK —— 单给它加会造出「同一张表里一个状态列有执行位、
--    其余同形状态列没有」的第二份真相,且加 CHECK 属收紧既有列(D 档须单独拍板)。
--
-- ## 为什么用状态值而不是正交布尔位
--
-- 全仓活动读面里有 6 处**硬写** `statusCode = 'published'`(App 活动广场 / available /
-- dashboard 两处计数 / 活动开始前提醒 / 报名对账入队),它们靠状态值天然把已归档挡在外面。
-- 换成正交布尔位,这 6 处每一处都要记得再加一条 `archivedAt IS NULL`,漏一处 =
-- 「归档了还在列表里」。执行位放在值域上,比放在「每个调用点都要记得加过滤」上硬。
--
-- ## 归档**不改**结算语义
--
-- 关账的「已结束/已终止」判据是 `terminatedAt IS NOT NULL OR now() > "endAt"`
-- (activity-closure.service.ts evaluateChecks ①),一个字都不读 statusCode;
-- 唯一读 statusCode 的那格是「普通取消不伪造结算」(= 'cancelled')。
-- ⇒ `completed → archived` 不会让已关账活动在关账链里变形。
--
-- ## 留痕成对
--
-- 撤销归档时**不清空**归档三件事实(archivedAt / archivedByUserId / archiveReasonCode),
-- 只追加 unarchivedAt / unarchivedByUserId。
-- ⇒ 「这个活动被归档过又撤销过」= 两侧时刻同时非 NULL,一条 where 查得出来。
--    当前是否处于归档态由 statusCode 单独承载,不靠「archivedAt 有没有被抹掉」去推 ——
--    抹掉它就等于把留痕删了。
--
-- ## 两条 unique 的语义
--
-- 与既有 activity_cancel_operation_key_key / activity_terminate_operation_key_key 逐字同形:
-- 单列 partial-by-NULL unique(PG 的 NULL 互不相等 ⇒ 未归档的行不互相冲突)。
-- 保存的是**最近一次**归档 / 撤销归档的 operationKey;归档可反复(归→撤→再归),
-- 用更早一轮的 key 重放会撞到「键在但当前事实对不上」而被拒,不会静默再归档一次。
--
-- 回滚:
--   ALTER TABLE "Activity"
--     DROP COLUMN "archivedAt", DROP COLUMN "archivedByUserId",
--     DROP COLUMN "archivedFromStatusCode", DROP COLUMN "archiveReasonCode",
--     DROP COLUMN "archiveOperationKey", DROP COLUMN "archiveRequestHash",
--     DROP COLUMN "unarchivedAt", DROP COLUMN "unarchivedByUserId",
--     DROP COLUMN "unarchiveOperationKey", DROP COLUMN "unarchiveRequestHash";
--   (两条 unique 索引与两条外键随列 DROP 一并消失。)
-- 生产未 deploy。

BEGIN;

-- AlterTable
ALTER TABLE "Activity"
ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "archivedByUserId" TEXT,
ADD COLUMN "archivedFromStatusCode" TEXT,
ADD COLUMN "archiveReasonCode" TEXT,
ADD COLUMN "archiveOperationKey" TEXT,
ADD COLUMN "archiveRequestHash" TEXT,
ADD COLUMN "unarchivedAt" TIMESTAMP(3),
ADD COLUMN "unarchivedByUserId" TEXT,
ADD COLUMN "unarchiveOperationKey" TEXT,
ADD COLUMN "unarchiveRequestHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "activity_archive_operation_key_key" ON "Activity"("archiveOperationKey");

-- CreateIndex
CREATE UNIQUE INDEX "activity_unarchive_operation_key_key" ON "Activity"("unarchiveOperationKey");

-- AddForeignKey
-- onDelete: Restrict 与既有 canceller / terminatedBy 逐字同形 —— 归档人不可因删账号而消失。
ALTER TABLE "Activity"
ADD CONSTRAINT "Activity_archivedByUserId_fkey" FOREIGN KEY ("archivedByUserId")
REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity"
ADD CONSTRAINT "Activity_unarchivedByUserId_fkey" FOREIGN KEY ("unarchivedByUserId")
REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;

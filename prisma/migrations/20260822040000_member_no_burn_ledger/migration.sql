-- ============================================================================
-- 队员编号「已烧号」台账(2026-08-22;跨模型二轮复核头号发现,维护者拍板方案 A)
--
-- 修的缺陷:铁律「memberNo 一旦发放就永久占用,即使队员被删也不复用」此前**只靠
-- Member 表兑现** —— `assertMemberNoUnique` 用含软删的 findUnique 查 Member。软删场景
-- 够用(行还在),但 `correctIdentity`(#1127)是**原地 update**:旧号改完在库里不留
-- 任何行,下一个人建档时唯一性预检通过,**旧号被重新发出去**。而 memberNo 同时是登录
-- 识别锚(auth.service 按 memberNo 兜底查),号被复用 = 曾经用 A001 登录的是甲、现在是乙。
--
-- 本 migration 两段:
--   ① expand —— 净新一张表 `MemberNoReservation`(只增不删的台账)。
--   ② backfill —— 把**现有全部** Member(**含软删**)的 memberNo 灌进台账。
--      含软删是刻意的:软删队员的号本来就不许复用,漏掉它们等于在回填这一刻开一个口子。
--
-- 纯 additive:**零删列、零 DROP、零既有行重解释**,不改任何既有表的结构或数据。
-- 可逆性:理论上可逆(DROP 新表即回到本刀之前),沿仓内惯例不提供 down migration;
--         回滚 = 回到本 migration 之前的库快照。生产未 deploy。
--
-- ⚠️ 物理表名是 PascalCase `"MemberNoReservation"`(**不使用 `@@map`** —— prisma/CLAUDE.md
--    默认禁,goal 未授权;沿最近四刀「不使用 @@map,物理表名即 model 名」的惯例)。
--
-- ⚠️ 本文件不是 `prisma migrate diff` 的原样产物。diff 的输出里混着 **19 条语句**的既有
--    漂移(手写约束名 vs Prisma 默认名之间的 RenameForeignKey / RenameIndex 等),照抄即
--    真实回退。已按 prisma/CLAUDE.md 的处方做:从**纯历史**(`--from-migrations`)取 diff,
--    再**按语句逐条**减去同法取得的基线 —— 净差恰为下方 5 条 DDL,基线侧零丢失。
-- ============================================================================

-- CreateTable
CREATE TABLE "MemberNoReservation" (
    "id" TEXT NOT NULL,
    "memberNo" TEXT NOT NULL,
    "memberId" TEXT,
    "reservedAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "MemberNoReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- ⭐ 这条唯一约束**才是**「永不复用」的执行位,应用层预检只负责把 P2002 翻成业务错误码。
--    任何绕过预检的写路径(招新发号从不调 assertMemberNoUnique)仍被它挡下。
CREATE UNIQUE INDEX "MemberNoReservation_memberNo_key" ON "MemberNoReservation"("memberNo");

-- CreateIndex
CREATE INDEX "MemberNoReservation_memberId_idx" ON "MemberNoReservation"("memberId");

-- CreateIndex
CREATE INDEX "MemberNoReservation_reservedAt_idx" ON "MemberNoReservation"("reservedAt");

-- AddForeignKey
-- ⭐ ON DELETE SET NULL(**不是 RESTRICT**):铁律说的是「这个**号**永不复用」,不是
-- 「队员行永不可删」。队员行真被物理删掉时归属指针置空,而台账行连同它的 memberNo
-- 唯一约束原样留着 ⇒ 号照样烧着。用 RESTRICT 反而危险:撞 FK 的人最顺手的解法是
-- 「先删台账再删 member」,那正好把号解烧了。
ALTER TABLE "MemberNoReservation" ADD CONSTRAINT "MemberNoReservation_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 存量回填:现有每一个 Member 的 memberNo 都必须进台账,一个不漏。
--
-- WHERE 子句刻意**没有** `"deletedAt" IS NULL` —— 软删队员的号同样已发放、同样不许复用。
--
-- `id` 直接复用 `Member.id`:确定性(重放可复现,不吃 gen_random_uuid 的随机)、
-- 且此刻每个 member 恰有一行故必然唯一。沿 20260701130202 那条回填的同一手法
-- (MemberDepartment.id → member_organization_memberships.id)。
-- 订正之后新增的行由应用侧生成 cuid,与本批不冲突。
--
-- `reservedAt` 取 `Member.createdAt` 而非 `now()`:记的是这个号**当初发放**的时刻,
-- 不是回填跑过的时刻 —— 写 now() 会让整批存量的烧号时间显示为迁移当天,是假事实。
--
-- 刻意**不写** `ON CONFLICT DO NOTHING`:此刻表是空的,`Member.memberNo` 又是全局唯一,
-- 结构上不可能冲突。真冲突了就该整条 migration 炸掉让人来看,而不是静默少灌几行。
-- ============================================================================
INSERT INTO "MemberNoReservation" ("id", "memberNo", "memberId", "reservedAt", "reason")
SELECT
    "id",
    "memberNo",
    "id",
    "createdAt",
    'backfill'
FROM "Member";

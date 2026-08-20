-- ============================================================================
-- issue #1055 T1 —— 队员视觉身份资产终态升级(expand 段)
--
-- 纯 additive:新建 2 个 enum + 1 张表 + 给 "User" 加 1 个可空列。
-- **零回填、零删除、零既有行重解释** —— 本刀不切任何读写路径,现有流程行为不变。
-- 可逆性:理论上可逆(DROP 新对象即回到本刀之前),但沿仓内惯例不提供 down migration;
--         回滚 = 回到本 migration 之前的库快照。生产未 deploy。
--
-- ⚠️ 本文件**不是** `prisma migrate diff` 的原样产物,两点差异必须知道:
--
-- (1) diff 的输出里混着 **3 行与本刀无关的既有漂移**,照抄会造成真实回退:
--       ALTER TABLE "ActivityQualificationRuleSet" DROP CONSTRAINT "..._positionId_fkey";
--       ALTER TABLE "ActivitySessionPosition"      DROP CONSTRAINT "..._qualificationRuleSetId_fkey";
--       DROP INDEX "activity_qualification_rule_set_scope_version_unique";
--     已用「拿 HEAD 的未修改 schema 跑同一条 diff」做对照实测:这 3 行在基线上原样出现
--     ⇒ 是仓内手写 DB 对象(Prisma DSL 至 6.x 表达不了带 WHERE 的唯一索引)与 DSL 的
--     常驻落差,不是本刀引入的。本文件**已剔除**。
--
-- (2) 末尾的 partial unique 与 4 条 CHECK 是**手写的**,diff 生成不出来 ——
--     它们正是 DSL 表达不了、因而只能活在 migration 里的那部分不变量。
-- ============================================================================

-- CreateEnum
CREATE TYPE "MemberOfficialPortraitStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "MemberOfficialPortraitSource" AS ENUM ('ADMIN_UPLOAD', 'LEGACY_IMPORT');

-- AlterTable:账号头像指针。可空 + 无默认 ⇒ 存量行零改写,不会锁表重写。
-- 与既有 "avatarKey" 刻意并存(expand/contract 中间态);"avatarKey" 在 T5 删。
ALTER TABLE "User" ADD COLUMN     "avatarAttachmentId" TEXT;

-- CreateTable
CREATE TABLE "member_official_portraits" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "attachmentId" TEXT,
    "specVersion" TEXT NOT NULL,
    "source" "MemberOfficialPortraitSource" NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "status" "MemberOfficialPortraitStatus" NOT NULL DEFAULT 'ACTIVE',
    -- 刻意无 DEFAULT:见 schema.prisma 上的说明。没有默认值 ⇒ Prisma `create` 里必填
    -- ⇒ 应用侧被编译器逼着显式传应用时钟,杜绝"漏传就吃库时钟"。
    "activatedAt" TIMESTAMP(3) NOT NULL,
    "activatedByUserId" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" TEXT,
    "endReason" TEXT,
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_official_portraits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "member_official_portraits_attachmentId_key" ON "member_official_portraits"("attachmentId");

-- CreateIndex
CREATE INDEX "member_official_portraits_memberId_status_idx" ON "member_official_portraits"("memberId", "status");

-- CreateIndex
CREATE INDEX "member_official_portraits_attachmentId_idx" ON "member_official_portraits"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "member_official_portraits_memberId_version_key" ON "member_official_portraits"("memberId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "User_avatarAttachmentId_key" ON "User"("avatarAttachmentId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_avatarAttachmentId_fkey" FOREIGN KEY ("avatarAttachmentId") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_official_portraits" ADD CONSTRAINT "member_official_portraits_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_official_portraits" ADD CONSTRAINT "member_official_portraits_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_official_portraits" ADD CONSTRAINT "member_official_portraits_activatedByUserId_fkey" FOREIGN KEY ("activatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_official_portraits" ADD CONSTRAINT "member_official_portraits_endedByUserId_fkey" FOREIGN KEY ("endedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 以下是 Prisma DSL 表达不了、只能手写的部分(issue #1055 §5.2「数据库约束」)。
--
-- 每一条在 test/e2e/member-official-portrait-schema.e2e-spec.ts 里都配了一个
-- **违反它的负面用例**:直接绕过任何应用层往库里插一行,断言 PG 抛出对应的
-- 23505 / 23514。DB 约束有太多种静默失效形状(谓词写反、建在错列、被后续 migration
-- DROP、`@@map` 改名后指向不存在的表),**"写了"不等于"挡得住"**。
-- ============================================================================

-- 一个 Member 至多一张 ACTIVE 标准照(issue §5.2 不变量 1)。
-- Prisma DSL 至 6.x 不支持带 WHERE 的唯一索引,故手写;沿 `User_memberId_active_key` /
-- `member_org_membership_primary_active_unique` / `role_bindings_active_unique` 既有范式。
--
-- 为什么必须有它:T4 的替换事务是「旧行转 SUPERSEDED + 新行 ACTIVE」两步。并发两个替换
-- 请求即使各自都拿了 Member 行锁,锁释放后仍可能出现两行 ACTIVE(锁保证串行,不保证
-- 后来者看到的是最新状态 —— 除非它重读)。这条索引是最后一道、也是唯一一道
-- **不依赖应用代码写对**的兜底,冲突表现为 23505 → 由业务层映射成明确 BizCode。
CREATE UNIQUE INDEX "member_official_portrait_one_active_per_member"
    ON "member_official_portraits" ("memberId")
    WHERE "status" = 'ACTIVE';

-- CHECK ①:ACTIVE 行的相容性。
-- ACTIVE ⇒ 必须有二进制(attachmentId 非空)、且三个终结/清理字段全空。
-- 反过来说:一张"当前标准照"不可能既是当前的、又已经被终结或被清理掉二进制。
-- 注:"status" 是 NOT NULL 列,故 `<> 'ACTIVE'` 恒非 NULL,不存在 CHECK 因 NULL 恒真而空转。
ALTER TABLE "member_official_portraits"
    ADD CONSTRAINT "member_official_portraits_active_shape_check"
    CHECK (
        "status" <> 'ACTIVE'
        OR (
            "attachmentId" IS NOT NULL
            AND "endedAt" IS NULL
            AND "endedByUserId" IS NULL
            AND "purgedAt" IS NULL
        )
    );

-- CHECK ②:终态行必须留下"谁在什么时候终结的"。
-- SUPERSEDED / VOIDED ⇒ endedAt 与 endedByUserId 都非空。
-- 缺了它,历史版本会退化成"不知道被谁换掉的一行",追溯链断在这里。
ALTER TABLE "member_official_portraits"
    ADD CONSTRAINT "member_official_portraits_ended_shape_check"
    CHECK (
        "status" = 'ACTIVE'
        OR ("endedAt" IS NOT NULL AND "endedByUserId" IS NOT NULL)
    );

-- CHECK ③:二进制清理后的形态。
-- purgedAt 非空 ⇒ 不能还是 ACTIVE,且 attachmentId 必须已置空。
-- 与 ① 有一处**刻意的重叠**(ACTIVE + purgedAt 两条都挡):issue §5.2 把它单列一条,
-- 保留冗余是为了让"清理"这件事在约束层有自己的名字 —— 将来 ① 若因别的原因放宽,
-- 清理语义不会跟着一起松掉。
ALTER TABLE "member_official_portraits"
    ADD CONSTRAINT "member_official_portraits_purged_shape_check"
    CHECK (
        "purgedAt" IS NULL
        OR ("status" <> 'ACTIVE' AND "attachmentId" IS NULL)
    );

-- CHECK ④:specVersion 受控闭集(issue §6.1「必须来自受控 registry,不允许自由输入」)。
-- 这是那句话在库层的执行位 —— 只写在文档或 DTO 里,脚本导入 / 修数 SQL 就能绕过去。
-- 将来冻结 `uniform-portrait-v2` = 新开一条 migration 把它加进闭集;
-- **旧行保留自己的旧值,禁止批量改写**(issue §6.1)。
ALTER TABLE "member_official_portraits"
    ADD CONSTRAINT "member_official_portraits_spec_version_check"
    CHECK ("specVersion" IN ('uniform-portrait-v1'));

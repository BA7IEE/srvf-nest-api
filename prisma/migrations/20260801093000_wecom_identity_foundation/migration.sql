-- 企业微信接入 T1 —— schema expand-only(第 68 migration)
--
-- 冻结稿:docs/archive/reviews/wecom-integration-t0-terminal-review.md §5(2026-07-29 冻结)。
--
-- 本 migration 做什么:
--   ① SmsPurpose 追加一个 enum 值 WECOM_BIND(T3 才消费;本刀一并加,把 schema 变更收进这一条)
--   ② 净新 3 张**空**表:wecom_settings / wecom_identities / wecom_auth_attempts
--   ③ 2 条 RESTRICT FK(均指向 User)、3+4 条普通索引、2 条列级 @unique
--   ④ 末尾手写:1 条 singleton unique + 2 条 active partial unique + 2 条 CHECK
--      (Prisma DSL 表达不了 WHERE 子句与 CHECK,故手写)
--
-- 本 migration **不**做什么:
--   零回填、零删数、零 DROP、零 default 变更、零默认身份绑定、零不可逆操作。
--   三张表**零 runtime 读写入口** —— T2 才有 settings 端点,T3 才有 OAuth 与绑定。
--
-- 骨架由只读 `prisma migrate diff --from-migrations --to-schema-datamodel` 生成,
-- 剥掉两条与本批无关的 RenameIndex(notification_outbox_intents / storage_object_operations
-- 的历史索引名截断差异,沿证书 PR-4b 同一处置),再手工追加末尾 5 条约束。
--
-- enum 与建表同事务:PG16 允许 `ALTER TYPE ... ADD VALUE` 在事务内执行,限制是
-- 新值不能在**同一事务**里被使用 —— 本刀三张表没有任何列以 WECOM_BIND 为 default 或
-- 参与约束,故不触发该限制。已在干净库 `migrate deploy` 实测重放通过。

-- AlterEnum
ALTER TYPE "SmsPurpose" ADD VALUE 'WECOM_BIND';

-- CreateTable
CREATE TABLE "wecom_settings" (
    "id" TEXT NOT NULL,
    "providerType" TEXT NOT NULL DEFAULT 'DEV_STUB',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "loginEnabled" BOOLEAN NOT NULL DEFAULT false,
    "messageEnabled" BOOLEAN NOT NULL DEFAULT false,
    "corpId" TEXT,
    "agentId" INTEGER,
    "webBaseUrl" TEXT,
    "corpSecretEncrypted" TEXT,
    "credentialConfigured" BOOLEAN NOT NULL DEFAULT false,
    "remarks" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wecom_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wecom_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "corpId" TEXT NOT NULL,
    "wecomUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "bindingSource" TEXT NOT NULL,
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wecom_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wecom_auth_attempts" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "subjectUserId" TEXT,
    "stateHash" TEXT NOT NULL,
    "returnPath" TEXT NOT NULL,
    "stateExpiresAt" TIMESTAMP(3) NOT NULL,
    "stateConsumedAt" TIMESTAMP(3),
    "bindingTicketHash" TEXT,
    "corpId" TEXT,
    "wecomUserId" TEXT,
    "bindingExpiresAt" TIMESTAMP(3),
    "bindingConsumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wecom_auth_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wecom_identities_userId_status_idx" ON "wecom_identities"("userId", "status");

-- CreateIndex
CREATE INDEX "wecom_identities_corpId_status_idx" ON "wecom_identities"("corpId", "status");

-- CreateIndex
CREATE INDEX "wecom_identities_wecomUserId_idx" ON "wecom_identities"("wecomUserId");

-- CreateIndex
CREATE UNIQUE INDEX "wecom_auth_attempts_stateHash_key" ON "wecom_auth_attempts"("stateHash");

-- CreateIndex
CREATE UNIQUE INDEX "wecom_auth_attempts_bindingTicketHash_key" ON "wecom_auth_attempts"("bindingTicketHash");

-- CreateIndex
CREATE INDEX "wecom_auth_attempts_status_stateExpiresAt_idx" ON "wecom_auth_attempts"("status", "stateExpiresAt");

-- CreateIndex
CREATE INDEX "wecom_auth_attempts_bindingExpiresAt_idx" ON "wecom_auth_attempts"("bindingExpiresAt");

-- AddForeignKey
ALTER TABLE "wecom_identities" ADD CONSTRAINT "wecom_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_auth_attempts" ADD CONSTRAINT "wecom_auth_attempts_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== 以下 5 条为手写(Prisma DSL 表达不了 partial unique 的 WHERE 与 CHECK)=====

-- 冻结稿 §5.1:singleton —— 全库至多一行。
-- 表达式索引 ON ((true)):所有行的索引键都是同一个常量 true,故第二行必然撞唯一。
-- 沿第 49 migration 四张 provider settings 表(sms / wechat / storage / realname)的同一形状;
-- 并发首配由 P2002 后重跑同一事务映射到既有单行,不新增 BizCode。
CREATE UNIQUE INDEX "wecom_settings_singleton_unique"
ON "wecom_settings" ((true));

-- 冻结稿 §5.2:同一企业微信身份最多绑定一个 active User。
-- partial(WHERE status='active')是关键 —— revoked 历史行必须能重复,
-- 否则"解绑后换个人再绑同一个企业微信号"会被永久挡死。
CREATE UNIQUE INDEX "wecom_identity_subject_active_unique"
ON "wecom_identities" ("corpId", "wecomUserId")
WHERE "status" = 'active';

-- 冻结稿 §5.2:同一 User 在当前 CorpID 下最多一个 active 企业微信身份。
-- 换绑 = 结束旧 active 行 + 新建 active 行,两步必须在同一事务内,否则中途撞本索引。
CREATE UNIQUE INDEX "wecom_identity_user_active_unique"
ON "wecom_identities" ("corpId", "userId")
WHERE "status" = 'active';

-- 冻结稿 §5.2:status 闭集。String 列 + CHECK,不建 Prisma enum(与 providerType 同一取舍)。
ALTER TABLE "wecom_identities"
ADD CONSTRAINT "wecom_identity_status_check"
CHECK ("status" IN ('active', 'revoked'));

-- 冻结稿 §5.2:撤销形状 —— active ⇔ revokedAt IS NULL。
-- 防的是"状态说 active、却带着撤销时间"和"状态说 revoked、却查不到什么时候撤的"两种脏行;
-- 后者会让审计无法回答"这个绑定是什么时候失效的"。
ALTER TABLE "wecom_identities"
ADD CONSTRAINT "wecom_identity_revocation_shape_check"
CHECK (
  ("status" = 'active' AND "revokedAt" IS NULL)
  OR
  ("status" = 'revoked' AND "revokedAt" IS NOT NULL)
);

-- 十项收口一刀(2026-07-11;招新/入队十项问题核查 §刀B/刀E):
--
-- 1) 「至多一个 open 轮」DB 兜底(刀 B):开轮逻辑是事务内 count-then-update(READ COMMITTED,
--    SELECT 不加锁),两管理员并发开两个不同轮次时双方都可能看到 0 个其它 open 轮而双双成功,
--    形成隐蔽 open 轮(去重按轮隔离失效 / 统计与 promote 范围分裂)。partial unique 收口:
--    过滤集内 statusCode 恒为 'open',单列唯一 = 至多一行;service 保留 count 预检做友好快速失败,
--    update 外捕 P2002 转专码(招新 28032 / 入队 28231)。
--    (Prisma DSL 不支持带 WHERE 的 partial unique,手写于此;沿 recruitment_applications /
--    team_join_applications / role_bindings 等先例,不会被 migrate 判 drift。)
CREATE UNIQUE INDEX "recruitment_cycles_single_open_unique"
ON "recruitment_cycles"("statusCode")
WHERE "statusCode" = 'open' AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX "team_join_cycles_single_open_unique"
ON "team_join_cycles"("statusCode")
WHERE "statusCode" = 'open' AND "deletedAt" IS NULL;

-- 2) 建档搬运落点(刀 E;MemberProfile MP-34 / MP-35,全 additive 可空、无回填、无不可逆):
--    promote 此前把报名行 detailedAddress / profileExtra 事务内置空但未复制到任何表(真丢失);
--    现搬入队员档案长期承载(镜像 idCardImageKey / signatureImageKey 搬运范式;表名无 @@map,
--    沿 F5 `ALTER TABLE "MemberProfile"` 字面)。
ALTER TABLE "MemberProfile" ADD COLUMN "detailedAddress" TEXT;
ALTER TABLE "MemberProfile" ADD COLUMN "profileExtra" JSONB;

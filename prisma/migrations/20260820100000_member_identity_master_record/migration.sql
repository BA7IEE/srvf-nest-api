-- 队员身份主档终态升级(issue #1048 T1;维护者 2026-08-20 拍板)
--
-- 终态:`Member` 成为 `memberNo + realName + nickname` 的唯一日常身份事实源,
-- `Member.displayName` 与 `MemberProfile` 的 realName / joinedDate / joinSourceCode 一并退役。
--
-- ⚠️ 本文件是 **expand → backfill → contract 单事务三段式**,不是朴素的 `migrate diff` 产物。
--    朴素 diff 会直接 `ADD COLUMN ... NOT NULL`,在**任何非空库**上必然 23502 失败。
--    维护者已可能跑过一轮「内部验证轮」部署(docs/ops/server-deployment-runbook-stage2.md §0),
--    那个库里有真实测试数据 ⇒ 本 migration 必须能在非空库上跑通,不能假设空库。
--
-- 存量迁移范围:issue 第九章的五步迁移流程(legacy 标记 / 差异清单 / 人工核对)**整章不做** ——
-- 维护者已拍板存量老队员走 API 脚本一次性录入,没有需要人工比对的历史行。
-- 本文件内的回填只负责「让已存在的行合法地过渡到新列」,不做业务意义上的数据订正。
--
-- 不可逆:DROP COLUMN ×4(Member.displayName + MemberProfile 三列)。
-- 回滚 = 回滚到本 migration 之前的库快照;**没有 down migration**(沿仓内一贯口径)。

BEGIN;

-- 回填窗口内冻结两张表的写入:回填读 MemberProfile、写 Member,
-- 中途有并发写会让「已回填」与「刚插入的新行」出现空档,而下面紧接着就要 SET NOT NULL。
-- 直接取最终 DDL 所需的最高锁级,消除 SHARE -> ACCESS EXCLUSIVE 的升级窗口(沿 D-INSURANCE PR4 范式)。
LOCK TABLE "Member" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "MemberProfile" IN ACCESS EXCLUSIVE MODE;

-- ── ① expand:四列先全部可空落地 ────────────────────────────────────────────────
-- 可空是刻意的:此刻还没有值,带 NOT NULL 就等于要求一个业务上不存在的 DEFAULT。
ALTER TABLE "Member"
  ADD COLUMN "realName"         TEXT,
  ADD COLUMN "nickname"         TEXT,
  ADD COLUMN "memberSinceDate"  TIMESTAMP(3),
  ADD COLUMN "memberOriginCode" TEXT;

-- ── ② backfill ────────────────────────────────────────────────────────────────
-- 自连接 + LEFT JOIN(不是 `FROM "MemberProfile"`):后者是 INNER 语义,
-- **只会更新有档案的队员**,而 `Member.memberProfile` 是可选关系 ——
-- 管理员在 members.service.ts 手工建的队员根本没有 profile 行,那批会被整片漏掉、
-- 停在 NULL,然后在 ④ 处以 23502 炸掉。这是本刀最容易写错的一处。
--
-- `MemberProfile.memberId` 是**全表** UNIQUE(不是 partial)⇒ LEFT JOIN 至多配到一行,不扇出。
-- 刻意不按 `p."deletedAt" IS NULL` 过滤:档案被软删不代表这个人改了名字,
-- 而排除掉软删档案只会让这些队员静默退回 displayName —— 那是更差的数据,不是更安全的数据。
--
-- ⚠️ 日期口径:`memberSinceDate` 的兜底**必须按北京日历日**取午夜,不能用裸
-- `date_trunc('day', "createdAt")`。全仓纯日期字段统一走 `beijingDateOnly`
-- (src/common/datetime/date-only.util.ts:22 —— +8h 后取 Y/M/D,返回该日 UTC 午夜)。
-- 裸 UTC 截断会让**创建于 UTC 16:00–24:00**(= 北京次日 00:00–08:00)的队员整体差一天。
UPDATE "Member" m
SET "realName"         = COALESCE(p."realName", m."displayName"),
    "memberSinceDate"  = COALESCE(p."joinedDate", date_trunc('day', m."createdAt" + INTERVAL '8 hours')),
    "memberOriginCode" = COALESCE(p."joinSourceCode", 'manual')
FROM "Member" m2
  LEFT JOIN "MemberProfile" p ON p."memberId" = m2."id"
WHERE m2."id" = m."id";

-- `nickname` 刻意不回填:旧模型里根本没有「外号」这个事实,
-- 编造一个(比如拿 displayName 塞进去)会造出一批假外号,而外号是 issue §5.2 规则 4
-- 明令**永远不能自动确认身份**的字段 —— 假数据在那条规则上是有害的。留 NULL 是正确终态。

-- ── ③ fail-fast:回填完整性 ────────────────────────────────────────────────────
-- 按上面的取值链三列都不可能为 NULL(displayName / createdAt 均 NOT NULL,
-- 第三列有字面量兜底)。这道闸守的是「链条被改坏」而不是「预期内的缺口」——
-- 若哪天有人把 LEFT JOIN 改回 INNER,这里会给出一条能读懂的消息,
-- 而不是让 ④ 抛一个只说列名的 23502。
DO $member_identity_backfill_check$
DECLARE
  missing_real_name   BIGINT;
  missing_since_date  BIGINT;
  missing_origin_code BIGINT;
BEGIN
  SELECT COUNT(*) INTO missing_real_name   FROM "Member" WHERE "realName" IS NULL;
  SELECT COUNT(*) INTO missing_since_date  FROM "Member" WHERE "memberSinceDate" IS NULL;
  SELECT COUNT(*) INTO missing_origin_code FROM "Member" WHERE "memberOriginCode" IS NULL;

  IF missing_real_name <> 0 OR missing_since_date <> 0 OR missing_origin_code <> 0 THEN
    RAISE EXCEPTION
      'member identity backfill incomplete: realName=% memberSinceDate=% memberOriginCode=% rows still NULL',
      missing_real_name, missing_since_date, missing_origin_code;
  END IF;
END
$member_identity_backfill_check$;

-- ── ④ contract:收紧 NOT NULL ──────────────────────────────────────────────────
-- `nickname` 保持可空 —— 它本来就是可选事实(schema 侧 `String?`)。
ALTER TABLE "Member"
  ALTER COLUMN "realName"         SET NOT NULL,
  ALTER COLUMN "memberSinceDate"  SET NOT NULL,
  ALTER COLUMN "memberOriginCode" SET NOT NULL;

-- ── ⑤ 删旧列(不可逆;必须排在回填之后,回填正读着它们)────────────────────────
ALTER TABLE "Member" DROP COLUMN "displayName";

ALTER TABLE "MemberProfile"
  DROP COLUMN "realName",
  DROP COLUMN "joinedDate",
  DROP COLUMN "joinSourceCode";

-- ── ⑥ 检索索引 ────────────────────────────────────────────────────────────────
-- issue #1048 T2 的排序第 ② 级是 realName 完全匹配(等值谓词)。
-- 第 ④ 级 `contains` 走 ILIKE,吃不到本索引 —— 不要据此以为模糊搜索被加速了。
CREATE INDEX "Member_realName_idx" ON "Member"("realName");

COMMIT;

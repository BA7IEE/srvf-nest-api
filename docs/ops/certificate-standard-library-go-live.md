# 证书标准库上线 runbook(PR-4b contract migration)

> 冻结稿:[`docs/archive/reviews/certificate-standard-library-t0-review.md`](../archive/reviews/certificate-standard-library-t0-review.md) v1.2 §20。
> 适用 migration:`20260730090000_certificate_standard_library_contract`(第 67 个,**不可逆**)。

这份 runbook 只有一个目的:**在执行一次不可逆的 DROP COLUMN 之前,用只读 SQL 证明没有数据会被删掉。**

PR-4b 删掉七列、把三列收紧为 NOT NULL。这些操作在空库上无风险,在有数据的库上会丢事实且无法回滚。所以判据不是「我认为库是空的」,而是下面这组探针在**真实目标库**上全部返 0。

## 一、执行顺序

```text
① 只读跑探针(本文第二节)—— 任一非 0 即停
② 停止写入(或确认无并发写)
③ pnpm prisma migrate deploy
④ 复核第三节的三条结构断言
```

第 ① 步不可跳过,第 ③ 步只能由维护者执行(AI 侧对 `migrate deploy` / `migrate dev` / `migrate reset` / `db push` 一律无权)。

## 二、前置探针(只读;§20.1 三条 + 4b 追加四条)

把下面整段贴进目标库的 psql。**期望每一行 `n` 都是 0。**

```sql
SELECT 'P1 Certificate 总行数' AS probe, COUNT(*) AS n FROM "Certificate";

SELECT 'P2 招新三个证书 JSON 非空行' AS probe, COUNT(*) AS n
FROM "recruitment_applications"
WHERE "certificateImages" IS NOT NULL
   OR "certificateReviewStatus" IS NOT NULL
   OR "certificateIssuanceInfo" IS NOT NULL;

SELECT 'P3 ownerType=certificate 的 attachments' AS probe, COUNT(*) AS n
FROM "attachments" WHERE "ownerType" = 'certificate';

SELECT 'P4a Certificate.certSubTypeCode 非空' AS probe, COUNT(*) AS n
FROM "Certificate" WHERE "certSubTypeCode" IS NOT NULL;

SELECT 'P4b Certificate.imageKeys 非空' AS probe, COUNT(*) AS n
FROM "Certificate" WHERE "imageKeys" IS NOT NULL;

SELECT 'P4c Certificate.isInternal = true' AS probe, COUNT(*) AS n
FROM "Certificate" WHERE "isInternal" = true;

SELECT 'P5 三列待转 NOT NULL 但有空值的行' AS probe, COUNT(*) AS n
FROM "Certificate"
WHERE "standardId" IS NULL OR "recognitionPolicyId" IS NULL OR "sourceCode" IS NULL;
```

除 SQL 之外还要人工确认三件事(§20.1 明列,SQL 查不出来):

- 是否存在 `certificate` 前缀的孤立 storage object;
- 是否有旧前端仍在调 category 证书接口(4a 已删端点,调用方会收 404);
- 是否有正在进行的招新联调数据。

### 任一非 0 时怎么做

```text
停止
输出计数与样本 id
回到维护者拍板
不执行 drop column
不猜 Standard
不批量回填
```

这条不是建议。P1 非 0 意味着库里有真实证书,而它们没有 `standardId` —— 此时 DROP 会把类别信息永久删掉,而回填需要人来决定「这张证属于哪个标准」,那是拍板不是脚本。

### 本仓已跑过的结果(2026-07-30)

在 head schema 的干净库(`app_cert_probe_head`,67 migrations)上,**八项全部为 0**。三个本地 dev 库(`app` / `app_membersv2_dev` / `app_migration_dev`)`Certificate` 行数亦为 0 —— 它们 schema 落后,P2/P4/P5 无法执行,但 P1/P3 已足以说明本地无证书数据。

**这不能替代生产库的探针。** 上面的结果只证明开发机干净。

## 三、迁移后结构复核

```sql
-- ① 三列已 NOT NULL,recognitionIssuerId 仍可空
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_name = 'Certificate'
  AND column_name IN ('standardId','recognitionPolicyId','recognitionIssuerId','sourceCode')
ORDER BY column_name;
-- 期望:recognitionIssuerId=YES,其余三列=NO

-- ② 七列已消失
SELECT column_name FROM information_schema.columns
WHERE (table_name = 'Certificate'
        AND column_name IN ('certTypeCode','certSubTypeCode','isInternal','imageKeys'))
   OR (table_name = 'recruitment_applications' AND column_name LIKE 'certificate%');
-- 期望:0 行

-- ③ 来源 CHECK 已就位
SELECT conname FROM pg_constraint WHERE conname = 'certificate_source_claim_consistency_check';
-- 期望:1 行
```

## 四、回滚

**没有列级回滚。** `DROP COLUMN` 不可逆,PR-4b 也不提供 down migration(本仓禁 down migration)。

冻结稿 §21 的约束是:4b 与 4a 必须同一个 release。若 4b 因任何原因无法完成,**回滚 4a 的代码、不发版**,而不是试图在 4b 之后往回补列。

数据层面的兜底只有一个:执行前的库备份。上线前请确认备份可用且可恢复。

## 五、上线后要盯的两处对外变化

这两处不是数据库问题,而是 4a/4b 合起来的契约破坏 —— 客户端不改就会报错:

| 面 | 变化 |
|---|---|
| 小程序 `GET /api/app/v1/my/certificates` | 出参 `certTypeCode`/`certSubTypeCode` → `standardId` + `standardName` + `certCategoryCode` + `certLevelCode`;查询参数 `certTypeCode` → `certCategoryCode` |
| 后台建证 / 改证 | 入参 `certTypeCode`(+`certSubTypeCode`)→ `standardId`;机构入参按认定规则的 `issuerPolicy` 决定传 `recognitionIssuerId` 还是 `issuingOrg` |

初始化顺序上还有一条硬前提:**库里必须先有 Standard 与 ACTIVE Policy,否则任何建证都会失败**(`standardId` NOT NULL + 建证要求当前 ACTIVE Policy)。首批标准的初始化包属 PR-6 范围。

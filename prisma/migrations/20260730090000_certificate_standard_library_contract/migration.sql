-- 证书标准库 PR-4b(第 67 migration,**contract**)。
-- 冻结稿 docs/archive/reviews/certificate-standard-library-t0-review.md v1.2 §20.2 / §21。
--
-- 与 PR-2(expand-only)成对:那一刀只加列与约束、零写入路径;本刀把 PR-4a 三刀
-- 已经切完的写路径留下的过渡状态收干 —— 三列转 NOT NULL + DROP 七个重复事实列。
--
-- 为什么可以直接 DROP 而不是先回填:§20.1 前置探针在 head schema 库上八项全 0
-- (Certificate 零行、招新三个 JSON 零非空行、ownerType=certificate 的 attachment 零行、
--  三个待收紧列零空值)。空库切换,不存在存量数据要迁。
-- **部署前必须在真实库重跑同一组探针**(SQL 见 docs/ops/certificate-standard-library-go-live.md);
-- 任一非 0 即停,不 drop、不猜 Standard、不批量回填。
--
-- ⚠️ 本文件由只读 `prisma migrate diff --from-migrations --to-schema-datamodel` 生成骨架,
-- 随后做了两处人工处理(与 PR-2 同):
--   ① 剥掉两条与本刀无关的 RenameIndex(notification_outbox_intents /
--      storage_object_operations 的长索引名漂移;它们是历史遗留,不该搭本刀的车);
--   ② 追加下方的来源 CHECK —— Prisma DSL 表达不了 CHECK 约束。

-- ===== ① Certificate:DROP 四个重复事实列 + 三列转 NOT NULL =====
--
-- certTypeCode / certSubTypeCode  类别与等级由 standardId 唯一决定(§6 数据权威表:
--                                 权威是 CertificateStandard,实例侧副本明令禁止)。
--                                 留着就是「按 category 猜 Standard」的现成入口。
-- isInternal                      本会颁发与否是标准的性质,权威在 CertificateStandard.isInternal。
-- imageKeys                       证据改读 sourceClaim.imageKeys(§13.5),blob 单一属主是 Claim。

-- DropIndex
DROP INDEX "Certificate_certTypeCode_idx";

-- AlterTable
ALTER TABLE "Certificate" DROP COLUMN "certSubTypeCode",
DROP COLUMN "certTypeCode",
DROP COLUMN "imageKeys",
DROP COLUMN "isInternal",
ALTER COLUMN "recognitionPolicyId" SET NOT NULL,
ALTER COLUMN "sourceCode" SET NOT NULL,
ALTER COLUMN "standardId" SET NOT NULL;

-- ===== ② RecruitmentApplication:DROP 三个证书 JSON 列 =====
--
-- 「按类别一格」时代的产物 —— 结构上表达不了同类别多张证书,也做不到单证重传与
-- 单证审核。取代者是 RecruitmentCertificateClaim(一证一行)。PR-4a-2 已停写。

-- AlterTable
ALTER TABLE "recruitment_applications" DROP COLUMN "certificateImages",
DROP COLUMN "certificateIssuanceInfo",
DROP COLUMN "certificateReviewStatus";

-- ===== ③ 来源 CHECK(§5.6 倒数第 4 条;Prisma DSL 表达不了)=====
--
-- sourceCode=RECRUITMENT → sourceClaimId 必须非空(发号来的证必须能指回它的申报);
-- sourceCode=ADMIN       → sourceClaimId 必须为空(管理端直接录入的证没有申报)。
--
-- 为什么要有它:sourceCode 是个可被随手写错的枚举,而「RECRUITMENT 却没有 sourceClaimId」
-- 的行会让 §13.5 的证据读取无处取 key —— 那是一张永远读不出证据的证书,
-- 且只有在有人点开它时才会发现。DB 层把这种行挡在写入之外。
ALTER TABLE "Certificate"
  ADD CONSTRAINT "certificate_source_claim_consistency_check"
  CHECK (
    ("sourceCode" = 'RECRUITMENT' AND "sourceClaimId" IS NOT NULL)
    OR ("sourceCode" = 'ADMIN' AND "sourceClaimId" IS NULL)
  );

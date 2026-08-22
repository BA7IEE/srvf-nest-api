-- P2-14 刀 A:活动封面 / 图集改附件制 —— expand 阶段
--
-- 维护者 2026-08-22 拍板:「按你建议:改成和内容模块一样」。
--
-- 本刀是 expand→contract 的 **expand 段**:只加列,一个 DROP / RENAME / ALTER COLUMN 都不做。
-- 旧的裸 URL 列 `coverImageUrl` / `galleryImageUrls` **原样保留**(刀 B 才删),
-- 但它们此刻已零写入路径 —— 可写 DTO 上的对应字段在同 PR 内拆除。
--
-- 修的缺陷:`Activity.coverImageUrl` 只有 `@IsString() @MaxLength(512)` 把关,
-- 即「任何字符串都能当封面」⇒ ①能填任意外站地址,外站换图/删图后封面变裂图或变成别的内容
-- ②图不在本仓存储里,备份 / 迁移 / 清理 / 配额全都管不到 ③也可能填站内签名链接,
-- 而签名链接会过期 ⇒ 封面一张一张慢慢坏掉且无告警 ④无访问控制,谁拿到 URL 谁能看、永不失效。
--
-- 新形状与 `Content.coverImageKey` / `Content.coverAttachmentId` **逐字同形**,
-- 校验与读签一律复用内容模块那一套(不另写一份 —— 两份对「什么算合法封面」的理解会各自漂移,
-- 而漂移时没有症状)。
--
-- 存量:本机四个库(app_test / app / app_membersv2_dev / app_migration_dev)实测
-- `coverImageUrl` 与 `galleryImageUrls` 非空计数均为 0;项目尚未上线,无生产库。
-- 故本刀零回填、零数据搬运、零既有行重解释。
--
-- 附件类型 `activity`(ownerTable='activity',10MB,jpeg/png/webp)#1138 已 seed,本刀不新增。

-- AlterTable
-- 反范式 storage key(列表缩略图直签,免 per-row Attachment 查询)+ 附件 id(标记 / 换 / 清)。
-- **刻意不建外键**:沿 `Content.coverAttachmentId` 的「不建外键」与 reviewedByUserId /
-- SmsSettings.updatedBy 的仓内惯例。附件被删后 id 悬空,由 resolveSignedUrlTrusted(key)
-- 返回 null 兜底 —— 与内容模块行为逐字一致。
--
-- 四列均带 DEFAULT ⇒ 既有行由 PG 在 ADD COLUMN 时直接填入默认值(实测:两个数组列
-- 在既有行上得到 `{}` 而非 NULL),不需要单独的 UPDATE 回填。
ALTER TABLE "Activity" ADD COLUMN     "coverAttachmentId" TEXT,
ADD COLUMN     "coverImageKey" TEXT,
ADD COLUMN     "galleryAttachmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "galleryImageKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- 图集两列必须**逐位对齐**:galleryImageKeys[i] 是 galleryAttachmentIds[i] 的 storage key。
-- 执行位放在 DB 而不是应用层约定 —— 应用层约定漂移时没有症状。
--
-- ⚠️ 守卫 `IS NOT NULL` 必须**前置**,不能写成朴素的 `cardinality(a) = cardinality(b)`:
-- Prisma 的 `String[]` 在 PG 侧落成**可空**列(与 contents.tags / visibleOrganizationIds 同形,
-- information_schema 实测 is_nullable=YES),而 SQL 的 CHECK 在表达式求值为 NULL 时**判通过**。
-- 双向变异实测(scratch 库):朴素式下 `(NULL, ARRAY['x'])` 这一行**静默入库**;
-- 换成守卫前置式后同一行被 23514 拒,长度不等的行被拒,合法行照常放行(正对照)。
-- AND 是 FALSE-主导 ⇒ 守卫前置后整式塌成 FALSE 而不是 NULL,结构免疫。
-- 这与本仓 §3.23.6 `recognized = credited + cappedOut` 是同一类缺陷,处置手法照抄。
ALTER TABLE "Activity" ADD CONSTRAINT "activity_gallery_arrays_aligned_check" CHECK (
  "galleryImageKeys" IS NOT NULL
  AND "galleryAttachmentIds" IS NOT NULL
  AND cardinality("galleryImageKeys") = cardinality("galleryAttachmentIds")
);

-- Activity OS Release 1 / A2：TemplateFamily 稳定身份 + ActivityTemplate Version 元数据扩展。
--
-- 纯 expand-only：新增一张空表，并向既有 ActivityTemplate 增加六个可空列。
-- 六个新增 Version 元数据列零 DEFAULT / 零回填 / 零 seed / 零删数 / 零 DROP / RENAME / ALTER COLUMN；
-- 所有既有模板行继续按 legacy (code, version) 可读，family 与新元数据保持 NULL。
-- 本 migration 不改运行时解析、API、DTO、权限或活动选定版本。
--
-- A3 才定义 canonical JSON、hash 生成、有效期边界及 Family / Version 生命周期。
-- 因而这里刻意不加 CHECK、trigger 或定义内容约束；这不是放宽，而是避免凭空冻结
-- 尚未拍板的语义。owner 与 family 引用的存在性则由 Restrict FK 在 DB 层守住。

-- CreateTable
CREATE TABLE "ActivityTemplateFamily" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "ownerOrganizationId" TEXT,
    "scopeTypeCode" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,

    CONSTRAINT "ActivityTemplateFamily_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ActivityTemplate"
ADD COLUMN     "familyId" TEXT,
ADD COLUMN     "schemaVersion" INTEGER,
ADD COLUMN     "definitionJson" JSONB,
ADD COLUMN     "definitionHash" TEXT,
ADD COLUMN     "effectiveFrom" TIMESTAMP(3),
ADD COLUMN     "effectiveTo" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "ActivityTemplateFamily_code_key" ON "ActivityTemplateFamily"("code");

-- Family 的分类、组织归属、范围与状态都只是稳定身份查询维度，不代表 A2 已定义生命周期。
CREATE INDEX "ActivityTemplateFamily_ownerOrganizationId_idx" ON "ActivityTemplateFamily"("ownerOrganizationId");
CREATE INDEX "ActivityTemplateFamily_categoryCode_idx" ON "ActivityTemplateFamily"("categoryCode");
CREATE INDEX "ActivityTemplateFamily_scopeTypeCode_idx" ON "ActivityTemplateFamily"("scopeTypeCode");
CREATE INDEX "ActivityTemplateFamily_statusCode_idx" ON "ActivityTemplateFamily"("statusCode");

-- 一条 Version 最多属于一个 Family；同 Family 内 version 号不可重，NULL family 的 legacy
-- 行不受此唯一索引影响，继续由既有 (code, version) 约束保护。
CREATE UNIQUE INDEX "ActivityTemplate_familyId_version_key" ON "ActivityTemplate"("familyId", "version");
CREATE INDEX "ActivityTemplate_familyId_idx" ON "ActivityTemplate"("familyId");

-- AddForeignKey
ALTER TABLE "ActivityTemplateFamily" ADD CONSTRAINT "ActivityTemplateFamily_ownerOrganizationId_fkey" FOREIGN KEY ("ownerOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityTemplate" ADD CONSTRAINT "ActivityTemplate_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "ActivityTemplateFamily"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

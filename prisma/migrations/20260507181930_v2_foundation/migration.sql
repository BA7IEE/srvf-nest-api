/*
  Warnings:

  - A unique constraint covering the columns `[memberId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "DictTypeStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DictItemStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "memberId" TEXT;

-- CreateTable
CREATE TABLE "DictType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "DictTypeStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DictType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DictItem" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "DictItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DictItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "nodeTypeCode" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "memberNo" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "gradeCode" TEXT,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberDepartment" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MemberDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DictType_code_key" ON "DictType"("code");

-- CreateIndex
CREATE INDEX "DictType_status_idx" ON "DictType"("status");

-- CreateIndex
CREATE INDEX "DictType_deletedAt_idx" ON "DictType"("deletedAt");

-- CreateIndex
CREATE INDEX "DictType_createdAt_idx" ON "DictType"("createdAt");

-- CreateIndex
CREATE INDEX "DictItem_typeId_idx" ON "DictItem"("typeId");

-- CreateIndex
CREATE INDEX "DictItem_parentId_idx" ON "DictItem"("parentId");

-- CreateIndex
CREATE INDEX "DictItem_status_idx" ON "DictItem"("status");

-- CreateIndex
CREATE INDEX "DictItem_deletedAt_idx" ON "DictItem"("deletedAt");

-- CreateIndex
CREATE INDEX "DictItem_createdAt_idx" ON "DictItem"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DictItem_typeId_code_key" ON "DictItem"("typeId", "code");

-- CreateIndex
CREATE INDEX "Organization_parentId_idx" ON "Organization"("parentId");

-- CreateIndex
CREATE INDEX "Organization_nodeTypeCode_idx" ON "Organization"("nodeTypeCode");

-- CreateIndex
CREATE INDEX "Organization_status_idx" ON "Organization"("status");

-- CreateIndex
CREATE INDEX "Organization_deletedAt_idx" ON "Organization"("deletedAt");

-- CreateIndex
CREATE INDEX "Organization_createdAt_idx" ON "Organization"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Member_memberNo_key" ON "Member"("memberNo");

-- CreateIndex
CREATE INDEX "Member_gradeCode_idx" ON "Member"("gradeCode");

-- CreateIndex
CREATE INDEX "Member_status_idx" ON "Member"("status");

-- CreateIndex
CREATE INDEX "Member_deletedAt_idx" ON "Member"("deletedAt");

-- CreateIndex
CREATE INDEX "Member_createdAt_idx" ON "Member"("createdAt");

-- CreateIndex
CREATE INDEX "MemberDepartment_memberId_idx" ON "MemberDepartment"("memberId");

-- CreateIndex
CREATE INDEX "MemberDepartment_organizationId_idx" ON "MemberDepartment"("organizationId");

-- CreateIndex
CREATE INDEX "MemberDepartment_deletedAt_idx" ON "MemberDepartment"("deletedAt");

-- CreateIndex
CREATE INDEX "MemberDepartment_createdAt_idx" ON "MemberDepartment"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_memberId_key" ON "User"("memberId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DictItem" ADD CONSTRAINT "DictItem_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "DictType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DictItem" ADD CONSTRAINT "DictItem_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DictItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberDepartment" ADD CONSTRAINT "MemberDepartment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberDepartment" ADD CONSTRAINT "MemberDepartment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 手动追加: MemberDepartment 单归属 partial unique index (决策点 D-1)
-- ----------------------------------------------------------------------------
-- 一人一部门 = 同一 memberId 在 deletedAt IS NULL 范围内最多 1 条 active 归属;
-- 软删后(deletedAt 非空)允许重新归属。
--
-- Prisma DSL 至 6.x 不支持在 @@unique 中表达 WHERE 子句的部分唯一约束,故
-- schema.prisma 中仅声明普通 @@index([memberId]),由本 migration 末尾手动
-- 追加 partial unique index 落地业务约束。
--
-- 详见 docs/v2-data-model.md §6.3 / docs/v2-plan.md §2.1 决策点 D-1。
-- ============================================================================
CREATE UNIQUE INDEX "MemberDepartment_memberId_active_key"
    ON "MemberDepartment"("memberId")
    WHERE "deletedAt" IS NULL;

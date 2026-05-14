/*
  Warnings:

  - You are about to drop the column `attachmentKey` on the `Certificate` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "AttachmentAccessLevel" AS ENUM ('PUBLIC', 'INTERNAL', 'SENSITIVE');

-- CreateEnum
CREATE TYPE "AttachmentTypeConfigStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "AttachmentMimeConfigStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "Certificate" DROP COLUMN "attachmentKey";

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "key" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "checksum" TEXT,
    "etag" TEXT,
    "description" TEXT,
    "accessLevel" "AttachmentAccessLevel",
    "tags" TEXT[],
    "originalUploaderName" TEXT,
    "expireAt" TIMESTAMP(3),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment_type_configs" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "ownerTable" TEXT NOT NULL,
    "defaultMaxSizeBytes" INTEGER,
    "defaultMimeWhitelist" TEXT[],
    "status" "AttachmentTypeConfigStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "attachment_type_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment_mime_configs" (
    "id" TEXT NOT NULL,
    "typeConfigId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "status" "AttachmentMimeConfigStatus" NOT NULL DEFAULT 'ACTIVE',
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "attachment_mime_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment_size_limit_configs" (
    "id" TEXT NOT NULL,
    "typeConfigId" TEXT NOT NULL,
    "maxSizeBytes" INTEGER NOT NULL,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "attachment_size_limit_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attachments_ownerType_ownerId_idx" ON "attachments"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "attachments_uploadedBy_idx" ON "attachments"("uploadedBy");

-- CreateIndex
CREATE INDEX "attachments_mime_idx" ON "attachments"("mime");

-- CreateIndex
CREATE INDEX "attachments_createdAt_idx" ON "attachments"("createdAt");

-- CreateIndex
CREATE INDEX "attachments_accessLevel_idx" ON "attachments"("accessLevel");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_type_configs_code_key" ON "attachment_type_configs"("code");

-- CreateIndex
CREATE INDEX "attachment_type_configs_status_idx" ON "attachment_type_configs"("status");

-- CreateIndex
CREATE INDEX "attachment_type_configs_deletedAt_idx" ON "attachment_type_configs"("deletedAt");

-- CreateIndex
CREATE INDEX "attachment_mime_configs_typeConfigId_idx" ON "attachment_mime_configs"("typeConfigId");

-- CreateIndex
CREATE INDEX "attachment_mime_configs_status_idx" ON "attachment_mime_configs"("status");

-- CreateIndex
CREATE INDEX "attachment_mime_configs_deletedAt_idx" ON "attachment_mime_configs"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_mime_configs_typeConfigId_mime_key" ON "attachment_mime_configs"("typeConfigId", "mime");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_size_limit_configs_typeConfigId_key" ON "attachment_size_limit_configs"("typeConfigId");

-- CreateIndex
CREATE INDEX "attachment_size_limit_configs_deletedAt_idx" ON "attachment_size_limit_configs"("deletedAt");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_mime_configs" ADD CONSTRAINT "attachment_mime_configs_typeConfigId_fkey" FOREIGN KEY ("typeConfigId") REFERENCES "attachment_type_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_size_limit_configs" ADD CONSTRAINT "attachment_size_limit_configs_typeConfigId_fkey" FOREIGN KEY ("typeConfigId") REFERENCES "attachment_type_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

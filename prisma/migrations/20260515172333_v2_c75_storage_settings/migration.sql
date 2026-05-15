-- CreateEnum
CREATE TYPE "StorageProviderType" AS ENUM ('LOCAL', 'COS');

-- CreateEnum
CREATE TYPE "StorageMimePolicyMode" AS ENUM ('INHERIT', 'OVERRIDE');

-- CreateTable
CREATE TABLE "storage_settings" (
    "id" TEXT NOT NULL,
    "providerType" "StorageProviderType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "bucket" TEXT,
    "region" TEXT,
    "envPrefix" TEXT,
    "uploadUrlTtlSeconds" INTEGER NOT NULL DEFAULT 600,
    "downloadUrlTtlSeconds" INTEGER NOT NULL DEFAULT 300,
    "lifecycleDays" INTEGER NOT NULL DEFAULT 30,
    "enableSignedUrl" BOOLEAN NOT NULL DEFAULT true,
    "enableVersioning" BOOLEAN NOT NULL DEFAULT true,
    "corsAllowedOrigins" JSONB,
    "maxObjectSizeBytes" BIGINT,
    "allowedMimePolicyMode" "StorageMimePolicyMode" NOT NULL DEFAULT 'INHERIT',
    "secretIdEncrypted" TEXT,
    "secretKeyEncrypted" TEXT,
    "credentialConfigured" BOOLEAN NOT NULL DEFAULT false,
    "remarks" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_settings_pkey" PRIMARY KEY ("id")
);

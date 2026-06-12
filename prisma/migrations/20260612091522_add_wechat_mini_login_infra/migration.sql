/*
  Warnings:

  - A unique constraint covering the columns `[openid]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "SmsPurpose" ADD VALUE 'WECHAT_BIND';

-- CreateEnum
CREATE TYPE "WechatProviderType" AS ENUM ('DEV_STUB', 'WECHAT');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "openid" TEXT;

-- CreateTable
CREATE TABLE "wechat_settings" (
    "id" TEXT NOT NULL,
    "providerType" "WechatProviderType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "appId" TEXT,
    "appSecretEncrypted" TEXT,
    "credentialConfigured" BOOLEAN NOT NULL DEFAULT false,
    "remarks" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wechat_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_openid_key" ON "User"("openid");

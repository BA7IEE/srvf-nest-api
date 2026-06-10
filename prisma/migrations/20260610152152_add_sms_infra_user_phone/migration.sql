/*
  Warnings:

  - A unique constraint covering the columns `[phone]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "SmsProviderType" AS ENUM ('DEV_STUB', 'TENCENT_SMS');

-- CreateEnum
CREATE TYPE "SmsPurpose" AS ENUM ('PHONE_BIND');

-- CreateEnum
CREATE TYPE "SmsSendStatus" AS ENUM ('SENT', 'FAILED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "sms_settings" (
    "id" TEXT NOT NULL,
    "providerType" "SmsProviderType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sdkAppId" TEXT,
    "signName" TEXT,
    "region" TEXT,
    "templateIdVerifyCode" TEXT,
    "secretIdEncrypted" TEXT,
    "secretKeyEncrypted" TEXT,
    "credentialConfigured" BOOLEAN NOT NULL DEFAULT false,
    "remarks" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_verification_codes" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" "SmsPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_verification_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_send_logs" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "providerType" "SmsProviderType" NOT NULL,
    "status" "SmsSendStatus" NOT NULL,
    "providerMsgId" TEXT,
    "errCode" TEXT,
    "errMsg" TEXT,
    "codeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_send_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sms_verification_codes_phone_purpose_idx" ON "sms_verification_codes"("phone", "purpose");

-- CreateIndex
CREATE INDEX "sms_send_logs_phone_createdAt_idx" ON "sms_send_logs"("phone", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

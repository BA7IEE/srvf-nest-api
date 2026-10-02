import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

const WINDOW_SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
  deploymentDigest: true,
  configDigest: true,
  signedMappingVersion: true,
  registrationReceipt: { select: { id: true, manifestHash: true } },
} as const;

@Injectable()
export class ContributionShadowEvidenceQueryService {
  constructor(private readonly auditLogs: AuditLogsService) {}

  findWindow(tx: Prisma.TransactionClient, windowId: string) {
    return tx.contributionShadowObservationWindow.findUnique({
      where: { id: windowId },
      select: WINDOW_SELECT,
    });
  }

  async windows(tx: Prisma.TransactionClient, skip: number, take: number) {
    const items = await tx.contributionShadowObservationWindow.findMany({
      select: WINDOW_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
    });
    const total = await tx.contributionShadowObservationWindow.count();
    return { items, total };
  }

  candidates(
    tx: Prisma.TransactionClient,
    windowId: string,
    skip: number,
    take: number,
    auditLogId: string | null = null,
  ) {
    return this.auditLogs.readShadowReconciliationPageInTx(tx, windowId, skip, take, auditLogId);
  }

  async summary(tx: Prisma.TransactionClient, windowId: string) {
    return this.auditLogs.summarizeShadowReconciliationInTx(tx, windowId);
  }

  findAttempt(tx: Prisma.TransactionClient, windowId: string, attemptId: string) {
    return tx.contributionShadowAttemptReceipt.findFirst({
      where: { id: attemptId, windowId },
      select: { id: true },
    });
  }

  async comparisons(tx: Prisma.TransactionClient, attemptId: string, skip: number, take: number) {
    const where = { attemptId };
    const items = await tx.contributionShadowComparisonReceipt.findMany({
      where,
      skip,
      take,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        attemptId: true,
        recordId: true,
        memberId: true,
        classificationCode: true,
        comparable: true,
        factHash: true,
        legacySourceHash: true,
        policySourceHash: true,
        legacyPoints: true,
        policyPoints: true,
        durationSeconds: true,
        failureCode: true,
        hashAlgorithmCode: true,
        canonicalVersion: true,
        createdAt: true,
      },
    });
    const total = await tx.contributionShadowComparisonReceipt.count({ where });
    return { items, total };
  }
}

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  contributionPolicyHash,
  contributionPolicyText,
} from './activity-contribution-policy-command';
import { parseShadowMappingRegistrationManifest } from './activity-contribution-shadow-mapping-registration.service';

/** Activity-owned reads only. The caller retains its transaction, locks and access checks. */
@Injectable()
export class ActivityContributionShadowMappingProofQuery {
  /** Actual same-activity positions only; absence is not inferred from names. */
  async readComparisonPositions(
    tx: Prisma.TransactionClient,
    input: { activityId: string; positionIds: readonly string[] },
  ) {
    const activityId = contributionPolicyText(input.activityId, 128);
    const ids = [...new Set(input.positionIds.map((id) => contributionPolicyText(id, 128)))].sort();
    if (ids.length === 0) return [];
    return tx.activitySessionPosition.findMany({
      where: {
        activityId,
        id: { in: ids },
        deletedAt: null,
        session: { activityId, deletedAt: null },
      },
      select: {
        id: true,
        activityId: true,
        sessionId: true,
        attendanceRoleCode: true,
        session: { select: { id: true, activityId: true } },
      },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * Complete same-activity event history as of the source instant. Do not filter
   * mappingVersion here: a later-version revoke/replace may target an old approval.
   */
  async readComparisonMappingHistory(
    tx: Prisma.TransactionClient,
    input: { activityId: string; sourceTime: Date },
  ) {
    const activityId = contributionPolicyText(input.activityId, 128);
    if (!(input.sourceTime instanceof Date) || !Number.isFinite(input.sourceTime.getTime()))
      throw new TypeError('Invalid shadow source instant');
    return tx.contributionShadowMappingApproval.findMany({
      where: {
        activityId,
        approvedAt: { lte: input.sourceTime },
        effectiveFrom: { lte: input.sourceTime },
      },
      orderBy: [{ approvedAt: 'asc' }, { approvalNumber: 'asc' }],
    });
  }

  /** Historical selection only; no current-pointer fallback or comparability decision. */
  async readSelectionAtSource(
    tx: Prisma.TransactionClient,
    input: { activityId: string; sourceTime: Date },
  ) {
    const activityId = contributionPolicyText(input.activityId, 128);
    if (!(input.sourceTime instanceof Date) || !Number.isFinite(input.sourceTime.getTime()))
      throw new TypeError('Invalid shadow source instant');
    return tx.activityContributionPolicySelectionRevision.findFirst({
      where: { activityId, createdAt: { lte: input.sourceTime } },
      orderBy: { revision: 'desc' },
      select: {
        id: true,
        activityId: true,
        revision: true,
        schemaVersion: true,
        selectionHash: true,
        selectionJson: true,
        itemCount: true,
        createdAt: true,
        // Keep inherit/explicit and all layers; filtering may invent a fallback.
        items: { where: { activityId }, orderBy: { id: 'asc' } },
      },
    });
  }

  /** Exact version/hash/evaluator set; missing references are not substituted. */
  async readComparisonPolicyVersions(
    tx: Prisma.TransactionClient,
    references: readonly { id: string; definitionHash: string; evaluatorVersion: number }[],
  ) {
    const unique = new Map<
      string,
      { id: string; definitionHash: string; evaluatorVersion: number }
    >();
    for (const reference of references) {
      const id = contributionPolicyText(reference.id, 128);
      const definitionHash = contributionPolicyHash(reference.definitionHash);
      if (!Number.isSafeInteger(reference.evaluatorVersion) || reference.evaluatorVersion <= 0)
        throw new TypeError('Invalid shadow evaluator version');
      const value = { id, definitionHash, evaluatorVersion: reference.evaluatorVersion };
      unique.set(JSON.stringify(value), value);
    }
    if (unique.size === 0) return [];
    return tx.contributionPolicyVersion.findMany({
      where: { OR: [...unique.values()] },
      select: {
        id: true,
        policyId: true,
        definitionHash: true,
        evaluatorVersion: true,
        schemaVersion: true,
        definitionJson: true,
        effectiveFrom: true,
        effectiveUntil: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  async readRegistrationReferences(tx: Prisma.TransactionClient, value: unknown) {
    const manifest = parseShadowMappingRegistrationManifest(value);
    const unique = <T>(values: T[]): T[] => [
      ...new Map(values.map((item) => [JSON.stringify(item), item])).values(),
    ];
    const activityIds = [...new Set(manifest.approvals.map((item) => item.activityId))].sort();
    const positions = unique(
      manifest.approvals.map((item) => ({
        id: item.sessionPositionId,
        activityId: item.activityId,
      })),
    );
    const versions = unique(
      manifest.approvals.map((item) => ({
        id: item.policyVersionId,
        definitionHash: item.policyDefinitionHash,
        evaluatorVersion: item.evaluatorVersion,
      })),
    );
    const predecessors = unique(
      manifest.approvals.flatMap((item) =>
        item.previousApprovalId === null
          ? []
          : [{ id: item.previousApprovalId, activityId: item.activityId }],
      ),
    );
    // Set reads, never a query per approval. Missing rows stay missing, not inferred from names.
    const [activities, sessionPositions, policies, previousApprovals] = await Promise.all([
      tx.activity.findMany({
        where: { id: { in: activityIds }, deletedAt: null },
        select: { id: true, activityTypeCode: true },
        orderBy: { id: 'asc' },
      }),
      tx.activitySessionPosition.findMany({
        where: { OR: positions, deletedAt: null },
        select: { id: true, activityId: true, sessionId: true, attendanceRoleCode: true },
        orderBy: { id: 'asc' },
      }),
      tx.contributionPolicyVersion.findMany({
        where: { OR: versions },
        select: {
          id: true,
          policyId: true,
          definitionHash: true,
          evaluatorVersion: true,
          schemaVersion: true,
          definitionJson: true,
          effectiveFrom: true,
          effectiveUntil: true,
        },
        orderBy: { id: 'asc' },
      }),
      predecessors.length === 0
        ? Promise.resolve([])
        : tx.contributionShadowMappingApproval.findMany({
            where: { OR: predecessors },
            orderBy: { id: 'asc' },
          }),
    ]);
    return { activities, sessionPositions, policies, previousApprovals };
  }

  /** Historical event set, NOT a decision that any mapping is approved or comparable. */
  async readMappingEvents(
    tx: Prisma.TransactionClient,
    input: { activityId: string; mappingVersion: string; sourceTime: Date },
  ) {
    const activityId = contributionPolicyText(input.activityId, 128);
    const mappingVersion = contributionPolicyText(input.mappingVersion, 128);
    if (!(input.sourceTime instanceof Date) || !Number.isFinite(input.sourceTime.getTime()))
      throw new TypeError('Invalid shadow source instant');
    // Include revoke/replace and expired events. Filtering to only active approvals
    // would erase predecessor history; the proof writer must resolve the whole set.
    return tx.contributionShadowMappingApproval.findMany({
      where: {
        activityId,
        mappingVersion,
        approvedAt: { lte: input.sourceTime },
        effectiveFrom: { lte: input.sourceTime },
      },
      orderBy: [{ approvedAt: 'asc' }, { approvalNumber: 'asc' }],
    });
  }
}

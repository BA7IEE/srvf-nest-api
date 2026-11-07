import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { ActivityPublishProposalV2Service } from './activity-publish-proposal-v2.service';
import { ActivityPublishReviewReferencedPoliciesResponseDto } from './activity-publish-review-policy.dto';
import { fingerprintTimePolicyVersion } from './activity-time-policy-definition';
import { fingerprintContributionPolicyVersion } from './activity-contribution-policy-definition';
import type { ActivityPublishProposalV8TimePolicyPointers } from './activity-publish-proposal-v8';
import type { ActivityPublishProposalV9ContributionPolicyPointers } from './activity-publish-proposal-v9';

const versionSelect = {
  id: true,
  policyId: true,
  version: true,
  schemaVersion: true,
  evaluatorVersion: true,
  definitionJson: true,
  definitionHash: true,
  effectiveFrom: true,
  effectiveUntil: true,
  statusCode: true,
} satisfies Prisma.TimePolicyVersionSelect & Prisma.ContributionPolicyVersionSelect;

type VersionRow = Prisma.TimePolicyVersionGetPayload<{ select: typeof versionSelect }>;
type Pointer = {
  policyId: string;
  versionId: string;
  definitionHash: string;
  evaluatorVersion?: number;
};
type Fingerprint<T> = {
  schemaVersion: number;
  evaluatorVersion: number;
  definitionHash: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  definition: T;
};

function invalid(): never {
  throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
}

function references<T extends Pointer>(
  roots: readonly ({
    selection: {
      items: Readonly<Record<string, { selection: { mode: string; pointer: T | null } }>>;
    };
    resolved: readonly { pointer: T }[];
  } | null)[],
): T[] {
  const byId = new Map<string, T>();
  for (const root of roots) {
    if (root === null) continue;
    const selected = Object.values(root.selection.items).flatMap((item) =>
      item.selection.mode === 'explicit' && item.selection.pointer !== null
        ? [item.selection.pointer]
        : [],
    );
    for (const pointer of [...selected, ...root.resolved.map((item) => item.pointer)]) {
      const previous = byId.get(pointer.versionId);
      if (
        previous &&
        (previous.policyId !== pointer.policyId ||
          previous.definitionHash !== pointer.definitionHash ||
          previous.evaluatorVersion !== pointer.evaluatorVersion)
      )
        invalid();
      byId.set(pointer.versionId, pointer);
    }
  }
  return [...byId.values()].sort((left, right) => left.versionId.localeCompare(right.versionId));
}

function versionDetails<T>(
  row: VersionRow | undefined,
  pointer: Pointer,
  fingerprint: (input: unknown) => Fingerprint<T>,
) {
  if (
    !row ||
    row.policyId !== pointer.policyId ||
    row.definitionHash !== pointer.definitionHash ||
    (pointer.evaluatorVersion !== undefined && row.evaluatorVersion !== pointer.evaluatorVersion) ||
    (row.statusCode !== 'active' && row.statusCode !== 'retired')
  )
    invalid();
  let checked: Fingerprint<T>;
  try {
    checked = fingerprint({
      schemaVersion: row.schemaVersion,
      evaluatorVersion: row.evaluatorVersion,
      definition: row.definitionJson,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveUntil: row.effectiveUntil?.toISOString() ?? null,
    });
  } catch (error) {
    if (error instanceof TypeError) invalid();
    throw error;
  }
  if (checked.definitionHash !== pointer.definitionHash) invalid();
  return { policyId: row.policyId, versionId: row.id, version: row.version, ...checked };
}

function checkResolved(
  roots: readonly ({
    resolved: readonly {
      pointer: Pointer;
      effectiveFrom: string;
      effectiveUntil: string | null;
      evaluatorVersion?: number;
    }[];
  } | null)[],
  versions: readonly {
    versionId: string;
    evaluatorVersion: number;
    effectiveFrom: string;
    effectiveUntil: string | null;
  }[],
  intervalSemantics: 'target' | 'version',
) {
  for (const root of roots) {
    for (const item of root?.resolved ?? []) {
      const version = versions.find((row) => row.versionId === item.pointer.versionId);
      if (!version) invalid();
      // V8 time entries freeze the target execution interval. V9 contribution
      // entries freeze version validity. These are different existing contracts.
      const intervalMismatch =
        intervalSemantics === 'target'
          ? item.effectiveFrom < version.effectiveFrom ||
            (version.effectiveUntil !== null &&
              (item.effectiveUntil === null || item.effectiveUntil > version.effectiveUntil))
          : version.effectiveFrom !== item.effectiveFrom ||
            version.effectiveUntil !== item.effectiveUntil;
      if (
        intervalMismatch ||
        (item.evaluatorVersion !== undefined && version.evaluatorVersion !== item.evaluatorVersion)
      )
        invalid();
    }
  }
}

@Injectable()
export class ActivityPublishReviewPolicyQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly proposals: ActivityPublishProposalV2Service,
  ) {}

  async findOne(
    id: string,
    user: CurrentUserPayload,
  ): Promise<ActivityPublishReviewReferencedPoliciesResponseDto> {
    // Permission, current resource organization, frozen review and immutable version
    // rows are read from one database snapshot. No catalogue authority is borrowed.
    return this.prisma.$transaction(
      async (tx) => {
        const decision = await this.authz.explain(
          user,
          'activity-review.read.request',
          {
            type: 'activity_publish_review',
            id,
          },
          tx,
        );
        if (!decision.allow) {
          throw new BizException(
            decision.reason === 'resource_not_found'
              ? BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND
              : BizCode.RBAC_FORBIDDEN,
          );
        }
        const review = await tx.activityPublishReview.findUnique({
          where: { id },
          select: { id: true, activityId: true, baseRevision: true, snapshot: true },
        });
        if (!review) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND);
        const snapshot = this.proposals.parseSnapshot(review.snapshot);
        if (review.baseRevision !== snapshot.baseWorkflowRevision) invalid();

        const timeRoots: (ActivityPublishProposalV8TimePolicyPointers | null)[] =
          snapshot.schemaVersion === 8 || snapshot.schemaVersion === 9
            ? [snapshot.base.timePolicyPointers, snapshot.timePolicyPointers]
            : [];
        const contributionRoots: (ActivityPublishProposalV9ContributionPolicyPointers | null)[] =
          snapshot.schemaVersion === 9
            ? [snapshot.base.contributionPolicyPointers, snapshot.contributionPolicyPointers]
            : [];
        const timeRefs = references(timeRoots),
          contributionRefs = references(contributionRoots);
        const timeRows =
          timeRefs.length === 0
            ? []
            : await tx.timePolicyVersion.findMany({
                where: {
                  OR: timeRefs.map((pointer) => ({
                    id: pointer.versionId,
                    policyId: pointer.policyId,
                    definitionHash: pointer.definitionHash,
                  })),
                },
                select: versionSelect,
              });
        const contributionRows =
          contributionRefs.length === 0
            ? []
            : await tx.contributionPolicyVersion.findMany({
                where: {
                  OR: contributionRefs.map((pointer) => ({
                    id: pointer.versionId,
                    policyId: pointer.policyId,
                    definitionHash: pointer.definitionHash,
                    evaluatorVersion: pointer.evaluatorVersion,
                  })),
                },
                select: versionSelect,
              });
        const timePolicies = timeRefs.map((pointer) =>
          versionDetails(
            timeRows.find((row) => row.id === pointer.versionId),
            pointer,
            fingerprintTimePolicyVersion,
          ),
        );
        const contributionPolicies = contributionRefs.map((pointer) =>
          versionDetails(
            contributionRows.find((row) => row.id === pointer.versionId),
            pointer,
            fingerprintContributionPolicyVersion,
          ),
        );
        checkResolved(timeRoots, timePolicies, 'target');
        checkResolved(contributionRoots, contributionPolicies, 'version');
        return {
          reviewId: review.id,
          activityId: review.activityId,
          snapshotSchemaVersion: snapshot.schemaVersion,
          snapshotHash: snapshot.snapshotHash,
          timePolicies,
          contributionPolicies,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

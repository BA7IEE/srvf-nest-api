import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { normalizeDateOnly } from '../../common/datetime/date-only.util';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';

type PrismaTx = Prisma.TransactionClient;

export type InsuranceEligibilitySource =
  | {
      kind: 'member_insurance';
      memberId: string;
      memberInsuranceId: string;
      sourceRevision: number;
      sourceReviewedByUserId: string;
      sourceReviewedAt: Date;
      coverageStart: Date | null;
      coverageEnd: Date;
    }
  | {
      kind: 'team_insurance_coverage';
      memberId: string;
      teamInsuranceCoverageId: string;
      sourceRevision: null;
      sourceReviewedByUserId: null;
      sourceReviewedAt: null;
      coverageStart: Date;
      coverageEnd: Date;
    };

export interface InsuranceEligibilityDecision {
  source: InsuranceEligibilitySource;
  requiredFrom: Date;
  requiredThrough: Date;
}

interface LockedSelfInsuranceRow {
  id: string;
  memberId: string;
  coverageStart: Date | null;
  coverageEnd: Date;
  version: number;
  reviewedByUserId: string;
  reviewedAt: Date;
}

interface TeamInsuranceCandidateRow {
  policyId: string;
  coverageId: string;
}

interface LockedTeamPolicyRow {
  id: string;
  coverageStart: Date;
  coverageEnd: Date;
}

interface LockedTeamCoverageRow {
  id: string;
  memberId: string;
}

interface LockedOwnerRow {
  id: string;
  memberId: string;
}

@Injectable()
export class InsuranceRequirementService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  isEnforcementEnabled(): boolean {
    return this.config.insurance.enforcementEnabled;
  }

  private activityInterval(activity: { startAt: Date; endAt: Date }): {
    requiredFrom: Date;
    requiredThrough: Date;
  } {
    return {
      requiredFrom: normalizeDateOnly(activity.startAt.toISOString()),
      requiredThrough: normalizeDateOnly(activity.endAt.toISOString()),
    };
  }

  private async hasCompatibilitySource(
    memberId: string,
    requiredFrom: Date,
    requiredThrough: Date,
    tx: PrismaTx,
  ): Promise<boolean> {
    const selfInsurance = await tx.memberInsurance.findFirst({
      where: {
        memberId,
        deletedAt: null,
        coverageEnd: { gte: requiredThrough },
        OR: [{ coverageStart: null }, { coverageStart: { lte: requiredFrom } }],
      },
      select: { id: true },
    });
    if (selfInsurance) return true;

    const coverage = await tx.teamInsuranceCoverage.findFirst({
      where: {
        memberId,
        deletedAt: null,
        policy: {
          deletedAt: null,
          coverageStart: { lte: requiredFrom },
          coverageEnd: { gte: requiredThrough },
        },
      },
      select: { id: true },
    });
    return coverage !== null;
  }

  private async lockVerifiedSelfSource(
    memberId: string,
    requiredFrom: Date,
    requiredThrough: Date,
    tx: PrismaTx,
  ): Promise<InsuranceEligibilitySource | null> {
    const rows = await tx.$queryRaw<LockedSelfInsuranceRow[]>(Prisma.sql`
      SELECT
        "id",
        "memberId",
        "coverageStart",
        "coverageEnd",
        "version",
        "reviewedByUserId",
        "reviewedAt"
      FROM "member_insurances"
      WHERE "memberId" = ${memberId}
        AND "deletedAt" IS NULL
        AND "reviewStatusCode" = 'verified'
        AND "reviewedByUserId" IS NOT NULL
        AND "reviewedAt" IS NOT NULL
        AND "coverageEnd" >= ${requiredThrough}
        AND ("coverageStart" IS NULL OR "coverageStart" <= ${requiredFrom})
      ORDER BY
        "coverageEnd" DESC,
        "coverageStart" DESC NULLS LAST,
        "reviewedAt" DESC,
        "id" ASC
      LIMIT 1
      FOR SHARE
    `);
    const row = rows[0];
    if (!row) return null;
    return {
      kind: 'member_insurance',
      memberId: row.memberId,
      memberInsuranceId: row.id,
      sourceRevision: row.version,
      sourceReviewedByUserId: row.reviewedByUserId,
      sourceReviewedAt: row.reviewedAt,
      coverageStart: row.coverageStart,
      coverageEnd: row.coverageEnd,
    };
  }

  private async lockTeamSource(
    memberId: string,
    requiredFrom: Date,
    requiredThrough: Date,
    tx: PrismaTx,
  ): Promise<InsuranceEligibilitySource | null> {
    const candidates = await tx.$queryRaw<TeamInsuranceCandidateRow[]>(Prisma.sql`
      SELECT p."id" AS "policyId", c."id" AS "coverageId"
      FROM "team_insurance_policies" p
      INNER JOIN "team_insurance_coverages" c ON c."policyId" = p."id"
      WHERE c."memberId" = ${memberId}
        AND c."deletedAt" IS NULL
        AND p."deletedAt" IS NULL
        AND p."coverageStart" <= ${requiredFrom}
        AND p."coverageEnd" >= ${requiredThrough}
      ORDER BY
        p."coverageEnd" DESC,
        p."coverageStart" DESC NULLS LAST,
        p."id" ASC,
        c."id" ASC
    `);

    for (const candidate of candidates) {
      // Global source order is Policy -> Coverage. Revalidate after each lock so
      // a concurrent soft delete/date edit can never leave a stale snapshot.
      const policies = await tx.$queryRaw<LockedTeamPolicyRow[]>(Prisma.sql`
        SELECT "id", "coverageStart", "coverageEnd"
        FROM "team_insurance_policies"
        WHERE "id" = ${candidate.policyId}
          AND "deletedAt" IS NULL
          AND "coverageStart" <= ${requiredFrom}
          AND "coverageEnd" >= ${requiredThrough}
        FOR SHARE
      `);
      const policy = policies[0];
      if (!policy) continue;

      const coverages = await tx.$queryRaw<LockedTeamCoverageRow[]>(Prisma.sql`
        SELECT "id", "memberId"
        FROM "team_insurance_coverages"
        WHERE "id" = ${candidate.coverageId}
          AND "policyId" = ${policy.id}
          AND "memberId" = ${memberId}
          AND "deletedAt" IS NULL
        FOR SHARE
      `);
      const coverage = coverages[0];
      if (!coverage) continue;

      return {
        kind: 'team_insurance_coverage',
        memberId: coverage.memberId,
        teamInsuranceCoverageId: coverage.id,
        sourceRevision: null,
        sourceReviewedByUserId: null,
        sourceReviewedAt: null,
        coverageStart: policy.coverageStart,
        coverageEnd: policy.coverageEnd,
      };
    }
    return null;
  }

  private async lockEligibilitySource(
    memberId: string,
    requiredFrom: Date,
    requiredThrough: Date,
    tx: PrismaTx,
  ): Promise<InsuranceEligibilitySource | null> {
    return (
      (await this.lockVerifiedSelfSource(memberId, requiredFrom, requiredThrough, tx)) ??
      this.lockTeamSource(memberId, requiredFrom, requiredThrough, tx)
    );
  }

  async isMemberInsuredForActivity(
    memberId: string,
    activity: { startAt: Date; endAt: Date },
    tx?: PrismaTx,
  ): Promise<boolean> {
    const { requiredFrom, requiredThrough } = this.activityInterval(activity);
    const check = async (client: PrismaTx): Promise<boolean> => {
      if (!this.isEnforcementEnabled()) {
        return this.hasCompatibilitySource(memberId, requiredFrom, requiredThrough, client);
      }
      return (
        (await this.lockEligibilitySource(memberId, requiredFrom, requiredThrough, client)) !== null
      );
    };
    return tx ? check(tx) : this.prisma.$transaction(check);
  }

  async requireForActivityRegistration(
    memberId: string,
    activity: { requiresInsurance: boolean; startAt: Date; endAt: Date },
    tx: PrismaTx,
  ): Promise<InsuranceEligibilityDecision | null> {
    if (!activity.requiresInsurance) return null;
    const { requiredFrom, requiredThrough } = this.activityInterval(activity);
    if (!this.isEnforcementEnabled()) {
      if (!(await this.hasCompatibilitySource(memberId, requiredFrom, requiredThrough, tx))) {
        throw new BizException(BizCode.INSURANCE_REQUIRED);
      }
      return null;
    }
    const source = await this.lockEligibilitySource(memberId, requiredFrom, requiredThrough, tx);
    if (!source) throw new BizException(BizCode.INSURANCE_REQUIRED);
    return { source, requiredFrom, requiredThrough };
  }

  async requireForTeamJoin(
    memberId: string,
    now: Date,
    tx: PrismaTx,
  ): Promise<InsuranceEligibilityDecision | null> {
    if (!this.isEnforcementEnabled()) return null;
    const requiredDay = normalizeDateOnly(now.toISOString());
    const source = await this.lockEligibilitySource(memberId, requiredDay, requiredDay, tx);
    if (!source) throw new BizException(BizCode.TEAM_JOIN_INSURANCE_REQUIRED);
    return { source, requiredFrom: requiredDay, requiredThrough: requiredDay };
  }

  private evidenceSourceData(decision: InsuranceEligibilityDecision): {
    sourceKind: string;
    memberInsuranceId: string | null;
    teamInsuranceCoverageId: string | null;
    sourceRevision: number | null;
    sourceReviewedByUserId: string | null;
    sourceReviewedAt: Date | null;
    requiredFrom: Date;
    requiredThrough: Date;
    sourceCoverageStart: Date | null;
    sourceCoverageEnd: Date;
  } {
    const { source } = decision;
    return {
      sourceKind: source.kind,
      memberInsuranceId: source.kind === 'member_insurance' ? source.memberInsuranceId : null,
      teamInsuranceCoverageId:
        source.kind === 'team_insurance_coverage' ? source.teamInsuranceCoverageId : null,
      sourceRevision: source.sourceRevision,
      sourceReviewedByUserId: source.sourceReviewedByUserId,
      sourceReviewedAt: source.sourceReviewedAt,
      requiredFrom: decision.requiredFrom,
      requiredThrough: decision.requiredThrough,
      sourceCoverageStart: source.coverageStart,
      sourceCoverageEnd: source.coverageEnd,
    };
  }

  private isValidDate(value: unknown): value is Date {
    return value instanceof Date && Number.isFinite(value.getTime());
  }

  private assertEvidenceDecisionValid(
    decision: InsuranceEligibilityDecision,
    memberId: string,
    failure: BizCodeEntry,
  ): void {
    const fail = (): never => {
      throw new BizException(failure);
    };
    if (
      !this.isValidDate(decision.requiredFrom) ||
      !this.isValidDate(decision.requiredThrough) ||
      decision.requiredFrom.getTime() > decision.requiredThrough.getTime()
    ) {
      fail();
    }

    const source = decision.source;
    if (
      !source ||
      source.memberId !== memberId ||
      !this.isValidDate(source.coverageEnd) ||
      source.coverageEnd.getTime() < decision.requiredThrough.getTime() ||
      (source.coverageStart !== null &&
        (!this.isValidDate(source.coverageStart) ||
          source.coverageStart.getTime() > decision.requiredFrom.getTime()))
    ) {
      fail();
    }

    if (source.kind === 'member_insurance') {
      if (
        typeof source.memberInsuranceId !== 'string' ||
        source.memberInsuranceId.length === 0 ||
        !Number.isInteger(source.sourceRevision) ||
        source.sourceRevision < 0 ||
        typeof source.sourceReviewedByUserId !== 'string' ||
        source.sourceReviewedByUserId.length === 0 ||
        !this.isValidDate(source.sourceReviewedAt)
      ) {
        fail();
      }
      return;
    }
    if (source.kind === 'team_insurance_coverage') {
      if (
        typeof source.teamInsuranceCoverageId !== 'string' ||
        source.teamInsuranceCoverageId.length === 0 ||
        !this.isValidDate(source.coverageStart) ||
        source.sourceRevision !== null ||
        source.sourceReviewedByUserId !== null ||
        source.sourceReviewedAt !== null
      ) {
        fail();
      }
      return;
    }
    fail();
  }

  async createActivityRegistrationEvidence(
    activityRegistrationId: string,
    memberId: string,
    decision: InsuranceEligibilityDecision | null,
    tx: PrismaTx,
  ): Promise<void> {
    if (!decision) return;
    const owners = await tx.$queryRaw<LockedOwnerRow[]>(Prisma.sql`
      SELECT "id", "memberId"
      FROM "ActivityRegistration"
      WHERE "id" = ${activityRegistrationId}
        AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    const owner = owners[0];
    if (!owner || owner.memberId !== memberId || decision.source.memberId !== memberId) {
      throw new BizException(BizCode.INSURANCE_REQUIRED);
    }
    this.assertEvidenceDecisionValid(decision, memberId, BizCode.INSURANCE_REQUIRED);
    const existing = await tx.insuranceEligibilityEvidence.findFirst({
      where: { activityRegistrationId },
      select: { id: true },
    });
    if (existing) throw new BizException(BizCode.INSURANCE_REQUIRED);

    await tx.insuranceEligibilityEvidence.create({
      data: {
        ...this.evidenceSourceData(decision),
        ownerKind: 'activity_registration',
        activityRegistrationId,
        teamJoinApplicationId: null,
      },
      select: { id: true },
    });
  }

  async createTeamJoinApplicationEvidence(
    teamJoinApplicationId: string,
    memberId: string,
    decision: InsuranceEligibilityDecision | null,
    tx: PrismaTx,
  ): Promise<void> {
    if (!decision) return;
    const owners = await tx.$queryRaw<LockedOwnerRow[]>(Prisma.sql`
      SELECT "id", "memberId"
      FROM "team_join_applications"
      WHERE "id" = ${teamJoinApplicationId}
        AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    const owner = owners[0];
    if (!owner || owner.memberId !== memberId || decision.source.memberId !== memberId) {
      throw new BizException(BizCode.TEAM_JOIN_INSURANCE_REQUIRED);
    }
    this.assertEvidenceDecisionValid(decision, memberId, BizCode.TEAM_JOIN_INSURANCE_REQUIRED);
    const existing = await tx.insuranceEligibilityEvidence.findFirst({
      where: { teamJoinApplicationId },
      select: { id: true },
    });
    if (existing) throw new BizException(BizCode.TEAM_JOIN_INSURANCE_REQUIRED);

    await tx.insuranceEligibilityEvidence.create({
      data: {
        ...this.evidenceSourceData(decision),
        ownerKind: 'team_join_application',
        activityRegistrationId: null,
        teamJoinApplicationId,
      },
      select: { id: true },
    });
  }
}

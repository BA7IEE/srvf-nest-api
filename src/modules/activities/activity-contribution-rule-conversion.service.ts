import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ContributionRuleConversionSourceQuery } from '../contribution-rules/contribution-rule-conversion-source.query';
import {
  ActivityContributionPolicyCommand,
  contributionPolicyHash,
  contributionPolicyText,
} from './activity-contribution-policy-command';
import { ActivityContributionRuleConversionAuditRecorder } from './activity-contribution-rule-conversion-audit-recorder';
import {
  buildLegacyContributionCandidate,
  type LegacyContributionMapping,
} from './activity-contribution-rule-conversion';
import { getLegacyContributionMappingDecision } from './activity-contribution-rule-conversion.mapping';
import { computeActivityTemplateDefinitionHash } from './activity-template-definition';

export interface E2FixtureConversionInput {
  activityTypeCode: string;
  policyCode: string;
  policyName: string;
  effectiveFrom: string;
  mapping: LegacyContributionMapping;
  expectedSourceFingerprint: string;
}

@Injectable()
export class ActivityContributionRuleConversionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: ActivityContributionPolicyCommand,
    private readonly audit: ActivityContributionRuleConversionAuditRecorder,
    private readonly sources: ContributionRuleConversionSourceQuery,
  ) {}

  private invalid(): never {
    throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_INVALID);
  }

  private async assertFixtureDatabase(tx: Prisma.TransactionClient): Promise<void> {
    const rows = await tx.$queryRaw<{ database: string }[]>`SELECT current_database() AS database`;
    if (rows.length !== 1 || !/^app_test(?:_[a-z0-9]+)*_w98$/u.test(rows[0].database)) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private validateInput(
    input: Omit<E2FixtureConversionInput, 'expectedSourceFingerprint'> & {
      expectedSourceFingerprint?: string;
    },
  ): void {
    if (
      getLegacyContributionMappingDecision(input.activityTypeCode) === 'hold' ||
      !/^e2_fixture_[a-z0-9_]{1,48}$/u.test(input.activityTypeCode) ||
      !/^e2_fixture_[a-z0-9_]{1,48}$/u.test(input.policyCode) ||
      input.mapping.activityTypeCode !== input.activityTypeCode
    )
      this.invalid();
    contributionPolicyText(input.policyName, 120);
    if (input.expectedSourceFingerprint !== undefined)
      contributionPolicyHash(input.expectedSourceFingerprint);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.effectiveFrom) ||
      !Number.isFinite(new Date(input.effectiveFrom).getTime()) ||
      new Date(input.effectiveFrom).toISOString() !== input.effectiveFrom
    )
      this.invalid();
  }

  async dryRunFixture(
    input: Omit<E2FixtureConversionInput, 'expectedSourceFingerprint'>,
    user: CurrentUserPayload,
  ) {
    this.validateInput(input);
    return this.prisma.$transaction(async (tx) => {
      await this.assertFixtureDatabase(tx);
      await this.commands.assertAccess(tx, user, 'contribution-policy.manage.version');
      const sources = await this.sources.readActiveSources(tx, input.activityTypeCode);
      const candidate = buildLegacyContributionCandidate(sources, input.mapping);
      return {
        sourceCount: sources.length,
        sourceFingerprint: candidate.sourceFingerprint,
        definition: candidate.definition,
      };
    });
  }

  async commitFixture(input: E2FixtureConversionInput, user: CurrentUserPayload, meta: AuditMeta) {
    this.validateInput(input);
    return this.prisma.$transaction(
      async (tx) => {
        await this.assertFixtureDatabase(tx);
        await this.commands.assertAccess(tx, user, 'contribution-policy.manage.version');
        // Fixture-only capability: freeze the old source set within this short transaction.
        // A later real-data conversion needs its own lock-budget and business approval.
        await tx.$executeRaw`LOCK TABLE "ContributionRule" IN SHARE MODE`;
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "ContributionRule"
          WHERE "activityTypeCode" = ${input.activityTypeCode}
            AND "status" = 'ACTIVE' AND "deletedAt" IS NULL
          ORDER BY "id" FOR UPDATE
        `);
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${input.policyCode}, 0))::text
        `;
        const actor = await this.commands.assertAccess(
          tx,
          user,
          'contribution-policy.manage.version',
        );
        const sources = await this.sources.readActiveSources(tx, input.activityTypeCode);
        const candidate = buildLegacyContributionCandidate(sources, input.mapping);
        if (candidate.sourceFingerprint !== input.expectedSourceFingerprint) this.invalid();
        const mappingFingerprint = computeActivityTemplateDefinitionHash({
          schemaVersion: 1,
          definition: input.mapping,
        });
        const batchFingerprint = computeActivityTemplateDefinitionHash({
          schemaVersion: 1,
          definition: {
            sourceFingerprint: candidate.sourceFingerprint,
            mappingFingerprint,
            policyCode: input.policyCode,
            effectiveFrom: input.effectiveFrom,
          },
        });
        const sourceFingerprints = sources.map((source) =>
          computeActivityTemplateDefinitionHash({ schemaVersion: 1, definition: source }),
        );
        const prior = await tx.contributionRuleConversionReceipt.findMany({
          where: { sourceRuleId: { in: sources.map((source) => source.id) } },
        });
        if (prior.length > 0) {
          if (
            prior.length !== sources.length ||
            prior.some(
              (receipt) =>
                receipt.batchFingerprint !== batchFingerprint ||
                receipt.mappingFingerprint !== mappingFingerprint ||
                receipt.converterVersion !== 1 ||
                receipt.sourceFingerprint !==
                  sourceFingerprints[
                    sources.findIndex((source) => source.id === receipt.sourceRuleId)
                  ],
            )
          )
            throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_COMMAND_CONFLICT);
          const version = await tx.contributionPolicyVersion.findFirst({
            where: {
              id: prior[0].versionId,
              policyId: prior[0].policyId,
              definitionHash: prior[0].definitionHash,
              evaluatorVersion: 1,
              statusCode: 'draft',
              policy: { code: input.policyCode },
            },
          });
          if (
            !version ||
            prior.some(
              (receipt) =>
                receipt.policyId !== version.policyId ||
                receipt.versionId !== version.id ||
                receipt.definitionHash !== version.definitionHash,
            )
          )
            throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID);
          return { policyId: version.policyId, versionId: version.id, replayed: true };
        }
        const { policy, draft } = await this.commands.createDraftCandidateInTx(tx, actor, {
          code: input.policyCode,
          name: input.policyName,
          definition: candidate.definition,
          effectiveFrom: input.effectiveFrom,
        });
        await tx.contributionRuleConversionReceipt.createMany({
          data: sources.map((source, index) => ({
            sourceRuleId: source.id,
            sourceFingerprint: sourceFingerprints[index],
            converterVersion: 1,
            mappingFingerprint,
            batchFingerprint,
            sourceSnapshotJson: source as unknown as Prisma.InputJsonValue,
            actorUserId: actor.id,
            policyId: policy.id,
            versionId: draft.id,
            definitionHash: draft.definitionHash,
            evaluatorVersion: 1,
          })),
        });
        await this.audit.log(tx, actor, meta, {
          policyId: policy.id,
          versionId: draft.id,
          batchFingerprint,
          sourceCount: sources.length,
        });
        return { policyId: policy.id, versionId: draft.id, replayed: false };
      },
      { timeout: 5_000 },
    );
  }
}

import type { ContributionPolicy, ContributionPolicyVersion } from '@prisma/client';
import { fingerprintContributionPolicyVersion } from './activity-contribution-policy-definition';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

export function contributionPolicyVersionDocument(row: ContributionPolicyVersion) {
  try {
    const document = fingerprintContributionPolicyVersion({
      schemaVersion: row.schemaVersion,
      evaluatorVersion: row.evaluatorVersion,
      definition: row.definitionJson,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveUntil: row.effectiveUntil?.toISOString() ?? null,
    });
    if (document.definitionHash !== row.definitionHash)
      throw new TypeError('Invalid stored policy hash');
    return document;
  } catch (error) {
    if (error instanceof TypeError)
      throw new BizException(BizCode.ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID);
    throw error;
  }
}

export function presentContributionPolicy(row: ContributionPolicy) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function presentContributionPolicyVersionSummary(
  row: Omit<ContributionPolicyVersion, 'definitionJson'>,
) {
  return {
    id: row.id,
    policyId: row.policyId,
    version: row.version,
    schemaVersion: row.schemaVersion,
    evaluatorVersion: row.evaluatorVersion,
    definitionHash: row.definitionHash,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveUntil: row.effectiveUntil?.toISOString() ?? null,
    statusCode: row.statusCode,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function presentContributionPolicyVersion(row: ContributionPolicyVersion) {
  return {
    ...presentContributionPolicyVersionSummary(row),
    definition: contributionPolicyVersionDocument(row).definition,
  };
}

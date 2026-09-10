import type { TimePolicy, TimePolicyVersion } from '@prisma/client';
import { fingerprintTimePolicyVersion } from './activity-time-policy-definition';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

export function timePolicyVersionDocument(row: TimePolicyVersion) {
  try {
    const document = fingerprintTimePolicyVersion({
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
      throw new BizException(BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID);
    throw error;
  }
}

export function presentTimePolicy(row: TimePolicy) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function presentTimePolicyVersionSummary(row: Omit<TimePolicyVersion, 'definitionJson'>) {
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

export function presentTimePolicyVersion(row: TimePolicyVersion) {
  return {
    ...presentTimePolicyVersionSummary(row),
    definition: timePolicyVersionDocument(row).definition,
  };
}

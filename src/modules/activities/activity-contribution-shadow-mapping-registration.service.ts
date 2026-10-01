import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuthHumanCommandIdentityService } from '../auth/auth-human-command-identity.service';
import { RbacService } from '../permissions/rbac.service';
import type { AuditLogEvent } from '../audit-logs/audit-logs.types';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import {
  contributionPolicyHash,
  contributionPolicyObject,
  contributionPolicyText,
} from './activity-contribution-policy-command';
import { CONTRIBUTION_TIME_CATEGORY_CODES } from './activity-contribution-policy-definition';
import { computeActivityTemplateDefinitionHash } from './activity-template-definition';

// SQL csm_register_mapping_fn is the emitter. The integration regression binds
// this typed contract witness to the actual durable audit, not a second log call.
export const SHADOW_MAPPING_REGISTRATION_AUDIT_EVENT: AuditLogEvent =
  'activity.contribution-shadow.mapping-register';

export interface ShadowMappingApprovalManifestItem {
  approvalNumber: string;
  mappingVersion: string;
  activityId: string;
  activityTypeCode: string;
  attendanceRoleCode: string;
  sessionPositionId: string;
  policyRoleCode: string;
  categoryCode: (typeof CONTRIBUTION_TIME_CATEGORY_CODES)[number];
  policyVersionId: string;
  policyDefinitionHash: string;
  evaluatorVersion: 1;
  durationSourceCode: 'legacy_stored_hours_2';
  effectiveFrom: string;
  effectiveUntil: string | null;
  eventKindCode: 'approve' | 'revoke' | 'replace';
  previousApprovalId: string | null;
}

export interface ShadowMappingRegistrationManifest {
  schemaVersion: 1;
  commandKey: string;
  approvalReference: string;
  approvals: ShadowMappingApprovalManifestItem[];
}

function instant(value: unknown): string {
  const text = contributionPolicyText(value, 24);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text)
    throw new TypeError('Invalid mapping effective instant');
  return text;
}

/** Parsing is NOT approval verification. It cannot confer authority or write evidence. */
export function parseShadowMappingRegistrationManifest(
  value: unknown,
): ShadowMappingRegistrationManifest {
  const root = contributionPolicyObject(value, [
    'schemaVersion',
    'commandKey',
    'approvalReference',
    'approvals',
  ]);
  if (root.schemaVersion !== 1 || !Array.isArray(root.approvals) || root.approvals.length === 0)
    throw new TypeError('Invalid mapping registration manifest');
  const approvalNumbers = new Set<string>();
  const approvals = root.approvals.map((value): ShadowMappingApprovalManifestItem => {
    const item = contributionPolicyObject(value, [
      'approvalNumber',
      'mappingVersion',
      'activityId',
      'activityTypeCode',
      'attendanceRoleCode',
      'sessionPositionId',
      'policyRoleCode',
      'categoryCode',
      'policyVersionId',
      'policyDefinitionHash',
      'evaluatorVersion',
      'durationSourceCode',
      'effectiveFrom',
      'effectiveUntil',
      'eventKindCode',
      'previousApprovalId',
    ]);
    const approvalNumber = contributionPolicyText(item.approvalNumber, 128);
    if (approvalNumbers.has(approvalNumber))
      throw new TypeError('Duplicate mapping approval number');
    approvalNumbers.add(approvalNumber);
    if (
      item.evaluatorVersion !== 1 ||
      item.durationSourceCode !== 'legacy_stored_hours_2' ||
      !CONTRIBUTION_TIME_CATEGORY_CODES.includes(
        item.categoryCode as ShadowMappingApprovalManifestItem['categoryCode'],
      ) ||
      typeof item.eventKindCode !== 'string' ||
      !['approve', 'revoke', 'replace'].includes(item.eventKindCode)
    )
      throw new TypeError('Unsupported mapping contract');
    const previousApprovalId =
      item.previousApprovalId === null
        ? null
        : contributionPolicyText(item.previousApprovalId, 128);
    if ((item.eventKindCode === 'approve') !== (previousApprovalId === null))
      throw new TypeError('Invalid mapping predecessor');
    const effectiveFrom = instant(item.effectiveFrom);
    const effectiveUntil = item.effectiveUntil === null ? null : instant(item.effectiveUntil);
    if (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
      throw new TypeError('Invalid mapping effective interval');
    return {
      approvalNumber,
      mappingVersion: contributionPolicyText(item.mappingVersion, 128),
      activityId: contributionPolicyText(item.activityId, 128),
      activityTypeCode: contributionPolicyText(item.activityTypeCode, 64),
      attendanceRoleCode: contributionPolicyText(item.attendanceRoleCode, 64),
      sessionPositionId: contributionPolicyText(item.sessionPositionId, 128),
      policyRoleCode: contributionPolicyText(item.policyRoleCode, 64),
      categoryCode: item.categoryCode as ShadowMappingApprovalManifestItem['categoryCode'],
      policyVersionId: contributionPolicyText(item.policyVersionId, 128),
      policyDefinitionHash: contributionPolicyHash(item.policyDefinitionHash),
      evaluatorVersion: 1,
      durationSourceCode: 'legacy_stored_hours_2',
      effectiveFrom,
      effectiveUntil,
      eventKindCode: item.eventKindCode as ShadowMappingApprovalManifestItem['eventKindCode'],
      previousApprovalId,
    };
  });
  return {
    schemaVersion: 1,
    commandKey: contributionPolicyText(root.commandKey, 128),
    approvalReference: contributionPolicyText(root.approvalReference, 256),
    approvals,
  };
}

@Injectable()
export class ActivityContributionShadowMappingRegistrationService {
  constructor(
    private readonly identity: AuthHumanCommandIdentityService,
    private readonly rbac: RbacService,
  ) {}

  /** Call again after every registration lock wait and on replay. No actor-id input. */
  async assertAuthenticatedAccess(tx: Prisma.TransactionClient, accessToken: string) {
    const authenticated = await this.identity.authenticate(accessToken);
    const actor = await loadActiveUserIdentityInTx(tx, authenticated.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    const permission = 'contribution-shadow-mapping.register.approval';
    if (
      !(await this.rbac.can(actor, permission, undefined, tx)) ||
      !(await this.rbac.getUserPermissionCodes(actor.id, undefined, tx)).has(permission)
    )
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    return actor;
  }

  /** Side-effect-free preparation; an independent authenticated registration gate is still required. */
  prepareManifest(value: unknown, expectedHash: string) {
    const manifest = parseShadowMappingRegistrationManifest(value);
    const manifestHash = computeActivityTemplateDefinitionHash({
      schemaVersion: 1,
      definition: { domain: 'SRVF:E3-2:shadow-mapping-registration:v1', manifest },
    });
    if (manifestHash !== contributionPolicyHash(expectedHash))
      throw new TypeError('Mapping manifest digest mismatch');
    return { manifest, manifestHash };
  }

  /** Caller owns the registrar-connection transaction. Never uses the app owner connection. */
  async registerInTx(
    tx: Prisma.TransactionClient,
    accessToken: string,
    value: unknown,
    expectedHash: string,
  ): Promise<unknown> {
    const { manifest } = this.prepareManifest(value, expectedHash);
    const actor = await this.assertAuthenticatedAccess(tx, accessToken);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`SRVF:E3-2:mapping-registration:${manifest.commandKey}`},0))`;
    const lockedActor = await this.assertAuthenticatedAccess(tx, accessToken);
    if (lockedActor.id !== actor.id) throw new BizException(BizCode.UNAUTHORIZED);
    const approvalIds = manifest.approvals.map(() => randomUUID());
    const rows = await tx.$queryRaw<Array<{ receipt: unknown }>>`
      SELECT csm_register_mapping_fn(${JSON.stringify(manifest)}::jsonb,${actor.id},
        ${randomUUID()},${randomUUID()},${JSON.stringify(approvalIds)}::jsonb) AS receipt`;
    // The SQL function may have waited for activity/policy locks. Expired tokens
    // or revoked access now throw inside the same transaction, rolling it back.
    const finalActor = await this.assertAuthenticatedAccess(tx, accessToken);
    if (finalActor.id !== actor.id) throw new BizException(BizCode.UNAUTHORIZED);
    if (rows.length !== 1 || rows[0].receipt === null)
      throw new Error('Shadow mapping registration returned no receipt');
    return rows[0].receipt;
  }
}

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuthHumanCommandIdentityService } from '../auth/auth-human-command-identity.service';
import { RbacService } from '../permissions/rbac.service';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import type { AuditLogEvent } from '../audit-logs/audit-logs.types';
import {
  prepareShadowReconciliationManifest,
  SHADOW_RECONCILIATION_PERMISSIONS,
  type ShadowReconciliationManifest,
} from './contribution-shadow-reconciliation-command';

// SQL emits these events in the same transaction; these witnesses are checked
// against durable integration audit rows, not an additional application log.
export const SHADOW_WINDOW_REGISTRATION_AUDIT_EVENT: AuditLogEvent =
  'activity.contribution-shadow.window-register';

export interface ShadowReconciliationCommandResult {
  receiptId: string;
  windowId: string;
  auditLogId?: string;
  revision?: number;
  replayed: boolean;
}

@Injectable()
export class ContributionShadowWindowRegistrationService {
  constructor(
    private readonly identity: AuthHumanCommandIdentityService,
    private readonly rbac: RbacService,
  ) {}

  async assertAuthenticatedAccess(
    tx: Prisma.TransactionClient,
    accessToken: string,
    operation: ShadowReconciliationManifest['operation'],
  ) {
    const authenticated = await this.identity.authenticate(accessToken);
    const actor = await loadActiveUserIdentityInTx(tx, authenticated.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    const permission = SHADOW_RECONCILIATION_PERMISSIONS[operation];
    if (
      !(await this.rbac.can(actor, permission, undefined, tx)) ||
      !(await this.rbac.getUserPermissionCodes(actor.id, undefined, tx)).has(permission)
    )
      throw new BizException(BizCode.FORBIDDEN);
    return actor;
  }

  /** The CLI caller owns the dedicated registrar connection and five-second transaction. */
  async registerInTx(
    tx: Prisma.TransactionClient,
    accessToken: string,
    value: unknown,
    expectedHash: string,
  ) {
    return this.executeInTx(tx, accessToken, value, expectedHash, 'register_window');
  }

  async executeInTx(
    tx: Prisma.TransactionClient,
    accessToken: string,
    value: unknown,
    expectedHash: string,
    operation: ShadowReconciliationManifest['operation'],
  ): Promise<ShadowReconciliationCommandResult> {
    const { manifest } = prepareShadowReconciliationManifest(value, expectedHash);
    if (manifest.operation !== operation) throw new TypeError('Reconciliation operation mismatch');
    const actor = await this.assertAuthenticatedAccess(tx, accessToken, operation);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`SRVF:E3-2:reconciliation-command:${manifest.commandKey}`},0))::text`;
    const lockedActor = await this.assertAuthenticatedAccess(tx, accessToken, operation);
    if (lockedActor.id !== actor.id) throw new BizException(BizCode.UNAUTHORIZED);
    const rows = await tx.$queryRaw<Array<{ receipt: ShadowReconciliationCommandResult }>>`
      SELECT csd3_register_fn(${JSON.stringify(manifest)}::jsonb,${actor.id},
        ${randomUUID()},${operation === 'sign_disposition' ? randomUUID() : null},${randomUUID()}) AS receipt`;
    const finalActor = await this.assertAuthenticatedAccess(tx, accessToken, operation);
    if (finalActor.id !== actor.id) throw new BizException(BizCode.UNAUTHORIZED);
    const result = rows[0]?.receipt;
    if (
      rows.length !== 1 ||
      !result ||
      typeof result.receiptId !== 'string' ||
      typeof result.windowId !== 'string' ||
      typeof result.replayed !== 'boolean'
    )
      throw new Error('Reconciliation returned no valid receipt');
    if (operation === 'sign_disposition') {
      if (
        typeof result.auditLogId !== 'string' ||
        !Number.isSafeInteger(result.revision) ||
        (result.revision ?? 0) < 1
      )
        throw new Error('Reconciliation returned invalid disposition');
      return {
        receiptId: result.receiptId,
        windowId: result.windowId,
        auditLogId: result.auditLogId,
        revision: result.revision,
        replayed: result.replayed,
      };
    }
    return { receiptId: result.receiptId, windowId: result.windowId, replayed: result.replayed };
  }
}

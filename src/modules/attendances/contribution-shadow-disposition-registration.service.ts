import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditLogEvent } from '../audit-logs/audit-logs.types';
import { ContributionShadowWindowRegistrationService } from './contribution-shadow-window-registration.service';

export const SHADOW_DISPOSITION_REGISTRATION_AUDIT_EVENT: AuditLogEvent =
  'activity.contribution-shadow.disposition-sign';

@Injectable()
export class ContributionShadowDispositionRegistrationService {
  constructor(private readonly registration: ContributionShadowWindowRegistrationService) {}

  /** Shares authenticated command orchestration, never grants window/read permission. */
  registerInTx(
    tx: Prisma.TransactionClient,
    accessToken: string,
    value: unknown,
    expectedHash: string,
  ) {
    return this.registration.executeInTx(tx, accessToken, value, expectedHash, 'sign_disposition');
  }
}

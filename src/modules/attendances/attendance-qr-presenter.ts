import { Injectable } from '@nestjs/common';

import type { AppManagedAttendanceQrCredentialDto } from './dto/app/app-managed-attendance-qr.dto';

export interface AttendanceQrCredentialPresentation {
  id: string;
  activityId: string;
  sessionId: string;
  actionCode: string;
  credentialVersion: number;
  statusCode: string;
  validFrom: Date;
  validUntil: Date;
  issuedAt: Date;
  revokedAt: Date | null;
}

@Injectable()
export class AttendanceQrPresenter {
  present(row: AttendanceQrCredentialPresentation): AppManagedAttendanceQrCredentialDto {
    return {
      credentialId: row.id,
      activityId: row.activityId,
      sessionId: row.sessionId,
      actionCode: row.actionCode,
      credentialVersion: row.credentialVersion,
      statusCode: row.statusCode,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      issuedAt: row.issuedAt,
      revokedAt: row.revokedAt,
    };
  }
}

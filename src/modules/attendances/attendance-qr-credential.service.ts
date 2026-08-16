import { randomUUID, createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { JwtConfig } from '../../config/jwt.config';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttendancePunchAuditRecorder } from './attendance-punch-audit-recorder';
import { AttendanceQrPresenter } from './attendance-qr-presenter';
import {
  digestAttendanceQrToken,
  signAttendanceQrToken,
  verifyAttendanceQrToken,
  type AttendanceQrActionCode,
  type AttendanceQrTokenPayload,
} from './attendance-qr-token';
import {
  isAttendanceQrAction,
  nextAttendanceQrCredentialVersion,
} from './attendance-qr-state-machine';
import type { AppManagedAttendanceQrCredentialDto } from './dto/app/app-managed-attendance-qr.dto';

type PrismaTx = Prisma.TransactionClient;

type CredentialRow = {
  id: string;
  activityId: string;
  sessionId: string;
  actionCode: string;
  credentialVersion: number;
  statusCode: string;
  tokenDigest: string;
  signingKeyVersion: number;
  validFrom: Date;
  validUntil: Date;
  issuedAt: Date;
  revokedAt: Date | null;
  operationKey: string | null;
  requestHash: string | null;
};

type QrCodeEncoder = {
  toString(
    value: string,
    options: { type: 'svg'; errorCorrectionLevel: 'M'; margin: number },
  ): Promise<string>;
};

// qrcode does not publish TypeScript declarations. Keep the runtime dependency narrow at the only
// binary-rendering boundary instead of introducing a hand-maintained ambient declaration surface.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const qrCode = require('qrcode') as QrCodeEncoder;

@Injectable()
export class AttendanceQrCredentialService {
  private readonly jwtSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenter: AttendanceQrPresenter,
    private readonly audit: AttendancePunchAuditRecorder,
    config: ConfigService,
  ) {
    const jwt = config.get<JwtConfig>('jwt');
    if (!jwt) throw new Error('jwt.config 未加载');
    this.jwtSecret = jwt.secret;
  }

  async list(
    activityId: string,
    sessionId: string,
    currentUser: CurrentUserPayload,
  ): Promise<AppManagedAttendanceQrCredentialDto[]> {
    await this.assertManagedAttendance(this.prisma, activityId, currentUser);
    const session = await this.prisma.activitySession.findFirst({
      where: { id: sessionId, activityId, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new BizException(BizCode.BAD_REQUEST);
    const rows = await this.prisma.attendanceQrCredential.findMany({
      where: { activityId, sessionId },
      select: this.safeSelect,
      orderBy: [{ actionCode: 'asc' }, { credentialVersion: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.presenter.present(row));
  }

  async issue(args: {
    activityId: string;
    sessionId: string;
    actionCode: string;
    operationKey: string;
    currentUser: CurrentUserPayload;
    auditMeta: AuditMeta;
  }): Promise<AppManagedAttendanceQrCredentialDto> {
    if (!isAttendanceQrAction(args.actionCode)) throw new BizException(BizCode.BAD_REQUEST);
    const requestHash = this.commandHash({
      command: 'issue',
      activityId: args.activityId,
      sessionId: args.sessionId,
      actionCode: args.actionCode,
    });
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockActivity(tx, args.activityId);
        await this.assertManagedAttendance(tx, args.activityId, args.currentUser);
        const session = await this.lockSession(tx, args.activityId, args.sessionId);
        const replay = await this.findOperationReplay(tx, args.operationKey, requestHash);
        if (replay) return this.presenter.present(replay);

        const latest = await tx.attendanceQrCredential.findFirst({
          where: {
            activityId: args.activityId,
            sessionId: args.sessionId,
            actionCode: args.actionCode,
          },
          select: { credentialVersion: true },
          orderBy: [{ credentialVersion: 'desc' }, { id: 'desc' }],
        });
        const active = await tx.attendanceQrCredential.findFirst({
          where: {
            activityId: args.activityId,
            sessionId: args.sessionId,
            actionCode: args.actionCode,
            statusCode: 'active',
          },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        const now = new Date();
        if (active) {
          await tx.attendanceQrCredential.update({
            where: { id: active.id },
            data: {
              statusCode: 'revoked',
              revokedByUserId: args.currentUser.id,
              revokedAt: now,
              revokeReason: '重签发',
            },
          });
        }
        const actionCode = args.actionCode as AttendanceQrActionCode;
        const validFrom =
          actionCode === 'check_in' ? session.checkInOpenAt : session.checkOutOpenAt;
        const validUntil =
          actionCode === 'check_in' ? session.checkInCloseAt : session.checkOutCloseAt;
        const credentialVersion = nextAttendanceQrCredentialVersion(
          latest?.credentialVersion ?? null,
        );
        const id = randomUUID();
        const token = signAttendanceQrToken(
          {
            credentialId: id,
            activityId: args.activityId,
            sessionId: args.sessionId,
            actionCode,
            credentialVersion,
            validFrom,
            validUntil,
          },
          this.jwtSecret,
        );
        const created = await tx.attendanceQrCredential.create({
          data: {
            id,
            activityId: args.activityId,
            sessionId: args.sessionId,
            actionCode,
            credentialVersion,
            statusCode: 'active',
            tokenDigest: digestAttendanceQrToken(token),
            signingKeyVersion: 0,
            validFrom,
            validUntil,
            issuedByUserId: args.currentUser.id,
            issuedAt: now,
            operationKey: args.operationKey,
            requestHash,
          },
          select: this.safeSelect,
        });
        await this.audit.logQr({
          operation: 'attendance-qr.issue',
          activityId: args.activityId,
          sessionId: args.sessionId,
          credentialId: created.id,
          actionCode: created.actionCode,
          credentialVersion: created.credentialVersion,
          statusCode: created.statusCode,
          actorUserId: args.currentUser.id,
          actorRoleSnap: args.currentUser.role,
          auditMeta: args.auditMeta,
          tx,
        });
        return this.presenter.present(created);
      },
      { maxWait: 60_000, timeout: 60_000 },
    );
  }

  async revoke(args: {
    activityId: string;
    credentialId: string;
    reason: string;
    operationKey: string;
    currentUser: CurrentUserPayload;
    auditMeta: AuditMeta;
  }): Promise<AppManagedAttendanceQrCredentialDto> {
    const reason = this.normalizeReason(args.reason);
    if (reason === null) throw new BizException(BizCode.BAD_REQUEST);
    const requestHash = this.commandHash({
      command: 'revoke',
      activityId: args.activityId,
      credentialId: args.credentialId,
      reason,
    });
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockActivity(tx, args.activityId);
        await this.assertManagedAttendance(tx, args.activityId, args.currentUser);
        const credential = await this.lockCredential(tx, args.activityId, args.credentialId);
        const replay = await this.findOperationReplay(tx, args.operationKey, requestHash);
        if (replay) return this.presenter.present(replay);
        if (credential.statusCode !== 'active')
          throw new BizException(BizCode.ATTENDANCE_QR_REVOKED);
        const revoked = await tx.attendanceQrCredential.update({
          where: { id: credential.id },
          data: {
            statusCode: 'revoked',
            revokedByUserId: args.currentUser.id,
            revokedAt: new Date(),
            revokeReason: reason,
            operationKey: args.operationKey,
            requestHash,
          },
          select: this.safeSelect,
        });
        await this.audit.logQr({
          operation: 'attendance-qr.revoke',
          activityId: args.activityId,
          sessionId: revoked.sessionId,
          credentialId: revoked.id,
          actionCode: revoked.actionCode,
          credentialVersion: revoked.credentialVersion,
          statusCode: revoked.statusCode,
          actorUserId: args.currentUser.id,
          actorRoleSnap: args.currentUser.role,
          auditMeta: args.auditMeta,
          tx,
        });
        return this.presenter.present(revoked);
      },
      { maxWait: 60_000, timeout: 60_000 },
    );
  }

  async renderSvg(args: {
    activityId: string;
    credentialId: string;
    currentUser: CurrentUserPayload;
    auditMeta: AuditMeta;
  }): Promise<string> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockActivity(tx, args.activityId);
        await this.assertManagedAttendance(tx, args.activityId, args.currentUser);
        const credential = await this.lockCredential(tx, args.activityId, args.credentialId);
        if (credential.statusCode !== 'active')
          throw new BizException(BizCode.ATTENDANCE_QR_REVOKED);
        const token = this.signCredential(credential);
        await this.audit.logQr({
          operation: 'attendance-qr.render',
          activityId: args.activityId,
          sessionId: credential.sessionId,
          credentialId: credential.id,
          actionCode: credential.actionCode,
          credentialVersion: credential.credentialVersion,
          statusCode: credential.statusCode,
          actorUserId: args.currentUser.id,
          actorRoleSnap: args.currentUser.role,
          auditMeta: args.auditMeta,
          tx,
        });
        return qrCode.toString(token, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
      },
      { maxWait: 60_000, timeout: 60_000 },
    );
  }

  verifyToken(token: string): AttendanceQrTokenPayload {
    return verifyAttendanceQrToken(token, this.jwtSecret);
  }

  tokenDigest(token: string): string {
    return digestAttendanceQrToken(token);
  }

  private readonly safeSelect = {
    id: true,
    activityId: true,
    sessionId: true,
    actionCode: true,
    credentialVersion: true,
    statusCode: true,
    tokenDigest: true,
    signingKeyVersion: true,
    validFrom: true,
    validUntil: true,
    issuedAt: true,
    revokedAt: true,
    operationKey: true,
    requestHash: true,
  } satisfies Prisma.AttendanceQrCredentialSelect;

  private signCredential(credential: CredentialRow): string {
    if (!isAttendanceQrAction(credential.actionCode) || credential.signingKeyVersion !== 0) {
      throw new BizException(BizCode.ATTENDANCE_QR_NOT_FOUND);
    }
    const token = signAttendanceQrToken(
      {
        credentialId: credential.id,
        activityId: credential.activityId,
        sessionId: credential.sessionId,
        actionCode: credential.actionCode,
        credentialVersion: credential.credentialVersion,
        validFrom: credential.validFrom,
        validUntil: credential.validUntil,
      },
      this.jwtSecret,
    );
    if (digestAttendanceQrToken(token) !== credential.tokenDigest) {
      throw new BizException(BizCode.ATTENDANCE_QR_NOT_FOUND);
    }
    return token;
  }

  private async lockActivity(tx: PrismaTx, activityId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string; statusCode: string }>>(Prisma.sql`
      SELECT "id", "statusCode" FROM "Activity"
      WHERE "id" = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    if (rows[0]?.statusCode !== 'published')
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
  }

  private async lockSession(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
  ): Promise<{
    checkInOpenAt: Date;
    checkInCloseAt: Date;
    checkOutOpenAt: Date;
    checkOutCloseAt: Date;
  }> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "ActivitySession"
      WHERE "id" = ${sessionId}
        AND "activityId" = ${activityId}
        AND "deletedAt" IS NULL
        AND "statusCode" = 'scheduled'
      FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(BizCode.BAD_REQUEST);
    const session = await tx.activitySession.findFirst({
      where: { id: sessionId, activityId, deletedAt: null, statusCode: 'scheduled' },
      select: {
        checkInOpenAt: true,
        checkInCloseAt: true,
        checkOutOpenAt: true,
        checkOutCloseAt: true,
      },
    });
    if (!session) throw new BizException(BizCode.BAD_REQUEST);
    return session;
  }

  private async lockCredential(
    tx: PrismaTx,
    activityId: string,
    credentialId: string,
  ): Promise<CredentialRow> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "AttendanceQrCredential"
      WHERE "id" = ${credentialId} AND "activityId" = ${activityId}
      FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(BizCode.ATTENDANCE_QR_NOT_FOUND);
    const credential = await tx.attendanceQrCredential.findFirst({
      where: { id: credentialId, activityId },
      select: this.safeSelect,
    });
    if (!credential) throw new BizException(BizCode.ATTENDANCE_QR_NOT_FOUND);
    return credential;
  }

  private async assertManagedAttendance(
    tx: Pick<PrismaService, 'activityResponsibilityAssignment'> | PrismaTx,
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const assignment = await tx.activityResponsibilityAssignment.findFirst({
      where: {
        activityId,
        memberId: currentUser.memberId,
        status: 'active',
        canManageAttendance: true,
      },
      select: { id: true },
    });
    if (!assignment) throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private async findOperationReplay(
    tx: PrismaTx,
    operationKey: string,
    requestHash: string,
  ): Promise<CredentialRow | null> {
    const existing = await tx.attendanceQrCredential.findFirst({
      where: { operationKey },
      select: this.safeSelect,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
    });
    if (!existing) return null;
    if (existing.requestHash === requestHash) return existing;
    throw new BizException(BizCode.ATTENDANCE_QR_VERSION_CONFLICT);
  }

  private commandHash(input: Record<string, string>): string {
    return createHash('sha256')
      .update(JSON.stringify({ v: 'attendance-qr-command/v1', ...input }), 'utf8')
      .digest('hex');
  }

  private normalizeReason(value: string): string | null {
    const normalized = value.trim().replace(/\s+/gu, ' ');
    return normalized.length === 0 ? null : normalized;
  }
}

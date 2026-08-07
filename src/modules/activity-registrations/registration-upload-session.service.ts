import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityParticipationPolicy } from '../activities/activity-participation-policy';
import {
  AttachmentsService,
  type RegistrationUploadAttachmentView,
} from '../attachments/attachments.service';
import type {
  AppRegistrationUploadAttachmentDto,
  AppRegistrationUploadSessionCreatedDto,
} from './dto/app/app-registration-upload-session.dto';

type PrismaTx = Prisma.TransactionClient;

const REGISTRATION_UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;
const internalOwnerType = 'registration-upload-session';

const attachmentResponseSelect = {
  id: true,
  originalName: true,
  mime: true,
  size: true,
  createdAt: true,
} as const satisfies Prisma.AttachmentSelect;

interface VerifiedUploadSession {
  id: string;
  activityId: string;
  formVersionId: string;
  expiresAt: Date;
}

@Injectable()
export class RegistrationUploadSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly participationPolicy: ActivityParticipationPolicy,
    private readonly attachments: AttachmentsService,
  ) {}

  async create(
    activityId: string,
    user: CurrentUserPayload,
    memberId: string,
  ): Promise<AppRegistrationUploadSessionCreatedDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivity(tx, activityId, BizCode.ACTIVITY_NOT_FOUND);
      const activity = await this.findVisibleActivity(tx, activityId, memberId);
      if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
      const decision = this.participationPolicy.canRegisterSelf(activity);
      if (!decision.allowed) throw new BizException(decision.biz);
      const form = await tx.registrationFormVersion.findFirst({
        where: {
          activityId,
          statusCode: 'active',
          fields: { some: { typeCode: 'file' } },
        },
        select: { id: true, version: true },
      });
      // The App never learns whether the activity has a Form, a retired Form or merely no file
      // question; all are outside this one-time upload capability.
      if (!form) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + REGISTRATION_UPLOAD_SESSION_TTL_MS);
      const session = await tx.registrationUploadSession.create({
        data: {
          activityId,
          memberId,
          formVersionId: form.id,
          tokenHash: this.hashToken(token),
          expiresAt,
          statusCode: 'active',
        },
        select: { id: true, expiresAt: true },
      });
      return { id: session.id, token, expiresAt: session.expiresAt, formVersion: form.version };
    });
  }

  async upload(input: {
    activityId: string;
    sessionId: string;
    token: string;
    file: { originalName: string; mime: string; size: number; buffer: Buffer };
    user: CurrentUserPayload;
    memberId: string;
    auditMeta: AuditMeta;
  }): Promise<AppRegistrationUploadAttachmentDto> {
    if (!input.token || typeof input.token !== 'string') {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    const tokenHash = this.hashToken(input.token);

    // Narrow anti-enumeration guard. It is intentionally before attachment config, ledger,
    // Provider, or audit work; malformed file bytes are not inspected until this commits cleanly.
    const guarded = await this.prisma.$transaction(async (tx) => {
      const verified = await this.lockAndVerifySession(tx, {
        activityId: input.activityId,
        sessionId: input.sessionId,
        tokenHash,
        memberId: input.memberId,
      });
      const existing = await this.findSessionAttachment(tx, verified.id);
      return { verified, existing };
    });
    if (guarded.existing) return this.toDto(guarded.existing);

    // All configuration, MIME/size/PII and magic-byte work is outside a transaction. The opaque
    // handle contains the only generated key/locator and cannot be forged by this module.
    const validated = await this.attachments.validateRegistrationUploadOutsideTransactionTrusted({
      sessionId: guarded.verified.id,
      originalName: input.file.originalName,
      mime: input.file.mime,
      size: input.file.size,
      body: input.file.buffer,
      uploadedByUserId: input.user.id,
      user: input.user,
      expiresAt: guarded.verified.expiresAt,
    });

    const preparedOrExisting = await this.prisma.$transaction(async (tx) => {
      const verified = await this.lockAndVerifySession(tx, {
        activityId: input.activityId,
        sessionId: input.sessionId,
        tokenHash,
        memberId: input.memberId,
      });
      const existing = await this.findSessionAttachment(tx, verified.id);
      if (existing) return { existing, prepared: null };
      return {
        existing: null,
        prepared: await this.attachments.prepareRegistrationUploadInTransactionTrusted(
          tx,
          validated,
        ),
      };
    });
    if (preparedOrExisting.existing) return this.toDto(preparedOrExisting.existing);
    if (!preparedOrExisting.prepared) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);

    const verifiedProvider =
      await this.attachments.putRegistrationUploadAndVerifyOutsideTransactionTrusted(
        preparedOrExisting.prepared,
      );
    try {
      const finalizedOrExisting = await this.prisma.$transaction(async (tx) => {
        const verified = await this.lockAndVerifySession(tx, {
          activityId: input.activityId,
          sessionId: input.sessionId,
          tokenHash,
          memberId: input.memberId,
        });
        const existing = await this.findSessionAttachment(tx, verified.id);
        if (existing) return { existing, finalized: null };
        return {
          existing: null,
          finalized: await this.attachments.finalizeRegistrationUploadInTransactionTrusted(
            tx,
            verifiedProvider,
            input.auditMeta,
          ),
        };
      });
      if (finalizedOrExisting.existing) return this.toDto(finalizedOrExisting.existing);
      if (!finalizedOrExisting.finalized) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
      return this.toDto(
        this.attachments.registrationUploadResponseTrusted(finalizedOrExisting.finalized),
      );
    } catch (error) {
      // The migration-level one-owner constraint is the last concurrent race fence. A loser never
      // leaks P2002; it rereads the winner's same safe projection and leaves its durable orphan
      // intent for the existing recovery chain rather than request-scoped deletion.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.attachment.findFirst({
          where: { ownerType: internalOwnerType, ownerId: input.sessionId },
          select: attachmentResponseSelect,
        });
        if (existing) return this.toDto(existing);
      }
      throw error;
    }
  }

  private async lockAndVerifySession(
    tx: PrismaTx,
    input: { activityId: string; sessionId: string; tokenHash: string; memberId: string },
  ): Promise<VerifiedUploadSession> {
    await this.lockActivity(tx, input.activityId, BizCode.ATTACHMENT_NOT_FOUND);
    const sessionRows = await tx.$queryRaw<
      Array<{
        id: string;
        activityId: string;
        memberId: string;
        formVersionId: string;
        tokenHash: string;
        expiresAt: Date;
        statusCode: string;
      }>
    >(Prisma.sql`
      SELECT "id", "activityId", "memberId", "formVersionId", "tokenHash", "expiresAt", "statusCode"
      FROM "RegistrationUploadSession"
      WHERE "id" = ${input.sessionId}
      FOR UPDATE
    `);
    const session = sessionRows[0];
    if (
      sessionRows.length !== 1 ||
      !session ||
      session.activityId !== input.activityId ||
      session.memberId !== input.memberId ||
      session.tokenHash !== input.tokenHash ||
      session.statusCode !== 'active' ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    const activity = await this.findVisibleActivity(tx, input.activityId, input.memberId);
    if (!activity || !this.participationPolicy.canRegisterSelf(activity).allowed) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }
    const activeForm = await tx.registrationFormVersion.findFirst({
      where: {
        id: session.formVersionId,
        activityId: input.activityId,
        statusCode: 'active',
        fields: { some: { typeCode: 'file' } },
      },
      select: { id: true },
    });
    if (!activeForm) throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    return {
      id: session.id,
      activityId: session.activityId,
      formVersionId: session.formVersionId,
      expiresAt: session.expiresAt,
    };
  }

  private async lockActivity(
    tx: PrismaTx,
    activityId: string,
    biz: typeof BizCode.ACTIVITY_NOT_FOUND | typeof BizCode.ATTACHMENT_NOT_FOUND,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Activity"
      WHERE "id" = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(biz);
  }

  private async findVisibleActivity(
    tx: PrismaTx,
    activityId: string,
    memberId: string,
  ): Promise<{
    statusCode: string;
    isPublicRegistration: boolean;
    registrationDeadline: Date | null;
    endAt: Date;
  } | null> {
    return tx.activity.findFirst({
      where: {
        id: activityId,
        deletedAt: null,
        OR: [
          { visibilityCode: null },
          { visibilityCode: { not: 'invitation' } },
          {
            invitations: {
              some: { memberId, statusCode: { in: ['pending', 'accepted'] } },
            },
          },
        ],
      },
      select: {
        statusCode: true,
        isPublicRegistration: true,
        registrationDeadline: true,
        endAt: true,
      },
    });
  }

  private async findSessionAttachment(
    tx: PrismaTx,
    sessionId: string,
  ): Promise<Prisma.AttachmentGetPayload<{ select: typeof attachmentResponseSelect }> | null> {
    return tx.attachment.findFirst({
      where: { ownerType: internalOwnerType, ownerId: sessionId },
      select: attachmentResponseSelect,
    });
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private toDto(
    row:
      | Prisma.AttachmentGetPayload<{ select: typeof attachmentResponseSelect }>
      | RegistrationUploadAttachmentView,
  ): AppRegistrationUploadAttachmentDto {
    return {
      attachmentId: 'attachmentId' in row ? row.attachmentId : row.id,
      originalName: row.originalName,
      mime: row.mime,
      size: row.size,
      createdAt: row.createdAt,
    };
  }
}

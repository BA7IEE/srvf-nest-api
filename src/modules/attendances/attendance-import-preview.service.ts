import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttendancePunchAuditRecorder } from './attendance-punch-audit-recorder';
import { AttendancePunchCommandService } from './attendance-punch-command.service';
import { AttendanceImportAttachmentService } from './attendance-import-attachment.service';
import { normalizeAttendancePunchReason } from './attendance-punch-request-hash';
import type { OnsiteBatchJobReceipt } from './attendance-onsite-batch-job.service';

type PrismaTx = Prisma.TransactionClient;

export const ATTENDANCE_IMPORT_PREVIEW_JOB_TYPE = 'import_preview';
export const ATTENDANCE_IMPORT_PREVIEW_ACTION = 'onsite_import_preview';
export const ATTENDANCE_IMPORT_EXECUTE_JOB_TYPE = 'import_execute';
export const ATTENDANCE_IMPORT_EXECUTE_ACTION = 'onsite_import_execute';
export const ATTENDANCE_IMPORT_CSV_PARSER_VERSION = 'attendance-import-csv/v1';
export const ATTENDANCE_IMPORT_CSV_MAX_ROWS = 10_000;
export const ATTENDANCE_IMPORT_CSV_MAX_BYTES = 10 * 1024 * 1024;
const ATTENDANCE_IMPORT_OPERATION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,96}$/u;
const ATTENDANCE_IMPORT_EXECUTE_PAYLOAD_VERSION = 1;
const ATTENDANCE_IMPORT_CSV_HEADER = [
  'participationIdentityId',
  'actionCode',
  'occurredAt',
  'longitude',
  'latitude',
  'accuracy',
] as const;

export interface CreateAttendanceImportPreviewInput {
  activityId: string;
  sessionId: string;
  operationKey: string;
  reason: string;
  file: { originalName: string; mime: string; size: number; buffer: Buffer };
}

export interface ExecuteAttendanceImportPreviewInput {
  activityId: string;
  previewId: string;
  operationKey: string;
  fileDigest: string;
  parserVersion: string;
  previewHash: string;
}

/** Worker lease/fence must be rechecked in the same Activity-root transaction as every event. */
export interface AttendanceImportExecuteLeaseFence {
  leaseOwner: string;
  leaseGeneration: number;
}

export class AttendanceImportExecuteLeaseLostError extends Error {
  constructor() {
    super('attendance import execute lease lost');
    this.name = 'AttendanceImportExecuteLeaseLostError';
  }
}

export interface AttendanceImportExecuteRunResult {
  itemsProcessed: number;
  itemsSkipped: number;
  itemsFailed: number;
  statusCode: 'succeeded' | 'partial_failed' | 'failed';
}

export interface AttendanceImportPreviewRead {
  jobId: string;
  statusCode: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  fileDigest: string;
  parserVersion: string;
  previewHash: string;
  items: {
    items: Array<{
      line: number;
      statusCode: string;
      lastErrorCode: string | null;
      safeMessage: string | null;
    }>;
    total: number;
    page: number;
    pageSize: number;
  };
}

interface ParsedImportRow {
  line: number;
  participationIdentityId: string | null;
  actionCode: 'check_in' | 'check_out' | null;
  occurredAt: string | null;
  longitude: string | null;
  latitude: string | null;
  accuracy: string | null;
  rowHash: string;
  valid: boolean;
}

interface ParsedImportCsv {
  rows: ParsedImportRow[];
}

interface PreviewFacts {
  jobId: string;
  operationKey: string;
  requestHash: string;
  ruleSnapshotHash: string;
  previewHash: string;
  replayed: boolean;
}

interface PreviewPayload {
  action: typeof ATTENDANCE_IMPORT_PREVIEW_ACTION;
  parserVersion: typeof ATTENDANCE_IMPORT_CSV_PARSER_VERSION;
  reason: string;
  fileDigest: string;
  ruleSnapshotHash: string;
  previewHash: string;
  actorUserId: string;
  actorMemberId: string;
}

interface ExecutePreviewFacts {
  activityId: string;
  previewId: string;
  sessionId: string;
  operationKey: string;
  requestHash: string;
  fileDigest: string;
  parserVersion: typeof ATTENDANCE_IMPORT_CSV_PARSER_VERSION;
  previewHash: string;
  ruleSnapshotHash: string;
  reason: string;
  actorUserId: string;
  actorMemberId: string;
}

interface ImportExecutePayload {
  action: typeof ATTENDANCE_IMPORT_EXECUTE_ACTION;
  previewId: string;
  fileDigest: string;
  parserVersion: typeof ATTENDANCE_IMPORT_CSV_PARSER_VERSION;
  previewHash: string;
  ruleSnapshotHash: string;
  reason: string;
  actorUserId: string;
  actorMemberId: string;
}

interface LockedImportExecuteJob {
  id: string;
  activityId: string;
  sessionId: string | null;
  jobTypeCode: string;
  statusCode: string;
  requestHash: string | null;
  payload: Prisma.JsonValue;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  leaseOwner: string | null;
  leaseGeneration: number;
  leaseExpiresAt: Date | null;
}

interface LockedImportExecuteItem {
  id: string;
  itemKey: string;
  statusCode: string;
  resourceType: string | null;
  resourceId: string | null;
  payloadHash: string | null;
}

interface LoadedImportExecuteSource {
  activityId: string;
  sessionId: string;
  requestHash: string | null;
  payload: ImportExecutePayload;
}

type ImportExecuteItemResult =
  | { kind: 'succeeded' }
  | { kind: 'failed' }
  | { kind: 'authorization_revoked' }
  | { kind: 'already_terminal' };

@Injectable()
export class AttendanceImportPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttendanceImportAttachmentService,
    private readonly audit: AttendancePunchAuditRecorder,
    private readonly command: AttendancePunchCommandService,
  ) {}

  async createPreview(
    input: CreateAttendanceImportPreviewInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<OnsiteBatchJobReceipt> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    if (!ATTENDANCE_IMPORT_OPERATION_KEY_PATTERN.test(input.operationKey)) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const reason = normalizeAttendancePunchReason(input.reason);
    if (reason === null || reason.length > 500) throw new BizException(BizCode.BAD_REQUEST);
    if (
      input.file.mime !== 'text/csv' ||
      !Number.isSafeInteger(input.file.size) ||
      input.file.size < 0 ||
      input.file.size !== input.file.buffer.length ||
      input.file.size > ATTENDANCE_IMPORT_CSV_MAX_BYTES
    ) {
      throw new BizException(
        input.file.mime !== 'text/csv'
          ? BizCode.ATTACHMENT_MIME_NOT_ALLOWED
          : BizCode.ATTACHMENT_SIZE_EXCEEDED,
      );
    }

    const fileDigest = sha256(input.file.buffer);
    const parsed = parseAttendanceImportCsv(input.file.buffer);
    const reserved = await this.reservePreviewWithReplay(
      { ...input, reason, fileDigest, parsed },
      currentUser,
    );
    if (reserved.replayed) return reserved.receipt;

    try {
      const validated = await this.attachments.validateOutsideTransaction({
        previewJobId: reserved.facts.jobId,
        originalName: input.file.originalName,
        mime: input.file.mime,
        size: input.file.size,
        body: input.file.buffer,
        fileDigest,
        uploadedByUserId: currentUser.id,
        user: currentUser,
      });
      const prepared = await this.prisma.$transaction(async (tx) => {
        await this.lockAndAssertPreviewCurrent(tx, reserved.facts, input.activityId, currentUser);
        return this.attachments.prepareInTransaction(tx, validated);
      });
      const verified = await this.attachments.putAndVerifyOutsideTransaction(prepared);
      return await this.prisma.$transaction(async (tx) => {
        const facts = await this.lockAndAssertPreviewCurrent(
          tx,
          reserved.facts,
          input.activityId,
          currentUser,
        );
        await this.attachments.finalizeInTransaction(tx, verified, auditMeta);
        const evaluated = await this.evaluateRowsInTransaction(
          tx,
          parsed.rows,
          input.activityId,
          input.sessionId,
        );
        await tx.activityBatchJobItem.createMany({
          data: evaluated.map((row) => ({
            jobId: facts.jobId,
            itemKey: `line:${row.line}`,
            statusCode: row.valid ? 'succeeded' : 'failed',
            attempts: 1,
            resourceType: row.valid ? 'activity_participation_identity' : null,
            resourceId: row.valid ? row.participationIdentityId : null,
            payloadHash: row.rowHash,
            lastErrorCode: row.valid ? null : `BizException:${BizCode.BAD_REQUEST.code}`,
            safeMessage: row.valid ? null : 'CSV 行不符合受控导入预览条件',
          })),
        });
        const succeeded = evaluated.filter((row) => row.valid).length;
        const failed = evaluated.length - succeeded;
        const statusCode = failed === 0 ? 'succeeded' : 'partial_failed';
        const updated = await tx.activityBatchJob.updateMany({
          where: { id: facts.jobId, statusCode: 'pending', requestHash: facts.requestHash },
          data: {
            statusCode,
            total: evaluated.length,
            succeeded,
            failed,
            skipped: 0,
            completedAt: await this.readAuthoritativeNow(tx),
          },
        });
        if (updated.count !== 1) this.failClosed();
        await this.audit.logOnsiteBatchJob({
          operation: 'attendance-import.preview',
          activityId: input.activityId,
          sessionId: input.sessionId,
          jobId: facts.jobId,
          total: evaluated.length,
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          auditMeta,
          tx,
        });
        return {
          jobId: facts.jobId,
          statusCode,
          total: evaluated.length,
          succeeded,
          failed,
          skipped: 0,
          replayed: false,
        };
      });
    } catch (error) {
      await this.markPreviewFailedAfterUploadError(reserved.facts, input.activityId, currentUser);
      throw error;
    }
  }

  async getPreview(input: {
    activityId: string;
    previewId: string;
    page: number;
    pageSize: number;
    currentUser: CurrentUserPayload;
  }): Promise<AttendanceImportPreviewRead> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivityRoot(tx, input.activityId);
      await this.assertManagedAttendance(tx, input.activityId, input.currentUser);
      const job = await tx.activityBatchJob.findFirst({
        where: {
          id: input.previewId,
          activityId: input.activityId,
          jobTypeCode: ATTENDANCE_IMPORT_PREVIEW_JOB_TYPE,
        },
        select: {
          id: true,
          statusCode: true,
          total: true,
          succeeded: true,
          failed: true,
          skipped: true,
          payload: true,
        },
      });
      if (job === null || !isPreviewPayload(job.payload))
        throw new BizException(BizCode.BAD_REQUEST);
      const payload = job.payload;
      const [total, rows] = await Promise.all([
        tx.activityBatchJobItem.count({ where: { jobId: job.id } }),
        tx.activityBatchJobItem.findMany({
          where: { jobId: job.id },
          select: { itemKey: true, statusCode: true, lastErrorCode: true, safeMessage: true },
          orderBy: [{ itemKey: 'asc' }, { id: 'asc' }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
      ]);
      return {
        jobId: job.id,
        statusCode: job.statusCode,
        total: job.total,
        succeeded: job.succeeded,
        failed: job.failed,
        skipped: job.skipped,
        fileDigest: payload.fileDigest,
        parserVersion: payload.parserVersion,
        previewHash: payload.previewHash,
        items: {
          items: rows.map((row) => ({
            line: parsePreviewItemLine(row.itemKey),
            statusCode: row.statusCode,
            lastErrorCode: row.lastErrorCode,
            safeMessage: row.safeMessage,
          })),
          total,
          page: input.page,
          pageSize: input.pageSize,
        },
      };
    });
  }

  /**
   * 把已成功的静态预览转换为一个可领取的 import_execute job。文件本体绝不进入
   * ActivityBatchJob.payload：这里和 worker 各自重新读取同一 internal attachment，
   * 以便 ADV-014 的替换检测既在命令边界也在真正写 PunchEvent 的边界生效。
   */
  async executePreview(
    input: ExecuteAttendanceImportPreviewInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<OnsiteBatchJobReceipt> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    this.assertExecuteInput(input);
    const prepared = await this.prepareExecute(input, currentUser);
    if (prepared.kind === 'replay') return prepared.receipt;

    const parsed = await this.readAndVerifyPinnedPreview(prepared.facts);
    return this.reserveExecuteWithReplay(prepared.facts, parsed, currentUser, auditMeta);
  }

  /** Called only by the existing leased ActivityBatchWorker. */
  async processImportExecuteJob(input: {
    jobId: string;
    activityId: string;
    fence: AttendanceImportExecuteLeaseFence;
  }): Promise<AttendanceImportExecuteRunResult> {
    const source = await this.loadImportExecuteSource(input);
    let parsed: ParsedImportCsv;
    try {
      parsed = await this.readAndVerifyPinnedPreview({
        activityId: source.activityId,
        previewId: source.payload.previewId,
        sessionId: source.sessionId,
        operationKey: '',
        requestHash: source.requestHash ?? '',
        fileDigest: source.payload.fileDigest,
        parserVersion: source.payload.parserVersion,
        previewHash: source.payload.previewHash,
        ruleSnapshotHash: source.payload.ruleSnapshotHash,
        reason: source.payload.reason,
        actorUserId: source.payload.actorUserId,
        actorMemberId: source.payload.actorMemberId,
      });
    } catch (error) {
      if (
        error instanceof BizException &&
        error.biz.code === BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH.code
      ) {
        return this.failImportExecuteForPreviewMismatch(input);
      }
      throw error;
    }

    const rowsByLine = new Map(parsed.rows.map((row) => [row.line, row]));
    const candidates = await this.prisma.activityBatchJobItem.findMany({
      where: { jobId: input.jobId, statusCode: 'pending' },
      select: { id: true },
      orderBy: [{ itemKey: 'asc' }, { id: 'asc' }],
    });
    let itemsProcessed = 0;
    let itemsSkipped = 0;
    let itemsFailed = 0;
    for (const candidate of candidates) {
      const result = await this.processImportExecuteItem({
        ...input,
        itemId: candidate.id,
        rowsByLine,
      });
      if (result.kind === 'succeeded') {
        itemsProcessed += 1;
        continue;
      }
      if (result.kind === 'failed') {
        itemsFailed += 1;
        continue;
      }
      if (result.kind === 'authorization_revoked') {
        itemsSkipped += 1;
        itemsSkipped += await this.skipPendingImportExecuteItems(input);
        break;
      }
    }
    const finalized = await this.finalizeImportExecuteJob(input);
    return { itemsProcessed, itemsSkipped, itemsFailed, statusCode: finalized.statusCode };
  }

  private assertExecuteInput(input: ExecuteAttendanceImportPreviewInput): void {
    if (
      !ATTENDANCE_IMPORT_OPERATION_KEY_PATTERN.test(input.operationKey) ||
      !isSha256(input.fileDigest) ||
      !isSha256(input.previewHash) ||
      input.parserVersion !== ATTENDANCE_IMPORT_CSV_PARSER_VERSION
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
  }

  private async prepareExecute(
    input: ExecuteAttendanceImportPreviewInput,
    currentUser: CurrentUserPayload,
  ): Promise<
    { kind: 'replay'; receipt: OnsiteBatchJobReceipt } | { kind: 'new'; facts: ExecutePreviewFacts }
  > {
    const operationKey = `b6:import-execute:${input.activityId}:${input.operationKey}`;
    const requestHash = createExecuteRequestHash({
      activityId: input.activityId,
      previewId: input.previewId,
      actorUserId: currentUser.id,
      fileDigest: input.fileDigest,
      parserVersion: input.parserVersion,
      previewHash: input.previewHash,
    });
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivityRoot(tx, input.activityId);
      await this.assertManagedAttendance(tx, input.activityId, currentUser);
      const existing = await tx.activityBatchJob.findUnique({
        where: { operationKey },
        select: {
          id: true,
          activityId: true,
          sessionId: true,
          jobTypeCode: true,
          statusCode: true,
          requestHash: true,
          total: true,
          succeeded: true,
          failed: true,
          skipped: true,
          payload: true,
        },
      });
      if (existing !== null) {
        if (
          existing.activityId !== input.activityId ||
          existing.jobTypeCode !== ATTENDANCE_IMPORT_EXECUTE_JOB_TYPE ||
          existing.requestHash !== requestHash ||
          !isExecutePayload(existing.payload) ||
          existing.payload.previewId !== input.previewId ||
          existing.payload.fileDigest !== input.fileDigest ||
          existing.payload.parserVersion !== input.parserVersion ||
          existing.payload.previewHash !== input.previewHash
        ) {
          throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
        }
        return { kind: 'replay' as const, receipt: receiptFromJob(existing, true) };
      }
      const preview = await tx.activityBatchJob.findFirst({
        where: {
          id: input.previewId,
          activityId: input.activityId,
          jobTypeCode: ATTENDANCE_IMPORT_PREVIEW_JOB_TYPE,
        },
        select: { id: true, sessionId: true, statusCode: true, payload: true },
      });
      if (preview === null || preview.sessionId === null || !isPreviewPayload(preview.payload)) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
      if (preview.statusCode !== 'succeeded') throw new BizException(BizCode.BAD_REQUEST);
      const payload = preview.payload;
      if (
        payload.fileDigest !== input.fileDigest ||
        payload.parserVersion !== input.parserVersion ||
        payload.previewHash !== input.previewHash
      ) {
        throw new BizException(BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH);
      }
      return {
        kind: 'new' as const,
        facts: {
          activityId: input.activityId,
          previewId: preview.id,
          sessionId: preview.sessionId,
          operationKey,
          requestHash,
          fileDigest: payload.fileDigest,
          parserVersion: payload.parserVersion,
          previewHash: payload.previewHash,
          ruleSnapshotHash: payload.ruleSnapshotHash,
          reason: payload.reason,
          actorUserId: currentUser.id,
          actorMemberId: currentUser.memberId!,
        },
      };
    });
  }

  private async readAndVerifyPinnedPreview(facts: ExecutePreviewFacts): Promise<ParsedImportCsv> {
    const body = await this.attachments.readForExecuteOutsideTransaction({
      previewJobId: facts.previewId,
      expectedFileDigest: facts.fileDigest,
    });
    if (body === null || sha256(body) !== facts.fileDigest) {
      throw new BizException(BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH);
    }
    const parsed = parseAttendanceImportCsv(body);
    if (parsed.rows.some((row) => !row.valid)) {
      throw new BizException(BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH);
    }
    const previewHash = createPreviewHash({
      rows: parsed.rows,
      activityId: facts.activityId,
      sessionId: facts.sessionId,
      reason: facts.reason,
      fileDigest: facts.fileDigest,
      ruleSnapshotHash: facts.ruleSnapshotHash,
    });
    if (previewHash !== facts.previewHash) {
      throw new BizException(BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH);
    }
    return parsed;
  }

  private async reserveExecuteWithReplay(
    facts: ExecutePreviewFacts,
    parsed: ParsedImportCsv,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<OnsiteBatchJobReceipt> {
    try {
      return await this.reserveExecute(facts, parsed, currentUser, auditMeta);
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      return this.reserveExecute(facts, parsed, currentUser, auditMeta);
    }
  }

  private async reserveExecute(
    facts: ExecutePreviewFacts,
    parsed: ParsedImportCsv,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<OnsiteBatchJobReceipt> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivityRoot(tx, facts.activityId);
      await this.assertManagedAttendance(tx, facts.activityId, currentUser);
      const existing = await tx.activityBatchJob.findUnique({
        where: { operationKey: facts.operationKey },
        select: {
          id: true,
          activityId: true,
          jobTypeCode: true,
          requestHash: true,
          statusCode: true,
          total: true,
          succeeded: true,
          failed: true,
          skipped: true,
          payload: true,
        },
      });
      if (existing !== null) {
        if (
          existing.activityId !== facts.activityId ||
          existing.jobTypeCode !== ATTENDANCE_IMPORT_EXECUTE_JOB_TYPE ||
          existing.requestHash !== facts.requestHash ||
          !isExecutePayload(existing.payload) ||
          existing.payload.previewId !== facts.previewId ||
          existing.payload.fileDigest !== facts.fileDigest ||
          existing.payload.previewHash !== facts.previewHash
        ) {
          throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
        }
        return receiptFromJob(existing, true);
      }
      const preview = await tx.activityBatchJob.findFirst({
        where: {
          id: facts.previewId,
          activityId: facts.activityId,
          sessionId: facts.sessionId,
          jobTypeCode: ATTENDANCE_IMPORT_PREVIEW_JOB_TYPE,
          statusCode: 'succeeded',
        },
        select: { payload: true },
      });
      if (
        preview === null ||
        !isPreviewPayload(preview.payload) ||
        preview.payload.fileDigest !== facts.fileDigest ||
        preview.payload.parserVersion !== facts.parserVersion ||
        preview.payload.previewHash !== facts.previewHash ||
        preview.payload.ruleSnapshotHash !== facts.ruleSnapshotHash ||
        preview.payload.reason !== facts.reason
      ) {
        throw new BizException(BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH);
      }
      await this.assertPreviewRowsMatch(tx, facts.previewId, parsed.rows);
      const payload: Prisma.InputJsonObject = {
        action: ATTENDANCE_IMPORT_EXECUTE_ACTION,
        previewId: facts.previewId,
        fileDigest: facts.fileDigest,
        parserVersion: facts.parserVersion,
        previewHash: facts.previewHash,
        ruleSnapshotHash: facts.ruleSnapshotHash,
        reason: facts.reason,
        actorUserId: facts.actorUserId,
        actorMemberId: facts.actorMemberId,
      };
      const job = await tx.activityBatchJob.create({
        data: {
          jobTypeCode: ATTENDANCE_IMPORT_EXECUTE_JOB_TYPE,
          activityId: facts.activityId,
          sessionId: facts.sessionId,
          statusCode: 'pending',
          operationKey: facts.operationKey,
          requestHash: facts.requestHash,
          payloadVersion: ATTENDANCE_IMPORT_EXECUTE_PAYLOAD_VERSION,
          payload,
          total: parsed.rows.length,
          // 写与判同源:`ActivityBatchWorker.claimJob` 用应用时钟比 `availableAt`,
          // 故入队显式写应用时钟,不吃列上的 `@default(now())`(数据库时钟)。
          availableAt: new Date(),
          createdByUserId: currentUser.id,
        },
        select: {
          id: true,
          statusCode: true,
          total: true,
          succeeded: true,
          failed: true,
          skipped: true,
        },
      });
      await tx.activityBatchJobItem.createMany({
        data: parsed.rows.map((row) => ({
          jobId: job.id,
          itemKey: `preview:${facts.previewId}:line:${row.line}`,
          statusCode: 'pending',
          resourceType: 'activity_participation_identity',
          resourceId: row.participationIdentityId,
          payloadHash: row.rowHash,
        })),
      });
      await this.audit.logOnsiteBatchJob({
        operation: 'attendance-import.execute',
        activityId: facts.activityId,
        sessionId: facts.sessionId,
        jobId: job.id,
        total: job.total,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });
      return receiptFromJob(job, false);
    });
  }

  private async assertPreviewRowsMatch(
    tx: PrismaTx,
    previewId: string,
    parsed: readonly ParsedImportRow[],
  ): Promise<void> {
    const rows = await tx.activityBatchJobItem.findMany({
      where: { jobId: previewId },
      select: {
        itemKey: true,
        statusCode: true,
        resourceType: true,
        resourceId: true,
        payloadHash: true,
      },
      orderBy: [{ itemKey: 'asc' }, { id: 'asc' }],
    });
    if (rows.length !== parsed.length) {
      throw new BizException(BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH);
    }
    const expected = [...parsed].sort((left, right) => left.line - right.line);
    for (let index = 0; index < expected.length; index += 1) {
      const row = rows[index];
      const source = expected[index];
      if (
        row === undefined ||
        source === undefined ||
        row.itemKey !== `line:${source.line}` ||
        row.statusCode !== 'succeeded' ||
        row.resourceType !== 'activity_participation_identity' ||
        row.resourceId !== source.participationIdentityId ||
        row.payloadHash !== source.rowHash
      ) {
        throw new BizException(BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH);
      }
    }
  }

  private async loadImportExecuteSource(input: {
    jobId: string;
    activityId: string;
    fence: AttendanceImportExecuteLeaseFence;
  }): Promise<LoadedImportExecuteSource> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivityForImportWorker(tx, input.activityId);
      const now = await this.readAuthoritativeNow(tx);
      const job = await this.lockAndVerifyImportExecuteJob(tx, input, now);
      const payload = requireExecutePayload(job.payload);
      const preview = await tx.activityBatchJob.findFirst({
        where: {
          id: payload.previewId,
          activityId: job.activityId,
          sessionId: job.sessionId,
          jobTypeCode: ATTENDANCE_IMPORT_PREVIEW_JOB_TYPE,
          statusCode: 'succeeded',
        },
        select: { payload: true },
      });
      if (
        preview === null ||
        !isPreviewPayload(preview.payload) ||
        preview.payload.fileDigest !== payload.fileDigest ||
        preview.payload.parserVersion !== payload.parserVersion ||
        preview.payload.previewHash !== payload.previewHash ||
        preview.payload.ruleSnapshotHash !== payload.ruleSnapshotHash ||
        preview.payload.reason !== payload.reason
      ) {
        throw new BizException(BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH);
      }
      if (job.sessionId === null) this.failClosed();
      return {
        activityId: job.activityId,
        sessionId: job.sessionId,
        requestHash: job.requestHash,
        payload,
      };
    });
  }

  private async processImportExecuteItem(input: {
    jobId: string;
    activityId: string;
    itemId: string;
    fence: AttendanceImportExecuteLeaseFence;
    rowsByLine: ReadonlyMap<number, ParsedImportRow>;
  }): Promise<ImportExecuteItemResult> {
    return this.prisma.$transaction(async (tx) => {
      // Canonical B6 lock order: Activity root → execute job/fence → current actor/responsibility
      // → item → unified PunchCommand's session/identity/segment/evidence/event chain.
      const activity = await this.lockActivityForImportWorker(tx, input.activityId);
      const now = await this.readAuthoritativeNow(tx);
      const job = await this.lockAndVerifyImportExecuteJob(tx, input, now);
      const item = await this.lockImportExecuteItem(tx, input.itemId, job.id);
      if (item.statusCode !== 'pending') return { kind: 'already_terminal' };

      await tx.$executeRaw(Prisma.sql`SAVEPOINT attendance_import_execute_item`);
      let savepointOpen = true;
      try {
        if (activity.deletedAt !== null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
        if (activity.statusCode !== 'published')
          throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        const payload = requireExecutePayload(job.payload);
        const line = parseExecuteItemLine(item.itemKey, payload.previewId);
        const row = input.rowsByLine.get(line);
        if (
          row === undefined ||
          !row.valid ||
          row.participationIdentityId === null ||
          row.actionCode === null
        ) {
          this.failClosed();
        }
        this.assertImportExecuteItemInvariant(job, item, payload, row);
        const actor = await this.lockActiveActor(tx, payload.actorUserId, payload.actorMemberId);
        if (
          actor === null ||
          !(await this.hasManagedAttendance(tx, job.activityId, actor.memberId!))
        ) {
          await tx.$executeRaw(Prisma.sql`ROLLBACK TO SAVEPOINT attendance_import_execute_item`);
          await tx.$executeRaw(Prisma.sql`RELEASE SAVEPOINT attendance_import_execute_item`);
          savepointOpen = false;
          await this.markImportExecuteItemSkipped(tx, job, item, input.fence);
          return { kind: 'authorization_revoked' };
        }
        if (job.sessionId === null || row.occurredAt === null) this.failClosed();
        const location = parseImportLocationForExecution(row);
        const receipt = await this.command.managedPunchWithinTransaction(tx, {
          activityId: job.activityId,
          sessionId: job.sessionId,
          participationIdentityId: row.participationIdentityId,
          memberCredential: null,
          actionCode: row.actionCode,
          sourceCode: 'import',
          eventKey: `attendance-import:${job.id}:${item.itemKey}`,
          reason: payload.reason,
          deviceId: null,
          longitude: location.longitude,
          latitude: location.latitude,
          accuracy: location.accuracy,
          occurredAt: new Date(row.occurredAt),
          batchJobItemId: item.id,
          currentUser: actor,
          auditMeta: {
            requestId: `activity-batch-worker:${job.id}:${item.id}`,
            ip: null,
            ua: null,
          },
        });
        await tx.$executeRaw(Prisma.sql`RELEASE SAVEPOINT attendance_import_execute_item`);
        savepointOpen = false;
        await this.markImportExecuteItemSucceeded(tx, job, item, input.fence, receipt.eventId);
        return { kind: 'succeeded' };
      } catch (error) {
        if (savepointOpen) {
          await tx.$executeRaw(Prisma.sql`ROLLBACK TO SAVEPOINT attendance_import_execute_item`);
          await tx.$executeRaw(Prisma.sql`RELEASE SAVEPOINT attendance_import_execute_item`);
          savepointOpen = false;
        }
        if (error instanceof BizException) {
          await this.markImportExecuteItemFailed(tx, job, item, input.fence, error);
          return { kind: 'failed' };
        }
        throw error;
      }
    });
  }

  private async skipPendingImportExecuteItems(input: {
    jobId: string;
    activityId: string;
    fence: AttendanceImportExecuteLeaseFence;
  }): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivityForImportWorker(tx, input.activityId);
      const now = await this.readAuthoritativeNow(tx);
      const job = await this.lockAndVerifyImportExecuteJob(tx, input, now);
      const skipped = await tx.activityBatchJobItem.updateMany({
        where: { jobId: job.id, statusCode: 'pending' },
        data: {
          statusCode: 'skipped',
          attempts: { increment: 1 },
          lastErrorCode: `BizException:${BizCode.RBAC_FORBIDDEN.code}`,
          safeMessage: BizCode.RBAC_FORBIDDEN.message,
        },
      });
      if (skipped.count === 0) return 0;
      await this.incrementImportExecuteCounter(tx, job, input.fence, 'skipped', skipped.count);
      return skipped.count;
    });
  }

  private async finalizeImportExecuteJob(input: {
    jobId: string;
    activityId: string;
    fence: AttendanceImportExecuteLeaseFence;
  }): Promise<Pick<AttendanceImportExecuteRunResult, 'statusCode'>> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivityForImportWorker(tx, input.activityId);
      const now = await this.readAuthoritativeNow(tx);
      const job = await this.lockAndVerifyImportExecuteJob(tx, input, now);
      const items = await tx.activityBatchJobItem.findMany({
        where: { jobId: job.id },
        select: { statusCode: true },
        orderBy: [{ itemKey: 'asc' }, { id: 'asc' }],
      });
      if (items.length !== job.total) this.failClosed();
      const succeeded = items.filter((item) => item.statusCode === 'succeeded').length;
      const failed = items.filter((item) => item.statusCode === 'failed').length;
      const skipped = items.filter((item) => item.statusCode === 'skipped').length;
      if (succeeded + failed + skipped !== job.total) this.failClosed();
      if (job.succeeded !== succeeded || job.failed !== failed || job.skipped !== skipped) {
        this.failClosed();
      }
      const statusCode: AttendanceImportExecuteRunResult['statusCode'] =
        succeeded === job.total ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial_failed';
      const updated = await tx.activityBatchJob.updateMany({
        where: {
          id: job.id,
          statusCode: 'processing',
          leaseOwner: input.fence.leaseOwner,
          leaseGeneration: input.fence.leaseGeneration,
        },
        data: {
          statusCode,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          lastErrorCode: null,
        },
      });
      if (updated.count !== 1) throw new AttendanceImportExecuteLeaseLostError();
      return { statusCode };
    });
  }

  private async failImportExecuteForPreviewMismatch(input: {
    jobId: string;
    activityId: string;
    fence: AttendanceImportExecuteLeaseFence;
  }): Promise<AttendanceImportExecuteRunResult> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivityForImportWorker(tx, input.activityId);
      const now = await this.readAuthoritativeNow(tx);
      const job = await this.lockAndVerifyImportExecuteJob(tx, input, now);
      const failedItems = await tx.activityBatchJobItem.updateMany({
        where: { jobId: job.id, statusCode: 'pending' },
        data: {
          statusCode: 'failed',
          attempts: { increment: 1 },
          lastErrorCode: `BizException:${BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH.code}`,
          safeMessage: BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH.message,
        },
      });
      const failed = job.failed + failedItems.count;
      if (job.succeeded + failed + job.skipped !== job.total) this.failClosed();
      const statusCode: AttendanceImportExecuteRunResult['statusCode'] =
        job.succeeded === 0 ? 'failed' : 'partial_failed';
      const updated = await tx.activityBatchJob.updateMany({
        where: {
          id: job.id,
          statusCode: 'processing',
          leaseOwner: input.fence.leaseOwner,
          leaseGeneration: input.fence.leaseGeneration,
        },
        data: {
          statusCode,
          failed,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          lastErrorCode: `BizException:${BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH.code}`,
        },
      });
      if (updated.count !== 1) throw new AttendanceImportExecuteLeaseLostError();
      return {
        itemsProcessed: 0,
        itemsSkipped: 0,
        itemsFailed: failedItems.count,
        statusCode,
      };
    });
  }

  private async lockAndVerifyImportExecuteJob(
    tx: PrismaTx,
    input: { jobId: string; activityId: string; fence: AttendanceImportExecuteLeaseFence },
    now: Date,
  ): Promise<LockedImportExecuteJob> {
    const rows = await tx.$queryRaw<LockedImportExecuteJob[]>(Prisma.sql`
      SELECT
        "id", "activityId", "sessionId", "jobTypeCode", "statusCode", "requestHash", "payload",
        "total", "succeeded", "failed", "skipped", "leaseOwner", "leaseGeneration", "leaseExpiresAt"
      FROM "ActivityBatchJob"
      WHERE "id" = ${input.jobId}
      FOR UPDATE
    `);
    const job = rows[0];
    if (
      rows.length !== 1 ||
      job === undefined ||
      job.activityId !== input.activityId ||
      job.jobTypeCode !== ATTENDANCE_IMPORT_EXECUTE_JOB_TYPE ||
      job.statusCode !== 'processing' ||
      job.leaseOwner !== input.fence.leaseOwner ||
      job.leaseGeneration !== input.fence.leaseGeneration ||
      job.leaseExpiresAt === null ||
      job.leaseExpiresAt.getTime() <= now.getTime()
    ) {
      throw new AttendanceImportExecuteLeaseLostError();
    }
    if (job.sessionId === null || job.requestHash === null || !isExecutePayload(job.payload)) {
      this.failClosed();
    }
    return job;
  }

  private async lockImportExecuteItem(
    tx: PrismaTx,
    itemId: string,
    jobId: string,
  ): Promise<LockedImportExecuteItem> {
    const rows = await tx.$queryRaw<LockedImportExecuteItem[]>(Prisma.sql`
      SELECT "id", "itemKey", "statusCode", "resourceType", "resourceId", "payloadHash"
      FROM "ActivityBatchJobItem"
      WHERE "id" = ${itemId} AND "jobId" = ${jobId}
      FOR UPDATE
    `);
    if (rows.length !== 1 || rows[0] === undefined) this.failClosed();
    return rows[0];
  }

  private async lockActivityForImportWorker(
    tx: PrismaTx,
    activityId: string,
  ): Promise<{ deletedAt: Date | null; statusCode: string }> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; deletedAt: Date | null; statusCode: string }>
    >(
      Prisma.sql`
        SELECT "id", "deletedAt", "statusCode"
        FROM "Activity"
        WHERE "id" = ${activityId}
        FOR UPDATE
      `,
    );
    if (rows.length !== 1 || rows[0] === undefined) this.failClosed();
    return rows[0];
  }

  private async lockActiveActor(
    tx: PrismaTx,
    userId: string,
    memberId: string,
  ): Promise<CurrentUserPayload | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; username: string; role: Role; status: UserStatus; memberId: string }>
    >(Prisma.sql`
      SELECT u."id", u."username", u."role", u."status", u."memberId"
      FROM "User" u
      INNER JOIN "Member" m ON m."id" = u."memberId"
      WHERE u."id" = ${userId}
        AND u."memberId" = ${memberId}
        AND u."status" = 'ACTIVE'
        AND u."deletedAt" IS NULL
        AND m."status" = 'ACTIVE'
        AND m."deletedAt" IS NULL
      FOR SHARE OF u, m
    `);
    const actor = rows[0];
    if (rows.length !== 1 || actor === undefined) return null;
    return actor;
  }

  private async hasManagedAttendance(
    tx: PrismaTx,
    activityId: string,
    memberId: string,
  ): Promise<boolean> {
    const assignments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "activity_responsibility_assignments"
      WHERE "activityId" = ${activityId}
        AND "memberId" = ${memberId}
        AND "status" = 'active'
        AND "canManageAttendance" = true
      ORDER BY "id" ASC
      FOR SHARE
    `);
    return assignments.length > 0;
  }

  private assertImportExecuteItemInvariant(
    job: LockedImportExecuteJob,
    item: LockedImportExecuteItem,
    payload: ImportExecutePayload,
    row: ParsedImportRow,
  ): void {
    if (
      job.requestHash === null ||
      !row.valid ||
      row.participationIdentityId === null ||
      item.resourceType !== 'activity_participation_identity' ||
      item.resourceId !== row.participationIdentityId ||
      item.itemKey !== `preview:${payload.previewId}:line:${row.line}` ||
      item.payloadHash !== row.rowHash
    ) {
      this.failClosed();
    }
  }

  private async markImportExecuteItemSucceeded(
    tx: PrismaTx,
    job: LockedImportExecuteJob,
    item: LockedImportExecuteItem,
    fence: AttendanceImportExecuteLeaseFence,
    eventId: string,
  ): Promise<void> {
    const updated = await tx.activityBatchJobItem.updateMany({
      where: { id: item.id, jobId: job.id, statusCode: 'pending' },
      data: {
        statusCode: 'succeeded',
        attempts: { increment: 1 },
        resultReference: eventId,
        lastErrorCode: null,
        safeMessage: null,
      },
    });
    if (updated.count !== 1) throw new AttendanceImportExecuteLeaseLostError();
    await this.incrementImportExecuteCounter(tx, job, fence, 'succeeded', 1);
  }

  private async markImportExecuteItemFailed(
    tx: PrismaTx,
    job: LockedImportExecuteJob,
    item: LockedImportExecuteItem,
    fence: AttendanceImportExecuteLeaseFence,
    error: BizException,
  ): Promise<void> {
    const updated = await tx.activityBatchJobItem.updateMany({
      where: { id: item.id, jobId: job.id, statusCode: 'pending' },
      data: {
        statusCode: 'failed',
        attempts: { increment: 1 },
        lastErrorCode: `BizException:${error.biz.code}`,
        safeMessage: error.biz.message,
      },
    });
    if (updated.count !== 1) throw new AttendanceImportExecuteLeaseLostError();
    await this.incrementImportExecuteCounter(tx, job, fence, 'failed', 1);
  }

  private async markImportExecuteItemSkipped(
    tx: PrismaTx,
    job: LockedImportExecuteJob,
    item: LockedImportExecuteItem,
    fence: AttendanceImportExecuteLeaseFence,
  ): Promise<void> {
    const updated = await tx.activityBatchJobItem.updateMany({
      where: { id: item.id, jobId: job.id, statusCode: 'pending' },
      data: {
        statusCode: 'skipped',
        attempts: { increment: 1 },
        lastErrorCode: `BizException:${BizCode.RBAC_FORBIDDEN.code}`,
        safeMessage: BizCode.RBAC_FORBIDDEN.message,
      },
    });
    if (updated.count !== 1) throw new AttendanceImportExecuteLeaseLostError();
    await this.incrementImportExecuteCounter(tx, job, fence, 'skipped', 1);
  }

  private async incrementImportExecuteCounter(
    tx: PrismaTx,
    job: LockedImportExecuteJob,
    fence: AttendanceImportExecuteLeaseFence,
    counter: 'succeeded' | 'failed' | 'skipped',
    amount: number,
  ): Promise<void> {
    const data: Prisma.ActivityBatchJobUpdateManyMutationInput =
      counter === 'succeeded'
        ? { succeeded: { increment: amount } }
        : counter === 'failed'
          ? { failed: { increment: amount } }
          : { skipped: { increment: amount } };
    const updated = await tx.activityBatchJob.updateMany({
      where: {
        id: job.id,
        statusCode: 'processing',
        leaseOwner: fence.leaseOwner,
        leaseGeneration: fence.leaseGeneration,
      },
      data,
    });
    if (updated.count !== 1) throw new AttendanceImportExecuteLeaseLostError();
  }

  private async reservePreviewWithReplay(
    input: CreateAttendanceImportPreviewInput & {
      reason: string;
      fileDigest: string;
      parsed: ParsedImportCsv;
    },
    currentUser: CurrentUserPayload,
  ): Promise<{ facts: PreviewFacts; replayed: boolean; receipt: OnsiteBatchJobReceipt }> {
    try {
      return await this.reservePreview(input, currentUser);
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      return this.reservePreview(input, currentUser);
    }
  }

  private async reservePreview(
    input: CreateAttendanceImportPreviewInput & {
      reason: string;
      fileDigest: string;
      parsed: ParsedImportCsv;
    },
    currentUser: CurrentUserPayload,
  ): Promise<{ facts: PreviewFacts; replayed: boolean; receipt: OnsiteBatchJobReceipt }> {
    return this.prisma.$transaction(async (tx) => {
      const activity = await this.lockActivityRoot(tx, input.activityId);
      await this.assertManagedAttendance(tx, input.activityId, currentUser);
      await this.assertSession(tx, input.activityId, input.sessionId);
      const ruleSnapshot = await tx.activityRuleSnapshot.findUnique({
        where: {
          activityId_workflowRevision: {
            activityId: input.activityId,
            workflowRevision: activity.workflowRevision,
          },
        },
        select: { snapshotHash: true },
      });
      if (ruleSnapshot === null || !/^[0-9a-f]{64}$/u.test(ruleSnapshot.snapshotHash)) {
        this.failClosed();
      }
      const requestHash = createPreviewRequestHash({
        activityId: input.activityId,
        sessionId: input.sessionId,
        actorUserId: currentUser.id,
        reason: input.reason,
        fileDigest: input.fileDigest,
        ruleSnapshotHash: ruleSnapshot.snapshotHash,
      });
      const previewHash = createPreviewHash({
        rows: input.parsed.rows,
        activityId: input.activityId,
        sessionId: input.sessionId,
        reason: input.reason,
        fileDigest: input.fileDigest,
        ruleSnapshotHash: ruleSnapshot.snapshotHash,
      });
      const operationKey = `b6:import-preview:${input.activityId}:${input.operationKey}`;
      const existing = await tx.activityBatchJob.findUnique({
        where: { operationKey },
        select: {
          id: true,
          activityId: true,
          sessionId: true,
          jobTypeCode: true,
          statusCode: true,
          requestHash: true,
          total: true,
          succeeded: true,
          failed: true,
          skipped: true,
          payload: true,
        },
      });
      if (existing !== null) {
        if (
          existing.activityId !== input.activityId ||
          existing.sessionId !== input.sessionId ||
          existing.jobTypeCode !== ATTENDANCE_IMPORT_PREVIEW_JOB_TYPE ||
          existing.requestHash !== requestHash ||
          !isPreviewPayload(existing.payload) ||
          existing.payload.previewHash !== previewHash
        ) {
          throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
        }
        return {
          facts: {
            jobId: existing.id,
            operationKey,
            requestHash,
            ruleSnapshotHash: ruleSnapshot.snapshotHash,
            previewHash,
            replayed: true,
          },
          replayed: true,
          receipt: receiptFromJob(existing, true),
        };
      }
      const payload: Prisma.InputJsonObject = {
        action: ATTENDANCE_IMPORT_PREVIEW_ACTION,
        parserVersion: ATTENDANCE_IMPORT_CSV_PARSER_VERSION,
        reason: input.reason,
        fileDigest: input.fileDigest,
        ruleSnapshotHash: ruleSnapshot.snapshotHash,
        previewHash,
        actorUserId: currentUser.id,
        actorMemberId: currentUser.memberId!,
      };
      const job = await tx.activityBatchJob.create({
        data: {
          jobTypeCode: ATTENDANCE_IMPORT_PREVIEW_JOB_TYPE,
          activityId: input.activityId,
          sessionId: input.sessionId,
          statusCode: 'pending',
          operationKey,
          requestHash,
          payloadVersion: 1,
          payload,
          total: 0,
          // import_preview 当前由服务内联推进、不经 `claimJob`,但 `availableAt` 是**列级**判定位:
          // 同一列在同一张表上被应用时钟判定,写侧一律显式,免得将来接进 worker 时静默失配。
          availableAt: new Date(),
          createdByUserId: currentUser.id,
        },
        select: { id: true },
      });
      return {
        facts: {
          jobId: job.id,
          operationKey,
          requestHash,
          ruleSnapshotHash: ruleSnapshot.snapshotHash,
          previewHash,
          replayed: false,
        },
        replayed: false,
        receipt: {
          jobId: job.id,
          statusCode: 'pending',
          total: 0,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          replayed: false,
        },
      };
    });
  }

  private async lockAndAssertPreviewCurrent(
    tx: PrismaTx,
    facts: PreviewFacts,
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<PreviewFacts> {
    await this.lockActivityRoot(tx, activityId);
    await this.assertManagedAttendance(tx, activityId, currentUser);
    const rows = await tx.$queryRaw<
      Array<{ id: string; requestHash: string | null; statusCode: string; action: string | null }>
    >(Prisma.sql`
      SELECT "id", "requestHash", "statusCode", "payload"->>'action' AS "action"
      FROM "ActivityBatchJob"
      WHERE "id" = ${facts.jobId}
      FOR UPDATE
    `);
    const job = rows[0];
    if (
      rows.length !== 1 ||
      job === undefined ||
      job.requestHash !== facts.requestHash ||
      job.statusCode !== 'pending' ||
      job.action !== ATTENDANCE_IMPORT_PREVIEW_ACTION
    ) {
      this.failClosed();
    }
    return facts;
  }

  private async evaluateRowsInTransaction(
    tx: PrismaTx,
    rows: readonly ParsedImportRow[],
    activityId: string,
    sessionId: string,
  ): Promise<ParsedImportRow[]> {
    const ids = rows
      .flatMap((row) =>
        row.valid && row.participationIdentityId !== null ? [row.participationIdentityId] : [],
      )
      .sort(compareUtf8);
    const known = new Set(
      (
        await tx.activityParticipationIdentity.findMany({
          where: { activityId, sessionId, id: { in: [...new Set(ids)] } },
          select: { id: true },
        })
      ).map((identity) => identity.id),
    );
    return rows.map((row) => ({
      ...row,
      valid:
        row.valid && row.participationIdentityId !== null && known.has(row.participationIdentityId),
    }));
  }

  private async markPreviewFailedAfterUploadError(
    facts: PreviewFacts,
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockActivityRoot(tx, activityId);
      await this.assertManagedAttendance(tx, activityId, currentUser);
      await tx.activityBatchJob.updateMany({
        where: { id: facts.jobId, statusCode: 'pending', requestHash: facts.requestHash },
        data: { statusCode: 'failed', completedAt: await this.readAuthoritativeNow(tx) },
      });
    });
  }

  private async lockActivityRoot(
    tx: PrismaTx,
    activityId: string,
  ): Promise<{ workflowRevision: number }> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; statusCode: string; deletedAt: Date | null; workflowRevision: number }>
    >(Prisma.sql`
      SELECT "id", "statusCode", "deletedAt", "workflowRevision"
      FROM "Activity"
      WHERE "id" = ${activityId}
      FOR UPDATE
    `);
    const activity = rows[0];
    if (rows.length !== 1 || activity === undefined || activity.deletedAt !== null) {
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }
    if (activity.statusCode !== 'published')
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    return { workflowRevision: activity.workflowRevision };
  }

  private async assertSession(tx: PrismaTx, activityId: string, sessionId: string): Promise<void> {
    const session = await tx.activitySession.findFirst({
      where: { id: sessionId, activityId },
      select: { id: true },
    });
    if (session === null) throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
  }

  private async assertManagedAttendance(
    tx: PrismaTx,
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const assignments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "activity_responsibility_assignments"
      WHERE "activityId" = ${activityId}
        AND "memberId" = ${currentUser.memberId}
        AND "status" = 'active'
        AND "canManageAttendance" = true
      ORDER BY "id" ASC
      FOR SHARE
    `);
    if (assignments.length === 0) throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private async readAuthoritativeNow(tx: PrismaTx): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ authoritativeNow: Date }>>`
      SELECT now() AS "authoritativeNow"
    `;
    const now = rows[0]?.authoritativeNow;
    if (!now) this.failClosed();
    return now;
  }

  private failClosed(): never {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
}

function parseAttendanceImportCsv(buffer: Buffer): ParsedImportCsv {
  const source = buffer.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(buffer)) {
    return { rows: [invalidRow(1)] };
  }
  const records = parseCsvRecords(source.startsWith('\uFEFF') ? source.slice(1) : source);
  if (records === null || records.length === 0 || !sameHeader(records[0])) {
    return { rows: [invalidRow(1)] };
  }
  const data = records.slice(1);
  if (data.length > ATTENDANCE_IMPORT_CSV_MAX_ROWS) {
    return { rows: [invalidRow(1)] };
  }
  return { rows: data.map((cells, index) => parseImportRow(index + 2, cells)) };
}

function parseImportRow(line: number, cells: readonly string[]): ParsedImportRow {
  const [participationIdentityId, actionCode, occurredAt, longitude, latitude, accuracy] = cells;
  const identity = participationIdentityId?.trim() ?? '';
  const action = actionCode?.trim();
  const parsedTime = occurredAt === undefined ? null : new Date(occurredAt.trim());
  const location = parseLocation(longitude, latitude, accuracy);
  const valid =
    cells.length === ATTENDANCE_IMPORT_CSV_HEADER.length &&
    /^[A-Za-z0-9_-]{8,64}$/u.test(identity) &&
    (action === 'check_in' || action === 'check_out') &&
    parsedTime !== null &&
    Number.isFinite(parsedTime.getTime()) &&
    location !== null;
  const canonical = {
    v: 'attendance-import-csv-row/v1',
    line,
    participationIdentityId: valid ? identity : null,
    actionCode: valid ? action : null,
    occurredAt: valid ? parsedTime.toISOString() : null,
    location:
      location === null
        ? null
        : {
            longitude: location.longitude,
            latitude: location.latitude,
            accuracy: location.accuracy,
          },
  };
  return {
    line,
    participationIdentityId: valid ? identity : null,
    actionCode: valid ? action : null,
    occurredAt: valid ? parsedTime.toISOString() : null,
    longitude: location?.longitude ?? null,
    latitude: location?.latitude ?? null,
    accuracy: location?.accuracy ?? null,
    rowHash: sha256(Buffer.from(stableJson(canonical), 'utf8')),
    valid,
  };
}

function invalidRow(line: number): ParsedImportRow {
  const canonical = {
    v: 'attendance-import-csv-row/v1',
    line,
    participationIdentityId: null,
    actionCode: null,
    occurredAt: null,
    location: null,
  };
  return {
    line,
    participationIdentityId: null,
    actionCode: null,
    occurredAt: null,
    longitude: null,
    latitude: null,
    accuracy: null,
    rowHash: sha256(Buffer.from(stableJson(canonical), 'utf8')),
    valid: false,
  };
}

function parseLocation(
  longitude: string | undefined,
  latitude: string | undefined,
  accuracy: string | undefined,
): { longitude: string | null; latitude: string | null; accuracy: string | null } | null {
  const values = [longitude, latitude, accuracy].map((value) => value?.trim() ?? '');
  if (values.every((value) => value === '')) {
    return { longitude: null, latitude: null, accuracy: null };
  }
  const [rawLongitude, rawLatitude, rawAccuracy] = values;
  if (rawLongitude === '' || rawLatitude === '') return null;
  const parsedLongitude = Number(rawLongitude);
  const parsedLatitude = Number(rawLatitude);
  const parsedAccuracy = rawAccuracy === '' ? null : Number(rawAccuracy);
  if (
    !Number.isFinite(parsedLongitude) ||
    !Number.isFinite(parsedLatitude) ||
    (parsedAccuracy !== null && !Number.isFinite(parsedAccuracy)) ||
    parsedLongitude < -180 ||
    parsedLongitude > 180 ||
    parsedLatitude < -90 ||
    parsedLatitude > 90 ||
    (parsedAccuracy !== null && (parsedAccuracy < 0 || parsedAccuracy > 99_999_999.99))
  ) {
    return null;
  }
  return {
    longitude: parsedLongitude.toFixed(7),
    latitude: parsedLatitude.toFixed(7),
    accuracy: parsedAccuracy === null ? null : parsedAccuracy.toFixed(2),
  };
}

function parseCsvRecords(source: string): string[][] | null {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      if (cell.length !== 0) return null;
      quoted = true;
      continue;
    }
    if (character === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (character === '\n') {
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (character === '\r') {
      if (source[index + 1] === '\n') index += 1;
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += character;
  }
  if (quoted) return null;
  if (cell.length !== 0 || row.length !== 0) {
    row.push(cell);
    records.push(row);
  }
  return records;
}

function sameHeader(row: readonly string[]): boolean {
  return (
    row.length === ATTENDANCE_IMPORT_CSV_HEADER.length &&
    row.every((value, index) => value === ATTENDANCE_IMPORT_CSV_HEADER[index])
  );
}

function createPreviewRequestHash(input: {
  activityId: string;
  sessionId: string;
  actorUserId: string;
  reason: string;
  fileDigest: string;
  ruleSnapshotHash: string;
}): string {
  return sha256(
    Buffer.from(
      stableJson({
        v: 'attendance-import-preview-request/v1',
        activityId: input.activityId,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        reason: input.reason,
        fileDigest: input.fileDigest,
        parserVersion: ATTENDANCE_IMPORT_CSV_PARSER_VERSION,
        ruleSnapshotHash: input.ruleSnapshotHash,
      }),
      'utf8',
    ),
  );
}

function createPreviewHash(input: {
  rows: readonly ParsedImportRow[];
  activityId: string;
  sessionId: string;
  reason: string;
  fileDigest: string;
  ruleSnapshotHash: string;
}): string {
  return sha256(
    Buffer.from(
      stableJson({
        v: 'attendance-import-preview/v1',
        activityId: input.activityId,
        sessionId: input.sessionId,
        reason: input.reason,
        fileDigest: input.fileDigest,
        parserVersion: ATTENDANCE_IMPORT_CSV_PARSER_VERSION,
        ruleSnapshotHash: input.ruleSnapshotHash,
        rows: input.rows.map((row) => ({ line: row.line, rowHash: row.rowHash })),
      }),
      'utf8',
    ),
  );
}

function createExecuteRequestHash(input: {
  activityId: string;
  previewId: string;
  actorUserId: string;
  fileDigest: string;
  parserVersion: string;
  previewHash: string;
}): string {
  return sha256(
    Buffer.from(
      stableJson({
        v: 'attendance-import-execute-request/v1',
        activityId: input.activityId,
        previewId: input.previewId,
        actorUserId: input.actorUserId,
        fileDigest: input.fileDigest,
        parserVersion: input.parserVersion,
        previewHash: input.previewHash,
      }),
      'utf8',
    ),
  );
}

function isPreviewPayload(value: Prisma.JsonValue): value is Prisma.JsonObject & PreviewPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value;
  return (
    payload['action'] === ATTENDANCE_IMPORT_PREVIEW_ACTION &&
    payload['parserVersion'] === ATTENDANCE_IMPORT_CSV_PARSER_VERSION &&
    typeof payload['reason'] === 'string' &&
    isSha256(payload['fileDigest']) &&
    isSha256(payload['ruleSnapshotHash']) &&
    isSha256(payload['previewHash']) &&
    typeof payload['actorUserId'] === 'string' &&
    typeof payload['actorMemberId'] === 'string'
  );
}

function isExecutePayload(
  value: Prisma.JsonValue,
): value is Prisma.JsonObject & ImportExecutePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value;
  return (
    payload['action'] === ATTENDANCE_IMPORT_EXECUTE_ACTION &&
    typeof payload['previewId'] === 'string' &&
    isSha256(payload['fileDigest']) &&
    payload['parserVersion'] === ATTENDANCE_IMPORT_CSV_PARSER_VERSION &&
    isSha256(payload['previewHash']) &&
    isSha256(payload['ruleSnapshotHash']) &&
    typeof payload['reason'] === 'string' &&
    typeof payload['actorUserId'] === 'string' &&
    typeof payload['actorMemberId'] === 'string'
  );
}

function requireExecutePayload(value: Prisma.JsonValue): ImportExecutePayload {
  if (!isExecutePayload(value)) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  return value;
}

function receiptFromJob(
  job: {
    id: string;
    statusCode: string;
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  },
  replayed: boolean,
): OnsiteBatchJobReceipt {
  return {
    jobId: job.id,
    statusCode: job.statusCode,
    total: job.total,
    succeeded: job.succeeded,
    failed: job.failed,
    skipped: job.skipped,
    replayed,
  };
}

function parsePreviewItemLine(itemKey: string): number {
  const match = /^line:([1-9]\d*)$/u.exec(itemKey);
  if (match?.[1] === undefined) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const line = Number(match[1]);
  if (!Number.isSafeInteger(line)) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  return line;
}

function parseExecuteItemLine(itemKey: string, previewId: string): number {
  const match = /^preview:([^:]+):line:([1-9]\d*)$/u.exec(itemKey);
  if (match?.[1] !== previewId || match[2] === undefined) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line)) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  return line;
}

function parseImportLocationForExecution(row: ParsedImportRow): {
  longitude: number | null;
  latitude: number | null;
  accuracy: number | null;
} {
  if (row.longitude === null && row.latitude === null && row.accuracy === null) {
    return { longitude: null, latitude: null, accuracy: null };
  }
  if (row.longitude === null || row.latitude === null) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const longitude = Number(row.longitude);
  const latitude = Number(row.latitude);
  const accuracy = row.accuracy === null ? null : Number(row.accuracy);
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    (accuracy !== null && !Number.isFinite(accuracy))
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  return { longitude, latitude, accuracy };
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareUtf8)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('unsupported attendance import canonical value');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isSha256(value: Prisma.JsonValue | undefined): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

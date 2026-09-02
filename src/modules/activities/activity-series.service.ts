import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityAccessService } from './activity-access.service';
import { ActivityFromTemplateService } from './activity-from-template.service';
import { ActivitySeriesAuditRecorder } from './activity-series-audit-recorder';
import {
  buildActivitySeriesRequestHash,
  isActivitySeriesStatusCode,
  normalizeCreateActivitySeriesCommand,
  normalizeGenerateActivitySeriesInstancesCommand,
  normalizeReviseActivitySeriesCommand,
  normalizeSetActivitySeriesStatusCommand,
  toActivitySeriesRevisionHashPayload,
  type ActivitySeriesCommandCode,
  type ActivitySeriesCommandResult,
  type CreateActivitySeriesCommand,
  type GenerateActivitySeriesInstancesCommand,
  type NormalizedActivitySeriesRevisionInput,
  type ReviseActivitySeriesCommand,
  type SetActivitySeriesStatusCommand,
} from './activity-series-command';
import {
  currentActivitySeriesLocalDate,
  generateActivitySeriesOccurrenceCandidates,
  normalizeActivitySeriesLocalDate,
  normalizeStoredActivitySeriesSchedule,
} from './activity-series-schedule';

export type {
  ActivitySeriesCommandResult,
  CreateActivitySeriesCommand,
  GenerateActivitySeriesInstancesCommand,
  ReviseActivitySeriesCommand,
  SetActivitySeriesStatusCommand,
} from './activity-series-command';

function badRequest(): never {
  throw new BizException(BizCode.BAD_REQUEST);
}

function dateForDatabase(localDate: string): Date {
  const result = new Date(`${localDate}T00:00:00.000Z`);
  if (Number.isNaN(result.getTime())) badRequest();
  return result;
}

function localDateFromDatabase(value: Date): string {
  if (Number.isNaN(value.getTime())) badRequest();
  return normalizeActivitySeriesLocalDate(value.toISOString().slice(0, 10));
}

@Injectable()
export class ActivitySeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityAccessService,
    private readonly fromTemplate: ActivityFromTemplateService,
    private readonly auditRecorder: ActivitySeriesAuditRecorder,
  ) {}

  async create(
    command: CreateActivitySeriesCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivitySeriesCommandResult> {
    await this.access.assertCanOrThrow(user, 'activity.create.record');
    const input = normalizeCreateActivitySeriesCommand(command);
    const hash = buildActivitySeriesRequestHash('create_series', user.id, input.operationKey, {
      code: input.code,
      revision: toActivitySeriesRevisionHashPayload(input),
    });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await this.findReplay(tx, 'create_series', input.operationKey, hash);
        if (replay) return replay;

        await this.access.assertOrganizationValidAndNonRoot(input.organizationId, tx);
        const template = await this.fromTemplate.validateExactTemplateVersionWithinTransaction({
          tx,
          templateVersionId: input.templateVersionId,
        });
        const series = await tx.activitySeries.create({
          data: { code: input.code, statusCode: 'active' },
          select: { id: true, statusCode: true },
        });
        const revision = await tx.activitySeriesRevision.create({
          data: this.revisionCreateData({
            seriesId: series.id,
            revision: 1,
            input,
            templateDefinitionHash: template.definitionHash,
            createdByUserId: user.id,
          }),
          select: { id: true, revision: true },
        });
        const result = this.result(series.id, revision.revision, series.statusCode, []);
        await this.persistReceipt(tx, {
          commandCode: 'create_series',
          operationKey: input.operationKey,
          requestHash: hash,
          seriesId: series.id,
          revisionId: revision.id,
          result,
        });
        await this.auditRecorder.logSeriesCommand({
          operation: 'create_series',
          seriesId: series.id,
          revision: revision.revision,
          statusCode: series.statusCode,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return result;
      });
    } catch (error) {
      return this.recoverReplayOrThrow(error, 'create_series', input.operationKey, hash);
    }
  }

  async revise(
    command: ReviseActivitySeriesCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivitySeriesCommandResult> {
    await this.access.assertCanOrThrow(user, 'activity.create.record');
    const input = normalizeReviseActivitySeriesCommand(command);
    const hash = buildActivitySeriesRequestHash('revise_series', user.id, input.operationKey, {
      seriesId: input.seriesId,
      revision: toActivitySeriesRevisionHashPayload(input),
    });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await this.findReplay(tx, 'revise_series', input.operationKey, hash);
        if (replay) return replay;

        const series = await this.lockSeries(tx, input.seriesId);
        const replayAfterLock = await this.findReplay(
          tx,
          'revise_series',
          input.operationKey,
          hash,
        );
        if (replayAfterLock) return replayAfterLock;
        if (series.statusCode === 'terminated') badRequest();

        const previousRevision = await this.lockLatestRevision(tx, series.id);
        const previousEnd = localDateFromDatabase(previousRevision.effectiveToLocalDate);
        if (input.effectiveFromLocalDate <= previousEnd) badRequest();
        await this.access.assertOrganizationValidAndNonRoot(input.organizationId, tx);
        const template = await this.fromTemplate.validateExactTemplateVersionWithinTransaction({
          tx,
          templateVersionId: input.templateVersionId,
        });
        const revision = await tx.activitySeriesRevision.create({
          data: this.revisionCreateData({
            seriesId: series.id,
            revision: previousRevision.revision + 1,
            input,
            templateDefinitionHash: template.definitionHash,
            createdByUserId: user.id,
          }),
          select: { id: true, revision: true },
        });
        const result = this.result(series.id, revision.revision, series.statusCode, []);
        await this.persistReceipt(tx, {
          commandCode: 'revise_series',
          operationKey: input.operationKey,
          requestHash: hash,
          seriesId: series.id,
          revisionId: revision.id,
          result,
        });
        await this.auditRecorder.logSeriesCommand({
          operation: 'revise_series',
          seriesId: series.id,
          revision: revision.revision,
          statusCode: series.statusCode,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return result;
      });
    } catch (error) {
      return this.recoverReplayOrThrow(error, 'revise_series', input.operationKey, hash);
    }
  }

  async setStatus(
    command: SetActivitySeriesStatusCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivitySeriesCommandResult> {
    await this.access.assertCanOrThrow(user, 'activity.create.record');
    const input = normalizeSetActivitySeriesStatusCommand(command);
    const hash = buildActivitySeriesRequestHash('set_series_status', user.id, input.operationKey, {
      seriesId: input.seriesId,
      statusCode: input.statusCode,
    });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await this.findReplay(tx, 'set_series_status', input.operationKey, hash);
        if (replay) return replay;

        const series = await this.lockSeries(tx, input.seriesId);
        const replayAfterLock = await this.findReplay(
          tx,
          'set_series_status',
          input.operationKey,
          hash,
        );
        if (replayAfterLock) return replayAfterLock;
        if (series.statusCode === 'terminated' || series.statusCode === input.statusCode)
          badRequest();

        const updated = await tx.activitySeries.update({
          where: { id: series.id },
          data: { statusCode: input.statusCode },
          select: { id: true, statusCode: true },
        });
        const result = this.result(updated.id, null, updated.statusCode, []);
        await this.persistReceipt(tx, {
          commandCode: 'set_series_status',
          operationKey: input.operationKey,
          requestHash: hash,
          seriesId: updated.id,
          revisionId: null,
          result,
        });
        await this.auditRecorder.logSeriesCommand({
          operation: 'set_series_status',
          seriesId: updated.id,
          statusCode: updated.statusCode,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return result;
      });
    } catch (error) {
      return this.recoverReplayOrThrow(error, 'set_series_status', input.operationKey, hash);
    }
  }

  async generate(
    command: GenerateActivitySeriesInstancesCommand,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivitySeriesCommandResult> {
    await this.access.assertCanOrThrow(user, 'activity.create.record');
    const input = normalizeGenerateActivitySeriesInstancesCommand(command);
    const hash = buildActivitySeriesRequestHash('generate_instances', user.id, input.operationKey, {
      seriesId: input.seriesId,
      revision: input.revision,
      fromLocalDate: input.fromLocalDate,
      count: input.count,
    });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await this.findReplay(tx, 'generate_instances', input.operationKey, hash);
        if (replay) return replay;

        const series = await this.lockSeries(tx, input.seriesId);
        const replayAfterLock = await this.findReplay(
          tx,
          'generate_instances',
          input.operationKey,
          hash,
        );
        if (replayAfterLock) return replayAfterLock;
        if (series.statusCode !== 'active') badRequest();
        if (input.fromLocalDate < currentActivitySeriesLocalDate()) badRequest();

        const revision = await this.lockRevision(tx, series.id, input.revision);
        const template = await this.fromTemplate.validateExactTemplateVersionWithinTransaction({
          tx,
          templateVersionId: revision.templateVersionId,
        });
        if (template.definitionHash !== revision.templateDefinitionHash) {
          throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_SELECTABLE);
        }
        const schedule = normalizeStoredActivitySeriesSchedule({
          frequencyCode: revision.frequencyCode,
          interval: revision.interval,
          weeklyWeekdayMask: revision.weeklyWeekdayMask,
          monthlyDay: revision.monthlyDay,
        });
        const candidates = generateActivitySeriesOccurrenceCandidates({
          schedule,
          localStartDate: localDateFromDatabase(revision.localStartDate),
          localStartMinute: revision.localStartMinute,
          durationMinutes: revision.durationMinutes,
          effectiveFromLocalDate: localDateFromDatabase(revision.effectiveFromLocalDate),
          effectiveToLocalDate: localDateFromDatabase(revision.effectiveToLocalDate),
          windowStartLocalDate: input.fromLocalDate,
          generationWindowDays: revision.generationWindowDays,
        }).slice(0, input.count);
        if (candidates.length !== input.count) badRequest();

        const activityIds: string[] = [];
        for (const candidate of candidates) {
          const existing = await tx.activitySeriesOccurrence.findUnique({
            where: {
              seriesId_occurrenceKey: {
                seriesId: series.id,
                occurrenceKey: candidate.occurrenceKey,
              },
            },
            select: { activityId: true },
          });
          if (existing) {
            activityIds.push(existing.activityId);
            continue;
          }

          const registrationDeadline =
            revision.registrationDeadlineOffsetMinutes === null
              ? null
              : new Date(
                  candidate.startAt.getTime() - revision.registrationDeadlineOffsetMinutes * 60_000,
                ).toISOString();
          const materialized = await this.fromTemplate.materializeWithinTransaction({
            tx,
            command: {
              templateVersionId: revision.templateVersionId,
              title: revision.title,
              organizationId: revision.organizationId,
              startAt: candidate.startAt.toISOString(),
              endAt: candidate.endAt.toISOString(),
              location: revision.location,
              registrationDeadline,
              operationKey: this.materializationOperationKey(series.id, candidate.occurrenceKey),
            },
            user,
            initiatorMode: 'leave-empty-for-series',
            expectedDefinitionHash: revision.templateDefinitionHash,
          });
          await tx.activitySeriesOccurrence.create({
            data: {
              seriesId: series.id,
              revisionId: revision.id,
              activityId: materialized.created.id,
              occurrenceKey: candidate.occurrenceKey,
              startAt: candidate.startAt,
              endAt: candidate.endAt,
            },
          });
          await this.auditRecorder.logGeneratedOccurrence({
            activityId: materialized.created.id,
            seriesId: series.id,
            revision: revision.revision,
            occurrenceKey: candidate.occurrenceKey,
            templateVersionId: revision.templateVersionId,
            actorUserId: user.id,
            actorRoleSnap: user.role,
            auditMeta,
            tx,
          });
          activityIds.push(materialized.created.id);
        }

        const result = this.result(series.id, revision.revision, series.statusCode, activityIds);
        await this.persistReceipt(tx, {
          commandCode: 'generate_instances',
          operationKey: input.operationKey,
          requestHash: hash,
          seriesId: series.id,
          revisionId: revision.id,
          result,
        });
        await this.auditRecorder.logSeriesCommand({
          operation: 'generate_instances',
          seriesId: series.id,
          revision: revision.revision,
          statusCode: series.statusCode,
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return result;
      });
    } catch (error) {
      return this.recoverReplayOrThrow(error, 'generate_instances', input.operationKey, hash);
    }
  }

  private revisionCreateData(args: {
    readonly seriesId: string;
    readonly revision: number;
    readonly input: NormalizedActivitySeriesRevisionInput;
    readonly templateDefinitionHash: string;
    readonly createdByUserId: string;
  }): Prisma.ActivitySeriesRevisionUncheckedCreateInput {
    return {
      seriesId: args.seriesId,
      revision: args.revision,
      templateVersionId: args.input.templateVersionId,
      templateDefinitionHash: args.templateDefinitionHash,
      frequencyCode: args.input.schedule.frequencyCode,
      interval: args.input.schedule.interval,
      weeklyWeekdayMask: args.input.schedule.weeklyWeekdayMask,
      monthlyDay: args.input.schedule.monthlyDay,
      timeZone: args.input.timeZone,
      localStartDate: dateForDatabase(args.input.localStartDate),
      localStartMinute: args.input.localStartMinute,
      durationMinutes: args.input.durationMinutes,
      title: args.input.title,
      organizationId: args.input.organizationId,
      location: args.input.location,
      registrationDeadlineOffsetMinutes: args.input.registrationDeadlineOffsetMinutes,
      effectiveFromLocalDate: dateForDatabase(args.input.effectiveFromLocalDate),
      effectiveToLocalDate: dateForDatabase(args.input.effectiveToLocalDate),
      generationWindowDays: args.input.generationWindowDays,
      createdByUserId: args.createdByUserId,
    };
  }

  private async findReplay(
    tx: Prisma.TransactionClient,
    commandCode: ActivitySeriesCommandCode,
    operationKey: string,
    expectedRequestHash: string,
  ): Promise<ActivitySeriesCommandResult | null> {
    const receipt = await tx.activitySeriesCommandReceipt.findUnique({
      where: { operationKey },
      select: {
        commandCode: true,
        requestHash: true,
        seriesId: true,
        resultRevision: true,
        resultStatusCode: true,
        activityIds: true,
      },
    });
    if (!receipt) return null;
    if (receipt.commandCode !== commandCode || receipt.requestHash !== expectedRequestHash)
      badRequest();
    return this.result(
      receipt.seriesId,
      receipt.resultRevision,
      receipt.resultStatusCode,
      receipt.activityIds,
    );
  }

  private async persistReceipt(
    tx: Prisma.TransactionClient,
    args: {
      readonly commandCode: ActivitySeriesCommandCode;
      readonly operationKey: string;
      readonly requestHash: string;
      readonly seriesId: string;
      readonly revisionId: string | null;
      readonly result: ActivitySeriesCommandResult;
    },
  ): Promise<void> {
    await tx.activitySeriesCommandReceipt.create({
      data: {
        commandCode: args.commandCode,
        operationKey: args.operationKey,
        requestHash: args.requestHash,
        seriesId: args.seriesId,
        revisionId: args.revisionId,
        resultRevision: args.result.revision,
        resultStatusCode: args.result.statusCode,
        activityIds: [...args.result.activityIds],
      },
    });
  }

  private async lockSeries(tx: Prisma.TransactionClient, seriesId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ActivitySeries"
      WHERE "id" = ${seriesId}
      FOR UPDATE
    `;
    if (rows.length !== 1) badRequest();
    const series = await tx.activitySeries.findUnique({
      where: { id: seriesId },
      select: { id: true, statusCode: true },
    });
    if (!series || !isActivitySeriesStatusCode(series.statusCode)) badRequest();
    return series;
  }

  private async lockLatestRevision(tx: Prisma.TransactionClient, seriesId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ActivitySeriesRevision"
      WHERE "seriesId" = ${seriesId}
      ORDER BY "revision" DESC
      LIMIT 1
      FOR UPDATE
    `;
    const id = rows[0]?.id;
    if (!id) badRequest();
    const revision = await tx.activitySeriesRevision.findUnique({
      where: { id },
      select: { id: true, revision: true, effectiveToLocalDate: true },
    });
    if (!revision) badRequest();
    return revision;
  }

  private async lockRevision(
    tx: Prisma.TransactionClient,
    seriesId: string,
    revisionNumber: number,
  ) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ActivitySeriesRevision"
      WHERE "seriesId" = ${seriesId} AND "revision" = ${revisionNumber}
      FOR UPDATE
    `;
    if (rows.length !== 1) badRequest();
    const revision = await tx.activitySeriesRevision.findUnique({
      where: { seriesId_revision: { seriesId, revision: revisionNumber } },
      select: {
        id: true,
        revision: true,
        templateVersionId: true,
        templateDefinitionHash: true,
        frequencyCode: true,
        interval: true,
        weeklyWeekdayMask: true,
        monthlyDay: true,
        localStartDate: true,
        localStartMinute: true,
        durationMinutes: true,
        title: true,
        organizationId: true,
        location: true,
        registrationDeadlineOffsetMinutes: true,
        effectiveFromLocalDate: true,
        effectiveToLocalDate: true,
        generationWindowDays: true,
      },
    });
    if (!revision) badRequest();
    return revision;
  }

  private result(
    seriesId: string,
    revision: number | null,
    statusCode: unknown,
    activityIds: readonly string[],
  ): ActivitySeriesCommandResult {
    if (!isActivitySeriesStatusCode(statusCode)) badRequest();
    if (revision !== null && (!Number.isInteger(revision) || revision < 1)) badRequest();
    return {
      seriesId,
      revision,
      statusCode,
      activityIds: [...activityIds],
    };
  }

  private materializationOperationKey(seriesId: string, occurrenceKey: string): string {
    return `activity-series:${seriesId}:${occurrenceKey}`;
  }

  private async recoverReplayOrThrow(
    error: unknown,
    commandCode: ActivitySeriesCommandCode,
    operationKey: string,
    expectedRequestHash: string,
  ): Promise<ActivitySeriesCommandResult> {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    const replay = await this.prisma.$transaction((tx) =>
      this.findReplay(tx, commandCode, operationKey, expectedRequestHash),
    );
    if (replay) return replay;
    badRequest();
  }
}

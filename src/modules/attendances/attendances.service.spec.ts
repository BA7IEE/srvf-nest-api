import { Prisma, Role, UserStatus, type PrismaClient } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { OrganizationsService } from '../organizations/organizations.service';
import type { AttendanceAuditRecorder } from './attendance-audit-recorder';
import type { AttendanceNotificationProducer } from './attendance-notification-producer';
import { AttendancePresenter } from './attendance-presenter';
import { AttendanceSheetQueryService } from './attendance-sheet-query.service';
import type {
  AttendanceSheetStateMachine,
  AttendanceSheetTransitionDecision,
} from './attendance-sheet-state-machine';
import type { RbacService } from '../permissions/rbac.service';
import type { AuthzService } from '../authz/authz.service';
import { ActivityParticipationPolicy } from '../activities/activity-participation-policy';
import type { ContributionCalculator } from './contribution-calculator';
import { ContributionShadowService } from './contribution-shadow.service';
import { ContributionShadowEvidenceWriteService } from './contribution-shadow-evidence.write.service';
import { ActivityContributionShadowMappingProofQuery } from '../activities/activity-contribution-shadow-mapping-proof.query';
import { hashLegacySource } from './contribution-shadow-evidence.write.service';
import { ATTENDANCE_SHEET_STATUS } from './attendances.dto';
import type {
  ApproveAttendanceSheetDto,
  CreateAttendanceSheetDto,
  FinalApproveAttendanceSheetDto,
  FinalRejectAttendanceSheetDto,
  ListAttendanceSheetsQueryDto,
  MyAttendanceRecordsQueryDto,
  RejectAttendanceSheetDto,
  UpdateAttendanceSheetDto,
} from './attendances.dto';
import { AttendanceAccessService } from './attendance-access.service';
import { LedgerQueryService } from '../activities/ledger-query.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { AttendanceReadService } from './attendance-read.service';
import { AttendanceReviewService } from './attendance-review.service';
import { AttendancesService } from './attendances.service';
import { memberIdentityData } from '../../../test/helpers/member-identity.fixture';

// attendances service-level characterization spec(B 档 test-only,scoped;沿 srvf-god-service-refactor）。
// 锁定 `attendances.service.ts`(1157L,最大 god-service)**浅层编排契约**现状行为,作为后续
// Presenter / QueryService 抽离前的快速重构护栏。
//
// 风格沿 src/modules/activity-registrations/activity-registrations.service.spec.ts
//      + src/modules/attachments/attachments.service.spec.ts
//      + src/modules/activities/activities.service.spec.ts:
// - 纯构造器注入 mock,不使用 NestJS TestingModule、不连库、不起 Nest。
// - $transaction mock 同时支持 callback(写路径把 prisma mock 自身当 tx 传入)与 array(list / count)两种用法。
//
// 边界(本 spec **只到浅层编排**;不改任何业务代码 / BizCode / audit event 名):
// - submit 仅补一条批量预取编排用例，深层 prefill / overlap / snapshot 语义仍归对应 e2e。
// - 不复刻 ContributionCalculator / TimeOverlapPolicy / AttendanceSheetStateMachine 内部矩阵(mock 返回值)。
// - 不断言 AttendanceAuditRecorder 内部 snapshot 结构(只断言被调用 + 入参 tx / action 接线)。
// - 不为覆盖率 mock 整个 Prisma 世界(仅 mock 浅层路径触达的最小模型面)。

// ============ 固定 fixture ============

const FIXED_IN = new Date('2026-01-01T08:00:00.000Z');
const FIXED_OUT = new Date('2026-01-01T12:00:00.000Z');
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const META: AuditMeta = { requestId: 'req-att-1', ip: '127.0.0.1', ua: 'jest' };

// 占位 deny decision:mapper / list / submit guard 不调用 state machine,用它兜底。
const DENY_DECISION: AttendanceSheetTransitionDecision = {
  allowed: false,
  biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
};

// ============ 行形 ============

interface SheetRow {
  id: string;
  activityId: string;
  submitterUserId: string;
  submittedAt: Date | null;
  statusCode: string;
  reviewerUserId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  finalReviewerUserId: string | null;
  finalReviewedAt: Date | null;
  finalReviewNote: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  previousSnapshot?: Prisma.JsonValue | null;
}

function makeSheetRow(overrides: Partial<SheetRow> = {}): SheetRow {
  return {
    id: 'sheet-1',
    activityId: 'act-1',
    submitterUserId: 'u1',
    submittedAt: FIXED_DATE,
    statusCode: ATTENDANCE_SHEET_STATUS.PENDING,
    reviewerUserId: null,
    reviewedAt: null,
    reviewNote: null,
    finalReviewerUserId: null,
    finalReviewedAt: null,
    finalReviewNote: null,
    version: 1,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    previousSnapshot: null,
    ...overrides,
  };
}

interface RecordRow {
  id: string;
  sheetId: string;
  memberId: string;
  roleCode: string;
  checkInAt: Date;
  checkOutAt: Date;
  serviceHours: Prisma.Decimal;
  attendanceStatusCode: string;
  note: string | null;
  registrationId: string | null;
  contributionPoints: Prisma.Decimal | null;
  createdAt: Date;
  updatedAt: Date;
  member: { id: string; memberNo: string; realName: string; nickname: string | null } | null;
}

function makeRecordRow(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: 'rec-1',
    sheetId: 'sheet-1',
    memberId: 'mem-1',
    roleCode: 'volunteer',
    checkInAt: FIXED_IN,
    checkOutAt: FIXED_OUT,
    serviceHours: new Prisma.Decimal('4.00'),
    attendanceStatusCode: 'present',
    note: null,
    registrationId: null,
    contributionPoints: new Prisma.Decimal('1.50'),
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    member: { id: 'mem-1', memberNo: 'M-1', ...memberIdentityData('Member One'), nickname: null },
    ...overrides,
  };
}

function makeCurrentUser(overrides: Partial<CurrentUserPayload> = {}): CurrentUserPayload {
  return {
    id: 'admin-1',
    username: 'admin',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
    ...overrides,
  };
}

// ============ DTO 工厂(结构性 cast;deny 路径不深读 dto) ============

function makeApproveDto(reviewNote?: string): ApproveAttendanceSheetDto {
  return { reviewNote };
}
function makeRejectDto(reviewNote = 'rejected'): RejectAttendanceSheetDto {
  return { reviewNote };
}
function makeFinalApproveDto(finalReviewNote?: string): FinalApproveAttendanceSheetDto {
  return { finalReviewNote };
}
function makeFinalRejectDto(finalReviewNote: string): FinalRejectAttendanceSheetDto {
  return { finalReviewNote };
}
function makeEditDto(records?: unknown[]): UpdateAttendanceSheetDto {
  return { records } as unknown as UpdateAttendanceSheetDto;
}
function makeSubmitDto(
  records: CreateAttendanceSheetDto['records'] = [],
): CreateAttendanceSheetDto {
  return { records };
}
function makeListQuery(statusCode?: string): ListAttendanceSheetsQueryDto {
  return { page: 1, pageSize: 20, statusCode };
}
function makeMyRecordsQuery(activityId?: string): MyAttendanceRecordsQueryDto {
  return { page: 1, pageSize: 20, activityId };
}

// ============ mock 工厂 ============

describe('E3-2 D2 qualified post-commit preparation', () => {
  const context = () => ({
    windowId: 'window-1',
    auditLogId: 'audit-1',
    sheetId: 'sheet-1',
    activityId: 'act-1',
    sheetVersion: 1,
    signedMappingVersion: 'signed-v1',
    recordIds: ['record-1'],
    operation: 'submit' as const,
    managed: false,
  });
  function setup(mode: 'off' | 'shadow' = 'shadow') {
    const prisma = makePrismaMock();
    const authz = makeAuthzMock();
    const actor = makeCurrentUser();
    prisma.user.findFirst.mockResolvedValue(actor);
    prisma.auditLog.findUnique.mockResolvedValue({
      createdAt: FIXED_DATE,
      event: 'attendance-sheet.submit',
      resourceId: 'sheet-1',
      resourceType: 'attendance_sheet',
      success: true,
      shadowProofRequired: true,
    });
    prisma.contributionShadowObservationWindow.findUnique.mockResolvedValue({
      signedMappingVersion: 'signed-v1',
      startsAt: new Date('2025-01-01T00:00:00Z'),
      endsAt: new Date('2099-01-01T00:00:00Z'),
    });
    const source = {
      id: 'source-1',
      ...context(),
      recordId: 'record-1',
      memberId: 'member-1',
      activityTypeCode: 'service',
      attendanceRoleCode: 'member',
      legacyServiceHours: new Prisma.Decimal('1.00'),
      legacyPoints: new Prisma.Decimal('0.00'),
      sourceKindCode: 'no_match' as const,
      legacyRuleId: null,
      durationThreshold: null,
      pointsBelow: null,
      pointsAbove: null,
      legacySourceHash: '',
      hashAlgorithmCode: 'sha256',
      canonicalVersion: 1,
      createdAt: FIXED_DATE,
    };
    source.legacySourceHash = hashLegacySource({
      ...source,
      source: {
        sourceKindCode: 'no_match',
        legacyRuleId: null,
        durationThreshold: null,
        pointsBelow: null,
        pointsAbove: null,
      },
    });
    prisma.contributionShadowLegacySourceAnchor.findMany.mockResolvedValue([source]);
    const history = jest
      .spyOn(ActivityContributionShadowMappingProofQuery.prototype, 'readComparisonMappingHistory')
      .mockResolvedValue([]);
    jest
      .spyOn(ActivityContributionShadowMappingProofQuery.prototype, 'readSelectionAtSource')
      .mockResolvedValue(null);
    jest
      .spyOn(ActivityContributionShadowMappingProofQuery.prototype, 'readComparisonPositions')
      .mockResolvedValue([]);
    jest
      .spyOn(ActivityContributionShadowMappingProofQuery.prototype, 'readComparisonPolicyVersions')
      .mockResolvedValue([]);
    const service = makeService(prisma, { authz, shadowMode: mode });
    return {
      prisma,
      authz,
      actor,
      history,
      service,
      prepare: (
        value: Parameters<AttendancesService['prepareCommittedShadowComparison']>[1] = context(),
      ) =>
        service.prepareCommittedShadowComparison(
          prisma as unknown as Prisma.TransactionClient,
          value,
          actor,
        ),
    };
  }
  afterEach(() => jest.restoreAllMocks());

  function runtimeFixture() {
    const f = setup();
    const runtime = makePrismaMock();
    const budgets: unknown[] = [];
    const runtimeOptions: unknown[] = [];
    const runtimeEntry = jest
      .spyOn(ContributionShadowService.prototype, 'withBoundedRuntimeClient')
      .mockImplementation((budget, work) => {
        budgets.push(budget);
        const options = budget.transactionOptions(0, 100);
        runtimeOptions.push(options);
        return work(runtime as unknown as PrismaClient, options);
      });
    const terminal = {
      id: 'terminal-1',
      attemptId: 'attempt-1',
      statusCode: 'complete',
      expectedRecordCount: 1,
      writtenRecordCount: 1,
      equalCount: 0,
      mismatchCount: 0,
      holdCount: 1,
      errorCount: 0,
      failureCode: null,
      createdAt: FIXED_DATE,
    };
    const start = jest
      .spyOn(ContributionShadowEvidenceWriteService.prototype, 'readOrCreateAttempt')
      .mockImplementation((_tx, input) =>
        Promise.resolve({
          attempt: {
            ...input,
            id: 'attempt-1',
            replayKey: 'fixture',
            createdAt: FIXED_DATE,
            hashAlgorithmCode: 'sha256',
            canonicalVersion: 1,
            terminal: null,
          },
          replayed: false,
        }),
      );
    const complete = jest
      .spyOn(ContributionShadowEvidenceWriteService.prototype, 'writeCompleteComparisonSet')
      .mockResolvedValue(terminal);
    const failed = jest
      .spyOn(ContributionShadowEvidenceWriteService.prototype, 'writeFailedTerminal')
      .mockResolvedValue({
        terminal: {
          ...terminal,
          statusCode: 'failed',
          writtenRecordCount: 0,
          holdCount: 0,
          failureCode: 'shadow_comparison_failed',
        },
        replayed: false,
      });
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    return {
      ...f,
      runtime,
      runtimeEntry,
      start,
      complete,
      failed,
      warning,
      budgets,
      runtimeOptions,
      terminal,
    };
  }

  it('commits start and complete in separate runtime transactions, requalifying every stage', async () => {
    const f = runtimeFixture();
    await f.service.compareCommittedShadow(context(), f.actor);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(f.runtime.$transaction).toHaveBeenCalledTimes(2);
    const transactions: unknown[][] = f.runtime.$transaction.mock.calls;
    expect(transactions[0][1]).toBe(f.runtimeOptions[0]);
    expect(transactions[1][1]).toBe(f.runtimeOptions[1]);
    expect(f.prisma.user.findFirst).toHaveBeenCalledTimes(6);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start.mock.calls[0][0]).toBe(f.runtime);
    expect(f.start.mock.calls[0][1]).toMatchObject({
      auditLogId: 'audit-1',
      expectedRecordCount: 1,
    });
    expect(f.complete.mock.calls[0][0]).toBe(f.runtime);
    expect(f.complete.mock.calls[0][3]).toHaveLength(1);
    expect(f.start.mock.invocationCallOrder[0]).toBeLessThan(
      f.complete.mock.invocationCallOrder[0],
    );
    expect(f.budgets).toHaveLength(2);
    expect(f.budgets[0]).toBe(f.budgets[1]);
    expect(f.failed).not.toHaveBeenCalled();
    expect(f.warning).not.toHaveBeenCalled();
  });

  it.each(['complete', 'failed'])(
    'existing %s terminal is read-only replay',
    async (statusCode) => {
      const f = runtimeFixture();
      f.start.mockImplementation((_tx, input) =>
        Promise.resolve({
          attempt: {
            ...input,
            id: 'attempt-1',
            replayKey: 'fixture',
            createdAt: FIXED_DATE,
            hashAlgorithmCode: 'sha256',
            canonicalVersion: 1,
            terminal: { ...f.terminal, statusCode },
          },
          replayed: true,
        }),
      );
      await f.service.compareCommittedShadow(context(), f.actor);
      expect(f.runtime.$transaction).toHaveBeenCalledTimes(1);
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.failed).not.toHaveBeenCalled();
    },
  );

  it('recovers a known committed start only after failed comparison settles, without retry', async () => {
    const f = runtimeFixture();
    f.complete.mockRejectedValue(new Error('sensitive driver details must never be logged'));
    await expect(f.service.compareCommittedShadow(context(), f.actor)).resolves.toBeUndefined();
    expect(f.runtime.$transaction).toHaveBeenCalledTimes(3);
    expect(f.prisma.user.findFirst).toHaveBeenCalledTimes(8);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.complete.mock.invocationCallOrder[0]).toBeLessThan(
      f.failed.mock.invocationCallOrder[0],
    );
    expect(f.budgets.every((budget) => budget === f.budgets[0])).toBe(true);
    expect(f.warning).toHaveBeenCalledWith(
      'contribution shadow evidence incomplete; manual reconciliation required',
    );
  });

  it('failed start never guesses an attempt or writes a failed terminal', async () => {
    const f = runtimeFixture();
    f.start.mockRejectedValue(new Error('unique conflict'));
    await f.service.compareCommittedShadow(context(), f.actor);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.runtime.$transaction).toHaveBeenCalledTimes(1);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('drains a runtime start after containing transaction failure, never leaving a background write', async () => {
    const f = runtimeFixture();
    let release: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const originalStart = f.start.getMockImplementation()!;
    f.start.mockImplementation(async (tx, input) => {
      signalStarted!();
      await gate;
      return originalStart(tx, input);
    });
    f.prisma.$transaction
      .mockImplementationOnce((arg: unknown) =>
        (arg as (tx: PrismaMock) => Promise<unknown>)(f.prisma),
      )
      .mockImplementationOnce(async (arg: unknown) => {
        // Simulate a driver reporting its containing timeout before the inner
        // callback settles; observe the callback rejection to avoid a test leak.
        const callback = (arg as (tx: PrismaMock) => Promise<unknown>)(f.prisma);
        void callback.catch(() => undefined);
        await entered;
        throw new Error('containing transaction failed');
      });
    let returned = false;
    const operation = f.service.compareCommittedShadow(context(), f.actor).then(() => {
      returned = true;
    });
    await entered;
    await Promise.resolve();
    expect(returned).toBe(false);
    release!();
    await operation;
    expect(returned).toBe(true);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('revoked current identity after durable start prevents comparison and failure-terminal writes', async () => {
    const f = runtimeFixture();
    f.prisma.user.findFirst
      .mockResolvedValueOnce(f.actor)
      .mockResolvedValueOnce(f.actor)
      .mockResolvedValueOnce(f.actor)
      .mockResolvedValueOnce(f.actor)
      .mockResolvedValue(null);
    await f.service.compareCommittedShadow(context(), f.actor);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
    expect(f.runtime.$transaction).toHaveBeenCalledTimes(1);
  });

  it('off or missing committed context does no post-commit transaction or runtime work', async () => {
    const f = runtimeFixture();
    await f.service.compareCommittedShadow(null, f.actor);
    await setup('off').service.compareCommittedShadow(context(), f.actor);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.runtimeEntry).not.toHaveBeenCalled();
  });

  it('off is zero new identity, lock, audit, source and candidate reads', async () => {
    const f = setup('off');
    await expect(f.prepare()).resolves.toBeNull();
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(f.prisma.user.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.auditLog.findUnique).not.toHaveBeenCalled();
    expect(f.prisma.contributionShadowLegacySourceAnchor.findMany).not.toHaveBeenCalled();
    expect(f.history).not.toHaveBeenCalled();
  });

  it('locks before current identity and qualifies twice, never projecting raw audit context', async () => {
    const f = setup();
    const prepared = await f.prepare();
    expect(prepared?.attempt.expectedRecordCount).toBe(1);
    expect(prepared?.comparisons[0].classificationCode).toBe('legacy_rule_missing');
    expect(f.prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      f.prisma.user.findFirst.mock.invocationCallOrder[0],
    );
    expect(f.prisma.user.findFirst).toHaveBeenCalledTimes(2);
    expect(f.authz.explain).toHaveBeenNthCalledWith(
      1,
      f.actor,
      'attendance.create.sheet',
      { type: 'activity', id: 'act-1' },
      f.prisma,
    );
    expect(f.authz.explain).toHaveBeenNthCalledWith(
      2,
      f.actor,
      'attendance.create.sheet',
      { type: 'activity', id: 'act-1' },
      f.prisma,
    );
    expect(f.prisma.auditLog.findUnique).toHaveBeenCalledWith({
      where: { id: 'audit-1' },
      select: {
        createdAt: true,
        event: true,
        resourceId: true,
        resourceType: true,
        success: true,
        shadowProofRequired: true,
      },
    });
    expect(f.prisma.contributionShadowLegacySourceAnchor.createMany).not.toHaveBeenCalled();
  });

  it('refuses inactive or missing current user before exposing audit or source', async () => {
    const f = setup();
    f.prisma.user.findFirst.mockResolvedValue(null);
    await expect(f.prepare()).rejects.toEqual(new BizException(BizCode.UNAUTHORIZED));
    expect(f.prisma.auditLog.findUnique).not.toHaveBeenCalled();
    expect(f.history).not.toHaveBeenCalled();
  });

  it('refuses a changed member binding rather than using the old request identity', async () => {
    const f = setup();
    f.prisma.user.findFirst.mockResolvedValue(makeCurrentUser({ memberId: 'new-member' }));
    await expect(f.prepare()).rejects.toEqual(new BizException(BizCode.UNAUTHORIZED));
    expect(f.prisma.auditLog.findUnique).not.toHaveBeenCalled();
  });

  it('refuses an inactive bound member before audit reads, including administrators', async () => {
    const f = setup();
    f.actor.memberId = 'bound-member';
    const identity = jest.spyOn(AppIdentityResolver.prototype, 'resolve').mockResolvedValue({
      canUseApp: false,
      reason: 'MEMBER_INACTIVE',
      member: null,
    });
    await expect(f.prepare()).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
    expect(identity).toHaveBeenCalledWith(f.actor, f.prisma);
    expect(f.prisma.auditLog.findUnique).not.toHaveBeenCalled();
  });

  it('uses the original edit permission and sheet resource instead of create permission', async () => {
    const f = setup();
    f.prisma.auditLog.findUnique.mockResolvedValue({
      createdAt: FIXED_DATE,
      event: 'attendance-sheet.edit',
      resourceId: 'sheet-1',
      resourceType: 'attendance_sheet',
      success: true,
      shadowProofRequired: true,
    });
    await expect(f.prepare({ ...context(), operation: 'edit' })).resolves.not.toBeNull();
    expect(f.authz.explain).toHaveBeenCalledTimes(2);
    expect(f.authz.explain).toHaveBeenLastCalledWith(
      f.actor,
      'attendance.update.sheet',
      { type: 'attendance_sheet', id: 'sheet-1' },
      f.prisma,
    );
  });

  it('managed requests cannot reuse an unbound admin identity', async () => {
    const f = setup();
    await expect(f.prepare({ ...context(), managed: true })).rejects.toEqual(
      new BizException(BizCode.RBAC_FORBIDDEN),
    );
    expect(f.prisma.auditLog.findUnique).not.toHaveBeenCalled();
  });

  it('refuses permissions revoked during candidate preparation', async () => {
    const f = setup();
    f.authz.explain
      .mockResolvedValueOnce({ allow: true, reason: 'fixture' })
      .mockResolvedValueOnce({ allow: false, reason: 'no_permission' });
    await expect(f.prepare()).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
    expect(f.prisma.user.findFirst).toHaveBeenCalledTimes(2);
  });

  it('refuses user invalidation during candidate preparation', async () => {
    const f = setup();
    f.prisma.user.findFirst.mockResolvedValueOnce(f.actor).mockResolvedValueOnce(null);
    await expect(f.prepare()).rejects.toEqual(new BizException(BizCode.UNAUTHORIZED));
  });

  it('does not read candidates outside the exact registered audit window', async () => {
    const f = setup();
    f.prisma.contributionShadowObservationWindow.findUnique.mockResolvedValue({
      signedMappingVersion: 'signed-v1',
      startsAt: new Date('2025-01-01T00:00:00Z'),
      endsAt: FIXED_DATE,
    });
    await expect(f.prepare()).rejects.toThrow('shadow committed audit qualification mismatch');
    expect(f.history).not.toHaveBeenCalled();
  });

  it('does not accept a successful audit lacking the same-transaction source requirement', async () => {
    const f = setup();
    f.prisma.auditLog.findUnique.mockResolvedValue({
      createdAt: FIXED_DATE,
      success: true,
      shadowProofRequired: false,
      event: 'attendance-sheet.submit',
      resourceId: 'sheet-1',
      resourceType: 'attendance_sheet',
    });
    await expect(f.prepare()).rejects.toThrow('shadow committed audit qualification mismatch');
    expect(f.history).not.toHaveBeenCalled();
  });
});

function makePrismaMock() {
  const attendanceSheet = {
    findFirst: jest.fn<Promise<SheetRow | null>, [unknown]>(),
    findMany: jest.fn<Promise<SheetRow[]>, [unknown]>(),
    count: jest.fn<Promise<number>, [unknown]>(),
    update: jest.fn<Promise<SheetRow>, [unknown]>(),
    create: jest.fn<Promise<SheetRow>, [unknown]>(),
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>().mockResolvedValue({ count: 1 }),
  };
  const attendanceRecord = {
    findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    count: jest.fn<Promise<number>, [unknown]>(),
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>().mockResolvedValue({ count: 0 }),
    createMany: jest.fn<Promise<{ count: number }>, [unknown]>().mockResolvedValue({ count: 2 }),
  };
  const user = { findFirst: jest.fn<Promise<{ memberId: string | null } | null>, [unknown]>() };
  const activity = {
    findFirst: jest.fn<Promise<unknown>, [unknown]>(),
    // 统一通知 S4:finalApprove 后 commit 外的派发 helper 读活动名(this.prisma.activity.findUnique);
    // 默认返标题,旧 characterization 用例不关心(helper try-catch 永不抛,断言零影响)。
    findUnique: jest
      .fn<Promise<{ title: string } | null>, [unknown]>()
      .mockResolvedValue({ title: '测试活动' }),
  };
  const dictItem = { findMany: jest.fn<Promise<unknown[]>, [unknown]>() };
  const member = { findMany: jest.fn<Promise<unknown[]>, [unknown]>() };
  const activityRegistration = { findMany: jest.fn<Promise<unknown[]>, [unknown]>() };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  // submit 的 Activity FOR SHARE 默认命中；活动不存在 / cancelled 仍由 findFirst fixture
  // 驱动既有错误优先级，不放宽生产锁或业务守卫。
  const $queryRaw = jest.fn().mockResolvedValue([{ id: 'act-1' }]);
  // M3:runMemberLinearizedTransaction 给事务设 `SET LOCAL lock_timeout`(有界锁等待)。
  const $executeRawUnsafe = jest.fn().mockResolvedValue(0);
  const prisma = {
    auditLog: { findUnique: jest.fn() },
    contributionShadowObservationWindow: { findUnique: jest.fn() },
    contributionShadowLegacySourceAnchor: {
      createMany: jest.fn<Promise<{ count: number }>, [unknown]>().mockResolvedValue({ count: 2 }),
      findMany: jest.fn(),
    },
    attendanceSheet,
    attendanceRecord,
    user,
    activity,
    dictItem,
    member,
    activityRegistration,
    $transaction,
    $queryRaw,
    $executeRawUnsafe,
  };
  // 双模:回调式把 prisma mock 自身当 tx 传入(service 在 tx 与 this.prisma 上调同名方法);
  // 数组式($transaction([findMany, count]))走 Promise.all。
  $transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
      : Promise.all(arg as Array<Promise<unknown>>),
  );
  return prisma;
}
type PrismaMock = ReturnType<typeof makePrismaMock>;

describe('E3-2 D2 old-write source proof wiring', () => {
  afterEach(() => jest.restoreAllMocks());
  function setup() {
    const prisma = makePrismaMock();
    const recorder = makeRecorderMock();
    const calculator = makeContributionCalculatorMock();
    const findCurrentRegisteredWindow = jest.fn().mockResolvedValue({
      id: 'window-1',
      signedMappingVersion: 'mapping-hold',
    });
    const shadow = { findCurrentRegisteredWindow } as unknown as ContributionShadowService;
    prisma.activity.findFirst.mockResolvedValue({
      id: 'act-1',
      statusCode: 'published',
      activityTypeCode: 'training',
      startAt: new Date('2026-01-01T07:00:00.000Z'),
      endAt: new Date('2026-01-01T18:00:00.000Z'),
    });
    prisma.dictItem.findMany.mockResolvedValue([
      { code: 'volunteer', type: { code: 'attendance_role' } },
      { code: 'present', type: { code: 'attendance_status' } },
    ]);
    prisma.member.findMany.mockResolvedValue([{ id: 'mem-1' }, { id: 'mem-2' }]);
    prisma.activityRegistration.findMany.mockResolvedValue([]);
    prisma.attendanceSheet.create.mockResolvedValue(makeSheetRow());
    prisma.attendanceSheet.findFirst.mockResolvedValue(makeSheetRow());
    prisma.attendanceSheet.update.mockResolvedValue(makeSheetRow({ version: 2 }));
    const rows = [
      makeRecordRow({
        id: 'cuid-two',
        memberId: 'mem-2',
        contributionPoints: new Prisma.Decimal(0),
      }),
      makeRecordRow({ id: 'cuid-one', contributionPoints: new Prisma.Decimal(0) }),
    ];
    const inputs = ['mem-1', 'mem-2'].map((memberId) => ({
      memberId,
      roleCode: 'volunteer',
      checkInAt: FIXED_IN.toISOString(),
      checkOutAt: FIXED_OUT.toISOString(),
      attendanceStatusCode: 'present',
    }));
    const service = makeService(prisma, {
      recorder,
      contributionCalculator: calculator,
      shadow,
      stateMachine: makeStateMachineMock({
        allowed: true,
        nextStatusCode: ATTENDANCE_SHEET_STATUS.PENDING,
      }),
    });
    return { prisma, recorder, calculator, service, rows, inputs, findCurrentRegisteredWindow };
  }

  it.each(['submit', 'edit'] as const)(
    '%s passes only the exact successful old outcome after commit, keeping its public DTO',
    async (operation) => {
      const f = setup();
      let committed = false;
      f.prisma.$transaction.mockImplementation(async (arg: unknown) => {
        const outcome = await (arg as (tx: PrismaMock) => Promise<unknown>)(f.prisma);
        committed = true;
        return outcome;
      });
      if (operation === 'edit')
        f.prisma.attendanceRecord.findMany.mockResolvedValueOnce([makeRecordRow()]);
      f.prisma.attendanceRecord.findMany.mockResolvedValue(f.rows);
      const actor = makeCurrentUser();
      const postCommit = jest
        .spyOn(f.service, 'compareCommittedShadow')
        .mockImplementation((context, authenticated) => {
          expect(committed).toBe(true);
          expect(authenticated).toBe(actor);
          expect(context).toEqual({
            windowId: 'window-1',
            signedMappingVersion: 'mapping-hold',
            auditLogId: `audit-${operation}`,
            sheetId: 'sheet-1',
            activityId: 'act-1',
            sheetVersion: operation === 'submit' ? 1 : 2,
            recordIds: ['cuid-two', 'cuid-one'],
            operation,
            managed: false,
          });
          return Promise.resolve();
        });
      const response =
        operation === 'submit'
          ? await f.service.submit('act-1', makeSubmitDto(f.inputs), actor, META)
          : await f.service.edit('sheet-1', makeEditDto(f.inputs), actor, META);
      expect(postCommit).toHaveBeenCalledTimes(1);
      expect(response.id).toBe('sheet-1');
      expect(response.version).toBe(operation === 'submit' ? 1 : 2);
      expect(response).not.toHaveProperty('shadowContext');
    },
  );

  it('source failure never invokes post-commit work', async () => {
    const f = setup();
    f.prisma.attendanceRecord.findMany.mockResolvedValue([f.rows[0]]);
    const postCommit = jest.spyOn(f.service, 'compareCommittedShadow');
    await expect(
      f.service.submit('act-1', makeSubmitDto(f.inputs), makeCurrentUser(), META),
    ).rejects.toThrow('correspondence failed');
    expect(postCommit).not.toHaveBeenCalled();
  });

  it.each(['submit', 'edit'] as const)(
    '%s binds reversed returned IDs to the exact source and audit in the old transaction',
    async (operation) => {
      const f = setup();
      if (operation === 'edit')
        f.prisma.attendanceRecord.findMany.mockResolvedValueOnce([
          makeRecordRow({ id: 'old-record' }),
        ]);
      f.prisma.attendanceRecord.findMany.mockResolvedValue(f.rows);
      if (operation === 'submit')
        await f.service.submit('act-1', makeSubmitDto(f.inputs), makeCurrentUser(), META);
      else await f.service.edit('sheet-1', makeEditDto(f.inputs), makeCurrentUser(), META);
      const call = f.prisma.contributionShadowLegacySourceAnchor.createMany.mock.calls[0][0] as {
        data: Array<{
          recordId: string;
          memberId: string;
          auditLogId: string;
          sheetVersion: number;
        }>;
      };
      expect(call.data.map((row) => [row.recordId, row.memberId])).toEqual([
        ['cuid-one', 'mem-1'],
        ['cuid-two', 'mem-2'],
      ]);
      expect(
        call.data.every(
          (row) =>
            row.auditLogId === `audit-${operation}` &&
            row.sheetVersion === (operation === 'submit' ? 1 : 2),
        ),
      ).toBe(true);
      expect(f.calculator.applyContributionRulePrefill).not.toHaveBeenCalled();
      expect(f.recorder.logSubmit).not.toHaveBeenCalled();
      expect(f.recorder.logEdit).not.toHaveBeenCalled();
      expect(f.findCurrentRegisteredWindow).toHaveBeenCalledWith(f.prisma);
    },
  );

  it.each(['submit', 'edit'] as const)(
    '%s fails the old transaction callback when returned records are incomplete',
    async (operation) => {
      const f = setup();
      if (operation === 'edit')
        f.prisma.attendanceRecord.findMany.mockResolvedValueOnce([makeRecordRow()]);
      f.prisma.attendanceRecord.findMany.mockResolvedValue([f.rows[0]]);
      const action =
        operation === 'submit'
          ? f.service.submit('act-1', makeSubmitDto(f.inputs), makeCurrentUser(), META)
          : f.service.edit('sheet-1', makeEditDto(f.inputs), makeCurrentUser(), META);
      await expect(action).rejects.toThrow('correspondence failed');
      expect(f.prisma.contributionShadowLegacySourceAnchor.createMany).not.toHaveBeenCalled();
    },
  );

  it('edit without records never queries a shadow window or creates a source proof', async () => {
    const f = setup();
    f.prisma.attendanceRecord.findMany.mockResolvedValue([makeRecordRow()]);
    await f.service.edit('sheet-1', makeEditDto(), makeCurrentUser(), META);
    expect(f.findCurrentRegisteredWindow).not.toHaveBeenCalled();
    expect(f.recorder.logEditNoRecords).toHaveBeenCalled();
    expect(f.recorder.logEditWithProof).not.toHaveBeenCalled();
    expect(f.prisma.contributionShadowLegacySourceAnchor.createMany).not.toHaveBeenCalled();
  });

  it('without a registered window retains the original calculator and audit calls', async () => {
    const f = setup();
    f.findCurrentRegisteredWindow.mockResolvedValue(null);
    f.prisma.attendanceRecord.findMany.mockResolvedValue(f.rows);
    await f.service.submit('act-1', makeSubmitDto(f.inputs), makeCurrentUser(), META);
    expect(f.calculator.applyContributionRulePrefill).toHaveBeenCalledTimes(1);
    expect(f.calculator.applyContributionRulePrefillWithSource).not.toHaveBeenCalled();
    expect(f.recorder.logSubmit).toHaveBeenCalledTimes(1);
    expect(f.recorder.logSubmitWithProof).not.toHaveBeenCalled();
    expect(f.prisma.contributionShadowLegacySourceAnchor.createMany).not.toHaveBeenCalled();
  });
});

function makeStateMachineMock(decision: AttendanceSheetTransitionDecision) {
  return {
    decide: jest
      .fn<AttendanceSheetTransitionDecision, [string, string]>()
      .mockReturnValue(decision),
  };
}
type StateMachineMock = ReturnType<typeof makeStateMachineMock>;

function makeRecorderMock() {
  return {
    logRead: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logSubmit: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logSubmitWithProof: jest.fn<Promise<string>, [unknown]>().mockResolvedValue('audit-submit'),
    logEdit: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logEditWithProof: jest.fn<Promise<string>, [unknown]>().mockResolvedValue('audit-edit'),
    logEditNoRecords: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logDelete: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logReview: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logFinalReview: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    buildPreviousSnapshot: jest
      .fn<Record<string, unknown>, [unknown, unknown]>()
      .mockReturnValue({}),
  };
}
type RecorderMock = ReturnType<typeof makeRecorderMock>;

function makeContributionCalculatorMock() {
  // passthrough:prefill 不在浅层 spec 范围(submit happy-path 不测);仅保证类型完整。
  return {
    applyContributionRulePrefill: jest
      .fn<Promise<unknown[]>, [unknown[], string, unknown]>()
      .mockImplementation((records: unknown[]) => Promise.resolve(records)),
    applyContributionRulePrefillWithSource: jest
      .fn()
      .mockImplementation((records: Array<Record<string, unknown>>) =>
        Promise.resolve({
          records: records.map((record) => ({ ...record, contributionPoints: 0 })),
          sources: records.map(() => ({
            sourceKindCode: 'no_match',
            legacyRuleId: null,
            durationThreshold: null,
            pointsBelow: null,
            pointsAbove: null,
          })),
        }),
      ),
  };
}
type ContributionCalculatorMock = ReturnType<typeof makeContributionCalculatorMock>;

function makeTimeOverlapPolicyMock() {
  return {
    assertNoInternalOverlap: jest.fn<void, [unknown[]]>(),
    lockMembersForOverlapCheck: jest
      .fn<Promise<void>, [readonly string[], unknown]>()
      .mockResolvedValue(undefined),
    assertNoTimeOverlap: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    assertNoTimeOverlapForRecords: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
  };
}
type TimeOverlapPolicyMock = ReturnType<typeof makeTimeOverlapPolicyMock>;

// 终态 scoped-authz PR9:authz mock —— explain 默认 allow(matched),既有 characterization
// 断言零修改(判权切换不动业务行为);deny 映射用例注入具体 reason 验证 BizCode 映射。
function makeAuthzMock(
  decision: { allow: boolean; reason: string } = { allow: true, reason: 'matched' },
) {
  return {
    explain: jest
      .fn<Promise<{ allow: boolean; reason: string }>, [unknown, string, unknown]>()
      .mockResolvedValue(decision),
    getVisibleOrganizationScope: jest.fn().mockResolvedValue({
      hasPermission: true,
      global: true,
      organizationIds: [],
    }),
  };
}
type AuthzMock = ReturnType<typeof makeAuthzMock>;

// PR-L4:通知 producer mock；service 只负责编排同一 tx，payload/outbox 细节归 producer 单测/e2e。
function makeAttendanceNotificationProducerMock() {
  return {
    enqueueReturned: jest
      .fn<Promise<void>, [unknown, Record<string, unknown>]>()
      .mockResolvedValue(),
    prepareContributionThresholdSnapshots: jest
      .fn<Promise<unknown[]>, [unknown, unknown[]]>()
      .mockResolvedValue([]),
    enqueueFinalApproved: jest
      .fn<Promise<void>, [unknown, Record<string, unknown>]>()
      .mockResolvedValue(),
  };
}
type AttendanceNotificationProducerMock = ReturnType<typeof makeAttendanceNotificationProducerMock>;

// F2/B2(2026-07-04):listAllSheetsForAdmin 新增 organizationId+includeDescendants 注入
// OrganizationsService.queryDescendantOrgIds();本 spec 不覆盖该分支(归 e2e
// admin-cross-axis-attendances),mock 仅满足构造器类型,不返回有意义值。
function makeOrganizationsMock() {
  return {
    queryDescendantOrgIds: jest.fn<Promise<string[]>, [string]>().mockResolvedValue([]),
  };
}
type OrganizationsMock = ReturnType<typeof makeOrganizationsMock>;

function makeService(
  prisma: PrismaMock,
  opts: {
    recorder?: RecorderMock;
    contributionCalculator?: ContributionCalculatorMock;
    timeOverlapPolicy?: TimeOverlapPolicyMock;
    stateMachine?: StateMachineMock;
    notificationProducer?: AttendanceNotificationProducerMock;
    authz?: AuthzMock;
    organizations?: OrganizationsMock;
    shadow?: ContributionShadowService;
    shadowEvidence?: ContributionShadowEvidenceWriteService;
    shadowMode?: 'off' | 'shadow';
    // PR9:resource_not_found 回退路径读 rbac.can(行为锁「先判码后查单」);默认 true
    rbacCan?: boolean;
  } = {},
): AttendancesService {
  const recorder = opts.recorder ?? makeRecorderMock();
  const contributionCalculator = opts.contributionCalculator ?? makeContributionCalculatorMock();
  const timeOverlapPolicy = opts.timeOverlapPolicy ?? makeTimeOverlapPolicyMock();
  const stateMachine = opts.stateMachine ?? makeStateMachineMock(DENY_DECISION);
  const notificationProducer =
    opts.notificationProducer ?? makeAttendanceNotificationProducerMock();
  const authz = opts.authz ?? makeAuthzMock();
  const organizations = opts.organizations ?? makeOrganizationsMock();
  // Slow-4 T3(评审稿 D-S4-6):rbac mock `can` 默认恒 true,锁业务行为而非判权;断言零修改。
  const rbac = {
    can: jest.fn<Promise<boolean>, [unknown, string]>().mockResolvedValue(opts.rbacCan ?? true),
  } as unknown as RbacService;
  // Phase 6-B 第三域第一刀:传**真实** AttendanceAccessService / AttendanceReviewService,
  // 并喂同一组 prisma / authz / rbac mock —— 判权、聚合根锁、审批八式的行为锁必须走真实实现。
  // mock 掉它们等于把本 spec 里全部 RBAC_FORBIDDEN / SHEET_NOT_FOUND / 自审同人限制断言
  // 变成自说自话(同 presenter / queryService 的既有处理)。
  // 账本轴在本 spec 中不被驱动(见下方 LedgerQueryService 处注释);占位以满足构造签名。
  const appIdentity = { resolve: jest.fn() };
  const access = new AttendanceAccessService(
    prisma as unknown as PrismaService,
    authz as unknown as AuthzService,
    rbac,
  );
  return new AttendancesService(
    prisma as unknown as PrismaService,
    access,
    new AttendanceReviewService(
      prisma as unknown as PrismaService,
      access,
      authz as unknown as AuthzService,
      rbac,
      stateMachine as unknown as AttendanceSheetStateMachine,
      new AttendancePresenter(),
      recorder as unknown as AttendanceAuditRecorder,
      notificationProducer as unknown as AttendanceNotificationProducer,
      gateStub(false),
    ),
    new AttendanceReadService(
      prisma as unknown as PrismaService,
      access,
      authz as unknown as AuthzService,
      organizations as unknown as OrganizationsService,
      new AttendanceSheetQueryService(prisma as unknown as PrismaService),
      new AttendancePresenter(),
      recorder as unknown as AttendanceAuditRecorder,
      // 第 7 批第 ②-a 刀:同 presenter / queryService,传**真实** LedgerQueryService 并喂同一组
      // prisma / authz / rbac mock。本 spec 不覆盖 getMemberContributionSummary(账本轴的
      // 唯一调用点),故它在这里一次也不会被驱动 —— 传真实实例是为了「以后有人在本 spec 里
      // 加那条用例时,打到的是真实实现而不是一个恒返空的替身」(沿本文件既有理由)。
      new LedgerQueryService(
        prisma as unknown as PrismaService,
        authz as unknown as AuthzService,
        rbac,
        appIdentity as unknown as AppIdentityResolver,
      ),
    ),
    recorder as unknown as AttendanceAuditRecorder,
    contributionCalculator as unknown as ContributionCalculator,
    timeOverlapPolicy,
    stateMachine as unknown as AttendanceSheetStateMachine,
    // Presenter 传真实实例而非 mock(零依赖纯映射类):mapper characterization
    // 断言经真实序列化路径,直接锁 P1-4 第一刀"搬家零漂移"。
    new AttendancePresenter(),
    // Phase 6-B 第二域第一刀:同 presenter,传**真实实例**并喂同一个 prisma mock ——
    // 读路径的既有 characterization 断言(where / select / orderBy / skip / take)因此
    // 继续经新类落到同一个 mock 上,断言一字未改即证「搬家零漂移」。传 mock 反而会
    // 把被测行为挖空。
    new AttendanceSheetQueryService(prisma as unknown as PrismaService),
    rbac,
    // PR9:终审两方法判权走 authz.explain(默认 allow;deny 映射见专属 describe)
    authz as unknown as AuthzService,
    notificationProducer as unknown as AttendanceNotificationProducer,
    organizations as unknown as OrganizationsService,
    {
      attendance: { allowSameReviewer: false, windowToleranceHours: 2 },
      contributionShadowMode: opts.shadowMode ?? 'off',
    } as never,
    new ActivityParticipationPolicy(),
    gateStub(false),
    opts.shadow ??
      new ContributionShadowService({ contributionShadowMode: 'off' } as never, {
        url: undefined,
        contributionShadowUrl: undefined,
      }),
    opts.shadowEvidence ?? new ContributionShadowEvidenceWriteService(),
    new ActivityContributionShadowMappingProofQuery(),
    new AppIdentityResolver(prisma as unknown as PrismaService),
    new AuditLogsService(prisma as unknown as PrismaService, rbac),
  );
}

/**
 * 活动 v1.1 cutover gate 的测试替身。**显式传 false** = 本 spec 断言的是
 * 「闸关(默认 / 今天的行为)」下的行为;闸开时旧写路径改为拒绝,由专属用例覆盖。
 */
function gateStub(enabled: boolean): ActivityWorkflowGate {
  return new ActivityWorkflowGate({ activityV11Workflow: { enabled } } as never);
}

describe('AttendancesService (characterization, scoped)', () => {
  // ============ 1. mapper / DTO response(经 public 读路径触达) ============
  describe('mapper / DTO response', () => {
    it('findOne → toSheetResponseDto 字段透传(含 finalReviewer 三字段)', async () => {
      const prisma = makePrismaMock();
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({
          statusCode: ATTENDANCE_SHEET_STATUS.APPROVED,
          reviewerUserId: 'rev-1',
          finalReviewerUserId: 'fr-1',
          finalReviewNote: 'ok',
        }),
      );
      const recorder = makeRecorderMock();
      const service = makeService(prisma, { recorder });

      const res = await service.findOne('sheet-1', makeCurrentUser(), META);

      expect(res.id).toBe('sheet-1');
      expect(res.statusCode).toBe(ATTENDANCE_SHEET_STATUS.APPROVED);
      expect(res.reviewerUserId).toBe('rev-1');
      expect(res.finalReviewerUserId).toBe('fr-1');
      expect(res.finalReviewNote).toBe('ok');
      expect(recorder.logRead).toHaveBeenCalledWith({
        actorUserId: 'admin-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'attendance_sheet',
        resourceId: 'sheet-1',
        operation: 'detail',
        auditMeta: META,
      });
    });

    it('findOne 不存在 → ATTENDANCE_SHEET_NOT_FOUND', async () => {
      const prisma = makePrismaMock();
      prisma.attendanceSheet.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.findOne('missing', makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ATTENDANCE_SHEET_NOT_FOUND),
      );
    });

    it('findOne:read audit rejection is fail-closed', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      prisma.attendanceSheet.findFirst.mockResolvedValue(makeSheetRow());
      recorder.logRead.mockRejectedValue(new Error('audit unavailable'));
      const service = makeService(prisma, { recorder });

      await expect(service.findOne('sheet-1', makeCurrentUser(), META)).rejects.toThrow(
        'audit unavailable',
      );
    });

    it('reviewDetail audits the completed query with a safe record count', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      prisma.attendanceSheet.findFirst.mockResolvedValue(makeSheetRow());
      prisma.activity.findFirst.mockResolvedValue({
        id: 'act-1',
        title: 'Activity',
        activityTypeCode: 'rescue',
        organizationId: 'org-1',
        startAt: FIXED_IN,
        endAt: FIXED_OUT,
        location: 'Location',
        statusCode: 'published',
      });
      prisma.attendanceRecord.findMany.mockResolvedValue([makeRecordRow()]);
      const service = makeService(prisma, { recorder });

      const result = await service.reviewDetail('sheet-1', makeCurrentUser(), META);

      expect(result.records).toHaveLength(1);
      expect(recorder.logRead).toHaveBeenCalledWith({
        actorUserId: 'admin-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'attendance_sheet',
        resourceId: 'sheet-1',
        operation: 'review-detail',
        count: 1,
        auditMeta: META,
      });
    });

    it('reviewDetail:完整查询后审计失败原样上抛,调用方拿不到 DTO', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const auditError = new Error('attendance review detail audit unavailable');
      prisma.attendanceSheet.findFirst.mockResolvedValue(makeSheetRow());
      prisma.activity.findFirst.mockResolvedValue({
        id: 'act-1',
        title: 'Activity',
        activityTypeCode: 'rescue',
        organizationId: 'org-1',
        startAt: FIXED_IN,
        endAt: FIXED_OUT,
        location: 'Location',
        statusCode: 'published',
      });
      prisma.attendanceRecord.findMany.mockResolvedValue([makeRecordRow()]);
      recorder.logRead.mockRejectedValue(auditError);
      const service = makeService(prisma, { recorder });
      let receivedDto: unknown;

      await expect(
        service.reviewDetail('sheet-1', makeCurrentUser(), META).then((dto) => {
          receivedDto = dto;
          return dto;
        }),
      ).rejects.toBe(auditError);

      expect(prisma.attendanceSheet.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.activity.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.attendanceRecord.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.attendanceRecord.findMany.mock.invocationCallOrder[0]).toBeLessThan(
        recorder.logRead.mock.invocationCallOrder[0],
      );
      expect(receivedDto).toBeUndefined();
    });

    it('listMyRecords → toRecordResponseDto:serviceHours/contributionPoints Decimal→string,member 映射', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({ memberId: 'mem-1' });
      prisma.attendanceRecord.findMany.mockResolvedValue([makeRecordRow()]);
      prisma.attendanceRecord.count.mockResolvedValue(1);
      const service = makeService(prisma);

      const page = await service.listMyRecords(makeMyRecordsQuery(), makeCurrentUser({ id: 'u1' }));

      expect(page.total).toBe(1);
      expect(page.items[0].serviceHours).toBe('4');
      expect(page.items[0].contributionPoints).toBe('1.5');
      expect(page.items[0].member).toEqual({
        id: 'mem-1',
        memberNo: 'M-1',
        realName: 'Member One',
        nickname: null,
        label: 'M-1 · Member One',
      });
    });

    it('listMyRecords:contributionPoints null → null;member null → null', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({ memberId: 'mem-1' });
      prisma.attendanceRecord.findMany.mockResolvedValue([
        makeRecordRow({ contributionPoints: null, member: null }),
      ]);
      prisma.attendanceRecord.count.mockResolvedValue(1);
      const service = makeService(prisma);

      const page = await service.listMyRecords(makeMyRecordsQuery(), makeCurrentUser({ id: 'u1' }));

      expect(page.items[0].contributionPoints).toBeNull();
      expect(page.items[0].member).toBeNull();
    });
  });

  // ============ 2. state-machine deny wiring ============
  describe('state-machine deny wiring', () => {
    it('edit deny → 抛 decision.biz;不 update / 不审计;decide("edit", statusCode)', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.APPROVED }),
      );
      const service = makeService(prisma, { recorder, stateMachine });

      await expect(service.edit('sheet-1', makeEditDto(), makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID),
      );
      expect(stateMachine.decide).toHaveBeenCalledWith('edit', ATTENDANCE_SHEET_STATUS.APPROVED);
      expect(prisma.attendanceSheet.update).not.toHaveBeenCalled();
      expect(recorder.logEdit).not.toHaveBeenCalled();
      expect(recorder.logEditNoRecords).not.toHaveBeenCalled();
    });

    it('softDelete deny → 抛 decision.biz;不 update / 不审计;decide("softDelete", statusCode)', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.APPROVED }),
      );
      const service = makeService(prisma, { recorder, stateMachine });

      await expect(service.softDelete('sheet-1', makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID),
      );
      expect(stateMachine.decide).toHaveBeenCalledWith(
        'softDelete',
        ATTENDANCE_SHEET_STATUS.APPROVED,
      );
      expect(prisma.attendanceSheet.update).not.toHaveBeenCalled();
      expect(recorder.logDelete).not.toHaveBeenCalled();
    });

    it('approve deny → 抛 decision.biz;不查 records / 不 update / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.REJECTED }),
      );
      const service = makeService(prisma, { recorder, stateMachine });

      await expect(
        service.approve('sheet-1', makeApproveDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID));
      expect(stateMachine.decide).toHaveBeenCalledWith('approve', ATTENDANCE_SHEET_STATUS.REJECTED);
      expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled();
      expect(prisma.attendanceSheet.update).not.toHaveBeenCalled();
      expect(recorder.logReview).not.toHaveBeenCalled();
    });

    it('reject deny → 抛 decision.biz;不 update / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.APPROVED }),
      );
      const service = makeService(prisma, { recorder, stateMachine });

      await expect(
        service.reject('sheet-1', makeRejectDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID));
      expect(stateMachine.decide).toHaveBeenCalledWith('reject', ATTENDANCE_SHEET_STATUS.APPROVED);
      expect(prisma.attendanceSheet.update).not.toHaveBeenCalled();
      expect(recorder.logReview).not.toHaveBeenCalled();
    });

    it('finalApprove deny → 抛 decision.biz;不 update / 不审计', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.PENDING }),
      );
      const service = makeService(prisma, { recorder, stateMachine });

      await expect(
        service.finalApprove('sheet-1', makeFinalApproveDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID));
      expect(stateMachine.decide).toHaveBeenCalledWith(
        'finalApprove',
        ATTENDANCE_SHEET_STATUS.PENDING,
      );
      expect(prisma.attendanceSheet.update).not.toHaveBeenCalled();
      expect(recorder.logFinalReview).not.toHaveBeenCalled();
    });

    it('finalReject deny → 抛 decision.biz;不软删 records / 不 update / 不审计(note 校验在状态门之后)', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.PENDING }),
      );
      const service = makeService(prisma, { recorder, stateMachine });

      await expect(
        service.finalReject('sheet-1', makeFinalRejectDto('nope'), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID));
      expect(stateMachine.decide).toHaveBeenCalledWith(
        'finalReject',
        ATTENDANCE_SHEET_STATUS.PENDING,
      );
      expect(prisma.attendanceRecord.updateMany).not.toHaveBeenCalled();
      expect(prisma.attendanceSheet.update).not.toHaveBeenCalled();
      expect(recorder.logFinalReview).not.toHaveBeenCalled();
    });
  });

  // ============ 2b. PR9 终审判权切换(authz deny 映射)============
  // goal 决断①:finalApprove / finalReject 判权走 authz.explain(user, code, {type:'attendance_sheet', id});
  // 约束两 reason → 22074 / 22075;resource_not_found → rbac.can 回退保「先判码后查单」旧契约;
  // 其余一切 deny → 30100。终态 scoped-authz PR12(2026-07-02)起其余 6 管理端动作也切
  // authz.explain(ref 矩阵见 attendances.service.ts assertCanOrThrow 头注),
  // 活动责任闭环起 approve/reject/return 的 self_approval_forbidden 映射 22081；
  // finalApprove/finalReject/finalReturn 的 self/same reason 继续映射 22074/22075。
  describe('PR9 终审 authz 判权(deny 映射)', () => {
    it('finalApprove:authz.explain 收 (user, final-approve 码, ref);approve 亦经 authz 但收各自 action+ref(PR12)', async () => {
      const prisma = makePrismaMock();
      const authz = makeAuthzMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.APPROVED }),
      );
      const service = makeService(prisma, { authz, stateMachine });
      const user = makeCurrentUser();

      await expect(
        service.finalApprove('sheet-1', makeFinalApproveDto(), user, META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID));
      expect(authz.explain).toHaveBeenCalledWith(user, 'attendance.final-approve.sheet', {
        type: 'attendance_sheet',
        id: 'sheet-1',
      });

      authz.explain.mockClear();
      await expect(service.approve('sheet-1', makeApproveDto(), user, META)).rejects.toEqual(
        new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID),
      );
      // PR12:approve 判权也走 authz.explain(不再是「零调用」);收自己的 action + sheet ref,
      // 与 final-approve 的约束否决面(§5.3 注册表)互不相干。
      expect(authz.explain).toHaveBeenCalledWith(user, 'attendance.approve.sheet', {
        type: 'attendance_sheet',
        id: 'sheet-1',
      });
    });

    it('finalReject:authz.explain 收 final-reject 码 + 同 ref 形状', async () => {
      const prisma = makePrismaMock();
      const authz = makeAuthzMock();
      const stateMachine = makeStateMachineMock(DENY_DECISION);
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.APPROVED }),
      );
      const service = makeService(prisma, { authz, stateMachine });
      const user = makeCurrentUser();

      await expect(
        service.finalReject('sheet-1', makeFinalRejectDto('no'), user, META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID));
      expect(authz.explain).toHaveBeenCalledWith(user, 'attendance.final-reject.sheet', {
        type: 'attendance_sheet',
        id: 'sheet-1',
      });
    });

    it('一审 self_approval_forbidden → 22081；不进事务 / 不审计', async () => {
      for (const invoke of [
        (service: AttendancesService) =>
          service.approve('sheet-1', makeApproveDto(), makeCurrentUser(), META),
        (service: AttendancesService) =>
          service.reject('sheet-1', makeRejectDto(), makeCurrentUser(), META),
      ]) {
        const prisma = makePrismaMock();
        const authz = makeAuthzMock({ allow: false, reason: 'self_approval_forbidden' });
        const recorder = makeRecorderMock();
        const service = makeService(prisma, { authz, recorder });

        await expect(invoke(service)).rejects.toEqual(
          new BizException(BizCode.ATTENDANCE_SELF_FIRST_REVIEW_FORBIDDEN),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(recorder.logReview).not.toHaveBeenCalled();
      }
    });

    it('终审 self_approval_forbidden → 22074(finalApprove / finalReject 同映射面)', async () => {
      const prisma = makePrismaMock();
      const authz = makeAuthzMock({ allow: false, reason: 'self_approval_forbidden' });
      const recorder = makeRecorderMock();
      const service = makeService(prisma, { authz, recorder });

      await expect(
        service.finalApprove('sheet-1', makeFinalApproveDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SELF_FINAL_REVIEW_FORBIDDEN));
      await expect(
        service.finalReject('sheet-1', makeFinalRejectDto('no'), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SELF_FINAL_REVIEW_FORBIDDEN));
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(recorder.logFinalReview).not.toHaveBeenCalled();
    });

    it('same_reviewer_forbidden → 22075(finalApprove / finalReject 同映射面)', async () => {
      const prisma = makePrismaMock();
      const authz = makeAuthzMock({ allow: false, reason: 'same_reviewer_forbidden' });
      const service = makeService(prisma, { authz });

      await expect(
        service.finalApprove('sheet-1', makeFinalApproveDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SAME_REVIEWER_FORBIDDEN));
      await expect(
        service.finalReject('sheet-1', makeFinalRejectDto('no'), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SAME_REVIEWER_FORBIDDEN));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('no_permission / out_of_scope / expired_grant / inactive_org → 30100(权限拒绝面契约零变)', async () => {
      for (const reason of ['no_permission', 'out_of_scope', 'expired_grant', 'inactive_org']) {
        const prisma = makePrismaMock();
        const service = makeService(prisma, { authz: makeAuthzMock({ allow: false, reason }) });
        await expect(
          service.finalApprove('sheet-1', makeFinalApproveDto(), makeCurrentUser(), META),
        ).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
        expect(prisma.$transaction).not.toHaveBeenCalled();
      }
    });

    it('resource_not_found + 持全局码 → 放行进事务,findSheetOrThrow 抛 22001(行为锁「先判码后查单」)', async () => {
      const prisma = makePrismaMock();
      const authz = makeAuthzMock({ allow: false, reason: 'resource_not_found' });
      prisma.attendanceSheet.findFirst.mockResolvedValue(null);
      const service = makeService(prisma, { authz, rbacCan: true });

      await expect(
        service.finalApprove('missing', makeFinalApproveDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SHEET_NOT_FOUND));
    });

    it('resource_not_found + 无全局码 → 30100(防枚举;不进事务)', async () => {
      const prisma = makePrismaMock();
      const authz = makeAuthzMock({ allow: false, reason: 'resource_not_found' });
      const service = makeService(prisma, { authz, rbacCan: false });

      await expect(
        service.finalReject('missing', makeFinalRejectDto('x'), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ============ 3. state-machine allow + audit wiring ============
  describe('state-machine allow + audit wiring', () => {
    it('edit no-records → lock 后权威 version/snapshot/audit before，不复用锁前行', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({
        allowed: true,
        nextStatusCode: ATTENDANCE_SHEET_STATUS.PENDING,
      });
      const observed = makeSheetRow({ version: 1, reviewNote: 'stale-before-lock' });
      const locked = makeSheetRow({ version: 7, reviewNote: 'locked-authoritative' });
      prisma.attendanceSheet.findFirst
        .mockResolvedValueOnce(observed)
        .mockResolvedValueOnce(locked);
      prisma.attendanceRecord.findMany.mockResolvedValue([]);
      prisma.attendanceSheet.update.mockResolvedValue(makeSheetRow({ version: 8 }));
      const service = makeService(prisma, { recorder, stateMachine });

      await service.edit('sheet-1', makeEditDto(), makeCurrentUser(), META);

      expect(recorder.buildPreviousSnapshot).toHaveBeenCalledWith(locked, []);
      const updateArg = prisma.attendanceSheet.update.mock.calls[0][0] as {
        data: { version: number };
      };
      expect(updateArg.data.version).toBe(8);
      expect(recorder.logEditNoRecords).toHaveBeenCalledWith(
        expect.objectContaining({ beforeSheet: locked, newVersion: 8, tx: prisma }),
      );
    });

    it('approve allow → update nextStatus + reviewer;logReview(action=approve, tx)', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({
        allowed: true,
        nextStatusCode: ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW,
      });
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.PENDING }),
      );
      // R31:所有 records.contributionPoints 非 null
      prisma.attendanceRecord.findMany.mockResolvedValue([
        { id: 'r1', contributionPoints: new Prisma.Decimal('1.5') },
      ]);
      prisma.attendanceSheet.update.mockResolvedValue(
        makeSheetRow({
          statusCode: ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW,
          reviewerUserId: 'admin-1',
        }),
      );
      const service = makeService(prisma, { recorder, stateMachine });

      const res = await service.approve(
        'sheet-1',
        makeApproveDto('looks good'),
        makeCurrentUser({ id: 'admin-1' }),
        META,
      );

      const updateArg = prisma.attendanceSheet.update.mock.calls[0][0] as {
        data: { statusCode: string; reviewerUserId: string };
      };
      expect(updateArg.data.statusCode).toBe(ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW);
      expect(updateArg.data.reviewerUserId).toBe('admin-1');
      expect(recorder.logReview).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'approve', tx: prisma }),
      );
      expect(res.statusCode).toBe(ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW);
    });

    it('reject allow → records 软删(updateMany)+ update rejected + reviewNote;logReview(action=reject, recordsCount, tx)', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({
        allowed: true,
        nextStatusCode: ATTENDANCE_SHEET_STATUS.REJECTED,
      });
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.PENDING }),
      );
      // F4:reject 软删前抓 records 快照(对称 finalReject);2 条 → recordsCount=2
      prisma.attendanceRecord.findMany.mockResolvedValue([makeRecordRow(), makeRecordRow()]);
      prisma.attendanceSheet.update.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.REJECTED, reviewNote: 'bad data' }),
      );
      const service = makeService(prisma, { recorder, stateMachine });

      const res = await service.reject(
        'sheet-1',
        makeRejectDto('bad data'),
        makeCurrentUser(),
        META,
      );

      // F4:records 跟随软删(updateMany 写 deletedAt;沿 finalReject 断言范式)
      expect(prisma.attendanceRecord.updateMany).toHaveBeenCalledTimes(1);
      const recUpdateArg = prisma.attendanceRecord.updateMany.mock.calls[0][0] as {
        where: { sheetId: string; deletedAt: null };
        data: { deletedAt: Date };
      };
      expect(recUpdateArg.where.sheetId).toBe('sheet-1');
      expect(recUpdateArg.data.deletedAt).toBeInstanceOf(Date);
      const updateArg = prisma.attendanceSheet.update.mock.calls[0][0] as {
        data: { statusCode: string; reviewNote: string };
      };
      expect(updateArg.data.statusCode).toBe(ATTENDANCE_SHEET_STATUS.REJECTED);
      expect(updateArg.data.reviewNote).toBe('bad data');
      // F4:logReview 带 beforeRecords + recordsCount(对称 finalReject)
      expect(recorder.logReview).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'reject', recordsCount: 2, tx: prisma }),
      );
      expect(res.statusCode).toBe(ATTENDANCE_SHEET_STATUS.REJECTED);
    });

    it('finalApprove allow → update approved + finalReviewer;logFinalReview(action=final-approve, tx)', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({
        allowed: true,
        nextStatusCode: ATTENDANCE_SHEET_STATUS.APPROVED,
      });
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW }),
      );
      // finalApprove 内 attendanceRecord.findMany 用于 event 触发(records 映射)
      prisma.attendanceRecord.findMany.mockResolvedValue([makeRecordRow()]);
      prisma.attendanceSheet.update.mockResolvedValue(
        makeSheetRow({
          statusCode: ATTENDANCE_SHEET_STATUS.APPROVED,
          finalReviewerUserId: 'admin-1',
        }),
      );
      const service = makeService(prisma, { recorder, stateMachine });

      const res = await service.finalApprove(
        'sheet-1',
        makeFinalApproveDto('final ok'),
        makeCurrentUser({ id: 'admin-1' }),
        META,
      );

      const updateArg = prisma.attendanceSheet.update.mock.calls[0][0] as {
        data: { statusCode: string; finalReviewerUserId: string };
      };
      expect(updateArg.data.statusCode).toBe(ATTENDANCE_SHEET_STATUS.APPROVED);
      expect(updateArg.data.finalReviewerUserId).toBe('admin-1');
      expect(recorder.logFinalReview).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'final-approve', tx: prisma }),
      );
      expect(res.statusCode).toBe(ATTENDANCE_SHEET_STATUS.APPROVED);
    });

    // ===== PR-L4:终审通过 → 业务/audit/通知 intent 同事务 =====
    it('PR-L4:finalApprove → 逐 record 通知 intent 与 audit 共用 tx', async () => {
      const prisma = makePrismaMock();
      const stateMachine = makeStateMachineMock({
        allowed: true,
        nextStatusCode: ATTENDANCE_SHEET_STATUS.APPROVED,
      });
      const notificationProducer = makeAttendanceNotificationProducerMock();
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW }),
      );
      prisma.attendanceRecord.findMany.mockResolvedValue([
        makeRecordRow({
          id: 'rec-1',
          memberId: 'mem-1',
          contributionPoints: new Prisma.Decimal('1.50'),
        }),
        makeRecordRow({
          id: 'rec-2',
          memberId: 'mem-2',
          contributionPoints: new Prisma.Decimal('2.00'),
        }),
      ]);
      prisma.attendanceSheet.update.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.APPROVED, activityId: 'act-9' }),
      );
      const service = makeService(prisma, { stateMachine, notificationProducer });

      const res = await service.finalApprove(
        'sheet-1',
        makeFinalApproveDto('ok'),
        makeCurrentUser(),
        META,
      );
      expect(res.statusCode).toBe(ATTENDANCE_SHEET_STATUS.APPROVED);

      expect(notificationProducer.prepareContributionThresholdSnapshots).toHaveBeenCalledWith(
        prisma,
        expect.arrayContaining([
          expect.objectContaining({ id: 'rec-1', memberId: 'mem-1' }),
          expect.objectContaining({ id: 'rec-2', memberId: 'mem-2' }),
        ]),
      );
      expect(notificationProducer.enqueueFinalApproved).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          sheetId: 'sheet-1',
          activityId: 'act-9',
          records: [
            { id: 'rec-1', memberId: 'mem-1', contributionPoints: '1.5' },
            { id: 'rec-2', memberId: 'mem-2', contributionPoints: '2' },
          ],
          contributionThresholdSnapshots: [],
        }),
      );
      const prepareOrder =
        notificationProducer.prepareContributionThresholdSnapshots.mock.invocationCallOrder[0];
      const updateOrder = prisma.attendanceSheet.update.mock.invocationCallOrder[0];
      const enqueueOrder = notificationProducer.enqueueFinalApproved.mock.invocationCallOrder[0];
      expect(prepareOrder).toBeLessThan(updateOrder);
      expect(enqueueOrder).toBeGreaterThan(updateOrder);
    });

    it('PR-L4:intent 写失败向外抛出，让真实事务回滚终审', async () => {
      const prisma = makePrismaMock();
      const stateMachine = makeStateMachineMock({
        allowed: true,
        nextStatusCode: ATTENDANCE_SHEET_STATUS.APPROVED,
      });
      const notificationProducer = makeAttendanceNotificationProducerMock();
      notificationProducer.enqueueFinalApproved.mockRejectedValue(new Error('enqueue boom'));
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW }),
      );
      prisma.attendanceRecord.findMany.mockResolvedValue([makeRecordRow()]);
      prisma.attendanceSheet.update.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.APPROVED }),
      );
      const service = makeService(prisma, { stateMachine, notificationProducer });

      await expect(
        service.finalApprove('sheet-1', makeFinalApproveDto('ok'), makeCurrentUser(), META),
      ).rejects.toThrow('enqueue boom');
      expect(prisma.attendanceSheet.update).toHaveBeenCalledTimes(1);
      expect(notificationProducer.enqueueFinalApproved).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ sheetId: 'sheet-1' }),
      );
    });

    it('finalReject allow → records 软删(updateMany)+ update final_rejected;logFinalReview(action=final-reject, tx)', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({
        allowed: true,
        nextStatusCode: ATTENDANCE_SHEET_STATUS.FINAL_REJECTED,
      });
      const observed = makeSheetRow({
        statusCode: ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW,
        finalReviewNote: 'stale-before-lock',
      });
      const locked = makeSheetRow({
        statusCode: ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW,
        finalReviewNote: 'locked-authoritative',
      });
      prisma.attendanceSheet.findFirst
        .mockResolvedValueOnce(observed)
        .mockResolvedValueOnce(locked);
      prisma.attendanceRecord.findMany.mockResolvedValue([makeRecordRow()]);
      prisma.attendanceSheet.update.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.FINAL_REJECTED }),
      );
      const service = makeService(prisma, { recorder, stateMachine });

      const res = await service.finalReject(
        'sheet-1',
        makeFinalRejectDto('insufficient'),
        makeCurrentUser(),
        META,
      );

      expect(prisma.attendanceRecord.updateMany).toHaveBeenCalledTimes(1);
      const updateArg = prisma.attendanceSheet.update.mock.calls[0][0] as {
        data: { statusCode: string; finalReviewNote: string };
      };
      expect(updateArg.data.statusCode).toBe(ATTENDANCE_SHEET_STATUS.FINAL_REJECTED);
      expect(updateArg.data.finalReviewNote).toBe('insufficient');
      expect(recorder.logFinalReview).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'final-reject', beforeSheet: locked, tx: prisma }),
      );
      expect(res.statusCode).toBe(ATTENDANCE_SHEET_STATUS.FINAL_REJECTED);
    });
  });

  // ============ 4. guards ============
  describe('guards', () => {
    it('approve R31:任一 record.contributionPoints null → CONTRIBUTION_POINTS_REQUIRED;不 update', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({
        allowed: true,
        nextStatusCode: ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW,
      });
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.PENDING }),
      );
      prisma.attendanceRecord.findMany.mockResolvedValue([
        { id: 'r1', contributionPoints: new Prisma.Decimal('1.5') },
        { id: 'r2', contributionPoints: null },
      ]);
      const service = makeService(prisma, { recorder, stateMachine });

      await expect(
        service.approve('sheet-1', makeApproveDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_RECORD_CONTRIBUTION_POINTS_REQUIRED));
      expect(prisma.attendanceSheet.update).not.toHaveBeenCalled();
      expect(recorder.logReview).not.toHaveBeenCalled();
    });

    it('finalReject allow 但 note 空白 → FINAL_REVIEW_NOTE_REQUIRED;不软删 / 不 update', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({
        allowed: true,
        nextStatusCode: ATTENDANCE_SHEET_STATUS.FINAL_REJECTED,
      });
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW }),
      );
      const service = makeService(prisma, { recorder, stateMachine });

      await expect(
        service.finalReject('sheet-1', makeFinalRejectDto('   '), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_NOTE_REQUIRED));
      expect(prisma.attendanceRecord.updateMany).not.toHaveBeenCalled();
      expect(prisma.attendanceSheet.update).not.toHaveBeenCalled();
      expect(recorder.logFinalReview).not.toHaveBeenCalled();
    });

    it('submit 两条 records：字典/成员/报名各一次 IN 预取，查询次数不随 records 数增长', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const contributionCalculator = makeContributionCalculatorMock();
      const timeOverlapPolicy = makeTimeOverlapPolicyMock();
      prisma.activity.findFirst.mockResolvedValue({
        id: 'act-1',
        statusCode: 'published',
        activityTypeCode: 'training',
        startAt: new Date('2026-01-01T07:00:00.000Z'),
        endAt: new Date('2026-01-01T18:00:00.000Z'),
      });
      prisma.dictItem.findMany.mockResolvedValue([
        { code: 'volunteer', type: { code: 'attendance_role' } },
        { code: 'present', type: { code: 'attendance_status' } },
      ]);
      prisma.member.findMany.mockResolvedValue([{ id: 'mem-1' }, { id: 'mem-2' }]);
      prisma.activityRegistration.findMany.mockResolvedValue([]);
      prisma.attendanceSheet.create.mockResolvedValue(makeSheetRow());
      prisma.attendanceRecord.findMany.mockResolvedValue([
        makeRecordRow(),
        makeRecordRow({ id: 'rec-2', memberId: 'mem-2' }),
      ]);
      const service = makeService(prisma, {
        recorder,
        contributionCalculator,
        timeOverlapPolicy,
      });

      const result = await service.submit(
        'act-1',
        makeSubmitDto([
          {
            memberId: 'mem-1',
            roleCode: 'volunteer',
            checkInAt: '2026-01-01T08:00:00.000Z',
            checkOutAt: '2026-01-01T10:00:00.000Z',
            attendanceStatusCode: 'present',
          },
          {
            memberId: 'mem-2',
            roleCode: 'volunteer',
            checkInAt: '2026-01-01T10:00:00.000Z',
            checkOutAt: '2026-01-01T12:00:00.000Z',
            attendanceStatusCode: 'present',
          },
        ]),
        makeCurrentUser(),
        META,
      );

      expect(result.id).toBe('sheet-1');
      expect(prisma.dictItem.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.member.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.activityRegistration.findMany).toHaveBeenCalledTimes(1);
      expect(timeOverlapPolicy.lockMembersForOverlapCheck).toHaveBeenCalledTimes(1);
      expect(timeOverlapPolicy.assertNoTimeOverlapForRecords).toHaveBeenCalledTimes(1);
      expect(contributionCalculator.applyContributionRulePrefill).toHaveBeenCalledTimes(1);
      expect(recorder.logSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ activityPushedToCompleted: false, recordsCount: 2 }),
      );
    });

    // Phase 6-B 第二刀接线锁:时间窗容差原本由 `assertRecordWithinActivityWindow` 直接读
    // `this.config`,抽成纯函数后改由 service **当入参传给 policy** —— 这引入了一个原本不存在的
    // 失效形态:「传错值」。本用例把容差的实际取值钉在 service→policy 的接线上:
    // 活动窗 07:00-18:00,记录 18:00-19:00 落在 +2h 容差带内 ⇒ 必须放行;
    // 若接线退化成传 0(或漏传),这条立刻红成 22078。
    it('submit:记录落在活动窗外但在容差带内 → 放行(钉住 service 传给 policy 的容差取值)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue({
        id: 'act-1',
        statusCode: 'published',
        activityTypeCode: 'training',
        startAt: new Date('2026-01-01T07:00:00.000Z'),
        endAt: new Date('2026-01-01T18:00:00.000Z'),
      });
      prisma.dictItem.findMany.mockResolvedValue([
        { code: 'volunteer', type: { code: 'attendance_role' } },
        { code: 'present', type: { code: 'attendance_status' } },
      ]);
      prisma.member.findMany.mockResolvedValue([{ id: 'mem-1' }]);
      prisma.activityRegistration.findMany.mockResolvedValue([]);
      prisma.attendanceSheet.create.mockResolvedValue(makeSheetRow());
      prisma.attendanceRecord.findMany.mockResolvedValue([makeRecordRow()]);
      const service = makeService(prisma);

      const result = await service.submit(
        'act-1',
        makeSubmitDto([
          {
            memberId: 'mem-1',
            roleCode: 'volunteer',
            checkInAt: '2026-01-01T18:00:00.000Z',
            checkOutAt: '2026-01-01T19:00:00.000Z',
            attendanceStatusCode: 'present',
          },
        ]),
        makeCurrentUser(),
        META,
      );

      expect(result.id).toBe('sheet-1');
    });

    // 同上,但走**带 registrationId** 的路径 —— 容差在 service 里有**两个**传入点:
    // ① 批量校验 `validateAndNormalizeRecordsBatch`;② claim 锁后复判 `claimAndRecheckRegistrations`。
    // 上一条只钉住 ①;本条让记录带上 pass 报名,从而必须同时穿过 ②,把第二个传入点也钉住。
    it('submit(带报名):容差带内记录也要穿过 claim 锁后复判 → 放行(钉住第二个容差传入点)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue({
        id: 'act-1',
        statusCode: 'published',
        activityTypeCode: 'training',
        startAt: new Date('2026-01-01T07:00:00.000Z'),
        endAt: new Date('2026-01-01T18:00:00.000Z'),
      });
      prisma.dictItem.findMany.mockResolvedValue([
        { code: 'volunteer', type: { code: 'attendance_role' } },
        { code: 'present', type: { code: 'attendance_status' } },
      ]);
      prisma.member.findMany.mockResolvedValue([{ id: 'mem-1' }]);
      // 批量预取与 claim 锁后复读复用同一个 mock,两次都返回这行 pass 报名。
      prisma.activityRegistration.findMany.mockResolvedValue([
        {
          id: 'reg-1',
          activityId: 'act-1',
          memberId: 'mem-1',
          statusCode: 'pass',
          activityPosition: null,
        },
      ]);
      prisma.attendanceSheet.create.mockResolvedValue(makeSheetRow());
      prisma.attendanceRecord.findMany.mockResolvedValue([makeRecordRow()]);
      const service = makeService(prisma);

      const result = await service.submit(
        'act-1',
        makeSubmitDto([
          {
            memberId: 'mem-1',
            roleCode: 'volunteer',
            checkInAt: '2026-01-01T18:00:00.000Z',
            checkOutAt: '2026-01-01T19:00:00.000Z',
            attendanceStatusCode: 'present',
            registrationId: 'reg-1',
          },
        ]),
        makeCurrentUser(),
        META,
      );

      expect(result.id).toBe('sheet-1');
      // 锁后确实复读了一次(批量预取 1 次 + 复读 1 次)
      expect(prisma.activityRegistration.findMany).toHaveBeenCalledTimes(2);
    });

    it('submit:记录超出容差带 → ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW(容差不是无限大)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue({
        id: 'act-1',
        statusCode: 'published',
        activityTypeCode: 'training',
        startAt: new Date('2026-01-01T07:00:00.000Z'),
        endAt: new Date('2026-01-01T18:00:00.000Z'),
      });
      prisma.dictItem.findMany.mockResolvedValue([
        { code: 'volunteer', type: { code: 'attendance_role' } },
        { code: 'present', type: { code: 'attendance_status' } },
      ]);
      prisma.member.findMany.mockResolvedValue([{ id: 'mem-1' }]);
      prisma.activityRegistration.findMany.mockResolvedValue([]);
      const service = makeService(prisma);

      await expect(
        service.submit(
          'act-1',
          makeSubmitDto([
            {
              memberId: 'mem-1',
              roleCode: 'volunteer',
              checkInAt: '2026-01-01T19:00:00.000Z',
              checkOutAt: '2026-01-01T20:00:00.001Z',
              attendanceStatusCode: 'present',
            },
          ]),
          makeCurrentUser(),
          META,
        ),
      ).rejects.toEqual(new BizException(BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW));
    });

    it('submit:activity 不存在 → ACTIVITY_NOT_FOUND(浅层 guard,不进 record 循环)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(
        service.submit('act-x', makeSubmitDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_NOT_FOUND));
      expect(prisma.attendanceSheet.update).not.toHaveBeenCalled();
    });

    it('submit:activity cancelled → ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN(浅层 guard)', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue({ id: 'act-1', statusCode: 'cancelled' });
      const service = makeService(prisma);

      await expect(
        service.submit('act-1', makeSubmitDto(), makeCurrentUser(), META),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN));
    });

    it('listMyRecords:user 未绑定 memberId → MEMBER_NOT_FOUND;不查 records', async () => {
      const prisma = makePrismaMock();
      prisma.user.findFirst.mockResolvedValue({ memberId: null });
      const service = makeService(prisma);

      await expect(
        service.listMyRecords(makeMyRecordsQuery(), makeCurrentUser({ id: 'u1' })),
      ).rejects.toEqual(new BizException(BizCode.MEMBER_NOT_FOUND));
      expect(prisma.attendanceRecord.findMany).not.toHaveBeenCalled();
    });
  });

  // ============ 5. list shallow behavior ============
  describe('list — shallow pagination', () => {
    it('activity 存在 → findMany/count 分页;statusCode 入参进 where', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue({ id: 'act-1', statusCode: 'published' });
      prisma.attendanceSheet.findMany.mockResolvedValue([makeSheetRow()]);
      prisma.attendanceSheet.count.mockResolvedValue(1);
      const recorder = makeRecorderMock();
      const service = makeService(prisma, { recorder });

      const page = await service.list(
        'act-1',
        makeListQuery(ATTENDANCE_SHEET_STATUS.PENDING),
        makeCurrentUser(),
        META,
      );

      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      const findManyArg = prisma.attendanceSheet.findMany.mock.calls[0][0] as {
        where: { activityId: string; statusCode?: string };
      };
      expect(findManyArg.where.activityId).toBe('act-1');
      expect(findManyArg.where.statusCode).toBe(ATTENDANCE_SHEET_STATUS.PENDING);
      expect(recorder.logRead).toHaveBeenCalledWith({
        actorUserId: 'admin-1',
        actorRoleSnap: Role.ADMIN,
        resourceType: 'activity',
        resourceId: 'act-1',
        operation: 'list',
        count: 1,
        filterFields: ['statusCode'],
        auditMeta: META,
      });
    });

    it('list:activity 不存在 → ACTIVITY_NOT_FOUND;不查 sheets', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.list('act-x', makeListQuery(), makeCurrentUser(), META)).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_NOT_FOUND),
      );
      expect(prisma.attendanceSheet.findMany).not.toHaveBeenCalled();
    });
  });
});

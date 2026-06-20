import { Prisma, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { AttendanceAuditRecorder } from './attendance-audit-recorder';
import { AttendancePresenter } from './attendance-presenter';
import type {
  AttendanceSheetStateMachine,
  AttendanceSheetTransitionDecision,
} from './attendance-sheet-state-machine';
import type { RbacService } from '../permissions/rbac.service';
import type { ContributionCalculator } from './contribution-calculator';
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
import { AttendancesService } from './attendances.service';

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
// - **不测 submit / edit 深事务 happy-path**(prefill / overlap / snapshot / 软删重建全链 → 归
//   attendances-contribution-prefill / attendances-time-overlap / attendances-audit-characterization e2e)。
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
  member: { id: string; memberNo: string; displayName: string } | null;
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
    member: { id: 'mem-1', memberNo: 'M-1', displayName: 'Member One' },
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
function makeSubmitDto(): CreateAttendanceSheetDto {
  return { records: [] };
}
function makeListQuery(statusCode?: string): ListAttendanceSheetsQueryDto {
  return { page: 1, pageSize: 20, statusCode };
}
function makeMyRecordsQuery(activityId?: string): MyAttendanceRecordsQueryDto {
  return { page: 1, pageSize: 20, activityId };
}

// ============ mock 工厂 ============

function makePrismaMock() {
  const attendanceSheet = {
    findFirst: jest.fn<Promise<SheetRow | null>, [unknown]>(),
    findMany: jest.fn<Promise<SheetRow[]>, [unknown]>(),
    count: jest.fn<Promise<number>, [unknown]>(),
    update: jest.fn<Promise<SheetRow>, [unknown]>(),
  };
  const attendanceRecord = {
    findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    count: jest.fn<Promise<number>, [unknown]>(),
    updateMany: jest.fn<Promise<{ count: number }>, [unknown]>().mockResolvedValue({ count: 0 }),
  };
  const user = { findFirst: jest.fn<Promise<{ memberId: string | null } | null>, [unknown]>() };
  const activity = {
    findFirst: jest.fn<Promise<{ id: string; statusCode: string } | null>, [unknown]>(),
  };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const prisma = { attendanceSheet, attendanceRecord, user, activity, $transaction };
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
    logSubmit: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
    logEdit: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
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
  };
}
type ContributionCalculatorMock = ReturnType<typeof makeContributionCalculatorMock>;

function makeTimeOverlapPolicyMock() {
  return {
    assertNoInternalOverlap: jest.fn<void, [unknown[]]>(),
    assertNoTimeOverlap: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
  };
}
type TimeOverlapPolicyMock = ReturnType<typeof makeTimeOverlapPolicyMock>;

function makeService(
  prisma: PrismaMock,
  opts: {
    recorder?: RecorderMock;
    contributionCalculator?: ContributionCalculatorMock;
    timeOverlapPolicy?: TimeOverlapPolicyMock;
    stateMachine?: StateMachineMock;
  } = {},
): AttendancesService {
  const recorder = opts.recorder ?? makeRecorderMock();
  const contributionCalculator = opts.contributionCalculator ?? makeContributionCalculatorMock();
  const timeOverlapPolicy = opts.timeOverlapPolicy ?? makeTimeOverlapPolicyMock();
  const stateMachine = opts.stateMachine ?? makeStateMachineMock(DENY_DECISION);
  return new AttendancesService(
    prisma as unknown as PrismaService,
    recorder as unknown as AttendanceAuditRecorder,
    contributionCalculator as unknown as ContributionCalculator,
    timeOverlapPolicy,
    stateMachine as unknown as AttendanceSheetStateMachine,
    // Presenter 传真实实例而非 mock(零依赖纯映射类):mapper characterization
    // 断言经真实序列化路径,直接锁 P1-4 第一刀"搬家零漂移"。
    new AttendancePresenter(),
    // Slow-4 T3(评审稿 D-S4-6):rbac mock `can` 恒 true,锁业务行为而非判权;断言零修改。
    {
      can: jest.fn<Promise<boolean>, [unknown, string]>().mockResolvedValue(true),
    } as unknown as RbacService,
  );
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
      const service = makeService(prisma);

      const res = await service.findOne('sheet-1', makeCurrentUser());

      expect(res.id).toBe('sheet-1');
      expect(res.statusCode).toBe(ATTENDANCE_SHEET_STATUS.APPROVED);
      expect(res.reviewerUserId).toBe('rev-1');
      expect(res.finalReviewerUserId).toBe('fr-1');
      expect(res.finalReviewNote).toBe('ok');
    });

    it('findOne 不存在 → ATTENDANCE_SHEET_NOT_FOUND', async () => {
      const prisma = makePrismaMock();
      prisma.attendanceSheet.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.findOne('missing', makeCurrentUser())).rejects.toEqual(
        new BizException(BizCode.ATTENDANCE_SHEET_NOT_FOUND),
      );
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
        displayName: 'Member One',
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

  // ============ 3. state-machine allow + audit wiring ============
  describe('state-machine allow + audit wiring', () => {
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

    it('finalReject allow → records 软删(updateMany)+ update final_rejected;logFinalReview(action=final-reject, tx)', async () => {
      const prisma = makePrismaMock();
      const recorder = makeRecorderMock();
      const stateMachine = makeStateMachineMock({
        allowed: true,
        nextStatusCode: ATTENDANCE_SHEET_STATUS.FINAL_REJECTED,
      });
      prisma.attendanceSheet.findFirst.mockResolvedValue(
        makeSheetRow({ statusCode: ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW }),
      );
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
        expect.objectContaining({ action: 'final-reject', tx: prisma }),
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
      const service = makeService(prisma);

      const page = await service.list(
        'act-1',
        makeListQuery(ATTENDANCE_SHEET_STATUS.PENDING),
        makeCurrentUser(),
      );

      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      const findManyArg = prisma.attendanceSheet.findMany.mock.calls[0][0] as {
        where: { activityId: string; statusCode?: string };
      };
      expect(findManyArg.where.activityId).toBe('act-1');
      expect(findManyArg.where.statusCode).toBe(ATTENDANCE_SHEET_STATUS.PENDING);
    });

    it('list:activity 不存在 → ACTIVITY_NOT_FOUND;不查 sheets', async () => {
      const prisma = makePrismaMock();
      prisma.activity.findFirst.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.list('act-x', makeListQuery(), makeCurrentUser())).rejects.toEqual(
        new BizException(BizCode.ACTIVITY_NOT_FOUND),
      );
      expect(prisma.attendanceSheet.findMany).not.toHaveBeenCalled();
    });
  });
});

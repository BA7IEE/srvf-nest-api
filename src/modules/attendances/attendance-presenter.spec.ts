import { Prisma } from '@prisma/client';

import { AttendancePresenter } from './attendance-presenter';

// AttendancePresenter 组件级 unit spec(P1-4 第一刀伴随护栏;沿 #278/#279 纯组件 spec 范式)。
// 行为权威是 attendances.service.spec.ts mapper characterization(经真实 Presenter 实例)
// + attendances e2e 全组;本 spec 只锁纯映射本身:
//   1. 三个 DTO 的字段集与透传(严格相等,防字段悄悄增删);
//   2. Decimal → string 序列化(serviceHours 必转 / contributionPoints 三态);
//   3. member 摘要的 null 防御分支。

const D = (s: string) => new Prisma.Decimal(s);
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T08:00:00.000Z');
const T2 = new Date('2026-01-01T12:00:00.000Z');

describe('AttendancePresenter', () => {
  let presenter: AttendancePresenter;

  beforeEach(() => {
    presenter = new AttendancePresenter();
  });

  describe('decimalToString', () => {
    it('null → null;Decimal → 字符串(保留两位小数形态)', () => {
      expect(presenter.decimalToString(null)).toBeNull();
      expect(presenter.decimalToString(D('1.50'))).toBe('1.5');
      expect(presenter.decimalToString(D('0.75'))).toBe('0.75');
    });
  });

  describe('toSheetResponseDto', () => {
    it('20 字段严格透传(含重提/退回字段;不夹带 previousSnapshot 等多余字段)', () => {
      const row = {
        id: 'sheet-1',
        activityId: 'act-1',
        submitterUserId: 'u1',
        submittedAt: T0,
        statusCode: 'pending',
        reviewerUserId: 'u2',
        reviewedAt: T1,
        reviewNote: 'ok',
        finalReviewerUserId: 'u3',
        finalReviewedAt: T2,
        finalReviewNote: 'final ok',
        lastSubmittedByUserId: 'u1',
        lastSubmittedAt: T0,
        returnedByUserId: null,
        returnedAt: null,
        returnNote: null,
        returnedFromStageCode: null,
        version: 2,
        createdAt: T0,
        updatedAt: T1,
      };

      expect(presenter.toSheetResponseDto(row)).toEqual(row);
      // 入参多余字段(如 previousSnapshot)不得透传到 DTO
      const extra = { ...row, previousSnapshot: { foo: 'bar' } };
      expect(presenter.toSheetResponseDto(extra)).toEqual(row);
    });
  });

  describe('toSheetListItemDto', () => {
    it('列表项仅 8 字段(无 review/finalReview 详情字段)', () => {
      const row = {
        id: 'sheet-1',
        activityId: 'act-1',
        submitterUserId: 'u1',
        submittedAt: T0,
        statusCode: 'pending',
        reviewedAt: null,
        version: 1,
        createdAt: T0,
      };

      const dto = presenter.toSheetListItemDto(row);

      expect(dto).toEqual(row);
      expect(Object.keys(dto)).toHaveLength(8);
    });
  });

  describe('toRecordResponseDto', () => {
    const baseRow = {
      id: 'rec-1',
      sheetId: 'sheet-1',
      memberId: 'mem-1',
      member: { id: 'mem-1', memberNo: 'M001', displayName: '张三' },
      roleCode: 'volunteer',
      checkInAt: T1,
      checkOutAt: T2,
      serviceHours: D('4.00'),
      attendanceStatusCode: 'present',
      note: null,
      registrationId: null,
      contributionPoints: D('1.25'),
      createdAt: T0,
      updatedAt: T0,
    };

    it('Decimal 字段序列化为字符串;member 摘要三字段', () => {
      const dto = presenter.toRecordResponseDto(baseRow);

      expect(dto.serviceHours).toBe('4');
      expect(dto.contributionPoints).toBe('1.25');
      expect(dto.member).toEqual({ id: 'mem-1', memberNo: 'M001', displayName: '张三' });
      expect(dto.id).toBe('rec-1');
      expect(dto.sheetId).toBe('sheet-1');
      expect(dto.registrationId).toBeNull();
    });

    it('contributionPoints null → null(APD approve 前未填)', () => {
      const dto = presenter.toRecordResponseDto({ ...baseRow, contributionPoints: null });
      expect(dto.contributionPoints).toBeNull();
    });

    it('member null → null(防御分支,不抛)', () => {
      const dto = presenter.toRecordResponseDto({ ...baseRow, member: null });
      expect(dto.member).toBeNull();
    });
  });
});

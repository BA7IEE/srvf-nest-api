import { BizException } from '../../common/exceptions/biz.exception';
import {
  ActivityRegistrationPresenter,
  REGISTRATION_CSV_HEADERS,
  type RegistrationAdminListRowLike,
  type RegistrationCsvRowLike,
  type RegistrationExpandKey,
  type RegistrationListRowLike,
  type RegistrationResponseRowLike,
} from './activity-registration-presenter';

// Phase 6-B 第三域第二刀的 characterization spec。
//
// Presenter 是**纯映射**类,断言直接打在返回值上(与第一刀 QueryService 相反 ——
// 那边返回值由 mock 决定、只能断言传给 Prisma 的实参)。
//
// 本 spec 刻意覆盖三类容易在「搬家」时悄悄变形的东西:
// ① `?? null` 防御分支(member 缺失时不能变成 undefined —— JSON 序列化后字段会整个消失);
// ② `extras` 的 Json 收敛语义(数组 / 标量 → null,只有对象透传);
// ③ expand 投影的**缺省不展开**(多取的 select 字段不得泄进响应)。

const D = (s: string): Date => new Date(s);

function responseRow(
  overrides: Partial<RegistrationResponseRowLike> = {},
): RegistrationResponseRowLike {
  return {
    id: 'reg-1',
    activityId: 'act-1',
    memberId: 'mem-1',
    statusCode: 'pending',
    registeredAt: D('2099-01-01T00:00:00.000Z'),
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    extras: null,
    cancelledByUserId: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: D('2099-01-01T00:00:00.000Z'),
    updatedAt: D('2099-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function listRow(overrides: Partial<RegistrationListRowLike> = {}): RegistrationListRowLike {
  return {
    id: 'reg-1',
    activityId: 'act-1',
    activityPosition: null,
    memberId: 'mem-1',
    member: { memberNo: 'M001', displayName: '张三' },
    statusCode: 'pending',
    registeredAt: D('2099-01-01T00:00:00.000Z'),
    reviewedAt: null,
    cancelledAt: null,
    createdAt: D('2099-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function adminListRow(
  overrides: Partial<RegistrationAdminListRowLike> = {},
): RegistrationAdminListRowLike {
  return {
    ...listRow(),
    member: { id: 'mem-1', memberNo: 'M001', displayName: '张三', gradeCode: 'L3' },
    activity: {
      id: 'act-1',
      title: '山地搜救',
      startAt: D('2099-02-01T00:00:00.000Z'),
      organizationId: 'org-1',
    },
    ...overrides,
  };
}

function csvRow(overrides: Partial<RegistrationCsvRowLike> = {}): RegistrationCsvRowLike {
  return {
    id: 'reg-1',
    memberId: 'mem-1',
    member: { memberNo: 'M001', displayName: '张三' },
    statusCode: 'pass',
    registeredAt: D('2099-01-01T00:00:00.000Z'),
    reviewedAt: null,
    reviewNote: null,
    cancelledAt: null,
    cancelReason: null,
    ...overrides,
  };
}

const expandOf = (...keys: RegistrationExpandKey[]): ReadonlySet<RegistrationExpandKey> =>
  new Set(keys);

describe('ActivityRegistrationPresenter (characterization)', () => {
  const presenter = new ActivityRegistrationPresenter();

  describe('jsonAsObject / toResponseDto 的 extras 收敛', () => {
    it('对象透传', () => {
      expect(presenter.jsonAsObject({ a: 1 })).toEqual({ a: 1 });
    });

    it('数组 → null(不是原样透传)', () => {
      expect(presenter.jsonAsObject([1, 2])).toBeNull();
    });

    it('标量与 null → null', () => {
      expect(presenter.jsonAsObject('x')).toBeNull();
      expect(presenter.jsonAsObject(1)).toBeNull();
      expect(presenter.jsonAsObject(null)).toBeNull();
    });

    it('toResponseDto 走同一条收敛(数组 extras 不得泄进响应)', () => {
      expect(presenter.toResponseDto(responseRow({ extras: [1] })).extras).toBeNull();
      expect(presenter.toResponseDto(responseRow({ extras: { k: 'v' } })).extras).toEqual({
        k: 'v',
      });
    });

    it('响应字段集逐字锁定(多一个少一个都算契约变更)', () => {
      expect(Object.keys(presenter.toResponseDto(responseRow())).sort()).toEqual(
        [
          'activityId',
          'cancelReason',
          'cancelledAt',
          'cancelledByUserId',
          'createdAt',
          'extras',
          'id',
          'memberId',
          'registeredAt',
          'reviewNote',
          'reviewedAt',
          'reviewedBy',
          'statusCode',
          'updatedAt',
        ].sort(),
      );
    });
  });

  describe('toListItemDto', () => {
    it('member 缺失时 memberNo / memberDisplayName 必须是 null,不能是 undefined', () => {
      const dto = presenter.toListItemDto(listRow({ member: null }), null);
      expect(dto.memberNo).toBeNull();
      expect(dto.memberDisplayName).toBeNull();
      // undefined 会在 JSON 序列化时让字段整个消失 —— 与 null 不是一回事。
      expect(Object.keys(dto)).toContain('memberNo');
    });

    it('activityPosition 为 null 时投影成 null;有值时改名成 activityPositionId', () => {
      expect(presenter.toListItemDto(listRow(), null).activityPosition).toBeNull();
      expect(
        presenter.toListItemDto(
          listRow({ activityPosition: { id: 'pos-1', name: '前锋组' } }),
          null,
        ).activityPosition,
      ).toEqual({ activityPositionId: 'pos-1', name: '前锋组' });
    });

    it('waitlistPosition 原样透传(含 0 —— 不能被 falsy 判断吃成 null)', () => {
      expect(presenter.toListItemDto(listRow(), 0).waitlistPosition).toBe(0);
      expect(presenter.toListItemDto(listRow(), 7).waitlistPosition).toBe(7);
      expect(presenter.toListItemDto(listRow(), null).waitlistPosition).toBeNull();
    });
  });

  describe('toAdminListItemDto', () => {
    it('默认不展开:select 多取的 gradeCode / startAt / organizationId 不得出现在响应里', () => {
      const dto = presenter.toAdminListItemDto(adminListRow(), expandOf(), null);
      expect(dto).not.toHaveProperty('member');
      expect(dto).not.toHaveProperty('activity');
      // 但摘要字段与 activityTitle 仍在(它们不受 expand 控制)。
      expect(dto.activityTitle).toBe('山地搜救');
      expect(dto.memberNo).toBe('M001');
    });

    it('expand=member 只展开 member,不连带展开 activity', () => {
      const dto = presenter.toAdminListItemDto(adminListRow(), expandOf('member'), null);
      expect(dto.member).toEqual({
        id: 'mem-1',
        memberNo: 'M001',
        displayName: '张三',
        gradeCode: 'L3',
      });
      expect(dto).not.toHaveProperty('activity');
    });

    it('expand=activity 只展开 activity', () => {
      const dto = presenter.toAdminListItemDto(adminListRow(), expandOf('activity'), null);
      expect(dto.activity).toEqual({
        id: 'act-1',
        title: '山地搜救',
        startAt: D('2099-02-01T00:00:00.000Z'),
        organizationId: 'org-1',
      });
      expect(dto).not.toHaveProperty('member');
    });

    it('要求展开但行上没有该关联时不产生该键(而不是产生 null)', () => {
      const dto = presenter.toAdminListItemDto(
        adminListRow({ member: null, activity: null }),
        expandOf('member', 'activity'),
        null,
      );
      expect(dto).not.toHaveProperty('member');
      expect(dto).not.toHaveProperty('activity');
      expect(dto.activityTitle).toBeNull();
    });
  });

  describe('parseExpand', () => {
    it('省略 / 空串 → 空集', () => {
      expect(presenter.parseExpand(undefined).size).toBe(0);
      expect(presenter.parseExpand('   ').size).toBe(0);
    });

    it('白名单内的键收下', () => {
      expect([...presenter.parseExpand('member,activity')].sort()).toEqual(['activity', 'member']);
      expect([...presenter.parseExpand('member')]).toEqual(['member']);
    });

    // ⚠️ 既有语义是**抛 BAD_REQUEST**,不是静默丢弃 —— 我起初按「丢弃」写断言,被这条打红,
    // 才回去读 parseExpandQuery 的实现。characterization 记录的是代码**实际**做什么。
    // 这条同时守住一个安全性质:白名单外的键(如 passwordHash)不可能被当成 expand 目标。
    it('白名单外的键抛 BAD_REQUEST,不静默丢弃', () => {
      expect(() => presenter.parseExpand('member,passwordHash')).toThrow(BizException);
      expect(() => presenter.parseExpand('passwordHash')).toThrow(BizException);
    });
  });

  describe('CSV', () => {
    it('首两个 chunk = BOM + 表头行(顺序固定;BOM 必须是 U+FEFF 单字符)', () => {
      const [bom, header] = presenter.csvHeaderChunks();
      expect(bom).toBe('\uFEFF');
      expect(bom).toHaveLength(1);
      expect(header).toBe(
        'registration_id,member_id,member_no,display_name,status_code,registered_at,reviewed_at,review_note,cancelled_at,cancel_reason',
      );
    });

    // 本刀把表头与行格式化收进同一个类,就是为了让这条能成为机器判据:
    // 从前两者分居 service 的两处,加一列忘了加表头不会有任何东西报错。
    it('行的列数必须与表头列数一致(加列忘改表头 = 当场红)', () => {
      const cells = presenter.formatCsvRow(csvRow()).split(',');
      expect(cells).toHaveLength(REGISTRATION_CSV_HEADERS.length);
      expect(presenter.csvHeaderChunks()[1].split(',')).toHaveLength(
        REGISTRATION_CSV_HEADERS.length,
      );
    });

    it('列顺序逐字锁定,Date 走 ISO,null 出空串', () => {
      expect(presenter.formatCsvRow(csvRow())).toBe(
        'reg-1,mem-1,M001,张三,pass,2099-01-01T00:00:00.000Z,,,,',
      );
    });

    it('member 缺失时 member_no / display_name 出空串,不出 undefined', () => {
      const cells = presenter.formatCsvRow(csvRow({ member: null })).split(',');
      expect(cells[2]).toBe('');
      expect(cells[3]).toBe('');
    });

    it('CSV 注入防护:公式前缀字段被转义(escapeCsvField 语义随迁未变)', () => {
      const cells = presenter.formatCsvRow(csvRow({ cancelReason: '=1+1' })).split(',');
      expect(cells[9]).not.toBe('=1+1');
      expect(cells[9]).toContain('1+1');
    });

    it('含逗号的字段被引号包裹,不会把一列拆成两列', () => {
      const line = presenter.formatCsvRow(csvRow({ reviewNote: 'a,b' }));
      expect(line).toContain('"a,b"');
    });
  });
});

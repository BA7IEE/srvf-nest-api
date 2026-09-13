import { HttpStatus } from '@nestjs/common';
import { BizCode } from './biz-code.constant';

// V1.3-2 §4:BizCode 元属性单测。
// Object.values(BizCode) 遍历断言每个条目结构合法,避免新增 BizCode 漏掉
// `code` 唯一性、`httpStatus` 合法性、`message` 非空等基本约束。
//
// 段位规则(对齐 docs/reference/response-pagination-errors.md §5):
//   - 4xxxx / 5xxxx:通用 HTTP 级
//   - 100xx:users 业务级
//   - 101xx:users 权限 / 操作边界
//   - 110xx+:后续模块按 200 个号段平铺

const HTTP_STATUS_VALUES = new Set(
  Object.values(HttpStatus).filter((value): value is number => typeof value === 'number'),
);

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const SEGMENT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [40000, 49999], // 4xxxx 通用 HTTP 级
  [50000, 59999], // 5xxxx 通用 HTTP 级
  [10000, 10099], // 100xx users 业务级
  [10100, 10199], // 101xx users 权限 / 操作边界
  [11000, 99999], // 110xx+ 后续模块预留(每模块 200 号段平铺)
];

function inAllowedSegment(code: number): boolean {
  return SEGMENT_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

describe('BizCode', () => {
  const entries = Object.entries(BizCode);

  it('至少包含一个条目', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('D1-2 时间政策错误码沿用活动域既有号段', () => {
    expect([
      BizCode.ACTIVITY_TIME_POLICY_INVALID.code,
      BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND.code,
      BizCode.ACTIVITY_TIME_POLICY_CODE_EXISTS.code,
      BizCode.ACTIVITY_TIME_POLICY_STALE.code,
      BizCode.ACTIVITY_TIME_POLICY_STATUS_INVALID.code,
      BizCode.ACTIVITY_TIME_POLICY_COMMAND_CONFLICT.code,
      BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID.code,
      BizCode.ACTIVITY_TIME_POLICY_VERSION_LIMIT.code,
    ]).toEqual([20197, 20198, 20199, 20023, 20024, 20025, 20026, 20027]);
  });

  it('D1-3 时长政策选择错误码固定为连续的八项合同', () => {
    expect([
      BizCode.ACTIVITY_TIME_POLICY_SELECTION_INVALID.code,
      BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE.code,
      BizCode.ACTIVITY_TIME_POLICY_SELECTION_STALE.code,
      BizCode.ACTIVITY_TIME_POLICY_SELECTION_COMMAND_CONFLICT.code,
      BizCode.ACTIVITY_TIME_POLICY_SELECTION_RECEIPT_INVALID.code,
      BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE.code,
      BizCode.ACTIVITY_TIME_POLICY_SELECTION_UNCHANGED.code,
      BizCode.ACTIVITY_TIME_POLICY_SELECTION_REVISION_LIMIT.code,
    ]).toEqual([20205, 20206, 20207, 20208, 20209, 20210, 20211, 20212]);
  });

  it('D3 参与时长认定错误码固定为连续的五项合同', () => {
    expect([
      BizCode.ACTIVITY_TIME_ALLOCATION_INVALID.code,
      BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE.code,
      BizCode.ACTIVITY_TIME_ALLOCATION_STALE.code,
      BizCode.ACTIVITY_TIME_ALLOCATION_COMMAND_CONFLICT.code,
      BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE.code,
    ]).toEqual([20213, 20214, 20215, 20216, 20217]);
  });

  it('D4 分类时长结算错误码固定为连续八项且不复用旧错误', () => {
    expect([
      BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID.code,
      BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.code,
      BizCode.ACTIVITY_TIME_SETTLEMENT_STALE.code,
      BizCode.ACTIVITY_TIME_SETTLEMENT_COMMAND_CONFLICT.code,
      BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY.code,
      BizCode.ACTIVITY_TIME_SETTLEMENT_POLICY_MIXED.code,
      BizCode.ACTIVITY_TIME_SETTLEMENT_OVERLAP.code,
      BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT.code,
    ]).toEqual([20218, 20219, 20220, 20221, 20222, 20223, 20224, 20225]);
  });

  describe.each(entries)('%s', (key, entry) => {
    it('key 命名为大写 SNAKE_CASE', () => {
      expect(key).toMatch(KEY_PATTERN);
    });

    it('code 是正整数', () => {
      expect(typeof entry.code).toBe('number');
      expect(Number.isInteger(entry.code)).toBe(true);
      expect(entry.code).toBeGreaterThan(0);
    });

    it('code 落在已分段范围内', () => {
      expect(inAllowedSegment(entry.code)).toBe(true);
    });

    it('message 是非空 string', () => {
      expect(typeof entry.message).toBe('string');
      expect(entry.message.length).toBeGreaterThan(0);
      expect(entry.message.trim()).toBe(entry.message);
    });

    it('httpStatus 是合法 HttpStatus 枚举值', () => {
      expect(typeof entry.httpStatus).toBe('number');
      expect(HTTP_STATUS_VALUES.has(entry.httpStatus)).toBe(true);
    });
  });

  it('code 在所有条目内全局唯一', () => {
    const codes = entries.map(([, entry]) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('key 在所有条目内全局唯一', () => {
    const keys = entries.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('报名命令主链 BizCode 固定映射', () => {
    expect(BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT).toMatchObject({
      code: 21003,
      httpStatus: HttpStatus.CONFLICT,
    });
    expect(BizCode.REGISTRATION_FORM_VERSION_INVALID).toMatchObject({
      code: 21036,
      httpStatus: HttpStatus.CONFLICT,
    });
    expect(BizCode.REGISTRATION_FORM_ANSWER_INVALID).toMatchObject({
      code: 21037,
      httpStatus: HttpStatus.BAD_REQUEST,
    });
    expect(BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED).toMatchObject({
      code: 21038,
      httpStatus: HttpStatus.CONFLICT,
    });
  });

  it('第 6 批 offline / import BizCode 固定映射', () => {
    expect(BizCode.ATTENDANCE_OFFLINE_PACKAGE_INVALID).toMatchObject({
      code: 22097,
      httpStatus: HttpStatus.CONFLICT,
    });
    expect(BizCode.ATTENDANCE_OFFLINE_PACKAGE_EXPIRED).toMatchObject({
      code: 22098,
      httpStatus: HttpStatus.CONFLICT,
    });
    expect(BizCode.ATTENDANCE_OFFLINE_REVIEW_REQUIRED).toMatchObject({
      code: 22099,
      httpStatus: HttpStatus.CONFLICT,
    });
    expect(BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH).toMatchObject({
      code: 22100,
      httpStatus: HttpStatus.CONFLICT,
    });
  });
});

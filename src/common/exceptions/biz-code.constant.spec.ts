import { HttpStatus } from '@nestjs/common';
import { BizCode } from './biz-code.constant';

// V1.3-2 §4:BizCode 元属性单测。
// Object.values(BizCode) 遍历断言每个条目结构合法,避免新增 BizCode 漏掉
// `code` 唯一性、`httpStatus` 合法性、`message` 非空等基本约束。
//
// 段位规则(对齐 CLAUDE.md §5 / ARCHITECTURE.md §7.3):
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
});

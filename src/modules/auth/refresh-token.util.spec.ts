import {
  generateFamilyId,
  generateRefreshTokenRaw,
  hashRefreshToken,
  parseMsString,
} from './refresh-token.util';

// P0-E PR-3:refresh-token util 纯函数单测(沿评审稿 §8.4 单测清单)。

describe('refresh-token.util', () => {
  describe('generateRefreshTokenRaw', () => {
    it('返 43 字符 base64url 字符串(256 bit 熵)', () => {
      const raw = generateRefreshTokenRaw();
      // base64url(32 bytes) = 43 字符,无 padding =,无 + /
      expect(raw).toHaveLength(43);
      expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('1000 次抽样无 collision(熵足够)', () => {
      const set = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        set.add(generateRefreshTokenRaw());
      }
      expect(set.size).toBe(1000);
    });
  });

  describe('hashRefreshToken', () => {
    it('返 64 字符 hex 字符串(sha256)', () => {
      const hash = hashRefreshToken('any-input');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('确定性:同 raw 同 hash', () => {
      const raw = generateRefreshTokenRaw();
      const a = hashRefreshToken(raw);
      const b = hashRefreshToken(raw);
      expect(a).toBe(b);
    });

    it('不同 raw 不同 hash(抽样;sha256 抗碰撞)', () => {
      const a = hashRefreshToken('raw-1');
      const b = hashRefreshToken('raw-2');
      expect(a).not.toBe(b);
    });

    it('空字符串不抛(防御性)', () => {
      expect(() => hashRefreshToken('')).not.toThrow();
      expect(hashRefreshToken('')).toHaveLength(64);
    });
  });

  describe('generateFamilyId', () => {
    it('返 32 字符 hex 字符串(128 bit 熵)', () => {
      const id = generateFamilyId();
      expect(id).toHaveLength(32);
      expect(id).toMatch(/^[0-9a-f]+$/);
    });

    it('1000 次抽样无 collision', () => {
      const set = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        set.add(generateFamilyId());
      }
      expect(set.size).toBe(1000);
    });
  });

  describe('parseMsString', () => {
    it.each<[string, number]>([
      ['90d', 90 * 24 * 60 * 60 * 1000],
      ['1d', 24 * 60 * 60 * 1000],
      ['1h', 60 * 60 * 1000],
      ['30m', 30 * 60 * 1000],
      ['60s', 60 * 1000],
      ['500ms', 500],
      ['1ms', 1],
      [' 15m ', 15 * 60 * 1000], // trim 容忍
      ['1 h', 60 * 60 * 1000], // 数字与单位之间空格容忍(沿 ms 库范式)
    ])('解析合法字符串 %s → %d ms', (input, expected) => {
      expect(parseMsString(input)).toBe(expected);
    });

    it.each<string>([
      '', // 空
      'abc', // 不含数字
      '123', // 不含单位
      '1y', // 不支持的单位
      '1.5h', // 小数
      '-1h', // 负数
      '0h', // 零(沿铁律:必须 > 0)
    ])('解析非法字符串 %j → null', (input) => {
      expect(parseMsString(input)).toBeNull();
    });
  });
});

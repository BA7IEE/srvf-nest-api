import { StorageConsistencyInvariantError } from '../storage/storage-consistency.types';
import type { HeadObjectResult } from '../storage/storage.types';
import {
  StorageObjectIntegrityMismatchError,
  assertExpectedSizeMatchesHead,
  requireHeadSize,
  requireSafeSize,
  requireSha256Hex,
  requireString,
  safeNumber,
  terminalSucceededData,
} from './attachment-storage-invariants';

/*
 * 存储不变量原语的单测(Phase 6-B 第四域收尾)。
 *
 * 这一层是 attachments 全模块共用的判定底座(terminalSucceededData 被 4 个文件引用、
 * assertExpectedSizeMatchesHead 3 个、requireHeadSize 3 个),迁出编排器前**零单测覆盖**。
 * 一处失效会同时影响上传确认、删除终态化、人工重定位、人工缺失认定四条路径。
 *
 * 用例挑的是**容易写错且失效不报错**的行为,不是逐行覆盖:
 *   - Prisma 的 undefined(不更新) vs null(清空)语义
 *   - size 为 0 的合法性(只有 undefined 才是缺证据)
 *   - 大小写归一化(哈希比对的前提)
 *   - 两个不同错误类型的分界(缺证据 vs 内容不符)
 */

const now = new Date('2026-08-17T00:00:00.000Z');

function head(over: Partial<HeadObjectResult> = {}): HeadObjectResult {
  return { exists: true, size: 100, ...over };
}

describe('terminalSucceededData —— 操作进入 succeeded 终态的统一字段集', () => {
  it('三种 effectState 都清空全部租约字段(租约残留会让已完成的操作被重复领取)', () => {
    for (const state of ['provider_present', 'provider_absent', 'effect_succeeded'] as const) {
      const data = terminalSucceededData(now, state);
      expect(data).toMatchObject({
        status: 'succeeded',
        effectState: state,
        completedAt: now,
        deadAt: null,
        leaseOwner: null,
        leaseAcquiredAt: null,
        leaseRenewedAt: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorClass: null,
      });
    }
  });

  // ⚠️ 这条钉的是 Prisma 的字段语义,不是取值偏好:
  // undefined = 「本次不更新该列」,null = 「把该列置空」。若把此处的 undefined 写成 null,
  // 一次 provider_present 的终态化就会**抹掉已有的 effectCompletedAt**,而 TypeScript
  // 与所有既有测试都不会报错(两者都符合 DateTime | null 的类型)。
  it('effect_succeeded 才写 effectCompletedAt;其余两态为 undefined(不更新)而非 null(清空)', () => {
    expect(terminalSucceededData(now, 'effect_succeeded').effectCompletedAt).toBe(now);
    expect(terminalSucceededData(now, 'provider_present').effectCompletedAt).toBeUndefined();
    expect(terminalSucceededData(now, 'provider_absent').effectCompletedAt).toBeUndefined();
    // 显式区分 undefined 与 null —— toBeUndefined 对 null 会失败,这正是本条的鉴别力所在
    expect(terminalSucceededData(now, 'provider_present').effectCompletedAt).not.toBeNull();
  });
});

describe('requireString', () => {
  it('非空字符串原样返回', () => {
    expect(requireString('abc', 'key')).toBe('abc');
  });

  it('null 抛出且消息含字段名(该层错误消息是唯一定位线索)', () => {
    expect(() => requireString(null, 'objectKey')).toThrow('objectKey is missing');
  });

  it('空字符串同样算缺失(判据是 !value 而非 === null)', () => {
    expect(() => requireString('', 'objectKey')).toThrow('objectKey is missing');
  });
});

describe('safeNumber / requireSafeSize —— bigint 到 number 的安全收窄', () => {
  it('safeNumber:null 返回 undefined(不抛)', () => {
    expect(safeNumber(null)).toBeUndefined();
  });

  it('safeNumber:安全范围内的 bigint 正常转换', () => {
    expect(safeNumber(0n)).toBe(0);
    expect(safeNumber(1024n)).toBe(1024);
    expect(safeNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('safeNumber:超出安全整数范围即抛(否则静默失精,尺寸比对会假通过)', () => {
    expect(() => safeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      StorageConsistencyInvariantError,
    );
  });

  it('safeNumber:负数即抛(尺寸不可能为负)', () => {
    expect(() => safeNumber(-1n)).toThrow(StorageConsistencyInvariantError);
  });

  it('requireSafeSize:与 safeNumber 的分界在 null —— 前者抛,后者返回 undefined', () => {
    expect(requireSafeSize(1024n)).toBe(1024);
    expect(() => requireSafeSize(null)).toThrow('expectedSize is missing');
  });
});

describe('requireHeadSize', () => {
  it('size 为 0 是合法的(空对象有尺寸证据,只是尺寸为零)', () => {
    expect(requireHeadSize(head({ size: 0 }))).toBe(0);
  });

  it('只有 undefined 才算「供应商未给出尺寸证据」', () => {
    expect(() => requireHeadSize(head({ size: undefined }))).toThrow(
      'provider HEAD lacks expected size evidence',
    );
  });
});

describe('assertExpectedSizeMatchesHead —— 缺证据与内容不符是两类错误', () => {
  it('尺寸一致时放行', () => {
    expect(() => assertExpectedSizeMatchesHead({ expectedSize: 100n }, head())).not.toThrow();
  });

  it('对象侧无 expectedSize ⇒ 缺证据(Invariant,不是完整性问题)', () => {
    expect(() => assertExpectedSizeMatchesHead({ expectedSize: null }, head())).toThrow(
      StorageConsistencyInvariantError,
    );
  });

  it('供应商侧无 size ⇒ 缺证据(Invariant)', () => {
    expect(() =>
      assertExpectedSizeMatchesHead({ expectedSize: 100n }, head({ size: undefined })),
    ).toThrow(StorageConsistencyInvariantError);
  });

  // 两侧都有证据但对不上 —— 这是内容完整性问题,错误类型必须与「缺证据」区分开,
  // 因为处置不同:缺证据可重取,内容不符必须停下人工核实。
  it('两侧都有证据但不相等 ⇒ 完整性不符(IntegrityMismatch,另一个类型)', () => {
    expect(() =>
      assertExpectedSizeMatchesHead({ expectedSize: 100n }, head({ size: 101 })),
    ).toThrow(StorageObjectIntegrityMismatchError);
  });
});

describe('requireSha256Hex —— 校验并归一化', () => {
  const lower = 'a'.repeat(64);

  it('64 位小写十六进制原样返回', () => {
    expect(requireSha256Hex(lower, 'checksum')).toBe(lower);
  });

  // 归一化是哈希比对的前提:大小写不同的同一摘要必须收敛成同一字符串,
  // 否则「存量 checksum 与流式 checksum 比对」会因书写差异而假不符。
  it('大写输入合法,但**返回小写**(比对前的归一化)', () => {
    expect(requireSha256Hex('A'.repeat(64), 'checksum')).toBe(lower);
    expect(requireSha256Hex('aA'.repeat(32), 'checksum')).toBe(lower);
  });

  it('长度不足 64 即抛', () => {
    expect(() => requireSha256Hex('a'.repeat(63), 'checksum')).toThrow(
      'checksum is not SHA-256 hex',
    );
  });

  it('长度超过 64 即抛(不截断)', () => {
    expect(() => requireSha256Hex('a'.repeat(65), 'checksum')).toThrow(
      'checksum is not SHA-256 hex',
    );
  });

  it('含非十六进制字符即抛', () => {
    expect(() => requireSha256Hex('g'.repeat(64), 'checksum')).toThrow(
      'checksum is not SHA-256 hex',
    );
  });

  it('空串即抛且消息含字段名', () => {
    expect(() => requireSha256Hex('', 'provider checksum')).toThrow(
      'provider checksum is not SHA-256 hex',
    );
  });
});

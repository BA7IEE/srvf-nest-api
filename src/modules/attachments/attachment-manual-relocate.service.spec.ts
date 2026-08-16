import { type StorageObject } from '@prisma/client';

import { StorageConsistencyInvariantError } from '../storage/storage-consistency.types';
import type { StorageObjectLedgerService } from '../storage/storage-object-ledger.service';
import type { StorageProvider } from '../storage/storage.interface';
import type { HeadObjectResult, StorageObjectSha256Result } from '../storage/storage.types';
import { PrismaService } from '../../database/prisma.service';
import { AttachmentManualRelocateService } from './attachment-manual-relocate.service';
import { StorageObjectIntegrityMismatchError } from './attachment-storage-invariants';

/*
 * 迁出编排器前,这三个方法(execute / collectEvidence / assertEvidence)在
 * `attachment-storage-orchestrator.spec.ts` 里**零单测覆盖** —— 实测该文件对
 * executeManualRelocate / collectManualRelocationEvidence / assertManualRelocationEvidence
 * 零命中。本 spec 补的是抽出后才具备可测性的那一层:证据校验的全部分支。
 *
 * 为什么值得逐分支钉:assertEvidence 是**内容完整性的最后一道判定** —— 它一旦放过,
 * 编排器就会把一个内容不符的对象标成 available 并改写 locator(不可逆)。
 */

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function makeObject(over: Partial<StorageObject> = {}): StorageObject {
  return {
    key: 'k/1',
    expectedSize: 100n,
    checksum: null,
    etag: null,
    ...over,
  } as unknown as StorageObject;
}

function makeHead(over: Partial<HeadObjectResult> = {}): HeadObjectResult {
  return { exists: true, size: 100, ...over } as HeadObjectResult;
}

function makeHash(over: Partial<StorageObjectSha256Result> = {}): StorageObjectSha256Result {
  return { checksum: SHA_A, size: 100, ...over } as StorageObjectSha256Result;
}

/** assertEvidence 是 private:按本仓既有做法用结构化断言取到它,避免为测试放宽可见性。 */
interface PrivateAssert {
  assertEvidence(
    object: StorageObject,
    evidence: { key: string; head: HeadObjectResult; hash: StorageObjectSha256Result | null },
  ): void;
}

function subject(): PrivateAssert {
  const service = new AttachmentManualRelocateService(
    {} as PrismaService,
    {} as StorageObjectLedgerService,
    {} as StorageProvider,
  );
  return service as unknown as PrivateAssert;
}

describe('AttachmentManualRelocateService.assertEvidence', () => {
  describe('身份与存在性', () => {
    it('证据 key 与对象 key 漂移即拒绝', () => {
      expect(() =>
        subject().assertEvidence(makeObject(), { key: 'other', head: makeHead(), hash: null }),
      ).toThrow(StorageConsistencyInvariantError);
    });

    it('目标不存在即拒绝', () => {
      expect(() =>
        subject().assertEvidence(makeObject({ etag: 'e1' }), {
          key: 'k/1',
          head: makeHead({ exists: false }),
          hash: null,
        }),
      ).toThrow(StorageConsistencyInvariantError);
    });

    it('HEAD 尺寸与 expectedSize 不符即拒绝', () => {
      expect(() =>
        subject().assertEvidence(makeObject({ etag: 'e1' }), {
          key: 'k/1',
          head: makeHead({ size: 101 }),
          hash: null,
        }),
      ).toThrow(StorageObjectIntegrityMismatchError);
    });
  });

  describe('有存量 checksum:必须有流式摘要且逐项相符', () => {
    const object = makeObject({ checksum: SHA_A });

    it('缺流式摘要即拒绝(不允许降级成只比 HEAD)', () => {
      expect(() =>
        subject().assertEvidence(object, { key: 'k/1', head: makeHead(), hash: null }),
      ).toThrow(StorageConsistencyInvariantError);
    });

    it('流式尺寸与 expectedSize 不符即拒绝', () => {
      expect(() =>
        subject().assertEvidence(object, {
          key: 'k/1',
          head: makeHead(),
          hash: makeHash({ size: 99 }),
        }),
      ).toThrow(StorageObjectIntegrityMismatchError);
    });

    it('流式 checksum 与存量不符即拒绝', () => {
      expect(() =>
        subject().assertEvidence(object, {
          key: 'k/1',
          head: makeHead(),
          hash: makeHash({ checksum: SHA_B }),
        }),
      ).toThrow(StorageObjectIntegrityMismatchError);
    });

    it('流式期间 etag 变化即拒绝(同读竞态)', () => {
      expect(() =>
        subject().assertEvidence(object, {
          key: 'k/1',
          head: makeHead({ etag: 'after' }),
          hash: makeHash({ etag: 'before' }),
        }),
      ).toThrow(StorageObjectIntegrityMismatchError);
    });

    it('checksum 相符时放行,且**不因 etag 与存量不同而拒绝**(定位副本可合法换 etag)', () => {
      expect(() =>
        subject().assertEvidence(makeObject({ checksum: SHA_A, etag: 'stored-old' }), {
          key: 'k/1',
          head: makeHead({ etag: 'copied-new' }),
          hash: makeHash({ etag: 'copied-new' }),
        }),
      ).not.toThrow();
    });
  });

  describe('无存量 checksum:退化为 etag 比对,且不得无凭据放行', () => {
    it('既无 checksum 也无存量 etag 即拒绝(不允许零凭据重定位)', () => {
      expect(() =>
        subject().assertEvidence(makeObject(), { key: 'k/1', head: makeHead(), hash: null }),
      ).toThrow(StorageConsistencyInvariantError);
    });

    it('目标未给出 etag 即拒绝', () => {
      expect(() =>
        subject().assertEvidence(makeObject({ etag: 'e1' }), {
          key: 'k/1',
          head: makeHead({ etag: undefined }),
          hash: null,
        }),
      ).toThrow(StorageConsistencyInvariantError);
    });

    it('etag 不符即拒绝', () => {
      expect(() =>
        subject().assertEvidence(makeObject({ etag: 'e1' }), {
          key: 'k/1',
          head: makeHead({ etag: 'e2' }),
          hash: null,
        }),
      ).toThrow(StorageObjectIntegrityMismatchError);
    });

    it('etag 相符时放行', () => {
      expect(() =>
        subject().assertEvidence(makeObject({ etag: 'e1' }), {
          key: 'k/1',
          head: makeHead({ etag: 'e1' }),
          hash: null,
        }),
      ).not.toThrow();
    });
  });
});

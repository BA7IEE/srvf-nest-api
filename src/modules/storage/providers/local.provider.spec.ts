import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import type { ConfigType } from '@nestjs/config';

import type appConfig from '../../../config/app.config';
import { LocalStorageProvider } from './local.provider';

// V2.x C-7.5 PR #7:LocalStorageProvider 单元测试(沿 Q-88-5 拍板 A 必须覆盖)
//
// 覆盖矩阵:
// 1. putObject:Buffer / Stream / 嵌套目录自动 mkdir / 同 key 覆盖 / size + etag
// 2. deleteObject:存在 → unlink / 不存在 → ENOENT 幂等 / 嵌套目录文件
// 3. generateUploadUrl:stub URL 形态 / method=PUT / headers={} / expiresAt 在未来 / encodeURIComponent
// 4. generateDownloadUrl:`/uploads/` 前缀 / expires query / expiresAt
// 5. headObject:存在 → exists+size+lastModified / 不存在 → exists=false
// 6. resolveKey 安全:`../` 逃逸 root → throw

type AppCfg = ConfigType<typeof appConfig>;

function makeCfg(localRoot: string): AppCfg {
  return {
    env: 'test',
    port: 3000,
    corsOrigin: [],
    swaggerEnabled: false,
    logLevel: 'silent' as never,
    loginThrottle: { limit: 5, ttlSeconds: 60 },
    storage: { encryptionKey: '', localRoot },
  } as unknown as AppCfg;
}

describe('LocalStorageProvider', () => {
  let tmpRoot: string;
  let svc: LocalStorageProvider;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'srvf-local-provider-'));
    svc = new LocalStorageProvider(makeCfg(tmpRoot));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  describe('putObject', () => {
    it('Buffer 入参 → 写入 + size + etag', async () => {
      const body = Buffer.from('hello world');
      const result = await svc.putObject({
        key: 'sample.txt',
        body,
        contentType: 'text/plain',
      });
      expect(result.key).toBe('sample.txt');
      expect(result.size).toBe(body.length);
      expect(result.contentType).toBe('text/plain');
      expect(result.etag).toMatch(/^[0-9a-f]{32}$/);

      const written = await fs.readFile(path.join(tmpRoot, 'sample.txt'));
      expect(written.equals(body)).toBe(true);
    });

    it('Stream 入参 → buffer 化写入', async () => {
      const body = Readable.from([Buffer.from('chunk1'), Buffer.from('chunk2')]);
      const result = await svc.putObject({ key: 'stream.bin', body });
      expect(result.size).toBe(12);

      const written = await fs.readFile(path.join(tmpRoot, 'stream.bin'));
      expect(written.toString('utf8')).toBe('chunk1chunk2');
    });

    it('嵌套目录自动 mkdir', async () => {
      await svc.putObject({
        key: 'attachments/dev/2026/05/16/abc.png',
        body: Buffer.from('x'),
      });
      const stat = await fs.stat(path.join(tmpRoot, 'attachments/dev/2026/05/16/abc.png'));
      expect(stat.isFile()).toBe(true);
    });

    it('同 key 覆盖写入', async () => {
      await svc.putObject({ key: 'same.txt', body: Buffer.from('first') });
      await svc.putObject({ key: 'same.txt', body: Buffer.from('second-longer') });
      const data = await fs.readFile(path.join(tmpRoot, 'same.txt'));
      expect(data.toString('utf8')).toBe('second-longer');
    });
  });

  describe('deleteObject', () => {
    it('存在 → unlink', async () => {
      await svc.putObject({ key: 'to-del.txt', body: Buffer.from('x') });
      await svc.deleteObject('to-del.txt');
      await expect(fs.stat(path.join(tmpRoot, 'to-del.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('不存在 → ENOENT 幂等不抛', async () => {
      await expect(svc.deleteObject('never-existed.txt')).resolves.toBeUndefined();
    });

    it('嵌套目录文件删除', async () => {
      await svc.putObject({
        key: 'nested/dir/file.txt',
        body: Buffer.from('x'),
      });
      await svc.deleteObject('nested/dir/file.txt');
      await expect(fs.stat(path.join(tmpRoot, 'nested/dir/file.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  describe('generateUploadUrl', () => {
    it('返 stub URL + method=PUT + headers={} + expiresAt', async () => {
      const before = Date.now();
      const result = await svc.generateUploadUrl({
        key: 'attachments/dev/foo.png',
        contentType: 'image/png',
        expiresIn: 600,
      });
      expect(result.url).toBe('/internal/storage/local-stub-upload/attachments%2Fdev%2Ffoo.png');
      expect(result.method).toBe('PUT');
      expect(result.headers).toEqual({});
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600 * 1000);
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 600 * 1000 + 100);
    });

    it('encodeURIComponent 转义特殊字符', async () => {
      const result = await svc.generateUploadUrl({
        key: 'with space and #hash.png',
        contentType: 'image/png',
        expiresIn: 60,
      });
      expect(result.url).toContain('with%20space%20and%20%23hash.png');
      expect(result.url).not.toContain(' ');
      expect(result.url).not.toContain('#');
    });
  });

  describe('generateDownloadUrl', () => {
    it('返 /uploads/<key>?expires=<ts>', async () => {
      const before = Math.floor(Date.now() / 1000);
      const result = await svc.generateDownloadUrl({
        key: 'attachments/dev/bar.png',
        expiresIn: 300,
      });
      expect(result.url).toMatch(/^\/uploads\/attachments%2Fdev%2Fbar\.png\?expires=\d+$/);
      const expiresMatch = /expires=(\d+)/.exec(result.url);
      expect(expiresMatch).not.toBeNull();
      const expiresQuery = Number(expiresMatch![1]);
      expect(expiresQuery).toBeGreaterThanOrEqual(before + 300);
      // url 内 expires 是 floor 整秒;expiresAt.getTime() 含毫秒;差 0-999ms
      const expiresAtMs = result.expiresAt.getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(expiresQuery * 1000);
      expect(expiresAtMs).toBeLessThan(expiresQuery * 1000 + 1000);
    });

    it('contentDisposition 入参不影响 URL 形态(本期不实装签名 disposition)', async () => {
      const result = await svc.generateDownloadUrl({
        key: 'key.txt',
        expiresIn: 60,
        contentDisposition: 'attachment; filename="hello.txt"',
      });
      expect(result.url).toMatch(/^\/uploads\/key\.txt\?expires=\d+$/);
    });
  });

  describe('headObject', () => {
    it('存在 → exists=true + size + lastModified', async () => {
      const before = Date.now();
      await svc.putObject({ key: 'head.txt', body: Buffer.from('payload') });
      const result = await svc.headObject('head.txt');
      expect(result.exists).toBe(true);
      expect(result.size).toBe(7);
      // Date 鸭子类型(避免 jest 跨 realm instanceof Date 误判)
      expect(result.lastModified).toBeDefined();
      expect(typeof result.lastModified?.getTime()).toBe('number');
      expect(result.lastModified!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      // etag / contentType 不持久化 → undefined
      expect(result.etag).toBeUndefined();
      expect(result.contentType).toBeUndefined();
    });

    it('不存在 → exists=false(其他字段不返)', async () => {
      const result = await svc.headObject('never.txt');
      expect(result.exists).toBe(false);
      expect(result.size).toBeUndefined();
      expect(result.lastModified).toBeUndefined();
    });
  });

  describe('readObjectPrefix', () => {
    it('只读取指定上限且短文件按实际长度返回', async () => {
      await svc.putObject({ key: 'prefix.bin', body: Buffer.from('abcdefghijklmnop') });
      await expect(svc.readObjectPrefix('prefix.bin', 5)).resolves.toEqual(Buffer.from('abcde'));

      await svc.putObject({ key: 'short.bin', body: Buffer.from('xy') });
      await expect(svc.readObjectPrefix('short.bin', 12)).resolves.toEqual(Buffer.from('xy'));
    });
  });

  describe('resolveKey 安全防御', () => {
    it('key 含 ../ 逃逸 root → throw', async () => {
      await expect(svc.putObject({ key: '../escape.txt', body: Buffer.from('x') })).rejects.toThrow(
        /path escape/,
      );
    });

    it('key 含深层 ../../ 逃逸 → throw', async () => {
      await expect(
        svc.putObject({ key: 'a/b/../../../escape.txt', body: Buffer.from('x') }),
      ).rejects.toThrow(/path escape/);
    });

    it('正常嵌套 key 不触发(防御不误伤)', async () => {
      await expect(
        svc.putObject({ key: 'a/b/c/normal.txt', body: Buffer.from('x') }),
      ).resolves.toMatchObject({ key: 'a/b/c/normal.txt' });
    });
  });
});

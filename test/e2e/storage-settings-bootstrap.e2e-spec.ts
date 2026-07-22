import { PrismaClient } from '@prisma/client';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import appConfig from '../../src/config/app.config';
import { StorageCryptoService } from '../../src/modules/storage/storage-crypto.service';
import { assertTestDatabaseUrl } from '../setup/test-db';

interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe('storage-settings-bootstrap CLI', () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const databaseName = new URL(databaseUrl).pathname.replace(/^\/+/, '');
  const encryptionKey = randomBytes(32).toString('base64');
  const secretId = randomBytes(24).toString('base64url');
  const secretKey = randomBytes(32).toString('base64url');
  const tempDirs: string[] = [];
  let prisma: PrismaClient;

  beforeAll(async () => {
    assertTestDatabaseUrl(databaseUrl);
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "storage_settings" RESTART IDENTITY CASCADE');
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(mode = 0o600): string {
    const dir = mkdtempSync(join(tmpdir(), 'srvf-storage-bootstrap-'));
    tempDirs.push(dir);
    const configFile = join(dir, 'storage-bootstrap.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        databaseUrl,
        bucket: 'srvf-production-test',
        region: 'ap-shanghai',
        envPrefix: 'production',
        secretId,
        secretKey,
      }),
      { mode: 0o600 },
    );
    chmodSync(configFile, mode);
    return configFile;
  }

  function runCli(configFile: string, extraArgs: readonly string[] = []): CliRunResult {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/storage-settings-bootstrap.ts',
        `--config-file=${configFile}`,
        `--confirm-database=${databaseName}`,
        ...extraArgs,
      ],
      {
        cwd: process.cwd(),
        env: {
          APP_ENV: 'test',
          STORAGE_ENCRYPTION_KEY: encryptionKey,
        },
        encoding: 'utf8',
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function runProductionCli(
    configFile: string,
    overrides: NodeJS.ProcessEnv = {},
    extraArgs: readonly string[] = [],
  ): CliRunResult {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/storage-settings-bootstrap.ts',
        `--config-file=${configFile}`,
        `--confirm-database=${databaseName}`,
        ...extraArgs,
      ],
      {
        cwd: process.cwd(),
        env: {
          APP_ENV: 'production',
          STORAGE_ENCRYPTION_KEY: encryptionKey,
          ...overrides,
        },
        encoding: 'utf8',
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function expectNoCredentialLeak(result: CliRunResult): void {
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain(secretId);
    expect(output).not.toContain(secretKey);
    expect(output).not.toContain(databaseUrl);
    expect(output).not.toContain('secretIdEncrypted');
    expect(output).not.toContain('secretKeyEncrypted');
  }

  it('dry-run validates target and credential round-trip without writing PostgreSQL', async () => {
    const result = runCli(writeConfig(), ['--dry-run']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'dry-run',
      target: { database: databaseName, schema: 'public' },
      rowCountBefore: 0,
      created: false,
      verified: true,
      providerType: 'COS',
      enabled: true,
      credentialConfigured: true,
    });
    expect(await prisma.storageSettings.count()).toBe(0);
    expectNoCredentialLeak(result);
  });

  it('production clean environment needs only APP_ENV and STORAGE_ENCRYPTION_KEY', async () => {
    const result = runProductionCli(writeConfig(), {}, ['--dry-run']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'dry-run', verified: true });
    expect(await prisma.storageSettings.count()).toBe(0);
    expectNoCredentialLeak(result);
  });

  it.each([
    // Prisma 的导入链会从仓库 `.env` 补载缺失变量；显式空值可阻止 dotenv 回填，
    // 并精确验证 production 下“无可用 key”必须 fail-closed。
    ['missing key', { STORAGE_ENCRYPTION_KEY: '' }, /STORAGE_ENCRYPTION_KEY/],
    ['short key', { STORAGE_ENCRYPTION_KEY: 'short' }, /太短/],
    ['invalid APP_ENV', { APP_ENV: 'invalid' }, /APP_ENV 无效/],
  ])(
    'production clean environment rejects %s without writing',
    async (_label, overrides, error) => {
      const result = runProductionCli(writeConfig(), overrides, ['--dry-run']);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(error);
      expect(await prisma.storageSettings.count()).toBe(0);
      expectNoCredentialLeak(result);
    },
  );

  it('creates one COS singleton, decrypts persisted credentials, and refuses overwrite', async () => {
    const configFile = writeConfig();
    const first = runCli(configFile);

    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      mode: 'create',
      rowCountBefore: 0,
      created: true,
      verified: true,
    });
    const row = await prisma.storageSettings.findFirstOrThrow();
    expect(row).toMatchObject({
      providerType: 'COS',
      enabled: true,
      bucket: 'srvf-production-test',
      region: 'ap-shanghai',
      envPrefix: 'production',
      credentialConfigured: true,
      updatedBy: null,
    });
    expect(row.secretIdEncrypted).not.toBe(secretId);
    expect(row.secretKeyEncrypted).not.toBe(secretKey);

    const previousKey = process.env.STORAGE_ENCRYPTION_KEY;
    process.env.STORAGE_ENCRYPTION_KEY = encryptionKey;
    const crypto = new StorageCryptoService(appConfig());
    if (previousKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
    else process.env.STORAGE_ENCRYPTION_KEY = previousKey;
    expect(crypto.decrypt(row.secretIdEncrypted!)).toBe(secretId);
    expect(crypto.decrypt(row.secretKeyEncrypted!)).toBe(secretKey);

    const second = runCli(configFile);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('只允许初始化空表，拒绝覆盖');
    expect(await prisma.storageSettings.count()).toBe(1);
    expectNoCredentialLeak(first);
    expectNoCredentialLeak(second);
  });

  it('rejects a confirmation mismatch before any database write', async () => {
    const configFile = writeConfig();
    const result = spawnSync(
      'pnpm',
      [
        'tsx',
        'src/storage-settings-bootstrap.ts',
        `--config-file=${configFile}`,
        '--confirm-database=wrong_database',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, APP_ENV: 'test', STORAGE_ENCRYPTION_KEY: encryptionKey },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--confirm-database 与配置目标库不一致');
    expect(await prisma.storageSettings.count()).toBe(0);
  });

  it('rejects a config file readable by group or other', async () => {
    const result = runCli(writeConfig(0o640), ['--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('不得授予 group/other 任何权限');
    expect(await prisma.storageSettings.count()).toBe(0);
    expectNoCredentialLeak(result);
  });
});

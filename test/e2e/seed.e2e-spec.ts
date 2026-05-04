import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { execSync } from 'child_process';
import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// 14.8 seed spec(6 用例)
// 直接 `pnpm tsx prisma/seed.ts` 跑子进程,绕过 prisma cli 的 .env 加载,
// 完全可控环境;子进程继承 jest worker 的 .env.test(setupFiles 已加载),
// 仅在 envOverrides 中显式指定要测试的字段。
//
// 强护栏:每次 runSeed 前显式 assertTestDatabaseUrl(envForChild.DATABASE_URL),
// 不含 'app_test' 子串拒绝执行——防止意外把 SUPER_ADMIN 写到开发库。

interface SeedRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSeed(envOverrides: Record<string, string>): SeedRunResult {
  const envForChild = { ...process.env, ...envOverrides };

  // 双保险:子进程的 DATABASE_URL 必须指向 app_test
  assertTestDatabaseUrl(envForChild.DATABASE_URL);

  try {
    const stdout = execSync('pnpm tsx prisma/seed.ts', {
      env: envForChild,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      code: e.status ?? -1,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? ''),
    };
  }
}

describe('prisma/seed.ts', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // 每用例自包含:beforeEach truncate User 表
    await resetDb(app);
  });

  it('空 db + 合法 env → 创建 SUPER_ADMIN(exit 0,db 状态正确)', async () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'customseed1',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
    });

    expect(result.code).toBe(0);

    const u = await prisma.user.findUnique({ where: { username: 'customseed1' } });
    expect(u).not.toBeNull();
    expect(u!.role).toBe(Role.SUPER_ADMIN);
    expect(u!.status).toBe(UserStatus.ACTIVE);
    expect(u!.deletedAt).toBeNull();
    expect(u!.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt hash 格式
  });

  it('再跑同 username 但不同 password/email → 幂等不覆盖', async () => {
    // 第一次创建
    const first = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'idempotent1',
      SUPER_ADMIN_PASSWORD: 'FirstPass1!',
      SUPER_ADMIN_EMAIL: 'first@example.com',
    });
    expect(first.code).toBe(0);

    const created = await prisma.user.findUnique({ where: { username: 'idempotent1' } });
    expect(created).not.toBeNull();
    const firstHash = created!.passwordHash;
    expect(created!.email).toBe('first@example.com');

    // 第二次:不同 password/email,seed 应跳过且不覆盖
    const second = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'idempotent1',
      SUPER_ADMIN_PASSWORD: 'SecondPass2!',
      SUPER_ADMIN_EMAIL: 'second@example.com',
    });

    expect(second.code).toBe(0);
    expect(second.stdout.toLowerCase()).toContain('already exists');

    const after = await prisma.user.findUnique({ where: { username: 'idempotent1' } });
    // bcrypt 每次 hash 结果不同(salt 随机),严格相等才能证明"未重新 hash"
    expect(after!.passwordHash).toBe(firstHash);
    expect(after!.email).toBe('first@example.com'); // 第一次的值,未被覆盖
    expect(after!.role).toBe(Role.SUPER_ADMIN);
  });

  it('production + SUPER_ADMIN_USERNAME=admin → exit ≠ 0,stderr 含 admin 关键字', () => {
    const result = runSeed({
      APP_ENV: 'production',
      SUPER_ADMIN_USERNAME: 'admin',
      SUPER_ADMIN_PASSWORD: 'NotDefaultPass1!',
      SUPER_ADMIN_EMAIL: '',
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain('admin');
  });

  it('production + SUPER_ADMIN_PASSWORD=ChangeMe123456 → exit ≠ 0,stderr 含 ChangeMe123456', () => {
    const result = runSeed({
      APP_ENV: 'production',
      SUPER_ADMIN_USERNAME: 'okusername',
      SUPER_ADMIN_PASSWORD: 'ChangeMe123456',
      SUPER_ADMIN_EMAIL: '',
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ChangeMe123456');
  });

  it('test + 非法 username "A"(违反 ^[a-z0-9_-]{3,32}$) → exit ≠ 0,stderr 含 username 关键字', () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'A',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain('username');
  });

  it('test + 缺 SUPER_ADMIN_PASSWORD → exit ≠ 0,stderr 含 password 关键字', () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'okusername',
      SUPER_ADMIN_PASSWORD: '',
      SUPER_ADMIN_EMAIL: '',
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain('password');
  });
});

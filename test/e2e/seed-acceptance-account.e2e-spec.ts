import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { createTestApp } from '../setup/test-app';
import { resetDb } from '../setup/reset-db';
import { assertTestDatabaseUrl } from '../setup/test-db';

describe('offline acceptance bootstrap', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
  });
  afterAll(async () => app.close());

  it('refuses wrong targets, creates one audited account and refuses a second account', async () => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    const [{ fingerprint }] = await prisma.$queryRaw<{ fingerprint: string }[]>`
      SELECT encode(sha256(convert_to(system_identifier::text || ':' || current_database(),
                                      'UTF8')), 'hex') AS fingerprint FROM pg_control_system()
    `;
    const password = randomBytes(32).toString('hex');
    const username = 'accept_' + randomBytes(6).toString('hex');
    const invoke = (pin: string, name: string) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', 'prisma/seed.ts', '--acceptance-account-only'],
        {
          env: {
            ...process.env,
            APP_ENV: 'test',
            ACCEPTANCE_SOURCE_COMMIT: 'a'.repeat(40),
            ACCEPTANCE_ENTRY_SHA256: createHash('sha256')
              .update(readFileSync('prisma/seed.ts'))
              .digest('hex'),
            SUPER_ADMIN_USERNAME: name,
            SUPER_ADMIN_PASSWORD: password,
            ACCEPTANCE_DATABASE_FINGERPRINT: pin,
          },
          stdio: 'ignore',
        },
      ).status;
    const snapshot = () =>
      Promise.all([
        prisma.user.count(),
        prisma.auditLog.count(),
        prisma.rbacRole.count(),
        prisma.permission.count(),
        prisma.rolePermission.count(),
        prisma.roleBinding.count(),
      ]);
    const [users, audits, ...rbac] = await snapshot();
    expect(invoke('0'.repeat(64), username)).toBe(1);
    expect(await snapshot()).toEqual([users, audits, ...rbac]);
    expect(invoke(fingerprint, username)).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({
      where: { username },
      select: { id: true, role: true },
    });
    expect(user.role).toBe('SUPER_ADMIN');
    expect(
      await prisma.auditLog.count({
        where: { event: 'seed.acceptance-account.create', resourceId: user.id },
      }),
    ).toBe(1);
    expect(invoke(fingerprint, username + '_b')).toBe(1);
    expect(await snapshot()).toEqual([users + 1, audits + 1, ...rbac]);
  }, 30000);
});

import { execSync } from 'node:child_process';

import type { INestApplication } from '@nestjs/common';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_USERNAME: 'batch4-seed-su',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
};

function runSeed(): void {
  const env: NodeJS.ProcessEnv = { ...process.env, ...SEED_ENV };
  assertTestDatabaseUrl(env.DATABASE_URL);
  execSync('pnpm tsx prisma/seed.ts', {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('prisma/seed.ts — registration-upload-session attachment configuration', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates the exact closed configuration once, then preserves operator adjustments via update:{}', async () => {
    runSeed();
    const initial = await prisma.attachmentTypeConfig.findUniqueOrThrow({
      where: { code: 'registration-upload-session' },
      select: {
        id: true,
        ownerTable: true,
        defaultMaxSizeBytes: true,
        defaultMimeWhitelist: true,
        displayName: true,
      },
    });
    expect(initial).toEqual({
      id: expect.any(String),
      ownerTable: 'registration_upload_sessions',
      defaultMaxSizeBytes: 10 * 1024 * 1024,
      defaultMimeWhitelist: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      displayName: '报名一次性上传附件',
    });
    const countAfterFirst = await prisma.attachmentTypeConfig.count({
      where: { code: 'registration-upload-session' },
    });

    runSeed();
    expect(
      await prisma.attachmentTypeConfig.count({
        where: { code: 'registration-upload-session' },
      }),
    ).toBe(countAfterFirst);

    await prisma.attachmentTypeConfig.update({
      where: { id: initial.id },
      data: {
        displayName: '运营已调整报名附件',
        defaultMaxSizeBytes: 123_456,
        defaultMimeWhitelist: ['application/pdf'],
      },
    });
    runSeed();
    await expect(
      prisma.attachmentTypeConfig.findUnique({
        where: { id: initial.id },
        select: {
          displayName: true,
          defaultMaxSizeBytes: true,
          defaultMimeWhitelist: true,
        },
      }),
    ).resolves.toEqual({
      displayName: '运营已调整报名附件',
      defaultMaxSizeBytes: 123_456,
      defaultMimeWhitelist: ['application/pdf'],
    });
  });
});

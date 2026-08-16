import type { INestApplication } from '@nestjs/common';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('activity v1.1 batch6 staff/import/offline schema constraints', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('red-first: owns explicit offline package, frozen participant and review-item tables', async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        offlinePackage: string | null;
        offlinePackageParticipant: string | null;
        offlinePunchReviewItem: string | null;
      }>
    >`
      SELECT
        to_regclass('"OfflinePackage"')::text AS "offlinePackage",
        to_regclass('"OfflinePackageParticipant"')::text AS "offlinePackageParticipant",
        to_regclass('"OfflinePunchReviewItem"')::text AS "offlinePunchReviewItem"
    `;

    expect(rows).toEqual([
      {
        offlinePackage: '"OfflinePackage"',
        offlinePackageParticipant: '"OfflinePackageParticipant"',
        offlinePunchReviewItem: '"OfflinePunchReviewItem"',
      },
    ]);
  });
});

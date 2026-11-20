import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertTestDatabaseUrl } from '../setup/test-db';

describe('deferred posting guard without a correction application', () => {
  let db: PrismaClient;
  // A fresh NOLOGIN role per invocation, confined to this test database.
  const reader = `settlement_test_${randomUUID().replaceAll('-', '')}`;
  let roleCreated = false;

  beforeAll(async () => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    db = new PrismaClient();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE ROLE "${reader}" NOLOGIN`);
      await tx.$executeRawUnsafe(
        `GRANT SELECT (id, "newPostingBatchId") ON public."CorrectionApplication" TO "${reader}"`,
      );
    });
    roleCreated = true;
  });

  afterAll(async () => {
    try {
      if (roleCreated) {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `REVOKE SELECT (id, "newPostingBatchId") ON public."CorrectionApplication" FROM "${reader}"`,
          );
          await tx.$executeRawUnsafe(`DROP ROLE "${reader}"`);
        });
      }
    } finally {
      await db?.$disconnect();
    }
  });

  it('commits without access to correction proofs or the protected phase function', async () => {
    // Run the installed trigger at COMMIT; only the temporary event source is
    // writable and it vanishes at commit. No business tables are modified.
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`CREATE TEMP TABLE "LedgerPostingBatch" (id text, "statusCode" text) ON COMMIT DROP`;
      await tx.$executeRaw`CREATE CONSTRAINT TRIGGER posting_guard AFTER INSERT ON pg_temp."LedgerPostingBatch"
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ctsp_lifecycle_guard()`;
      await tx.$executeRawUnsafe(`GRANT INSERT ON pg_temp."LedgerPostingBatch" TO "${reader}"`);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${reader}"`);
      const [identity] = await tx.$queryRaw<
        { actor: string; canDefer: boolean; canReadProof: boolean }[]
      >`
        SELECT current_user::text AS actor,
          has_function_privilege(current_user, 'public.r5_correction_phase_deferred_registered(text)', 'EXECUTE') AS "canDefer",
          has_any_column_privilege(current_user, 'public."CorrectionTimeSourceProof"', 'SELECT') AS "canReadProof"
      `;
      expect(identity).toEqual({ actor: reader, canDefer: false, canReadProof: false });
      await tx.$executeRaw`INSERT INTO pg_temp."LedgerPostingBatch" VALUES (${randomUUID()}, 'preparing')`;
    });
  });
});

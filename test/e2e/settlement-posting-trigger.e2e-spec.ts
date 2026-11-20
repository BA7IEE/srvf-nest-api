import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertTestDatabaseUrl } from '../setup/test-db';

describe('deferred posting guard without a correction application', () => {
  let db: PrismaClient;

  beforeAll(() => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    db = new PrismaClient();
  });

  afterAll(async () => db.$disconnect());

  it('commits an ordinary batch event with no EXECUTE on the protected correction function', async () => {
    // Exercise the installed deferred trigger at COMMIT. The temporary event
    // source is the only writable object for the reader and vanishes at commit.
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`CREATE TEMP TABLE "LedgerPostingBatch" (id text, "statusCode" text) ON COMMIT DROP`;
      await tx.$executeRaw`CREATE CONSTRAINT TRIGGER posting_guard AFTER INSERT ON pg_temp."LedgerPostingBatch"
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ctsp_lifecycle_guard()`;
      await tx.$executeRaw`GRANT INSERT ON pg_temp."LedgerPostingBatch" TO pg_read_all_data`;
      await tx.$executeRaw`SET LOCAL ROLE pg_read_all_data`;
      const [identity] = await tx.$queryRaw<{ actor: string; canDefer: boolean }[]>`
        SELECT current_user::text AS actor,
          has_function_privilege(current_user, 'public.r5_correction_phase_deferred_registered(text)', 'EXECUTE') AS "canDefer"
      `;
      expect(identity).toEqual({ actor: 'pg_read_all_data', canDefer: false });
      await tx.$executeRaw`INSERT INTO pg_temp."LedgerPostingBatch" VALUES (${randomUUID()}, 'preparing')`;
    });
  });
});

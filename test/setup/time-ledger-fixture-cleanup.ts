import type { Prisma } from '@prisma/client';
import {
  assertConnectedTestDatabase,
  assertDroppableTestDbName,
  assertTestDatabaseUrl,
} from './test-db';
import { deriveTestDbName } from './worktree-db';

const TRUNCATE_TRIGGERS = [
  { table: 'ParticipationTimeLedgerEntry', trigger: 'ptle_no_truncate' },
  { table: 'ParticipationTimeLedgerManifest', trigger: 'ptlm_no_truncate' },
] as const;

/** Fixed SQL fragments for existing psql batches; caller supplies BEGIN/COMMIT on one connection. */
export function timeLedgerFixtureTriggerSql(expectedDatabase = deriveTestDbName()) {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  assertDroppableTestDbName(expectedDatabase);
  const dbLiteral = "'" + expectedDatabase.replaceAll("'", "''") + "'";
  return {
    before: `DO $d6_fixture$
      DECLARE item record; states jsonb := '[]'::jsonb;
      BEGIN
        IF current_database() <> ${dbLiteral} THEN RAISE EXCEPTION 'Wrong fixture database'; END IF;
        FOR item IN
          SELECT c.relname AS tbl, names.trg, t.tgenabled::text AS enabled
          FROM (VALUES ('ParticipationTimeLedgerEntry','ptle_no_truncate'), ('ParticipationTimeLedgerManifest','ptlm_no_truncate')) names(tbl,trg)
          JOIN pg_class c ON c.relname=names.tbl JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
          LEFT JOIN pg_trigger t ON t.tgrelid=c.oid AND t.tgname=names.trg AND NOT t.tgisinternal
          ORDER BY names.tbl
        LOOP
          IF item.enabled IS NULL THEN RAISE EXCEPTION 'Expected fixture trigger missing'; END IF;
          states := states || jsonb_build_array(jsonb_build_object('table',item.tbl,'trigger',item.trg,'enabled',item.enabled));
          EXECUTE format('ALTER TABLE %I DISABLE TRIGGER %I',item.tbl,item.trg);
        END LOOP;
        PERFORM set_config('srvf.d6_fixture_trigger_states',states::text,true);
      END $d6_fixture$;`,
    after: `DO $d6_fixture$
      DECLARE item jsonb; clause text;
      BEGIN
        IF current_database() <> ${dbLiteral} THEN RAISE EXCEPTION 'Wrong fixture database'; END IF;
        FOR item IN SELECT value FROM jsonb_array_elements(current_setting('srvf.d6_fixture_trigger_states')::jsonb)
        LOOP
          IF NOT ((item->>'table'='ParticipationTimeLedgerEntry' AND item->>'trigger'='ptle_no_truncate') OR
                  (item->>'table'='ParticipationTimeLedgerManifest' AND item->>'trigger'='ptlm_no_truncate')) THEN
            RAISE EXCEPTION 'Unexpected fixture trigger';
          END IF;
          clause := CASE item->>'enabled' WHEN 'O' THEN 'ENABLE' WHEN 'D' THEN 'DISABLE' WHEN 'R' THEN 'ENABLE REPLICA' WHEN 'A' THEN 'ENABLE ALWAYS' ELSE NULL END;
          IF clause IS NULL THEN RAISE EXCEPTION 'Unknown fixture trigger state'; END IF;
          EXECUTE format('ALTER TABLE %I %s TRIGGER %I',item->>'table',clause,item->>'trigger');
        END LOOP;
      END $d6_fixture$;`,
  };
}

/** Test fixtures only. Caller must supply one transaction for guard, cleanup and restoration. */
export async function withTimeLedgerFixtureCleanup<T>(
  tx: Prisma.TransactionClient,
  cleanup: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  await assertConnectedTestDatabase(tx);
  const changed: { table: string; trigger: string; enabled: string }[] = [];
  for (const { table, trigger } of TRUNCATE_TRIGGERS) {
    const rows = await tx.$queryRaw<{ enabled: string | null }[]>`
      SELECT t.tgenabled::text AS enabled FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = ${trigger} AND NOT t.tgisinternal
      WHERE n.nspname = 'public' AND c.relname = ${table}
    `;
    if (rows.length === 0) continue;
    const enabled = rows[0].enabled;
    if (enabled === null) throw new Error('Expected fixture trigger is missing');
    if (!['O', 'A', 'R', 'D'].includes(enabled)) throw new Error('Unknown fixture trigger state');
    // Both identifiers are from the fixed two-element list above, never caller data.
    await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    changed.push({ table, trigger, enabled });
  }
  const result = await cleanup(tx);
  for (const { table, trigger, enabled } of changed) {
    const clause =
      enabled === 'D'
        ? 'DISABLE'
        : enabled === 'A'
          ? 'ENABLE ALWAYS'
          : enabled === 'R'
            ? 'ENABLE REPLICA'
            : 'ENABLE';
    await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ${clause} TRIGGER "${trigger}"`);
  }
  // A thrown callback must escape to the owning transaction; rollback restores ALTER TABLE too.
  return result;
}

import type { Prisma } from '@prisma/client';
import {
  assertConnectedTestDatabase,
  assertDroppableTestDbName,
  assertTestDatabaseUrl,
} from './test-db';
import { deriveTestDbName } from './worktree-db';

const TRUNCATE_TRIGGERS = [
  { table: 'ContributionRuleConversionReceipt', trigger: 'crcr_no_truncate' },
  {
    table: 'ActivityContributionPolicySelectionCommandReceipt',
    trigger: 'acps_receipt_no_truncate',
  },
  { table: 'ActivityContributionPolicySelectionItem', trigger: 'acps_item_no_truncate' },
  { table: 'ActivityContributionPolicySelectionRevision', trigger: 'acps_revision_no_truncate' },
  { table: 'ContributionPolicyCommandReceipt', trigger: 'cpr_no_truncate' },
  { table: 'ContributionPolicyVersion', trigger: 'cpv_no_truncate' },
  { table: 'ContributionPolicy', trigger: 'cp_no_truncate' },
  { table: 'ParticipationTimeCutoverBinding', trigger: 'ptcb_no_truncate' },
  { table: 'ActivityTimeCutoverReceipt', trigger: 'atcr_no_truncate' },
  { table: 'CorrectionPendingTimeAllocation', trigger: 'cpta_no_truncate' },
  { table: 'CorrectionPendingTimeAllocationEvidence', trigger: 'cptae_no_truncate' },
  { table: 'CorrectionTimeAllocationBinding', trigger: 'ctab_no_truncate' },
  { table: 'CorrectionTimeSourceProof', trigger: 'ctsp_no_truncate' },
  { table: 'ParticipationTimeCorrectionCommitReceipt', trigger: 'ptcr_no_truncate' },
  { table: 'ParticipationTimeCorrectionEntry', trigger: 'ptce_no_truncate' },
  { table: 'ParticipationTimeCorrectionManifest', trigger: 'ptcm_no_truncate' },
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
          FROM (VALUES ('ContributionRuleConversionReceipt','crcr_no_truncate'), ('ActivityContributionPolicySelectionCommandReceipt','acps_receipt_no_truncate'), ('ActivityContributionPolicySelectionItem','acps_item_no_truncate'), ('ActivityContributionPolicySelectionRevision','acps_revision_no_truncate'), ('ContributionPolicyCommandReceipt','cpr_no_truncate'), ('ContributionPolicyVersion','cpv_no_truncate'), ('ContributionPolicy','cp_no_truncate'), ('ParticipationTimeCutoverBinding','ptcb_no_truncate'), ('ActivityTimeCutoverReceipt','atcr_no_truncate'), ('CorrectionPendingTimeAllocation','cpta_no_truncate'), ('CorrectionPendingTimeAllocationEvidence','cptae_no_truncate'), ('CorrectionTimeAllocationBinding','ctab_no_truncate'), ('CorrectionTimeSourceProof','ctsp_no_truncate'), ('ParticipationTimeCorrectionCommitReceipt','ptcr_no_truncate'), ('ParticipationTimeCorrectionEntry','ptce_no_truncate'), ('ParticipationTimeCorrectionManifest','ptcm_no_truncate'), ('ParticipationTimeLedgerEntry','ptle_no_truncate'), ('ParticipationTimeLedgerManifest','ptlm_no_truncate')) names(tbl,trg)
          JOIN pg_class c ON c.relname=names.tbl JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
          LEFT JOIN pg_trigger t ON t.tgrelid=c.oid AND t.tgname=names.trg AND NOT t.tgisinternal
          ORDER BY names.tbl
        LOOP
          IF item.enabled IS NULL THEN RAISE EXCEPTION 'Expected fixture trigger missing'; END IF;
          states := states || jsonb_build_array(jsonb_build_object('table',item.tbl,'trigger',item.trg,'enabled',item.enabled));
          EXECUTE format('ALTER TABLE %I DISABLE TRIGGER %I',item.tbl,item.trg);
        END LOOP;
        IF to_regclass('public."ParticipationTimeCutoverBinding"') IS NOT NULL THEN
          IF to_regclass('public."ActivityTimeCutoverReceipt"') IS NULL THEN
            RAISE EXCEPTION 'Incomplete cutover fixture tables';
          END IF;
          EXECUTE 'TRUNCATE TABLE "ParticipationTimeCutoverBinding", "ActivityTimeCutoverReceipt" RESTART IDENTITY';
        END IF;
        PERFORM set_config('srvf.d6_fixture_trigger_states',states::text,true);
      END $d6_fixture$;`,
    after: `DO $d6_fixture$
      DECLARE item jsonb; clause text;
      BEGIN
        IF current_database() <> ${dbLiteral} THEN RAISE EXCEPTION 'Wrong fixture database'; END IF;
        IF to_regclass('public."ContributionPolicy"') IS NOT NULL OR
           to_regclass('public."ContributionPolicyVersion"') IS NOT NULL OR
           to_regclass('public."ContributionPolicyCommandReceipt"') IS NOT NULL THEN
          IF to_regclass('public."ContributionPolicy"') IS NULL OR
             to_regclass('public."ContributionPolicyVersion"') IS NULL OR
             to_regclass('public."ContributionPolicyCommandReceipt"') IS NULL THEN
            RAISE EXCEPTION 'Incomplete contribution policy fixture tables';
          END IF;
          IF to_regclass('public."ActivityContributionPolicySelectionRevision"') IS NOT NULL OR
             to_regclass('public."ActivityContributionPolicySelectionItem"') IS NOT NULL OR
             to_regclass('public."ActivityContributionPolicySelectionCommandReceipt"') IS NOT NULL THEN
            IF to_regclass('public."ActivityContributionPolicySelectionRevision"') IS NULL OR
               to_regclass('public."ActivityContributionPolicySelectionItem"') IS NULL OR
               to_regclass('public."ActivityContributionPolicySelectionCommandReceipt"') IS NULL THEN
              RAISE EXCEPTION 'Incomplete contribution policy selection fixture tables';
            END IF;
            IF EXISTS (SELECT 1 FROM "ActivityContributionPolicySelectionRevision" LIMIT 1) OR
               EXISTS (SELECT 1 FROM "ActivityContributionPolicySelectionItem" LIMIT 1) OR
               EXISTS (SELECT 1 FROM "ActivityContributionPolicySelectionCommandReceipt" LIMIT 1) THEN
              RAISE EXCEPTION 'Caller did not clear contribution policy selection fixtures';
            END IF;
          END IF;
          IF to_regclass('public."ContributionRuleConversionReceipt"') IS NOT NULL THEN
            EXECUTE 'TRUNCATE TABLE "ContributionRuleConversionReceipt", "ContributionPolicyCommandReceipt", "ContributionPolicyVersion", "ContributionPolicy" RESTART IDENTITY CASCADE';
          ELSE
            EXECUTE 'TRUNCATE TABLE "ContributionPolicyCommandReceipt", "ContributionPolicyVersion", "ContributionPolicy" RESTART IDENTITY CASCADE';
          END IF;
        END IF;
        FOR item IN SELECT value FROM jsonb_array_elements(current_setting('srvf.d6_fixture_trigger_states')::jsonb)
        LOOP
          IF NOT ((item->>'table'='ContributionRuleConversionReceipt' AND item->>'trigger'='crcr_no_truncate') OR
                  (item->>'table'='ActivityContributionPolicySelectionCommandReceipt' AND item->>'trigger'='acps_receipt_no_truncate') OR
                  (item->>'table'='ActivityContributionPolicySelectionItem' AND item->>'trigger'='acps_item_no_truncate') OR
                  (item->>'table'='ActivityContributionPolicySelectionRevision' AND item->>'trigger'='acps_revision_no_truncate') OR
                  (item->>'table'='ContributionPolicyCommandReceipt' AND item->>'trigger'='cpr_no_truncate') OR
                  (item->>'table'='ContributionPolicyVersion' AND item->>'trigger'='cpv_no_truncate') OR
                  (item->>'table'='ContributionPolicy' AND item->>'trigger'='cp_no_truncate') OR
                  (item->>'table'='ParticipationTimeCutoverBinding' AND item->>'trigger'='ptcb_no_truncate') OR
                  (item->>'table'='ActivityTimeCutoverReceipt' AND item->>'trigger'='atcr_no_truncate') OR
                  (item->>'table'='CorrectionPendingTimeAllocation' AND item->>'trigger'='cpta_no_truncate') OR
                  (item->>'table'='CorrectionPendingTimeAllocationEvidence' AND item->>'trigger'='cptae_no_truncate') OR
                  (item->>'table'='CorrectionTimeAllocationBinding' AND item->>'trigger'='ctab_no_truncate') OR
                  (item->>'table'='CorrectionTimeSourceProof' AND item->>'trigger'='ctsp_no_truncate') OR
                  (item->>'table'='ParticipationTimeLedgerEntry' AND item->>'trigger'='ptle_no_truncate') OR
                  (item->>'table'='ParticipationTimeCorrectionCommitReceipt' AND item->>'trigger'='ptcr_no_truncate') OR
                  (item->>'table'='ParticipationTimeCorrectionEntry' AND item->>'trigger'='ptce_no_truncate') OR
                  (item->>'table'='ParticipationTimeCorrectionManifest' AND item->>'trigger'='ptcm_no_truncate') OR
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
    // Both identifiers are from the fixed list above, never caller data.
    await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    changed.push({ table, trigger, enabled });
  }
  const cutoverTables = new Set(
    changed
      .filter(({ table }) =>
        ['ParticipationTimeCutoverBinding', 'ActivityTimeCutoverReceipt'].includes(table),
      )
      .map(({ table }) => table),
  );
  if (cutoverTables.size !== 0) {
    if (cutoverTables.size !== 2) throw new Error('Incomplete cutover fixture tables');
    await tx.$executeRawUnsafe(
      'TRUNCATE TABLE "ParticipationTimeCutoverBinding", "ActivityTimeCutoverReceipt" RESTART IDENTITY',
    );
  }
  const contributionPolicyTables = new Set(
    changed
      .filter(({ table }) =>
        [
          'ContributionPolicyCommandReceipt',
          'ContributionPolicyVersion',
          'ContributionPolicy',
        ].includes(table),
      )
      .map(({ table }) => table),
  );
  const conversionReceipt = changed.some(
    ({ table }) => table === 'ContributionRuleConversionReceipt',
  );
  if (conversionReceipt && contributionPolicyTables.size !== 3) {
    throw new Error('Conversion fixture receipt requires contribution policy tables');
  }
  if (contributionPolicyTables.size !== 0) {
    if (contributionPolicyTables.size !== 3) {
      throw new Error('Incomplete contribution policy fixture tables');
    }
  }
  const contributionSelectionTables = new Set(
    changed
      .filter(({ table }) =>
        [
          'ActivityContributionPolicySelectionCommandReceipt',
          'ActivityContributionPolicySelectionItem',
          'ActivityContributionPolicySelectionRevision',
        ].includes(table),
      )
      .map(({ table }) => table),
  );
  if (contributionSelectionTables.size !== 0) {
    if (contributionSelectionTables.size !== 3) {
      throw new Error('Incomplete contribution policy selection fixture tables');
    }
    if (contributionPolicyTables.size !== 3) {
      throw new Error('Contribution policy selection fixture tables require policy tables');
    }
  }
  const result = await cleanup(tx);
  if (contributionPolicyTables.size === 3) {
    if (contributionSelectionTables.size === 3) {
      const [selectionRows] = await tx.$queryRawUnsafe<
        Array<{ revisions: bigint; items: bigint; receipts: bigint }>
      >(`SELECT
        (SELECT count(*) FROM "ActivityContributionPolicySelectionRevision") AS revisions,
        (SELECT count(*) FROM "ActivityContributionPolicySelectionItem") AS items,
        (SELECT count(*) FROM "ActivityContributionPolicySelectionCommandReceipt") AS receipts`);
      if (
        selectionRows.revisions !== 0n ||
        selectionRows.items !== 0n ||
        selectionRows.receipts !== 0n
      ) {
        throw new Error('Caller did not clear contribution policy selection fixtures');
      }
    }
    await tx.$executeRawUnsafe(
      conversionReceipt
        ? 'TRUNCATE TABLE "ContributionRuleConversionReceipt", "ContributionPolicyCommandReceipt", "ContributionPolicyVersion", "ContributionPolicy" RESTART IDENTITY CASCADE'
        : 'TRUNCATE TABLE "ContributionPolicyCommandReceipt", "ContributionPolicyVersion", "ContributionPolicy" RESTART IDENTITY CASCADE',
    );
  }
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

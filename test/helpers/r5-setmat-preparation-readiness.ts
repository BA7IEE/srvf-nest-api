import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';
import { R5_SETMAT_CALLER } from './r5-setmat-observation';

export const R5_PREPARE_STORAGE_COLUMNS = Object.freeze([
  // The retained real Prisma SELECT includes its primary key as well.
  'id',
  'key',
  'state',
  'resourceType',
  'resourceId',
  'deleteRequestedAt',
] as const);

export interface R5PrepareStorageReadiness {
  role: string;
  roleOid: string;
  table: string;
  tableExists: boolean;
  schemaUsage: boolean;
  tableSelect: boolean;
  rls: boolean;
  forceRls: boolean;
  columns: { name: string; select: boolean }[];
}

/** Catalog-only ACL prerequisite, not a storage-data or safety verdict. Always
 * test the original caller explicitly, even when the observer is an admin.
 */
export async function readR5PrepareStorageReadiness(observer: PrismaClient) {
  return await observer.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout='4s'`;
      const rows = await tx.$queryRaw<{ proof: R5PrepareStorageReadiness }[]>`
      SELECT jsonb_build_object(
        'role',r.rolname,'roleOid',r.oid::text,'table','public.storage_objects',
        'tableExists',c.oid IS NOT NULL,'schemaUsage',has_schema_privilege(r.oid,'public','USAGE'),
        'tableSelect',CASE WHEN c.oid IS NULL THEN false ELSE has_table_privilege(r.oid,c.oid,'SELECT') END,
        'rls',COALESCE(c.relrowsecurity,false),'forceRls',COALESCE(c.relforcerowsecurity,false),
        'columns',(SELECT jsonb_agg(jsonb_build_object('name',x.name,'select',
          CASE WHEN c.oid IS NULL THEN false ELSE has_column_privilege(r.oid,c.oid,x.name,'SELECT') END)
          ORDER BY x.ordinal)
          FROM unnest(ARRAY['id','key','state','resourceType','resourceId','deleteRequestedAt']) WITH ORDINALITY x(name,ordinal))
      ) AS proof FROM pg_roles r
      LEFT JOIN pg_class c ON c.oid=to_regclass('public.storage_objects')
      WHERE r.rolname=${R5_SETMAT_CALLER}
    `;
      assert.equal(rows.length, 1, 'original caller role must exist');
      return rows[0].proof;
    },
    { timeout: 7_000, maxWait: 2_000 },
  );
}

export function assertR5PrepareStorageReadiness(proof: R5PrepareStorageReadiness) {
  assert.equal(proof.role, R5_SETMAT_CALLER, 'admin/other-role access is not caller access');
  assert(/^[1-9][0-9]*$/.test(proof.roleOid));
  assert.equal(proof.table, 'public.storage_objects');
  assert.equal(proof.tableExists, true);
  assert.equal(proof.schemaUsage, true);
  assert.equal(proof.rls, false, 'storage RLS differs from the frozen source');
  assert.equal(proof.forceRls, false, 'forced storage RLS differs from the frozen source');
  assert.deepEqual(
    proof.columns.map((row) => row.name),
    [...R5_PREPARE_STORAGE_COLUMNS],
  );
  const missing = proof.columns.filter((row) => row.select !== true).map((row) => row.name);
  assert.equal(
    missing.length,
    0,
    `R5 prepare prerequisite blocked: ${R5_SETMAT_CALLER} lacks SELECT on public.storage_objects columns [${missing.join(',')}]; permission decision required before fixture writes`,
  );
}

export type R5FixedActorIds = Record<'creator' | 'A' | 'B', string>;
export function assertR5ReadClosureCatalog(catalog: unknown) {
  assert(catalog !== null && typeof catalog === 'object');
  const tables: unknown = Reflect.get(catalog, 'tables');
  assert(Array.isArray(tables));
  const names = tables.map((table: unknown) => {
    assert(table !== null && typeof table === 'object');
    const name: unknown = Reflect.get(table, 'name');
    assert(typeof name === 'string');
    return name;
  });
  assert.equal(new Set(names).size, names.length);
  for (const name of ['storage_objects', 'User', 'organization_position_assignments']) {
    assert(
      names.includes(name),
      `new source-qualified caller-read dependency pin missing: ${name}`,
    );
  }
}

export interface R5FixedActorAssignmentFact {
  label: string;
  actorExists: boolean;
  memberLinkExists: boolean;
  nonSoftDeletedAssignmentCount: number;
}

/** Exact collectGrants predicate. Status and term never filter this count. */
export async function readR5FixedActorAssignments(
  tx: Prisma.TransactionClient,
  actors: R5FixedActorIds,
): Promise<R5FixedActorAssignmentFact[]> {
  assert.deepEqual(Object.keys(actors).sort(), ['A', 'B', 'creator']);
  assert(Object.values(actors).every((id) => typeof id === 'string' && id.length > 0));
  assert.equal(new Set(Object.values(actors)).size, 3);
  const values = Prisma.join(
    Object.entries(actors).map(([label, id]) => Prisma.sql`(${label}::text,${id}::text)`),
  );
  return await tx.$queryRaw<R5FixedActorAssignmentFact[]>(Prisma.sql`
    WITH fixed_actor(label,user_id) AS (VALUES ${values})
    SELECT f.label,(u.id IS NOT NULL) AS "actorExists",
      (u."memberId" IS NOT NULL) AS "memberLinkExists",
      (SELECT count(*)::int FROM public.organization_position_assignments pa
        WHERE pa."memberId"=u."memberId" AND pa."deletedAt" IS NULL)
        AS "nonSoftDeletedAssignmentCount"
    FROM fixed_actor f LEFT JOIN public."User" u ON u.id=f.user_id ORDER BY f.label
  `);
}

export function assertR5NoPolicyBranch(facts: readonly R5FixedActorAssignmentFact[]) {
  assert.deepEqual(
    facts.map((fact) => fact.label).sort(),
    ['A', 'B', 'creator'],
    'exact fixed actor facts required',
  );
  for (const fact of facts) {
    assert.equal(fact.actorExists, true);
    assert.equal(fact.memberLinkExists, true);
    assert(Number.isSafeInteger(fact.nonSoftDeletedAssignmentCount));
    assert.equal(
      fact.nonSoftDeletedAssignmentCount,
      0,
      `zero-assignment prerequisite changed for ${fact.label}; stop without adding policy privileges`,
    );
  }
}

export async function readR5ZeroAssignmentReadiness(
  observer: PrismaClient,
  actors: R5FixedActorIds,
) {
  return await observer.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout='4s'`;
      await tx.$executeRaw`SET LOCAL ROLE "r5_boundary_caller_h7c6"`;
      return await readR5FixedActorAssignments(tx, actors);
    },
    { timeout: 7_000, maxWait: 2_000 },
  );
}

import { Prisma, PrismaClient, type ActivitySettlementContributionRevision } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  installE4ValidationDatabase,
  prepareE4Time,
  submitE4Time,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import {
  E4_MIGRATION_137,
  E4_MIGRATION_140,
  E4_MIGRATION_142,
  E4_MIGRATION_143,
} from '../helpers/e4-migration-prefix';
import { assertConnectedTestDatabase } from '../setup/test-db';

const namespace = 'e4_assert_oracle_' + randomBytes(8).toString('hex');
const oldPin = '21fe9ecf6df989a3f8fa5878df40b93c';
const newPin = 'ade4d2af9aa0baf8400a79fc6b62c797';
const candidateSha = 'c996a26fc7dca81e73a75843d9cdd792d895e5e66855899fd05a42ce7c02d819';
const rollback = new Error('E4 source reuse intentional rollback');
// Only these test-owned transactions run several independent old/new guards.
// Keep Prisma's default 5s deadline from masking the native SQLSTATE/rollback.
const guardTransactionOptions = { maxWait: 5_000, timeout: 30_000 };
type Database = PrismaClient | Prisma.TransactionClient;
type Outcome = { state: string; guard: string };
type OracleExpectation = {
  evaluations: number;
  sources: number;
  seconds: number;
  days: { ledgerDate: string; recognizedPoints: string }[];
};
const singleSourceExpectation: OracleExpectation = {
  evaluations: 1,
  sources: 1,
  seconds: 3600,
  days: [{ ledgerDate: '2020-03-01', recognizedPoints: '1.00' }],
};

function deferredEvaluationErrorEvidence(error: unknown) {
  const unknownRequest = error instanceof Prisma.PrismaClientUnknownRequestError;
  const native = unknownRequest
    ? error.message.match(
        /PostgresError \{ code: "([0-9A-Z]{5})", message: "([^"]*)", severity: "ERROR"/u,
      )
    : null;
  return {
    unknownRequest,
    sqlstate: native?.[1] ?? 'NONE',
    evaluationGuardMessage: native?.[2] === 'contribution evaluation set mismatch',
  };
}

function redactedDiagnosticText(text: string) {
  const allowed = new Set([
    '23514',
    '23505',
    '23503',
    '40P01',
    'P2028',
    'P2010',
    'ERROR',
    'contribution evaluation set mismatch',
    'e4_evaluation_guard',
    'PrismaClientUnknownRequestError',
    'PrismaClientKnownRequestError',
    'Error',
    'code',
    'message',
    'severity',
    'constraint',
    'name',
    'kind',
    'clientVersion',
    'cause',
    'detail',
    'column',
    'hint',
    'error',
    'meta',
    'sqlstate',
    'original_code',
  ]);
  return text
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[URL_REDACTED]')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>)}]+/gu, '[PATH_REDACTED]')
    .replace(
      /\b(?:password|secret|token|authorization)\s*[:=]\s*[^,;\n}]+/giu,
      '[CREDENTIAL_REDACTED]',
    )
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/gu, (quoted) =>
      allowed.has(quoted.slice(1, -1)) ? quoted : '[QUOTED_REDACTED]',
    )
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu, '[EMAIL_REDACTED]')
    .replace(
      /\b(?:[a-f0-9]{32,64}|c[a-z0-9]{20,32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/giu,
      '[ID_REDACTED]',
    )
    .replace(/\b\d{9,}\b/gu, '[NUMBER_REDACTED]');
}

function deferredErrorDiagnostic(error: unknown, depth = 0): object {
  const object = error !== null && typeof error === 'object' ? error : undefined;
  const properties = object ? Object.getOwnPropertyDescriptors(object) : {};
  const message: unknown = typeof error === 'string' ? error : properties.message?.value;
  const name: unknown = error instanceof Error ? error.name : properties.name?.value;
  const prototype: unknown = object ? Object.getPrototypeOf(object) : undefined;
  const constructorValue: unknown =
    prototype !== null && typeof prototype === 'object'
      ? Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
      : undefined;
  const constructor = typeof constructorValue === 'function' ? constructorValue.name : undefined;
  const clientVersion: unknown = properties.clientVersion?.value;
  const cause: unknown = properties.cause?.value;
  const code: unknown = properties.code?.value;
  const meta: unknown = properties.meta?.value;
  const sanitized = typeof message === 'string' ? redactedDiagnosticText(message) : '';
  const nativeOffset = sanitized.indexOf('PostgresError');
  return {
    type: typeof error,
    constructor:
      typeof constructor === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(constructor)
        ? constructor
        : 'OTHER',
    name:
      typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(name) ? name : 'OTHER',
    clientVersion:
      typeof clientVersion === 'string' && /^\d+\.\d+\.\d+$/u.test(clientVersion)
        ? clientVersion
        : 'OTHER',
    ownProperties: Object.entries(properties).map(([key, descriptor]) => ({
      name: key,
      type: 'value' in descriptor ? typeof descriptor.value : 'accessor',
    })),
    message: sanitized.slice(0, 1600),
    messageCharacters: typeof message === 'string' ? message.length : 0,
    messageTruncated: sanitized.length > 1600,
    nativeWindow: nativeOffset < 0 ? '' : sanitized.slice(nativeOffset, nativeOffset + 800),
    messageMarkers: {
      postgresError: typeof message === 'string' && message.includes('PostgresError'),
      queryError: typeof message === 'string' && message.includes('QueryError'),
      sqlstate23514: typeof message === 'string' && message.includes('23514'),
      evaluationGuardMessage:
        typeof message === 'string' && message.includes('contribution evaluation set mismatch'),
    },
    nativeCode:
      typeof code === 'string' && /^(?:P[0-9]{4}|23514|23505|23503|40P01|55P03|57P01)$/u.test(code)
        ? code
        : 'OTHER',
    meta: depth < 1 && meta !== undefined ? deferredErrorDiagnostic(meta, depth + 1) : null,
    cause: depth < 1 && cause !== undefined ? deferredErrorDiagnostic(cause, depth + 1) : null,
  };
}

describe('E4 deferred COMMIT error evidence adapter', () => {
  const nativeMessage = (code: string, message: string) =>
    `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "${message}", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`;
  it('accepts a PostgresError-shaped unknown-request fixture with the exact native code and message', () => {
    expect(
      deferredEvaluationErrorEvidence(
        new Prisma.PrismaClientUnknownRequestError(
          nativeMessage('23514', 'contribution evaluation set mismatch'),
          { clientVersion: Prisma.prismaVersion.client },
        ),
      ),
    ).toEqual({ unknownRequest: true, sqlstate: '23514', evaluationGuardMessage: true });
  });
  it.each([
    ['23505', 'contribution evaluation set mismatch'],
    ['23514', 'contribution unresolved source'],
    ['23514', 'transaction expired'],
  ])('rejects native code=%s/message=%s from another failure', (code, message) => {
    expect(
      deferredEvaluationErrorEvidence(
        new Prisma.PrismaClientUnknownRequestError(nativeMessage(code, message), {
          clientVersion: Prisma.prismaVersion.client,
        }),
      ),
    ).not.toEqual({ unknownRequest: true, sqlstate: '23514', evaluationGuardMessage: true });
  });
  it('rejects an arbitrary Error even when its text imitates the native error', () => {
    expect(
      deferredEvaluationErrorEvidence(
        new Error(nativeMessage('23514', 'contribution evaluation set mismatch')),
      ),
    ).toEqual({ unknownRequest: false, sqlstate: 'NONE', evaluationGuardMessage: false });
  });
  it('rejects P2028 even when its text imitates the native error', () => {
    expect(
      deferredEvaluationErrorEvidence(
        new Prisma.PrismaClientKnownRequestError(
          nativeMessage('23514', 'contribution evaluation set mismatch'),
          { code: 'P2028', clientVersion: Prisma.prismaVersion.client },
        ),
      ),
    ).toEqual({ unknownRequest: false, sqlstate: 'NONE', evaluationGuardMessage: false });
  });
  it('redacts diagnostic values while retaining native code/message structure', () => {
    const text =
      nativeMessage('23514', 'contribution evaluation set mismatch') +
      ' https://example.invalid/private?token=fixture-secret /private/fixture/path ' +
      'password="fixture-password" "fixture-member" user@example.invalid 12345678901';
    const redacted = redactedDiagnosticText(text);
    expect(redacted).toContain('code: "23514"');
    expect(redacted).toContain('message: "contribution evaluation set mismatch"');
    for (const value of [
      'example.invalid',
      '/private/',
      'fixture-secret',
      'fixture-password',
      'fixture-member',
      '12345678901',
    ])
      expect(redacted).not.toContain(value);
  });
  it('records actual error descriptors and a redacted cause without changing strict evidence', () => {
    const error = new Prisma.PrismaClientUnknownRequestError(
      nativeMessage('23514', 'contribution evaluation set mismatch'),
      { clientVersion: Prisma.prismaVersion.client },
    );
    Object.defineProperty(error, 'cause', {
      value: new Error('https://example.invalid/private?token=fixture-secret "fixture-member"'),
    });
    const diagnostic = deferredErrorDiagnostic(error);
    expect(diagnostic).toMatchObject({
      constructor: error.constructor.name,
      name: error.name,
      clientVersion: Prisma.prismaVersion.client,
      ownProperties: expect.arrayContaining([
        { name: 'message', type: 'string' },
        { name: 'cause', type: 'object' },
      ]),
      messageMarkers: { postgresError: true, queryError: true, sqlstate23514: true },
      cause: { constructor: 'Error', name: 'Error' },
    });
    const serialized = JSON.stringify(diagnostic);
    for (const value of ['example.invalid', 'fixture-secret', 'fixture-member'])
      expect(serialized).not.toContain(value);
    expect(deferredEvaluationErrorEvidence(error)).toEqual({
      unknownRequest: true,
      sqlstate: '23514',
      evaluationGuardMessage: true,
    });
  });
});

function frozenAssertion() {
  const source = readFileSync(
    resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_137, 'migration.sql'),
    'utf8',
  );
  const definitions = [
    ...source.matchAll(/CREATE FUNCTION e4_assert_complete\([^]*? AS \$\$([^]*?)\$\$;/gu),
  ];
  expect(definitions).toHaveLength(1);
  expect(createHash('md5').update(definitions[0][1]).digest('hex')).toBe(oldPin);
  return definitions[0][0].replace(
    'CREATE FUNCTION e4_assert_complete(',
    'CREATE FUNCTION ' + namespace + '.original142(',
  );
}

// Load the existing independently frozen oracle as data, without registering its suite.
function frozenOracle() {
  const path = resolve(__dirname, 'activity-os-r5-e4-contribution-settlement.e2e-spec.ts');
  const source = readFileSync(path, 'utf8');
  expect(createHash('sha256').update(source).digest('hex')).toBe(
    '46c31154bfa284f923ab34ca8be651573a8fe3a1f6d6035e1010265371a17e72',
  );
  const names = ['fixedE4RootAggregateSql', 'assertFixedE4RootOracle', 'assertFixedE4Oracle'];
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && !!node.name && names.includes(node.name.text),
  );
  expect(functions).toHaveLength(3);
  const code = ts.transpileModule(functions.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(code + '\nassertFixedE4Oracle;', {
    Prisma,
    createHash,
    readFileSync,
    resolve,
    __dirname,
    expect,
  }) as (db: PrismaClient, id: string, count?: number) => Promise<void>;
}

async function assertSmallFixtureDayOracle(
  db: PrismaClient,
  revisionId: string,
  expected: OracleExpectation,
) {
  const source = readFileSync(
    resolve(__dirname, 'activity-os-r5-e4-contribution-settlement-migration.e2e-spec.ts'),
    'utf8',
  );
  const fixed = [...source.matchAll(/const E4_P_DAY_ORACLE_SQL = String\.raw`([\s\S]*?)`;/gu)];
  expect(fixed).toHaveLength(1);
  expect(createHash('sha256').update(fixed[0][1]).digest('hex')).toBe(
    'a8cdf667c0632e832d10ea2912ebd510e84163097ddfc594f55d000746446274',
  );
  // Fixed fixture expectations are independent of stored counts and candidate output.
  const [denominators] = await db.$queryRaw<
    { sources: number; slices: number; allocations: number; seconds: number; invalid: number }[]
  >`
    WITH refs AS (
      SELECT ref FROM "ParticipantContributionEvaluation" e
      CROSS JOIN LATERAL jsonb_array_elements(e."sourceRefsJson") r(ref)
      WHERE e."contributionRevisionId"=${revisionId}
    ) SELECT count(*)::int AS sources,count(DISTINCT ref->>'sliceId')::int AS slices,
      count(DISTINCT ref->>'allocationRevisionId')::int AS allocations,
      coalesce(sum((ref->>'durationSeconds')::int),0)::int AS seconds,
      count(*) FILTER (WHERE ref->>'sliceId' IS NULL OR ref->>'allocationRevisionId' IS NULL)::int AS invalid
    FROM refs
  `;
  expect(denominators).toEqual({
    sources: expected.sources,
    slices: expected.evaluations,
    allocations: expected.evaluations,
    seconds: expected.seconds,
    invalid: 0,
  });
  await expect(
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
      await tx.$executeRawUnsafe(
        fixed[0][1].replace(
          'CREATE FUNCTION e4_day_points(',
          'CREATE FUNCTION pg_temp.e4_assert143_day_oracle(',
        ),
      );
      const [functionScope] = await tx.$queryRaw<{ temporary: boolean }[]>`
        SELECT p.pronamespace=pg_my_temp_schema() AS temporary FROM pg_proc p
        WHERE p.oid='pg_temp.e4_assert143_day_oracle(jsonb,integer)'::regprocedure
      `;
      expect(functionScope.temporary).toBe(true);
      const [comparison] = await tx.$queryRaw<
        {
          evaluations: number;
          candidateDifferences: number;
          storedDifferences: number;
          fixtureDifferences: number;
        }[]
      >`
        WITH results AS MATERIALIZED (
          SELECT "beijingDayPointsJson" AS stored,
            pg_temp.e4_assert143_day_oracle("sourceRefsJson",("recognizedPoints"*100)::int) AS old_day,
            public.e4_day_points("sourceRefsJson",("recognizedPoints"*100)::int) AS candidate_day
          FROM "ParticipantContributionEvaluation" WHERE "contributionRevisionId"=${revisionId}
        ) SELECT count(*)::int AS evaluations,
          count(*) FILTER (WHERE old_day IS DISTINCT FROM candidate_day)::int AS "candidateDifferences",
          count(*) FILTER (WHERE old_day IS DISTINCT FROM stored)::int AS "storedDifferences",
          count(*) FILTER (WHERE old_day IS DISTINCT FROM ${JSON.stringify(expected.days)}::jsonb)::int AS "fixtureDifferences"
        FROM results
      `;
      expect(comparison).toEqual({
        evaluations: expected.evaluations,
        candidateDifferences: 0,
        storedDifferences: 0,
        fixtureDifferences: 0,
      });
      throw rollback;
    }, guardTransactionOptions),
  ).rejects.toBe(rollback);
  const [residue] = await db.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.proname='e4_assert143_day_oracle' AND n.nspname LIKE 'pg_temp_%'
  `;
  expect(residue.count).toBe(0);
}

async function outcome(
  db: Database,
  id: string,
  original = false,
  validateVersion = true,
): Promise<Outcome> {
  const [row] = await db.$queryRawUnsafe<Outcome[]>(
    'SELECT state,guard FROM ' + namespace + '.outcome($1,$2,$3)',
    id,
    original,
    validateVersion,
  );
  return row;
}

async function catalog(db: Database) {
  const functions = await db.$queryRaw`
    SELECT p.oid::text AS oid,CASE WHEN p.oid='public.e4_assert_complete(text,boolean)'::regprocedure
      THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END AS metadata
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid
  `;
  const constraints =
    await db.$queryRaw`SELECT to_jsonb(c)::text AS definition FROM pg_constraint c WHERE connamespace='public'::regnamespace ORDER BY oid`;
  const triggers =
    await db.$queryRaw`SELECT to_jsonb(t)::text AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid`;
  const indexes =
    await db.$queryRaw`SELECT oid::text AS oid,pg_get_indexdef(oid) AS definition FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='i' ORDER BY oid`;
  return JSON.stringify({ functions, constraints, triggers, indexes });
}

async function catalogTargetSignature(db: Database) {
  const [signature] = await db.$queryRaw<
    {
      oid: string;
      arguments: string;
      identityArguments: string;
      defaultExpression: string | null;
      proargdefaults: string | null;
      proargtypes: string;
      proallargtypes: string | null;
      proargmodes: string | null;
      proargnames: string[] | null;
    }[]
  >`
    SELECT p.oid::text AS oid,pg_get_function_arguments(p.oid) AS arguments,
      pg_get_function_identity_arguments(p.oid) AS "identityArguments",
      pg_get_expr(p.proargdefaults,0) AS "defaultExpression",p.proargdefaults::text AS proargdefaults,
      p.proargtypes::text AS proargtypes,p.proallargtypes::text AS proallargtypes,
      p.proargmodes::text AS proargmodes,p.proargnames AS proargnames
    FROM pg_proc p WHERE p.oid='public.e4_assert_complete(text,boolean)'::regprocedure
  `;
  return signature;
}

function catalogDiagnosticFields(source: string) {
  const parsed: unknown = JSON.parse(source);
  const fields = new Map<string, unknown>();
  if (parsed === null || typeof parsed !== 'object') throw new Error('E4 catalog diagnostic shape');
  for (const [category, rows] of Object.entries(parsed)) {
    if (!Array.isArray(rows)) throw new Error('E4 catalog diagnostic rows');
    for (const entry of rows) {
      const row: unknown = entry;
      if (row === null || typeof row !== 'object') throw new Error('E4 catalog diagnostic row');
      let record: object = row;
      if ('metadata' in row && row.metadata !== null && typeof row.metadata === 'object')
        record = row.metadata;
      else if (
        'definition' in row &&
        typeof row.definition === 'string' &&
        row.definition.startsWith('{')
      ) {
        const definition: unknown = JSON.parse(row.definition);
        if (definition === null || typeof definition !== 'object')
          throw new Error('E4 catalog definition shape');
        record = definition;
      }
      const oid: unknown = 'oid' in row ? row.oid : 'oid' in record ? record.oid : undefined;
      if (!/^\d+$/u.test(String(oid))) throw new Error('E4 catalog diagnostic oid');
      for (const [field, value] of Object.entries(record))
        fields.set(`${category}.${String(oid)}.${field}`, value);
    }
  }
  return fields;
}

function catalogFieldDiagnostic(value: unknown, field: string, target: boolean) {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value ?? null;
  // Only the target's fixed boolean default node is printed verbatim. Other
  // catalog strings (function SQL, ACLs, index definitions) stay hashed.
  if (target && field === 'proargdefaults' && typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  return {
    characters: serialized.length,
    sha256: createHash('sha256').update(serialized).digest('hex'),
  };
}

function emitCatalogDiagnostic(
  before: string,
  after: string,
  phase: 'BASELINE_ORACLE' | 'UPGRADE' | 'CANDIDATE_ORACLE' | 'NOOP',
  beforeTarget: Awaited<ReturnType<typeof catalogTargetSignature>>,
  afterTarget: Awaited<ReturnType<typeof catalogTargetSignature>>,
) {
  const a = catalogDiagnosticFields(before);
  const b = catalogDiagnosticFields(after);
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter(
    (key) => JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key)),
  );
  console.info(
    'E4_ASSERT143_CATALOG_DIFF',
    JSON.stringify({
      phase,
      equal: before === after,
      changedFields: changed.length,
      changes: changed.slice(0, 12).map((key) => {
        const [category, oid, field] = key.split('.');
        const target =
          category === 'functions' && (oid === beforeTarget.oid || oid === afterTarget.oid);
        return {
          category,
          oid,
          field,
          target,
          before: catalogFieldDiagnostic(a.get(key), field, target),
          after: catalogFieldDiagnostic(b.get(key), field, target),
        };
      }),
      truncated: changed.length > 12,
      beforeTarget,
      afterTarget,
    }),
  );
}

async function migrationRows(db: Database) {
  return db.$queryRaw<
    { name: string; checksum: string }[]
  >`SELECT migration_name AS name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
}

async function businessSnapshot(db: Database) {
  const tables = await db.$queryRaw<
    { name: string }[]
  >`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname <> '_prisma_migrations' ORDER BY relname COLLATE "C"`;
  expect(tables.length).toBeGreaterThanOrEqual(196);
  const snapshots: string[] = [];
  for (const { name } of tables) {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    const [row] = await db.$queryRawUnsafe<{ snapshot: string }[]>(
      'SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text COLLATE "C"),\'[]\'::jsonb)::text AS snapshot FROM public.' +
        quoted +
        ' row',
    );
    snapshots.push(row.snapshot);
  }
  // Private rows remain in memory; failure output receives only a boolean.
  return JSON.stringify(snapshots);
}

function withoutIdentity<T extends { id: string; createdAt: Date }>(
  row: T,
): Omit<T, 'id' | 'createdAt'> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'id' && key !== 'createdAt'),
  ) as Omit<T, 'id' | 'createdAt'>;
}

function rootData(
  root: ActivitySettlementContributionRevision,
  revision: number,
  operationKey: string,
) {
  const data = withoutIdentity(root);
  return { ...data, revision, operationKey };
}

describe('E4 complete assertion source reuse migration 143', () => {
  const owner = installE4ValidationDatabase({ baselineMigrationCount: 136 });
  const priorGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let fixture: E4Fixture | undefined;
  let installed = false;
  let upgraded143 = false;
  let roots: ActivitySettlementContributionRevision[] = [];
  const fixedOracle = frozenOracle();
  const expectations = new Map<string, OracleExpectation>();
  const oracle = async (client: PrismaClient, id: string) => {
    const root = await client.activitySettlementContributionRevision.findUniqueOrThrow({
      where: { id },
    });
    const expected = expectations.get(root.activityId);
    if (!expected) throw new Error('E4 small fixture oracle expectation missing');
    await fixedOracle(client, id, expected.evaluations);
    await assertSmallFixtureDayOracle(client, id, expected);
  };
  const db = () => {
    if (!fixture) throw new Error('E4 source reuse fixture missing');
    return fixture.db;
  };
  const require143 = async () => {
    if (!upgraded143)
      throw new Error('E4 dedicated 142 to143 installation prerequisite was not reached');
    const migrations = await migrationRows(db());
    expect(migrations).toHaveLength(143);
    expect(migrations[142]).toEqual({ name: E4_MIGRATION_143, checksum: candidateSha });
    const [body] = await db().$queryRaw<{ pin: string }[]>`
      SELECT md5(prosrc) AS pin FROM pg_proc
      WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure
    `;
    expect(body.pin).toBe(newPin);
  };
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    owner.deployUnitMigrations();
    fixture = await createE4Fixture();
    for (const { options, expected } of [
      { options: {}, expected: singleSourceExpectation },
      {
        options: {
          startsAt: new Date('2020-03-01T15:30:00.000Z'),
          endsAt: new Date('2020-03-01T17:00:00.000Z'),
        },
        expected: {
          evaluations: 1,
          // D4's bucket key is revision/identity/category, not a Beijing date.
          // This single allocation/slice is one source reference spanning two days.
          sources: 1,
          seconds: 5400,
          days: [
            { ledgerDate: '2020-03-01', recognizedPoints: '0.33' },
            { ledgerDate: '2020-03-02', recognizedPoints: '0.67' },
          ],
        },
      },
      {
        options: {
          beforeSeal: async (draft: { activityId: string }) => {
            await db().activityParticipationIdentity.updateMany({
              where: { activityId: draft.activityId, populationIncluded: true },
              data: { populationIncluded: false },
            });
          },
        },
        expected: { evaluations: 0, sources: 0, seconds: 0, days: [] },
      },
    ]) {
      const source = await createE4Source(fixture, options);
      expectations.set(source.activityId, expected);
      const prepared = await prepareE4Time(fixture, source);
      await submitE4Time(fixture, source, prepared);
    }
    roots = await db().activitySettlementContributionRevision.findMany({
      orderBy: { revision: 'asc' },
    });
    expect(roots.length).toBe(6);
    if (!/^e4_assert_oracle_[a-f0-9]{16}$/u.test(namespace))
      throw new Error('E4 oracle namespace refused');
    await db().$executeRawUnsafe('CREATE SCHEMA ' + namespace);
    installed = true;
    await db().$executeRawUnsafe(frozenAssertion());
    await db().$executeRawUnsafe(
      'CREATE FUNCTION ' +
        namespace +
        `.outcome(root_id text, original boolean, validate_version boolean) RETURNS TABLE(state text,guard text)
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $body$
      DECLARE actual_state text; actual_guard text;
      BEGIN
        IF original THEN PERFORM ` +
        namespace +
        `.original142(root_id,validate_version);
        ELSE PERFORM public.e4_assert_complete(root_id,validate_version); END IF;
        RETURN QUERY SELECT '00000'::text,'NONE'::text;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,actual_guard=CONSTRAINT_NAME;
        IF actual_state='P0002' THEN RETURN QUERY SELECT 'P0002'::text,'NONE'::text;
        ELSIF actual_state='23514' AND actual_guard IN ('e4_source_guard','e4_evaluation_guard','e4_complete_guard','e4_version_guard','e4_result_guard','e4_selection_guard','e4_policy_guard','e4_copy_guard','e4_correction_guard')
          THEN RETURN QUERY SELECT actual_state,actual_guard;
        ELSE RAISE EXCEPTION 'E4 assertion unexpected error category'; END IF;
      END $body$;`,
    );
  }, 120_000);
  afterAll(async () => {
    try {
      if (installed && fixture)
        await fixture.db.$executeRawUnsafe('DROP SCHEMA ' + namespace + ' CASCADE');
    } finally {
      try {
        await closeE13Fixture(fixture);
      } finally {
        if (priorGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
        else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = priorGate;
      }
    }
  });

  it('preserves every business row and catalog identity on nonempty142 to143 and no-op with frozen root/day/source oracle', async () => {
    const beforeMigrations = await migrationRows(db());
    expect(beforeMigrations).toHaveLength(142);
    expect(beforeMigrations[141].name).toBe(E4_MIGRATION_142);
    const beforeCatalog = await catalog(db());
    const beforeTarget = await catalogTargetSignature(db());
    const beforeBusiness = await businessSnapshot(db());
    for (const root of roots) {
      expect(await outcome(db(), root.id)).toEqual({ state: '00000', guard: 'NONE' });
      await oracle(db(), root.id);
    }
    const baselineAfterOracleCatalog = await catalog(db());
    const baselineAfterOracleTarget = await catalogTargetSignature(db());
    emitCatalogDiagnostic(
      beforeCatalog,
      baselineAfterOracleCatalog,
      'BASELINE_ORACLE',
      beforeTarget,
      baselineAfterOracleTarget,
    );
    owner.deployLatestMigrations();
    const afterMigrations = await migrationRows(db());
    expect(afterMigrations).toHaveLength(143);
    expect(JSON.stringify(afterMigrations.slice(0, 142)) === JSON.stringify(beforeMigrations)).toBe(
      true,
    );
    expect(afterMigrations[142]).toEqual({ name: E4_MIGRATION_143, checksum: candidateSha });
    const candidate = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_143, 'migration.sql'),
      'utf8',
    );
    expect(createHash('sha256').update(candidate).digest('hex')).toBe(candidateSha);
    const [installedBody] = await db().$queryRaw<
      { pin: string; body: string }[]
    >`SELECT md5(prosrc) AS pin,prosrc AS body FROM pg_proc WHERE oid='public.e4_assert_complete(text,boolean)'::regprocedure`;
    expect(installedBody.pin).toBe(newPin);
    expect(installedBody.body === candidate.split('$$')[1]).toBe(true);
    upgraded143 = true;
    console.info(
      'E4_ASSERT143_INSTALLED',
      JSON.stringify({
        migrations: afterMigrations.length,
        migration: afterMigrations[142].name,
        checksum: candidateSha,
        bodyPin: installedBody.pin,
      }),
    );
    const afterCatalog = await catalog(db());
    const afterTarget = await catalogTargetSignature(db());
    emitCatalogDiagnostic(
      baselineAfterOracleCatalog,
      afterCatalog,
      'UPGRADE',
      baselineAfterOracleTarget,
      afterTarget,
    );
    expect(afterCatalog === beforeCatalog).toBe(true);
    expect((await businessSnapshot(db())) === beforeBusiness).toBe(true);
    for (const root of roots) {
      expect(await outcome(db(), root.id)).toEqual(await outcome(db(), root.id, true));
      await oracle(db(), root.id);
    }
    const afterOracleCatalog = await catalog(db());
    const afterOracleTarget = await catalogTargetSignature(db());
    emitCatalogDiagnostic(
      afterCatalog,
      afterOracleCatalog,
      'CANDIDATE_ORACLE',
      afterTarget,
      afterOracleTarget,
    );
    owner.deployLatestMigrations();
    expect(JSON.stringify(await migrationRows(db())) === JSON.stringify(afterMigrations)).toBe(
      true,
    );
    const noopCatalog = await catalog(db());
    emitCatalogDiagnostic(
      afterOracleCatalog,
      noopCatalog,
      'NOOP',
      afterOracleTarget,
      await catalogTargetSignature(db()),
    );
    expect(noopCatalog === beforeCatalog).toBe(true);
    expect((await businessSnapshot(db())) === beforeBusiness).toBe(true);
    console.info(
      'E4_ASSERT143_NONEMPTY_UPGRADE',
      JSON.stringify({
        from: 142,
        to: 143,
        historicalChecksums: 142,
        roots: roots.length,
        businessUnchanged: true,
        catalogUnchanged: true,
        frozenOracle: true,
        noop: true,
      }),
    );
  }, 120_000);

  it('retains native source before evaluation before root error precedence with exact old/new SQLSTATE and rollback', async () => {
    await require143();
    const empty = roots.find((root) => root.kindCode === 'draft' && root.evaluationCount === 0)!;
    const nonempty = roots.find((root) => root.kindCode === 'draft' && root.evaluationCount > 0)!;
    const cases = [
      { root: empty, mutation: { evaluationCount: 1 }, guard: 'e4_complete_guard' },
      { root: empty, mutation: { draftContentHash: '0'.repeat(64) }, guard: 'e4_source_guard' },
      {
        root: empty,
        mutation: { draftContentHash: '0'.repeat(64), evaluationCount: 1 },
        guard: 'e4_source_guard',
      },
      { root: nonempty, mutation: {}, guard: 'e4_evaluation_guard' },
      { root: nonempty, mutation: { evaluationCount: 99 }, guard: 'e4_evaluation_guard' },
      {
        root: nonempty,
        mutation: { draftContentHash: '0'.repeat(64), evaluationCount: 99 },
        guard: 'e4_source_guard',
      },
    ];
    const before = await businessSnapshot(db());
    for (const testcase of cases) {
      await expect(
        db().$transaction(async (tx) => {
          const root = await tx.activitySettlementContributionRevision.create({
            data: {
              ...rootData(
                testcase.root,
                testcase.root.revision + 10,
                fixture!.key('source_reuse_negative'),
              ),
              ...testcase.mutation,
            },
          });
          const expected = { state: '23514', guard: testcase.guard };
          expect(await outcome(tx, root.id, true)).toEqual(expected);
          expect(await outcome(tx, root.id)).toEqual(expected);
          throw rollback;
        }, guardTransactionOptions),
      ).rejects.toBe(rollback);
      expect((await businessSnapshot(db())) === before).toBe(true);
    }
  }, 120_000);

  it('keeps the independent final version/result check after valid sources and evaluations', async () => {
    await require143();
    const root = roots.find((row) => row.kindCode === 'submitted' && row.evaluationCount > 0)!;
    const before = await businessSnapshot(db());
    await expect(
      db().$transaction(async (tx) => {
        await tx.attendanceSettlementVersion.update({
          where: { id: root.settlementVersionId },
          data: { sessionParticipationCount: { increment: 1 } },
        });
        expect(await outcome(tx, root.id, true, false)).toEqual({ state: '00000', guard: 'NONE' });
        expect(await outcome(tx, root.id, false, false)).toEqual({ state: '00000', guard: 'NONE' });
        expect(await outcome(tx, root.id, true)).toEqual({
          state: '23514',
          guard: 'e4_result_guard',
        });
        expect(await outcome(tx, root.id)).toEqual({ state: '23514', guard: 'e4_result_guard' });
        throw rollback;
      }, guardTransactionOptions),
    ).rejects.toBe(rollback);
    expect((await businessSnapshot(db())) === before).toBe(true);
  });

  it('rejects unresolved sources before evaluation/day construction in private SQL fault fixtures', async () => {
    await require143();
    const root = roots.find((row) => row.kindCode === 'draft' && row.evaluationCount > 0)!;
    // No production function, trigger, index or constraint is changed. Private copies
    // inject one NULL source field and a failing day constructor to exercise the
    // otherwise unreachable double fault without weakening earlier database guards.
    await db().$executeRawUnsafe(
      'CREATE FUNCTION ' +
        namespace +
        `.invalid_sources(revision_id text)
      RETURNS TABLE(identity_id text,member_id text,session_id text,snapshot_id text,item_id text,
        policy_id text,policy_version_id text,definition_hash text,evaluator_version integer,
        role_code text,category_code text,source_ref jsonb)
      LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $body$
      SELECT identity_id,NULL::text,session_id,snapshot_id,item_id,policy_id,policy_version_id,
        definition_hash,evaluator_version,role_code,category_code,source_ref
      FROM public.e4_source_rows(revision_id) $body$;`,
    );
    await db().$executeRawUnsafe(
      'CREATE FUNCTION ' +
        namespace +
        `.failing_days(refs jsonb,hundredths integer)
      RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $body$
      BEGIN RAISE EXCEPTION 'E4 private unexpected day construction'; END $body$;`,
    );
    const expectedSql = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_140, 'migration.sql'),
      'utf8',
    );
    const expectedDefinitions = [
      ...expectedSql.matchAll(/CREATE OR REPLACE FUNCTION e4_expected_evaluations\([^]*?\$\$;/gu),
    ];
    expect(expectedDefinitions).toHaveLength(1);
    await db().$executeRawUnsafe(
      expectedDefinitions[0][0]
        .replace(
          'CREATE OR REPLACE FUNCTION e4_expected_evaluations(',
          'CREATE FUNCTION ' + namespace + '.invalid_expected(',
        )
        .replaceAll('e4_source_rows(', namespace + '.invalid_sources(')
        .replaceAll('e4_day_points(', namespace + '.failing_days('),
    );
    await db().$executeRawUnsafe(
      frozenAssertion()
        .replace(namespace + '.original142(', namespace + '.invalid142(')
        .replaceAll('e4_source_rows(', namespace + '.invalid_sources(')
        .replaceAll('e4_expected_evaluations(', namespace + '.invalid_expected('),
    );
    const candidate = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_MIGRATION_143, 'migration.sql'),
      'utf8',
    );
    const definition = [
      ...candidate.matchAll(/CREATE OR REPLACE FUNCTION e4_assert_complete\([^]*?\$\$;/gu),
    ];
    expect(definition).toHaveLength(1);
    await db().$executeRawUnsafe(
      definition[0][0]
        .replace(
          'CREATE OR REPLACE FUNCTION e4_assert_complete(',
          'CREATE FUNCTION ' + namespace + '.invalid143(',
        )
        .replaceAll('e4_source_rows(', namespace + '.invalid_sources(')
        .replaceAll('e4_day_points(', namespace + '.failing_days('),
    );
    await db().$executeRawUnsafe(
      'CREATE FUNCTION ' +
        namespace +
        `.invalid_priority(revision_id text) RETURNS boolean
      LANGUAGE plpgsql SECURITY INVOKER AS $body$
      DECLARE actual_state text; actual_guard text; day_failed boolean := false;
      BEGIN
        BEGIN PERFORM * FROM ` +
        namespace +
        `.invalid_expected(revision_id);
        EXCEPTION WHEN OTHERS THEN
          IF SQLERRM IS DISTINCT FROM 'E4 private unexpected day construction' THEN
            RAISE EXCEPTION 'E4 private day fault fixture mismatch';
          END IF;
          day_failed := true;
        END;
        IF NOT day_failed THEN RAISE EXCEPTION 'E4 private day fault fixture did not execute'; END IF;
        BEGIN PERFORM ` +
        namespace +
        `.invalid142(revision_id);
          RAISE EXCEPTION 'E4 private unresolved source accepted';
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,actual_guard=CONSTRAINT_NAME;
          IF actual_state IS DISTINCT FROM '23514' OR actual_guard IS DISTINCT FROM 'e4_source_guard' THEN
            RAISE EXCEPTION 'E4 private old unresolved source priority mismatch';
          END IF;
        END;
        BEGIN PERFORM ` +
        namespace +
        `.invalid143(revision_id);
          RAISE EXCEPTION 'E4 private unresolved source accepted';
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,actual_guard=CONSTRAINT_NAME;
          IF actual_state IS DISTINCT FROM '23514' OR actual_guard IS DISTINCT FROM 'e4_source_guard' THEN
            RAISE EXCEPTION 'E4 private new unresolved source priority mismatch';
          END IF;
        END;
        RETURN true;
      END $body$;`,
    );
    const [result] = await db().$queryRawUnsafe<{ matches: boolean }[]>(
      'SELECT ' + namespace + '.invalid_priority($1) AS matches',
      root.id,
    );
    expect(result.matches).toBe(true);
  });

  it('keeps INSERT and deferred checks independent and rolls back the whole transaction on a later incomplete root', async () => {
    await require143();
    const template = roots.find((row) => row.kindCode === 'draft' && row.evaluationCount > 0)!;
    const evaluations = await db().participantContributionEvaluation.findMany({
      where: { contributionRevisionId: template.id },
    });
    const observer = new PrismaClient();
    try {
      await assertConnectedTestDatabase(observer);
      const before = await businessSnapshot(observer);
      let statementPassed = false;
      let incompleteGuard: Outcome | undefined;
      let commitError: unknown;
      let callbackReturned = false;
      try {
        await db().$transaction(async (tx) => {
          const root = await tx.activitySettlementContributionRevision.create({
            data: rootData(template, template.revision + 10, fixture!.key('source_reuse_insert')),
          });
          await tx.participantContributionEvaluation.createMany({
            data: evaluations.map((evaluation) => ({
              ...withoutIdentity(evaluation),
              contributionRevisionId: root.id,
              sourceRefsJson: evaluation.sourceRefsJson as Prisma.InputJsonValue,
              beijingDayPointsJson: evaluation.beijingDayPointsJson as Prisma.InputJsonValue,
            })),
          });
          statementPassed = true;
          expect(await outcome(tx, root.id)).toEqual({ state: '00000', guard: 'NONE' });
          const incomplete = await tx.activitySettlementContributionRevision.create({
            data: rootData(template, template.revision + 11, fixture!.key('source_reuse_deferred')),
          });
          // This catches the original SQLSTATE and constraint for this same root.
          // It leaves the unchanged queued deferred trigger to reject actual COMMIT.
          incompleteGuard = await outcome(tx, incomplete.id);
          // No explicit SET: the unchanged native deferred trigger must reject COMMIT.
          callbackReturned = true;
        }, guardTransactionOptions);
      } catch (error) {
        commitError = error;
      }
      // Read on the independent client before error assertions, including on an
      // unexpected wrapper/failure, so a mismatch never hides rollback evidence.
      const rolledBack = (await businessSnapshot(observer)) === before;
      console.info('E4_ASSERT143_DEFERRED_ROLLBACK', JSON.stringify({ rolledBack }));
      console.info(
        'E4_ASSERT143_COMMIT_ERROR',
        JSON.stringify({
          callbackReturned,
          rolledBack,
          statementPassed,
          incompleteGuard,
          parsedCommitError: deferredEvaluationErrorEvidence(commitError),
          actualError: deferredErrorDiagnostic(commitError),
        }),
      );
      expect(rolledBack).toBe(true);
      expect(statementPassed).toBe(true);
      expect(incompleteGuard).toEqual({ state: '23514', guard: 'e4_evaluation_guard' });
      expect(deferredEvaluationErrorEvidence(commitError)).toEqual({
        unknownRequest: true,
        sqlstate: '23514',
        evaluationGuardMessage: true,
      });
    } finally {
      await observer.$disconnect();
    }
  });

  it('uses a real statement snapshot across an observed two-backend commit and reads fresh sources on the next invocation', async () => {
    await require143();
    const observer = new PrismaClient();
    const template = roots.find((row) => row.kindCode === 'draft' && row.evaluationCount > 0)!;
    const evaluations = await db().participantContributionEvaluation.findMany({
      where: { contributionRevisionId: template.id },
    });
    const lockKey = randomBytes(4).readInt32BE();
    const rootId = fixture!.key('source_reuse_visibility');
    let started!: (pid: number) => void;
    let rejectStarted!: (error: unknown) => void;
    let release!: () => void;
    const ready = new Promise<number>((resolve, reject) => {
      started = resolve;
      rejectStarted = reject;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writer: Promise<unknown> | undefined;
    let reader: Promise<{ before: number; after: number }[]> | undefined;
    try {
      await assertConnectedTestDatabase(observer);
      writer = db().$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lockKey}::bigint)::text`;
          await tx.activitySettlementContributionRevision.create({
            data: {
              ...rootData(template, template.revision + 20, fixture!.key('source_reuse_committed')),
              id: rootId,
            },
          });
          await tx.participantContributionEvaluation.createMany({
            data: evaluations.map((evaluation) => ({
              ...withoutIdentity(evaluation),
              contributionRevisionId: rootId,
              sourceRefsJson: evaluation.sourceRefsJson as Prisma.InputJsonValue,
              beijingDayPointsJson: evaluation.beijingDayPointsJson as Prisma.InputJsonValue,
            })),
          });
          started(pid);
          await gate;
        },
        { timeout: 20_000 },
      );
      void writer.catch(rejectStarted);
      const writerPid = await ready;
      expect(await outcome(observer, rootId)).toEqual({ state: 'P0002', guard: 'NONE' });
      reader = observer.$queryRaw<{ before: number; after: number }[]>`
        WITH before_read AS MATERIALIZED (SELECT count(*)::int AS n FROM public.e4_source_rows(${rootId})),
        barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock(${lockKey}::bigint)::text FROM before_read)
        SELECT b.n AS before,(SELECT count(*)::int FROM public.e4_source_rows(${rootId})) AS after FROM before_read b CROSS JOIN barrier
      `.then((rows) => rows);
      void reader.catch(() => undefined);
      // Observe the actual advisory waiter in this database before permitting COMMIT.
      const deadline = Date.now() + 5_000;
      let waited = false;
      while (Date.now() < deadline) {
        const [row] = await db().$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND ${writerPid} = ANY(pg_blocking_pids(pid))) AS waiting
        `;
        if (row.waiting) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waited).toBe(true);
      release();
      await writer;
      expect(await reader).toEqual([{ before: 0, after: 0 }]);
      const [fresh] = await observer.$queryRaw<
        { sources: number }[]
      >`SELECT count(*)::int AS sources FROM public.e4_source_rows(${rootId})`;
      expect(fresh.sources).toBeGreaterThan(0);
      expect(await outcome(observer, rootId)).toEqual({ state: '00000', guard: 'NONE' });
      expect(await outcome(observer, rootId, true)).toEqual({ state: '00000', guard: 'NONE' });
      await oracle(observer, rootId);
      console.info(
        'E4_ASSERT143_SNAPSHOT',
        JSON.stringify({
          observedWait: true,
          statementBefore: 0,
          statementAfter: 0,
          nextInvocationFresh: true,
          committed: true,
        }),
      );
    } finally {
      release?.();
      await Promise.allSettled([writer, reader]);
      await observer.$disconnect();
    }
  }, 30_000);

  it('runs real prepare and submit after143 with native guards and the independent frozen oracle', async () => {
    await require143();
    const source = await createE4Source(fixture!);
    expectations.set(source.activityId, singleSourceExpectation);
    const prepared = await prepareE4Time(fixture!, source);
    await submitE4Time(fixture!, source, prepared);
    const current = await db().activitySettlementContributionRevision.findMany({
      where: { activityId: source.activityId },
    });
    expect(current).toHaveLength(2);
    for (const root of current) {
      expect(await outcome(db(), root.id)).toEqual(await outcome(db(), root.id, true));
      await oracle(db(), root.id);
    }
  }, 120_000);
});

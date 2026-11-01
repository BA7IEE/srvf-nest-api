import * as ts from 'typescript';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { literalSql, rawSqlDisposition } from '../../scripts/check-boundaries';
import { isReadOnlyCatalogSql } from '../../scripts/check-catalog-sql-proof';

describe('static SQL proof refuses unknown structure and preserves raw enforcement', () => {
  const root = mkdtempSync(join(tmpdir(), 'r5-static-sql-'));
  const fixture = join(root, 'input.ts');
  const files = [
    'src/modules/activities/human-correction-http-providers.ts',
    'src/modules/activities/human-correction-item-authority.ts',
    'src/modules/activities/human-correction-trusted-connection.ts',
  ].map((file) => resolve(file));
  let program: ts.Program;
  beforeAll(() => {
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    writeFileSync(
      join(root, 'constant.ts'),
      'export const TEXT = String.raw`SELECT 1 FROM "Member" WHERE id=\\n`;',
    );
    writeFileSync(
      fixture,
      `import {Prisma} from '@prisma/client';
      import {TEXT as ALIAS} from './constant';
      declare const runtimeText:string;
      const fixed=String.raw\`SELECT 1 FROM "Member"\`;
      let mutable='SELECT 1';
      const stored=Prisma.sql\`SELECT 1\`;
      stored.strings[0]='DELETE FROM "Member"';
      const calls=[Prisma.raw(ALIAS),Prisma.raw(fixed),Prisma.raw(runtimeText),Prisma.raw(mutable),stored,
        Prisma.raw(String.raw\`SELECT \${runtimeText}\`),Prisma.sql\`SELECT \${Prisma.raw(runtimeText)} FROM pg_catalog.pg_class\`];
      function fake(){const Prisma={raw:(x:string)=>x};return Prisma.raw(fixed)}
      const fakeNamespace:typeof Prisma={...Prisma,sql:()=>Prisma.raw('DELETE FROM "Member"')};
      const forged=fakeNamespace.sql\`SELECT 1 FROM pg_catalog.pg_class\`;
      const cycleA=cycleB;const cycleB=cycleA;const cycle=Prisma.raw(cycleA);`,
    );
    program = ts.createProgram([fixture, ...files], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      experimentalDecorators: true,
      esModuleInterop: true,
      skipLibCheck: true,
    });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('proves all five actual metadata queries without mistaking column names or filter values for table access', () => {
    const proved: string[] = [];
    for (const file of files) {
      const visit = (node: ts.Node) => {
        let argument: ts.Expression | undefined;
        if (
          ts.isTaggedTemplateExpression(node) &&
          ts.isPropertyAccessExpression(node.tag) &&
          node.tag.name.text === '$queryRaw'
        )
          argument = node;
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === '$queryRaw'
        )
          argument = node.arguments[0];
        if (argument) {
          const sql = literalSql(argument, program.getTypeChecker());
          if (sql?.catalogProofEligible && isReadOnlyCatalogSql(sql.text)) proved.push(sql.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(program.getSourceFile(file)!);
    }
    expect(proved).toHaveLength(5);
    expect(proved.filter((sql) => sql.includes('WITH relations AS'))).toHaveLength(2);
    expect(proved.filter((sql) => sql.includes('pg_auth_members'))).toHaveLength(3);
    for (const sql of proved) {
      expect(isReadOnlyCatalogSql(sql + '; DELETE FROM "Member"')).toBe(false);
      expect(
        isReadOnlyCatalogSql(sql.replace(/FROM pg_catalog\.pg_[a-z_]+/u, 'FROM public."Member"')),
      ).toBe(false);
    }
  });

  it('resolves only primitive fixed strings through real imports and Prisma.raw, preserving raw escapes', () => {
    const expressions: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'calls' &&
        node.initializer &&
        ts.isArrayLiteralExpression(node.initializer)
      )
        expressions.push(...node.initializer.elements);
      ts.forEachChild(node, visit);
    };
    visit(program.getSourceFile(fixture)!);
    const result = expressions.map((node) => literalSql(node, program.getTypeChecker()));
    expect(result[0]?.text).toBe('SELECT 1 FROM "Member" WHERE id=\\n');
    expect(result[1]?.text).toBe('SELECT 1 FROM "Member"');
    expect(result.slice(2, 6)).toEqual([null, null, null, null]);
    expect(result[6]?.catalogProofEligible).toBe(false);
    expect(rawSqlDisposition(result[6])).toBe('dynamic');
    let forged: ts.Expression | undefined;
    const findForged = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'forged'
      )
        forged = node.initializer;
      ts.forEachChild(node, findForged);
    };
    findForged(program.getSourceFile(fixture)!);
    const forgedSql = literalSql(forged!, program.getTypeChecker());
    expect(forgedSql?.catalogProofEligible).toBe(false);
    expect(rawSqlDisposition(forgedSql)).toBe('dynamic');
    const rejected: ts.Expression[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && node.expression) rejected.push(node.expression);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'cycle' &&
        node.initializer
      )
        rejected.push(node.initializer);
      ts.forEachChild(node, walk);
    };
    walk(program.getSourceFile(fixture)!);
    expect(rejected.map((node) => literalSql(node, program.getTypeChecker()))).toEqual([
      null,
      null,
    ]);
  });

  it.each([
    'SELECT 1 FROM pg_catalog.pg_class c JOIN "Member" m ON true',
    'SELECT 1 FROM pg_catalog.pg_class c, attachments a',
    'WITH changed AS (DELETE FROM "Member" RETURNING id) SELECT * FROM pg_catalog.pg_class',
    "SELECT query_to_xml('DELETE FROM \"Member\" RETURNING id',true,false,'')",
    'SELECT pg_catalog.pg_advisory_lock(1)',
    'SELECT public.count(*) FROM pg_catalog.pg_class',
    'SELECT public."count"(*) FROM pg_catalog.pg_class',
    'SELECT 1::public.custom_type FROM pg_catalog.pg_class',
    'SELECT EXISTS (TABLE public."Member") FROM pg_catalog.pg_class',
    'WITH first AS (SELECT * FROM roles), roles AS (SELECT * FROM pg_catalog.pg_class) SELECT * FROM first',
    'WITH roles AS (SELECT * FROM roles) SELECT * FROM roles',
    'WITH public AS (SELECT * FROM pg_catalog.pg_class) SELECT * FROM public."Member"',
    'SELECT public.values(1) FROM pg_catalog.pg_class',
    "SELECT custom_type 'input' FROM pg_catalog.pg_class",
    'SELECT public."custom_type" \'Member\' FROM pg_catalog.pg_class',
    'SELECT 1; UPDATE "Member" SET id=id',
    'DO $$BEGIN DELETE FROM "Member"; END$$',
    'SELECT 1 FROM pg_catalog.pg_class /* unfinished',
  ])('retains enforcement for writes, unknown functions and non-catalog sources: %s', (sql) => {
    expect(isReadOnlyCatalogSql(sql)).toBe(false);
  });
});

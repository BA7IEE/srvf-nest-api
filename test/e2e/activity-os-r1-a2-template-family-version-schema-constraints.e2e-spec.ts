import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Activity OS Release 1 / A2：TemplateFamily 稳定身份 + TemplateVersion expand。
// 合同：docs/archive/reviews/activity-os-r1-a2-template-family-version-review.md。
//
// 本 spec 只在真实 PostgreSQL 验证 A2 的存储边界：新表、可空扩展列、两条 FK 与两条
// unique。它刻意不测试 canonical JSON、hash、有效期边界或 lifecycle——这些语义尚未
// 被拍板，属于 A3；也不触碰旧模板解析路径、endpoint、DTO 或 service。
//
// 拒绝用例都配套合法正对照，防止「恒拒」制造假绿。原生 SQL 的 PG 错误由 Prisma
// 包为 P2010，SQLSTATE 位于 meta.code。

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

type TemplateOptions = {
  code?: string;
  version?: number;
  familyId?: string | null;
  schemaVersion?: number | null;
  definitionJson?: string | null;
  definitionHash?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};

type FamilyOptions = {
  code?: string;
  ownerOrganizationId?: string | null;
  statusCode?: string;
};

describe('Activity OS R1 A2 TemplateFamily / TemplateVersion schema 约束', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let seq = 0;

  const fixtureTimestamp = "'2099-09-01T09:00:00.000Z'::timestamp";
  const uniq = (label: string) => 'activity-os-r1-a2-' + label + '-' + (seq += 1);
  const sqlText = (value: string | null) =>
    value === null ? 'NULL' : "'" + value.replace(/'/g, "''") + "'";
  const sqlInt = (value: number | null) => (value === null ? 'NULL' : String(value));
  const sqlJson = (value: string | null) =>
    value === null ? 'NULL' : "'" + value.replace(/'/g, "''") + "'::jsonb";
  const sqlTimestamp = (value: string | null) =>
    value === null ? 'NULL' : "'" + value.replace(/'/g, "''") + "'::timestamp";

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function run(sql: string): Promise<RawDbError | null> {
    try {
      await prisma.$executeRawUnsafe(sql);
      return null;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
        const meta = err.meta as { code?: string; message?: string } | undefined;
        const message = meta?.message ?? '';
        const matched = /constraint "([^"]+)"/.exec(message);
        return { sqlState: meta?.code ?? '', constraint: matched?.[1] ?? '', message };
      }
      throw err;
    }
  }

  async function expectAccepted(sql: string): Promise<void> {
    expect(await run(sql)).toBeNull();
  }

  async function expectRejected(
    sql: string,
    expected: { sqlState: string; constraint?: string },
  ): Promise<RawDbError> {
    const err = await run(sql);
    expect(err).not.toBeNull();
    expect(err!.sqlState).toBe(expected.sqlState);
    if (expected.constraint !== undefined) expect(err!.constraint).toBe(expected.constraint);
    return err!;
  }

  const familySql = (id: string, options: FamilyOptions = {}) => {
    const value = {
      code: 'family-' + id,
      ownerOrganizationId: organizationId as string | null,
      statusCode: 'unclassified-a2',
      ...options,
    };
    return [
      'INSERT INTO "ActivityTemplateFamily"',
      '("id","updatedAt","code","name","categoryCode","ownerOrganizationId","scopeTypeCode","statusCode")',
      'VALUES (' +
        sqlText(id) +
        ', ' +
        fixtureTimestamp +
        ', ' +
        sqlText(value.code) +
        ', ' +
        sqlText('Family ' + id) +
        ', ' +
        sqlText('volunteer') +
        ', ' +
        sqlText(value.ownerOrganizationId) +
        ', ' +
        sqlText('organization') +
        ', ' +
        sqlText(value.statusCode) +
        ')',
    ].join(' ');
  };

  const templateSql = (id: string, options: TemplateOptions = {}) => {
    const value = {
      code: 'template-' + id,
      version: 1,
      familyId: null as string | null,
      schemaVersion: null as number | null,
      definitionJson: null as string | null,
      definitionHash: null as string | null,
      effectiveFrom: null as string | null,
      effectiveTo: null as string | null,
      ...options,
    };
    return [
      'INSERT INTO "ActivityTemplate"',
      '("id","updatedAt","code","name","activityTypeCode","statusCode","version","familyId",',
      '"schemaVersion","definitionJson","definitionHash","effectiveFrom","effectiveTo")',
      'VALUES (' +
        sqlText(id) +
        ', ' +
        fixtureTimestamp +
        ', ' +
        sqlText(value.code) +
        ', ' +
        sqlText('Template ' + id) +
        ', ' +
        sqlText('legacy-activity-type') +
        ', ' +
        sqlText('legacy-status') +
        ', ' +
        value.version +
        ', ' +
        sqlText(value.familyId) +
        ', ' +
        sqlInt(value.schemaVersion) +
        ', ' +
        sqlJson(value.definitionJson) +
        ', ' +
        sqlText(value.definitionHash) +
        ', ' +
        sqlTimestamp(value.effectiveFrom) +
        ', ' +
        sqlTimestamp(value.effectiveTo) +
        ')',
    ].join(' ');
  };

  beforeEach(async () => {
    await resetDb(app);
    // resetDb 会清掉有 Organization FK 的 Family；legacy Template 可没有 familyId，
    // 因而本 spec 只清自己的原表，避免跨 it 的 legacy fixture 残留。
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ActivityTemplate" RESTART IDENTITY CASCADE');
    organizationId = (
      await prisma.organization.create({
        data: { name: uniq('org'), nodeTypeCode: 'team' },
        select: { id: true },
      })
    ).id;
  });

  it('精确提供 Family 与 Version expand 列形状，新增 Version 列均可空', async () => {
    const columns = await prisma.$queryRawUnsafe<
      Array<{
        tableName: string;
        columnName: string;
        isNullable: string;
        dataType: string;
        udtName: string;
      }>
    >(
      'SELECT table_name AS "tableName", column_name AS "columnName", ' +
        'is_nullable AS "isNullable", data_type AS "dataType", udt_name AS "udtName" ' +
        "FROM information_schema.columns WHERE table_schema = 'public' AND " +
        "((table_name = 'ActivityTemplateFamily' AND column_name = ANY(ARRAY[" +
        "'id','createdAt','updatedAt','code','name','categoryCode','ownerOrganizationId'," +
        "'scopeTypeCode','statusCode']::text[])) OR " +
        "(table_name = 'ActivityTemplate' AND column_name = ANY(ARRAY[" +
        "'familyId','schemaVersion','definitionJson','definitionHash','effectiveFrom','effectiveTo']::text[])))",
    );

    const byColumn = Object.fromEntries(
      columns.map((row) => [
        row.tableName + '.' + row.columnName,
        { nullable: row.isNullable, dataType: row.dataType, udtName: row.udtName },
      ]),
    );
    expect(columns).toHaveLength(15);
    expect(byColumn).toMatchObject({
      'ActivityTemplateFamily.id': { nullable: 'NO', dataType: 'text', udtName: 'text' },
      'ActivityTemplateFamily.createdAt': {
        nullable: 'NO',
        dataType: 'timestamp without time zone',
        udtName: 'timestamp',
      },
      'ActivityTemplateFamily.updatedAt': {
        nullable: 'NO',
        dataType: 'timestamp without time zone',
        udtName: 'timestamp',
      },
      'ActivityTemplateFamily.code': { nullable: 'NO', dataType: 'text', udtName: 'text' },
      'ActivityTemplateFamily.name': { nullable: 'NO', dataType: 'text', udtName: 'text' },
      'ActivityTemplateFamily.categoryCode': {
        nullable: 'NO',
        dataType: 'text',
        udtName: 'text',
      },
      'ActivityTemplateFamily.ownerOrganizationId': {
        nullable: 'YES',
        dataType: 'text',
        udtName: 'text',
      },
      'ActivityTemplateFamily.scopeTypeCode': {
        nullable: 'NO',
        dataType: 'text',
        udtName: 'text',
      },
      'ActivityTemplateFamily.statusCode': {
        nullable: 'NO',
        dataType: 'text',
        udtName: 'text',
      },
      'ActivityTemplate.familyId': { nullable: 'YES', dataType: 'text', udtName: 'text' },
      'ActivityTemplate.schemaVersion': {
        nullable: 'YES',
        dataType: 'integer',
        udtName: 'int4',
      },
      'ActivityTemplate.definitionJson': {
        nullable: 'YES',
        dataType: 'jsonb',
        udtName: 'jsonb',
      },
      'ActivityTemplate.definitionHash': {
        nullable: 'YES',
        dataType: 'text',
        udtName: 'text',
      },
      'ActivityTemplate.effectiveFrom': {
        nullable: 'YES',
        dataType: 'timestamp without time zone',
        udtName: 'timestamp',
      },
      'ActivityTemplate.effectiveTo': {
        nullable: 'YES',
        dataType: 'timestamp without time zone',
        udtName: 'timestamp',
      },
    });
  });

  it('既有 Template 形状仍可插入，新增 Family / Version 元数据全部为 NULL', async () => {
    await expectAccepted(templateSql('legacy-row'));

    const rows = await prisma.$queryRawUnsafe<
      Array<{
        familyId: string | null;
        schemaVersion: number | null;
        definitionJson: unknown;
        definitionHash: string | null;
        effectiveFrom: Date | null;
        effectiveTo: Date | null;
      }>
    >(
      'SELECT "familyId", "schemaVersion", "definitionJson", "definitionHash", ' +
        '"effectiveFrom", "effectiveTo" FROM "ActivityTemplate" WHERE id = \'legacy-row\'',
    );
    expect(rows).toEqual([
      {
        familyId: null,
        schemaVersion: null,
        definitionJson: null,
        definitionHash: null,
        effectiveFrom: null,
        effectiveTo: null,
      },
    ]);
  });

  it('Family 保留归属 FK 与 code 唯一性，但不擅自冻结 status 闭集', async () => {
    await expectAccepted(familySql('valid-family'));
    await expectAccepted(
      familySql('future-status', { statusCode: 'unreviewed-a2-lifecycle-placeholder' }),
    );

    await expectRejected(
      familySql('bad-owner', { ownerOrganizationId: 'organization-does-not-exist' }),
      {
        sqlState: '23503',
        constraint: 'ActivityTemplateFamily_ownerOrganizationId_fkey',
      },
    );

    await expectRejected(familySql('duplicate-code', { code: 'family-valid-family' }), {
      sqlState: '23505',
    });
  });

  it('Version 只能指向存在的 Family，且同 Family 的 version 不可重复', async () => {
    await expectAccepted(familySql('one'));
    await expectAccepted(familySql('two'));
    await expectAccepted(
      templateSql('one-v1', {
        familyId: 'one',
        version: 1,
        schemaVersion: 1,
        definitionJson: '{"kind":"a2-storage-only"}',
        definitionHash: 'opaque-a2-placeholder',
        effectiveFrom: '2099-09-01T00:00:00.000Z',
        effectiveTo: '2099-12-31T00:00:00.000Z',
      }),
    );

    await expectRejected(templateSql('one-v1-duplicate', { familyId: 'one', version: 1 }), {
      sqlState: '23505',
    });
    await expectAccepted(templateSql('two-v1', { familyId: 'two', version: 1 }));
    await expectRejected(
      templateSql('unknown-family', { familyId: 'family-does-not-exist', version: 1 }),
      { sqlState: '23503', constraint: 'ActivityTemplate_familyId_fkey' },
    );
  });

  it('两个 Restrict FK 都拒绝删除仍被引用的父行', async () => {
    await expectAccepted(familySql('owned-family'));
    await expectRejected('DELETE FROM "Organization" WHERE id = ' + sqlText(organizationId), {
      sqlState: '23503',
      constraint: 'ActivityTemplateFamily_ownerOrganizationId_fkey',
    });

    await expectAccepted(familySql('referenced-family'));
    await expectAccepted(templateSql('referenced-template', { familyId: 'referenced-family' }));
    await expectRejected(
      'DELETE FROM "ActivityTemplateFamily" WHERE id = ' + sqlText('referenced-family'),
      { sqlState: '23503', constraint: 'ActivityTemplate_familyId_fkey' },
    );
  });
});

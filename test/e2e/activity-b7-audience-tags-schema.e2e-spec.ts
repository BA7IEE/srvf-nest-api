import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

describe('activity B7 member audience-tag assignment schema', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sequence = 0;

  const unique = (label: string) => `activity-b7-audience-tags-${label}-${(sequence += 1)}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  async function execute(sql: string): Promise<RawDbError | null> {
    try {
      await prisma.$executeRawUnsafe(sql);
      return null;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
        const meta = error.meta as { code?: string; message?: string } | undefined;
        const message = meta?.message ?? '';
        const matched = /constraint "([^"]+)"/.exec(message);
        return {
          sqlState: meta?.code ?? '',
          constraint: matched?.[1] ?? '',
          message,
        };
      }
      throw error;
    }
  }

  it('installs the live-assignment table, partial uniqueness, RESTRICT FKs, and revocation history', async () => {
    const reviewAudienceTagColumn = await prisma.$queryRaw<
      Array<{ data_type: string; udt_name: string; is_nullable: string }>
    >`
      SELECT data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'activity_publish_reviews'
        AND column_name = 'audienceTagCodes'
    `;
    expect(reviewAudienceTagColumn).toEqual([
      { data_type: 'jsonb', udt_name: 'jsonb', is_nullable: 'YES' },
    ]);

    const columns = await prisma.$queryRaw<
      Array<{ column_name: string; is_nullable: string; column_default: string | null }>
    >`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'member_audience_tag_assignments'
      ORDER BY ordinal_position
    `;
    expect(columns.map((column) => column.column_name)).toEqual([
      'id',
      'memberId',
      'dictItemId',
      'assignedAt',
      'revokedAt',
    ]);
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: 'id', is_nullable: 'NO' }),
        expect.objectContaining({ column_name: 'memberId', is_nullable: 'NO' }),
        expect.objectContaining({ column_name: 'dictItemId', is_nullable: 'NO' }),
        expect.objectContaining({ column_name: 'assignedAt', is_nullable: 'NO' }),
        expect.objectContaining({ column_name: 'revokedAt', is_nullable: 'YES' }),
      ]),
    );

    const foreignKeys = await prisma.$queryRaw<
      Array<{ column_name: string; foreign_table_name: string; delete_rule: string }>
    >`
      SELECT kcu.column_name, ccu.table_name AS foreign_table_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_schema = kcu.constraint_schema
       AND tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_schema = tc.constraint_schema
       AND ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_schema = tc.constraint_schema
       AND rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_schema = current_schema()
        AND tc.table_name = 'member_audience_tag_assignments'
        AND tc.constraint_type = 'FOREIGN KEY'
      ORDER BY kcu.column_name
    `;
    expect(foreignKeys).toEqual([
      { column_name: 'dictItemId', foreign_table_name: 'DictItem', delete_rule: 'RESTRICT' },
      { column_name: 'memberId', foreign_table_name: 'Member', delete_rule: 'RESTRICT' },
    ]);

    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'member_audience_tag_assignments'
      ORDER BY indexname
    `;
    const liveUnique = indexes.find(
      (index) => index.indexname === 'member_audience_tag_assignments_live_member_item_key',
    );
    expect(liveUnique?.indexdef).toContain('UNIQUE INDEX');
    expect(liveUnique?.indexdef).toContain('("memberId", "dictItemId")');
    expect(liveUnique?.indexdef).toContain('WHERE ("revokedAt" IS NULL)');
    expect(indexes.map((index) => index.indexname)).toEqual(
      expect.arrayContaining([
        'member_audience_tag_assignments_member_live_idx',
        'member_audience_tag_assignments_item_live_idx',
      ]),
    );

    const type = await prisma.dictType.create({
      data: { code: unique('type'), label: 'B7 schema tag type' },
      select: { id: true },
    });
    const item = await prisma.dictItem.create({
      data: { typeId: type.id, code: unique('item'), label: 'B7 schema tag item' },
      select: { id: true },
    });
    const member = await prisma.member.create({
      data: { memberNo: unique('member'), displayName: 'B7 schema member' },
      select: { id: true },
    });
    const firstId = unique('assignment-first');
    const secondId = unique('assignment-second');

    expect(
      await execute(
        `INSERT INTO member_audience_tag_assignments ("id", "memberId", "dictItemId")
         VALUES ('${firstId}', '${member.id}', '${item.id}')`,
      ),
    ).toBeNull();
    const duplicate = await execute(
      `INSERT INTO member_audience_tag_assignments ("id", "memberId", "dictItemId")
       VALUES ('${secondId}', '${member.id}', '${item.id}')`,
    );
    expect(duplicate?.sqlState).toBe('23505');

    expect(
      await execute(
        `UPDATE member_audience_tag_assignments
         SET "revokedAt" = NOW()
         WHERE "id" = '${firstId}'`,
      ),
    ).toBeNull();
    expect(
      await execute(
        `INSERT INTO member_audience_tag_assignments ("id", "memberId", "dictItemId")
         VALUES ('${secondId}', '${member.id}', '${item.id}')`,
      ),
    ).toBeNull();

    const history = await prisma.$queryRaw<
      Array<{ id: string; revokedAt: Date | null; assignedAt: Date }>
    >`
      SELECT "id", "revokedAt", "assignedAt"
      FROM member_audience_tag_assignments
      WHERE "memberId" = ${member.id}
        AND "dictItemId" = ${item.id}
      ORDER BY "assignedAt", "id"
    `;
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.id === firstId)?.revokedAt).toBeInstanceOf(Date);
    expect(history.find((row) => row.id === secondId)?.revokedAt).toBeNull();
  });
});

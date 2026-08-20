import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

/**
 * issue #1055 T1 —— 队员标准照 / 账号头像指针的 **DB 约束** 用例。
 *
 * 为什么全部走 `$executeRawUnsafe` 直插:本刀是 expand 段,**还没有任何应用层写路径**
 * (Admin 上传在 T4、App 头像在 T3)。就算有,这里要证的也正是「绕过应用层照样挡得住」——
 * 存量导入脚本、修数 SQL、以后某个写错的 service 都是从这个方向进来的。
 *
 * ⚠️ 每条断言都钉到**具体是哪条约束**,不只是 SQLSTATE。只断 `23505` 的话,任何一条别的
 * 唯一约束先炸都会让用例变绿,而被测的那条可能根本没建上 —— DB 约束的静默失效形状里,
 * 「建在错列上」和「压根没建」都长这个样子。
 *
 * 但**两类错误只能用不同的判别器**,这是实测出来的,不是设计选择:
 *   - CHECK(23514)/ FK(23503):Prisma 的 `P2010 meta.message` 保留 PG 完整消息,
 *     里面有 `constraint "<名字>"` ⇒ 直接断名字。
 *   - UNIQUE(23505):`meta.message` **只剩 PG 的 `DETAIL:` 行**
 *     (`Key ("memberId", version)=(…) already exists.`),带约束名的主消息行被丢掉
 *     ⇒ 名字拿不到,改断**键列签名**。本表四条唯一约束的键列两两不同
 *     (`"memberId"` / `"memberId", version` / `"attachmentId"` / `"avatarAttachmentId"`),
 *     足以互相区分。
 *
 * 唯一一处键列签名区分不了的:one-active partial unique 与"假如它漏写了 WHERE"
 * 长得一样(都是 `Key ("memberId")`)。那一格由另外两条判据合起来钉死:
 * 结构用例断言 indexdef 里含 `WHERE (status = 'ACTIVE'`,加上下面那条
 * 「第二条 SUPERSEDED 必须放行」的反向对照 —— 漏写 WHERE 时后者会红。
 *
 * 三条**反向对照**(SUPERSEDED 并存 / 多个 NULL 头像 / 附件删后留行)同样重要:
 * 它们证明约束不是恒红。一组只会拒绝的判据,和一条 `CHECK (false)` 无法区分。
 */

interface RawDbError {
  sqlState: string;
  /** 违反的约束名。**只有 CHECK(23514)与 FK(23503)拿得到** —— 见下方说明。 */
  constraint: string;
  /** 唯一约束(23505)的键列签名,如 `"memberId", version`。唯一违反只能靠它区分。 */
  keyColumns: string;
  message: string;
}

describe('member official portrait + account avatar schema constraints', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sequence = 0;

  const unique = (label: string) => `mvi-${label}-${(sequence += 1)}`;

  let memberId: string;
  let userId: string;
  let attachmentA: string;
  let attachmentB: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);

    const member = await prisma.member.create({
      data: { memberNo: unique('member-no'), ...memberIdentityData('标准照测试队员') },
      select: { id: true },
    });
    memberId = member.id;

    const user = await prisma.user.create({
      data: { username: unique('user'), passwordHash: 'x' },
      select: { id: true },
    });
    userId = user.id;

    const [a, b] = await Promise.all([
      prisma.attachment.create({
        data: {
          key: unique('key-a'),
          originalName: 'a.jpg',
          mime: 'image/jpeg',
          size: 1024,
          uploadedBy: user.id,
          ownerType: 'member-official-portrait',
          ownerId: member.id,
        },
        select: { id: true },
      }),
      prisma.attachment.create({
        data: {
          key: unique('key-b'),
          originalName: 'b.jpg',
          mime: 'image/jpeg',
          size: 1024,
          uploadedBy: user.id,
          ownerType: 'member-official-portrait',
          ownerId: member.id,
        },
        select: { id: true },
      }),
    ]);
    attachmentA = a.id;
    attachmentB = b.id;
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
        const key = /Key \(([^)]*)\)=/.exec(message);
        return {
          sqlState: meta?.code ?? '',
          constraint: matched?.[1] ?? '',
          keyColumns: key?.[1] ?? '',
          message,
        };
      }
      throw error;
    }
  }

  /** 插一行标准照。缺省是一条**合法的 ACTIVE 行**;各用例只覆盖它要打破的那一格。 */
  function insertPortrait(overrides: {
    id: string;
    version: number;
    attachmentId?: string | null;
    specVersion?: string;
    status?: 'ACTIVE' | 'SUPERSEDED' | 'VOIDED';
    endedAt?: string | null;
    endedByUserId?: string | null;
    purgedAt?: string | null;
  }): Promise<RawDbError | null> {
    const attachment =
      overrides.attachmentId === null ? 'NULL' : `'${overrides.attachmentId ?? attachmentA}'`;
    const endedBy =
      overrides.endedByUserId === null || overrides.endedByUserId === undefined
        ? 'NULL'
        : `'${overrides.endedByUserId}'`;
    return execute(
      `INSERT INTO member_official_portraits
         ("id","memberId","version","attachmentId","specVersion","source","status",
          "activatedAt","activatedByUserId","endedAt","endedByUserId","purgedAt","updatedAt")
       VALUES ('${overrides.id}', '${memberId}', ${overrides.version}, ${attachment},
               '${overrides.specVersion ?? 'uniform-portrait-v1'}', 'ADMIN_UPLOAD',
               '${overrides.status ?? 'ACTIVE'}', NOW(), '${userId}',
               ${overrides.endedAt ?? 'NULL'}, ${endedBy}, ${overrides.purgedAt ?? 'NULL'}, NOW())`,
    );
  }

  it('installs the table shape, RESTRICT/SetNull foreign keys, indexes and four CHECK constraints', async () => {
    const columns = await prisma.$queryRaw<
      Array<{ column_name: string; is_nullable: string; column_default: string | null }>
    >`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'member_official_portraits'
      ORDER BY ordinal_position
    `;
    expect(columns.map((column) => column.column_name)).toEqual([
      'id',
      'memberId',
      'version',
      'attachmentId',
      'specVersion',
      'source',
      'capturedAt',
      'status',
      'activatedAt',
      'activatedByUserId',
      'endedAt',
      'endedByUserId',
      'endReason',
      'purgedAt',
      'createdAt',
      'updatedAt',
    ]);
    // 版本历史**没有** deletedAt —— 历史照片用 SUPERSEDED/VOIDED 终态表达,不是软删。
    expect(columns.map((column) => column.column_name)).not.toContain('deletedAt');
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: 'memberId', is_nullable: 'NO' }),
        expect.objectContaining({ column_name: 'version', is_nullable: 'NO' }),
        expect.objectContaining({ column_name: 'specVersion', is_nullable: 'NO' }),
        expect.objectContaining({ column_name: 'activatedByUserId', is_nullable: 'NO' }),
        // 可空**不是**因为"可以没有照片",而是历史版本二进制被清理后仍要留元数据。
        expect.objectContaining({ column_name: 'attachmentId', is_nullable: 'YES' }),
      ]),
    );

    // `activatedAt` **必须没有默认值**。这不是风格洁癖:有默认值时,应用侧漏传就会
    // 悄悄吃库时钟,而仓内「写用库时钟、判用应用时钟」是一整类缺陷(clock-authority.spec.ts)。
    // 无默认值 ⇒ Prisma `create` 必填 ⇒ 漏传是编译错误,不是运行时的一个错时间戳。
    //
    // ⚠️ 这条断言还兼职**探测陈旧测试库**:改一个**已被应用过**的 migration 文件时,
    //    Prisma 按名字认定「已应用」而不会重跑,于是本地库停在旧结构上、用例照样全绿
    //    (本刀实测踩到过:改完 DEFAULT 后 12/12 仍绿,而库里 DEFAULT 还在)。
    //    这行会在那种情况下变红,把假绿变成真红。
    const activatedAt = columns.find((column) => column.column_name === 'activatedAt');
    expect(activatedAt?.column_default).toBeNull();
    // 反向对照:同一张表上 createdAt 确实**有**默认值 —— 证明这条判据不是"恒为 null"。
    expect(
      columns.find((column) => column.column_name === 'createdAt')?.column_default,
    ).not.toBeNull();

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
        AND tc.table_name = 'member_official_portraits'
        AND tc.constraint_type = 'FOREIGN KEY'
      ORDER BY kcu.column_name
    `;
    expect(foreignKeys).toEqual([
      { column_name: 'activatedByUserId', foreign_table_name: 'User', delete_rule: 'RESTRICT' },
      // SET NULL:附件被 durable delete 掉后,版本历史必须留下来。
      { column_name: 'attachmentId', foreign_table_name: 'attachments', delete_rule: 'SET NULL' },
      { column_name: 'endedByUserId', foreign_table_name: 'User', delete_rule: 'RESTRICT' },
      // RESTRICT:挂着标准照的队员行不能被硬删。
      { column_name: 'memberId', foreign_table_name: 'Member', delete_rule: 'RESTRICT' },
    ]);

    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'member_official_portraits'
      ORDER BY indexname
    `;
    const oneActive = indexes.find(
      (index) => index.indexname === 'member_official_portrait_one_active_per_member',
    );
    expect(oneActive?.indexdef).toContain('UNIQUE INDEX');
    expect(oneActive?.indexdef).toContain('("memberId")');
    // 谓词写错(比如漏掉 WHERE,或者写成 <> 'ACTIVE')在功能上完全是另一条约束,
    // 而两者都能让"插第二条 ACTIVE 被拒"这个用例变绿 —— 所以谓词本身也要断言。
    expect(oneActive?.indexdef).toMatch(/WHERE \(status = 'ACTIVE'/);
    expect(indexes.map((index) => index.indexname)).toEqual(
      expect.arrayContaining([
        'member_official_portraits_memberId_version_key',
        'member_official_portraits_attachmentId_key',
        'member_official_portraits_memberId_status_idx',
      ]),
    );

    const checks = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'member_official_portraits'::regclass
        AND contype = 'c'
      ORDER BY conname
    `;
    expect(checks.map((check) => check.conname)).toEqual([
      'member_official_portraits_active_shape_check',
      'member_official_portraits_ended_shape_check',
      'member_official_portraits_purged_shape_check',
      'member_official_portraits_spec_version_check',
    ]);

    const avatarIndex = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'User'
        AND indexname = 'User_avatarAttachmentId_key'
    `;
    expect(avatarIndex).toHaveLength(1);
  });

  it('accepts a well-formed ACTIVE row (baseline: the probes below are not vacuously red)', async () => {
    expect(await insertPortrait({ id: unique('ok'), version: 1 })).toBeNull();
  });

  it('is cleared by resetDb, so portrait rows cannot leak across specs', async () => {
    // `test/setup/reset-db.ts` 清的是一张**逐字写死的 62 表清单**,新表不在里面。
    // 它靠 `TRUNCATE ... CASCADE` 连带清理 —— 而 CASCADE 只带走「引用被清表」的表。
    // 本表引用 Member / User / attachments(三张都在清单里)⇒ 应当被带走。
    // 但仓里出过「以为会被 CASCADE、实际从未被清」的事故(三张表跨 spec 存活),
    // 所以这里**实测**而不是推理:插一行 → resetDb → 数它还在不在。
    expect(await insertPortrait({ id: unique('leak-probe'), version: 1 })).toBeNull();
    expect(await prisma.memberOfficialPortrait.count()).toBe(1);

    await resetDb(app);

    expect(await prisma.memberOfficialPortrait.count()).toBe(0);
  });

  it('rejects a second ACTIVE portrait for the same member, but allows a SUPERSEDED sibling', async () => {
    expect(await insertPortrait({ id: unique('active-1'), version: 1 })).toBeNull();

    const duplicate = await insertPortrait({
      id: unique('active-2'),
      version: 2,
      attachmentId: attachmentB,
    });
    expect(duplicate?.sqlState).toBe('23505');
    // 键列签名区分不了 partial 与 full unique —— 那一格由结构用例的 indexdef 断言
    // 与紧接着的 SUPERSEDED 反向对照合起来钉死。
    expect(duplicate?.keyColumns).toBe('"memberId"');

    // 反向对照:同一 Member 的第二条**非 ACTIVE** 行必须放行。
    // 少了这条,一个漏写 WHERE 的全表唯一索引也会让上面的断言全绿。
    expect(
      await insertPortrait({
        id: unique('superseded'),
        version: 2,
        attachmentId: attachmentB,
        status: 'SUPERSEDED',
        endedAt: 'NOW()',
        endedByUserId: userId,
      }),
    ).toBeNull();
  });

  it('rejects an ACTIVE row without a binary, or carrying end/purge fields', async () => {
    const noAttachment = await insertPortrait({
      id: unique('active-no-blob'),
      version: 1,
      attachmentId: null,
    });
    expect(noAttachment?.sqlState).toBe('23514');
    expect(noAttachment?.constraint).toBe('member_official_portraits_active_shape_check');

    const endedWhileActive = await insertPortrait({
      id: unique('active-ended'),
      version: 2,
      endedAt: 'NOW()',
    });
    expect(endedWhileActive?.sqlState).toBe('23514');
    expect(endedWhileActive?.constraint).toBe('member_official_portraits_active_shape_check');

    const purgedWhileActive = await insertPortrait({
      id: unique('active-purged'),
      version: 3,
      purgedAt: 'NOW()',
    });
    expect(purgedWhileActive?.sqlState).toBe('23514');
    expect(purgedWhileActive?.constraint).toBe('member_official_portraits_active_shape_check');
  });

  it('rejects a terminal row that does not record who ended it and when', async () => {
    const supersededWithoutEndedAt = await insertPortrait({
      id: unique('superseded-bare'),
      version: 1,
      status: 'SUPERSEDED',
    });
    expect(supersededWithoutEndedAt?.sqlState).toBe('23514');
    expect(supersededWithoutEndedAt?.constraint).toBe(
      'member_official_portraits_ended_shape_check',
    );

    const voidedWithoutActor = await insertPortrait({
      id: unique('voided-bare'),
      version: 2,
      status: 'VOIDED',
      endedAt: 'NOW()',
    });
    expect(voidedWithoutActor?.sqlState).toBe('23514');
    expect(voidedWithoutActor?.constraint).toBe('member_official_portraits_ended_shape_check');
  });

  it('rejects a purged row that still points at a binary', async () => {
    const purgedWithBlob = await insertPortrait({
      id: unique('purged-with-blob'),
      version: 1,
      status: 'SUPERSEDED',
      endedAt: 'NOW()',
      endedByUserId: userId,
      purgedAt: 'NOW()',
    });
    expect(purgedWithBlob?.sqlState).toBe('23514');
    expect(purgedWithBlob?.constraint).toBe('member_official_portraits_purged_shape_check');

    // 反向对照:二进制已清空的 purged 行必须放行(否则"合规清理"根本落不了库)。
    expect(
      await insertPortrait({
        id: unique('purged-clean'),
        version: 2,
        attachmentId: null,
        status: 'SUPERSEDED',
        endedAt: 'NOW()',
        endedByUserId: userId,
        purgedAt: 'NOW()',
      }),
    ).toBeNull();
  });

  it('rejects a specVersion outside the controlled registry', async () => {
    const unknownSpec = await insertPortrait({
      id: unique('bad-spec'),
      version: 1,
      specVersion: 'uniform-portrait-v9',
    });
    expect(unknownSpec?.sqlState).toBe('23514');
    expect(unknownSpec?.constraint).toBe('member_official_portraits_spec_version_check');
  });

  it('rejects a duplicated version number and a shared attachment across versions', async () => {
    expect(
      await insertPortrait({
        id: unique('v1'),
        version: 1,
        status: 'SUPERSEDED',
        endedAt: 'NOW()',
        endedByUserId: userId,
      }),
    ).toBeNull();

    const duplicateVersion = await insertPortrait({
      id: unique('v1-again'),
      version: 1,
      attachmentId: attachmentB,
      status: 'SUPERSEDED',
      endedAt: 'NOW()',
      endedByUserId: userId,
    });
    expect(duplicateVersion?.sqlState).toBe('23505');
    expect(duplicateVersion?.keyColumns).toBe('"memberId", version');

    const sharedAttachment = await insertPortrait({
      id: unique('v2-shared-blob'),
      version: 2,
      attachmentId: attachmentA,
      status: 'SUPERSEDED',
      endedAt: 'NOW()',
      endedByUserId: userId,
    });
    expect(sharedAttachment?.sqlState).toBe('23505');
    expect(sharedAttachment?.keyColumns).toBe('"attachmentId"');
  });

  it('keeps the version row when its attachment is deleted, nulling the pointer', async () => {
    const id = unique('survives-purge');
    expect(
      await insertPortrait({
        id,
        version: 1,
        status: 'SUPERSEDED',
        endedAt: 'NOW()',
        endedByUserId: userId,
      }),
    ).toBeNull();

    await prisma.attachment.delete({ where: { id: attachmentA } });

    const row = await prisma.memberOfficialPortrait.findUnique({
      where: { id },
      select: { id: true, attachmentId: true, status: true },
    });
    expect(row).toEqual({ id, attachmentId: null, status: 'SUPERSEDED' });
  });

  it('refuses to hard-delete a member that still owns portrait history', async () => {
    expect(await insertPortrait({ id: unique('blocks-delete'), version: 1 })).toBeNull();

    const blocked = await execute(`DELETE FROM "Member" WHERE "id" = '${memberId}'`);
    expect(blocked?.sqlState).toBe('23503');
    expect(blocked?.constraint).toBe('member_official_portraits_memberId_fkey');
  });

  it('lets at most one user claim a given attachment as avatar, while NULL never collides', async () => {
    const other = await prisma.user.create({
      data: { username: unique('user-other'), passwordHash: 'x' },
      select: { id: true },
    });

    await prisma.user.update({
      where: { id: userId },
      data: { avatarAttachmentId: attachmentA },
    });

    const stolen = await execute(
      `UPDATE "User" SET "avatarAttachmentId" = '${attachmentA}' WHERE "id" = '${other.id}'`,
    );
    expect(stolen?.sqlState).toBe('23505');
    expect(stolen?.keyColumns).toBe('"avatarAttachmentId"');

    // 反向对照:两个都没头像的账号必须能共存 —— PG 唯一索引里 NULL 互不冲突,
    // 所以"绝大多数用户没头像"不需要 partial unique 也不会挤在一个槽位上。
    const third = await prisma.user.create({
      data: { username: unique('user-third'), passwordHash: 'x' },
      select: { id: true, avatarAttachmentId: true },
    });
    expect(third.avatarAttachmentId).toBeNull();
    expect(
      await prisma.user.count({
        where: { avatarAttachmentId: null, id: { in: [other.id, third.id] } },
      }),
    ).toBe(2);
  });
});

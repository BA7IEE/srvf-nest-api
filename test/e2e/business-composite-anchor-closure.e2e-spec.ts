import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

/**
 * 业务复合锚点闭合(第六轮评审 A-2 + B-03)—— **数据库真的在挡** 的直接证据。
 *
 * 配套的结构判据(`composite-anchor-closure.criteria.spec.ts`)只证明
 * **schema 写对了**:哪些关系声明成了复合外键。它读的是 `schema.prisma` 文本,
 * 一行 SQL 都没跑过 —— 迁移漏跑、约束建在错列上、`ADD CONSTRAINT` 静默失败,
 * 这三种形状它**一个都发现不了**。本文件补的正是那一格。
 *
 * 手法:先建**两条各自完全合法**的业务主链(活动 A 与活动 B),再用
 * `$executeRawUnsafe` 把两条链的 ID **交叉组合**插入。绕开应用层是刻意的 ——
 * 存量导入脚本、修数 SQL、以后某个写错的 service 都是从这个方向进来的,
 * service 层校验(`attendance-punch-command.service.ts:166`)拦不住它们。
 *
 * ⚠️ 每条负例都钉到**具体是哪条约束**,不只断 `23503`。只断 SQLSTATE 的话,
 * 任何一条别的外键先炸都会让用例变绿,而被测的那条可能根本没建上 ——
 * 「建在错列上」和「压根没建」在只断 SQLSTATE 时长得一模一样。
 * FK(23503)的约束名可以从 Prisma `P2010` 的 `meta.message` 里取到。
 *
 * ⚠️ 每条负例都配一条**正向对照**(同链组合必须插入成功)。只会拒绝的一组判据,
 * 与一条 `CHECK (false)` 无法区分 —— 少了正向对照,把外键建成恒拒也是全绿。
 */

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

interface Chain {
  tag: string;
  activityId: string;
  sessionId: string;
  memberId: string;
  registrationId: string;
  identityId: string;
  positionId: string;
}

describe('business composite anchor closure — cross-chain inserts are rejected by the database', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let actorUserId: string;
  let organizationId: string;
  let sequence = 0;

  const SESSION_START = new Date('2099-05-01T01:00:00.000Z');
  const SESSION_END = new Date('2099-05-01T05:00:00.000Z');

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    prisma = app.get(PrismaService);

    const user = await createTestUser(app, {
      username: `anchor-closure-actor-${(sequence += 1)}`,
      role: Role.SUPER_ADMIN,
    });
    actorUserId = user.id;

    const organization = await prisma.organization.create({
      data: { name: '复合锚点闭合测试组织', nodeTypeCode: `anchor-team-${sequence}` },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  async function createSession(activityId: string, code: string, name: string): Promise<string> {
    const session = await prisma.activitySession.create({
      data: {
        activityId,
        code,
        name,
        startAt: SESSION_START,
        endAt: SESSION_END,
        locationText: '深圳',
        checkInOpenAt: new Date(SESSION_START.getTime() - 3600_000),
        checkInCloseAt: new Date(SESSION_START.getTime() + 3600_000),
        checkOutOpenAt: SESSION_START,
        checkOutCloseAt: new Date(SESSION_END.getTime() + 3600_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    return session.id;
  }

  /** 建一条**完全合法**的业务主链:活动 → 场次 → 岗位 → 队员 → 报名 → 参与身份。 */
  async function buildChain(label: string): Promise<Chain> {
    sequence += 1;
    const tag = `${label}-${sequence}`;

    const activity = await prisma.activity.create({
      data: {
        title: `复合锚点活动 ${tag}`,
        activityTypeCode: `anchor-type-${tag}`,
        organizationId,
        startAt: SESSION_START,
        endAt: SESSION_END,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });

    const sessionId = await createSession(activity.id, `${tag}-s0`, `${tag} 场次`);

    const position = await prisma.activitySessionPosition.create({
      data: {
        activityId: activity.id,
        sessionId,
        code: `${tag}-p0`,
        name: `${tag} 岗位`,
        attendanceRoleCode: 'general',
        capacity: 10,
      },
      select: { id: true },
    });

    const member = await prisma.member.create({
      data: {
        memberNo: `${tag}-m0`,
        ...memberIdentityData(`${tag} 队员`),
        gradeCode: 'level-2',
      },
      select: { id: true },
    });

    const registration = await prisma.activityRegistration.create({
      data: { activityId: activity.id, memberId: member.id, statusCode: 'approved' },
      select: { id: true },
    });

    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId,
        registrationId: registration.id,
        memberId: member.id,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
      select: { id: true },
    });

    return {
      tag,
      activityId: activity.id,
      sessionId,
      memberId: member.id,
      registrationId: registration.id,
      identityId: identity.id,
      positionId: position.id,
    };
  }

  async function execute(sql: string): Promise<RawDbError | null> {
    try {
      await prisma.$executeRawUnsafe(sql);
      return null;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
        const meta = error.meta as { code?: string; message?: string } | undefined;
        const message = meta?.message ?? '';
        return {
          sqlState: meta?.code ?? '',
          constraint: /constraint "([^"]+)"/.exec(message)?.[1] ?? '',
          message,
        };
      }
      throw error;
    }
  }

  /** 插一条参与身份;各用例只覆盖它要打破的那一格。 */
  function insertIdentity(o: {
    activityId: string;
    sessionId: string;
    registrationId: string;
    memberId: string;
  }): Promise<RawDbError | null> {
    return execute(
      `INSERT INTO "ActivityParticipationIdentity"
         ("id","activityId","sessionId","registrationId","memberId",
          "currentStatusCode","populationIncluded","updatedAt")
       VALUES ('${randomUUID()}', '${o.activityId}', '${o.sessionId}',
               '${o.registrationId}', '${o.memberId}', 'pass', true, NOW())`,
    );
  }

  /** 插一条打卡事件;各用例只覆盖它要打破的那一格。 */
  function insertPunch(o: {
    activityId: string;
    sessionId: string;
    participationIdentityId: string;
    memberId: string;
    positionId?: string | null;
  }): Promise<RawDbError | null> {
    const key = randomUUID();
    return execute(
      `INSERT INTO "AttendancePunchEvent"
         ("id","activityId","sessionId","positionId","participationIdentityId","memberId",
          "eventTypeCode","sourceCode","occurredAt","receivedAt","operatorUserId",
          "eventKey","requestHash","evidenceRevision")
       VALUES ('${key}', '${o.activityId}', '${o.sessionId}',
               ${o.positionId ? `'${o.positionId}'` : 'NULL'},
               '${o.participationIdentityId}', '${o.memberId}',
               'check_in', 'staff_scan', NOW(), NOW(), '${actorUserId}',
               'ek-${key}', 'rh-${key}', 0)`,
    );
  }

  // ===========================================================================
  // 负例:两条合法链交叉组合 —— 必须被数据库以 23503 挡住,并点名到具体约束
  // ===========================================================================

  it('rejects a participation identity whose registration belongs to another activity', async () => {
    const a = await buildChain('act-a');
    const b = await buildChain('act-b');

    // ⚠️ 必须换一个**新场次**:沿用 a.sessionId 会先撞上
    // `@@unique([activityId, sessionId, memberId])`,拿到 23505 而不是 23503 ——
    // 唯一约束会**遮蔽**被测的外键,用例看着红了却红在别处(实测踩到过)。
    const freshSession = await createSession(a.activityId, `${a.tag}-s1`, `${a.tag} 第二场`);

    // A 的活动 / 场次 / 队员,配 B 的报名头 —— 两个 ID 各自都存在,组合非法。
    const error = await insertIdentity({
      activityId: a.activityId,
      sessionId: freshSession,
      registrationId: b.registrationId,
      memberId: a.memberId,
    });

    expect(error).not.toBeNull();
    expect(error?.sqlState).toBe('23503');
    expect(error?.constraint).toBe(
      'ActivityParticipationIdentity_registrationId_activityId_me_fkey',
    );
  });

  it('rejects a punch event whose participation identity belongs to another activity', async () => {
    const a = await buildChain('act-a');
    const b = await buildChain('act-b');

    const error = await insertPunch({
      activityId: a.activityId,
      sessionId: a.sessionId,
      participationIdentityId: b.identityId,
      memberId: a.memberId,
    });

    expect(error).not.toBeNull();
    expect(error?.sqlState).toBe('23503');
    expect(error?.constraint).toBe(
      'AttendancePunchEvent_participationIdentityId_activityId_se_fkey',
    );
  });

  it('rejects a punch event whose position belongs to another activity session', async () => {
    const a = await buildChain('act-a');
    const b = await buildChain('act-b');

    const error = await insertPunch({
      activityId: a.activityId,
      sessionId: a.sessionId,
      participationIdentityId: a.identityId,
      memberId: a.memberId,
      positionId: b.positionId,
    });

    expect(error).not.toBeNull();
    expect(error?.sqlState).toBe('23503');
    expect(error?.constraint).toBe('AttendancePunchEvent_positionId_activityId_sessionId_fkey');
  });

  it('rejects a punch event that supersedes an event from another activity', async () => {
    const a = await buildChain('act-a');
    const b = await buildChain('act-b');

    // 先在 B 链上落一条合法事件,再让 A 链的事件去 void 它。
    const bEventId = randomUUID();
    const seeded = await execute(
      `INSERT INTO "AttendancePunchEvent"
         ("id","activityId","sessionId","participationIdentityId","memberId",
          "eventTypeCode","sourceCode","occurredAt","receivedAt","operatorUserId",
          "eventKey","requestHash","evidenceRevision")
       VALUES ('${bEventId}', '${b.activityId}', '${b.sessionId}', '${b.identityId}',
               '${b.memberId}', 'check_in', 'staff_scan', NOW(), NOW(), '${actorUserId}',
               'ek-${bEventId}', 'rh-${bEventId}', 0)`,
    );
    expect(seeded).toBeNull(); // 前置:B 链自己那条必须是合法的

    const key = randomUUID();
    const error = await execute(
      `INSERT INTO "AttendancePunchEvent"
         ("id","activityId","sessionId","participationIdentityId","memberId",
          "eventTypeCode","sourceCode","occurredAt","receivedAt","operatorUserId",
          "eventKey","requestHash","evidenceRevision","reason","supersedesEventId")
       VALUES ('${key}', '${a.activityId}', '${a.sessionId}', '${a.identityId}',
               '${a.memberId}', 'void', 'correction', NOW(), NOW(), '${actorUserId}',
               'ek-${key}', 'rh-${key}', 0, '跨活动作废', '${bEventId}')`,
    );

    expect(error).not.toBeNull();
    expect(error?.sqlState).toBe('23503');
    expect(error?.constraint).toBe(
      'AttendancePunchEvent_supersedesEventId_activityId_sessionI_fkey',
    );
  });

  // ===========================================================================
  // 正向对照:同链组合必须插得进去
  //
  // 没有这一组,把外键建成恒拒(或建在一对永不满足的列上)也会让上面四条全绿。
  // ===========================================================================

  it('accepts same-chain combinations (proves the constraints are not always-reject)', async () => {
    const a = await buildChain('act-a');

    // 同一条链上再开一个场次与身份,全部同锚点。
    const session2 = await prisma.activitySession.create({
      data: {
        activityId: a.activityId,
        code: `${a.tag}-s1`,
        name: `${a.tag} 第二场`,
        startAt: SESSION_START,
        endAt: SESSION_END,
        locationText: '深圳',
        checkInOpenAt: new Date(SESSION_START.getTime() - 3600_000),
        checkInCloseAt: new Date(SESSION_START.getTime() + 3600_000),
        checkOutOpenAt: SESSION_START,
        checkOutCloseAt: new Date(SESSION_END.getTime() + 3600_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });

    // 1) 同活动的报名头 + 新场次 ⇒ 应当放行
    await expect(
      insertIdentity({
        activityId: a.activityId,
        sessionId: session2.id,
        registrationId: a.registrationId,
        memberId: a.memberId,
      }),
    ).resolves.toBeNull();

    // 2) 同活动 / 同场次 / 同身份 / 同岗位的打卡 ⇒ 应当放行
    await expect(
      insertPunch({
        activityId: a.activityId,
        sessionId: a.sessionId,
        participationIdentityId: a.identityId,
        memberId: a.memberId,
        positionId: a.positionId,
      }),
    ).resolves.toBeNull();

    // 3) 同链内的 void ⇒ 应当放行
    const firstId = randomUUID();
    await expect(
      execute(
        `INSERT INTO "AttendancePunchEvent"
           ("id","activityId","sessionId","participationIdentityId","memberId",
            "eventTypeCode","sourceCode","occurredAt","receivedAt","operatorUserId",
            "eventKey","requestHash","evidenceRevision")
         VALUES ('${firstId}', '${a.activityId}', '${a.sessionId}', '${a.identityId}',
                 '${a.memberId}', 'check_in', 'staff_scan', NOW(), NOW(), '${actorUserId}',
                 'ek-${firstId}', 'rh-${firstId}', 0)`,
      ),
    ).resolves.toBeNull();

    const voidId = randomUUID();
    await expect(
      execute(
        `INSERT INTO "AttendancePunchEvent"
           ("id","activityId","sessionId","participationIdentityId","memberId",
            "eventTypeCode","sourceCode","occurredAt","receivedAt","operatorUserId",
            "eventKey","requestHash","evidenceRevision","reason","supersedesEventId")
         VALUES ('${voidId}', '${a.activityId}', '${a.sessionId}', '${a.identityId}',
                 '${a.memberId}', 'void', 'correction', NOW(), NOW(), '${actorUserId}',
                 'ek-${voidId}', 'rh-${voidId}', 0, '同链作废', '${firstId}')`,
      ),
    ).resolves.toBeNull();
  });

  // ===========================================================================
  // 结构:约束确实建在**该建的列上**
  //
  // 上面的负例证明「有东西在挡」,这一条证明「挡的是复合锚点,不是别的巧合约束」。
  // ===========================================================================

  it('installs composite foreign keys on the settlement-truth tables', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ table_name: string; constraint_name: string; columns: string; refcolumns: string }>
    >`
      SELECT c.conrelid::regclass::text                                   AS table_name,
             c.conname                                                    AS constraint_name,
             (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
             (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcolumns
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.conrelid::regclass::text IN
             ('"ParticipationLedgerEntry"', '"AttendancePunchEvent"',
              '"ActivityParticipationIdentity"', '"OfflinePackageParticipant"')
       ORDER BY 1, 2
    `;

    const find = (table: string, cols: string) =>
      rows.find((r) => r.table_name === `"${table}"` && r.columns === cols);

    // 账本分录指回参与身份:四列同锚(B-03 的正主)
    expect(
      find('ParticipationLedgerEntry', 'participationIdentityId,activityId,sessionId,memberId')
        ?.refcolumns,
    ).toBe('id,activityId,sessionId,memberId');

    // 打卡事件指回参与身份
    expect(
      find('AttendancePunchEvent', 'participationIdentityId,activityId,sessionId,memberId')
        ?.refcolumns,
    ).toBe('id,activityId,sessionId,memberId');

    // 参与身份指回报名头:活动 + 队员同锚
    expect(
      find('ActivityParticipationIdentity', 'registrationId,activityId,memberId')?.refcolumns,
    ).toBe('id,activityId,memberId');

    // 离线包参与者指回参与身份
    expect(
      find('OfflinePackageParticipant', 'participationIdentityId,activityId,sessionId,memberId')
        ?.refcolumns,
    ).toBe('id,activityId,sessionId,memberId');
  });
});

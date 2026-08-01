import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 企业微信接入 T1(2026-08-01;第 68 migration `20260801093000_wecom_identity_foundation`)
// 冻结稿:docs/archive/reviews/wecom-integration-t0-terminal-review.md §5
//
// 本 spec 的**唯一**职责:证明 migration 末尾 5 条手写约束在真实 PostgreSQL 上**真的会拒**,
// 而不是"schema 文本里写了"。goal DoD 原话:「两条 partial unique + 两条 CHECK 有 e2e 实测
// (违反即拒,不是只看 schema 文本)」。
//
// 为什么每条都要**双向**断言(违规被拒 + 合法放行):
// 只断言"被拒"证明不了约束是对的 —— 一条 `CHECK (false)` 也能让所有违规用例全绿,
// 却把合法写入一起拒掉。反向样例是区分"约束正确"与"约束过严"的唯一手段
//(沿本仓 harness 阳性对照纪律)。
//
// 走 $executeRawUnsafe 而非 Prisma model API:partial unique 的 WHERE 与 CHECK 都是
// **DB 层**约束,Prisma client 不认识它们;必须让语句真的打到 PostgreSQL 才算实测。
// Prisma 把原生语句的数据库错误包成 P2010,SQLSTATE 落在 `meta.code`(23505=unique / 23514=check)。

const CORP_A = 'wwCorpAlpha';
const CORP_B = 'wwCorpBeta';

interface RawDbError {
  sqlState: string;
  message: string;
}

describe('WeCom T1 schema 约束(第 68 migration 手写 5 条)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
    const userA = await prisma.user.create({
      data: { username: 'wecom-user-a', passwordHash: 'x' },
      select: { id: true },
    });
    const userB = await prisma.user.create({
      data: { username: 'wecom-user-b', passwordHash: 'x' },
      select: { id: true },
    });
    userAId = userA.id;
    userBId = userB.id;
  });

  // 执行一条原生语句;成功返回 null,失败返回归一化的 { sqlState, message }。
  // 刻意不 throw —— 调用点用返回值做断言,避免 expect().rejects 把"没抛"读成通过。
  async function run(sql: string): Promise<RawDbError | null> {
    try {
      await prisma.$executeRawUnsafe(sql);
      return null;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
        const meta = err.meta as { code?: string; message?: string } | undefined;
        return { sqlState: meta?.code ?? '', message: meta?.message ?? '' };
      }
      throw err;
    }
  }

  function insertIdentity(input: {
    id: string;
    userId: string;
    corpId: string;
    wecomUserId: string;
    status: string;
    revokedAt: 'now' | null;
  }): string {
    const revokedAt = input.revokedAt === 'now' ? 'now()' : 'NULL';
    return `INSERT INTO "wecom_identities"
      ("id","userId","corpId","wecomUserId","status","bindingSource","revokedAt","updatedAt")
      VALUES ('${input.id}','${input.userId}','${input.corpId}','${input.wecomUserId}',
              '${input.status}','pre-auth',${revokedAt},now())`;
  }

  const activeIdentity = (id: string, userId: string, corpId: string, wecomUserId: string) =>
    insertIdentity({ id, userId, corpId, wecomUserId, status: 'active', revokedAt: null });

  const revokedIdentity = (id: string, userId: string, corpId: string, wecomUserId: string) =>
    insertIdentity({ id, userId, corpId, wecomUserId, status: 'revoked', revokedAt: 'now' });

  // ===== ① wecom_settings_singleton_unique(冻结稿 §5.1)=====

  describe('singleton unique —— 全库至多一行 settings', () => {
    it('第 1 行放行;第 2 行被 constant unique 拒(23505)', async () => {
      expect(
        await run(`INSERT INTO "wecom_settings" ("id","updatedAt") VALUES ('ws-1',now())`),
      ).toBeNull();

      const second = await run(
        `INSERT INTO "wecom_settings" ("id","updatedAt") VALUES ('ws-2',now())`,
      );
      expect(second?.sqlState).toBe('23505');
    });

    it('三个开关默认全 false(冻结稿 §13 T2「默认所有开关 false」)', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "wecom_settings" ("id","updatedAt") VALUES ('ws-defaults',now())`,
      );
      const row = await prisma.wecomSettings.findUniqueOrThrow({
        where: { id: 'ws-defaults' },
        select: {
          enabled: true,
          loginEnabled: true,
          messageEnabled: true,
          providerType: true,
          credentialConfigured: true,
        },
      });
      expect(row).toEqual({
        enabled: false,
        loginEnabled: false,
        messageEnabled: false,
        providerType: 'DEV_STUB',
        credentialConfigured: false,
      });
    });
  });

  // ===== ② wecom_identity_subject_active_unique(冻结稿 §5.2)=====

  describe('subject active partial unique —— 一个企业微信身份至多绑一个 active User', () => {
    it('同 (corpId, wecomUserId) 第 2 条 active 被拒(23505)', async () => {
      expect(await run(activeIdentity('id-1', userAId, CORP_A, 'zhangsan'))).toBeNull();

      const dup = await run(activeIdentity('id-2', userBId, CORP_A, 'zhangsan'));
      expect(dup?.sqlState).toBe('23505');
    });

    it('反向:同 subject 但 status=revoked 放行 —— 解绑后可换人再绑(partial 的意义)', async () => {
      await prisma.$executeRawUnsafe(revokedIdentity('id-old', userAId, CORP_A, 'zhangsan'));
      expect(await run(activeIdentity('id-new', userBId, CORP_A, 'zhangsan'))).toBeNull();
    });

    it('反向:同 wecomUserId 但不同 corpId 放行(唯一性按 corp 分域)', async () => {
      await prisma.$executeRawUnsafe(activeIdentity('id-a', userAId, CORP_A, 'zhangsan'));
      expect(await run(activeIdentity('id-b', userBId, CORP_B, 'zhangsan'))).toBeNull();
    });
  });

  // ===== ③ wecom_identity_user_active_unique(冻结稿 §5.2)=====

  describe('user active partial unique —— 一个 User 在当前 Corp 下至多一个 active 身份', () => {
    it('同 (corpId, userId) 第 2 条 active 被拒(23505)', async () => {
      expect(await run(activeIdentity('id-1', userAId, CORP_A, 'zhangsan'))).toBeNull();

      const dup = await run(activeIdentity('id-2', userAId, CORP_A, 'lisi'));
      expect(dup?.sqlState).toBe('23505');
    });

    it('反向:换绑形状(旧行 revoked + 新行 active)放行 —— 历史行必须留得住', async () => {
      await prisma.$executeRawUnsafe(revokedIdentity('id-old', userAId, CORP_A, 'zhangsan'));
      expect(await run(activeIdentity('id-new', userAId, CORP_A, 'lisi'))).toBeNull();

      const rows = await prisma.wecomIdentity.count({ where: { userId: userAId } });
      expect(rows).toBe(2); // 换绑不覆盖历史:两行都在
    });

    it('反向:同 User 在另一个 corpId 下可再有一条 active', async () => {
      await prisma.$executeRawUnsafe(activeIdentity('id-a', userAId, CORP_A, 'zhangsan'));
      expect(await run(activeIdentity('id-b', userAId, CORP_B, 'zhangsan'))).toBeNull();
    });
  });

  // ===== ④ wecom_identity_revocation_shape_check(冻结稿 §5.2)=====

  describe('revocation shape CHECK —— active ⇔ revokedAt IS NULL', () => {
    it('active 却带 revokedAt 被拒(23514)', async () => {
      const bad = await run(
        insertIdentity({
          id: 'bad-1',
          userId: userAId,
          corpId: CORP_A,
          wecomUserId: 'zhangsan',
          status: 'active',
          revokedAt: 'now',
        }),
      );
      expect(bad?.sqlState).toBe('23514');
      expect(bad?.message).toContain('wecom_identity_revocation_shape_check');
    });

    it('revoked 却没有 revokedAt 被拒(23514)—— 否则审计答不出"什么时候失效的"', async () => {
      const bad = await run(
        insertIdentity({
          id: 'bad-2',
          userId: userAId,
          corpId: CORP_A,
          wecomUserId: 'zhangsan',
          status: 'revoked',
          revokedAt: null,
        }),
      );
      expect(bad?.sqlState).toBe('23514');
      expect(bad?.message).toContain('wecom_identity_revocation_shape_check');
    });

    it('反向:两种合法形状都放行', async () => {
      expect(await run(activeIdentity('ok-active', userAId, CORP_A, 'zhangsan'))).toBeNull();
      expect(await run(revokedIdentity('ok-revoked', userBId, CORP_A, 'lisi'))).toBeNull();
    });
  });

  // ===== ⑤ wecom_identity_status_check(冻结稿 §5.2)=====

  describe('status CHECK —— 闭集 {active, revoked}', () => {
    it('非法 status 被 CHECK 拒(23514)', async () => {
      const bad = await run(
        insertIdentity({
          id: 'bad-status',
          userId: userAId,
          corpId: CORP_A,
          wecomUserId: 'zhangsan',
          status: 'bogus',
          revokedAt: null,
        }),
      );
      expect(bad?.sqlState).toBe('23514');
    });

    // ⚠️ 诚实记录一处**约束重叠**(实测发现,非缺陷):
    // 任何 status ∉ {active, revoked} 同时也让 revocation_shape_check 的两个分支都为假,
    // 故 PostgreSQL 实际报出的是 shape check —— status_check **在 INSERT 路径上被完全覆盖**,
    // 不存在"只违反 status_check 却满足 shape_check"的输入。
    // 冻结稿 §5.2 两条都要求写,本刀逐字落地,不擅自删其一;但 status_check 的价值是
    // **纵深防御的声明**(将来若放宽 shape,取值闭集仍然关着),不是一道独立可达的闸。
    // 上面的用例因此只断言 23514 与"被拒",不断言具体命中哪条 —— 断言 status_check
    // 会是一条**假绿**:它测的其实是 shape check。
    it('结构断言:status_check 确实存在于 pg_constraint(行为上被 shape 覆盖,故单独查存在性)', async () => {
      const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'wecom_identities'::regclass
          AND contype = 'c'
        ORDER BY conname
      `;
      expect(rows.map((r) => r.conname)).toEqual([
        'wecom_identity_revocation_shape_check',
        'wecom_identity_status_check',
      ]);
    });
  });

  // ===== ⑥ WecomAuthAttempt 一次性凭证 hash 唯一(冻结稿 §5.3)=====

  describe('auth attempt —— stateHash / bindingTicketHash 唯一', () => {
    const attempt = (id: string, stateHash: string, ticketHash: string | null) =>
      `INSERT INTO "wecom_auth_attempts"
        ("id","purpose","returnPath","stateHash","stateExpiresAt","bindingTicketHash","updatedAt")
        VALUES ('${id}','login','/','${stateHash}',now() + interval '5 min',
                ${ticketHash === null ? 'NULL' : `'${ticketHash}'`},now())`;

    it('stateHash 重复被拒(23505)', async () => {
      expect(await run(attempt('at-1', 'hash-state-1', null))).toBeNull();
      expect((await run(attempt('at-2', 'hash-state-1', null)))?.sqlState).toBe('23505');
    });

    it('bindingTicketHash 重复被拒(23505);多行 NULL 放行(PG unique 容多 NULL)', async () => {
      expect(await run(attempt('at-1', 'hash-state-1', 'hash-ticket-1'))).toBeNull();
      expect((await run(attempt('at-2', 'hash-state-2', 'hash-ticket-1')))?.sqlState).toBe('23505');
      // 反向:未进入 binding_required 的 attempt 恒 NULL ticket,必须允许多行并存
      expect(await run(attempt('at-3', 'hash-state-3', null))).toBeNull();
      expect(await run(attempt('at-4', 'hash-state-4', null))).toBeNull();
    });
  });

  // ===== ⑦ expand-only 自证:User 侧零标量列(冻结稿 §5.4 / §0.3 硬禁区)=====

  it('User 上没有任何 wecom 标量字段 —— 只有两条反向 relation', async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'User' AND column_name ILIKE '%wecom%'
    `;
    expect(columns).toEqual([]);
  });

  it('SmsPurpose 含 WECOM_BIND(T3 才消费,本刀只加值)', async () => {
    const labels = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'SmsPurpose'
    `;
    expect(labels.map((r) => r.enumlabel)).toContain('WECOM_BIND');
  });
});

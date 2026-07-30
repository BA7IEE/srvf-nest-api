import type { INestApplication } from '@nestjs/common';
import { CertificateSource, CertificateValidityMode, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { PrismaService } from '../../src/database/prisma.service';
import { CertificatesService } from '../../src/modules/certificates/certificates.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 证书标准库 · 第二轮跨模型评审 findings G3:`verify()` 锁后复读。
//
// `verify` 在 `claimAtStatus`(条件行锁)**之前**读 `before`,然后用那份锁前快照的
// `expiredAt` 决定落点状态(§9.3:最后有效日早于今天 → expired,否则 verified)。
// 等锁期间一次 `PATCH expiredAt` 可以提交 —— 于是核验按一个**已经不存在的到期日**
// 给证书定状态。同文件的 `update()` 早就做对了(claimAtStatus → 重新查 lockedBefore →
// 后续只看锁后事实),这一处只是没跟上。
//
// 两个方向都要:改早 → 应写 expired;改晚 → 应写 verified。
// 只测一个方向证明不了「用的是锁后事实」—— 只能证明它在那一侧碰巧猜对了。

const TX_OPTS = { timeout: 30_000, maxWait: 30_000 } as const;
const meta: AuditMeta = { requestId: 'cert-verify-concurrency', ip: null, ua: null };

/** 按北京日历日偏移(与后端 date-only 口径同源,不用机器本地时区推日期)。 */
function beijingDayOffset(days: number): Date {
  const d = new Date(Date.now() + 8 * 3_600_000);
  d.setUTCDate(d.getUTCDate() + days);
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

describe('certificate verify concurrency(评审 findings G3:核验必须用锁后的到期日)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let certificatesB: CertificatesService;
  let admin: CurrentUserPayload;

  let memberId: string;
  let standardId: string;
  let seq = 0;

  /** 等到确实有 `expected` 个连接卡在 Certificate 的行锁上(不用 sleep:sleep 要么不够要么太长)。 */
  async function waitForCertificateLockWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const [row] = await prismaB.$queryRaw<Array<{ waitingCount: number }>>`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%Certificate%'
      `;
      if ((row?.waitingCount ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected at least ${expected} Certificate row-lock waiter(s)`);
  }

  async function createPendingCert(expiredAt: Date | null): Promise<{ id: string }> {
    seq += 1;
    const policy = await prismaA.certificateRecognitionPolicy.findFirstOrThrow({
      where: { standardId, status: 'ACTIVE' },
      select: { id: true },
    });
    return prismaA.certificate.create({
      data: {
        memberId,
        standardId,
        recognitionPolicyId: policy.id,
        sourceCode: CertificateSource.ADMIN,
        issuingOrg: '深圳市红十字会',
        certNumber: `CVC-${seq}`,
        issuedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiredAt,
        certStatusCode: 'pending',
      },
      select: { id: true },
    });
  }

  /**
   * blocker:占住证书行 → 通知 → 等放行 → **在同一事务内**改到期日 → 提交。
   *
   * 用裸 SQL 而不是真 `update()`:后者要拿的正是 blocker 手里这把锁(调它必然自锁)。
   * 这里改的只有 `expiredAt` 一列,与 `PATCH { expiredAt }` 的落库效果同义;
   * `update()` 自身「锁后复读」的正确性由既有 F3 用例覆盖。
   */
  function setExpiredAtAfterLock(
    certificateId: string,
    nextExpiredAt: Date | null,
  ): { ready: Promise<void>; release: () => void; done: Promise<void> } {
    let signalReady!: () => void;
    let doRelease!: () => void;
    const ready = new Promise<void>((r) => {
      signalReady = r;
    });
    const gate = new Promise<void>((r) => {
      doRelease = r;
    });
    const done = prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "Certificate" WHERE "id" = ${certificateId} FOR NO KEY UPDATE
      `;
      signalReady();
      await gate;
      await tx.$executeRaw`
        UPDATE "Certificate" SET "expiredAt" = ${nextExpiredAt} WHERE "id" = ${certificateId}
      `;
    }, TX_OPTS);
    return { ready, release: () => doRelease(), done };
  }

  /**
   * 全库巡检:`verified` 的证书不得带一个早于今天的最后有效日。
   *
   * 这正是 §9.3 那条规则的数据面表述 —— 到期扫描 cron 只处理**已经是 verified** 的行,
   * 所以一张「核验当天就已过期却写成 verified」的证书会被资质查询当作有效,
   * 直到次日 09:00 才被纠正。
   */
  async function assertNoVerifiedCertificateAlreadyExpired(): Promise<void> {
    const rows = await prismaA.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Certificate"
      WHERE "deletedAt" IS NULL
        AND "certStatusCode" = 'verified'
        AND "expiredAt" IS NOT NULL
        AND "expiredAt" < ${beijingDayOffset(0)}
    `;
    expect(rows).toEqual([]);
  }

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    certificatesB = appB.get(CertificatesService);

    const adminUser = await createTestUser(appA, {
      username: 'cert-verify-concurrency-admin',
      role: Role.SUPER_ADMIN,
    });
    admin = {
      id: adminUser.id,
      username: adminUser.username,
      role: adminUser.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    memberId = (
      await prismaA.member.create({
        data: { memberNo: 'cvc-m-1', displayName: 'CVC Member' },
        select: { id: true },
      })
    ).id;

    const dictType = await prismaA.dictType.create({
      data: { code: 'cert_type', label: '证书大类' },
      select: { id: true },
    });
    await prismaA.dictItem.create({
      data: { typeId: dictType.id, code: 'first_aid', label: '救护员' },
    });

    standardId = (
      await prismaA.certificateStandard.create({
        data: {
          code: 'cvc-first-aid',
          name: '红十字急救员证',
          kind: 'CREDENTIAL',
          status: 'ACTIVE',
          categoryCode: 'first_aid',
        },
        select: { id: true },
      })
    ).id;
    await prismaA.certificateRecognitionPolicy.create({
      data: {
        standardId,
        version: 1,
        status: 'ACTIVE',
        issuerPolicy: 'FREE_TEXT',
        validityMode: CertificateValidityMode.EXPLICIT_OPTIONAL,
        certNumberMode: 'OPTIONAL',
      },
    });
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  it('两个 app 确实是两条独立连接(否则下面的锁等待全是自欺)', async () => {
    expect(prismaA).not.toBe(prismaB);
    const [[a], [b]] = await Promise.all([
      prismaA.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(a?.pid).not.toBe(b?.pid);
  });

  // ===== ⑦-1 改早 → 应写 expired =====

  it('PATCH expiredAt 改早 vs verify:到期日先被改到过去 → 核验必须落 expired', async () => {
    const cert = await createPendingCert(beijingDayOffset(30));
    const blocker = setExpiredAtAfterLock(cert.id, beijingDayOffset(-1));
    await blocker.ready;

    const verifying = certificatesB.verify(memberId, cert.id, { verifyNote: '核验' }, admin, meta);
    await waitForCertificateLockWaiters(1);
    blocker.release();
    await blocker.done;

    // 修复前:`before` 读于 claimAtStatus **之前**,`alreadyExpired` 用的是锁前那份
    // 「30 天后到期」的快照 —— 于是一张最后有效日已经在昨天的证书被写成 verified,
    // 而到期扫描 cron 要到次日 09:00 才会纠正它。这段时间里资质查询一律认它有效。
    const dto = await verifying;
    expect(dto.certStatusCode).toBe('expired');
    const row = await prismaA.certificate.findUniqueOrThrow({
      where: { id: cert.id },
      select: { certStatusCode: true, expiredAt: true, verifiedAt: true },
    });
    expect(row.certStatusCode).toBe('expired');
    expect(row.expiredAt).toEqual(beijingDayOffset(-1));
    expect(row.verifiedAt).not.toBeNull();
    await assertNoVerifiedCertificateAlreadyExpired();
  });

  // ===== ⑦-2 改晚 → 应写 verified =====

  it('PATCH expiredAt 改晚 vs verify:到期日先被延到将来 → 核验必须落 verified', async () => {
    const cert = await createPendingCert(beijingDayOffset(-5));
    const blocker = setExpiredAtAfterLock(cert.id, beijingDayOffset(365));
    await blocker.ready;

    const verifying = certificatesB.verify(memberId, cert.id, { verifyNote: '核验' }, admin, meta);
    await waitForCertificateLockWaiters(1);
    blocker.release();
    await blocker.done;

    // 反方向同样是缺陷:锁前快照说「5 天前就过期了」,于是一张刚被续期到明年的证书
    // 被写成 expired,持证人凭空少了一年资质。两个方向都要,只测一侧证明不了
    // 「用的是锁后事实」—— 只能证明它在那一侧碰巧猜对了。
    const dto = await verifying;
    expect(dto.certStatusCode).toBe('verified');
    const row = await prismaA.certificate.findUniqueOrThrow({
      where: { id: cert.id },
      select: { certStatusCode: true, expiredAt: true },
    });
    expect(row.certStatusCode).toBe('verified');
    expect(row.expiredAt).toEqual(beijingDayOffset(365));
    await assertNoVerifiedCertificateAlreadyExpired();
  });

  // ===== ⑦-3 审计 before 同样必须是锁后事实 =====

  it('核验审计的 before 取锁后状态:等锁期间的改动不得让审计记下一个不存在的过去', async () => {
    const cert = await createPendingCert(beijingDayOffset(10));
    const blocker = setExpiredAtAfterLock(cert.id, beijingDayOffset(-2));
    await blocker.ready;

    const verifying = certificatesB.verify(
      memberId,
      cert.id,
      { verifyNote: '锁后审计' },
      admin,
      meta,
    );
    await waitForCertificateLockWaiters(1);
    blocker.release();
    await blocker.done;
    await verifying;

    const audit = await prismaA.auditLog.findFirstOrThrow({
      where: { event: 'certificate.verify', resourceId: cert.id },
      select: { context: true },
    });
    const ctx = audit.context as {
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    };
    // before 的状态位仍是 pending(条件行锁保证了这一点),after 必须是重算后的 expired。
    expect(ctx.before?.status).toBe('pending');
    expect(ctx.after?.status).toBe('expired');
    await assertNoVerifiedCertificateAlreadyExpired();
  });

  // ===== ⑦-4 同文件扫查产物:reject 也只看锁后的行 =====

  it('驳回也在锁后复读:等锁期间改到期日不影响结论,审计 before 仍是锁后的 pending', async () => {
    const cert = await createPendingCert(beijingDayOffset(30));
    const blocker = setExpiredAtAfterLock(cert.id, beijingDayOffset(-3));
    await blocker.ready;

    const rejecting = certificatesB.reject(
      memberId,
      cert.id,
      { verifyNote: '证据不足' },
      admin,
      meta,
    );
    await waitForCertificateLockWaiters(1);
    blocker.release();
    await blocker.done;

    // reject 的落点与到期日无关(恒 rejected),所以这条不是「修复前会错」的用例 ——
    // 它钉的是**形状**:锁之后不再引用锁前快照。少了它,下一刀很容易把
    // `lockedBefore` 改回 `before` 而没有任何东西变红。
    const dto = await rejecting;
    expect(dto.certStatusCode).toBe('rejected');
    const audit = await prismaA.auditLog.findFirstOrThrow({
      where: { event: 'certificate.reject', resourceId: cert.id },
      select: { context: true },
    });
    const ctx = audit.context as {
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    };
    expect(ctx.before?.status).toBe('pending');
    expect(ctx.after?.status).toBe('rejected');
    expect(
      (
        await prismaA.certificate.findUniqueOrThrow({
          where: { id: cert.id },
          select: { expiredAt: true },
        })
      ).expiredAt,
    ).toEqual(beijingDayOffset(-3));
  });

  // ===== 非竞态:既有落点规则不得被这一刀改掉 =====

  it('无并发时落点规则逐字不变:未到期 → verified;已过期 → expired;终身有效 → verified', async () => {
    const future = await createPendingCert(beijingDayOffset(30));
    const past = await createPendingCert(beijingDayOffset(-1));
    const permanent = await createPendingCert(null);

    expect((await certificatesB.verify(memberId, future.id, {}, admin, meta)).certStatusCode).toBe(
      'verified',
    );
    expect((await certificatesB.verify(memberId, past.id, {}, admin, meta)).certStatusCode).toBe(
      'expired',
    );
    expect(
      (await certificatesB.verify(memberId, permanent.id, {}, admin, meta)).certStatusCode,
    ).toBe('verified');
    await assertNoVerifiedCertificateAlreadyExpired();
  });

  it('当天到期(expiredAt = 今天)仍算有效 → verified(边界不得被改成 expired)', async () => {
    const today = await createPendingCert(beijingDayOffset(0));
    expect((await certificatesB.verify(memberId, today.id, {}, admin, meta)).certStatusCode).toBe(
      'verified',
    );
    await assertNoVerifiedCertificateAlreadyExpired();
  });

  it('非 pending 证书不可核验 → 18xxx 状态迁移非法(状态闸不变)', async () => {
    const cert = await createPendingCert(beijingDayOffset(30));
    await certificatesB.verify(memberId, cert.id, {}, admin, meta);
    await expect(certificatesB.verify(memberId, cert.id, {}, admin, meta)).rejects.toMatchObject({
      biz: BizCode.CERTIFICATE_INVALID_STATE_TRANSITION,
    });
  });
});

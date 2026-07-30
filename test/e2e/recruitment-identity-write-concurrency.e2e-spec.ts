import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { PrismaService } from '../../src/database/prisma.service';
import { RecruitmentApplicationReviewService } from '../../src/modules/recruitment/recruitment-application-review.service';
import { RecruitmentIdentityService } from '../../src/modules/recruitment/recruitment-identity.service';
import { RecruitmentPromotionService } from '../../src/modules/recruitment/recruitment-promotion.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 证书标准库 · 第二轮跨模型评审 findings G2:**自助换绑 / 后台改资料 vs 发号**的真并发行为锁。
//
// 被修的窗口:这三条路径都在事务**之外**解析凭证 / 读报名(要调微信、要消费短信码,
// 不能放进事务),随后进事务按**锁前那份快照**无条件写。等锁期间发号可以提交 ——
// 发号会把报名标 `promoted` + `sensitivePurgedAt` 并清空全部 PII。
// 旧请求醒来后把手机 / openid / 地址 / 换绑历史**写回**一行已脱敏的记录,
// 而 `sensitivePurgedAt` 非空会让留存清理 SOP(`WHERE sensitivePurgedAt IS NULL`)
// **永远跳过该行** —— 这一行会永久带着本该删除的 PII。
//
// 编排:blocker 先占住报名行 → 发号排进锁队列(第 1 位)→ 被测操作解析完凭证后排进
// 锁队列(第 2 位)→ 放行。于是发号必然先提交,被测操作醒来时看到的是已脱敏的行。
// **发号用的是真 service**(不是裸 SQL 仿写)—— 清敏字段清单因此不会与实现漂移。

const TX_OPTS = { timeout: 30_000, maxWait: 30_000 } as const;
const meta: AuditMeta = { requestId: 'identity-write-concurrency', ip: null, ua: null };
const FIXED_CODE = '888888'; // SMS DEV_STUB 固定码

describe('recruitment identity/update write concurrency(评审 findings G2:换绑与改资料接入同一把锁)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let identityA: RecruitmentIdentityService;
  let reviewA: RecruitmentApplicationReviewService;
  let promotionB: RecruitmentPromotionService;
  let admin: CurrentUserPayload;

  let cycleId: string;
  let seq = 0;

  /** 等到确实有 `expected` 个连接卡在 recruitment_applications 的行锁上(不用 sleep,见 G1 spec)。 */
  async function waitForApplicationLockWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const [row] = await prismaB.$queryRaw<Array<{ waitingCount: number }>>`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%recruitment_applications%'
      `;
      if ((row?.waitingCount ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected at least ${expected} recruitment_applications row-lock waiter(s)`);
  }

  /** 直插一份可发号的 publicity 报名(建档字段齐备)。 */
  async function createPublicityApp(): Promise<{
    id: string;
    phone: string;
    openid: string;
    wechatCode: string;
  }> {
    seq += 1;
    const phone = `139${40000000 + seq}`; // 11 位规范大陆号(SMS 发码强校验)
    const wechatCode = `iwc-${seq}`;
    const openid = `dev-openid-${wechatCode}`;
    const row = await prismaA.recruitmentApplication.create({
      data: {
        cycleId,
        statusCode: 'publicity',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: `换绑${seq}`,
        idCardNumber: `IWC${String(seq).padStart(6, '0')}`,
        birthDate: new Date('1990-03-07T00:00:00.000Z'),
        genderCode: 'male',
        phone,
        detailedAddress: '深圳市南山区某街道 1 号',
        openid,
        tempNo: `I2026${String(seq).padStart(4, '0')}`,
        phoneChangeReason: null,
      },
      select: { id: true },
    });
    return { id: row.id, phone, openid, wechatCode };
  }

  /** 占住报名行,直到 release()。 */
  function holdApplicationLock(applicationId: string): {
    ready: Promise<void>;
    release: () => void;
    done: Promise<void>;
  } {
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
        SELECT "id" FROM "recruitment_applications"
        WHERE "id" = ${applicationId} FOR NO KEY UPDATE
      `;
      signalReady();
      await gate;
    }, TX_OPTS);
    return { ready, release: () => doRelease(), done };
  }

  /** 占住报名行 → 通知 → 等放行 → **在同一事务内**改事实 → 提交(镜像 G1 spec 的同名 helper)。 */
  function mutateAfterLock(
    applicationId: string,
    mutate: (tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0]) => Promise<void>,
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
        SELECT "id" FROM "recruitment_applications"
        WHERE "id" = ${applicationId} FOR NO KEY UPDATE
      `;
      signalReady();
      await gate;
      await mutate(tx);
    }, TX_OPTS);
    return { ready, release: () => doRelease(), done };
  }

  /**
   * 让**真发号**赢在前面,被测操作排在它后面醒来。
   *
   * `startContender` 在发号已排队之后才调用 —— 它的凭证解析 / 快照读发生在
   * 报名仍然活跃、PII 仍然完整的时刻,这正是被修的那个窗口。
   */
  async function promoteWinsThen<T>(
    applicationId: string,
    startContender: () => Promise<T>,
  ): Promise<{ contender: Promise<T> }> {
    const blocker = holdApplicationLock(applicationId);
    await blocker.ready;

    const promoting = promotionB.promoteSingle(applicationId, admin, meta, new Date());
    await waitForApplicationLockWaiters(1);

    const contender = startContender();
    // 吞掉 unhandled rejection:断言在调用方,这里只保证它已经进入锁队列。
    contender.catch(() => undefined);
    await waitForApplicationLockWaiters(2);

    blocker.release();
    await blocker.done;
    await promoting; // 发号必须成功 —— 它是这一局的赢家
    return { contender };
  }

  /**
   * 全库巡检②:`sensitivePurgedAt IS NOT NULL` 的报名不得含任何应清 PII。
   *
   * 字段清单逐字对齐 `recruitment-promotion.service.ts` 标 promoted 那一段的清敏写入。
   * 它是「已脱敏」这个断言的全部内容:留存清理 SOP 从此永远跳过这些行,
   * 漏一列就是永久残留。
   */
  async function assertPurgedRowsCarryNoPii(): Promise<void> {
    const rows = await prismaA.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "recruitment_applications"
      WHERE "sensitivePurgedAt" IS NOT NULL
        AND (
          "realName" IS NOT NULL OR "idCardNumber" IS NOT NULL OR "birthDate" IS NOT NULL
          OR "phone" IS NOT NULL OR "detailedAddress" IS NOT NULL
          OR "emergencyContacts" IS NOT NULL OR "profileExtra" IS NOT NULL
          OR "idCardImageKey" IS NOT NULL OR "openid" IS NOT NULL OR "reviewNote" IS NOT NULL
          OR "signatureImageKey" IS NOT NULL
          OR "ocrAddress" IS NOT NULL OR "ocrNation" IS NOT NULL
          OR "ocrAuthority" IS NOT NULL OR "ocrValidDate" IS NOT NULL
          OR "idCardCropImageKey" IS NOT NULL OR "idCardPortraitImageKey" IS NOT NULL
          OR "phoneChangeReason" IS NOT NULL OR "phoneBindingHistory" IS NOT NULL
        )
    `;
    expect(rows).toEqual([]);
  }

  beforeAll(async () => {
    process.env.RECRUITMENT_THROTTLE_LIMIT = '100';
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    identityA = appA.get(RecruitmentIdentityService);
    reviewA = appA.get(RecruitmentApplicationReviewService);
    promotionB = appB.get(RecruitmentPromotionService);

    const adminUser = await createTestUser(appA, {
      username: 'identity-write-concurrency-admin',
      role: Role.SUPER_ADMIN,
    });
    admin = {
      id: adminUser.id,
      username: adminUser.username,
      role: adminUser.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    cycleId = (
      await prismaA.recruitmentCycle.create({
        data: { year: 2026, name: '2026 年度招新', statusCode: 'open' },
        select: { id: true },
      })
    ).id;
    await prismaA.organization.create({
      data: { name: '志愿者', code: 'VOL', nodeTypeCode: 'volunteer', status: 'ACTIVE' },
    });
    await prismaA.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prismaA.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
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

  // ===== ④ 微信换绑 vs 发号 =====

  it('微信换绑 vs 发号:发号先提交 → 换绑必须拒,不得把 openid 写回已脱敏行', async () => {
    const target = await createPublicityApp();
    await identityA.sendCode(target.phone, null);

    const { contender } = await promoteWinsThen(target.id, () =>
      identityA.rebindWechat(
        { phone: target.phone, code: FIXED_CODE, newWechatCode: `new-${seq}` },
        meta,
      ),
    );

    // 修复前:事务内只做冲突查询,然后按 id 无条件 `update({ data: { openid } })` ——
    // 一行已经 promoted + sensitivePurgedAt 的报名被重新写上 openid,
    // 而留存清理从此永远跳过它。
    await expect(contender).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    });

    const after = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: { statusCode: true, openid: true, sensitivePurgedAt: true },
    });
    expect(after.statusCode).toBe('promoted');
    expect(after.openid).toBeNull();
    expect(after.sensitivePurgedAt).not.toBeNull();
    expect(
      await prismaA.auditLog.count({
        where: { event: 'recruitment-application.rebind-wechat', resourceId: target.id },
      }),
    ).toBe(0);
    await assertPurgedRowsCarryNoPii();
  });

  // ===== ⑤ 手机换绑 vs 发号 =====

  it('手机换绑 vs 发号:发号先提交 → 换绑必须拒,不得把手机 / 换绑历史写回已脱敏行', async () => {
    const target = await createPublicityApp();
    const newPhone = `139${50000000 + seq}`;
    await identityA.sendCode(target.phone, null);
    await identityA.sendCode(newPhone, null);

    const { contender } = await promoteWinsThen(target.id, () =>
      identityA.rebindPhone(
        {
          phone: target.phone,
          code: FIXED_CODE,
          newPhone,
          newPhoneCode: FIXED_CODE,
          reason: '换号',
        },
        meta,
        new Date(),
      ),
    );

    // 修复前:除了 phone 本身,还会把 `phoneBindingHistory`(含**明文旧手机号**)
    // 和 `phoneChangeReason`(自由文本,可含 PII)写进已脱敏行 ——
    // 而且历史是从事务**外**那份快照拼出来的,连锁后的事实都不是。
    await expect(contender).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    });

    const after = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: {
        statusCode: true,
        phone: true,
        phoneBindingHistory: true,
        phoneChangeReason: true,
        sensitivePurgedAt: true,
      },
    });
    expect(after.statusCode).toBe('promoted');
    expect(after.phone).toBeNull();
    expect(after.phoneBindingHistory).toBeNull();
    expect(after.phoneChangeReason).toBeNull();
    expect(after.sensitivePurgedAt).not.toBeNull();
    await assertPurgedRowsCarryNoPii();
  });

  // ===== ⑥ 后台改资料 vs 发号 =====

  it('后台改资料 vs 发号:发号先提交 → 改资料必须拒(28041),不得把住址写回已脱敏行', async () => {
    const target = await createPublicityApp();

    const { contender } = await promoteWinsThen(target.id, () =>
      reviewA.updateApplication(
        target.id,
        { detailedAddress: '不该写入的新住址 9 号' },
        admin,
        meta,
        new Date(),
      ),
    );

    // 修复前:`promoted` / `sensitivePurgedAt` 两道守卫都建立在**锁前**的 findFirst 上,
    // 于是它们看到的是一行仍然活跃、仍未脱敏的报名 —— 守卫全过,住址照写。
    await expect(contender).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
    });

    const after = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: { statusCode: true, detailedAddress: true, sensitivePurgedAt: true },
    });
    expect(after.statusCode).toBe('promoted');
    expect(after.detailedAddress).toBeNull();
    expect(after.sensitivePurgedAt).not.toBeNull();
    expect(
      await prismaA.auditLog.count({
        where: { event: 'recruitment-application.update', resourceId: target.id },
      }),
    ).toBe(0);
    await assertPurgedRowsCarryNoPii();
  });

  // ===== 非竞态:三条路径的既有行为不得被这一刀改掉 =====

  it('正常微信换绑仍然可用(锁不误伤本人)', async () => {
    const target = await createPublicityApp();
    await identityA.sendCode(target.phone, null);
    await identityA.rebindWechat(
      { phone: target.phone, code: FIXED_CODE, newWechatCode: `ok-${seq}` },
      meta,
    );
    expect(
      (
        await prismaA.recruitmentApplication.findUniqueOrThrow({
          where: { id: target.id },
          select: { openid: true },
        })
      ).openid,
    ).toBe(`dev-openid-ok-${seq}`);
  });

  it('正常手机换绑仍然可用,且换绑历史从**锁后**的行生成', async () => {
    const target = await createPublicityApp();
    const newPhone = `139${60000000 + seq}`;
    await identityA.sendCode(target.phone, null);
    await identityA.sendCode(newPhone, null);
    await identityA.rebindPhone(
      { phone: target.phone, code: FIXED_CODE, newPhone, newPhoneCode: FIXED_CODE, reason: '换号' },
      meta,
      new Date(),
    );
    const after = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: { phone: true, phoneBindingHistory: true, phoneChangeReason: true },
    });
    expect(after.phone).toBe(newPhone);
    expect(after.phoneChangeReason).toBe('换号');
    expect(after.phoneBindingHistory).toEqual([
      expect.objectContaining({ from: target.phone, to: newPhone, reason: '换号', method: 'sms' }),
    ]);
  });

  it('换绑历史是追加而不是覆盖(既有历史不得被抹掉)', async () => {
    const target = await createPublicityApp();
    const newPhone = `139${70000000 + seq}`;
    const prior = {
      from: '13900000000',
      to: target.phone,
      at: '2026-07-01T00:00:00.000Z',
      reason: '首次换绑',
      method: 'sms',
    };
    await prismaA.recruitmentApplication.update({
      where: { id: target.id },
      data: { phoneBindingHistory: [prior] },
    });
    await identityA.sendCode(target.phone, null);
    await identityA.sendCode(newPhone, null);
    await identityA.rebindPhone(
      { phone: target.phone, code: FIXED_CODE, newPhone, newPhoneCode: FIXED_CODE },
      meta,
      new Date(),
    );
    const after = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: { phone: true, phoneBindingHistory: true },
    });
    expect(after.phone).toBe(newPhone);
    expect(after.phoneBindingHistory).toEqual([
      prior,
      expect.objectContaining({ from: target.phone, to: newPhone }),
    ]);
  });

  it('两个手机换绑竞速:先到的赢 → 后到的必须拒,且**不得用事务外快照覆盖历史**', async () => {
    const target = await createPublicityApp();
    const winnerPhone = `139${90000000 + seq}`; // 先提交的那次换到这个号
    const loserPhone = `138${10000000 + seq}`; // 后到的那次本想换到这个号
    await identityA.sendCode(target.phone, null);
    await identityA.sendCode(loserPhone, null);

    // blocker 在窗口里完成一次「等价于 rebindPhone 成功」的提交:
    // phone 换成 winnerPhone,历史追加一条。用裸 SQL 是因为真 service 要的
    // 正是 blocker 手里这把锁(调它必然自锁),语义由下面的断言兜住。
    const blocker = mutateAfterLock(target.id, async (tx) => {
      await tx.$executeRaw`
        UPDATE "recruitment_applications"
        SET "phone" = ${winnerPhone},
            "phoneBindingHistory" = ${JSON.stringify([
              {
                from: target.phone,
                to: winnerPhone,
                at: '2026-07-31T00:00:00.000Z',
                reason: 'self-rebind',
                method: 'sms',
              },
            ])}::jsonb
        WHERE "id" = ${target.id}
      `;
    });
    await blocker.ready;

    const losing = identityA.rebindPhone(
      { phone: target.phone, code: FIXED_CODE, newPhone: loserPhone, newPhoneCode: FIXED_CODE },
      meta,
      new Date(),
    );
    losing.catch(() => undefined);
    await waitForApplicationLockWaiters(1);
    blocker.release();
    await blocker.done;

    // 修复前:后到的那次按事务**外**读到的 `priorHistory`(此刻还是空)拼出新历史,
    // 然后按 id 无条件写 —— 先到那次的换绑记录被**整条抹掉**,
    // 而手机号也被换成了一个用户在旧凭证下才请求过的号。
    await expect(losing).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    });
    const after = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: { phone: true, phoneBindingHistory: true },
    });
    expect(after.phone).toBe(winnerPhone);
    expect(after.phoneBindingHistory).toEqual([
      expect.objectContaining({ from: target.phone, to: winnerPhone }),
    ]);
  });

  it('正常后台改资料仍然可用(非身份字段恒可改)', async () => {
    const target = await createPublicityApp();
    const dto = await reviewA.updateApplication(
      target.id,
      { detailedAddress: '深圳市福田区某路 8 号' },
      admin,
      meta,
      new Date(),
    );
    expect(dto.id).toBe(target.id);
    expect(
      (
        await prismaA.recruitmentApplication.findUniqueOrThrow({
          where: { id: target.id },
          select: { detailedAddress: true },
        })
      ).detailedAddress,
    ).toBe('深圳市福田区某路 8 号');
  });

  it('终态报名(withdrawn)不可再被后台改资料 —— 锁内终态闸', async () => {
    const target = await createPublicityApp();
    await prismaA.recruitmentApplication.update({
      where: { id: target.id },
      data: { statusCode: 'withdrawn' },
    });
    await expect(
      reviewA.updateApplication(
        target.id,
        { detailedAddress: '不该写入' },
        admin,
        meta,
        new Date(),
      ),
    ).rejects.toMatchObject({ biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE });
  });

  it('已脱敏但未 promoted 的行(留存清理已跑过)同样不可改 —— 独立于状态的那道轴', async () => {
    const target = await createPublicityApp();
    await prismaA.recruitmentApplication.update({
      where: { id: target.id },
      data: {
        statusCode: 'verified',
        sensitivePurgedAt: new Date(),
        realName: null,
        idCardNumber: null,
        birthDate: null,
        phone: null,
        detailedAddress: null,
        openid: null,
      },
    });
    await expect(
      reviewA.updateApplication(
        target.id,
        { detailedAddress: '不该写入' },
        admin,
        meta,
        new Date(),
      ),
    ).rejects.toMatchObject({ biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE });
    await assertPurgedRowsCarryNoPii();
  });
});

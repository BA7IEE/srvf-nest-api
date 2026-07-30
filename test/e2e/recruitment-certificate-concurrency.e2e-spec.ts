import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { PrismaService } from '../../src/database/prisma.service';
import { RecruitmentCertificateClaimsService } from '../../src/modules/recruitment/recruitment-certificate-claims.service';
import { RecruitmentPromotionService } from '../../src/modules/recruitment/recruitment-promotion.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 证书标准库 · 跨模型评审 findings F1:发号 / 申报 / 撤销三条写路径的**真并发**行为锁。
//
// 为什么这组用例必须用真 PostgreSQL 行锁而不是 mock 或串行调用:
// 被修的缺陷形状是「读到的状态」与「写入时的状态」之间存在一个窗口 ——
// 串行调用永远走不进那个窗口(读完立刻就写),mock 则根本没有窗口的概念。
// 只有让两个真实连接抢同一把行锁,窗口才会被撑开到可观测。
//
// 构造手法沿仓库既有的 `activity-publish-review-concurrency`:
// 一个 blocker 事务先占住目标行,把被测操作逼到锁等待队列里,再释放。
// 差别是本组要的不是对称竞态而是**指定顺序**(「撤销先提交、发号后拿到锁」),
// 所以 blocker 自己在同一事务里完成状态迁移 —— 让被测操作醒来时看到的
// 必然是已经变过的行。用真 service 跑撤销做不到这一点:它要的正是 blocker 手里那把锁。
//
// 每条用例都标注了**修复前**的表现,那是这些断言存在的理由。

const CLAIM_APPROVED = 'APPROVED';
const CLAIM_SUBMITTED = 'SUBMITTED';
const CLAIM_WITHDRAWN = 'WITHDRAWN';

const TX_OPTS = { timeout: 30_000, maxWait: 30_000 } as const;
const meta: AuditMeta = { requestId: 'cert-concurrency', ip: null, ua: null };

/** 最小合法 JPEG:魔数 `FF D8 FF` + 填充(AttachmentContentValidator 只看前 12 字节)。 */
function jpegBuffer(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
}

function uploadFile(name: string) {
  const buffer = jpegBuffer();
  return {
    fieldname: 'images',
    originalname: name,
    mimetype: 'image/jpeg',
    size: buffer.length,
    buffer,
  };
}

describe('recruitment certificate concurrency(评审 findings F1:锁后复读 + CAS)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let promotionB: RecruitmentPromotionService;
  let claimsB: RecruitmentCertificateClaimsService;
  let admin: CurrentUserPayload;

  let cycleId: string;
  let standardId: string;
  let policyId: string;
  let issuerId: string;
  let seq = 0;

  /**
   * 等到确实有 `expected` 个连接卡在 recruitment_applications 的行锁上。
   *
   * 不用 sleep:sleep 要么不够(用例假绿 —— 被测操作还没进锁就 release 了)
   * 要么太长(整组变慢)。查 pg_stat_activity 是唯一能确认「它真的在等锁」的办法。
   */
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

  /** 直插一份 publicity 报名(建档字段齐备 → 可发号)。 */
  async function createPublicityApp(): Promise<{ id: string; wechatCode: string }> {
    seq += 1;
    const wechatCode = `ccc-${seq}`;
    const row = await prismaA.recruitmentApplication.create({
      data: {
        cycleId,
        statusCode: 'publicity',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: `并发${seq}`,
        idCardNumber: `CCC${String(seq).padStart(6, '0')}`,
        birthDate: new Date('1990-03-07T00:00:00.000Z'),
        genderCode: 'male',
        phone: `1391000${String(1000 + seq).slice(-4)}`,
        detailedAddress: '深圳市南山区某街道 1 号',
        openid: `dev-openid-${wechatCode}`,
        tempNo: `T2026${String(seq).padStart(4, '0')}`,
      },
      select: { id: true },
    });
    return { id: row.id, wechatCode };
  }

  async function createApprovedClaim(applicationId: string): Promise<{ id: string }> {
    return prismaA.recruitmentCertificateClaim.create({
      data: {
        applicationId,
        status: CLAIM_APPROVED,
        categoryHintCode: 'first_aid',
        rawCertificateName: '红十字急救员证',
        standardId,
        recognitionPolicyId: policyId,
        recognitionIssuerId: issuerId,
        issuingOrg: '深圳市红十字会',
        certNumber: `SZ-CCC-${seq}`,
        issuedAt: new Date('2026-01-31T00:00:00.000Z'),
        imageKeys: ['recruitment/certificate-claim/x.jpg'],
      },
      select: { id: true },
    });
  }

  /**
   * blocker:占住报名行 → 通知调用方 → 等放行 → **在同一事务内**完成整份撤销 → 提交。
   *
   * 撤销用裸 SQL 而不是 `RecruitmentIdentityService.withdraw`:后者要拿的正是
   * blocker 手里这把锁,调它必然自锁。语义与它逐字对齐(状态 + 非 PROMOTED Claim 级联),
   * 由下方 `期望的级联语义` 断言兜住 —— 若哪天 service 侧改了口径,这里会跟着红。
   */
  function withdrawAfterLock(applicationId: string): {
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
      await tx.$executeRaw`
        UPDATE "recruitment_applications" SET "statusCode" = 'withdrawn' WHERE "id" = ${applicationId}
      `;
      await tx.$executeRaw`
        UPDATE "RecruitmentCertificateClaim"
        SET "status" = 'WITHDRAWN'::"RecruitmentCertificateClaimStatus"
        WHERE "applicationId" = ${applicationId}
          AND "status" <> 'PROMOTED'::"RecruitmentCertificateClaimStatus"
          AND "deletedAt" IS NULL
      `;
    }, TX_OPTS);
    return { ready, release: () => doRelease(), done };
  }

  /** §DoD 第 5 条:终态报名下不得存在非终态 Claim —— 数据库级全表巡检。 */
  async function assertNoNonTerminalClaimUnderTerminalApplication(): Promise<void> {
    const rows = await prismaA.$queryRaw<Array<{ claimId: string; appStatus: string; s: string }>>`
      SELECT c."id" AS "claimId", a."statusCode" AS "appStatus", c."status"::text AS s
      FROM "RecruitmentCertificateClaim" c
      JOIN "recruitment_applications" a ON a."id" = c."applicationId"
      WHERE c."deletedAt" IS NULL
        AND a."deletedAt" IS NULL
        AND a."statusCode" IN ('promoted', 'withdrawn', 'rejected')
        AND c."status" NOT IN (
          'PROMOTED'::"RecruitmentCertificateClaimStatus",
          'WITHDRAWN'::"RecruitmentCertificateClaimStatus"
        )
    `;
    expect(rows).toEqual([]);
  }

  /** 每张正式证书都必须挂在一条 PROMOTED 且事实完整的 Claim 上。 */
  async function assertEveryCertificateBackedByPromotedClaim(): Promise<void> {
    const orphans = await prismaA.$queryRaw<Array<{ certId: string }>>`
      SELECT ct."id" AS "certId"
      FROM "Certificate" ct
      LEFT JOIN "RecruitmentCertificateClaim" c ON c."id" = ct."sourceClaimId"
      WHERE ct."deletedAt" IS NULL
        AND ct."sourceCode" = 'RECRUITMENT'
        AND (
          c."id" IS NULL
          OR c."status" <> 'PROMOTED'::"RecruitmentCertificateClaimStatus"
          OR c."standardId" IS NULL
        )
    `;
    expect(orphans).toEqual([]);
  }

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    promotionB = appB.get(RecruitmentPromotionService);
    claimsB = appB.get(RecruitmentCertificateClaimsService);

    const adminUser = await createTestUser(appA, {
      username: 'cert-concurrency-admin',
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

    // promote 依赖:VOL 归口部门(缺它整批 28044)。
    await prismaA.organization.create({
      data: { name: '志愿者', code: 'VOL', nodeTypeCode: 'volunteer', status: 'ACTIVE' },
    });

    // 公开面申报走微信凭证:DEV_STUB 按 code 返确定性 `dev-openid-<code>`,
    // 与 createPublicityApp 写进报名行的 openid 对上。
    await prismaA.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

    const certType = await prismaA.dictType.create({
      data: { code: 'cert_type', label: '证书大类' },
      select: { id: true },
    });
    await prismaA.dictItem.createMany({
      data: [
        { typeId: certType.id, code: 'first_aid', label: '急救' },
        { typeId: certType.id, code: 'bsafe', label: 'BSAFE' },
      ],
    });

    standardId = (
      await prismaA.certificateStandard.create({
        data: {
          code: 'ccc-first-aid',
          name: '红十字急救员证',
          kind: 'CREDENTIAL',
          status: 'ACTIVE',
          categoryCode: 'first_aid',
        },
        select: { id: true },
      })
    ).id;
    policyId = (
      await prismaA.certificateRecognitionPolicy.create({
        data: {
          standardId,
          version: 1,
          status: 'ACTIVE',
          issuerPolicy: 'ALLOWLIST',
          validityMode: 'EXPLICIT_OPTIONAL',
          certNumberMode: 'OPTIONAL',
        },
        select: { id: true },
      })
    ).id;
    issuerId = (
      await prismaA.certificateRecognitionIssuer.create({
        data: { policyId, name: '深圳市红十字会', normalizedName: '深圳市红十字会' },
        select: { id: true },
      })
    ).id;
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

  // ===== ① 批量发号 vs 报名撤销 =====

  it('批量发号 vs 报名撤销:撤销先提交 → 发号必须整批拒(28041),不得把 withdrawn 改写成 promoted', async () => {
    const target = await createPublicityApp();
    await createApprovedClaim(target.id);

    const blocker = withdrawAfterLock(target.id);
    await blocker.ready;

    // promote 的「谁可发号」在事务外算(此刻仍是 publicity),随后进事务卡在报名行锁上。
    const promoting = promotionB.promote(cycleId, admin, meta, new Date());
    await waitForApplicationLockWaiters(1);
    blocker.release();
    await blocker.done;

    // 修复前:发号从不锁也不复读报名,醒来后按事务外快照无条件写
    // `statusCode='promoted'` —— 一份用户已经撤销的报名被强行发号建人。
    await expect(promoting).rejects.toBeInstanceOf(BizException);
    await expect(promoting).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
    });

    const after = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: { statusCode: true, promotedMemberId: true },
    });
    expect(after.statusCode).toBe('withdrawn');
    expect(after.promotedMemberId).toBeNull();
    // 整批回滚 = 一个 Member / Certificate 都不留(号段亦随事务回滚,无空洞)。
    expect(await prismaA.certificate.count({ where: { sourceCode: 'RECRUITMENT' } })).toBe(0);
    await assertNoNonTerminalClaimUnderTerminalApplication();
  });

  // ===== ② 单人发号 vs 报名撤销 =====

  it('单人发号 vs 报名撤销:同一内核 → 同样 28041,且不建 Member', async () => {
    const target = await createPublicityApp();
    const membersBefore = await prismaA.member.count();

    const blocker = withdrawAfterLock(target.id);
    await blocker.ready;

    const promoting = promotionB.promoteSingle(target.id, admin, meta, new Date());
    await waitForApplicationLockWaiters(1);
    blocker.release();
    await blocker.done;

    await expect(promoting).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
    });
    expect(await prismaA.member.count()).toBe(membersBefore);
    expect(
      (
        await prismaA.recruitmentApplication.findUniqueOrThrow({
          where: { id: target.id },
          select: { statusCode: true },
        })
      ).statusCode,
    ).toBe('withdrawn');
  });

  // ===== ③ 发号 vs Claim 撤回审核 =====

  it('发号 vs 撤回审核:撤回先提交 → 发号必须看见锁后的 SUBMITTED,绝不按旧快照建证', async () => {
    const target = await createPublicityApp();
    const claim = await createApprovedClaim(target.id);

    // 这一条卡的是**Claim 行锁**而不是报名行锁 —— 被测的正是「发号读 Claim 集合」
    // 与「发号按该集合建证」之间那个窗口。blocker 在窗口里完成一次撤回审核并提交。
    let signalReady!: () => void;
    let doRelease!: () => void;
    const ready = new Promise<void>((r) => {
      signalReady = r;
    });
    const gate = new Promise<void>((r) => {
      doRelease = r;
    });
    const revokeInsideWindow = prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "RecruitmentCertificateClaim"
        WHERE "id" = ${claim.id} FOR UPDATE
      `;
      signalReady();
      await gate;
      // 与 revokeReview 逐字同义:回 SUBMITTED 并清空锁定的标准化结论。
      await tx.$executeRaw`
        UPDATE "RecruitmentCertificateClaim"
        SET "status" = 'SUBMITTED'::"RecruitmentCertificateClaimStatus",
            "standardId" = NULL,
            "recognitionPolicyId" = NULL,
            "recognitionIssuerId" = NULL,
            "version" = "version" + 1
        WHERE "id" = ${claim.id}
      `;
    }, TX_OPTS);
    await ready;

    const promoting = promotionB.promoteSingle(target.id, admin, meta, new Date());
    // 等发号真的卡在 Claim 行锁上(而不是还没走到那一步)。
    const deadline = Date.now() + 15_000;
    for (;;) {
      const [row] = await prismaB.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query LIKE '%RecruitmentCertificateClaim%'
      `;
      if ((row?.n ?? 0) >= 1) break;
      if (Date.now() > deadline) throw new Error('expected a Claim row-lock waiter');
      await new Promise((r) => setTimeout(r, 20));
    }
    doRelease();
    await revokeInsideWindow;
    await promoting;

    // 修复前:发号先 findMany(APPROVED) 拿快照、再 FOR UPDATE、然后**用锁前那份快照**建证 ——
    // 于是一条已被撤回审核的申报照样被建成正式证书,而且 Claim 被写成
    // `status=PROMOTED` 却 `standardId=NULL`(锁前快照有、库里已被清空)。
    // 修复后锁内重新查询,看到的是 SUBMITTED,一张证书都不建。
    const finalClaim = await prismaA.recruitmentCertificateClaim.findUniqueOrThrow({
      where: { id: claim.id },
      select: { status: true, standardId: true },
    });
    expect(finalClaim.status).toBe(CLAIM_WITHDRAWN); // 发号收尾把非 APPROVED 一并终结
    expect(await prismaA.certificate.count({ where: { sourceClaimId: claim.id } })).toBe(0);
    await assertEveryCertificateBackedByPromotedClaim();
    await assertNoNonTerminalClaimUnderTerminalApplication();
  });

  // ===== ④ 公开面 Claim 提交 / 重传 vs 报名撤销 =====

  it('公开提交 vs 报名撤销:撤销先提交 → 新申报必须被拒,不得在 withdrawn 报名下留 SUBMITTED', async () => {
    const target = await createPublicityApp();

    const blocker = withdrawAfterLock(target.id);
    await blocker.ready;

    // 凭证在事务外解析(此刻报名仍活跃),随后进事务卡在锁上 —— 正是被修的那个窗口。
    const submitting = claimsB.submitPublic(
      { wechatCode: target.wechatCode, categoryHintCode: 'first_aid' },
      [uploadFile('a.jpg')],
      meta,
    );
    await waitForApplicationLockWaiters(1);
    blocker.release();
    await blocker.done;

    // 修复前:`lockApplication` 只 `SELECT id FOR UPDATE` 且返回 void,
    // 锁后既不复核状态也不复核归属 → 已撤销报名照样新增一条 SUBMITTED 申报。
    await expect(submitting).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
    });
    expect(
      await prismaA.recruitmentCertificateClaim.count({ where: { applicationId: target.id } }),
    ).toBe(0);
    await assertNoNonTerminalClaimUnderTerminalApplication();
  });

  it('公开重传 vs 报名撤销:同一道闸 —— 已撤销报名下的旧申报不可再被重传拉回 SUBMITTED', async () => {
    const target = await createPublicityApp();
    const claim = await prismaA.recruitmentCertificateClaim.create({
      data: {
        applicationId: target.id,
        status: CLAIM_SUBMITTED,
        categoryHintCode: 'first_aid',
        imageKeys: ['recruitment/certificate-claim/old.jpg'],
      },
      select: { id: true, version: true },
    });

    const blocker = withdrawAfterLock(target.id);
    await blocker.ready;

    const resubmitting = claimsB.resubmitPublic(
      claim.id,
      {
        wechatCode: target.wechatCode,
        categoryHintCode: 'first_aid',
        version: claim.version,
      },
      [uploadFile('b.jpg')],
      meta,
    );
    await waitForApplicationLockWaiters(1);
    blocker.release();
    await blocker.done;

    await expect(resubmitting).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
    });
    expect(
      (
        await prismaA.recruitmentCertificateClaim.findUniqueOrThrow({
          where: { id: claim.id },
          select: { status: true },
        })
      ).status,
    ).toBe(CLAIM_WITHDRAWN);
    await assertNoNonTerminalClaimUnderTerminalApplication();
  });

  // ===== ⑤ 不需要并发就能复现的一条:发号只终结 APPROVED =====

  it('发号收尾级联:非 APPROVED 申报必须一并终结 —— 否则 promoted 报名下永久残留可审核的 SUBMITTED', async () => {
    const target = await createPublicityApp();
    await createApprovedClaim(target.id);
    const leftover = await prismaA.recruitmentCertificateClaim.create({
      data: {
        applicationId: target.id,
        status: CLAIM_SUBMITTED,
        categoryHintCode: 'bsafe',
        imageKeys: ['recruitment/certificate-claim/leftover.jpg'],
      },
      select: { id: true },
    });

    await promotionB.promoteSingle(target.id, admin, meta, new Date());

    // 修复前:发号只把 APPROVED 搬成 PROMOTED,这条 SUBMITTED 原封不动留在一份
    // 已经终态的报名下 —— 它永远不会再变成证书,却仍可被审核、仍可签发证据 URL。
    expect(
      (
        await prismaA.recruitmentCertificateClaim.findUniqueOrThrow({
          where: { id: leftover.id },
          select: { status: true },
        })
      ).status,
    ).toBe(CLAIM_WITHDRAWN);
    await assertNoNonTerminalClaimUnderTerminalApplication();
    await assertEveryCertificateBackedByPromotedClaim();
  });
});

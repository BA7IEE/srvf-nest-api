import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { PrismaService } from '../../src/database/prisma.service';
import { RecruitmentApplicationReviewService } from '../../src/modules/recruitment/recruitment-application-review.service';
import { RecruitmentPromotionService } from '../../src/modules/recruitment/recruitment-promotion.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 证书标准库 · 第二轮跨模型评审 findings G1:**评定**这条写路径的真并发行为锁。
//
// 手法逐字沿用 `recruitment-certificate-concurrency.e2e-spec.ts`(F1 那一批):
// 一个 blocker 事务先占住报名行,把被测操作逼进锁等待队列,在窗口里改掉事实再提交。
// 串行调用走不进这个窗口(读完立刻写),mock 则根本没有窗口的概念 ——
// 只有两条真实连接抢同一把 PostgreSQL 行锁,窗口才被撑开到可观测。
//
// 每条用例都标注**修复前**的表现,那是这些断言存在的理由。

const CLAIM_APPROVED = 'APPROVED';

const TX_OPTS = { timeout: 30_000, maxWait: 30_000 } as const;
const meta: AuditMeta = { requestId: 'app-write-concurrency', ip: null, ua: null };

/** 5 项门槛全部完成的标记(评定通过的前置);派生族两项另需 APPROVED Claim 兜住。 */
function completeMarks(): Record<string, { at: string; by: string }> {
  const at = '2026-07-30T00:00:00.000Z';
  return {
    patrol1: { at, by: 'seed' },
    patrol2: { at, by: 'seed' },
    training: { at, by: 'seed' },
    redCross: { at, by: 'system:certificate-claim-derived' },
    bsafe: { at, by: 'system:certificate-claim-derived' },
  };
}

describe('recruitment application write concurrency(评审 findings G1:评定锁后复读 + 门槛复算 + CAS)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let reviewB: RecruitmentApplicationReviewService;
  let promotionB: RecruitmentPromotionService;
  let admin: CurrentUserPayload;

  let cycleId: string;
  let firstAidStandardId: string;
  let bsafeStandardId: string;
  let firstAidPolicyId: string;
  let bsafePolicyId: string;
  let firstAidIssuerId: string;
  let bsafeIssuerId: string;
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

  /** 直插一份「门槛已齐、待评定」的报名(建档字段齐备 → 评定通过即可进公示)。 */
  async function createPendingEvaluationApp(): Promise<{ id: string }> {
    seq += 1;
    return prismaA.recruitmentApplication.create({
      data: {
        cycleId,
        statusCode: 'pending_evaluation',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: `评定${seq}`,
        idCardNumber: `AWC${String(seq).padStart(6, '0')}`,
        birthDate: new Date('1990-03-07T00:00:00.000Z'),
        genderCode: 'male',
        phone: `1392${String(100000 + seq).slice(-6)}`,
        detailedAddress: '深圳市南山区某街道 1 号',
        openid: `dev-openid-awc-${seq}`,
        tempNo: `E2026${String(seq).padStart(4, '0')}`,
        thresholdMarks: completeMarks(),
      },
      select: { id: true },
    });
  }

  /** 两条 APPROVED Claim(first_aid + bsafe)—— 让派生门槛在重算下仍然成立。 */
  async function createApprovedClaims(
    applicationId: string,
  ): Promise<{ firstAidClaimId: string; bsafeClaimId: string }> {
    const mk = async (
      category: string,
      standardId: string,
      policyId: string,
      issuerId: string,
      name: string,
    ) =>
      prismaA.recruitmentCertificateClaim.create({
        data: {
          applicationId,
          status: CLAIM_APPROVED,
          categoryHintCode: category,
          rawCertificateName: name,
          standardId,
          recognitionPolicyId: policyId,
          recognitionIssuerId: issuerId,
          issuingOrg: `${name}发证方`,
          certNumber: `AWC-${category}-${seq}`,
          issuedAt: new Date('2026-01-31T00:00:00.000Z'),
          imageKeys: [`recruitment/certificate-claim/${category}.jpg`],
        },
        select: { id: true },
      });
    const firstAid = await mk(
      'first_aid',
      firstAidStandardId,
      firstAidPolicyId,
      firstAidIssuerId,
      '红十字急救员证',
    );
    const bsafe = await mk('bsafe', bsafeStandardId, bsafePolicyId, bsafeIssuerId, 'BSAFE 证');
    return { firstAidClaimId: firstAid.id, bsafeClaimId: bsafe.id };
  }

  /**
   * blocker:占住报名行 → 通知调用方 → 等放行 → **在同一事务内**改事实 → 提交。
   *
   * 用裸 SQL 而不是真 service:被测操作要拿的正是 blocker 手里这把锁,
   * 调 service 必然自锁。语义与对应 service 逐字对齐,由各用例的断言兜住。
   */
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
   * 全库巡检①:`publicity` 报名不得存在证书门槛不完整的状态。
   *
   * 「门槛完整」按**事实源**(Claim 聚合)判,不看 `thresholdMarks` 投影 ——
   * 用投影查投影只能证明它自洽,证明不了它没落后于事实。
   */
  async function assertNoPublicityWithIncompleteThresholds(): Promise<void> {
    const rows = await prismaA.$queryRaw<Array<{ id: string; missingCount: number }>>`
      SELECT a."id", count(*) FILTER (WHERE sat."categoryCode" IS NULL)::int AS "missingCount"
      FROM "recruitment_applications" a
      CROSS JOIN (VALUES ('first_aid'), ('bsafe')) AS cat(code)
      LEFT JOIN LATERAL (
        SELECT s."categoryCode"
        FROM "RecruitmentCertificateClaim" c
        JOIN "CertificateStandard" s ON s."id" = c."standardId"
        WHERE c."applicationId" = a."id"
          AND c."deletedAt" IS NULL
          AND c."status" IN (
            'APPROVED'::"RecruitmentCertificateClaimStatus",
            'PROMOTED'::"RecruitmentCertificateClaimStatus"
          )
          AND s."categoryCode" = cat.code
        LIMIT 1
      ) sat ON TRUE
      WHERE a."deletedAt" IS NULL AND a."statusCode" = 'publicity'
      GROUP BY a."id"
      HAVING count(*) FILTER (WHERE sat."categoryCode" IS NULL) > 0
    `;
    expect(rows).toEqual([]);
  }

  /**
   * 评审 findings H1:终态报名下不得存在非终态 Claim —— 数据库级全表巡检。
   *
   * 与 `recruitment-certificate-concurrency.e2e-spec.ts` 里那条逐字同款,**刻意重复**:
   * 那份守的是发号与撤销,这份守的是评定;缺陷正是「范式抽出来了但没铺到每条路径」,
   * 所以每条写终态的路径都必须在**自己那组用例里**被这条巡检扫一遍。
   *
   * 这条与本文件那条「正常淘汰照旧可用」曾经是互相矛盾的:修复前淘汰一定留下
   * APPROVED Claim,两条不可能同时绿。现在必须同时绿。
   */
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

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    reviewB = appB.get(RecruitmentApplicationReviewService);
    promotionB = appB.get(RecruitmentPromotionService);

    const adminUser = await createTestUser(appA, {
      username: 'app-write-concurrency-admin',
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

    const makeStandard = async (code: string, name: string, categoryCode: string) => {
      const standard = await prismaA.certificateStandard.create({
        data: { code, name, kind: 'CREDENTIAL', status: 'ACTIVE', categoryCode },
        select: { id: true },
      });
      const policy = await prismaA.certificateRecognitionPolicy.create({
        data: {
          standardId: standard.id,
          version: 1,
          status: 'ACTIVE',
          issuerPolicy: 'ALLOWLIST',
          validityMode: 'EXPLICIT_OPTIONAL',
          certNumberMode: 'OPTIONAL',
        },
        select: { id: true },
      });
      const issuer = await prismaA.certificateRecognitionIssuer.create({
        data: { policyId: policy.id, name: `${name}发证方`, normalizedName: `${name}发证方` },
        select: { id: true },
      });
      return { standardId: standard.id, policyId: policy.id, issuerId: issuer.id };
    };

    const firstAid = await makeStandard('awc-first-aid', '红十字急救员证', 'first_aid');
    firstAidStandardId = firstAid.standardId;
    firstAidPolicyId = firstAid.policyId;
    firstAidIssuerId = firstAid.issuerId;
    const bsafe = await makeStandard('awc-bsafe', 'BSAFE 证', 'bsafe');
    bsafeStandardId = bsafe.standardId;
    bsafePolicyId = bsafe.policyId;
    bsafeIssuerId = bsafe.issuerId;
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

  // ===== ① 评定通过 vs 整份报名撤销 =====

  it('评定通过 vs 整份撤销:撤销先提交 → 评定必须拒(28041),绝不把 withdrawn 改写成 publicity', async () => {
    const target = await createPendingEvaluationApp();
    await createApprovedClaims(target.id);

    const blocker = mutateAfterLock(target.id, async (tx) => {
      await tx.$executeRaw`
        UPDATE "recruitment_applications" SET "statusCode" = 'withdrawn' WHERE "id" = ${target.id}
      `;
      await tx.$executeRaw`
        UPDATE "RecruitmentCertificateClaim"
        SET "status" = 'WITHDRAWN'::"RecruitmentCertificateClaimStatus"
        WHERE "applicationId" = ${target.id}
          AND "status" <> 'PROMOTED'::"RecruitmentCertificateClaimStatus"
          AND "deletedAt" IS NULL
      `;
    });
    await blocker.ready;

    const evaluating = reviewB.evaluate(
      target.id,
      { approved: true, note: '评定通过' },
      admin,
      meta,
      new Date(),
    );
    await waitForApplicationLockWaiters(1);
    blocker.release();
    await blocker.done;

    // 修复前:evaluate 既不锁也不复读,醒来后按锁前快照(pending_evaluation)
    // 无条件 `update({ where: { id } })` —— 一份已撤销的报名被改写成 publicity,
    // 而发号内核只复核「当前是不是 publicity」,于是它随后可以被建人发永久编号。
    await expect(evaluating).rejects.toBeInstanceOf(BizException);
    await expect(evaluating).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
    });

    const after = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: { statusCode: true, evaluatedByUserId: true, evaluatedAt: true },
    });
    expect(after.statusCode).toBe('withdrawn');
    expect(after.evaluatedByUserId).toBeNull();
    expect(after.evaluatedAt).toBeNull();
    await assertNoPublicityWithIncompleteThresholds();
  });

  // ===== ② 评定通过 vs 证书门槛回退(撤回审核)=====

  it('评定通过 vs 撤回审核(投影已同步):门槛回退先提交 → 评定看见锁后的 verified,必须拒', async () => {
    const target = await createPendingEvaluationApp();
    const claims = await createApprovedClaims(target.id);

    // 与 `revokeReview` + `recomputeCertificateThresholds` 逐字同义:
    // Claim 回 SUBMITTED、清 redCross 标记、报名从 pending_evaluation 掉回 verified。
    const blocker = mutateAfterLock(target.id, async (tx) => {
      await tx.$executeRaw`
        UPDATE "RecruitmentCertificateClaim"
        SET "status" = 'SUBMITTED'::"RecruitmentCertificateClaimStatus",
            "standardId" = NULL, "recognitionPolicyId" = NULL, "recognitionIssuerId" = NULL,
            "version" = "version" + 1
        WHERE "id" = ${claims.firstAidClaimId}
      `;
      await tx.$executeRaw`
        UPDATE "recruitment_applications"
        SET "statusCode" = 'verified', "thresholdMarks" = "thresholdMarks" - 'redCross'
        WHERE "id" = ${target.id}
      `;
    });
    await blocker.ready;

    const evaluating = reviewB.evaluate(
      target.id,
      { approved: true, note: '评定通过' },
      admin,
      meta,
      new Date(),
    );
    await waitForApplicationLockWaiters(1);
    blocker.release();
    await blocker.done;

    // 修复前:锁前快照说 pending_evaluation,于是直接写 publicity ——
    // 一份门槛已经回退的报名进了公示,并且带着评定通过的痕迹。
    await expect(evaluating).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
    });
    expect(
      (
        await prismaA.recruitmentApplication.findUniqueOrThrow({
          where: { id: target.id },
          select: { statusCode: true },
        })
      ).statusCode,
    ).toBe('verified');
    await assertNoPublicityWithIncompleteThresholds();
  });

  it('评定通过 vs 撤回审核(投影落后):只加锁不复算就会放行 —— 复算必须自己重新聚合 Claim', async () => {
    const target = await createPendingEvaluationApp();
    const claims = await createApprovedClaims(target.id);

    // 这一条**只**改事实源(Claim),刻意不动 `thresholdMarks` / `statusCode` 投影。
    // 于是锁后复读看到的仍是 pending_evaluation + 五项齐全 —— 锁拦不住它。
    // 拦得住的只有「approved 前重新聚合一次 Claim」。
    const blocker = mutateAfterLock(target.id, async (tx) => {
      await tx.$executeRaw`
        UPDATE "RecruitmentCertificateClaim"
        SET "status" = 'SUBMITTED'::"RecruitmentCertificateClaimStatus",
            "standardId" = NULL, "recognitionPolicyId" = NULL, "recognitionIssuerId" = NULL,
            "version" = "version" + 1
        WHERE "id" = ${claims.firstAidClaimId}
      `;
    });
    await blocker.ready;

    const evaluating = reviewB.evaluate(
      target.id,
      { approved: true, note: '评定通过' },
      admin,
      meta,
      new Date(),
    );
    await waitForApplicationLockWaiters(1);
    blocker.release();
    await blocker.done;

    await expect(evaluating).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
    });

    // 复算与评定同事务:拒掉之后整个事务回滚,**连它刚修好的投影一起回滚**。
    // 所以这里断言的是「没有写成 publicity、没有留下评定痕迹」,而不是「投影被修好了」——
    // 落后的投影仍然落后,要等某条 Claim 写路径再跑一次重算才会追上。
    const after = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: { statusCode: true, evaluatedByUserId: true, evaluatedAt: true },
    });
    expect(after.statusCode).toBe('pending_evaluation');
    expect(after.evaluatedByUserId).toBeNull();
    expect(after.evaluatedAt).toBeNull();
    await assertNoPublicityWithIncompleteThresholds();
  });

  // ===== ③ 竞态结束后尝试发号:不得产生 Member / User / Certificate / 永久编号 =====

  it('两轮竞态之后发号:批量与单人都不得为它建 Member / User / Certificate / 永久编号', async () => {
    const withdrawn = await createPendingEvaluationApp();
    await createApprovedClaims(withdrawn.id);
    const reverted = await createPendingEvaluationApp();
    const revertedClaims = await createApprovedClaims(reverted.id);

    const membersBefore = await prismaA.member.count();
    const usersBefore = await prismaA.user.count();
    const certsBefore = await prismaA.certificate.count();

    // 竞态一:撤销赢
    const b1 = mutateAfterLock(withdrawn.id, async (tx) => {
      await tx.$executeRaw`
        UPDATE "recruitment_applications" SET "statusCode" = 'withdrawn' WHERE "id" = ${withdrawn.id}
      `;
      // 与用例 ① 的 blocker 同款:撤销服务是**连 Claim 一起**级联的,裸 SQL 少写这一半
      // 就等于给库里留一份真实撤销永远不会产生的残局,H1 那条全表巡检会照直报出来。
      // 「语义与对应 service 逐字对齐」是本文件 blocker 的既定纪律,这里补齐。
      await tx.$executeRaw`
        UPDATE "RecruitmentCertificateClaim"
        SET "status" = 'WITHDRAWN'::"RecruitmentCertificateClaimStatus"
        WHERE "applicationId" = ${withdrawn.id}
          AND "status" <> 'PROMOTED'::"RecruitmentCertificateClaimStatus"
          AND "deletedAt" IS NULL
      `;
    });
    await b1.ready;
    const e1 = reviewB.evaluate(withdrawn.id, { approved: true }, admin, meta, new Date());
    await waitForApplicationLockWaiters(1);
    b1.release();
    await b1.done;
    await expect(e1).rejects.toMatchObject({ biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE });

    // 竞态二:门槛回退赢(投影落后形态)
    const b2 = mutateAfterLock(reverted.id, async (tx) => {
      await tx.$executeRaw`
        UPDATE "RecruitmentCertificateClaim"
        SET "status" = 'SUBMITTED'::"RecruitmentCertificateClaimStatus", "standardId" = NULL
        WHERE "id" = ${revertedClaims.bsafeClaimId}
      `;
    });
    await b2.ready;
    const e2 = reviewB.evaluate(reverted.id, { approved: true }, admin, meta, new Date());
    await waitForApplicationLockWaiters(1);
    b2.release();
    await b2.done;
    await expect(e2).rejects.toMatchObject({ biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE });

    // 批量发号只取 publicity —— 两条都不该在里面。
    const batch = await promotionB.promote(cycleId, admin, meta, new Date());
    expect(batch.promoted).toEqual([]);

    // 单人发号逐条打回(28041),同样不建任何东西。
    for (const id of [withdrawn.id, reverted.id]) {
      await expect(promotionB.promoteSingle(id, admin, meta, new Date())).rejects.toMatchObject({
        biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
      });
    }

    expect(await prismaA.member.count()).toBe(membersBefore);
    expect(await prismaA.user.count()).toBe(usersBefore);
    expect(await prismaA.certificate.count()).toBe(certsBefore);
    const rows = await prismaA.recruitmentApplication.findMany({
      where: { id: { in: [withdrawn.id, reverted.id] } },
      select: { statusCode: true, promotedMemberId: true },
    });
    expect(rows.map((r) => r.promotedMemberId)).toEqual([null, null]);
    expect(rows.every((r) => r.statusCode !== 'promoted')).toBe(true);
    await assertNoPublicityWithIncompleteThresholds();
  });

  // ===== ④ 不需要并发就能复现的一条:门槛投影虚高 =====

  it('门槛投影虚高(marks 齐但无 Claim)时评定通过必须拒 —— 不需要并发就能复现', async () => {
    seq += 1;
    const bare = await prismaA.recruitmentApplication.create({
      data: {
        cycleId,
        statusCode: 'pending_evaluation',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: `虚高${seq}`,
        idCardNumber: `AWCX${String(seq).padStart(5, '0')}`,
        birthDate: new Date('1990-03-07T00:00:00.000Z'),
        genderCode: 'male',
        phone: `1393${String(100000 + seq).slice(-6)}`,
        detailedAddress: '深圳市南山区某街道 2 号',
        openid: `dev-openid-awcx-${seq}`,
        thresholdMarks: completeMarks(),
      },
      select: { id: true },
    });

    // 修复前:evaluate 只看 `statusCode`,门槛投影说齐了就当齐了 ——
    // 一份根本没有任何 APPROVED Claim 的报名照样进公示。
    await expect(
      reviewB.evaluate(bare.id, { approved: true }, admin, meta, new Date()),
    ).rejects.toMatchObject({ biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE });
    // 同上:拒掉 = 整个事务回滚,投影维持原样(虚高),但绝不进公示、不留评定痕迹。
    const after = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: bare.id },
      select: { statusCode: true, evaluatedByUserId: true },
    });
    expect(after.statusCode).toBe('pending_evaluation');
    expect(after.evaluatedByUserId).toBeNull();
    await assertNoPublicityWithIncompleteThresholds();
  });

  // ===== ⑤ 正常路径与既有状态闸不得被这一刀改掉 =====

  it('门槛齐备的评定通过仍然照常进公示(复算不得误伤正常路径)', async () => {
    const target = await createPendingEvaluationApp();
    await createApprovedClaims(target.id);
    const dto = await reviewB.evaluate(
      target.id,
      { approved: true, note: '通过' },
      admin,
      meta,
      new Date(),
    );
    expect(dto.statusCode).toBe('publicity');
    const row = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: { statusCode: true, evaluatedByUserId: true, evaluationNote: true },
    });
    expect(row).toMatchObject({
      statusCode: 'publicity',
      evaluatedByUserId: admin.id,
      evaluationNote: '通过',
    });
    await assertNoPublicityWithIncompleteThresholds();
  });

  it('评定不通过(淘汰)照旧可用:pending_evaluation → rejected,eliminationStage 落 evaluation', async () => {
    const target = await createPendingEvaluationApp();
    await createApprovedClaims(target.id);
    const dto = await reviewB.evaluate(target.id, { approved: false }, admin, meta, new Date());
    expect(dto.statusCode).toBe('rejected');
    const row = await prismaA.recruitmentApplication.findUniqueOrThrow({
      where: { id: target.id },
      select: { statusCode: true, eliminationStage: true, evaluatedByUserId: true },
    });
    expect(row).toMatchObject({
      statusCode: 'rejected',
      eliminationStage: 'evaluation',
      evaluatedByUserId: admin.id,
    });
    // 评审 findings H1:淘汰必须同事务把该报名的非 PROMOTED Claim 级联成 WITHDRAWN。
    // **修复前这一段必红** —— 那两条 APPROVED Claim 会原样留下,而 rejected 之后
    // 一切 Claim 写路径都被终态闸拒掉:它们永久卡住,留存 SOP(只扫 REJECTED/WITHDRAWN)
    // 扫不到,证据闸(只含 WITHDRAWN/PROMOTED)也不拦 —— 证件照无限期留存且仍可签 URL。
    const claims = await prismaA.recruitmentCertificateClaim.findMany({
      where: { applicationId: target.id },
      select: { status: true },
      orderBy: { id: 'asc' },
    });
    expect(claims).toHaveLength(2);
    expect(claims.every((c) => c.status === 'WITHDRAWN')).toBe(true);
    // 派生门槛随之失去依据 → 重算清空(Claim 状态一变就必须重算,§8.4 唯一写者)。
    const marks = (
      await prismaA.recruitmentApplication.findUniqueOrThrow({
        where: { id: target.id },
        select: { thresholdMarks: true },
      })
    ).thresholdMarks as Record<string, unknown> | null;
    expect(marks?.redCross).toBeUndefined();
    expect(marks?.bsafe).toBeUndefined();
    // 审计只记条数,不记 claimId / 编号 / 图片 key。
    const log = await prismaA.auditLog.findFirstOrThrow({
      where: { event: 'recruitment-application.evaluate', resourceId: target.id },
      select: { context: true },
    });
    const extra = (log.context as { extra: Record<string, unknown> }).extra;
    expect(extra.cascadedWithdrawnClaimCount).toBe(2);
    expect(JSON.stringify(extra)).not.toContain('AWC-first_aid');
    // 这条与上面的「淘汰照旧可用」修复前不可能同时绿。
    await assertNoNonTerminalClaimUnderTerminalApplication();
  });

  it('评定通过(未进终态)不级联 Claim —— 收尾函数只绑终态,不得误伤正常放行', async () => {
    const target = await createPendingEvaluationApp();
    await createApprovedClaims(target.id);
    await reviewB.evaluate(target.id, { approved: true }, admin, meta, new Date());
    const claims = await prismaA.recruitmentCertificateClaim.findMany({
      where: { applicationId: target.id },
      select: { status: true },
    });
    expect(claims.map((c) => c.status)).toEqual([CLAIM_APPROVED, CLAIM_APPROVED]);
  });

  it('PROMOTED Claim 在淘汰级联中必须保留 —— 否则正式证书与来源申报脱钩', async () => {
    const target = await createPendingEvaluationApp();
    const { firstAidClaimId } = await createApprovedClaims(target.id);
    // PROMOTED 行有 DB check(standardId + policyId + promotedAt 必须齐),
    // 直插要按发号那条路径的落库形态写全,不能只改 status。
    await prismaA.recruitmentCertificateClaim.update({
      where: { id: firstAidClaimId },
      data: { status: 'PROMOTED', promotedAt: new Date(), sensitivePurgedAt: new Date() },
    });
    await reviewB.evaluate(target.id, { approved: false }, admin, meta, new Date());
    const claims = await prismaA.recruitmentCertificateClaim.findMany({
      where: { applicationId: target.id },
      select: { id: true, status: true },
    });
    expect(claims.find((c) => c.id === firstAidClaimId)?.status).toBe('PROMOTED');
    expect(claims.filter((c) => c.status === 'WITHDRAWN')).toHaveLength(1);
    await assertNoNonTerminalClaimUnderTerminalApplication();
  });

  it('verified 态 + approved=true 仍恒拒(门槛未齐不可直接过评定;复算不得把它变成可通过)', async () => {
    const target = await createPendingEvaluationApp();
    await createApprovedClaims(target.id);
    await prismaA.recruitmentApplication.update({
      where: { id: target.id },
      data: { statusCode: 'verified' },
    });
    await expect(
      reviewB.evaluate(target.id, { approved: true }, admin, meta, new Date()),
    ).rejects.toMatchObject({ biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE });
    expect(
      (
        await prismaA.recruitmentApplication.findUniqueOrThrow({
          where: { id: target.id },
          select: { statusCode: true },
        })
      ).statusCode,
    ).toBe('verified');
  });

  it('已发号(promoted)报名不可再评定 —— 终态闸', async () => {
    const target = await createPendingEvaluationApp();
    await prismaA.recruitmentApplication.update({
      where: { id: target.id },
      data: { statusCode: 'promoted' },
    });
    await expect(
      reviewB.evaluate(target.id, { approved: false }, admin, meta, new Date()),
    ).rejects.toMatchObject({ biz: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE });
  });

  it('不存在 / 已软删报名 → 28002(不是状态错)', async () => {
    const target = await createPendingEvaluationApp();
    await prismaA.recruitmentApplication.update({
      where: { id: target.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      reviewB.evaluate(target.id, { approved: false }, admin, meta, new Date()),
    ).rejects.toMatchObject({ biz: BizCode.RECRUITMENT_APPLICATION_NOT_FOUND });
  });
});

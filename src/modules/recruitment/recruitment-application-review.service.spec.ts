import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RecruitmentApplicationReviewService } from './recruitment-application-review.service';

// 证书标准库 PR-4a-2(§8.4):`reviewCertificate` 随旧 category 端点退役,
// 其「pending_verification 历史行不被自动翻状态」的断言由 buildThresholdMutation
// 本身承担(该分支未改动,markThreshold 路径仍覆盖)。
//
// 换上来的是本刀真正需要钉住的那条:**证书型门槛不可人工标记**。
// 这条最容易被后续刀「顺手放开一格」——放开就等于把派生投影退回可写标记,
// 而可写标记记不住「同类别还有另一张已通过的证书」。
describe('RecruitmentApplicationReviewService.markThreshold · 证书门槛派生只读(§8.4)', () => {
  const meta: AuditMeta = { requestId: 'r1', ip: null, ua: null };
  const now = new Date('2026-07-30T00:00:00.000Z');
  const user = { id: 'admin1', role: 'SUPER_ADMIN' } as never;

  function buildService(): {
    service: RecruitmentApplicationReviewService;
    $transaction: jest.Mock;
  } {
    const $transaction = jest.fn();
    const service = new RecruitmentApplicationReviewService(
      { $transaction } as never,
      { can: jest.fn().mockResolvedValue(true) } as never,
      { log: jest.fn() } as never,
    );
    return { service, $transaction };
  }

  // completed 真假都拒。拒 false 与拒 true 同等重要:允许人工清除,
  // 就等于允许绕过审核结论把一张已通过证书带来的门槛抹掉。
  const derivedCases: Array<[string, boolean]> = [
    ['redCross', true],
    ['redCross', false],
    ['bsafe', true],
    ['bsafe', false],
  ];
  it.each(derivedCases)('%s + completed=%s → 28063,且不进事务', async (code, completed) => {
    const { service, $transaction } = buildService();

    const err = await service
      .markThreshold('app-1', { thresholdCode: code, completed }, user, meta, now)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(BizException);
    expect((err as BizException).biz.code).toBe(
      BizCode.RECRUITMENT_THRESHOLD_DERIVED_READONLY.code,
    );
    // 守卫必须在开事务**之前** —— 进了事务再拒会白拿一次行锁。
    expect($transaction).not.toHaveBeenCalled();
  });

  it('人工族 patrol1 不被这道守卫拦住(不误伤)', async () => {
    const { service, $transaction } = buildService();
    $transaction.mockRejectedValue(new Error('reached transaction'));

    await expect(
      service.markThreshold(
        'app-1',
        { thresholdCode: 'patrol1', completed: true },
        user,
        meta,
        now,
      ),
    ).rejects.toThrow('reached transaction');
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});

// 证书标准库 PR-4a-2:「驳回证书图清理日志不泄漏 key/bucket/secret/URL」随
// safeDeleteBlob 一起迁到 recruitment-certificate-claims.service(证据清理的新归属)。
// 不变量与断言逐字保留,只是守卫位置跟着代码走。

// god-service 拆分(2026-06-28):批量标门槛编排 characterization 随方法从
// RecruitmentApplicationsService 迁来(断言不变,仅构造目标类改为 ReviewService;
// markThreshold + batchMarkThreshold 同处一类 → spy 仍命中 this.markThreshold)。

// 招新闭环优化 S6(评审稿 §8.1):批量标门槛编排(复用单行 markThreshold + 逐行容错)。
// matching 纯函数另见 recruitment-batch-matching.spec.ts;本组锁编排:① 复用单行 markThreshold(spy 验调用);
// ② 逐行容错(某行抛 BizException 记 failed 不整批断);③ 匹配不上记 unmatched;④ 自动推进计数;⑤ 批次汇总。
describe('RecruitmentApplicationReviewService.batchMarkThreshold · 编排(复用单行 markThreshold + 逐行容错)', () => {
  const meta: AuditMeta = { requestId: 'r1', ip: null, ua: null };
  const now = new Date('2026-06-24T00:00:00.000Z');
  const user = { id: 'admin1', role: 'SUPER_ADMIN' } as never;

  function buildBatchService(candidates: Record<string, unknown>[]) {
    const prisma = {
      recruitmentApplication: { findMany: jest.fn().mockResolvedValue(candidates) },
    };
    const rbac = { can: jest.fn().mockResolvedValue(true) };
    const service = new RecruitmentApplicationReviewService(
      prisma as never,
      rbac as never,
      { log: jest.fn() } as never,
    );
    return { service };
  }

  const dto = (over: Record<string, unknown> = {}) => ({
    thresholdCode: 'patrol1',
    completed: true,
    matches: [{ tempNo: 'T20260001' }, { tempNo: 'T20260002' }, { tempNo: 'T99999999' }],
    ...over,
  });

  it('matched 行逐行复用单行 markThreshold;unmatched 行不调;失败行记 failed 不整批断;汇总正确', async () => {
    const { service } = buildBatchService([
      { id: 'a1', tempNo: 'T20260001', phone: null, realName: null },
      { id: 'a2', tempNo: 'T20260002', phone: null, realName: null },
      // T99999999 无候选 → unmatched(no-match)
    ]);

    // spy 单行 markThreshold:a1 成功(末次完成→pending_evaluation 自动推进)、a2 抛 28041 状态非法
    // (返回/拒绝 Promise,不用 async 关键字以免 require-await;逐行容错路径靠 a2 的 reject 触发)
    const spy = jest.spyOn(service, 'markThreshold').mockImplementation((id: string) => {
      if (id === 'a1') {
        return Promise.resolve({
          statusCode: 'pending_evaluation',
          thresholdsComplete: true,
        } as never);
      }
      return Promise.reject(new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE));
    });

    const res = await service.batchMarkThreshold(dto(), user, meta, now);

    // ① 仅对 matched 的 a1/a2 调单行 markThreshold(零第二套);unmatched 不调
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(
      'a1',
      { thresholdCode: 'patrol1', completed: true },
      user,
      meta,
      now,
    );

    // ② 逐行结果 + 汇总(逐行容错:a2 failed 不影响 a1 marked / T9 unmatched)
    expect(res.total).toBe(3);
    expect(res.marked).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.unmatched).toBe(1);
    expect(res.autoAdvanced).toBe(1); // a1 末次完成自动推进

    const a1 = res.results.find((r) => r.applicationId === 'a1');
    expect(a1).toMatchObject({
      status: 'marked',
      statusCode: 'pending_evaluation',
      matchedBy: 'tempNo',
    });
    const a2 = res.results.find((r) => r.applicationId === 'a2');
    expect(a2).toMatchObject({
      status: 'failed',
      errorCode: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE.code,
    });
    const unmatched = res.results.find((r) => r.status === 'unmatched');
    expect(unmatched).toMatchObject({ index: 2, unmatchedReason: 'no-match', applicationId: null });
  });

  it('RBAC 拒绝 → RBAC_FORBIDDEN(入口快速失败,不触候选查询)', async () => {
    const prisma = { recruitmentApplication: { findMany: jest.fn() } };
    const rbac = { can: jest.fn().mockResolvedValue(false) };
    const service = new RecruitmentApplicationReviewService(
      prisma as never,
      rbac as never,
      { log: jest.fn() } as never,
    );
    await expect(service.batchMarkThreshold(dto() as never, user, meta, now)).rejects.toMatchObject(
      {
        biz: { code: BizCode.RBAC_FORBIDDEN.code },
      },
    );
    expect(prisma.recruitmentApplication.findMany).not.toHaveBeenCalled();
  });
});

// review #484 G4(2026-07-03):markThreshold / evaluate 写响应曾恒 toAdminApplicationDto(updated, false)
// 明文,未检查 read.sensitive —— 与详情/导出(recruitment-applications-query.service.ts)口径矛盾。
// 本组镜像 query.service.spec.ts 的 rbac.can mock 范式(SENSITIVE 常量同款),锁定双分支:
// 无 sensitive → 脱敏;持 sensitive → 明文。canSensitive 求值在 $transaction 外(沿 detail/export 先例)。
describe('RecruitmentApplicationReviewService · S3 敏感字段分级(响应脱敏闸,review #484 G4)', () => {
  const RAW_ID = '110101199003070038';
  const RAW_PHONE = '13900000001';
  const MARK = 'recruitment-application.mark.threshold';
  const EVALUATE = 'recruitment-application.evaluate.assessment';
  const SENSITIVE = 'recruitment-application.read.sensitive';
  const user = { id: 'admin1', username: 'admin', role: 'ADMIN', memberId: null } as never;
  const meta: AuditMeta = { requestId: 'r1', ip: null, ua: null };
  const now = new Date('2026-06-24T00:00:00.000Z');

  // 5 项门槛齐备的投影 —— evaluate 的门槛重算(findings G1)读它,
  // 与桩里那两条 APPROVED Claim 对上后判定「仍完整」,重算因此不改任何字段。
  const MARK_AT = { at: '2026-06-24T00:00:00.000Z', by: 'admin1' };
  const COMPLETE_MARKS = {
    patrol1: MARK_AT,
    patrol2: MARK_AT,
    training: MARK_AT,
    redCross: MARK_AT,
    bsafe: MARK_AT,
  };

  // toAdminApplicationDto / isPromotable 读到的字段全集(镜像 query.service.spec.ts 的 ROW)
  const UPDATED_ROW = {
    id: 'app-1',
    cycleId: 'cyc-1',
    statusCode: 'verified',
    tempNo: 'T20260001',
    realName: '张三',
    idCardNumber: RAW_ID,
    phone: RAW_PHONE,
    documentTypeCode: 'mainland_id',
    isForeigner: false,
    birthDate: new Date('1990-03-07T00:00:00.000Z'),
    genderCode: 'male',
    ageGroup: null,
    cityDistrict: '北京市朝阳区',
    verifyOutcome: null,
    eliminationStage: null,
    idCardImageKey: null,
    thresholdMarks: { patrol1: { at: '2026-06-24T00:00:00.000Z', by: 'admin1' } },
    evaluationNote: null,
    promotedMemberId: null,
    openid: 'op-1',
    createdAt: new Date('2026-06-18T00:00:00.000Z'),
  };

  // $transaction 回调式 mock:把 tx 桩传入 service 内部的 tx.recruitmentApplication.* 调用。
  //
  // findings G1 之后 evaluate 的调用序变成「锁 → 复读 → 门槛重算 → CAS updateMany → 再复读」,
  // 所以桩要能区分「写入前的复读」与「写入后的复读」—— 本组断言(脱敏 / 明文)一字未改,
  // 变的只是桩要跟上真实调用序。`recruitmentCertificateClaim.findMany` 返两条 APPROVED
  // 是让重算得出「门槛仍完整」,否则重算会把 pending_evaluation 退回 verified,
  // 这组用例就测不到本该测的响应脱敏了。
  function buildReviewService(canMap: Record<string, boolean>, entryRow: Record<string, unknown>) {
    let written = false;
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
      recruitmentApplication: {
        findFirst: jest.fn(() => Promise.resolve(written ? UPDATED_ROW : entryRow)),
        update: jest.fn().mockResolvedValue(UPDATED_ROW),
        updateMany: jest.fn(() => {
          written = true;
          return Promise.resolve({ count: 1 });
        }),
      },
      recruitmentCertificateClaim: {
        findMany: jest.fn().mockResolvedValue([
          { status: 'APPROVED', standard: { categoryCode: 'first_aid' } },
          { status: 'APPROVED', standard: { categoryCode: 'bsafe' } },
        ]),
      },
    };
    const prisma = {
      $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(tx)),
    };
    const rbac = {
      can: jest.fn((_u: unknown, code: string) => Promise.resolve(canMap[code] ?? false)),
    };
    const auditLogs = { log: jest.fn() };
    const service = new RecruitmentApplicationReviewService(
      prisma as never,
      rbac as never,
      auditLogs as never,
    );
    return { service };
  }

  it('markThreshold · 仅持 mark.threshold(无 read.sensitive)→ 响应脱敏证件号/手机', async () => {
    const { service } = buildReviewService(
      { [MARK]: true, [SENSITIVE]: false },
      { id: 'app-1', statusCode: 'verified', thresholdMarks: null },
    );
    const dto = await service.markThreshold(
      'app-1',
      { thresholdCode: 'patrol1', completed: true },
      user,
      meta,
      now,
    );
    expect(dto.idCardNumber).not.toBe(RAW_ID);
    expect(dto.idCardNumber).toContain('*');
    expect(dto.phone).not.toBe(RAW_PHONE);
    expect(dto.phone).toContain('*');
  });

  it('markThreshold · 持 mark.threshold + read.sensitive → 响应明文证件号/手机', async () => {
    const { service } = buildReviewService(
      { [MARK]: true, [SENSITIVE]: true },
      { id: 'app-1', statusCode: 'verified', thresholdMarks: null },
    );
    const dto = await service.markThreshold(
      'app-1',
      { thresholdCode: 'patrol1', completed: true },
      user,
      meta,
      now,
    );
    expect(dto.idCardNumber).toBe(RAW_ID);
    expect(dto.phone).toBe(RAW_PHONE);
  });

  it('evaluate · 仅持 evaluate.assessment(无 read.sensitive)→ 响应脱敏证件号/手机', async () => {
    const { service } = buildReviewService(
      { [EVALUATE]: true, [SENSITIVE]: false },
      { id: 'app-1', statusCode: 'pending_evaluation', thresholdMarks: COMPLETE_MARKS },
    );
    const dto = await service.evaluate('app-1', { approved: true }, user, meta, now);
    expect(dto.idCardNumber).not.toBe(RAW_ID);
    expect(dto.idCardNumber).toContain('*');
    expect(dto.phone).not.toBe(RAW_PHONE);
    expect(dto.phone).toContain('*');
  });

  it('evaluate · 持 evaluate.assessment + read.sensitive → 响应明文证件号/手机', async () => {
    const { service } = buildReviewService(
      { [EVALUATE]: true, [SENSITIVE]: true },
      { id: 'app-1', statusCode: 'pending_evaluation', thresholdMarks: COMPLETE_MARKS },
    );
    const dto = await service.evaluate('app-1', { approved: true }, user, meta, now);
    expect(dto.idCardNumber).toBe(RAW_ID);
    expect(dto.phone).toBe(RAW_PHONE);
  });
});

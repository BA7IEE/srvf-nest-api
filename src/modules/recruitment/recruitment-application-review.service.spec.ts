import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RecruitmentApplicationReviewService } from './recruitment-application-review.service';

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

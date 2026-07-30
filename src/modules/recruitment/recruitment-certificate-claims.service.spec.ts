import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RecruitmentCertificateClaimsService } from './recruitment-certificate-claims.service';

const META: AuditMeta = { requestId: 'req-claim-1', ip: '127.0.0.1', ua: 'jest' };
const ADMIN_USER = { id: 'admin-1', username: 'admin', role: 'ADMIN', memberId: null } as never;

// 证书标准库 PR-4a-2:两条 fail-closed 不变量从退役的 `getCertificateImageUrls`
// 迁到这里(§13.4 删旧 category 端点,但不变量必须跟着新端点走,不能随端点一起消失):
//
//   ① 先按**安全计数**落审计,再调 provider 生成 signed-URL;
//   ② 审计失败 → provider 调用次数恒 0(fail-closed:读不到账就不给图)。
//
// 另加一条本刀新增的:审计 extra 里只有条数,object key 与 URL 一律不出现(§15.6)。
describe('RecruitmentCertificateClaimsService.getImageUrls · 证据图 fail-closed 审计', () => {
  const CLAIM = {
    id: 'claim-1',
    applicationId: 'app-1',
    version: 0,
    status: 'SUBMITTED',
    categoryHintCode: 'first_aid',
    rawCertificateName: '急救证',
    suggestedStandardId: null,
    standardId: null,
    recognitionPolicyId: null,
    recognitionIssuerId: null,
    issuingOrg: null,
    certNumber: null,
    issuedAt: null,
    expiredAt: null,
    imageKeys: ['recruitment/claims/secret-object-key.jpg'],
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNote: null,
    promotedAt: null,
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    updatedAt: new Date('2026-07-30T00:00:00.000Z'),
    suggestedStandard: null,
    standard: null,
  };

  function buildService() {
    const prisma = {
      recruitmentCertificateClaim: { findFirst: jest.fn().mockResolvedValue(CLAIM) },
      recruitmentApplication: { findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }) },
    };
    const rbac = { can: jest.fn().mockResolvedValue(true) };
    const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
    const storage = {
      generateDownloadUrl: jest
        .fn()
        .mockResolvedValue({ url: 'https://storage.example/signed', expiresAt: new Date() }),
    };
    const service = new RecruitmentCertificateClaimsService(
      prisma as never,
      rbac as never,
      auditLogs as never,
      {} as never, // resolver:本组只测读图,不触发认定规则解析
      {} as never, // identity:同上,公开面凭证链不参与 admin 取图
      {} as never, // contentValidator
      storage as never,
    );
    return { service, auditLogs, storage };
  }

  it('先按安全计数审计,再调用 provider', async () => {
    const { service, auditLogs, storage } = buildService();

    const result = await service.getImageUrls(ADMIN_USER, 'claim-1', META);

    expect(result.urls).toHaveLength(1);
    expect(auditLogs.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'recruitment-application.read.other',
        resourceId: 'app-1',
        extra: { operation: 'certificate-claim-images', count: 1 },
      }),
    );
    // 顺序锁:审计必须在 provider 之前。反过来就意味着「图已经发出去了才记账」。
    expect(auditLogs.log.mock.invocationCallOrder[0]).toBeLessThan(
      storage.generateDownloadUrl.mock.invocationCallOrder[0],
    );
  });

  it('审计失败 → provider 调用次数为 0', async () => {
    const { service, auditLogs, storage } = buildService();
    auditLogs.log.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.getImageUrls(ADMIN_USER, 'claim-1', META)).rejects.toThrow(
      'audit unavailable',
    );
    expect(storage.generateDownloadUrl).not.toHaveBeenCalled();
  });

  it('审计 extra 只含条数 —— object key 与 signed URL 都不入账', async () => {
    const { service, auditLogs } = buildService();

    await service.getImageUrls(ADMIN_USER, 'claim-1', META);

    const serialized = JSON.stringify(auditLogs.log.mock.calls[0] as unknown[]);
    expect(serialized).not.toContain('secret-object-key');
    expect(serialized).not.toContain('https://storage.example');
  });

  it('出参不含 imageKeys / keys 字段(只给 URL,不给 object key)', async () => {
    const { service } = buildService();

    const result = await service.getImageUrls(ADMIN_USER, 'claim-1', META);

    expect(result).not.toHaveProperty('imageKeys');
    expect(result).not.toHaveProperty('keys');
    expect(Object.keys(result).sort()).toEqual(['claimId', 'expiresAt', 'urls']);
  });
});

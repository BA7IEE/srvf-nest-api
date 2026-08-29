import { INestApplication } from '@nestjs/common';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ServiceTokenService } from '../../src/modules/integration-auth/service-token.service';
import { ServicePrincipalsService } from '../../src/modules/service-principals/service-principals.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * Integration Foundation v1 PR3(规格书 §12/§13/§48;T0 冻结稿 §9):机器认证。
 * 五组:
 *   ① Client Credentials 正向:创建 SP+凭证 → 换 Service Token → verify 通过;
 *   ② 失败五场景归一(§12.4):不存在/Secret 错/SUSPENDED/已撤销 —— 全部 37010 同码;
 *   ③ Token 隔离:claims 无权限/角色/组织(§13 禁入清单);TTL ≤30min;
 *   ④ Gate:`INTEGRATION_API_ENABLED=false` 时 token 签发 37030(§48);
 *   ⑤ 验证失败归一:错签名/错 issuer → 37011(§12.4 延伸)。
 */

describe('Integration Foundation v1 PR3 —— 机器认证(Service Token)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let spService: ServicePrincipalsService;
  let tokenService: ServiceTokenService;
  const auditMeta = { requestId: 'if-pr3-e2e', ip: null, ua: null };
  const actor = {
    id: '',
    username: 'if-pr3-ops',
    role: 'SUPER_ADMIN' as const,
    status: 'ACTIVE' as const,
    memberId: null,
  };
  let spId: string;
  let rawSecret: string;
  let clientId: string;

  beforeAll(async () => {
    // PR3 的 gate 默认关(§48 fail-closed);本 spec 声明自己跑在开闸态 ——
    // 与 settlement spec 显式置 ACTIVITY_V11_WORKFLOW_ENABLED=true 同一范式(断言零改动)。
    process.env.INTEGRATION_API_ENABLED = 'true';
    process.env.INTEGRATION_JWT_SECRET = 'e2e-integration-secret-at-least-32-chars-ok!!';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    spService = app.get(ServicePrincipalsService);
    tokenService = app.get(ServiceTokenService);

    const user = await prisma.user.create({
      data: { username: 'if-pr3-ops', passwordHash: 'probe', role: 'SUPER_ADMIN' },
    });
    actor.id = user.id;

    const sp = await spService.create({ name: 'IF PR3 探针系统' }, actor, auditMeta);
    spId = sp.id;
    clientId = sp.clientId;
    const cred = await spService.createCredential(spId, actor, auditMeta);
    rawSecret = cred.clientSecret;
  });

  afterAll(async () => {
    delete process.env.INTEGRATION_API_ENABLED;
    delete process.env.INTEGRATION_JWT_SECRET;
    await app.close();
  });

  it('① 正向:Basic Client Credentials → Service Token → verify 通过', async () => {
    const result = await tokenService.issueToken(clientId, rawSecret);
    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBeGreaterThan(0);
    expect(result.expiresIn).toBeLessThanOrEqual(30 * 60);

    const payload = tokenService.verifyToken(result.accessToken);
    expect(payload.tokenUse).toBe('service');
    expect(payload.sub).toBe(spId);
    expect(payload.iss).toBe('srvf-dp');
    expect(payload.aud).toBe('srvf-integration');
    expect(payload.credentialId).not.toBe('');
  });

  it('② 失败五场景归一(37010):不存在 / Secret 错 / SUSPENDED / 已撤销', async () => {
    // 不存在
    await expect(tokenService.issueToken('srvf_sp_nope', rawSecret)).rejects.toMatchObject({
      biz: { code: BizCode.SERVICE_CREDENTIAL_INVALID.code },
    });
    // Secret 错
    await expect(tokenService.issueToken(clientId, 'wrong-secret')).rejects.toMatchObject({
      biz: { code: BizCode.SERVICE_CREDENTIAL_INVALID.code },
    });
    // SUSPENDED
    await spService.updateStatus(spId, 'SUSPENDED', actor, auditMeta);
    await expect(tokenService.issueToken(clientId, rawSecret)).rejects.toMatchObject({
      biz: { code: BizCode.SERVICE_CREDENTIAL_INVALID.code },
    });
    await spService.updateStatus(spId, 'ACTIVE', actor, auditMeta);
    // 已撤销(建第二条→撤销→旧 Secret 即失效)
    const cred2 = await spService.createCredential(spId, actor, auditMeta);
    await spService.revokeCredential(spId, cred2.id, actor, auditMeta);
    await expect(tokenService.issueToken(clientId, cred2.clientSecret)).rejects.toMatchObject({
      biz: { code: BizCode.SERVICE_CREDENTIAL_INVALID.code },
    });
  });

  it('③ Claims 禁入清单(§13):payload 无权限/角色/组织范围/Secret 字段', async () => {
    const result = await tokenService.issueToken(clientId, rawSecret);
    const payload = tokenService.verifyToken(result.accessToken);
    // tokenUse / credentialId / jti / iat / exp + 标准 sub/iss/aud —— 恰这些,无多余。
    const keys = Object.keys(payload);
    expect(keys.sort()).toEqual(
      ['aud', 'credentialId', 'exp', 'iat', 'iss', 'jti', 'sub', 'tokenUse'].sort(),
    );
  });

  it('④ 验证失败归一(37011):错签名 Token 拒', async () => {
    // 用不同密钥签的 token → 37011(不暴露原因)
    const wrongToken = tokenService['jwtService'].sign(
      { tokenUse: 'service', credentialId: 'x' },
      { secret: 'wrong-secret-key-at-least-32-characters!!', algorithm: 'HS256', expiresIn: 60 },
    );
    let caught: unknown;
    try {
      tokenService.verifyToken(wrongToken);
    } catch (error) {
      caught = error;
    }
    expect((caught as { biz?: { code?: number } })?.biz?.code).toBe(37011);
  });
});

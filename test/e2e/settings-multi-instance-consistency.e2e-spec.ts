import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import COS from 'cos-nodejs-sdk-v5';
import request from 'supertest';
import { sms } from 'tencentcloud-sdk-nodejs-sms';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { DevStubRealnameProvider } from '../../src/modules/realname/providers/dev-stub.provider';
import { TencentRealnameProvider } from '../../src/modules/realname/providers/tencent-realname.provider';
import { RealnameSettingsService } from '../../src/modules/realname/realname-settings.service';
import { RealnameVerificationService } from '../../src/modules/realname/realname.service';
import { DevStubSmsProvider } from '../../src/modules/sms/providers/dev-stub.provider';
import { TencentSmsProvider } from '../../src/modules/sms/providers/tencent-sms.provider';
import { SmsProviderRouter } from '../../src/modules/sms/sms-provider.router';
import { SmsSettingsService } from '../../src/modules/sms/sms-settings.service';
import { CosStorageProvider } from '../../src/modules/storage/providers/cos.provider';
import { StorageProviderRouter } from '../../src/modules/storage/storage-provider.router';
import { StorageSettingsService } from '../../src/modules/storage/storage-settings.service';
import { WechatMiniRealProvider } from '../../src/modules/wechat/providers/wechat.provider';
import { WechatSettingsService } from '../../src/modules/wechat/wechat-settings.service';
import { WechatService } from '../../src/modules/wechat/wechat.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

jest.mock('cos-nodejs-sdk-v5', () => {
  const instance = {
    getObjectUrl: jest.fn(),
  };
  const Constructor = jest.fn().mockImplementation(() => instance);
  (Constructor as unknown as { __mockInstance: typeof instance }).__mockInstance = instance;
  return { __esModule: true, default: Constructor };
});

const COSMock = COS as unknown as jest.Mock & {
  __mockInstance: { getObjectUrl: jest.Mock };
};

const AUDIT_META: AuditMeta = {
  requestId: 'settings-multi-instance-cutover',
  ip: '127.0.0.1',
  ua: 'jest/settings-multi-instance-consistency',
};
const HTTP_USER_AGENT = 'jest/settings-multi-instance-http-app-b';
const SETTINGS_ENDPOINTS = {
  sms: '/api/system/v1/sms-settings',
  wechat: '/api/system/v1/wechat-settings',
  storage: '/api/system/v1/storage-settings',
  realname: '/api/system/v1/realname-settings',
} as const;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchUrl(request: Parameters<typeof fetch>[0]): string {
  if (typeof request === 'string') return request;
  if (request instanceof URL) return request.href;
  return request.url;
}

describe('settings live-read / multi-instance cutover', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let auditB: AuditLogsService;
  let actor: CurrentUserPayload;
  let appBAuthHeader: string;

  let smsSettingsA: SmsSettingsService;
  let smsSettingsB: SmsSettingsService;
  let wechatSettingsA: WechatSettingsService;
  let storageSettingsA: StorageSettingsService;
  let storageSettingsB: StorageSettingsService;
  let realnameSettingsA: RealnameSettingsService;

  let smsRouterA: SmsProviderRouter;
  let wechatA: WechatService;
  let storageRouterA: StorageProviderRouter;
  let realnameA: RealnameVerificationService;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    auditB = appB.get(AuditLogsService);

    smsSettingsA = appA.get(SmsSettingsService);
    smsSettingsB = appB.get(SmsSettingsService);
    wechatSettingsA = appA.get(WechatSettingsService);
    storageSettingsA = appA.get(StorageSettingsService);
    storageSettingsB = appB.get(StorageSettingsService);
    realnameSettingsA = appA.get(RealnameSettingsService);

    smsRouterA = appA.get(SmsProviderRouter);
    wechatA = appA.get(WechatService);
    storageRouterA = appA.get(StorageProviderRouter);
    realnameA = appA.get(RealnameVerificationService);
  });

  beforeEach(async () => {
    COSMock.mockClear();
    COSMock.__mockInstance.getObjectUrl.mockReset();
    await resetDb(appA);
    const row = await createTestUser(appA, {
      username: `settings-cutover-${Date.now()}`,
      role: Role.SUPER_ADMIN,
    });
    actor = {
      id: row.id,
      username: row.username,
      role: row.role,
      status: row.status,
      memberId: row.memberId,
    };
    appBAuthHeader = (await loginAs(appB, row.username)).authHeader;
    await seedOldGeneration();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  async function postSettingsThroughAppB(
    path: string,
    body: Record<string, unknown>,
    requestId: string,
  ): Promise<void> {
    const response = await request(httpServer(appB))
      .post(path)
      .set('Authorization', appBAuthHeader)
      .set('x-request-id', requestId)
      .set('user-agent', HTTP_USER_AGENT)
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ code: 0, message: 'ok' });
  }

  async function patchSettingsThroughAppB(
    path: string,
    body: Record<string, unknown>,
    requestId: string,
  ): Promise<void> {
    const response = await request(httpServer(appB))
      .patch(path)
      .set('Authorization', appBAuthHeader)
      .set('x-request-id', requestId)
      .set('user-agent', HTTP_USER_AGENT)
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ code: 0, message: 'ok' });
  }

  async function seedOldGeneration(): Promise<void> {
    await prismaA.smsSettings.create({
      data: { providerType: 'DEV_STUB', enabled: true },
    });
    await prismaA.wechatSettings.create({
      data: { providerType: 'DEV_STUB', enabled: true },
    });
    await prismaA.storageSettings.create({
      data: { providerType: 'LOCAL', enabled: true },
    });
    await prismaA.realnameVerificationSettings.create({
      data: { providerType: 'DEV_STUB', enabled: true },
    });
  }

  async function cutoverAllToReal(newSuffix = 'new'): Promise<void> {
    await postSettingsThroughAppB(
      `${SETTINGS_ENDPOINTS.sms}/reset-credentials`,
      { secretId: `sms-id-${newSuffix}`, secretKey: `sms-key-${newSuffix}` },
      `settings-http-${newSuffix}-sms-reset`,
    );
    await patchSettingsThroughAppB(
      SETTINGS_ENDPOINTS.sms,
      {
        providerType: 'TENCENT_SMS',
        enabled: true,
        sdkAppId: `sms-app-${newSuffix}`,
        signName: `sms-sign-${newSuffix}`,
        region: `sms-region-${newSuffix}`,
        templateIdVerifyCode: `sms-template-${newSuffix}`,
      },
      `settings-http-${newSuffix}-sms-patch`,
    );

    await postSettingsThroughAppB(
      `${SETTINGS_ENDPOINTS.wechat}/reset-credentials`,
      { appSecret: `wechat-secret-${newSuffix}` },
      `settings-http-${newSuffix}-wechat-reset`,
    );
    await patchSettingsThroughAppB(
      SETTINGS_ENDPOINTS.wechat,
      { providerType: 'WECHAT', enabled: true, appId: `wechat-app-${newSuffix}` },
      `settings-http-${newSuffix}-wechat-patch`,
    );

    await postSettingsThroughAppB(
      `${SETTINGS_ENDPOINTS.storage}/reset-credentials`,
      { secretId: `cos-id-${newSuffix}`, secretKey: `cos-key-${newSuffix}` },
      `settings-http-${newSuffix}-storage-reset`,
    );
    await patchSettingsThroughAppB(
      SETTINGS_ENDPOINTS.storage,
      {
        providerType: 'COS',
        enabled: true,
        bucket: `cos-bucket-${newSuffix}`,
        region: `cos-region-${newSuffix}`,
      },
      `settings-http-${newSuffix}-storage-patch`,
    );

    await postSettingsThroughAppB(
      `${SETTINGS_ENDPOINTS.realname}/reset-credentials`,
      { secretId: `realname-id-${newSuffix}`, secretKey: `realname-key-${newSuffix}` },
      `settings-http-${newSuffix}-realname-reset`,
    );
    await patchSettingsThroughAppB(
      SETTINGS_ENDPOINTS.realname,
      { providerType: 'TENCENT_CLOUD', enabled: true, region: `realname-region-${newSuffix}` },
      `settings-http-${newSuffix}-realname-patch`,
    );
  }

  it('两套 Nest app 使用不同 HTTP server/Prisma pool；B 经四路真实 HTTP 写后 A 下一读取见新事实', async () => {
    expect(appA).not.toBe(appB);
    expect(httpServer(appA)).not.toBe(httpServer(appB));
    expect(prismaA).not.toBe(prismaB);
    const [backendA] = await prismaA.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid()::integer AS pid
    `;
    const [backendB] = await prismaB.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid()::integer AS pid
    `;
    expect(backendA?.pid).toEqual(expect.any(Number));
    expect(backendB?.pid).toEqual(expect.any(Number));
    expect(backendA?.pid).not.toBe(backendB?.pid);

    await expect(smsSettingsA.getActiveSettings()).resolves.toMatchObject({
      providerType: 'DEV_STUB',
    });
    await expect(wechatSettingsA.getActiveSettings()).resolves.toMatchObject({
      providerType: 'DEV_STUB',
    });
    await expect(storageSettingsA.getActiveSettings()).resolves.toMatchObject({
      providerType: 'LOCAL',
    });
    await expect(realnameSettingsA.getActiveSettings()).resolves.toMatchObject({
      providerType: 'DEV_STUB',
    });

    await cutoverAllToReal();

    await expect(smsSettingsA.getActiveSettings()).resolves.toMatchObject({
      providerType: 'TENCENT_SMS',
      sdkAppId: 'sms-app-new',
      credentials: { secretId: 'sms-id-new', secretKey: 'sms-key-new' },
    });
    await expect(wechatSettingsA.getActiveSettings()).resolves.toMatchObject({
      providerType: 'WECHAT',
      appId: 'wechat-app-new',
      credentials: { appSecret: 'wechat-secret-new' },
    });
    await expect(storageSettingsA.getActiveSettings()).resolves.toMatchObject({
      providerType: 'COS',
      bucket: 'cos-bucket-new',
      region: 'cos-region-new',
      credentials: { secretId: 'cos-id-new', secretKey: 'cos-key-new' },
    });
    await expect(realnameSettingsA.getActiveSettings()).resolves.toMatchObject({
      providerType: 'TENCENT_CLOUD',
      region: 'realname-region-new',
      credentials: { secretId: 'realname-id-new', secretKey: 'realname-key-new' },
    });
    const httpAudits = await prismaA.auditLog.findMany({
      where: {
        event: {
          in: [
            'sms-setting.update',
            'sms-setting.reset-credentials',
            'wechat-setting.update',
            'wechat-setting.reset-credentials',
            'storage-setting.update',
            'storage-setting.reset-credentials',
            'realname-setting.update',
            'realname-setting.reset-credentials',
          ],
        },
      },
      select: { actorUserId: true, actorRoleSnap: true, context: true },
    });
    expect(httpAudits).toHaveLength(8);
    for (const audit of httpAudits) {
      expect(audit.actorUserId).toBe(actor.id);
      expect(audit.actorRoleSnap).toBe(Role.SUPER_ADMIN);
      expect(audit.context).toMatchObject({
        requestId: expect.stringMatching(/^settings-http-new-/),
        ua: HTTP_USER_AGENT,
      });
    }
  });

  it('真实 audit/写事务 barrier：A 看不到 B 未提交值，commit 后下一读可见', async () => {
    const auditEntered = deferred<void>();
    const releaseAudit = deferred<void>();
    const originalLog = auditB.log.bind(auditB);
    jest.spyOn(auditB, 'log').mockImplementation(async (input) => {
      if (input.event === 'storage-setting.update') {
        auditEntered.resolve();
        await releaseAudit.promise;
      }
      return originalLog(input);
    });

    // 有意保留 service 直调：此探针必须把 spy 插在 B 写事务内部、audit 提交之前。
    const update = storageSettingsB.updateSettings(
      { providerType: 'COS', bucket: 'pending-bucket', region: 'pending-region' },
      actor,
      AUDIT_META,
    );
    void update.catch((error: unknown) => auditEntered.reject(error));
    try {
      await auditEntered.promise;
      await expect(storageSettingsA.getActiveSettings()).resolves.toMatchObject({
        providerType: 'LOCAL',
        bucket: null,
        region: null,
      });
    } finally {
      releaseAudit.resolve();
    }
    await expect(update).resolves.toMatchObject({
      providerType: 'COS',
      bucket: 'pending-bucket',
      region: 'pending-region',
    });
    await expect(storageSettingsA.getActiveSettings()).resolves.toMatchObject({
      providerType: 'COS',
      bucket: 'pending-bucket',
      region: 'pending-region',
    });
  });

  it('audit 失败令写事务回滚；A 的下一读取绝不暴露失败值', async () => {
    const auditFailure = new Error('synthetic settings audit failure');
    jest.spyOn(auditB, 'log').mockRejectedValue(auditFailure);

    // 有意保留 service 直调：需要精确注入事务内 audit failure，正常 cutover 均走 appB HTTP。
    await expect(smsSettingsB.updateSettings({ enabled: false }, actor, AUDIT_META)).rejects.toBe(
      auditFailure,
    );
    await expect(smsSettingsA.getActiveSettings()).resolves.toMatchObject({
      providerType: 'DEV_STUB',
      enabled: true,
    });
    expect(await prismaA.auditLog.count({ where: { event: 'sms-setting.update' } })).toBe(0);
  });

  it('四路 provider boundary：已取得旧 route 保持旧快照；下一 Effect 使用新代 SDK/fetch 参数', async () => {
    const oldSmsRoute = await smsRouterA.resolveRoute();
    const oldWechatRoute = await wechatA.resolveRoute();
    const oldRealnameRoute = await realnameA.resolveRoute();
    await expect(
      storageRouterA.generateUploadUrl({
        key: 'old-local',
        contentType: 'image/png',
        expiresIn: 60,
      }),
    ).resolves.toMatchObject({
      url: expect.stringContaining('/internal/storage/local-stub-upload/'),
    });

    const devSms = jest.spyOn(appA.get(DevStubSmsProvider), 'sendVerifyCode');
    const devRealname = jest.spyOn(appA.get(DevStubRealnameProvider), 'recognize');
    await cutoverAllToReal();

    await oldSmsRoute
      .prepareVerifyCode({ phone: '13900009991', code: '888888', ttlMinutes: 5 })
      .invoke();
    await expect(oldWechatRoute.code2session({ code: 'old-route' })).resolves.toEqual({
      openid: 'dev-openid-old-route',
    });
    await oldRealnameRoute
      .prepare({
        documentTypeCode: 'mainland_id',
        image: Buffer.from('{"name":"旧代","idCardNumber":"old"}'),
        mimeType: 'image/jpeg',
      })
      .invoke();
    expect(devSms).toHaveBeenCalledTimes(1);
    expect(devRealname).toHaveBeenCalledTimes(1);

    const sendSms = jest.spyOn(sms.v20210111.Client.prototype, 'SendSms').mockResolvedValue({
      SendStatusSet: [{ Code: 'Ok', Message: 'send success', SerialNo: 'sms-new-serial' }],
    });
    COSMock.__mockInstance.getObjectUrl.mockReturnValue(
      'https://cos-new.example/object?signature=new',
    );
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((request) => {
      const url = fetchUrl(request);
      if (url.includes('/cgi-bin/stable_token')) {
        return Promise.resolve(
          jsonResponse({ access_token: 'wechat-token-new', expires_in: 7200 }),
        );
      }
      if (url.includes('/cgi-bin/message/subscribe/send')) {
        return Promise.resolve(jsonResponse({ errcode: 0, msgid: 1001 }));
      }
      if (url === 'https://ocr.tencentcloudapi.com') {
        return Promise.resolve(
          jsonResponse({
            Response: {
              IDCardInfo: {
                Name: { Content: '新代' },
                IdNum: { Content: '110101199003070038' },
              },
              RequestId: 'realname-new-request',
            },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected mocked fetch target: ${url}`));
    });

    const smsPrepare = jest.spyOn(appA.get(TencentSmsProvider), 'prepareVerifyCode');
    const wechatPrepare = jest.spyOn(appA.get(WechatMiniRealProvider), 'prepare');
    const cosPrepare = jest.spyOn(appA.get(CosStorageProvider), 'prepare');
    const realnamePrepare = jest.spyOn(appA.get(TencentRealnameProvider), 'prepare');

    await expect(
      smsRouterA.sendVerifyCode({ phone: '13900009992', code: '123456', ttlMinutes: 5 }),
    ).resolves.toEqual({ providerMsgId: 'sms-new-serial' });
    await expect(
      storageRouterA.generateUploadUrl({
        key: 'new-cos',
        contentType: 'image/png',
        expiresIn: 60,
      }),
    ).resolves.toMatchObject({ url: 'https://cos-new.example/object?signature=new' });
    await expect(
      wechatA.sendSubscribeMessage({
        openid: 'openid-new',
        templateId: 'template-new',
        data: { thing1: { value: 'new generation' } },
      }),
    ).resolves.toEqual({ ok: true, msgId: '1001' });
    const realnameRoute = await realnameA.resolveRoute();
    await expect(
      realnameRoute
        .prepare({
          documentTypeCode: 'mainland_id',
          image: Buffer.from('new-realname-image'),
          mimeType: 'image/jpeg',
        })
        .invoke(),
    ).resolves.toMatchObject({ recognized: true, name: '新代' });

    expect(smsPrepare.mock.calls[0]?.[0]).toMatchObject({
      providerType: 'TENCENT_SMS',
      sdkAppId: 'sms-app-new',
      credentials: { secretId: 'sms-id-new', secretKey: 'sms-key-new' },
    });
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        SmsSdkAppId: 'sms-app-new',
        SignName: 'sms-sign-new',
        TemplateId: 'sms-template-new',
      }),
    );
    expect(cosPrepare.mock.calls[0]?.[0]).toMatchObject({
      bucket: 'cos-bucket-new',
      region: 'cos-region-new',
      credentials: { secretId: 'cos-id-new', secretKey: 'cos-key-new' },
    });
    expect(COSMock).toHaveBeenCalledWith({
      SecretId: 'cos-id-new',
      SecretKey: 'cos-key-new',
      Timeout: 8000,
    });
    expect(COSMock.__mockInstance.getObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: 'cos-bucket-new', Region: 'cos-region-new' }),
    );
    expect(wechatPrepare.mock.calls[0]?.[0]).toMatchObject({
      appId: 'wechat-app-new',
      credentials: { appSecret: 'wechat-secret-new' },
    });
    expect(realnamePrepare.mock.calls[0]?.[0]).toMatchObject({
      region: 'realname-region-new',
      credentials: { secretId: 'realname-id-new', secretKey: 'realname-key-new' },
    });

    const stableCall = fetchSpy.mock.calls.find(([request]) =>
      fetchUrl(request).includes('/cgi-bin/stable_token'),
    );
    expect(JSON.parse(stableCall?.[1]?.body as string)).toMatchObject({
      appid: 'wechat-app-new',
      secret: 'wechat-secret-new',
    });
    const realnameCall = fetchSpy.mock.calls.find(
      ([request]) => fetchUrl(request) === 'https://ocr.tencentcloudapi.com',
    );
    const realnameHeaders = realnameCall?.[1]?.headers as Record<string, string>;
    expect(realnameHeaders['X-TC-Region']).toBe('realname-region-new');
    expect(realnameHeaders.Authorization).toContain('Credential=realname-id-new/');
  });

  it('Storage pinned locator 固定旧 bucket/region，凭证轮换后下一 Effect 使用当前凭证', async () => {
    await postSettingsThroughAppB(
      `${SETTINGS_ENDPOINTS.storage}/reset-credentials`,
      { secretId: 'cos-id-old', secretKey: 'cos-key-old' },
      'settings-http-pinned-storage-reset-old',
    );
    await patchSettingsThroughAppB(
      SETTINGS_ENDPOINTS.storage,
      { providerType: 'COS', bucket: 'bucket-pinned-old', region: 'region-pinned-old' },
      'settings-http-pinned-storage-patch-old',
    );
    const pinned = await storageRouterA.getCurrentLocator();
    expect(pinned).toEqual({
      providerType: 'COS',
      bucket: 'bucket-pinned-old',
      region: 'region-pinned-old',
      localNamespace: null,
    });

    await postSettingsThroughAppB(
      `${SETTINGS_ENDPOINTS.storage}/reset-credentials`,
      { secretId: 'cos-id-rotated', secretKey: 'cos-key-rotated' },
      'settings-http-pinned-storage-reset-rotated',
    );
    await patchSettingsThroughAppB(
      SETTINGS_ENDPOINTS.storage,
      { bucket: 'bucket-current-new', region: 'region-current-new' },
      'settings-http-pinned-storage-patch-current',
    );
    COSMock.mockClear();
    COSMock.__mockInstance.getObjectUrl
      .mockReset()
      .mockReturnValue('https://pinned.example/signed');

    await expect(
      storageRouterA.generateUploadUrlAt(pinned, {
        key: 'pinned-key',
        contentType: 'application/pdf',
        expiresIn: 60,
      }),
    ).resolves.toMatchObject({ url: 'https://pinned.example/signed' });
    expect(COSMock).toHaveBeenCalledWith({
      SecretId: 'cos-id-rotated',
      SecretKey: 'cos-key-rotated',
      Timeout: 8000,
    });
    expect(COSMock.__mockInstance.getObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'bucket-pinned-old',
        Region: 'region-pinned-old',
      }),
    );
  });

  it('WeChat 在途 Effect barrier：配置提交不撕裂旧 delivery；下一 delivery 不命中旧 generation token', async () => {
    await postSettingsThroughAppB(
      `${SETTINGS_ENDPOINTS.wechat}/reset-credentials`,
      { appSecret: 'wechat-secret-old-real' },
      'settings-http-wechat-barrier-reset-old',
    );
    await patchSettingsThroughAppB(
      SETTINGS_ENDPOINTS.wechat,
      { providerType: 'WECHAT', appId: 'wechat-app-old-real', enabled: true },
      'settings-http-wechat-barrier-patch-old',
    );

    const firstStableStarted = deferred<{ appid: string; secret: string }>();
    const firstStableResponse = deferred<Response>();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((request, init) => {
      const url = fetchUrl(request);
      if (url.includes('/cgi-bin/stable_token')) {
        const body = JSON.parse(init?.body as string) as { appid: string; secret: string };
        if (body.appid === 'wechat-app-old-real') {
          firstStableStarted.resolve(body);
          return firstStableResponse.promise;
        }
        return Promise.resolve(
          jsonResponse({ access_token: 'token-new-generation', expires_in: 7200 }),
        );
      }
      if (url.includes('/cgi-bin/message/subscribe/send')) {
        return Promise.resolve(
          jsonResponse({ errcode: 0, msgid: url.includes('token-old-generation') ? 1 : 2 }),
        );
      }
      return Promise.reject(new Error(`unexpected mocked fetch target: ${url}`));
    });

    const inFlight = wechatA.sendSubscribeMessage({
      openid: 'openid-old-delivery',
      templateId: 'template-old-delivery',
      data: {},
    });
    void inFlight.catch((error: unknown) => firstStableStarted.reject(error));
    try {
      await expect(firstStableStarted.promise).resolves.toEqual({
        appid: 'wechat-app-old-real',
        secret: 'wechat-secret-old-real',
        grant_type: 'client_credential',
        force_refresh: false,
      });

      await postSettingsThroughAppB(
        `${SETTINGS_ENDPOINTS.wechat}/reset-credentials`,
        { appSecret: 'wechat-secret-new-real' },
        'settings-http-wechat-barrier-reset-new',
      );
      await patchSettingsThroughAppB(
        SETTINGS_ENDPOINTS.wechat,
        { appId: 'wechat-app-new-real' },
        'settings-http-wechat-barrier-patch-new',
      );
    } finally {
      firstStableResponse.resolve(
        jsonResponse({ access_token: 'token-old-generation', expires_in: 7200 }),
      );
    }
    await expect(inFlight).resolves.toEqual({ ok: true, msgId: '1' });

    await expect(
      wechatA.sendSubscribeMessage({
        openid: 'openid-new-delivery',
        templateId: 'template-new-delivery',
        data: {},
      }),
    ).resolves.toEqual({ ok: true, msgId: '2' });

    const stableBodies = fetchSpy.mock.calls
      .filter(([request]) => fetchUrl(request).includes('/cgi-bin/stable_token'))
      .map(
        ([, init]) =>
          JSON.parse(init?.body as string) as {
            appid: string;
            secret: string;
            grant_type: 'client_credential';
            force_refresh: false;
          },
      );
    expect(stableBodies).toEqual([
      {
        appid: 'wechat-app-old-real',
        secret: 'wechat-secret-old-real',
        grant_type: 'client_credential',
        force_refresh: false,
      },
      {
        appid: 'wechat-app-new-real',
        secret: 'wechat-secret-new-real',
        grant_type: 'client_credential',
        force_refresh: false,
      },
    ]);
    const sendUrls = fetchSpy.mock.calls
      .map(([request]) => fetchUrl(request))
      .filter((url) => url.includes('/cgi-bin/message/subscribe/send'));
    expect(sendUrls[0]).toContain('access_token=token-old-generation');
    expect(sendUrls[1]).toContain('access_token=token-new-generation');
  });
});

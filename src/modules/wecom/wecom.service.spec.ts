import type { ConfigType } from '@nestjs/config';

import type appConfig from '../../config/app.config';
import type { RbacService } from '../permissions/rbac.service';
import { DevStubWecomProvider } from './providers/dev-stub-wecom.provider';
import { WecomRealProvider } from './providers/wecom.provider';
import { WecomService } from './wecom.service';
import type { WecomSettingsService } from './wecom-settings.service';
import { WecomCredentialStatus, type WecomSettingsResolved } from './wecom.types';

// 企业微信 T2 收口 W3(2026-08-01):`resolveRoute` 并发不串配置 —— 走真实编排路径的 red-first
//
// 与 `providers/wecom.provider.spec.ts` 的分工:那份钉的是 Provider 自身的形状
// (`prepare` 不写实例字段),这份钉的是**缺陷在真实调用路径上可达** ——
// `resolveRoute()` = `await getActiveSettings()`(异步,让出)→ `routeFor` → `prepare`。
// 两个并发请求都完成 DB 读之后才轮到任一个真正发外部请求,这正是修复前
// `this.settings = settings; return this` 被后到者覆写的窗口。
//
// 纯构造器注入 mock,不起 Nest、不连库(沿 wechat.service.spec 范式)。

let generationSeq = 0;

function makeResolved(overrides: Partial<WecomSettingsResolved> = {}): WecomSettingsResolved {
  generationSeq += 1;
  return {
    id: 'wc1',
    configurationGeneration: `svc-generation-${generationSeq}`,
    providerType: 'WECOM',
    enabled: true,
    loginEnabled: true,
    messageEnabled: true,
    corpId: 'ww-corp-default',
    agentId: 1000002,
    webBaseUrl: 'https://app.example.com',
    credentials: { corpSecret: 'secret-default' },
    credentialStatus: WecomCredentialStatus.CONFIGURED,
    remarks: null,
    updatedBy: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

describe('WecomService.resolveRoute 并发', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('两个并发 resolveRoute 拿到不同配置快照 → 各自的外部请求用各自的 CorpID / CorpSecret', async () => {
    const s1 = makeResolved({
      corpId: 'ww-route-1',
      credentials: { corpSecret: 'route-secret-1' },
    });
    const s2 = makeResolved({
      corpId: 'ww-route-2',
      credentials: { corpSecret: 'route-secret-2' },
    });

    const settings = {
      getActiveSettings: jest
        .fn()
        .mockResolvedValueOnce(s1)
        .mockResolvedValueOnce(s2) as unknown as WecomSettingsService['getActiveSettings'],
    } as unknown as WecomSettingsService;
    const rbac = { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService;
    const service = new WecomService(
      settings,
      new DevStubWecomProvider(),
      new WecomRealProvider(),
      rbac,
      { env: 'test' } as ConfigType<typeof appConfig>,
    );

    const urls: string[] = [];
    fetchSpy.mockImplementation((input: unknown) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ errcode: 0, access_token: 't', expires_in: 7200 }), {
          status: 200,
        }),
      );
    });

    // 两条路由都先解析完配置(此时修复前的 `this.settings` 已被后到者覆写),再各自发请求
    const [routeA, routeB] = await Promise.all([service.resolveRoute(), service.resolveRoute()]);
    await Promise.all([routeA.getAccessToken(), routeB.getAccessToken()]);

    expect(urls).toHaveLength(2);
    expect(
      urls.some((u) => u.includes('corpid=ww-route-1') && u.includes('corpsecret=route-secret-1')),
    ).toBe(true);
    expect(
      urls.some((u) => u.includes('corpid=ww-route-2') && u.includes('corpsecret=route-secret-2')),
    ).toBe(true);
  });
});

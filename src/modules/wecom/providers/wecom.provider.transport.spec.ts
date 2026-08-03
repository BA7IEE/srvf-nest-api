import { WecomApiError, WecomCredentialStatus, type WecomSettingsResolved } from '../wecom.types';
import { WecomRealProvider } from './wecom.provider';

// 外部评审 F2 第二刀(2026-08-03):传输层 fence / 物理尝试预算 / 类型化错误 / 严格回执解析
//
// 本文件全部是 **red-first** 用例:每一条都先在未修代码上跑红。断言刻意写成
// **字符串字面量 + 可选属性读取**(`(err as { kind?: string }).kind`),这样修复前
// 整个文件仍能编译 —— 于是"哪一条红"本身就是判据,而不是被一个编译错误整体盖住。
//
// 对应评审 BLOCKER:
//   B6 —— fence 与重试归属:`beforeEffect` 必须在**每次真实 fetch 紧前**(含 request 内重试);
//         message/send 的物理尝试预算归 Outbox;`forceRefresh` 只绕缓存 token,
//         **不绕**进行中的 `refreshPromise`。
//   B7 —— 错误类型不被擦除:Provider 抛出 / 返回的每一个失败都带 `kind` 闭集标签,
//         调用方据此决定退避与否,而不是靠 errCode 字符串嗅探。
//   SF1 —— strict receipt parser:四个名单字段三分(缺席/空串 = 空名单;字符串 = 解析;
//         其它类型 = INVALID_RESPONSE),且 `errcode != 0` 与 invalidparty/invalidtag
//         同时出现时不得漏判契约错。

const AGENT_ID = 1000002;
const SEND_INPUT = {
  toUser: 'zhangsan',
  title: 't',
  description: 'd',
  url: 'https://app.example.com',
} as const;

let generationSeq = 0;

// token cache 是**模块级** Map(键含 configurationGeneration),跨用例不清空;
// 每条用例给独立 generation,否则上一条的 token 会命中本条、把 gettoken 断言静默跳过。
function makeResolved(overrides: Partial<WecomSettingsResolved> = {}): WecomSettingsResolved {
  generationSeq += 1;
  return {
    id: 'wc-transport',
    configurationGeneration: `transport-generation-${generationSeq}`,
    providerType: 'WECOM',
    enabled: true,
    loginEnabled: true,
    messageEnabled: true,
    corpId: 'ww-corp-transport',
    agentId: AGENT_ID,
    webBaseUrl: 'https://app.example.com',
    credentials: { corpSecret: 'secret-transport' },
    credentialStatus: WecomCredentialStatus.CONFIGURED,
    remarks: null,
    updatedBy: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err;
  }
}

/** 读取归一化错误分类标签。修复前该属性不存在 ⇒ `undefined` ⇒ 用例红。 */
function kindOf(value: unknown): string | undefined {
  return (value as { kind?: string } | undefined)?.kind;
}

describe('WecomRealProvider 传输层(评审 F2:B6 / B7 / SF1)', () => {
  let fetchSpy: jest.SpyInstance;
  let provider: WecomRealProvider;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    provider = new WecomRealProvider();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockJson(body: unknown, status = 200): void {
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
  }

  function prepared(settings: WecomSettingsResolved = makeResolved()) {
    return provider.prepare(settings);
  }

  // ===== B6 ①:fence 下沉到每次 fetch 紧前 =====

  describe('B6 fence 归属', () => {
    // 修复前:`beforeEffect` 只在 `fetchAccessToken` 开头调用一次,而 `request()` 内部
    // 对 errcode=-1 自动重试至多 3 次 ⇒ 第 2、3 次 fetch **完全没有 fence 校验**。
    // 现场后果:lease 已经丢了(别的 worker 正在跑同一条 intent),我们仍继续打上游。
    it('第一次 fetch 后 guard 失败 ⇒ 第二次 fetch 根本不启动', async () => {
      mockJson({ errcode: -1, errmsg: 'system busy' });
      let guardCalls = 0;
      const beforeEffect = (): Promise<void> => {
        guardCalls += 1;
        // 第一次放行,第二次(= 重试那一次)失败
        return guardCalls === 1 ? Promise.resolve() : Promise.reject(new Error('LEASE_LOST'));
      };

      const err = await caughtFrom(prepared().getAccessToken(false, beforeEffect));

      expect((err as Error).message).toBe('LEASE_LOST');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(guardCalls).toBe(2);
    });

    // guard 抛出的错误必须**原样冒泡**,绝不能被 fetch 的 catch 归一化成 FETCH_ERROR ——
    // 那样 worker 就分不出"租约丢了"和"网络抖了",于是照常 nack 重试。
    it('guard 抛出的错误原样冒泡,不被归一化成网络错', async () => {
      mockJson({ errcode: 0, access_token: 't', expires_in: 7200 });
      const sentinel = new Error('LEASE_LOST');
      const err = await caughtFrom(
        prepared().getAccessToken(false, () => Promise.reject(sentinel)),
      );
      expect(err).toBe(sentinel);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ===== B6 ②:message/send 的物理尝试预算归 Outbox =====

  describe('B6 物理尝试预算', () => {
    // 修复前:Provider 自己对 5xx / 网络错重试 3 次,Outbox 再退避 8 次,
    // 而 `deliverWecom` 还会因 token-invalid 再走一遍 ⇒ **一条通知最多 48 次物理 message/send**。
    // 重复检查窗口(1800s)是第二层保险,不是让我们放心打点的理由。
    it('message/send 遇 HTTP 5xx 只打上游一次(重试预算全部交给 Outbox)', async () => {
      mockJson({ errcode: -1 }, 502);
      const result = await prepared().sendTextCard('token', SEND_INPUT);
      expect(result.ok).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('message/send 遇 errcode=-1 系统繁忙同样只打一次,由 Outbox 退避', async () => {
      mockJson({ errcode: -1, errmsg: 'system busy' });
      const result = await prepared().sendTextCard('token', SEND_INPUT);
      expect(result.ok).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // 反向锁:gettoken 仍保留系统繁忙的 3 次上限(它不产生用户可见 Effect,
    // 且登录链路没有 Outbox 兜底 —— 把它一起砍掉等于改 T3 的行为)。
    it('反向:gettoken 的 -1 重试上限维持 3 次不变', async () => {
      mockJson({ errcode: -1, errmsg: 'system busy' });
      await caughtFrom(prepared().getAccessToken());
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
  });

  // ===== B6 ③:forceRefresh 只绕缓存,不绕在途刷新 =====

  describe('B6 forceRefresh 合流', () => {
    // 修复前:`if (!forceRefresh && cached?.refreshPromise) return cached.refreshPromise;`
    // ⇒ forceRefresh 直接跳过合流,N 个并发 40014 各起一次 gettoken。
    // 45009 正是这么被自己触发的:一次 token 失效 = 一批 worker 同时打 gettoken。
    it('并发 forceRefresh(40014 场景)⇒ gettoken 实际请求次数 = 1', async () => {
      let resolveFetch: ((res: Response) => void) | undefined;
      const pending = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      fetchSpy.mockImplementation(() => pending);

      const route = prepared();
      const a = route.getAccessToken(true);
      const b = route.getAccessToken(true);
      // 让两个调用都进入 getAccessToken 之后再放行上游
      await Promise.resolve();
      resolveFetch!(jsonResponse({ errcode: 0, access_token: 'tok', expires_in: 7200 }));

      await expect(Promise.all([a, b])).resolves.toEqual(['tok', 'tok']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // 反向锁:forceRefresh 仍必须绕过**已缓存的 token**(诊断接口靠它证明"现在这套凭证可用")。
    it('反向:forceRefresh 绕过已缓存 token,重新打 gettoken', async () => {
      mockJson({ errcode: 0, access_token: 'tok', expires_in: 7200 });
      const route = prepared();
      await route.getAccessToken();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await route.getAccessToken(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ===== B7:类型化错误 =====

  describe('B7 类型化错误闭集', () => {
    it.each([
      ['gettoken 45009 限流', { errcode: 45009 }, 200, 'rate-limited'],
      ['gettoken 40001 凭证错(配置终态)', { errcode: 40001 }, 200, 'config-fatal'],
      ['gettoken 40014 token 失效', { errcode: 40014 }, 200, 'token-invalid'],
      ['gettoken 回执畸形', {}, 200, 'invalid-response'],
      ['HTTP 4xx(确定性,重试无意义)', { errcode: 0 }, 400, 'http-4xx'],
      ['HTTP 5xx(暂态,可退避)', { errcode: 0 }, 503, 'http-5xx'],
    ])('%s → kind=%p', async (_label, body, status, expectedKind) => {
      mockJson(body, status);
      const err = await caughtFrom(prepared().getAccessToken());
      expect(kindOf(err)).toBe(expectedKind);
    });

    it('网络错 → kind=network(与 timeout 分开,两者退避语义相同但诊断不同)', async () => {
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
      const err = await caughtFrom(prepared().getAccessToken());
      expect(kindOf(err)).toBe('network');
    });

    it('超时 → kind=timeout', async () => {
      const timeout = new Error('timed out');
      timeout.name = 'TimeoutError';
      fetchSpy.mockRejectedValue(timeout);
      const err = await caughtFrom(prepared().getAccessToken());
      expect(kindOf(err)).toBe('timeout');
    });

    it('系统繁忙耗尽 → kind=system-busy(上游自己说的"稍后再试",归可退避)', async () => {
      mockJson({ errcode: -1 });
      const err = await caughtFrom(prepared().getAccessToken());
      expect(kindOf(err)).toBe('system-busy');
    });

    // sendTextCard 不抛异常而是返回判别联合 —— 失败分支同样必须带 kind,
    // 否则 Outbox 只能回到"按 errCode 字符串猜",而那正是被擦除的那一层。
    it.each([
      ['45009', { errcode: 45009 }, 200, 'rate-limited'],
      ['40001 配置终态', { errcode: 40001 }, 200, 'config-fatal'],
      ['40014 token 失效', { errcode: 40014 }, 200, 'token-invalid'],
      ['HTTP 4xx', { errcode: 0 }, 400, 'http-4xx'],
      ['HTTP 5xx', { errcode: 0 }, 503, 'http-5xx'],
      ['回执畸形', {}, 200, 'invalid-response'],
    ])('message/send %s → ok:false 且 kind=%p', async (_label, body, status, expectedKind) => {
      mockJson(body, status);
      const result = await prepared().sendTextCard('token', SEND_INPUT);
      expect(result.ok).toBe(false);
      expect(kindOf(result)).toBe(expectedKind);
    });

    it('反向:message/send 成功分支形状逐字不变(不多带 kind)', async () => {
      mockJson({ errcode: 0, msgid: 'M1' });
      const result = await prepared().sendTextCard('token', SEND_INPUT);
      expect(result).toEqual({ ok: true, msgId: 'M1', invalidUsers: [], unlicensedUsers: [] });
    });
  });

  // ===== SF1:strict receipt parser =====

  describe('SF1 严格回执解析', () => {
    // 修复前 `splitUserList` 对**任何非字符串**都返回 `[]` ⇒ `invaliduser: 123` 被读成
    // "没有无效收件人" ⇒ 这条投递被记为 **SENT**。运营指标④⑤于是集体失真。
    it.each([
      ['数字', 123],
      ['显式 null', null],
      ['数组', ['zhangsan']],
      ['对象', { userid: 'zhangsan' }],
      ['布尔', true],
    ])('invaliduser 是%s ⇒ INVALID_RESPONSE,**不得** SENT', async (_label, invaliduser) => {
      mockJson({ errcode: 0, msgid: 'M1', invaliduser });
      const result = await prepared().sendTextCard('token', SEND_INPUT);
      expect(result.ok).toBe(false);
      expect(kindOf(result)).toBe('invalid-response');
    });

    it.each(['unlicenseduser', 'invalidparty', 'invalidtag'])(
      '%s 是数字 ⇒ 同样 INVALID_RESPONSE(四个名单字段一视同仁)',
      async (key) => {
        mockJson({ errcode: 0, msgid: 'M1', [key]: 7 });
        const result = await prepared().sendTextCard('token', SEND_INPUT);
        expect(result.ok).toBe(false);
        expect(kindOf(result)).toBe('invalid-response');
      },
    );

    it('反向:四个名单字段全缺席 ⇒ 空名单,正常 SENT', async () => {
      mockJson({ errcode: 0, msgid: 'M1' });
      const result = await prepared().sendTextCard('token', SEND_INPUT);
      expect(result).toEqual({ ok: true, msgId: 'M1', invalidUsers: [], unlicensedUsers: [] });
    });

    it('反向:空串 ⇒ 空名单(官方"没有"就是空串,不是缺席)', async () => {
      mockJson({
        errcode: 0,
        msgid: 'M1',
        invaliduser: '',
        unlicenseduser: '',
        invalidparty: '',
        invalidtag: '',
      });
      const result = await prepared().sendTextCard('token', SEND_INPUT);
      expect(result).toEqual({ ok: true, msgId: 'M1', invalidUsers: [], unlicensedUsers: [] });
    });

    it('反向:字符串名单照常解析', async () => {
      mockJson({ errcode: 0, msgid: 'M1', invaliduser: 'a|b', unlicenseduser: 'c' });
      const result = await prepared().sendTextCard('token', SEND_INPUT);
      expect(result).toEqual({
        ok: true,
        msgId: 'M1',
        invalidUsers: ['a', 'b'],
        unlicensedUsers: ['c'],
      });
    });

    // 修复前:`errcode != 0` 直接 return,**根本不看** invalidparty/invalidtag ——
    // 于是"我们发的请求根本不是我们以为的那个"这条最硬的信号被 errcode 盖住。
    it('errcode != 0 且带 invalidparty ⇒ 仍判契约错(不被 errcode 盖住)', async () => {
      mockJson({ errcode: 40008, invalidparty: '12' });
      const result = await prepared().sendTextCard('token', SEND_INPUT);
      expect(result.ok).toBe(false);
      expect((result as { errCode: string }).errCode).toBe('INVALID_PARTY_OR_TAG');
    });

    it('errcode != 0 且 invalidtag 类型非法 ⇒ INVALID_RESPONSE 优先(读不懂就不下结论)', async () => {
      mockJson({ errcode: 40008, invalidtag: 12 });
      const result = await prepared().sendTextCard('token', SEND_INPUT);
      expect(result.ok).toBe(false);
      expect(kindOf(result)).toBe('invalid-response');
    });

    it('反向:errcode != 0 且名单字段全缺席 ⇒ 按 errcode 分类', async () => {
      mockJson({ errcode: 45009 });
      const result = await prepared().sendTextCard('token', SEND_INPUT);
      expect(result.ok).toBe(false);
      expect((result as { errCode: string }).errCode).toBe('45009');
    });
  });

  // ===== L3 日志纪律回归(新增标签不得泄露 URL / secret)=====

  it('新增 kind 标签不带出任何 URL / corpsecret', async () => {
    const raw = new TypeError('fetch failed to https://qyapi.weixin.qq.com/...corpsecret=leak');
    fetchSpy.mockRejectedValue(raw);
    const err = await caughtFrom(prepared().getAccessToken());
    const serialized = `${(err as Error).message} ${(err as WecomApiError).errMsg} ${kindOf(err)}`;
    expect(serialized).not.toContain('corpsecret');
    expect(serialized).not.toContain('qyapi.weixin.qq.com');
  });
});

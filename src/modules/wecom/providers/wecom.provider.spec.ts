import {
  WecomApiError,
  WecomChannelUnavailableError,
  WecomCredentialStatus,
  type WecomProvider,
  type WecomSettingsResolved,
} from '../wecom.types';
import { WecomRealProvider } from './wecom.provider';

// 企业微信 T2 收口 W2 / W3(2026-08-01):真实 Provider 单元测试(mock 全局 fetch)
//
// **W2 —— `agent/get` 端点级严格协议解析**(整批评审 P1 ④)
//   修复前用 `readNumber(body, key, fallback)` 兜底,三个默认值各自是一句谎话:
//     - `errcode` 缺失 → 0 = **成功**(比评审报告描述的更糟:上游返 `{}` 也算连通正常)
//     - `agentid` 缺失 → 填**本地配置的 agentId** ⇒ `agentMatched` 恒 true(自己和自己比)
//     - `close`   缺失 → 0 = **应用已启用**
//   ⇒ 诊断接口在上游什么都没说的情况下回答"一切正常"。
//   现在:errcode / agentid / close 必须**存在且为整数**,否则一律 `WecomApiError`(→ 36031)。
//
// **W3 —— Provider 去请求级状态**(整批评审 P1 ⑤)
//   修复前 `prepare(settings)` 写 `this.settings` 后 `return this`,而本类是 @Injectable **单例**
//   ⇒ 两个并发请求 prepare 后互串配置快照(后 prepare 的那份赢,两个请求都用它的 CorpID/Secret)。
//   现在 `prepare()` 返回**绑定不可变 ctx 的新对象**,类上不再有任何请求级字段。
//   `return this` 曾是全 `src/` 唯一一处 —— cos / wechat / realname 三个 provider 一直是 closure 范式。

const AGENT_ID = 1000002;

let generationSeq = 0;

// token cache 是**模块级** Map(键含 configurationGeneration),跨用例不清空;
// 每个快照给独立 generation,避免上一条用例的 token 命中本条(否则 gettoken 的断言会静默跳过)。
function makeResolved(overrides: Partial<WecomSettingsResolved> = {}): WecomSettingsResolved {
  generationSeq += 1;
  return {
    id: 'wc1',
    configurationGeneration: `generation-${generationSeq}`,
    providerType: 'WECOM',
    enabled: true,
    loginEnabled: true,
    messageEnabled: true,
    corpId: 'ww-corp-default',
    agentId: AGENT_ID,
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

describe('WecomRealProvider', () => {
  let fetchSpy: jest.SpyInstance;
  let provider: WecomRealProvider;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    provider = new WecomRealProvider();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /** 每次调用都造新 Response —— Response body 只能读一次,共用实例会让第二次 fetch 拿到已消费的流。 */
  function mockJson(body: unknown, status = 200): void {
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
  }

  function prepared(settings: WecomSettingsResolved = makeResolved()): WecomProvider {
    return provider.prepare(settings);
  }

  // ===== W2:agent/get 严格协议解析(六组畸形响应)=====

  describe('agent/get 严格协议解析(W2)', () => {
    // 修复前:这六组里有五组会被"本地默认值"补成一份看起来正常的快照。
    it.each([
      ['① `{}` —— 连 errcode 都没有', {}],
      ['② `{errcode:0}` —— 只有 errcode,缺 agentid / close', { errcode: 0 }],
      ['③ 缺 agentid', { errcode: 0, close: 0, name: '自建应用' }],
      ['④ 缺 close', { errcode: 0, agentid: AGENT_ID, name: '自建应用' }],
      [
        '⑤ 字符串型(errcode / agentid / close 全是字符串)',
        { errcode: '0', agentid: String(AGENT_ID), close: '0' },
      ],
      [
        '⑥ 可见范围结构错(allow_userinfos 不是对象)',
        { errcode: 0, agentid: AGENT_ID, close: 0, allow_userinfos: 'not-an-object' },
      ],
    ])('%s → WecomApiError(→ 36031),不得当成"连接正常"', async (_label, body) => {
      mockJson(body);
      const err = await caughtFrom(prepared().getAgent('token', AGENT_ID));
      expect(err).toBeInstanceOf(WecomApiError);
      expect((err as WecomApiError).errCode).toBe('INVALID_RESPONSE');
    });

    it('可见范围嵌套层结构错(allow_partys.partyid 不是数组)→ 36031(不静默计 0)', async () => {
      mockJson({
        errcode: 0,
        agentid: AGENT_ID,
        close: 0,
        allow_partys: { partyid: 'oops' },
      });
      const err = await caughtFrom(prepared().getAgent('token', AGENT_ID));
      expect(err).toBeInstanceOf(WecomApiError);
    });

    it('小数型 agentid → 36031(必须是整数,不是"能转成数字就行")', async () => {
      mockJson({ errcode: 0, agentid: 1000002.5, close: 0 });
      const err = await caughtFrom(prepared().getAgent('token', AGENT_ID));
      expect(err).toBeInstanceOf(WecomApiError);
    });

    // 关键反证:缺 agentid 时**绝不能**回填本地 agentId —— 那等于用本地配置冒充上游事实,
    // 让 test-connection 的 agentMatched 变成"自己和自己比",永远 true。
    it('缺 agentid 时不得回填本地 agentId(修复前正是这条让 agentMatched 恒 true)', async () => {
      mockJson({ errcode: 0, close: 0 });
      const err = await caughtFrom(prepared().getAgent('token', AGENT_ID));
      expect(err).toBeInstanceOf(WecomApiError);
      expect(String((err as Error).message)).not.toContain(String(AGENT_ID));
    });

    it('反向:字段齐备 → 原样解析,可见范围只出计数不出任何 ID', async () => {
      mockJson({
        errcode: 0,
        errmsg: 'ok',
        agentid: AGENT_ID,
        name: '救援队自建应用',
        close: 0,
        allow_userinfos: { user: [{ userid: 'zhangsan' }, { userid: 'lisi' }] },
        allow_partys: { partyid: [1, 2, 3] },
        allow_tags: { tagid: [] },
      });
      const agent = await prepared().getAgent('token', AGENT_ID);
      expect(agent).toEqual({
        agentId: AGENT_ID,
        name: '救援队自建应用',
        close: 0,
        allowUserCount: 2,
        allowPartyCount: 3,
        allowTagCount: 0,
      });
      // §7.1 规则 12:返回类型里根本没有存放 ID 的字段
      expect(JSON.stringify(agent)).not.toContain('zhangsan');
    });

    it('反向:可见范围键**整个缺失** → 计 0(缺席 = 空列表,是协议读法而非本地兜底)', async () => {
      mockJson({ errcode: 0, agentid: AGENT_ID, close: 0, name: 'x' });
      const agent = await prepared().getAgent('token', AGENT_ID);
      expect(agent.allowUserCount).toBe(0);
      expect(agent.allowPartyCount).toBe(0);
      expect(agent.allowTagCount).toBe(0);
    });

    it('反向:close=1(应用已停用)如实返回,不被默认值抹平', async () => {
      mockJson({ errcode: 0, agentid: AGENT_ID, close: 1 });
      const agent = await prepared().getAgent('token', AGENT_ID);
      expect(agent.close).toBe(1);
    });

    it('非 0 errcode 仍按 errcode 分类:40056 → WecomChannelUnavailableError(→ 36030)', async () => {
      mockJson({ errcode: 40056, errmsg: 'invalid agentid' });
      const err = await caughtFrom(prepared().getAgent('token', AGENT_ID));
      expect(err).toBeInstanceOf(WecomChannelUnavailableError);
    });
  });

  // ===== W2 的同类默认值在其余端点上的清扫 =====

  describe('其余端点同样禁止用默认值补上游事实(W2)', () => {
    it('gettoken 返 `{}` → 36031(修复前 errcode 缺失当成功,再靠 access_token 缺失才拦下)', async () => {
      mockJson({});
      const err = await caughtFrom(prepared().getAccessToken());
      expect(err).toBeInstanceOf(WecomApiError);
      expect((err as WecomApiError).errCode).toBe('INVALID_RESPONSE');
    });

    it('message/send 返 `{}` → ok:false(修复前 errcode 缺失 ⇒ 记为发送成功)', async () => {
      mockJson({});
      const result = await prepared().sendTextCard('token', {
        toUser: 'zhangsan',
        title: 't',
        description: 'd',
        url: 'https://app.example.com',
      });
      expect(result.ok).toBe(false);
    });

    it('auth/getuserinfo 返 `{}` → 抛错,不得当成"拿到了身份"', async () => {
      mockJson({});
      const err = await caughtFrom(prepared().exchangeOAuthCode({ code: 'c' }));
      expect(err).toBeInstanceOf(Error);
    });

    it('反向:message/send 字段齐备 → ok:true 且投递诊断如实带出', async () => {
      mockJson({ errcode: 0, errmsg: 'ok', msgid: 'MSGID1', invaliduser: 'a|b' });
      const result = await prepared().sendTextCard('token', {
        toUser: 'a|b|c',
        title: 't',
        description: 'd',
        url: 'https://app.example.com',
      });
      expect(result).toEqual({
        ok: true,
        msgId: 'MSGID1',
        invalidUsers: ['a', 'b'],
        unlicensedUsers: [],
      });
    });
  });

  // ===== W3:Provider 无请求级状态 =====

  describe('无请求级状态(W3)', () => {
    it('prepare() 返回**新对象**而非 this —— 类上没有可被下一个请求覆写的快照字段', () => {
      const p1 = provider.prepare(makeResolved());
      const p2 = provider.prepare(makeResolved());
      expect(p1).not.toBe(provider);
      expect(p2).not.toBe(provider);
      expect(p1).not.toBe(p2);
    });

    // red-first:修复前 `prepare(s1)` / `prepare(s2)` 先后写同一个 `this.settings`,
    // 后写的赢 ⇒ 两个请求都用 corp-2 的 CorpID + CorpSecret 去换 token。
    it('两份快照先后 prepare 后并发取 token → 各用各的 CorpID / CorpSecret(不串配置)', async () => {
      const urls: string[] = [];
      fetchSpy.mockImplementation((input: unknown) => {
        urls.push(String(input));
        return Promise.resolve(jsonResponse({ errcode: 0, access_token: 't', expires_in: 7200 }));
      });

      const s1 = makeResolved({ corpId: 'ww-corp-1', credentials: { corpSecret: 'secret-1' } });
      const s2 = makeResolved({ corpId: 'ww-corp-2', credentials: { corpSecret: 'secret-2' } });

      // 两个请求各自 resolve 完配置(await DB)后才轮到任一个真正发请求 —— 现实里的交错就是这样
      const p1 = provider.prepare(s1);
      const p2 = provider.prepare(s2);
      await Promise.all([p1.getAccessToken(), p2.getAccessToken()]);

      expect(urls).toHaveLength(2);
      expect(
        urls.some((u) => u.includes('corpid=ww-corp-1') && u.includes('corpsecret=secret-1')),
      ).toBe(true);
      expect(
        urls.some((u) => u.includes('corpid=ww-corp-2') && u.includes('corpsecret=secret-2')),
      ).toBe(true);
    });

    it('sendTextCard 用的是**本 route 的** agentId,不受后一次 prepare 影响', async () => {
      const bodies: string[] = [];
      fetchSpy.mockImplementation((_input: unknown, init: unknown) => {
        const body = (init as { body?: unknown } | undefined)?.body;
        bodies.push(typeof body === 'string' ? body : '');
        return Promise.resolve(jsonResponse({ errcode: 0, msgid: 'M' }));
      });

      const p1 = provider.prepare(makeResolved({ agentId: 111 }));
      provider.prepare(makeResolved({ agentId: 222 })); // 后到的请求
      await p1.sendTextCard('token', {
        toUser: 'u',
        title: 't',
        description: 'd',
        url: 'https://app.example.com',
      });

      expect(bodies).toHaveLength(1);
      expect(JSON.parse(bodies[0]) as { agentid: number }).toMatchObject({ agentid: 111 });
    });

    it('prepare 守卫:凭证缺失 / corpId 缺失 → WecomChannelUnavailableError(纵深,routeFor 之外第二道)', () => {
      expect(() =>
        provider.prepare(
          makeResolved({ credentials: null, credentialStatus: WecomCredentialStatus.MISSING }),
        ),
      ).toThrow(WecomChannelUnavailableError);
      expect(() => provider.prepare(makeResolved({ corpId: null }))).toThrow(
        WecomChannelUnavailableError,
      );
    });
  });

  // ===== L3 日志纪律回归(§7.1 规则 2)=====

  it('fetch 抛错时不冒泡原始 error —— 错误信息不含 URL / corpsecret', async () => {
    const raw = new TypeError('fetch failed to https://qyapi.weixin.qq.com/...corpsecret=leak');
    raw.name = 'TypeError';
    fetchSpy.mockRejectedValue(raw);
    const err = await caughtFrom(prepared().getAgent('token', AGENT_ID));
    expect(err).toBeInstanceOf(WecomApiError);
    const serialized = `${(err as Error).message} ${(err as WecomApiError).errMsg}`;
    expect(serialized).not.toContain('corpsecret');
    expect(serialized).not.toContain('qyapi.weixin.qq.com');
  });
});

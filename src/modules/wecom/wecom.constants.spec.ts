import {
  buildWecomAuthorizeUrl,
  isAcceptableWecomOAuthCode,
  isSafeWecomReturnPath,
  maskCorpId,
  maskWecomUserId,
  WECOM_OAUTH_CALLBACK_PATH,
  WECOM_OAUTH_CODE_MAX_BYTES,
  WECOM_OAUTH_STATE_HEX_LENGTH,
  WECOM_RETURN_PATH_MAX_LENGTH,
} from './wecom.constants';

// 企业微信接入 T3(2026-08-02):returnPath 策略 / authorize URL / code 长度 的单测
// (冻结稿 §14.1 的 `returnPath policy` 与 `state/ticket util` 两行)。
//
// 这里的每一条**都是反向断言**:它们证明的不是"好输入能过",
// 而是"坏输入过不去"。开放重定向的防线只有 isSafeWecomReturnPath 一处 ——
// 它一旦被放宽,整条企业微信登录链就成了钓鱼跳板,而没有任何别的检查会红。

// 控制字符一律用 String.fromCharCode 构造,**不写进源码字面量** ——
// 真实控制字节会让本文件在 grep / diff 里变成二进制,评审时整段不可见。
const CHAR = (code: number): string => String.fromCharCode(code);

describe('isSafeWecomReturnPath', () => {
  it('接受站内相对路径(含 query 与 fragment)', () => {
    expect(isSafeWecomReturnPath('/')).toBe(true);
    expect(isSafeWecomReturnPath('/activities')).toBe(true);
    expect(isSafeWecomReturnPath('/activities/123')).toBe(true);
    expect(isSafeWecomReturnPath('/activities?page=2&size=20')).toBe(true);
    expect(isSafeWecomReturnPath('/me/security#wecom')).toBe(true);
    expect(isSafeWecomReturnPath('/活动/报名')).toBe(true);
  });

  it('拒绝绝对 URL —— 任何 scheme 都不以单个 / 开头', () => {
    expect(isSafeWecomReturnPath('https://evil.com')).toBe(false);
    expect(isSafeWecomReturnPath('http://evil.com/x')).toBe(false);
    expect(isSafeWecomReturnPath('HTTPS://evil.com')).toBe(false);
    expect(isSafeWecomReturnPath('javascript:alert(1)')).toBe(false);
    expect(isSafeWecomReturnPath('data:text/html,<script>')).toBe(false);
    expect(isSafeWecomReturnPath('//evil.com')).toBe(false); // 协议相对 = 外站
    expect(isSafeWecomReturnPath('///evil.com')).toBe(false);
  });

  it('拒绝反斜杠 —— 浏览器把 /\\evil.com 规范化成 //evil.com', () => {
    expect(isSafeWecomReturnPath('/\\evil.com')).toBe(false);
    expect(isSafeWecomReturnPath('/\\\\evil.com')).toBe(false);
    expect(isSafeWecomReturnPath('\\\\evil.com')).toBe(false);
    expect(isSafeWecomReturnPath('/path\\to')).toBe(false);
  });

  it('拒绝百分号编码绕过 —— 解码后仍必须是站内路径', () => {
    // 这一组是「字符级黑名单挡不住、必须靠解码复核」的实证
    expect(isSafeWecomReturnPath('/%2F%2Fevil.com')).toBe(false);
    expect(isSafeWecomReturnPath('/%5Cevil.com')).toBe(false); // %5C = 反斜杠
    expect(isSafeWecomReturnPath('/%40evil.com')).toBe(false); // %40 = @
    expect(isSafeWecomReturnPath('/%09evil')).toBe(false); // %09 = Tab
    // 畸形百分号序列:解码抛错 ⇒ 读不懂就不放行
    expect(isSafeWecomReturnPath('/%')).toBe(false);
    expect(isSafeWecomReturnPath('/%zz')).toBe(false);
  });

  it('拒绝 userinfo 片段', () => {
    expect(isSafeWecomReturnPath('/@evil.com')).toBe(false);
    expect(isSafeWecomReturnPath('/user:pass@evil.com')).toBe(false);
  });

  it('拒绝控制字符与空白', () => {
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x20, 0x7f]) {
      expect(isSafeWecomReturnPath(`/act${CHAR(code)}ivities`)).toBe(false);
    }
    expect(isSafeWecomReturnPath(' /activities')).toBe(false);
    expect(isSafeWecomReturnPath('/activities ')).toBe(false);
  });

  it('拒绝 query 里的 token-like key(凭证不得搭 returnPath 的便车)', () => {
    for (const key of [
      'token',
      'access_token',
      'id_token',
      'secret',
      'password',
      'passwd',
      'pwd',
      'code',
      'state',
      'ticket',
      'key',
      'apikey',
      'api_key',
      'auth',
      'session',
      'sid',
      'sig',
      'signature',
      'jwt',
      'credential',
      'assertion',
    ]) {
      expect(isSafeWecomReturnPath(`/activities?${key}=x`)).toBe(false);
    }
  });

  it('camelCase 无分隔符也要拒 —— 初版正则正是漏在这里', () => {
    // `refreshToken` 里 refresh 与 token 之间没有 _ / -,
    // 带分隔符的正则整条不匹配 ⇒ 凭证直接放行(本刀初版实测漏放)。
    expect(isSafeWecomReturnPath('/activities?refreshToken=x')).toBe(false);
    expect(isSafeWecomReturnPath('/activities?accessToken=x')).toBe(false);
    expect(isSafeWecomReturnPath('/activities?stepUpToken=x')).toBe(false);
    // 大小写不敏感 + 出现在非首位仍拒 + 其他分隔符
    expect(isSafeWecomReturnPath('/activities?page=2&Access_Token=x')).toBe(false);
    expect(isSafeWecomReturnPath('/activities?Access-Token=x')).toBe(false);
    expect(isSafeWecomReturnPath('/activities?wecom.state=x')).toBe(false);
  });

  it('放行不含凭证语义的普通 query key(逐段精确匹配,不是子串包含)', () => {
    expect(isSafeWecomReturnPath('/activities?page=2')).toBe(true);
    // `keyword` 含子串 key 但整段不是 key —— 子串包含式判据会在这里误杀
    expect(isSafeWecomReturnPath('/activities?keyword=救援')).toBe(true);
    expect(isSafeWecomReturnPath('/activities?stateless=1')).toBe(true);
    expect(isSafeWecomReturnPath('/members?sort=name&order=asc')).toBe(true);
  });

  it('已知且接受的误杀:`key` 作为独立段一律拒', () => {
    // 记录既有取舍,防止后来者当 bug 修掉:
    // 凭证漏过去 = 一次性凭证进浏览器历史;误杀 = 前端换个参数名。
    expect(isSafeWecomReturnPath('/members?sortKey=name')).toBe(false);
    expect(isSafeWecomReturnPath('/members?group_key=a')).toBe(false);
  });

  it('拒绝空串与超长', () => {
    expect(isSafeWecomReturnPath('')).toBe(false);
    expect(isSafeWecomReturnPath(`/${'a'.repeat(WECOM_RETURN_PATH_MAX_LENGTH)}`)).toBe(false);
    expect(isSafeWecomReturnPath(`/${'a'.repeat(WECOM_RETURN_PATH_MAX_LENGTH - 1)}`)).toBe(true);
  });

  it('拒绝非字符串输入(DTO 之外的调用方兜底)', () => {
    expect(isSafeWecomReturnPath(undefined as unknown as string)).toBe(false);
    expect(isSafeWecomReturnPath(null as unknown as string)).toBe(false);
    expect(isSafeWecomReturnPath(123 as unknown as string)).toBe(false);
  });
});

describe('buildWecomAuthorizeUrl', () => {
  const base = {
    corpId: 'ww1234567890abcdef',
    agentId: 1000002,
    webBaseUrl: 'https://srvf.example.org',
    state: 'a'.repeat(WECOM_OAUTH_STATE_HEX_LENGTH),
  };

  it('参数顺序与形态逐字符合冻结稿 §6.2', () => {
    expect(buildWecomAuthorizeUrl(base)).toBe(
      'https://open.weixin.qq.com/connect/oauth2/authorize' +
        `?appid=${base.corpId}` +
        '&redirect_uri=https%3A%2F%2Fsrvf.example.org%2Fauth%2Fwecom%2Fcallback' +
        '&response_type=code' +
        '&scope=snsapi_base' +
        `&state=${base.state}` +
        `&agentid=${base.agentId}` +
        '#wechat_redirect',
    );
  });

  it('redirect_uri 只编码一次 —— 不出现 %253A 这类二次编码', () => {
    const url = buildWecomAuthorizeUrl(base);
    expect(url).not.toContain('%25');
    // 解码一次即还原成可读 URL
    const redirect = /redirect_uri=([^&]+)/.exec(url)?.[1] ?? '';
    expect(decodeURIComponent(redirect)).toBe(`${base.webBaseUrl}${WECOM_OAUTH_CALLBACK_PATH}`);
  });

  it('callback path 由代码固定拼接,不受 webBaseUrl 结尾斜杠影响', () => {
    const withSlash = buildWecomAuthorizeUrl({ ...base, webBaseUrl: 'https://srvf.example.org/' });
    expect(withSlash).toBe(buildWecomAuthorizeUrl(base));
    const withManySlashes = buildWecomAuthorizeUrl({
      ...base,
      webBaseUrl: 'https://srvf.example.org///',
    });
    expect(withManySlashes).toBe(buildWecomAuthorizeUrl(base));
  });

  it('必带 agentid 与 snsapi_base(D-WC-13)', () => {
    const url = buildWecomAuthorizeUrl(base);
    expect(url).toContain(`&agentid=${base.agentId}`);
    expect(url).toContain('&scope=snsapi_base');
    expect(url).not.toContain('snsapi_userinfo');
    expect(url).not.toContain('snsapi_privateinfo');
  });

  it('以 #wechat_redirect 结尾(缺了企业微信客户端不会自动跳转)', () => {
    expect(buildWecomAuthorizeUrl(base).endsWith('#wechat_redirect')).toBe(true);
  });
});

describe('isAcceptableWecomOAuthCode', () => {
  it('拒绝空串', () => {
    expect(isAcceptableWecomOAuthCode('')).toBe(false);
  });

  it('按 UTF-8 字节数判上限,不是字符数', () => {
    expect(isAcceptableWecomOAuthCode('a'.repeat(WECOM_OAUTH_CODE_MAX_BYTES))).toBe(true);
    expect(isAcceptableWecomOAuthCode('a'.repeat(WECOM_OAUTH_CODE_MAX_BYTES + 1))).toBe(false);
    // 中文 3 字节/字:171 字 = 513 字节 > 512,即使 .length 只有 171
    const multiByte = '汉'.repeat(171);
    expect(multiByte.length).toBeLessThan(WECOM_OAUTH_CODE_MAX_BYTES);
    expect(isAcceptableWecomOAuthCode(multiByte)).toBe(false);
  });
});

describe('掩码(§5.5:响应 / Audit / 日志只允许掩码)', () => {
  it('wecomUserId 长值留首尾各 4 位', () => {
    expect(maskWecomUserId('zhangsan-0001')).toBe('zhan****0001');
  });

  it('wecomUserId 短值整体打码,不泄露片段', () => {
    expect(maskWecomUserId('zhangsan')).toBe('***');
    expect(maskWecomUserId('abc')).toBe('***');
    expect(maskWecomUserId('')).toBe('***');
  });

  it('corpId 同款防御', () => {
    expect(maskCorpId('ww1234567890abcdef')).toBe('ww12****cdef');
    expect(maskCorpId('ww123456')).toBe('***');
  });
});

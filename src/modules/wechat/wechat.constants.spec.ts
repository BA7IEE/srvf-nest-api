import { maskOpenid } from './wechat.constants';

// 微信小程序登录 review 收口(2026-06-12 增量审计⑭):全仓唯一 openid 掩码实现的
// characterization——短串防御分支(≤8 整体打码)此前零触达,仅长路径有一条 e2e 正则。

describe('maskOpenid', () => {
  it('长 openid → 首 4 + **** + 尾 4(与 e2e 掩码断言同形)', () => {
    expect(maskOpenid('dev-openid-wx-user-1')).toBe('dev-****er-1');
  });

  it('真实微信 openid 形态(28 字符)', () => {
    expect(maskOpenid('oABCDEFGHIJKLMNOPQRSTUVWXYZ1')).toBe('oABC****XYZ1');
  });

  it.each([['12345678'], ['a'], ['']])('≤ 8 字符整体打码:%j → ***', (s) => {
    expect(maskOpenid(s)).toBe('***');
  });

  it('9 字符边界走长路径(现状锁定:首尾片段可重叠)', () => {
    expect(maskOpenid('123456789')).toBe('1234****6789');
  });
});

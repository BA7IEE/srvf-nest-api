import { buildWechatSubscribeData } from './notification.wechat-data';

// 统一通知 S2:微信订阅消息字段映射纯函数单测(D-N3 内置映射)。

describe('buildWechatSubscribeData', () => {
  it('映射 title→thing1 / body→thing2 / publishedAt→time3', () => {
    const data = buildWechatSubscribeData({
      title: '紧急集合',
      body: '请尽快到位',
      publishedAt: new Date('2026-06-25T01:30:00.000Z'), // UTC+8 = 09:30
    });
    expect(data.thing1.value).toBe('紧急集合');
    expect(data.thing2.value).toBe('请尽快到位');
    expect(data.time3.value).toBe('2026-06-25 09:30');
  });

  it('thing 字段超 20 字符截断(微信 thing.DATA ≤ 20,防 47003)', () => {
    const longTitle = '一二三四五六七八九十一二三四五六七八九十廿一廿二'; // 24 字
    const data = buildWechatSubscribeData({ title: longTitle, body: 'x', publishedAt: null });
    expect(data.thing1.value.length).toBeLessThanOrEqual(20);
    expect(data.thing1.value.endsWith('…')).toBe(true);
  });

  it('publishedAt 为 null → time 空串(防御)', () => {
    const data = buildWechatSubscribeData({ title: 't', body: 'b', publishedAt: null });
    expect(data.time3.value).toBe('');
  });

  it('首尾空白 trim', () => {
    const data = buildWechatSubscribeData({ title: '  标题  ', body: ' 正文 ', publishedAt: null });
    expect(data.thing1.value).toBe('标题');
    expect(data.thing2.value).toBe('正文');
  });
});

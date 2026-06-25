import { NotificationDispatcher } from './notification-dispatcher';

// 统一通知 S3:NotificationDispatcher Effect 单测(评审稿 §2.2 / §3.6)。
// 锁:① dispatchTargeted 建**已发布定向行**(audienceType=directed / sourceType=system / authorUserId=null /
//   statusCode=published + publishedAt 非空 / recipientMemberId 挂行)= 跳过 draft 不走 admin 状态机;
// ② 渠道归一站内恒发(强制含 in-app);③ 声明含 wechat → 委派 S2 dispatchDirected;未声明 → 不碰微信。
// 纯 unit:mock prisma.notification.create + mock NotificationWechatDispatchService(零 DB / 零外部)。

type CreateArgs = [{ data: Record<string, unknown> }];

describe('NotificationDispatcher · dispatchTargeted(定向派发 Effect)', () => {
  function build() {
    const created: Record<string, unknown>[] = [];
    const create = jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `notif-${created.length + 1}`, ...data };
      created.push(row);
      return Promise.resolve(row);
    });
    const prisma = { notification: { create } };
    const dispatchDirected = jest.fn().mockResolvedValue(undefined);
    const wechatDispatch = { dispatchDirected };
    const dispatcher = new NotificationDispatcher(prisma as never, wechatDispatch as never);
    const createCalls = () => create.mock.calls as CreateArgs[];
    return { dispatcher, createCalls, dispatchDirected };
  }

  it('建已发布定向行:directed / system / authorUserId=null / published + publishedAt / recipientMemberId', async () => {
    const { dispatcher, createCalls } = build();
    const row = await dispatcher.dispatchTargeted({
      recipientMemberId: 'member-1',
      notificationTypeCode: 'recruitment',
      title: '已发放永久编号',
      body: '您已转为志愿者,永久编号 26001。',
      channels: ['in-app'],
    });

    const calls = createCalls();
    expect(calls).toHaveLength(1);
    const data = calls[0][0].data;
    expect(data).toMatchObject({
      audienceType: 'directed',
      sourceType: 'system',
      authorUserId: null,
      statusCode: 'published', // 跳过 draft 直 published(不走 admin 状态机)
      recipientMemberId: 'member-1',
      notificationTypeCode: 'recruitment',
      visibilityCode: 'member', // 定向可见档(feed 由 recipientMemberId 闸控,非可见档)
    });
    expect(data.publishedAt).toBeInstanceOf(Date); // 即发布时刻
    expect(row.id).toBe('notif-1');
  });

  it('渠道归一:站内恒发(未传 channels 也含 in-app;传 wechat 时 in-app 在前去重)', async () => {
    const { dispatcher, createCalls } = build();

    await dispatcher.dispatchTargeted({
      recipientMemberId: 'm',
      notificationTypeCode: 'recruitment',
      title: 't',
      body: 'b',
    });
    await dispatcher.dispatchTargeted({
      recipientMemberId: 'm',
      notificationTypeCode: 'recruitment',
      title: 't',
      body: 'b',
      channels: ['wechat', 'in-app', 'wechat'],
    });

    const calls = createCalls();
    expect(calls[0][0].data.channels).toEqual(['in-app']);
    expect(calls[1][0].data.channels).toEqual(['in-app', 'wechat']);
  });

  it('声明含 wechat → 委派 S2 dispatchDirected(传建出的定向行)', async () => {
    const { dispatcher, dispatchDirected } = build();
    await dispatcher.dispatchTargeted({
      recipientMemberId: 'm',
      notificationTypeCode: 'recruitment',
      title: 't',
      body: 'b',
      channels: ['in-app', 'wechat'],
    });
    expect(dispatchDirected).toHaveBeenCalledTimes(1);
    const arg = (dispatchDirected.mock.calls as [Record<string, unknown>][])[0][0];
    expect(arg.audienceType).toBe('directed');
    expect(arg.recipientMemberId).toBe('m');
  });

  it('仅站内(未声明 wechat)→ 不碰微信渠道(dispatchDirected 零调用)', async () => {
    const { dispatcher, dispatchDirected } = build();
    await dispatcher.dispatchTargeted({
      recipientMemberId: 'm',
      notificationTypeCode: 'recruitment',
      title: 't',
      body: 'b',
      channels: ['in-app'],
    });
    expect(dispatchDirected).not.toHaveBeenCalled();
  });
});

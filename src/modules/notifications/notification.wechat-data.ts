// 统一通知 S2:微信订阅消息字段映射(D-N3「字段映射内置代码」;随广播通知类型固定,不入配置表)。
//
// 微信订阅消息 data 形状 = { <字段key>: { value: string } }。字段 key(thingN / timeN / constN)
// 由小程序后台**模板本身**决定,随模板审批固定。本仓 S2 的广播通知统一走一套 key 约定(下方),
// **运维上线须按真实模板字段名核对并按需调整本文件**(这正是 D-N3 把"字段映射"留在代码、把"模板 ID"
// 留在配置表的分工:ID 随审批变 → 运营可配;字段映射是 payload 构造契约 → 代码内置)。
//
// 微信字段长度限制(超限微信侧 47003 拒发):thing.DATA ≤ 20 字符、const.DATA ≤ 20 字符。
// 本映射统一截断到 20,杜绝 admin 写超长标题导致整渠道 47003。
//
// 纯函数,零 DB / 零副作用,可单测(镜像 content.visibility 纯函数范式)。

// 微信 thing / const 字段上限(字符数;中文按字符计)。
const WECHAT_THING_MAX = 20;

// 截断到微信字段上限(超限加省略号占位,保 ≤ 上限)。
function clip(value: string, max = WECHAT_THING_MAX): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

// publishedAt → 'YYYY-MM-DD HH:mm'(UTC+8 墙钟;沿生日批 Asia/Shanghai 固定时区口径)。
// publishedAt 在 publish 时置 now,派发紧随其后,故恒非空;防御性 null → 空串。
function formatPublishedAt(publishedAt: Date | null): string {
  if (!publishedAt) return '';
  const shifted = new Date(publishedAt.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16).replace('T', ' ');
}

// 广播通知 → 微信订阅消息 data(字段 key 约定见文件头;运维按真实模板核对)。
// thing1 = 标题、thing2 = 正文摘要、time3 = 发布时间。
export function buildWechatSubscribeData(notification: {
  title: string;
  body: string;
  publishedAt: Date | null;
}): Record<string, { value: string }> {
  return {
    thing1: { value: clip(notification.title) },
    thing2: { value: clip(notification.body) },
    time3: { value: formatPublishedAt(notification.publishedAt) },
  };
}

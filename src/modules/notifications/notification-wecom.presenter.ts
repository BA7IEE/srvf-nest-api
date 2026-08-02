import { Injectable } from '@nestjs/common';

// 企业微信应用消息呈现层(T5B;冻结稿 §10.6 / D-WC-20)。
//
// **职责边界**(§10.6 末段逐字:"它是 Presenter,不访问 Prisma"):
// - ✅ Notification 的 title / body → textcard 的 title / description(纯文本化 + 转义 + 确定性裁剪)
// - ✅ 深链拼装(固定 path,只接受调用方给的 origin)
// - ❌ 不持有 PrismaService、不查库、不判权、不认识 wecomUserId / token / settings 凭证
//
// 本类**零构造依赖**是刻意的:它是纯函数集合,单测可以直接 `new` 出来喂 100 组字符串,
// 不需要 Nest DI、不需要 mock。想给它加依赖之前请先问:那件事真的属于"呈现"吗?
//
// ⚠️ **最硬的一条**:`description` 绝不透传 `Notification.body` 里的任意 HTML(§10.6 第 2 条)。
// 流程固定为「先纯文本化 → 再整体转义 → 最后只由本文件自己贴 `<br>`」。
// 顺序反过来(先贴标签再转义)会把自己贴的标签也转义掉;更糟的是"先转义再让业务文本里
// 的标签活下来",那等于把 body 变成企业微信客户端里的一段可注入模板。

// ===== D-WC-20 / §10.6 的四个硬上限 =====
//
// 单位各不相同,**不能混着记**:
//   - title / description 按 **Unicode 码点**(不是 UTF-16 code unit)——
//     `.length` 对 emoji 与增补平面汉字会数成 2,按它裁剪会把上限白白砍掉一半,
//     还可能**从代理对中间切开**,产出半个字符的乱码。故一律 `Array.from()`。
//   - URL 按 **UTF-8 字节**(cuid 与固定 path 都是 ASCII,真正可能超的是 webBaseUrl)。
export const WECOM_TEXTCARD_TITLE_MAX_CHARS = 128;
export const WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS = 512;
export const WECOM_TEXTCARD_URL_MAX_BYTES = 2048;
// §10.6:按钮固定"查看详情",不超过 4 个文字。**不做成可配置** —— 按钮文案可配置就意味着
// 运营能把审批动作的措辞搬进企业微信,而 D-WC-20 的整条决策就是"不把审批动作搬到企业微信回调"。
export const WECOM_TEXTCARD_BTN_TXT = '查看详情';
// 深链 path 由代码固定拼接,不可配置(镜像 WECOM_OAUTH_CALLBACK_PATH 的同一条理由:
// 允许配置里带 path,配置面就成了改跳转目标的入口)。
export const WECOM_NOTIFICATION_DEEP_LINK_PATH = '/notifications';
// 裁剪省略号。占 1 个码点,计入上限。
const ELLIPSIS = '…';

export interface WecomTextCardContent {
  title: string;
  description: string;
  url: string;
}

// 呈现所需的最小 Notification 形状(沿 time-overlap-policy / OverlapRecordLike 范式:
// 只声明真正读取的字段,不反向依赖 Prisma GetPayload)。
export interface WecomPresentableNotification {
  id: string;
  title: string;
  body: string;
}

/** 深链 origin 不可用(webBaseUrl 未配置 / 不是 http(s) / 拼出来超 2048 字节)。 */
export class WecomDeepLinkUnavailableError extends Error {
  constructor(reason: string) {
    super(`WECOM_DEEP_LINK_UNAVAILABLE: ${reason}`);
    this.name = 'WecomDeepLinkUnavailableError';
  }
}

@Injectable()
export class WecomMessagePresenter {
  /**
   * Notification → textcard 三段内容。**确定性**:同一入参恒产出同一字节串
   * (没有时间戳、没有随机、没有 locale 相关格式化)—— 企业微信 1800 秒重复检查
   * 是按内容判重的,不确定的呈现会让第二层保险直接失效。
   */
  present(
    notification: WecomPresentableNotification,
    webBaseUrl: string | null,
  ): WecomTextCardContent {
    return {
      title: cropTitle(notification.title),
      description: renderDescription(notification.body),
      url: buildDeepLink(webBaseUrl, notification.id),
    };
  }
}

/**
 * 标题:纯文本化 + 按码点裁剪到 128。
 *
 * **不做 HTML 转义** —— 企业微信 textcard 的 title 是纯文本字段,转义了反而会让
 * 正文里的 `&` 显示成字面 `&amp;`。description 才是需要转义的那个(它允许受限 HTML)。
 */
function cropTitle(raw: string): string {
  return cropByCodePoints(toPlainText(raw), WECOM_TEXTCARD_TITLE_MAX_CHARS);
}

/**
 * 描述:纯文本化 → 整体转义 → 只贴本文件自己生成的 `<br>` → 裁剪到 512 码点。
 *
 * 裁剪必须作用在**最终字节串**上(含 `<br>` 与 `&amp;` 这类展开),否则
 * "按纯文本数了 512 个字"发出去可能是 900 多个字符,被上游截断成半个实体。
 * 这里用二分找"最大的、渲染后仍 ≤512 的纯文本长度":渲染函数对输入长度单调不减,
 * 二分因此成立,且结果与实现无关地确定。
 */
function renderDescription(raw: string): string {
  const plain = toPlainText(raw, { keepLineBreaks: true });
  const points = [...plain];
  if (renderedLength(points, points.length, false) <= WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS) {
    return renderPlain(points, points.length, false);
  }
  // 已经确定要截断,故所有候选都带省略号。找最大可行的 take。
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (renderedLength(points, mid, true) <= WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return renderPlain(points, low, true);
}

function renderedLength(points: string[], take: number, truncated: boolean): number {
  return [...renderPlain(points, take, truncated)].length;
}

function renderPlain(points: string[], take: number, truncated: boolean): string {
  const body = escapeHtml(points.slice(0, take).join(''));
  // ⚠️ 换行 → `<br>` 必须发生在 escapeHtml **之后**:反过来会把这个 `<br>` 自己转义掉。
  // 这也是"只允许 Presenter 自身生成 `<br>`"的执行位 —— body 里原有的 `<br>` 在上一步
  // 已经变成 `&lt;br&gt;`,永远走不到这里。
  const withBreaks = body.replace(/\n/g, '<br>');
  return truncated ? `${withBreaks}${ELLIPSIS}` : withBreaks;
}

/**
 * 纯文本化:去掉除换行外的全部控制字符,并把各种换行归一成 `\n`。
 *
 * 用**数值比较**而不是控制字符类正则,与 `wecom.constants.hasForbiddenReturnPathChar` 同一条理由:
 * 把真实控制字节敲进源文件会让整个文件在 grep / diff 眼里变成二进制,评审时整段不可见
 * (本仓踩过一次)。
 */
function toPlainText(raw: string, options: { keepLineBreaks?: boolean } = {}): string {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let out = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0)!;
    if (ch === '\n') {
      out += options.keepLineBreaks ? '\n' : ' ';
      continue;
    }
    // C0(含 Tab)与 DEL 一律丢弃;Tab 归空格保留可读性。
    if (code === 0x09) {
      out += ' ';
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  // 连续空行压成一个,避免裁剪预算被空白吃掉。
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * HTML 转义五件套。`'` 用 `&#x27;` 而不是 `&apos;` —— 后者不是 HTML4 实体,
 * 老渲染器上会原样显示成 `&apos;`。
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** 按码点裁剪(带省略号,确定性)。 */
function cropByCodePoints(value: string, max: number): string {
  const points = [...value];
  if (points.length <= max) return value;
  return `${points.slice(0, max - 1).join('')}${ELLIPSIS}`;
}

/**
 * 深链:`{origin}/notifications/{id}`。
 *
 * §10.6 硬约束逐条落在这里:
 * - **URL 里不放 JWT / refresh token / state / ticket / signed URL** —— 本函数除固定 path 与
 *   notification id 外**不接受任何入参**,想放也没有地方放(类型系统兜底,不靠自觉)。
 * - production 必须 HTTPS:webBaseUrl 的写入口(wecom-settings)已强制,这里是纵深防御的第二道。
 *   ⚠️ 判据写死"必须 https",不读 env —— 非 production 的联调环境若配了 http,
 *   宁可这条通知记 channel-disabled,也不要让"本地能发、生产发不出"成为上线当天才发现的事。
 * - UTF-8 字节 ≤2048。
 *
 * 用户点开后必须在 SRVF 重新登录并走 App/Admin 可见性检查(§10.6 倒数第 3 条)——
 * 这条深链只是一个**指针**,不携带任何授权。
 */
function buildDeepLink(webBaseUrl: string | null, notificationId: string): string {
  if (webBaseUrl === null || webBaseUrl === '') {
    throw new WecomDeepLinkUnavailableError('webBaseUrl 未配置');
  }
  let origin: string;
  try {
    const parsed = new URL(webBaseUrl);
    if (parsed.protocol !== 'https:') {
      throw new WecomDeepLinkUnavailableError('webBaseUrl 必须是 https origin');
    }
    origin = parsed.origin;
  } catch (err) {
    if (err instanceof WecomDeepLinkUnavailableError) throw err;
    throw new WecomDeepLinkUnavailableError('webBaseUrl 不是合法 URL');
  }
  const url = `${origin}${WECOM_NOTIFICATION_DEEP_LINK_PATH}/${encodeURIComponent(notificationId)}`;
  if (Buffer.byteLength(url, 'utf8') > WECOM_TEXTCARD_URL_MAX_BYTES) {
    throw new WecomDeepLinkUnavailableError('深链超过 2048 字节');
  }
  return url;
}

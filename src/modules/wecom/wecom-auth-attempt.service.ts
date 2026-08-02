import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { PrismaService } from '../../database/prisma.service';
import {
  WECOM_BINDING_TICKET_BYTES,
  WECOM_BINDING_TICKET_TTL_MS,
  WECOM_OAUTH_STATE_BYTES,
  WECOM_OAUTH_STATE_TTL_MS,
} from './wecom.constants';
import {
  WECOM_ATTEMPT_PURPOSE,
  WECOM_ATTEMPT_STATUS,
  type WecomAttemptPurpose,
} from './wecom.types';

// 企业微信接入 T3(2026-08-02):OAuth state / binding ticket 一次性凭证台账
// (冻结稿 §5.3 + §9.5;下称"冻结稿")
//
// ⚠️ 本文件最硬的一条(§5.3 规则 1-2 / §5.5):
//   **原始 state、原始 binding ticket 只以 SHA-256 hash 落库;OAuth code 连 hash 都不存。**
//   三者都不入日志、不入 Audit、不进任何响应(ticket 只在 bindingRequired 响应里出现一次)。
//   本 Service 因此没有 logger —— 没有任何一句日志能安全地提到它处理的值,
//   加一个 logger 只会让后来者顺手 `logger.debug(state)`。
//
// ⚠️ 第二硬的一条(§9.5 / §5.3 规则 9):**一次性凭证用 CAS 消费,不用"读-判-写"**。
//   读出来判断"还没被消费"再去写,两个并发请求会同时读到未消费 —— 这正是重放窗口。
//   这里全部用 `updateMany({ where: <含状态与过期判据> })` 让 PostgreSQL 在一条语句里
//   完成"判 + 写",`count === 1` 才算赢家,`count === 0` 一律当无效(不区分子原因:
//   不存在 / 过期 / 已消费 / 状态不匹配对外同码同形,否则 ticket 就成了状态探测器)。
//
// ⚠️ 第三条(§9.5):**Provider 调用不在事务内**。state 先 CAS 消费,再打上游;
//   上游成功但进程随后崩溃时用户重新发起即可 —— 刻意**不复活** code / state。
//
// ⚠️ 第四条(P1-27 第一刀 B1,2026-08-03):**state 必须绑定发起授权的那个浏览器**。
//   原实现里 state 只证明"这条回跳对应我方签发过的一次 attempt",不证明"提交回跳的
//   浏览器就是发起的那个"。攻击者在自己那侧换到 `code + state` 后塞进受害者浏览器,
//   受害者提交即得攻击者身份的会话;攻击者身份未绑定时还会升级成完整账号接管
//   (受害者输入自己的手机号 + 短信码,把攻击者的企业微信号绑到自己账号上)。
//
//   修法 = 派生绑定,**不新增列**(本刀的 migration 预算恰好一列,已给 B2 的
//   `User.wecomIdentityVersion`):
//       browserNonce  = randomBytes(32)          ← 只走 HttpOnly Cookie,永不落库
//       state         = sha256(browserNonce)     ← 走 authorize URL,经企业微信重定向暴露
//       stateHash     = sha256(state)            ← 落库(与原实现同形,列没变)
//   回跳时必须同时出示 `state`(body)与 `browserNonce`(Cookie),服务端先核
//   `sha256(nonce) === state` 再走原来的 CAS。
//
//   为什么这与"把 nonce hash 也写进 CAS 的 where"等价:一个 state 有且只有一个 nonce
//   前像,所以"nonce 配得上 state"是个**纯函数判据**,不携带独立状态,也就不可能与
//   attempt 行失步 —— 三者仍然是一次性、原子地一起消费掉。
//   为什么攻击者绕不过:sha256 抗原像 ⇒ 手里有 state 推不回 nonce;
//   `__Host-` 前缀 Cookie 是 host-only 且必须 Secure ⇒ 也写不进受害者浏览器。
//
// retention(§5.3 规则 8):成功 / 失败 / 过期行由**手动 SOP** 清理 ——
// §0.3 硬禁区「不新增第三个 Cron」,与 throttler_buckets 同一处置。

/** state 消费成功后返回给调用方的最小事实集(不含 hash,不含任何原始凭证)。 */
export interface ConsumedWecomAttempt {
  id: string;
  purpose: WecomAttemptPurpose;
  returnPath: string;
  subjectUserId: string | null;
}

/** binding ticket 预检(不消费)命中的行。 */
export interface PendingWecomBinding {
  id: string;
  returnPath: string;
  corpId: string;
  wecomUserId: string;
}

@Injectable()
export class WecomAuthAttemptService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 签发 OAuth state + 浏览器关联 nonce,并建 attempt 行(purpose 决定 subjectUserId 语义)。
   *
   * §5.3 规则 3/4:`purpose=login` 时 subjectUserId 恒 null;
   * `purpose=bind_self` 时必须是发起 authorize 的登录用户 —— 由类型签名强制成对传入。
   *
   * 返回的两个原值都是**唯一一次**能拿到的机会,且去向严格分开(B1):
   * - `state` 拼进 authorize URL,会经企业微信重定向暴露在 URL / Referer / 网关日志里
   * - `browserNonce` 只写进 `HttpOnly` Cookie,**永不**进响应体、日志、Audit、DB
   * 之后系统里只剩 `stateHash`。
   */
  async createAttempt(input: {
    purpose: WecomAttemptPurpose;
    subjectUserId: string | null;
    returnPath: string;
  }): Promise<{ state: string; browserNonce: string; expiresAt: Date }> {
    // §5.3 规则 5:randomBytes(32).toString('hex') = 64 个 [0-9a-f] 字符、256-bit 熵。
    // B1:随机的是 **nonce**,state 由它派生 —— 于是"持有 state"不蕴含"持有 nonce"。
    const browserNonce = randomBytes(WECOM_OAUTH_STATE_BYTES).toString('hex');
    const state = deriveWecomStateFromBrowserNonce(browserNonce);
    const expiresAt = new Date(Date.now() + WECOM_OAUTH_STATE_TTL_MS);

    await this.prisma.wecomAuthAttempt.create({
      data: {
        purpose: input.purpose,
        status: WECOM_ATTEMPT_STATUS.PENDING,
        subjectUserId:
          input.purpose === WECOM_ATTEMPT_PURPOSE.BIND_SELF ? input.subjectUserId : null,
        stateHash: hashOneTimeSecret(state),
        returnPath: input.returnPath,
        stateExpiresAt: expiresAt,
      },
      select: { id: true },
    });

    return { state, browserNonce, expiresAt };
  }

  /**
   * 原子消费 state + 浏览器关联 nonce(§9.5 CAS 第一条 + B1)。
   *
   * ① 先核浏览器归属:`sha256(browserNonce) === state`。
   *    不匹配 ⇒ 立刻 null,**且不发出那条 UPDATE** —— 这一条很重要:
   *    非发起浏览器的失败绝不能把 state 烧掉,否则任何人只要拿到 state
   *    就能让合法用户的登录流程作废(把接管漏洞换成一个 DoS 不算修好)。
   * ② 再走原有 CAS。where 同时钉住 stateHash + purpose + status=pending + 未消费 + 未过期:
   *    - `purpose` 进 where 是**目的隔离**(§14.1):login 签发的 state 不能拿去走 bind_self
   *      路径,反之亦然。少了这一条,未登录用户就能用 login state 去消费 bind_self 流程。
   *    - `count === 1` 才是赢家。并发两请求必然只有一个拿到 1,另一个拿到 0 → null → 36010。
   *
   * 返回 null 一律由调用方映射成 36010,**不区分**浏览器不符 / 不存在 / 过期 / 已消费 /
   * 目的不符 —— 区分即 oracle。
   */
  async consumeState(input: {
    state: string;
    purpose: WecomAttemptPurpose;
    browserNonce: string | null;
  }): Promise<ConsumedWecomAttempt | null> {
    if (!matchesWecomBrowserNonce(input.state, input.browserNonce)) return null;

    const stateHash = hashOneTimeSecret(input.state);
    const now = new Date();

    const result = await this.prisma.wecomAuthAttempt.updateMany({
      where: {
        stateHash,
        purpose: input.purpose,
        status: WECOM_ATTEMPT_STATUS.PENDING,
        stateConsumedAt: null,
        stateExpiresAt: { gt: now },
      },
      data: { status: WECOM_ATTEMPT_STATUS.STATE_CONSUMED, stateConsumedAt: now },
    });
    if (result.count !== 1) return null;

    // 赢家才回读。stateHash @unique,故这次 findUnique 必然命中刚被自己改过的那一行。
    const row = await this.prisma.wecomAuthAttempt.findUnique({
      where: { stateHash },
      select: { id: true, purpose: true, returnPath: true, subjectUserId: true },
    });
    if (row === null) return null;
    return {
      id: row.id,
      purpose: row.purpose as WecomAttemptPurpose,
      returnPath: row.returnPath,
      subjectUserId: row.subjectUserId,
    };
  }

  /**
   * 未绑定登录:attempt 转 `binding_required` 并签发 binding ticket(§5.3 规则 6/7)。
   *
   * `corpId` / `wecomUserId` 在此**临时**保存 —— 它们不是身份真相源(真相在 WecomIdentity),
   * 只是为了让随后的 bind 请求知道"这张 ticket 对应的是哪个企业微信成员",
   * 免得 bind 再打一次上游(那会需要第二个 code,而 code 是一次性的)。
   *
   * 仍走 CAS:只有 `state_consumed` 且尚未签过 ticket 的行能转入,防止同一 attempt 被签两张票。
   */
  async issueBindingTicket(input: {
    attemptId: string;
    corpId: string;
    wecomUserId: string;
  }): Promise<{ bindingTicket: string; expiresAt: Date } | null> {
    const bindingTicket = randomBytes(WECOM_BINDING_TICKET_BYTES).toString('hex');
    const expiresAt = new Date(Date.now() + WECOM_BINDING_TICKET_TTL_MS);

    const result = await this.prisma.wecomAuthAttempt.updateMany({
      where: {
        id: input.attemptId,
        status: WECOM_ATTEMPT_STATUS.STATE_CONSUMED,
        bindingTicketHash: null,
      },
      data: {
        status: WECOM_ATTEMPT_STATUS.BINDING_REQUIRED,
        bindingTicketHash: hashOneTimeSecret(bindingTicket),
        corpId: input.corpId,
        wecomUserId: input.wecomUserId,
        bindingExpiresAt: expiresAt,
      },
    });
    if (result.count !== 1) return null;
    return { bindingTicket, expiresAt };
  }

  /**
   * binding ticket **只校验不消费**(§6.2 send-code 规则:"binding ticket 必须有效但不消费")。
   *
   * 为什么 send-code 不能消费:用户可能输错手机号、可能没收到短信要重发 ——
   * 每次都烧掉 ticket 等于逼他从企业微信重新走一遍 OAuth。
   * 真正的一次性保证在 `consumeBindingTicket`(bind 时),那里才是绑定发生的地方。
   */
  async findValidBinding(bindingTicket: string): Promise<PendingWecomBinding | null> {
    const row = await this.prisma.wecomAuthAttempt.findUnique({
      where: { bindingTicketHash: hashOneTimeSecret(bindingTicket) },
      select: {
        id: true,
        status: true,
        returnPath: true,
        corpId: true,
        wecomUserId: true,
        bindingExpiresAt: true,
        bindingConsumedAt: true,
      },
    });
    if (
      row === null ||
      row.status !== WECOM_ATTEMPT_STATUS.BINDING_REQUIRED ||
      row.bindingConsumedAt !== null ||
      row.bindingExpiresAt === null ||
      row.bindingExpiresAt <= new Date() ||
      row.corpId === null ||
      row.wecomUserId === null
    ) {
      return null;
    }
    return {
      id: row.id,
      returnPath: row.returnPath,
      corpId: row.corpId,
      wecomUserId: row.wecomUserId,
    };
  }

  /**
   * 原子消费 binding ticket(§9.5 CAS 第二条)。**必须在绑定事务内调用** ——
   * 传 `tx` 而不是用 this.prisma 是为了让"消费票"和"写身份"同生共死:
   * 分成两个事务的话,绑定回滚而票已烧 = 用户被卡在中间态,得从头走 OAuth。
   *
   * 返回 false 一律映射 36011,同样不区分子原因。
   */
  async consumeBindingTicket(
    tx: Prisma.TransactionClient,
    bindingTicket: string,
  ): Promise<boolean> {
    const now = new Date();
    const result = await tx.wecomAuthAttempt.updateMany({
      where: {
        bindingTicketHash: hashOneTimeSecret(bindingTicket),
        status: WECOM_ATTEMPT_STATUS.BINDING_REQUIRED,
        bindingConsumedAt: null,
        bindingExpiresAt: { gt: now },
      },
      data: { status: WECOM_ATTEMPT_STATUS.COMPLETED, bindingConsumedAt: now },
    });
    return result.count === 1;
  }

  /**
   * attempt 收尾:`state_consumed` → `completed`(已绑定直登路径,没有 ticket 环节)。
   *
   * 与 `consumeBindingTicket` 分开是因为两条路径的终态判据不同:
   * 直登没有 ticket 可消费,拿 ticket 的 CAS 去判它会恒 false。
   */
  async markCompleted(attemptId: string): Promise<void> {
    await this.prisma.wecomAuthAttempt.updateMany({
      where: { id: attemptId, status: WECOM_ATTEMPT_STATUS.STATE_CONSUMED },
      data: { status: WECOM_ATTEMPT_STATUS.COMPLETED },
    });
  }

  /**
   * attempt 置 `failed`(终态)。用于 state 已消费但后续失败的场景
   * (上游 code 换身份失败 / 换到的不是内部成员 / 绑定账号不可用)。
   *
   * ⚠️ **不回退到 pending**:state 已经烧了,回退等于承诺一个再也不会被接受的凭证还能用。
   * 这只是台账,失败路径的对外语义仍由调用方抛 36010 决定。
   */
  async markFailed(attemptId: string): Promise<void> {
    await this.prisma.wecomAuthAttempt.updateMany({
      where: {
        id: attemptId,
        status: {
          in: [WECOM_ATTEMPT_STATUS.STATE_CONSUMED, WECOM_ATTEMPT_STATUS.BINDING_REQUIRED],
        },
      },
      data: { status: WECOM_ATTEMPT_STATUS.FAILED },
    });
  }
}

/**
 * 一次性凭证的落库形态:SHA-256 hex(§5.3 规则 1)。
 *
 * 与 refresh token 的 `hashRefreshToken` 同型且**刻意不复用**:那边是 auth 模块的
 * 会话凭证,这边是企业微信 OAuth 台账,两者的轮换与迁移节奏无关。
 * 共用一个 helper 只会在将来某一方要换算法时产生一次不必要的跨模块讨论。
 *
 * 这里不需要加盐 / HMAC:入参是 256-bit 均匀随机数,不存在字典或彩虹表威胁模型;
 * hash 的作用是"DB 泄露时原文不可用",而非抗猜测。
 */
function hashOneTimeSecret(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * `state = sha256(browserNonce)`(B1 派生绑定)。
 *
 * 导出是给 spec 用的:判据"两者确实是同一次派生的两端"必须能被机器核对,
 * 不能只写在注释里。
 */
export function deriveWecomStateFromBrowserNonce(browserNonce: string): string {
  return hashOneTimeSecret(browserNonce);
}

/**
 * 提交回跳的浏览器是否就是发起授权的那个(B1 的整条判据)。
 *
 * ⚠️ 缺 Cookie 时**不能早返回** —— 那会让"没带 Cookie"比"带错 Cookie"少跑一次 sha256,
 * 于是 36010 的耗时里又多出一位可测的信息(B3 正在收口的正是这类差异)。
 * 这里改成对一个随机值做同样的派生再比,本地开销与真实分支一致,结果恒 false。
 *
 * 比对走 `timingSafeEqual`:两边都是定长 64 字符 hex,长度不等即判否。
 */
function matchesWecomBrowserNonce(state: string, browserNonce: string | null): boolean {
  const candidate = browserNonce ?? randomBytes(WECOM_OAUTH_STATE_BYTES).toString('hex');
  const derived = Buffer.from(deriveWecomStateFromBrowserNonce(candidate), 'utf8');
  const presented = Buffer.from(state, 'utf8');
  if (derived.length !== presented.length) return false;
  return browserNonce !== null && timingSafeEqual(derived, presented);
}

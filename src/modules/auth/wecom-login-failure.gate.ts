import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

// 企业微信登录失败的**唯一出口**(P1-27 第一刀 B3,2026-08-03)
//
// ── 修的是什么 ──
// 36010 的**码形**早已归一(state 无效 / code 本地格式无效 / 上游拒绝 code /
// 外部成员或跨企业 / 身份指向 DISABLED 或软删,对外逐字段同形),但**耗时不归一**:
// 各分支在服务端做的活儿差着一整段。2026-08-03 取证探针实测(DEV_STUB,21 轮,中位数):
//
//     A `state` 无效            10ms   (7–16)
//     B `code` 本地格式无效     17ms   (12–33)
//     C 上游拒绝 `code`         18ms   (13–22)
//     D 身份指向 DISABLED 账号  19ms   (14–27)
//
// ⚠️ 实测把评审的结论**收窄**了:B/C/D 三条彼此几乎分不开,真正可分的是 **A vs 其余**
//    —— state 无效在第一条 SQL 就返回,不碰上游、不查 User,少一整段本地开销。
//    于是这个 oracle 泄露的那一位是:「我方认不认这个 state」。
//    (评审给的"四条路径查询长度不同"方向对,但四分法不是实测形状;
//     照四分法去"逐分支配平"会配错地方 —— SOP §1.5:结论属实 ≠ 机制正确。)
//
// ── 怎么修 ──
// 有界最小响应时长 + 小扰动,**从请求进入 `login()` 那一刻**起算:
// 所有耗时低于 floor 的分支被拉平到同一个值,彼此不可分;
// 扰动让 floor 边界本身也测不准(否则多采几次就能读出 floor 常数,
// 再看谁"卡在 floor 上"仍能分出快慢两档)。
//
// ⚠️ **不**为了统一路径而对无效 state / 无效 code 发真实上游请求 —— 那会拿合法用户的
//    code 配额和上游限流去换一点点均匀性,是拿更糟的东西换。
// ⚠️ 因此存在**已知残余**:真实企业微信下 C(上游拒绝)可能超过 floor,
//    那一档仍与 A/B/D 可分。在不打上游就无法消除的前提下这是被接受的边界,
//    已写进交付报告与 handoff,不假装它不存在。
//    纵深:`login-wecom` 挂 IP 5/60 限流,攻击者能采到的样本量本身受限。

/** 有界最小响应时长。必须显著大于全部**本地**分支的耗时上界(实测上界 33ms)。 */
export const WECOM_LOGIN_FAILURE_FLOOR_MS = 150;

/** 扰动上界(均匀 `[0, JITTER)`);让 floor 常数本身不可被采样读出。 */
export const WECOM_LOGIN_FAILURE_JITTER_MS = 50;

/**
 * 36010 的单一归一化出口。
 *
 * 做成 `@Injectable` 而不是模块内私有函数,只为一件事:**判据可被机器核对**。
 * 单测把它换成 spy,就能逐分支断言"每一条 36010 都确实经过了这里"——
 * 而不是写一个毫秒阈值 e2e(既脆弱又必然 flake,goal 明令不写)。
 */
@Injectable()
export class WecomLoginFailureGate {
  /**
   * 补齐到 floor + 扰动,然后抛 36010。返回类型是 `never` —— 它永远不正常返回,
   * 调用方写 `await gate.reject(...)` 之后不需要再补一句 throw
   * (少一句就少一处"某天有人把 throw 删了,失败静默变成功"的可能)。
   *
   * `startedAtMs` 必须取自**请求处理的最开始**,不是失败发生的那一刻:
   * 从失败点起算等于没算 —— 差异恰恰积累在失败点**之前**。
   */
  async reject(startedAtMs: number): Promise<never> {
    const elapsed = Date.now() - startedAtMs;
    const target = WECOM_LOGIN_FAILURE_FLOOR_MS + randomInt(WECOM_LOGIN_FAILURE_JITTER_MS);
    // 已经超过 floor 的分支不再额外等(上界不封顶只会把慢分支拖得更显眼,
    // 且给了一条按耗时放大的 DoS 杠杆)。
    if (elapsed < target) {
      await delay(target - elapsed);
    }
    throw new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
  }
}

/** 判断某个异常是否就是 36010(用于把深层抛出的同码错误收进同一个出口)。 */
export function isWecomLoginCredentialInvalid(err: unknown): boolean {
  return (
    err instanceof BizException && err.biz.code === BizCode.WECOM_LOGIN_CREDENTIAL_INVALID.code
  );
}

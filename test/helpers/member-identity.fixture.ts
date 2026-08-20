import { MEMBER_ORIGIN_MANUAL } from '../../src/common/identity/member-origin.constant';

// 建 Member 所需的身份三件套(issue #1048 T1)。
//
// 为什么要这个 helper:`realName` / `memberSinceDate` / `memberOriginCode` 三列
// 都是 NOT NULL 且**刻意不给 DB default**(业务事实不该由 schema 替维护者编)。
// 于是全仓两百来处 `member.create` 各自补三行 —— 那不仅啰嗦,还会让「发号日」
// 在不同 spec 里散成一堆随机日期,日后任何按日期断言的用例都要先考古。
// 收成一处:测试里凡是不关心发号日的,一律用同一个常量。
//
// ⚠️ 关心发号日 / 来源码的用例请**显式覆盖**,不要改这里的默认值:
//   `{ ...memberIdentityData('张三'), memberSinceDate: new Date('2021-03-04T00:00:00.000Z') }`

/** 测试统一发号日。固定常量 —— 绝不用 `new Date()`,否则用例结果随墙钟漂移。 */
export const TEST_MEMBER_SINCE_DATE = new Date('2020-01-01T00:00:00.000Z');

export interface MemberIdentityData {
  realName: string;
  nickname?: string;
  memberSinceDate: Date;
  memberOriginCode: string;
}

/**
 * `realName` 之外全部取仓内统一默认值。
 *
 * `nickname` 默认「没有外号」——「大多数队员没外号」才是真实分布,默认给一个外号
 * 会让 `编号 · 姓名(外号)` 的不带括号分支在测试里几乎不被覆盖。
 *
 * ⚠️ 「没有外号」用**省略这个键**表达,不是 `nickname: null`。两个原因:
 *   1. 本 helper 同时喂 Prisma `create` 与 **HTTP 请求体**;`CreateMemberDto.nickname`
 *      用的是 `@OmittableOnly()`(仓内规则:只是可省略、不可为空 ⇒ 显式 null 稳定 400),
 *      带 `nickname: null` 的请求体会被打成 400;
 *   2. Prisma 侧省略可空列与显式 null 等价,都落 NULL —— 省略两边都对。
 * 真要测「显式清空」的行为,请在调用点直接写 `{ nickname: null }`,别改这里的默认值。
 */
export function memberIdentityData(realName: string, nickname?: string): MemberIdentityData {
  return {
    realName,
    ...(nickname === undefined ? {} : { nickname }),
    memberSinceDate: TEST_MEMBER_SINCE_DATE,
    memberOriginCode: MEMBER_ORIGIN_MANUAL,
  };
}

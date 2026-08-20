// 队员展示名的**唯一**拼装点(issue #1048 T1 DoD 6:「人员 label 全仓统一」)。
//
// 为什么是一个函数而不是各处 `${memberNo} · ${realName}`:
// 「全仓统一」如果靠约定,就会在下一个新增列表页处失效 —— 那正是 `displayName`
// 当初的下场(一列被 N 个地方各自解释)。把格式收成一处,格式本身就成了可改可测的东西:
// 半角括号要换成全角、分隔符要换、外号要加引号,都只动这里一行。
//
// ⚠️ 本文件是纯函数,不碰 Prisma、不碰 Nest DI —— 放在 common/ 才能被业务域各模块
// 平铺引用而不产生 business→business 的反向边(边界扫描见 scripts/check-boundaries.ts)。

/** 拼 label 所需的最小事实面;调用方的 Prisma select 至少要取到这三列。 */
export interface MemberLabelParts {
  readonly memberNo: string;
  readonly realName: string;
  readonly nickname?: string | null;
}

/**
 * `编号 · 姓名(外号)`;外号为空(null / undefined / 全空白)时**不显示括号**。
 *
 * 空白也算空是刻意的:`nickname` 可空且无 trim 约束,`"   "` 落库后若按「非 null 即有值」
 * 判断,会渲染出一个 `姓名(   )` 的空括号 —— 那是 DoD 6 后半句要挡的东西。
 */
export function formatMemberLabel(parts: MemberLabelParts): string {
  const base = `${parts.memberNo} · ${parts.realName}`;
  const nickname = parts.nickname?.trim();
  return nickname ? `${base}(${nickname})` : base;
}

/** 人员引用 DTO 的统一字段集(全仓同形)。 */
export interface MemberLabelFields {
  readonly memberNo: string;
  readonly realName: string;
  readonly nickname: string | null;
  readonly label: string;
}

/**
 * `memberLabelSelect` 取出的行 → 对外 DTO 的四个字段。
 *
 * `nickname` 统一收敛成 `string | null`(而不是留 `undefined`):对外契约里
 * 「没有外号」只能有一种形态,否则 JSON 里会时而是 `null` 时而整个键消失。
 */
export function toMemberLabelFields(parts: MemberLabelParts): MemberLabelFields {
  return {
    memberNo: parts.memberNo,
    realName: parts.realName,
    nickname: parts.nickname ?? null,
    label: formatMemberLabel(parts),
  };
}

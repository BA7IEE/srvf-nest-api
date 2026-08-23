import { Prisma } from '@prisma/client';
import { maskIdentifier } from '../../common/audit/mask-pii.util';
import { toMemberLabelFields } from '../../common/identity/member-label.util';
import type {
  MemberInsuranceWorkbenchItemDto,
  MemberInsuranceWorkbenchMemberDto,
} from './member-insurances-workbench.dto';

// MemberInsurance 行 → admin 侧出参的**唯一**字段分级点(2026-08-23,保险审核工作台)。
//
// 为什么要有这个文件:审核工作台是**跨队员**面,而单人面
// `GET /admin/v1/members/:memberId/insurances` 已经存在。两个面各写一份「哪些列该掩」,
// 就会各自漂移 —— 而漂移时**没有症状**:没有测试会红,没有检查会响,
// 只在有人真去比对两个响应那天才暴露。所以分级只留一份,两个面都从这里取。
//
// 分级现状(实测 d1adf853):
//   - 单人面历史口径是 `policyNumber` **明文**(无掩码、无 `*.read.sensitive` 分档)。
//     本刀不改它(goal §6 明令「不改单人端点的行为或掩码口径」)。
//   - 跨队员面**恒掩码、永不返明文** —— 沿 `certificates-workbench` 的成文范式
//     (`certificates-workbench.dto.ts` §15.2「工作台永不返回完整 certNumber」)。
//     一个跨队员列表若返明文保单号,它就是绕过掩码的批量通道;
//     与「和单人面形式一致」相比,这是更重要的那条不变式。

/**
 * 敏感列 select 片段 —— 本文件的**根事实**。
 *
 * 新增敏感列只改这一处:`MEMBER_INSURANCE_SENSITIVE_FIELDS` 机械派生、
 * 单人面 select 自动带上、工作台 presenter 自动剥掉。
 */
export const MEMBER_INSURANCE_SENSITIVE_SELECT = {
  policyNumber: true,
} as const satisfies Prisma.MemberInsuranceSelect;

export type MemberInsuranceSensitiveField = keyof typeof MEMBER_INSURANCE_SENSITIVE_SELECT;

/**
 * 敏感列名清单。从 select 机械派生而不是另抄一份数组 ——
 * 两份手写清单会漂,派生的不会。
 */
export const MEMBER_INSURANCE_SENSITIVE_FIELDS = Object.keys(
  MEMBER_INSURANCE_SENSITIVE_SELECT,
) as ReadonlyArray<MemberInsuranceSensitiveField>;

/** 非敏感列:任何持 `member-insurance.read.other` 的调用方都可见原值。 */
export const MEMBER_INSURANCE_SAFE_SELECT = {
  id: true,
  memberId: true,
  insurerName: true,
  coverageStart: true,
  coverageEnd: true,
  createdAt: true,
  updatedAt: true,
  reviewStatusCode: true,
  version: true,
  reviewedAt: true,
} as const satisfies Prisma.MemberInsuranceSelect;

/**
 * 单人面 select(`GET /admin/v1/members/:memberId/insurances` 与审核端点出参)。
 *
 * 字段集与本刀之前逐字相同 —— 只是不再手抄一份,而是由「安全列 ∪ 敏感列」拼出来,
 * 这样两个面**共用同一份分级**,而不是共用一份注释里的约定。
 */
export const MEMBER_INSURANCE_ADMIN_SELECT = {
  ...MEMBER_INSURANCE_SAFE_SELECT,
  ...MEMBER_INSURANCE_SENSITIVE_SELECT,
} as const satisfies Prisma.MemberInsuranceSelect;

/** 工作台需要的队员标识列(拼 label 的最小事实面)。 */
export const MEMBER_INSURANCE_WORKBENCH_MEMBER_SELECT = {
  id: true,
  memberNo: true,
  realName: true,
  nickname: true,
} as const satisfies Prisma.MemberSelect;

/**
 * 工作台 select。敏感列取出来**只为算掩码**,presenter 不外传原值 ——
 * 出参里不出现原值这件事由 `presentMemberInsuranceWorkbenchItem` 结构性保证,
 * 不靠调用方记得剥。
 */
export const MEMBER_INSURANCE_WORKBENCH_SELECT = {
  ...MEMBER_INSURANCE_SAFE_SELECT,
  ...MEMBER_INSURANCE_SENSITIVE_SELECT,
  member: { select: MEMBER_INSURANCE_WORKBENCH_MEMBER_SELECT },
} as const satisfies Prisma.MemberInsuranceSelect;

export type MemberInsuranceWorkbenchRow = Prisma.MemberInsuranceGetPayload<{
  select: typeof MEMBER_INSURANCE_WORKBENCH_SELECT;
}>;

function toWorkbenchMember(
  member: MemberInsuranceWorkbenchRow['member'],
): MemberInsuranceWorkbenchMemberDto {
  return { id: member.id, ...toMemberLabelFields(member) };
}

/**
 * 敏感列进入工作台出参的**唯一**出口。
 *
 * 剥离用分级表驱动的循环,而不是 `const { policyNumber, ...rest } = row`:
 * 后者也能剥掉今天这一列,但明天分级表新增一列时它不会跟着变,
 * 而 TS 的多余属性检查**对 spread 是失明的**(不报错)—— 漂移零症状,正是要防的那件事。
 */
export function presentMemberInsuranceWorkbenchItem(
  row: MemberInsuranceWorkbenchRow,
): MemberInsuranceWorkbenchItemDto {
  const stripped: Record<string, unknown> = { ...row };
  for (const field of MEMBER_INSURANCE_SENSITIVE_FIELDS) {
    delete stripped[field];
  }
  // `member` 换成展示用聚合;`memberId` 与 `member.id` 同值,不给契约留两种表示。
  delete stripped.member;
  delete stripped.memberId;

  const safe = stripped as Omit<
    MemberInsuranceWorkbenchRow,
    MemberInsuranceSensitiveField | 'member' | 'memberId'
  >;

  return {
    ...safe,
    member: toWorkbenchMember(row.member),
    policyNumberMasked: maskIdentifier(row.policyNumber),
  };
}

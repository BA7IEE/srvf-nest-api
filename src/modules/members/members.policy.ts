import { DictItemStatus, DictTypeStatus, type Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

// Member 域校验策略(Phase 6-B 第三刀;docs/architecture-boundary.md §3.3 Policy
// 的 "domain-specific validation")。
//
// **入参即全部依赖**:
// - ❌ 不 import `prisma.service`、不注入任何 service、不持有 `this`
// - ❌ 不开事务(调用方在自己的 `$transaction` 内把 client 传进来)
// - ❌ 不判权(RBAC / authz 仍归 `MembersService.assertCanOrThrow`)
// - ✅ 只做「这个取值合不合法」的域判定,并抛既有 BizCode
//
// ⚠️ 留在 service 未搬的三个(**刻意**,不是遗漏):
// - `assertCanOrThrow` —— 判权,§3.3 明确不收
// - `runWithUniqueConstraintGuard` —— P2002 错误映射,包着调用方的回调,属编排
// - `assertMemberNoUnique` —— 见 PR 说明:它与本文件的 `assertGradeCodeValid` 同型
//   (都是「传入 client 做一次存在性查询」),goal 只点名搬后者;为不越写集范围,
//   本刀按 goal 原样执行,一致性问题已上报维护者。

// 队员等级 dict_type code(seed 内置真实值 member_grade,R13 收窄后队内分类可内置;
// 详见 prisma/seed.ts V2_DICT_SEED)。
const MEMBER_GRADE_DICT_CODE = 'member_grade';

/** 只读 client:调用方传入 `tx`(事务内)或 `PrismaService`(事务外)。 */
type DictReader = Pick<Prisma.TransactionClient, 'dictItem'>;

// memberNo 入库前 trim(保留原大小写,与 v1 username 的 toLowerCase 不同 — 编号即身份)
export function normalizeMemberNo(raw: string): string {
  return raw.trim();
}

// gradeCode 6 项 AND 校验(对应 docs/v2-api-contract.md §4.3,与 organizations 同模式):
//   dict_type.code = MEMBER_GRADE_DICT_CODE
//   dict_type.status = ACTIVE
//   dict_type.deletedAt = null
//   dict_item.code = gradeCode
//   dict_item.status = ACTIVE
//   dict_item.deletedAt = null
export async function assertGradeCodeValid(client: DictReader, gradeCode: string): Promise<void> {
  const item = await client.dictItem.findFirst({
    where: {
      code: gradeCode,
      status: DictItemStatus.ACTIVE,
      deletedAt: null,
      type: {
        code: MEMBER_GRADE_DICT_CODE,
        status: DictTypeStatus.ACTIVE,
        deletedAt: null,
      },
    },
    select: { id: true },
  });
  if (!item) throw new BizException(BizCode.MEMBER_GRADE_CODE_INVALID);
}

import type { UserStatus } from '@prisma/client';
import { formatMemberLabel } from '../../common/identity/member-label.util';
import type { MemberResponseDto } from './members.dto';
import type { SafeMember } from './members-query.service';

// Member 响应组装(Phase 6-B 第三刀;docs/architecture-boundary.md §3.1 Presenter)。
//
// 触发条件是 §3.1 第一条 trigger:同一份输出形状在 service 内被 10 处调用
// (create / findOne / update / updateStatus / softDelete / bind / unbind /
//  status-change / offboard,以及第一刀之后的 list 分页映射)。
//
// **纯函数,入参即全部依赖**:
// - ❌ 不 import `prisma.service`、不查库、不开事务
// - ❌ 不判权 / 不写 audit / 不做状态跃迁判断
// - ✅ 只把 SafeMember + 关联 live User 拼成对外 DTO
//
// issue #1048 T1:统一展示标签 `label` 在这里拼(而不是让 10 个调用点各拼一次),
// 格式本体收在 `common/identity/member-label.util.ts` —— 全仓同一份。
export function attachAccountInfo(
  member: SafeMember,
  linked: { id: string; status: UserStatus } | undefined,
): MemberResponseDto {
  return {
    ...member,
    label: formatMemberLabel(member),
    hasAccount: linked !== undefined,
    accountStatus: linked?.status ?? null,
    userId: linked?.id ?? null,
  };
}

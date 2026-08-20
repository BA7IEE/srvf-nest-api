import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { VisibleOrganizationScope } from '../authz/authz.service';

// 队员**读**范围的唯一解析点(issue #1048 T3 抽出)。
//
// 为什么单独一个文件:`MembersService` 与 `MemberReferenceResolver` 都要「先拿到调用者
// 能看见哪些组织,拿不到就 30100」。这段逻辑复制成两份,就会有两份可各自演化的授权入口 ——
// 而漂移的表现是「解析器多认出了本不该看见的人」,不会有任何东西报错。
//
// 不放进 `members.policy.ts`:那个文件的边界注释明写「不判权」,把判权塞进去等于把它的
// 契约改掉。也不放进 `MembersQueryService`:那个类明写禁止注入 rbac / authz。
//
// **入参即全部依赖**:authz 由调用方注入并传进来,本文件不持有 `this`、不注入任何 service。
type AuthzReader = {
  getVisibleOrganizationScope(
    currentUser: CurrentUserPayload,
    permissionCode: string,
  ): Promise<VisibleOrganizationScope>;
};

/** 队员读面统一权限码 —— 解析器与列表/选择器共用同一个,不另开新码(issue §5.2 D2 口径)。 */
export const MEMBER_READ_PERMISSION_CODE = 'member.read.record';

/**
 * 取调用者的可见组织范围;无码直接 30100。
 *
 * 返回的 `VisibleOrganizationScope` 再交给 `MembersQueryService.buildOrganizationScopeFilter`
 * 翻成 where —— 从「谁能看见什么」到「SQL 怎么写」这条链上,两端各只有一份实现。
 */
export async function resolveMemberReadScope(
  authz: AuthzReader,
  currentUser: CurrentUserPayload,
): Promise<VisibleOrganizationScope> {
  const scope = await authz.getVisibleOrganizationScope(currentUser, MEMBER_READ_PERMISSION_CODE);
  if (!scope.hasPermission) {
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }
  return scope;
}

import { Injectable } from '@nestjs/common';
import { BindingScopeType, OrganizationStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { RbacService } from '../permissions/rbac.service';
import {} from '../permissions/role-binding-validity';
import {} from '../permissions/role-delegation.policy';
import {} from './role-bindings.dto';
import { type SafeRoleBinding } from './role-bindings.select';

/*
 * 角色绑定的**共享准入与序列化**(Phase 6-B 第三域第六刀,§3.2)。
 *
 * 两件被读侧与写侧**双方**使用的东西:判权入口、行→DTO 序列化。
 * 不先降为共享底座,被抽出的读族就得 import 回主 service(循环依赖)。
 *
 * ⚠️ 判权做成注入而非「把结果当入参传」:漏传一个实参 = 一条判权凭空消失,
 * 而全仓单测可以零红(6-B 第三域实测)。注入式则调用点仍在各族自己的方法体内。
 */
@Injectable()
export class RoleBindingAccessService {
  constructor(private readonly rbac: RbacService) {}

  async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  toResponseDto(row: SafeRoleBinding) {
    return {
      id: row.id,
      principalType: row.principalType,
      principalId: row.principalId,
      roleId: row.roleId,
      scopeType: row.scopeType,
      scopeOrgId: row.scopeOrgId,
      scopeActivityId: row.scopeActivityId,
      scopeResourceType: row.scopeResourceType,
      scopeResourceId: row.scopeResourceId,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      createdByUserId: row.createdByUserId,
      note: row.note,
      scopeInactive:
        (row.scopeType === BindingScopeType.ORGANIZATION ||
          row.scopeType === BindingScopeType.ORGANIZATION_TREE) &&
        (row.scopeOrganization === null ||
          row.scopeOrganization.deletedAt !== null ||
          row.scopeOrganization.status !== OrganizationStatus.ACTIVE),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

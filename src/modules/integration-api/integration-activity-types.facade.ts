import { Injectable } from '@nestjs/common';
import { PrincipalType } from '@prisma/client';

import type { IntegrationPrincipalContext } from '../../common/decorators/current-integration-principal.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityTypeReferenceQueryService } from '../dictionaries/activity-type-reference-query.service';
import { DirectPrincipalAuthzService } from '../integration-authz/direct-principal-authz.service';
import { RoleBindingScopeCoveragePolicy } from '../integration-authz/role-binding-scope-coverage.policy';
import {
  IntegrationActivityTypeItemDto,
  ListIntegrationActivityTypesQueryDto,
} from './integration-activity-types.dto';

/**
 * PR7 的 Integration 编排边界：主体准入和直接角色授权留在这里，字典读模型仍归属
 * 字典域的窄 Query API。没有通用 integration facade，也不接入任何写命令。
 */
@Injectable()
export class IntegrationActivityTypesFacade {
  constructor(
    private readonly directAuthz: DirectPrincipalAuthzService,
    private readonly scopeCoverage: RoleBindingScopeCoveragePolicy,
    private readonly activityTypeReferences: ActivityTypeReferenceQueryService,
  ) {}

  async list(
    principal: IntegrationPrincipalContext,
    query: ListIntegrationActivityTypesQueryDto,
  ): Promise<PageResultDto<IntegrationActivityTypeItemDto>> {
    // 路由声明与 IntegrationJwtAuthGuard 已在入口拒绝 DELEGATED；此处仍保留服务层
    // 纵深，防止未来内部调用绕开 route principal admission。
    if (principal.kind !== 'SERVICE') {
      throw new BizException(BizCode.PRINCIPAL_KIND_FORBIDDEN);
    }

    const action = 'dict.read.item';
    const decision = await this.directAuthz.explainDirect(
      {
        principalType: PrincipalType.SERVICE_PRINCIPAL,
        principalId: principal.servicePrincipalId,
      },
      action,
    );

    // `activity_type` 是全局参考数据，不存在可供组织/活动/资源 scope 对齐的目标；
    // 因而只有 GLOBAL direct binding 可覆盖空目标。不能让局部绑定扩大为全局目录读取。
    if (!decision.allowed || !(await this.scopeCoverage.anyCovers(decision.matched, {}))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    return this.activityTypeReferences.listActive(query);
  }
}

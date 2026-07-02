import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { AuthzService } from './authz.service';
import type { ExplainAuthzDto, ExplainAuthzResponseDto } from './authz.dto';

// 终态 scoped-authz PR10「authz/explain 端点」(2026-07-02;冻结稿 §7.6):权限解释薄编排。
// 只做三件事:调用者判权 → 目标用户加载 → 委托 AuthzService.explain 原样返回。
// **不改 AuthzService/resolver/constraints 任何语义**(判权大脑 PR8 冻结;本 service 是纯消费者)。
//
// 判权口径(goal 决断①):调用者走 rbac.can('authz.explain.decision') —— 沿现 admin 面 R 模式单轨
// (与 authz.can 无 ref 等价,PR8 已证;逐面迁移是 PR12);缺码 → 30100。
// deny 是数据不是错误(goal 决断②):入参合法即 200 返 decision;resource_not_found 也是 200 的
// decision reason。仅输入错误走异常:目标用户不存在/已软删 → USER_NOT_FOUND(10001)。
// 无 audit(goal 决断④):纯诊断读,ops-admin 门控;deny 采样(冻结稿 §10.6 可选项)本刀不做。

const EXPLAIN_PERMISSION_CODE = 'authz.explain.decision';

@Injectable()
export class AuthzExplainService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
  ) {}

  async explain(
    caller: CurrentUserPayload,
    dto: ExplainAuthzDto,
  ): Promise<ExplainAuthzResponseDto> {
    if (!(await this.rbac.can(caller, EXPLAIN_PERMISSION_CODE))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    // 目标用户按 CurrentUserPayload 形状加载(status 原样返:DISABLED 也可 explain,goal 决断③ ——
    // 运营正是要排查"他为什么不行";线上真实请求会先被 JwtStrategy 挡,响应含 status 让这一层可见)。
    const target = await this.prisma.user.findFirst({
      where: { id: dto.userId, deletedAt: null },
      select: { id: true, username: true, role: true, status: true, memberId: true },
    });
    if (!target) {
      throw new BizException(BizCode.USER_NOT_FOUND);
    }

    const decision = await this.authz.explain(target, dto.action, dto.resourceRef);
    return { targetUser: target, decision };
  }
}

import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { AuthzService } from './authz.service';
import type {
  ExplainAuthzBatchDto,
  ExplainAuthzBatchResponseDto,
  ExplainAuthzDto,
  ExplainAuthzResponseDto,
  ExplainBatchResultItemDto,
} from './authz.dto';

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
// F3/C2(路线图 §4 C2 / D8;2026-07-04):批量壳独立码(绑 ops-admin,镜像单条码)。
const EXPLAIN_BATCH_PERMISSION_CODE = 'authz.explain-batch.decision';

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

  // F3/C2「explain-batch」:单条 explain 的批量壳(≤200;逻辑 = 循环委托 AuthzService.explain,
  // 目标用户批量预取一次)。**判权语义零新增**:decision 与单条逐字同源;reason 同一套 11 值枚举。
  // 输入错误镜像单条:任一 userId 不存在/已软删 → 整请求 10001(items 内无「用户不存在」通道,
  // reason 枚举是 §9 行 20 契约锁,不为批量壳扩值)。响应逐条回显入参 + decision,无 targetUser
  // 快照(与单条刻意不同:批量面向矩阵诊断,快照请走单条)。
  async explainBatch(
    caller: CurrentUserPayload,
    dto: ExplainAuthzBatchDto,
  ): Promise<ExplainAuthzBatchResponseDto> {
    if (!(await this.rbac.can(caller, EXPLAIN_BATCH_PERMISSION_CODE))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const uniqueUserIds = [...new Set(dto.items.map((i) => i.userId))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: uniqueUserIds }, deletedAt: null },
      select: { id: true, username: true, role: true, status: true, memberId: true },
    });
    if (users.length !== uniqueUserIds.length) {
      throw new BizException(BizCode.USER_NOT_FOUND);
    }
    const byId = new Map(users.map((u) => [u.id, u]));

    const items: ExplainBatchResultItemDto[] = [];
    for (const item of dto.items) {
      const target = byId.get(item.userId)!;
      const decision = await this.authz.explain(target, item.action, item.resourceRef);
      items.push({
        userId: item.userId,
        action: item.action,
        ...(item.resourceRef !== undefined ? { resourceRef: item.resourceRef } : {}),
        decision,
      });
    }
    return { items };
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { MemberInsuranceAdminResponseDto } from './insurances.dto';

// 保险模块 T2:admin 查队员自购保险 service(2026-06-13)。
// 冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.2 端点 14 / E-15。
//
// 仅 1 个读端点:GET admin/v1/members/:memberId/insurances,返数组无分页
// (镜像 admin certificates list 范式;每队员保险记录量小)。
// 判权:rbac.can('member-insurance.read.other')(App 本人侧 self-scope 无码)。
// audit:查询完成后 fail-closed 落 member-insurance.read.other;extra 只记 operation/count,
// 不记录保单号、保险公司或 id 列表。

const adminSelect = {
  id: true,
  memberId: true,
  insurerName: true,
  policyNumber: true,
  coverageStart: true,
  coverageEnd: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MemberInsuranceSelect;

@Injectable()
export class MemberInsurancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
  ) {}

  async listForMember(
    memberId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<MemberInsuranceAdminResponseDto[]> {
    const action = 'member-insurance.read.other';
    const decision = await this.authz.explain(currentUser, action, {
      type: 'member',
      id: memberId,
    });
    if (
      !decision.allow &&
      !(decision.reason === 'resource_not_found' && (await this.rbac.can(currentUser, action)))
    ) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const member = await this.prisma.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);

    const items = await this.prisma.memberInsurance.findMany({
      where: notDeletedWhere({ memberId }),
      select: adminSelect,
      orderBy: { coverageEnd: 'desc' },
    });

    await this.auditLogs.log({
      event: 'member-insurance.read.other',
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'member',
      resourceId: memberId,
      meta: auditMeta,
      extra: { operation: 'list', count: items.length },
    });

    return items;
  }
}

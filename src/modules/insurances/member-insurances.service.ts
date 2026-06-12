import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { auditPlaceholder } from '../../common/audit/audit-placeholder';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { MemberInsuranceAdminResponseDto } from './insurances.dto';

// 保险模块 T2:admin 查队员自购保险 service(2026-06-13)。
// 冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.2 端点 14 / E-15。
//
// 仅 1 个读端点:GET admin/v1/members/:memberId/insurances,返数组无分页
// (镜像 admin certificates list 范式;每队员保险记录量小)。
// 判权:rbac.can('member-insurance.read.other')(App 本人侧 self-scope 无码)。
// audit:pino auditPlaceholder('member-insurance.read.other')——保单号/保险公司中敏感,
// admin 视角读他人留痕(镜像 certificate.read.other;评审稿 E-9);不进 audit_logs DB。

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
    private readonly rbac: RbacService,
  ) {}

  async listForMember(
    memberId: string,
    currentUser: CurrentUserPayload,
  ): Promise<MemberInsuranceAdminResponseDto[]> {
    if (!(await this.rbac.can(currentUser, 'member-insurance.read.other'))) {
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

    auditPlaceholder('member-insurance.read.other', {
      operatorUserId: currentUser.id,
      targetMemberId: memberId,
      insuranceIds: items.map((i) => i.id),
      operation: 'list',
    });

    return items;
  }
}

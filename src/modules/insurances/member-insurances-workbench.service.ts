import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import {
  MEMBER_INSURANCE_WORKBENCH_SELECT,
  presentMemberInsuranceWorkbenchItem,
} from './member-insurance-projection';
import type {
  ListMemberInsuranceWorkbenchQueryDto,
  MemberInsuranceWorkbenchItemDto,
} from './member-insurances-workbench.dto';

// 保险审核工作台 service(2026-08-23)。
//
// 它解锁的是 `INSURANCE_ENFORCEMENT_ENABLED` 的前置条件:开关一开,所有「录了但没审」的
// 记录当场失效,那批人会突然报不上名。开之前必须先把已录的保险审一遍,而在本刀之前
// 「哪些还没审」这个问题**在系统里没有任何办法回答** —— 只有按 memberId 的单人端点,
// 要回答只能把每个队员挨个点一遍(scripts/ 下也没有运维脚本旁路)。
//
// 判权:复用单人面的 `member-insurance.read.other`,零新增码。
//   跨队员面没有资源 ref,而 `authz.explain` 在**无 ref 时是逐字复用 rbac.judge 的退化路径**
//   (`authz.service.ts:253` 的行为锁),所以这里直接走 `rbac.can` —— 与单人面同一条
//   可见性边界,不是另开一条。该码 `engine=rbac-global` / `scopes=-` / 无 ActionConstraint,
//   没有需要下推的数据范围(与 `certificate.read.record` 的组织范围不同,那是证书侧的专门设计)。
//
// PII:保单号**恒掩码**,见 `member-insurance-projection.ts`。跨队员面永不返明文。
//
// audit:与单人面同一个事件族 `member-insurance.read.other`(不新增族,
//   `sensitive-read-audit-unification` 的九族清单不变),查询完成后 fail-closed 先落账再返数据;
//   extra 只记 operation / 过滤字段名 / 计数,**不记**保单号、保险公司或 id 列表。

const ACTION = 'member-insurance.read.other';

@Injectable()
export class MemberInsurancesWorkbenchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
  ) {}

  async list(
    query: ListMemberInsuranceWorkbenchQueryDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<PageResultDto<MemberInsuranceWorkbenchItemDto>> {
    if (!(await this.rbac.can(currentUser, ACTION))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    // 软删的保险行不出;软删队员的保险行也不出 —— 单人面对软删队员是 26001,
    // 跨队员面若把它们列出来,就成了「单人面查不到、列表里却看得见」的两套口径。
    const where: Prisma.MemberInsuranceWhereInput = notDeletedWhere({
      member: { deletedAt: null },
      ...(query.reviewStatusCode ? { reviewStatusCode: query.reviewStatusCode } : {}),
    });

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.memberInsurance.findMany({
        where,
        select: MEMBER_INSURANCE_WORKBENCH_SELECT,
        // 分页出参铁律的默认排序;`id` 兜底保证同 createdAt 下翻页稳定不重不漏。
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.memberInsurance.count({ where }),
    ]);

    await this.auditLogs.log({
      event: ACTION,
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'member',
      resourceId: null,
      meta: auditMeta,
      extra: {
        operation: 'workbench-list',
        filterFields: Object.keys(query)
          .filter((k) => k !== 'page' && k !== 'pageSize')
          .sort(),
        count: rows.length,
        total,
      },
    });

    return {
      items: rows.map((row) => presentMemberInsuranceWorkbenchItem(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}

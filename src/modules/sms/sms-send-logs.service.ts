import { Injectable } from '@nestjs/common';
import type { Prisma, SmsSendLog as SmsSendLogRow } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { maskPhone } from './sms.constants';
import type { SmsSendLogQueryDto, SmsSendLogResponseDto } from './sms.dto';

// SMS 基础设施 T2(2026-06-10):sms_send_logs 只读列表(评审稿 §3.2 ④ / E-20)
//
// - 分页只读;无 detail / 无更新删除路径(append-only 留痕,写入方为 SmsCodeService,T3)
// - **响应 phone 一律掩码** 138****1234(E-21);入参 phone 过滤为精确匹配明文
// - R 模式判权:rbac.can('sms-send-log.read.list'),失败 30100(镜像 audit-log.read.entry 范式)
// - 默认排序 createdAt desc(沿 AGENTS §4)

@Injectable()
export class SmsSendLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  async list(
    query: SmsSendLogQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<SmsSendLogResponseDto>> {
    if (!(await this.rbac.can(user, 'sms-send-log.read.list'))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const where: Prisma.SmsSendLogWhereInput = {};
    if (query.status !== undefined) where.status = query.status;
    if (query.phone !== undefined) where.phone = query.phone;

    const { page, pageSize } = query;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.smsSendLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.smsSendLog.count({ where }),
    ]);

    return {
      items: items.map((row) => this.toResponseDto(row)),
      total,
      page,
      pageSize,
    };
  }

  private toResponseDto(row: SmsSendLogRow): SmsSendLogResponseDto {
    return {
      id: row.id,
      phone: maskPhone(row.phone),
      templateKey: row.templateKey,
      providerType: row.providerType,
      status: row.status,
      providerMsgId: row.providerMsgId,
      errCode: row.errCode,
      errMsg: row.errMsg,
      codeId: row.codeId,
      createdAt: row.createdAt,
    };
  }
}

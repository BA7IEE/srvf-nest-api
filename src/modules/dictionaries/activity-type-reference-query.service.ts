import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';

import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';

/** Integration reference read model; deliberately excludes ids, status and timestamps. */
export interface ActiveActivityTypeReference {
  code: string;
  label: string;
  sortOrder: number;
}

const activeActivityTypeReferenceSelect = {
  code: true,
  label: true,
  sortOrder: true,
} as const satisfies Prisma.DictItemSelect;

/**
 * 字典域对外的最小只读 Query API。类型固定为 `activity_type`，不接受任何调用方指定的
 * 字典类型，防止它被扩展为通用字典导出面。
 */
@Injectable()
export class ActivityTypeReferenceQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async listActive(query: PaginationQueryDto): Promise<PageResultDto<ActiveActivityTypeReference>> {
    return this.prisma.$transaction(async (tx) => {
      const type = await tx.dictType.findFirst({
        where: notDeletedWhere({ code: 'activity_type', status: DictTypeStatus.ACTIVE }),
        select: { id: true },
      });
      if (type === null) throw new BizException(BizCode.DICT_TYPE_NOT_FOUND);

      const where: Prisma.DictItemWhereInput = notDeletedWhere({
        typeId: type.id,
        status: DictItemStatus.ACTIVE,
      });
      const [items, total] = await Promise.all([
        tx.dictItem.findMany({
          where,
          select: activeActivityTypeReferenceSelect,
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        tx.dictItem.count({ where }),
      ]);
      return { items, total, page: query.page, pageSize: query.pageSize };
    });
  }
}

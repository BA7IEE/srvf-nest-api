import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { ActivityTemplateVersionCommand } from './activity-template-version-command';
import { ActivityTemplateDefinitionV1Error } from './activity-template-definition-v1';
import {
  globalTemplateFamilyWhere,
  presentTemplateVersion,
  presentTemplateVersionSummary,
} from './activity-template-version-presenter';

@Injectable()
export class ActivityTemplateVersionQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: ActivityTemplateVersionCommand,
  ) {}

  list(
    query: {
      page: number;
      pageSize: number;
      familyId?: string;
      statusCode?: string;
      schemaVersion?: number;
    },
    user: CurrentUserPayload,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'activity-template.read.catalog');
      const where: Prisma.ActivityTemplateWhereInput = {
        family: globalTemplateFamilyWhere(),
        familyId: query.familyId,
        statusCode: query.statusCode,
        schemaVersion: query.schemaVersion ?? { in: [1, 2, 3, 4] },
      };
      const [rows, total] = await Promise.all([
        tx.activityTemplate.findMany({
          where,
          include: { family: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        tx.activityTemplate.count({ where }),
      ]);
      return {
        items: rows.map(presentTemplateVersionSummary),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  get(id: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'activity-template.read.catalog');
      const row = await tx.activityTemplate.findFirst({
        where: { id, family: globalTemplateFamilyWhere(), schemaVersion: { in: [1, 2, 3, 4] } },
        include: { family: true },
      });
      if (!row) throw new BizException(BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND);
      try {
        return presentTemplateVersion(row);
      } catch (error) {
        if (error instanceof TypeError || error instanceof ActivityTemplateDefinitionV1Error)
          throw new BizException(BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID);
        throw error;
      }
    });
  }
}

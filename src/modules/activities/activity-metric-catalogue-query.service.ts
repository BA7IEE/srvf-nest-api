import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityMetricCommand } from './activity-metric-command';
import { presentMetricDefinition, presentMetricSet } from './activity-metric-presenter';
import type { AdminListActivityMetricDefinitionsQueryDto } from './dto/admin/activity-metric-definition.dto';
import type { AdminListActivityMetricSetsQueryDto } from './dto/admin/activity-metric-set.dto';

@Injectable()
export class ActivityMetricCatalogueQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: ActivityMetricCommand,
  ) {}

  listDefinitions(query: AdminListActivityMetricDefinitionsQueryDto, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'activity-metric.read.catalog');
      const { page, pageSize } = query;
      const where = { code: query.code, statusCode: query.statusCode, kindCode: query.kindCode };
      const [rows, total] = await Promise.all([
        tx.activityMetricDefinition.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        tx.activityMetricDefinition.count({ where }),
      ]);
      return { items: rows.map(presentMetricDefinition), total, page, pageSize };
    });
  }

  getDefinition(id: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'activity-metric.read.catalog');
      const row = await tx.activityMetricDefinition.findFirst({ where: { id } });
      if (!row) throw new BizException(BizCode.ACTIVITY_METRIC_DEFINITION_NOT_FOUND);
      return presentMetricDefinition(row);
    });
  }

  listSets(query: AdminListActivityMetricSetsQueryDto, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'activity-metric.read.catalog');
      const { page, pageSize } = query;
      const where = { code: query.code, statusCode: query.statusCode };
      const [rows, total] = await Promise.all([
        tx.activityMetricSetVersion.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: {
            items: { include: { metricDefinition: true }, orderBy: { sortOrder: 'asc' } },
          },
        }),
        tx.activityMetricSetVersion.count({ where }),
      ]);
      return { items: rows.map(presentMetricSet), total, page, pageSize };
    });
  }

  getSet(id: string, user: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.commands.assertAccess(tx, user, 'activity-metric.read.catalog');
      const row = await tx.activityMetricSetVersion.findFirst({
        where: { id },
        include: { items: { include: { metricDefinition: true }, orderBy: { sortOrder: 'asc' } } },
      });
      if (!row) throw new BizException(BizCode.ACTIVITY_METRIC_SET_NOT_FOUND);
      return presentMetricSet(row);
    });
  }
}

import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, type WechatSubscribeTemplate } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { NOTIFICATION_TYPE_DICT_CODE } from './notification.constants';
import type {
  UpsertWechatSubscribeTemplateDto,
  WechatSubscribeTemplateDto,
} from './notification.dto';

// 统一通知 S2:微信订阅消息模板配置(notificationTypeCode → templateId;运营可配,D-N3)。
//
// 镜像 wechat-settings.service「模板 ID 存配置 + RBAC 判权 + 运营可配不重部署」范式。
// - getEnabledTemplateId(typeCode):派发器用——返该类型已启用且 templateId 非空的模板 ID,否则 null(整渠道跳过)。
// - listForAdmin / upsertForAdmin:admin 运维面(R 模式 rbac.can;读 notification.read.record / 写 notification.update.template)。
//
// 一类型一模板(notificationTypeCode @unique);templateId 可空(小程序后台审批后由 admin 填)。
@Injectable()
export class WechatSubscribeTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 派发器调用:该类型当前是否有可发的微信模板(enabled 且 templateId 非空)。
  async getEnabledTemplateId(notificationTypeCode: string): Promise<string | null> {
    const row = await this.prisma.wechatSubscribeTemplate.findUnique({
      where: { notificationTypeCode },
      select: { templateId: true, enabled: true },
    });
    if (!row || !row.enabled || !row.templateId) return null;
    return row.templateId;
  }

  // ===== admin:列出全部模板配置(运维查看哪些类型已配模板)=====
  async listForAdmin(user: CurrentUserPayload): Promise<WechatSubscribeTemplateDto[]> {
    await this.assertCanOrThrow(user, 'notification.read.record');
    const rows = await this.prisma.wechatSubscribeTemplate.findMany({
      orderBy: { notificationTypeCode: 'asc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  // ===== admin:upsert 某类型的模板 ID + 启用态(运营改不重部署)=====
  // notificationTypeCode 须为 notification_type 字典 ACTIVE item(防为不存在类型配模板)。
  async upsertForAdmin(
    notificationTypeCode: string,
    dto: UpsertWechatSubscribeTemplateDto,
    user: CurrentUserPayload,
  ): Promise<WechatSubscribeTemplateDto> {
    await this.assertCanOrThrow(user, 'notification.update.template');
    await this.assertNotificationTypeValid(notificationTypeCode);

    const enabled = dto.enabled ?? true;
    const row = await this.prisma.wechatSubscribeTemplate.upsert({
      where: { notificationTypeCode },
      create: {
        notificationTypeCode,
        templateId: dto.templateId ?? null,
        enabled,
        remarks: dto.remarks ?? null,
        updatedBy: user.id,
      },
      update: {
        templateId: dto.templateId ?? null,
        enabled,
        remarks: dto.remarks ?? null,
        updatedBy: user.id,
      },
    });
    return this.toDto(row);
  }

  private async assertNotificationTypeValid(code: string): Promise<void> {
    const item = await this.prisma.dictItem.findFirst({
      where: notDeletedWhere({
        code,
        status: DictItemStatus.ACTIVE,
        type: { code: NOTIFICATION_TYPE_DICT_CODE, status: DictTypeStatus.ACTIVE, deletedAt: null },
      }),
      select: { id: true },
    });
    if (!item) {
      throw new BizException(BizCode.NOTIFICATION_TYPE_INVALID);
    }
  }

  private toDto(row: WechatSubscribeTemplate): WechatSubscribeTemplateDto {
    return {
      notificationTypeCode: row.notificationTypeCode,
      templateId: row.templateId,
      enabled: row.enabled,
      remarks: row.remarks,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { type Member, Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { WECHAT_SUBSCRIPTION_QUOTA_CAP } from './notification.constants';
import type {
  WechatSubscriptionAckResponseDto,
  WechatSubscriptionStatusResponseDto,
} from './notification.dto';

// 统一通知 S2:微信订阅 quota app 面(ack 上报授权 +1 封顶 / status 查额度供前端判补授权)。
//
// 入口仅全局 JwtAuthGuard;**不**挂 @Roles / RBAC;准入 = canUseApp(否则 403,镜像 notification-read)。
//
// **诚实非幂等标注(评审稿 §3.3)**:微信不给授权回执 ID,每次 wx.requestSubscribeMessage 用户接受 =
// 一次真实新授权(可累积)→ ack 本质 **additive、非去重幂等**;滥刷靠 D-N2 上限封顶(WECHAT_SUBSCRIPTION_QUOTA_CAP)
// + 前端只在真授权后上报缓解。**前端只拿授权 + 上报,绝不直接发消息**(发送权全在后端派发器)。
@Injectable()
export class NotificationSubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appIdentity: AppIdentityResolver,
  ) {}

  private async assertCanUseAppOrThrow(currentUser: CurrentUserPayload): Promise<Member> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return access.member;
  }

  // ===== ack:逐模板 quota +1(封顶 D-N2);返各模板新 availableCount =====
  async ack(
    currentUser: CurrentUserPayload,
    templateIds: string[],
  ): Promise<WechatSubscriptionAckResponseDto> {
    const member = await this.assertCanUseAppOrThrow(currentUser);
    // 去重(同请求重复 templateId 视为一次授权;additive 仍按唯一模板各 +1)
    const uniqueTemplateIds = [...new Set(templateIds)];
    const quotas = [];
    for (const templateId of uniqueTemplateIds) {
      const availableCount = await this.incrementCapped(member.id, templateId);
      quotas.push({ templateId, availableCount });
    }
    return { quotas };
  }

  // ===== status:逐模板返当前 availableCount(无行 = 0);供前端判断是否需补授权 =====
  async status(
    currentUser: CurrentUserPayload,
    templateIds: string[],
  ): Promise<WechatSubscriptionStatusResponseDto> {
    const member = await this.assertCanUseAppOrThrow(currentUser);
    const uniqueTemplateIds = [...new Set(templateIds)];
    const rows = await this.prisma.wechatSubscriptionQuota.findMany({
      where: { memberId: member.id, templateId: { in: uniqueTemplateIds } },
      select: { templateId: true, availableCount: true },
    });
    const byTemplate = new Map(rows.map((r) => [r.templateId, r.availableCount]));
    const quotas = uniqueTemplateIds.map((templateId) => ({
      templateId,
      availableCount: byTemplate.get(templateId) ?? 0,
    }));
    return { quotas };
  }

  // 并发安全封顶 +1:条件 increment(availableCount < cap)→ 0 行时首次 create count=1 /
  // P2002 竞争兜底再试条件 increment;杜绝超过 cap。返回 +1 后(或封顶后)的当前值。
  private async incrementCapped(memberId: string, templateId: string): Promise<number> {
    const bumped = await this.prisma.wechatSubscriptionQuota.updateMany({
      where: { memberId, templateId, availableCount: { lt: WECHAT_SUBSCRIPTION_QUOTA_CAP } },
      data: { availableCount: { increment: 1 } },
    });
    if (bumped.count === 0) {
      // 要么无行(首次 ack)→ create count=1;要么已达上限 → 下面读回即 cap(no-op)。
      try {
        await this.prisma.wechatSubscriptionQuota.create({
          data: { memberId, templateId, availableCount: 1 },
        });
      } catch (err) {
        // 并发首次 ack 竞争:另一请求刚 create → P2002;重试条件 increment(达上限则 no-op)。
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          await this.prisma.wechatSubscriptionQuota.updateMany({
            where: { memberId, templateId, availableCount: { lt: WECHAT_SUBSCRIPTION_QUOTA_CAP } },
            data: { availableCount: { increment: 1 } },
          });
        } else {
          throw err;
        }
      }
    }
    const row = await this.prisma.wechatSubscriptionQuota.findUnique({
      where: { memberId_templateId: { memberId, templateId } },
      select: { availableCount: true },
    });
    return row?.availableCount ?? 0;
  }
}

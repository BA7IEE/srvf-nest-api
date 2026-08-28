import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * 存量考勤账本化转换刀(P1-28 第 7 批② A 案,2026-08-27 拍板)的 D2 落点。
 *
 * `ActivityRegistration` 的属主是本模块 —— activities 侧跨域直写建头会被架构债棘轮
 * 判红(`check-boundaries --new-debt-check` 的 cross-owner-write;2026-08-28 转换刀
 * 实测,基线只减不增、无登记之门)。故由本服务导出「找或建历史转换头」的唯一入口,
 * 转换刀只调用、不碰本域 prisma 模型。
 *
 * 建头形状逐字镜像 `OnsiteParticipationCommandService` 的「无头才建新头」分支
 * (onsite 先例),仅两处刻意差异:sourceCode 取 'admin'(§3.6 闭集内;闭集没有
 * legacy 值,不自行扩 CHECK),registeredAt 取旧考勤单提交时间(回填沿用旧链历史值,
 * 不引入新时钟 —— 已登记 clock-authority 写点表)。
 */
@Injectable()
export class LegacyConversionRegistrationHeadService {
  /** 找现有头(任意状态;§3.6 同 member+activity 全局唯一)或建合成头。 */
  async ensureLegacyConversionHead(
    tx: Prisma.TransactionClient,
    args: { activityId: string; memberId: string; registeredAt: Date },
  ): Promise<{ id: string; synthesized: boolean }> {
    const existing = await tx.activityRegistration.findFirst({
      where: { activityId: args.activityId, memberId: args.memberId },
      select: { id: true },
    });
    if (existing !== null) return { id: existing.id, synthesized: false };
    const head = await tx.activityRegistration.create({
      data: {
        activityId: args.activityId,
        memberId: args.memberId,
        statusCode: 'pending',
        currentRevision: 0,
        currentFormVersionId: null,
        statusSummaryCode: 'active',
        sourceCode: 'admin',
        registeredAt: args.registeredAt,
      },
      select: { id: true },
    });
    return { id: head.id, synthesized: true };
  }
}

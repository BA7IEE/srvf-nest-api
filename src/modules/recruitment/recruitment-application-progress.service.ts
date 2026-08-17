import { Injectable } from '@nestjs/common';
import { DictItemStatus, type RecruitmentApplication } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import {} from '../realname/realname.constants';
import { WechatService } from '../wechat/wechat.service';
import { APP_INACTIVE_STATUS_CODES } from './recruitment.constants';
import {} from './recruitment-identity.service';
import { loadProgressClaims } from './recruitment-certificate-claim-progress';
import {
  RECRUITMENT_STAGE_DICT_TYPE,
  assembleRecruitmentProgress,
} from './recruitment-progress-presenter';
import {} from './recruitment-applications.presenter';
import type { RecruitmentApplicationProgressDto } from './recruitment.dto';

/*
 * 招新报名的**进度查询族**(Phase 6-B 第三域第四刀,D-7 QueryService)。
 *
 * 一个入口 query(wechatCode) + 三条按 openid 的锚点查找 + 阶段文案字典加载。
 * 三条查找的先后是**语义**不是优化:活跃单 → 终态单 → 已晋升单,
 * 前者命中即返回。调换顺序会让「刚提交又被驳回」的申请人看到错误的阶段。
 */
@Injectable()
export class RecruitmentApplicationProgressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wechat: WechatService,
  ) {}

  // ============ 公开查询(凭新 wx.login code → openid → 本人最近报名)============
  // 招新闭环优化 S1(评审稿 §4/§6):出参 enrich 为新人进度模型(业务态 stage + 字典文案 +
  // 门槛 todoList 真投影);statusCode 流转逻辑 / 状态机零改动,纯展示派生。
  // 招新可用性收口 F4-3b(评审稿 §2.3/E-U-5):promote 即清 openid 使旧查询「查无 28002」体验像
  // 报名消失 —— 现 miss 后 fall-through 经 live User.openid 反查 ACTIVE 队员,用其 promotedMemberId
  // 定位**真实报名行**(promoted 态;PII 已清但 statusCode/thresholdMarks/promotedMemberId 俱在)组装
  // 引导态(stage=volunteer「已转志愿者 / 待入队」,nextAction=apply-teamjoin,memberNo 恒 null)——
  // **零新增 PII 留存,零合成 DTO**;wx.login code 即微信身份自证,无枚举面。member 非 ACTIVE 或
  // 无报名行(非招新出身队员)→ 维持 28002。
  async query(wechatCode: string): Promise<RecruitmentApplicationProgressDto> {
    const { openid } = await this.wechat.code2session(wechatCode);
    let app =
      (await this.findLatestActiveAppByOpenidForProgress(openid)) ??
      (await this.findLatestTerminalAppByOpenidForProgress(openid));
    if (!app) {
      app = await this.findPromotedAppByOpenidAnchor(openid);
    }
    if (!app) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    const cycle = await this.prisma.recruitmentCycle.findFirstOrThrow({
      where: { id: app.cycleId },
    });
    const stageTextByCode = await this.loadStageTextMap();
    // PR-4a-2:证书段改由 Claim 行组装(一证一行);presenter 仍零 Prisma。
    const certificateClaims = await loadProgressClaims(this.prisma, app.id);
    return assembleRecruitmentProgress({ ...app, certificateClaims }, cycle, stageTextByCode);
  }

  private async findLatestActiveAppByOpenidForProgress(
    openid: string,
  ): Promise<RecruitmentApplication | null> {
    return this.prisma.recruitmentApplication.findFirst({
      where: {
        openid,
        deletedAt: null,
        statusCode: { notIn: [...APP_INACTIVE_STATUS_CODES] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findLatestTerminalAppByOpenidForProgress(
    openid: string,
  ): Promise<RecruitmentApplication | null> {
    return this.prisma.recruitmentApplication.findFirst({
      where: {
        openid,
        deletedAt: null,
        statusCode: { in: [...APP_INACTIVE_STATUS_CODES] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // F4-3b:openid 锚 → 已发号队员的 promoted 报名行(fall-through;E-U-5;镜像 identity service
  // 的手机锚版本,各模块级实现不抽共享 util)。live User.openid → Member ACTIVE 守卫 → promotedMemberId。
  private async findPromotedAppByOpenidAnchor(
    openid: string,
  ): Promise<RecruitmentApplication | null> {
    const user = await this.prisma.user.findFirst({
      where: { openid, deletedAt: null, memberId: { not: null } },
      select: { memberId: true },
    });
    if (!user?.memberId) return null;
    const member = await this.prisma.member.findFirst({
      where: { id: user.memberId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!member) return null;
    return this.prisma.recruitmentApplication.findFirst({
      where: { promotedMemberId: user.memberId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  // recruitment_stage 字典 → { stage code → stageText } map(§4.1「展示文案在字典」)。
  // 仅取 ACTIVE 项;字典缺项时 presenter 回退 stage 机器码(prod 由 seed 兜底齐全)。
  async loadStageTextMap(): Promise<ReadonlyMap<string, string>> {
    const items = await this.prisma.dictItem.findMany({
      where: {
        type: { code: RECRUITMENT_STAGE_DICT_TYPE, deletedAt: null },
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
      },
      select: { code: true, label: true },
    });
    return new Map(items.map((i) => [i.code, i.label]));
  }
}

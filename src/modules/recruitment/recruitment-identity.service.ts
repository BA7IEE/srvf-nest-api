import { Injectable, Logger } from '@nestjs/common';
import { DictItemStatus, Prisma, SmsPurpose, type RecruitmentApplication } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { SmsCodeService } from '../sms/sms-code.service';
import { maskPhone } from '../sms/sms.constants';
import { WechatService } from '../wechat/wechat.service';
import {
  CYCLE_STATUS_OPEN,
  PHONE_CHANGE_REASON_SELF_REBIND,
  PHONE_VERIFICATION_METHOD_SMS,
  RECRUITMENT_IDENTITY_SESSION_TTL_SECONDS,
  generatePhoneVerificationToken,
  hashPhoneVerificationToken,
} from './recruitment.constants';
import {
  RECRUITMENT_STAGE_DICT_TYPE,
  assembleRecruitmentProgress,
} from './recruitment-progress-presenter';
import type {
  RecruitmentApplicationProgressDto,
  RecruitmentRebindPhoneDto,
  RecruitmentRebindWechatDto,
  RecruitmentSendCodeResponseDto,
  RecruitmentVerifyCodeDto,
  RecruitmentVerifyCodeResponseDto,
} from './recruitment.dto';

// 招新四期 S4a(H5 + 手机身份链;2026-06-24;评审稿 recruitment-phase4-loop-optimization-review.md §3)。
//
// 报名前手机身份链 + 自助换绑的 service(无账号 pre-auth)。复用 src/modules/sms 基建
// (SmsPurpose.RECRUITMENT_BIND;userId 形参放宽 null,E-P4-4)+ wechat code2session。
// 报名前身份会话行(recruitment_identity_sessions)承载「验码 → 短时一次性 token → 提交」的有时间差身份链;
// **会话行不进 recruitment_applications、不参与去重/统计/容量**;token 入库只存 sha256(明文仅一次性返客户端)。
//
// 职责边界:本 service 不碰 OCR / 不发临时号 / 不改状态机 —— 报名落库与状态流转仍归
// RecruitmentApplicationsService.submit(本 service 只提供 token 校验/消费 + 自助换绑)。

const AUDIT_RESOURCE_TYPE = 'recruitment_application';

// token 消费返回的手机身份(submit 据此写 application 身份链落点字段)
export interface ConsumedPhoneIdentity {
  phone: string;
  phoneVerifiedAt: Date;
  phoneVerificationMethod: string;
  openid: string | null;
}

@Injectable()
export class RecruitmentIdentityService {
  private readonly logger = new Logger(RecruitmentIdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly smsCode: SmsCodeService,
    private readonly wechat: WechatService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ============ H5 发码(open/v1;无账号;SmsPurpose.RECRUITMENT_BIND,userId=null)============
  // 无 open 轮即 28030 快速失败(省发码);限流由 controller @RecruitmentThrottle + SmsCodeService
  // 自带手机维度 60s 间隔 / 10 条日限(跨 purpose 合计)双层兜底。
  async sendCode(phone: string, ip: string | null): Promise<RecruitmentSendCodeResponseDto> {
    await this.findOpenCycleIdOrThrow();
    return this.smsCode.issue({
      phone,
      purpose: SmsPurpose.RECRUITMENT_BIND,
      userId: null, // 匿名报名人无账号(E-P4-4)
      ip,
    });
  }

  // ============ H5 验码 → 发 token(验码成功落会话行 + 发短时一次性 token)============
  async verifyCode(
    dto: RecruitmentVerifyCodeDto,
    now: Date,
  ): Promise<RecruitmentVerifyCodeResponseDto> {
    const cycleId = await this.findOpenCycleIdOrThrow();
    // 验码失败统一 SMS_CODE_INVALID=24010(防枚举;匿名 userId=null,归属 null===null 放行)
    await this.smsCode.verifyAndConsume({
      phone: dto.phone,
      purpose: SmsPurpose.RECRUITMENT_BIND,
      code: dto.code,
      userId: null,
    });
    const rawToken = generatePhoneVerificationToken();
    const expiresAt = new Date(now.getTime() + RECRUITMENT_IDENTITY_SESSION_TTL_SECONDS * 1000);
    await this.prisma.recruitmentIdentitySession.create({
      data: {
        cycleId,
        phone: dto.phone,
        phoneVerifiedAt: now,
        phoneVerificationMethod: PHONE_VERIFICATION_METHOD_SMS,
        phoneVerificationTokenHash: hashPhoneVerificationToken(rawToken),
        expiresAt,
      },
    });
    // 明文 token 仅此一次性返客户端(永不入库 / 日志)
    return { phoneVerificationToken: rawToken, expiresAt };
  }

  // ============ token 校验(非消费;submit 付费 OCR / 落图前 fail-fast,镜像 SMS assertValid)============
  // 校验链:存在 → 未过期 → 未消费 → 轮次一致 → 手机与提交值一致(防「验 A 号 token 报 B 号」)。
  // 任一不符 → 28050(过期/无效/已用)或 40000(手机不一致);不消费,真正消费在 submit 事务内。
  async assertPhoneSessionValid(
    rawToken: string,
    cycleId: string,
    expectedPhone: string,
    now: Date,
  ): Promise<void> {
    const session = await this.prisma.recruitmentIdentitySession.findUnique({
      where: { phoneVerificationTokenHash: hashPhoneVerificationToken(rawToken) },
      select: { phone: true, cycleId: true, consumedAt: true, expiresAt: true },
    });
    if (
      session === null ||
      session.cycleId !== cycleId ||
      session.consumedAt !== null ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      throw new BizException(BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID);
    }
    if (session.phone !== expectedPhone) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
  }

  // ============ token 消费(事务内;submit 调用,原子单消费)============
  // 在 submit 的 $transaction 内调用:消费与建报名记录同事务,建记录失败回滚则 token 保活可重试。
  // 原子 updateMany(consumedAt:null → now)抢占:并发重放只一个赢家(镜像 SmsCodeService.verifyAndConsume)。
  async consumePhoneSession(
    tx: Prisma.TransactionClient,
    rawToken: string,
    cycleId: string,
    now: Date,
  ): Promise<ConsumedPhoneIdentity> {
    const session = await tx.recruitmentIdentitySession.findUnique({
      where: { phoneVerificationTokenHash: hashPhoneVerificationToken(rawToken) },
      select: {
        id: true,
        phone: true,
        cycleId: true,
        consumedAt: true,
        expiresAt: true,
        phoneVerifiedAt: true,
        phoneVerificationMethod: true,
        openid: true,
      },
    });
    if (
      session === null ||
      session.cycleId !== cycleId ||
      session.consumedAt !== null ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      throw new BizException(BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID);
    }
    const consumed = await tx.recruitmentIdentitySession.updateMany({
      where: { id: session.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumed.count === 0) {
      throw new BizException(BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID);
    }
    return {
      phone: session.phone,
      phoneVerifiedAt: session.phoneVerifiedAt,
      phoneVerificationMethod: session.phoneVerificationMethod,
      openid: session.openid,
    };
  }

  // ============ S4b OCR 六分流:读 / 写会话行重拍计数(Q-P4-1;承载于 S4a 预建列)============
  // token 已经过 submit 的 assertPhoneSessionValid 前置校验(存在/未过期/未消费/轮次/手机一致);
  // 此二法只读写计数列、**不消费 token**(延迟分支重拍循环不结束身份链)。无会话(小程序链)不调。

  // 读会话行 OCR 计数态(escalation/连续计数决策用;未找到返 null,防御)
  async readOcrAttemptState(
    rawToken: string,
  ): Promise<{ ocrAttemptCount: number; lastOcrOutcome: string | null } | null> {
    const session = await this.prisma.recruitmentIdentitySession.findUnique({
      where: { phoneVerificationTokenHash: hashPhoneVerificationToken(rawToken) },
      select: { ocrAttemptCount: true, lastOcrOutcome: true },
    });
    return session;
  }

  // 写会话行 OCR 计数(延迟分支;不消费 token;ocrAttemptCount 为调用方算好的连续计数)
  async writeOcrAttempt(
    rawToken: string,
    bump: { lastOcrOutcome: string; requiresRetake: boolean; ocrAttemptCount: number },
  ): Promise<void> {
    await this.prisma.recruitmentIdentitySession.updateMany({
      where: { phoneVerificationTokenHash: hashPhoneVerificationToken(rawToken), consumedAt: null },
      data: {
        lastOcrOutcome: bump.lastOcrOutcome,
        requiresRetake: bump.requiresRetake,
        ocrAttemptCount: bump.ocrAttemptCount,
      },
    });
  }

  // ============ 查询②:手机 + 验证码(查本人最近一条报名进度;Q-P4-6)============
  // 直验码(消费一码)→ 手机定位最近活跃报名 → 进度模型(与微信 code 查询同出参 / 同派生口径)。
  async queryByPhone(phone: string, code: string): Promise<RecruitmentApplicationProgressDto> {
    await this.smsCode.verifyAndConsume({
      phone,
      purpose: SmsPurpose.RECRUITMENT_BIND,
      code,
      userId: null,
    });
    const app = await this.findLatestAppByPhoneOrThrow(phone);
    return this.assembleProgressFor(app);
  }

  // ============ 自助换微信换绑(锚当前手机;§3.4)============
  // 校验本人 = 当前手机验码;定位最近活跃报名 → code2session 新微信 → 防绑他人报名 → 更 openid + 审计。
  async rebindWechat(
    dto: RecruitmentRebindWechatDto,
    meta: AuditMeta,
  ): Promise<RecruitmentApplicationProgressDto> {
    await this.smsCode.verifyAndConsume({
      phone: dto.phone,
      purpose: SmsPurpose.RECRUITMENT_BIND,
      code: dto.code,
      userId: null,
    });
    const app = await this.findLatestAppByPhoneOrThrow(dto.phone);
    const { openid: newOpenid } = await this.wechat.code2session(dto.newWechatCode);
    const oldOpenid = app.openid;
    const updated = await this.prisma.$transaction(async (tx) => {
      // 防换绑到他人:新 openid 已被本轮另一活跃报名占用 → 28051(否则查询串号)
      const conflict = await tx.recruitmentApplication.findFirst({
        where: { cycleId: app.cycleId, openid: newOpenid, deletedAt: null, id: { not: app.id } },
        select: { id: true },
      });
      if (conflict) {
        throw new BizException(BizCode.RECRUITMENT_WECHAT_ALREADY_BOUND);
      }
      const row = await tx.recruitmentApplication.update({
        where: { id: app.id },
        data: { openid: newOpenid },
      });
      await this.auditLogs.log({
        event: 'recruitment-application.rebind-wechat',
        actorUserId: null, // 无账号自助换绑
        actorRoleSnap: null,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: app.id,
        meta,
        before: { openid: this.maskOpenid(oldOpenid) },
        after: { openid: this.maskOpenid(newOpenid) },
        extra: { phone: maskPhone(dto.phone) },
        tx,
      });
      return row;
    });
    return this.assembleProgressFor(updated);
  }

  // ============ 自助换手机换绑(双验:当前手机 + 新手机;§3.4)============
  // 校验本人 = 当前手机验码;定位报名 → 新手机验码 → 更 phone + phoneChangedAt/Reason + 历史追加 + 审计。
  async rebindPhone(
    dto: RecruitmentRebindPhoneDto,
    meta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentApplicationProgressDto> {
    if (dto.newPhone === dto.phone) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    // ① 校验本人(当前手机);定位本人报名(无 → 28002,此时新手机码未消费)
    await this.smsCode.verifyAndConsume({
      phone: dto.phone,
      purpose: SmsPurpose.RECRUITMENT_BIND,
      code: dto.code,
      userId: null,
    });
    const app = await this.findLatestAppByPhoneOrThrow(dto.phone);
    // ② 校验新手机控制权
    await this.smsCode.verifyAndConsume({
      phone: dto.newPhone,
      purpose: SmsPurpose.RECRUITMENT_BIND,
      code: dto.newPhoneCode,
      userId: null,
    });
    const reason = dto.reason ?? PHONE_CHANGE_REASON_SELF_REBIND;
    const priorHistory = Array.isArray(app.phoneBindingHistory) ? app.phoneBindingHistory : [];
    const history = [
      ...priorHistory,
      {
        from: app.phone,
        to: dto.newPhone,
        at: now.toISOString(),
        reason,
        method: PHONE_VERIFICATION_METHOD_SMS,
      },
    ];
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.recruitmentApplication.update({
        where: { id: app.id },
        data: {
          phone: dto.newPhone,
          phoneChangedAt: now,
          phoneChangeReason: reason,
          phoneVerifiedAt: now,
          phoneVerificationMethod: PHONE_VERIFICATION_METHOD_SMS,
          phoneBindingHistory: history,
        },
      });
      await this.auditLogs.log({
        event: 'recruitment-application.rebind-phone',
        actorUserId: null,
        actorRoleSnap: null,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: app.id,
        meta,
        before: { phone: maskPhone(app.phone ?? '') },
        after: { phone: maskPhone(dto.newPhone) },
        extra: { method: PHONE_VERIFICATION_METHOD_SMS, reason },
        tx,
      });
      return row;
    });
    return this.assembleProgressFor(updated);
  }

  // === helpers ===

  // 当前唯一 open 轮 id(无 → 28030;沿 RecruitmentApplicationsService.findOpenCycleOrThrow 口径,不卡容量)
  private async findOpenCycleIdOrThrow(): Promise<string> {
    const cycle = await this.prisma.recruitmentCycle.findFirst({
      where: { statusCode: CYCLE_STATUS_OPEN, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!cycle) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_NOT_OPEN);
    }
    return cycle.id;
  }

  // 手机定位最近一条活跃报名(任轮,沿 query-by-wechat 不卡轮口径;phone 非去重键,取最近一条)
  private async findLatestAppByPhoneOrThrow(phone: string): Promise<RecruitmentApplication> {
    const app = await this.prisma.recruitmentApplication.findFirst({
      where: { phone, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!app) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    return app;
  }

  // 组装进度模型(复用 S1 presenter + stageText 字典;与 RecruitmentApplicationsService.query 同口径)
  private async assembleProgressFor(
    app: RecruitmentApplication,
  ): Promise<RecruitmentApplicationProgressDto> {
    const cycle = await this.prisma.recruitmentCycle.findFirstOrThrow({
      where: { id: app.cycleId },
    });
    const stageTextByCode = await this.loadStageTextMap();
    return assembleRecruitmentProgress(app, cycle, stageTextByCode);
  }

  // recruitment_stage 字典 → { stage → stageText } map(§4.1;仅 ACTIVE;缺项 presenter 回退机器码)
  private async loadStageTextMap(): Promise<ReadonlyMap<string, string>> {
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

  private maskOpenid(openid: string | null): string | null {
    if (openid === null) return null;
    return openid.length <= 8 ? '***' : `${openid.slice(0, 4)}****${openid.slice(-4)}`;
  }
}

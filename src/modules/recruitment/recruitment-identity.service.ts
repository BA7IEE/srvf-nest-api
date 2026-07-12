import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DictItemStatus, Prisma, SmsPurpose, type RecruitmentApplication } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { SmsCodeService } from '../sms/sms-code.service';
import { SMS_CODE_TTL_SECONDS, maskPhone } from '../sms/sms.constants';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import { WechatService } from '../wechat/wechat.service';
import {
  APP_INACTIVE_STATUS_CODES,
  APP_STATUS_PROMOTED,
  APP_STATUS_REJECTED,
  APP_STATUS_WITHDRAWN,
  CERTIFICATE_IMAGES_MAX_PER_CATEGORY,
  CERTIFICATE_IMAGE_KEY_PREFIX,
  CYCLE_STATUS_OPEN,
  ID_CARD_IMAGE_ALLOWED_MIME,
  ID_CARD_IMAGE_MAX_BYTES,
  PHONE_CHANGE_REASON_SELF_REBIND,
  PHONE_VERIFICATION_METHOD_SMS,
  RECRUITMENT_IDENTITY_SESSION_TTL_SECONDS,
  generatePhoneVerificationToken,
  hashPhoneVerificationToken,
} from './recruitment.constants';
import { recruitmentDuplicateExceptionForP2002 } from './recruitment-prisma-errors';
import {
  RECRUITMENT_STAGE_DICT_TYPE,
  assembleRecruitmentProgress,
} from './recruitment-progress-presenter';
import type {
  RecruitmentApplicationProgressDto,
  RecruitmentCertificateUploadDto,
  RecruitmentCertificateUploadResultDto,
  RecruitmentRebindPhoneDto,
  RecruitmentRebindWechatDto,
  RecruitmentSendCodeResponseDto,
  RecruitmentVerifyCodeDto,
  RecruitmentVerifyCodeResponseDto,
  RecruitmentWithdrawDto,
} from './recruitment.dto';
import type { UploadedImageFile } from './recruitment-applications.service';

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
    // F7 证书图上传落 storage(镜像 applications.service 注入范式)
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // ============ H5 发码(open/v1;无账号;SmsPurpose.RECRUITMENT_BIND,userId=null)============
  // 招新可用性收口 F4-3a(评审稿 §2.3/E-U-5):放行条件 = 存在开放轮 **或** 手机号命中未清除报名记录
  // (报名行 phone 仍在 = 未脱敏;闭轮后本人仍可走 查询②/rebind 自助链)。**防枚举沿 login-sms 范式**:
  // 闭轮期陌生手机返与有效路径同形状同值的泛化 200(不发码、不写 codes/send_logs、不调 provider、零留痕)。
  // 开放轮行为逐字不变(任意手机可发码 = 报名前身份链本义)。限流由 controller @RecruitmentThrottle +
  // SmsCodeService 自带手机维度 60s 间隔 / 10 条日限(跨 purpose 合计)双层兜底。
  async sendCode(phone: string, ip: string | null): Promise<RecruitmentSendCodeResponseDto> {
    const openCycleId = await this.findOpenCycleId();
    if (openCycleId === null) {
      const app = await this.findLatestAppByPhoneForProgress(phone);
      if (app === null) {
        // 防枚举泛化 200:不发码、不留痕;300 与 SmsCodeService.issue 成功路径同值(沿 login-sms)
        return { expiresInSeconds: SMS_CODE_TTL_SECONDS };
      }
    }
    return this.smsCode.issue({
      phone,
      purpose: SmsPurpose.RECRUITMENT_BIND,
      userId: null, // 匿名报名人无账号(E-P4-4)
      ip,
    });
  }

  // ============ H5 验码 → 发 token(验码成功落会话行 + 发短时一次性 token)============
  // F4-3a:轮次锚 = 开放轮 **或** 手机命中的未清除报名行所在轮(闭轮自助链恢复;该会话 token 只可能
  // 被 submit 消费,而 submit 自有开放轮闸 → 闭轮 token 天然不可用于报名,无越权面)。
  // 防枚举:闭轮 + 无命中 → 直抛 24010(与码错同形;沿 login-sms「先解析锚,null 即统一失败」范式)。
  async verifyCode(
    dto: RecruitmentVerifyCodeDto,
    now: Date,
  ): Promise<RecruitmentVerifyCodeResponseDto> {
    const cycleId =
      (await this.findOpenCycleId()) ??
      (await this.findLatestAppByPhoneForProgress(dto.phone))?.cycleId ??
      null;
    if (cycleId === null) {
      throw new BizException(BizCode.SMS_CODE_INVALID);
    }
    // 验码失败统一 SMS_CODE_INVALID=24010(防枚举;匿名 userId=null,归属 null===null 放行)
    await this.smsCode.verifyAndConsume({
      phone: dto.phone,
      purpose: SmsPurpose.RECRUITMENT_BIND,
      code: dto.code,
      userId: null,
    });
    // 十项收口刀C:顺手硬删本手机的过期会话行(明文手机 + OCR 轨迹属临时凭证,过期即无业务价值;
    // 镜像 SmsCodeService「发新作废旧」先例,不建 cron——全库过期行的兜底清理走留存 SOP
    // recruitment_identity_sessions 节)。放在验码成功后:仅真实机主触发,错码尝试不触库删。
    await this.prisma.recruitmentIdentitySession.deleteMany({
      where: { phone: dto.phone, expiresAt: { lt: now } },
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
  // 招新可用性收口 F4-3b(评审稿 §2.3/E-U-5):报名行 miss(promote 已清 phone)→ fall-through 经
  // live User.phone(H5 手机通道发号)∪ member_profiles.mobile(微信通道发号)反查 ACTIVE 队员 →
  // 用其 promotedMemberId 定位**真实报名行**(promoted 态,PII 已清但 stage 派生字段俱在)组装引导态
  // (stage=volunteer「已转志愿者 / 待入队」,memberNo 恒 null)——**零新增 PII 留存,零合成 DTO**。
  // 验码在前 = 已证手机控制权,无枚举面;member 非 ACTIVE 或无报名行 → 维持 28002。
  async queryByPhone(phone: string, code: string): Promise<RecruitmentApplicationProgressDto> {
    await this.smsCode.verifyAndConsume({
      phone,
      purpose: SmsPurpose.RECRUITMENT_BIND,
      code,
      userId: null,
    });
    const app = await this.findLatestAppByPhoneForProgress(phone);
    if (app) {
      return this.assembleProgressFor(app);
    }
    const promotedApp = await this.findPromotedAppByPhoneAnchor(phone);
    if (!promotedApp) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    return this.assembleProgressFor(promotedApp);
  }

  // ============ 招新可用性收口 F6:自助撤销(评审稿 §3 R4)============
  // 凭证双通道镜像 query / query-by-phone:通道① wechatCode(code2session → openid 定位)/
  // 通道② phone+code(验码消费一码 → 手机定位);双通道二选一(both/neither → 40000)。
  // 非终态(promoted/rejected/withdrawn 之外)皆可撤 → statusCode='withdrawn'(终态;非淘汰,
  // 不写 eliminationStage);终态命中(含幂等重撤)→ 28052。撤销后同轮同证件号/同 openid/同手机
  // 可重报(APP_INACTIVE_STATUS_CODES + partial unique 排除集已含 withdrawn)。必落 audit。
  async withdraw(
    dto: RecruitmentWithdrawDto,
    meta: AuditMeta,
  ): Promise<RecruitmentApplicationProgressDto> {
    const viaWechat = typeof dto.wechatCode === 'string' && dto.wechatCode.length > 0;
    const viaPhone = typeof dto.phone === 'string' && dto.phone.length > 0;
    if (viaWechat === viaPhone) {
      // 双通道二选一(both / neither 均拒)
      throw new BizException(BizCode.BAD_REQUEST);
    }
    let app: RecruitmentApplication | null;
    let channel: 'wechat' | 'phone';
    if (viaWechat) {
      channel = 'wechat';
      const { openid } = await this.wechat.code2session(dto.wechatCode as string);
      app = await this.findLatestActiveAppByOpenid(openid);
      if (!app) {
        const terminal = await this.findLatestTerminalAppByOpenid(openid);
        if (terminal) {
          throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_WITHDRAWABLE);
        }
      }
    } else {
      channel = 'phone';
      if (typeof dto.code !== 'string' || dto.code.length === 0) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
      await this.smsCode.verifyAndConsume({
        phone: dto.phone as string,
        purpose: SmsPurpose.RECRUITMENT_BIND,
        code: dto.code,
        userId: null,
      });
      app = await this.findLatestActiveAppByPhone(dto.phone as string);
      if (!app) {
        const terminal = await this.findLatestTerminalAppByPhone(dto.phone as string);
        if (terminal) {
          throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_WITHDRAWABLE);
        }
      }
    }
    if (!app) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    if (
      app.statusCode === APP_STATUS_PROMOTED ||
      app.statusCode === APP_STATUS_REJECTED ||
      app.statusCode === APP_STATUS_WITHDRAWN
    ) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_WITHDRAWABLE);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.recruitmentApplication.update({
        where: { id: app.id },
        data: { statusCode: APP_STATUS_WITHDRAWN },
      });
      await this.auditLogs.log({
        event: 'recruitment-application.withdraw',
        actorUserId: null, // 无账号自助撤销
        actorRoleSnap: null,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: app.id,
        meta,
        before: { statusCode: app.statusCode },
        after: { statusCode: APP_STATUS_WITHDRAWN },
        extra: {
          channel,
          ...(channel === 'phone' ? { phone: maskPhone(dto.phone as string) } : {}),
          ...(channel === 'wechat' && app.openid ? { openid: this.maskOpenid(app.openid) } : {}),
        },
        tx,
      });
      return row;
    });
    return this.assembleProgressFor(updated);
  }

  // ============ 招新可用性收口 F7:证书图上传(评审稿 §2.9 R6)============
  // 凭证双通道二选一(镜像 F6 withdraw);category ∈ cert_type 既有码(DTO @IsIn);每类 ≤3 张
  // **重传整类覆盖**(替换语义,免增量删除口;旧 blob best-effort 删不留孤儿);单图校验镜像
  // idCardImage(jpeg/png ≤5MB)。存 recruitment_applications.certificateImages Json
  // ({ [category]: string[] } 暂存位);promote 建 pending Certificate 搬 imageKeys(R6)。
  // 终态行(promoted/rejected/withdrawn)不可传 → 28041。审核动作仍 = 既有标门槛,不新建审核流。
  async uploadCertificateImages(
    dto: RecruitmentCertificateUploadDto,
    files: UploadedImageFile[],
    meta: AuditMeta,
  ): Promise<RecruitmentCertificateUploadResultDto> {
    const viaWechat = typeof dto.wechatCode === 'string' && dto.wechatCode.length > 0;
    const viaPhone = typeof dto.phone === 'string' && dto.phone.length > 0;
    if (viaWechat === viaPhone) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    if (files.length === 0 || files.length > CERTIFICATE_IMAGES_MAX_PER_CATEGORY) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    for (const f of files) {
      if (f.size > ID_CARD_IMAGE_MAX_BYTES || !ID_CARD_IMAGE_ALLOWED_MIME.includes(f.mimetype)) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
    }
    let app: RecruitmentApplication | null;
    let channel: 'wechat' | 'phone';
    if (viaWechat) {
      channel = 'wechat';
      const { openid } = await this.wechat.code2session(dto.wechatCode as string);
      app = await this.findLatestActiveAppByOpenid(openid);
    } else {
      channel = 'phone';
      if (typeof dto.code !== 'string' || dto.code.length === 0) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
      await this.smsCode.verifyAndConsume({
        phone: dto.phone as string,
        purpose: SmsPurpose.RECRUITMENT_BIND,
        code: dto.code,
        userId: null,
      });
      app = await this.findLatestActiveAppByPhone(dto.phone as string);
    }
    if (!app) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    if (
      app.statusCode === APP_STATUS_PROMOTED ||
      app.statusCode === APP_STATUS_REJECTED ||
      app.statusCode === APP_STATUS_WITHDRAWN
    ) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
    }

    // 落图(失败域:任一 putObject 失败 → best-effort 删本批已落新 key,不动旧图;镜像 FM-B)
    const newKeys: string[] = [];
    try {
      for (const f of files) {
        const ext = f.mimetype === 'image/png' ? 'png' : 'jpg';
        const key = `${CERTIFICATE_IMAGE_KEY_PREFIX}/${dto.category}/${app.cycleId}/${randomUUID()}.${ext}`;
        await this.storage.putObject({ key, body: f.buffer, contentType: f.mimetype });
        newKeys.push(key);
      }
    } catch (err) {
      for (const k of newKeys) {
        await this.safeDeleteBlob(k);
      }
      throw err;
    }

    const existing = (app.certificateImages as Record<string, string[]> | null) ?? {};
    const existingReviews = (app.certificateReviewStatus as Record<string, unknown> | null) ?? {};
    const nextReviews = { ...existingReviews };
    delete nextReviews[dto.category];
    const oldKeys = Array.isArray(existing[dto.category]) ? existing[dto.category] : [];
    const nextImages: Record<string, string[]> = { ...existing, [dto.category]: newKeys };

    await this.prisma.$transaction(async (tx) => {
      await tx.recruitmentApplication.update({
        where: { id: app.id },
        data: {
          certificateImages: nextImages,
          certificateReviewStatus:
            Object.keys(nextReviews).length > 0
              ? (nextReviews as Prisma.InputJsonValue)
              : Prisma.DbNull,
        },
      });
      await this.auditLogs.log({
        event: 'recruitment-application.certificate-upload',
        actorUserId: null, // 无账号自助上传
        actorRoleSnap: null,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: app.id,
        meta,
        extra: {
          channel,
          category: dto.category,
          imageCount: newKeys.length,
          replacedCount: oldKeys.length,
          ...(channel === 'phone' ? { phone: maskPhone(dto.phone as string) } : {}),
        },
        tx,
      });
    });

    // 重传覆盖:旧 blob best-effort 删(库行已指向新 key;删失败仅告警,不影响本次结果)
    for (const k of oldKeys) {
      await this.safeDeleteBlob(k);
    }
    return { category: dto.category, imageCount: newKeys.length };
  }

  // 证书图 blob best-effort 删(重传覆盖旧图 / 落图失败补偿;失败仅告警不外抛,镜像 safeDeleteOrphanImage)
  private async safeDeleteBlob(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (e) {
      this.logger.warn(
        `recruitment certificate image cleanup failed key=${key}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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
    const app = await this.findLatestActiveAppByPhoneOrThrow(dto.phone);
    const { openid: newOpenid } = await this.wechat.code2session(dto.newWechatCode);
    const oldOpenid = app.openid;
    const updated = await this.prisma.$transaction(async (tx) => {
      // 防换绑到他人:新 openid 已被本轮另一活跃报名占用 → 28051(否则查询串号)
      const conflict = await tx.recruitmentApplication.findFirst({
        where: {
          cycleId: app.cycleId,
          openid: newOpenid,
          deletedAt: null,
          statusCode: { notIn: [...APP_INACTIVE_STATUS_CODES] },
          id: { not: app.id },
        },
        select: { id: true },
      });
      if (conflict) {
        throw new BizException(BizCode.RECRUITMENT_WECHAT_ALREADY_BOUND);
      }
      let row: RecruitmentApplication;
      try {
        row = await tx.recruitmentApplication.update({
          where: { id: app.id },
          data: { openid: newOpenid },
        });
      } catch (err) {
        const duplicate = recruitmentDuplicateExceptionForP2002(err);
        if (duplicate) throw duplicate;
        throw err;
      }
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
    const app = await this.findLatestActiveAppByPhoneOrThrow(dto.phone);
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
      const conflict = await tx.recruitmentApplication.findFirst({
        where: {
          cycleId: app.cycleId,
          phone: dto.newPhone,
          deletedAt: null,
          statusCode: { notIn: [...APP_INACTIVE_STATUS_CODES] },
          id: { not: app.id },
        },
        select: { id: true },
      });
      if (conflict) {
        throw new BizException(BizCode.RECRUITMENT_DUPLICATE_PHONE_ACTIVE);
      }
      let row: RecruitmentApplication;
      try {
        row = await tx.recruitmentApplication.update({
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
      } catch (err) {
        const duplicate = recruitmentDuplicateExceptionForP2002(err);
        if (duplicate) throw duplicate;
        throw err;
      }
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

  // 当前唯一 open 轮 id(可空;F4-3a 闭轮放行判定用;沿 findOpenCycleOrThrow 查询口径,不卡容量)
  private async findOpenCycleId(): Promise<string | null> {
    const cycle = await this.prisma.recruitmentCycle.findFirst({
      where: { statusCode: CYCLE_STATUS_OPEN, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return cycle?.id ?? null;
  }

  // 写动作口径:手机只锚最近活跃报名(rejected/withdrawn 终态永不被更新)。
  private async findLatestActiveAppByPhone(phone: string): Promise<RecruitmentApplication | null> {
    return this.prisma.recruitmentApplication.findFirst({
      where: {
        phone,
        deletedAt: null,
        statusCode: { notIn: [...APP_INACTIVE_STATUS_CODES] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findLatestTerminalAppByPhone(
    phone: string,
  ): Promise<RecruitmentApplication | null> {
    return this.prisma.recruitmentApplication.findFirst({
      where: {
        phone,
        deletedAt: null,
        statusCode: { in: [...APP_INACTIVE_STATUS_CODES] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // 查进度口径:活跃优先；没有活跃行才回落最近 rejected/withdrawn 终态行。
  private async findLatestAppByPhoneForProgress(
    phone: string,
  ): Promise<RecruitmentApplication | null> {
    return (
      (await this.findLatestActiveAppByPhone(phone)) ?? this.findLatestTerminalAppByPhone(phone)
    );
  }

  private async findLatestActiveAppByPhoneOrThrow(phone: string): Promise<RecruitmentApplication> {
    const app = await this.findLatestActiveAppByPhone(phone);
    if (!app) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    return app;
  }

  private async findLatestActiveAppByOpenid(
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

  private async findLatestTerminalAppByOpenid(
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

  // F4-3b:手机锚 → 已发号队员的 promoted 报名行(fall-through;E-U-5)。
  // 锚点两路并查:① live User.phone(H5 手机通道发号建的 SMS 登录 User);② member_profiles.mobile
  // (微信通道发号的 User 无 phone,报名手机搬进了档案)。命中后守 Member ACTIVE(非 ACTIVE →
  // null,维持 28002 不泄离队者状态),再以 promotedMemberId 取最近一条真实报名行。
  private async findPromotedAppByPhoneAnchor(
    phone: string,
  ): Promise<RecruitmentApplication | null> {
    const user = await this.prisma.user.findFirst({
      where: { phone, deletedAt: null, memberId: { not: null } },
      select: { memberId: true },
    });
    let memberId = user?.memberId ?? null;
    if (memberId === null) {
      const profile = await this.prisma.memberProfile.findFirst({
        where: { mobile: phone, deletedAt: null },
        select: { memberId: true },
      });
      memberId = profile?.memberId ?? null;
    }
    if (memberId === null) return null;
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!member) return null;
    return this.prisma.recruitmentApplication.findFirst({
      where: { promotedMemberId: memberId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
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

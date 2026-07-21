import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { OrganizationStatus, Prisma, type RecruitmentApplication } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { normalizeDateOnly } from '../../common/datetime/date-only.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { assertEmergencyRelationCodeValid } from '../emergency-contacts/emergency-relation.validation';
import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_WECHAT,
  NOTIFICATION_TYPE_RECRUITMENT,
  OUTBOX_EVENT_TARGETED_NOTIFICATION,
  OUTBOX_PAYLOAD_VERSION,
} from '../notifications/notification.constants';
import { NotificationOutboxService } from '../notifications/notification-outbox.service';
import { RbacService } from '../permissions/rbac.service';
import { maskPhone } from '../sms/sms.constants';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import {
  APP_STATUS_PROMOTED,
  APP_STATUS_PUBLICITY,
  MEMBER_NO_MAX_SEQ,
  RECRUITMENT_MAX_AGE,
  RECRUITMENT_MIN_AGE,
  comparePromotionOrder,
  computeAge,
  decidePromotionIssuance,
  formatMemberNo,
  toMemberProfileDocumentTypeCode,
} from './recruitment.constants';
import {
  certificateIssuanceForCategory,
  certificateReviewForCategory,
} from './recruitment-certificate-json';
import type {
  PromoteResultDto,
  PromoteSkippedItemDto,
  PromoteSingleResultDto,
  PromotePrecheckResultDto,
  PromotePrecheckRowDto,
  PromotedItemDto,
} from './recruitment.dto';

// 招新二期(后段)T3:一键发号(评审稿 D-R2-5/6 + E-R2-6/7 + §4 流程冻结)。
// 公示结束 → 对 cycle 内全部 publicity 报名按姓名拼音序批量发永久编号 {YY}{NNN}
// → 建 User + Member(+VOL 归口部门)+ member_profiles + emergency_contacts → 标 promoted + promotedMemberId + 清敏感。
//
// 铁律:
// - 单一事务(全或无、号段连续无空洞、无半建态;吸取 phase-1 FM-A);
// - 幂等(promoted 已离开 publicity,重跑命中 0 / promotedMemberId 置则不会重入 + @unique 兜底;不双建 VOL 部门);
// - 失败可恢复(事务任一步失败 → 整批回滚、seq 复位,admin 修后重跑);
// - 资料或登录锚不齐的不可发号项 = 事务前分区 skip + report(不 block、不静默丢);
// - 志愿者身份(招新闭环优化 S5;评审稿 §5.2a,推翻 phase-3 E-J-6「双表示」取舍):建的 Member 即赋
//   gradeCode='volunteer' + **同事务建 VOL 归口部门**(Organization.code='VOL',≠ VOD 志愿者组织部);
//   入队(team-join 一键入队)才软删 VOL 行、换目标部门并升 level-1。VOL 缺失/非 ACTIVE → 建任何 member 前清晰失败;
// - 不复用 members/users service(直连 prisma,防环 + 零行为漂移;E-R2-14)。

const BCRYPT_SALT_ROUNDS = 10; // 与 users.service / password-reset.service 同值(各模块级声明)
// 显式事务超时(超时硬化):bcrypt 已移出事务,回调内仅快速 DB 写;按最大公示批量(~数十人,
// 每人 ~7 次写)留充足余量取 60s,远超 Prisma 默认 5s,杜绝大批量发号被事务超时整批顶死回滚。
export const PROMOTE_TX_TIMEOUT_MS = 60_000;
const AUDIT_RESOURCE_TYPE = 'recruitment_application';
const JOIN_SOURCE_RECRUITMENT = 'recruitment'; // member_profiles.joinSourceCode(候选字典码,promote 直写)
// 招新闭环优化 S5(评审稿 §5.2a):promote 出的志愿者身份。字面镜像 seed 稳定契约
//(member_grade 'volunteer' 项 + Organization.code='VOL' ≠ VOD 志愿者组织部),不 import team-join(保持自洽)。
const VOLUNTEER_GRADE_CODE = 'volunteer';
const VOL_ORG_CODE = 'VOL';
// 招新可用性收口 F7(评审稿 §2.9 R6):promote 为已上传证书图的类别自动建 Certificate。
// 字面镜像 certificates.service 的建行契约;仅上传未审的类别建 pending 走既有 verify/reject 核验;
// 存量报名没有 certificateIssuanceInfo 时才回退以下占位；新上传按申请人填写真值搬运。
// 证书审核只审一次(2026-07-14):招新阶段已 approved 的类别在此继承审核结论建为 verified(见建行块)。
const CERT_STATUS_PENDING = 'pending';
const CERT_STATUS_VERIFIED = 'verified';
const RECRUITMENT_CERT_ISSUING_ORG = '申请人自报(招新上传,待核验)';

interface EmergencyContactJson {
  name: string;
  relation: string;
  phone: string;
}

@Injectable()
export class RecruitmentPromotionService {
  private readonly logger = new Logger(RecruitmentPromotionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    // Durable outbox producer: intent 与发号业务写共用同一 PostgreSQL transaction。
    private readonly notificationOutbox: NotificationOutboxService,
    // 主体裁剪图 blob 无档案落点；发号前经当前 provider fail-closed 删除。
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  async promote(
    cycleId: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<PromoteResultDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.promote.member');

    const cycle = await this.prisma.recruitmentCycle.findFirst({
      where: { id: cycleId, deletedAt: null },
    });
    if (!cycle) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_NOT_FOUND);
    }

    // 公示集
    const apps = await this.prisma.recruitmentApplication.findMany({
      where: { cycleId, statusCode: APP_STATUS_PUBLICITY, deletedAt: null },
    });

    // F16(#399):openid 占用一次性批量查(取代逐行 findFirst,N 顺序往返 → 1;行为/原子性零变)。
    // v0.40.0 H5 手机通道:同批查 phone 占用(仅无 openid 的 app;镜像 openid,占用者 skip 不 block)。
    const boundOpenids = await this.loadBoundOpenids(apps);
    const boundPhones = await this.loadBoundPhones(apps);

    // 事务前分区(纯查询):先按发号序排,再用与公示预览共享的 decidePromotionIssuance 判定 —— 结构性
    // 保证「公示拟发号 = 实发」(#399 F9)、批内同 openid/phone 仅首行发号余项 skip(#399 F15,免第二行入
    // 事务撞 User.openid/phone @unique 整批回滚)。skip 项 report 不 block(缺字段/openid·phone 占用)。
    const sortedApps = [...apps].sort(comparePromotionOrder);
    const promotable: RecruitmentApplication[] = [];
    const skipped: PromoteSkippedItemDto[] = [];
    for (const d of decidePromotionIssuance(sortedApps, boundOpenids, boundPhones)) {
      if (d.willIssue) {
        promotable.push(d.app);
      } else {
        skipped.push({
          applicationId: d.app.id,
          realName: d.app.realName,
          reason: d.reason as string,
        });
      }
    }

    // 超时硬化:bcrypt(rounds=10,~80ms/个,CPU 密集)预算在**事务之外**完成。
    // 口令为随机高熵、与编号/事务无关,故可在事务前并发预算 n 个哈希,事务回调内逐个取用,
    // 杜绝串行 bcrypt 撑爆事务超时(大批量公示 → 整批回滚发不出号)。原子性模型一字不变。
    const passwordHashes = await Promise.all(
      promotable.map(() => bcrypt.hash(randomBytes(48).toString('base64'), BCRYPT_SALT_ROUNDS)),
    );

    // VOL 归口部门(招新闭环优化 S5;§5.2a):promote 即赋志愿者身份须挂 VOL 部门。运行时按
    // Organization.code='VOL' 解析(≠ VOD)、守 ACTIVE;缺失/非 ACTIVE → 在建任何 member 之前清晰失败
    //(不留半成品 member,沿「失败可恢复」)。仅有可发号项时才要求 VOL 存在(空公示批不触发)。
    const volOrgId = promotable.length > 0 ? await this.resolveVolOrgIdOrThrow() : null;

    // 主体框裁剪图没有建档落点：全部读/排序/skip 分区、bcrypt 与 VOL 校验成功后，紧贴业务
    // transaction 前按已冻结发号序逐条删除。只处理 promotable，不碰 skip 行或头像裁剪图；任一
    // provider 删除失败统一抛安全 500，transaction 根本不进入，杜绝任何业务/audit/outbox 写。
    // 已成功删除后若 transaction 失败，报名行 key 会暂指向不存在对象；修复 DB 阻断后重试依赖
    // provider 的 absent-delete 幂等契约，不恢复 blob、不引入 ledger。
    for (const a of promotable) {
      await this.deleteCropBlobBeforeTransactionOrThrow(a.idCardCropImageKey);
    }

    // 单一事务:发号 + 建 User/Member(+VOL 部门)/profile/contacts + 标 promoted + 清敏感(全或无)
    const promoted = await this.prisma.$transaction(
      async (tx) => {
        const n = promotable.length;
        if (n === 0) return [] as PromotedItemDto[];
        // volOrgId 在 promotable>0 时已解析守 ACTIVE;此处必非 null,防御性兜底兼为 TS 收窄。
        if (volOrgId === null) {
          throw new BizException(BizCode.RECRUITMENT_VOLUNTEER_ORG_UNAVAILABLE);
        }

        // cycle 行锁 + 原子自增 N(并发批次串行;失败回滚撤销自增,号段无空洞)
        const bumped = await tx.recruitmentCycle.update({
          where: { id: cycleId },
          data: { memberNoSeq: { increment: n } },
          select: { memberNoSeq: true, year: true },
        });
        if (bumped.memberNoSeq > MEMBER_NO_MAX_SEQ) {
          throw new BizException(BizCode.RECRUITMENT_MEMBER_NO_EXHAUSTED);
        }
        const startSeq = bumped.memberNoSeq - n; // 自增前基值

        const out: PromotedItemDto[] = [];
        for (let i = 0; i < n; i++) {
          const a = promotable[i];
          const memberNo = formatMemberNo(bumped.year, startSeq + i + 1);
          try {
            // 单行建档内核抽取(招新可用性收口 F3):批量与单人手动建档共用同一份建档语义
            // (Member+VOL 归口+User+档案+紧急联系人+标 promoted 清敏感+audit)。批量通道派生
            // 逐字保持 v0.40.0 语义:有 openid → 微信通道;无 openid(decidePromotionIssuance
            // 已保证 phone 非空)→ 手机通道。try/catch 位置不变 = 整批回滚语义不变(行为锁)。
            const item = await this.buildOnePromotion(
              tx,
              a,
              memberNo,
              passwordHashes[i],
              volOrgId,
              a.openid != null ? 'wechat' : 'phone',
              user,
              meta,
              now,
            );
            await this.enqueuePromotionNotification(tx, a.id, item);
            out.push(item);
          } catch (err) {
            // memberNo / openid / username @unique 冲突(撞既有号 or 并发竞态)→ 整批回滚不跳号(28042)
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_PROMOTABLE);
            }
            throw err;
          }
        }
        return out;
      },
      { timeout: PROMOTE_TX_TIMEOUT_MS },
    );

    this.logger.log(
      `recruitment promote cycle=${cycleId} promoted=${promoted.length} skipped=${skipped.length}`,
    );

    return {
      cycleId,
      promotedCount: promoted.length,
      skippedCount: skipped.length,
      promoted,
      skipped,
    };
  }

  // 稳定事件身份绑定 recruitment application：重试或重复请求只能得到同一 intent。
  // payload 仅含收件 memberId 与已冻结模板数据；enqueue 内部复用中心 sanitizer / exact parser。
  private async enqueuePromotionNotification(
    tx: Prisma.TransactionClient,
    applicationId: string,
    item: PromotedItemDto,
  ): Promise<void> {
    await this.notificationOutbox.enqueue(
      {
        eventKey: `recruitment-promotion:${applicationId}`,
        eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
        payloadVersion: OUTBOX_PAYLOAD_VERSION,
        payload: {
          recipientMemberId: item.memberId,
          notificationTypeCode: NOTIFICATION_TYPE_RECRUITMENT,
          title: '已发放永久编号',
          body: `您已转为志愿者,永久编号 ${item.memberNo}。请进入小程序「申请入队」完成入队。`,
          channels: [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECHAT],
        },
        aggregateType: 'recruitment_application',
        aggregateId: applicationId,
        destinationType: 'member',
        destinationRef: item.memberId,
      },
      tx,
    );
  }

  // 招新闭环优化 S6(评审稿 §8.2):一键发号前预检 —— **纯读**,不写、不改 promote 结论。
  // 结构性保证「预检 = 实发」:逐字复用 promote 的事务前分区(同 loadBoundOpenids + comparePromotionOrder
  // + decidePromotionIssuance),输出每行可发/跳过 + 跳过原因(§8.2 六类)+ 重复 openid 高亮 +
  // 缺手机/生日/性别 + 特殊证件标识 + 汇总。RBAC 复用 promote.member(与实发同 audience)。
  async promotePrecheck(
    cycleId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<PromotePrecheckResultDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.promote.member');

    const cycle = await this.prisma.recruitmentCycle.findFirst({
      where: { id: cycleId, deletedAt: null },
    });
    if (!cycle) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_NOT_FOUND);
    }

    // 公示集 + openid 占用集 + 拼音序:与 promote 事务前分区一字不差(同源保证预检=实发)。
    const apps = await this.prisma.recruitmentApplication.findMany({
      where: { cycleId, statusCode: APP_STATUS_PUBLICITY, deletedAt: null },
    });
    const boundOpenids = await this.loadBoundOpenids(apps);
    const boundPhones = await this.loadBoundPhones(apps);
    const sortedApps = [...apps].sort(comparePromotionOrder);

    // 「openid / phone 批内重复」高亮:出现 ≥2 行的非空值(展示辅助,不改发号判定)。
    // phone 仅统计无 openid 的行(手机通道;有 openid 者走微信通道 phone 不参与)。
    const openidCounts = new Map<string, number>();
    const phoneCounts = new Map<string, number>();
    for (const a of sortedApps) {
      if (a.openid != null) openidCounts.set(a.openid, (openidCounts.get(a.openid) ?? 0) + 1);
      else if (a.phone != null) phoneCounts.set(a.phone, (phoneCounts.get(a.phone) ?? 0) + 1);
    }

    // 拟发编号推算与 publicityList 同口径(willIssue 行依序占号)。
    let seq = cycle.memberNoSeq;
    const rows: PromotePrecheckRowDto[] = decidePromotionIssuance(
      sortedApps,
      boundOpenids,
      boundPhones,
    ).map(({ app, willIssue, reason }) => {
      let proposedMemberNo: string | null = null;
      if (willIssue) {
        seq += 1;
        proposedMemberNo = seq <= MEMBER_NO_MAX_SEQ ? formatMemberNo(cycle.year, seq) : null;
      }
      const usesPhoneChannel = app.openid == null && app.phone != null;
      return {
        applicationId: app.id,
        realName: app.realName,
        willIssue,
        skipReason: reason,
        proposedMemberNo,
        isNonMainlandDocument: app.isForeigner,
        documentTypeCode: app.documentTypeCode,
        missingOpenid: app.openid == null,
        openidAlreadyBound: app.openid != null && boundOpenids.has(app.openid),
        duplicateOpenidInBatch: app.openid != null && (openidCounts.get(app.openid) ?? 0) > 1,
        // v0.40.0 H5 手机通道:仅无 openid 走手机通道的行才有 phone 占用/去重语义。
        phoneAlreadyBound: usesPhoneChannel && boundPhones.has(app.phone as string),
        duplicatePhoneInBatch: usesPhoneChannel && (phoneCounts.get(app.phone as string) ?? 0) > 1,
        missingPhone: app.phone == null,
        missingBirthDate: app.birthDate == null,
        missingGender: app.genderCode == null,
      };
    });

    const promotableCount = rows.filter((r) => r.willIssue).length;
    const skipCount = rows.length - promotableCount;
    await this.auditLogs.log({
      event: 'recruitment-application.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'recruitment_cycle',
      resourceId: cycle.id,
      meta: auditMeta,
      extra: { operation: 'promotion-precheck', count: rows.length },
    });

    return {
      cycleId: cycle.id,
      cycleYear: cycle.year,
      rows,
      promotableCount,
      skipCount,
      total: rows.length,
    };
  }

  // ============ 招新可用性收口 F3:单人手动建档(评审稿 §3 R3 / §6.1 E-U-3/E-U-4)============
  // 批量 promote 的 skip 项(资料不齐/锚点占用等)的收尾通道:对单条 publicity 报名走与批量**同一份**
  // 建档内核(buildOnePromotion)+ 同一原子号段(memberNoSeq 行级自增,连续无空洞)+ 同一通知派发。
  // 差异仅三点:① **放行非大陆证件**(birthDate/genderCode 由 F2 补录);② **锚点择优**
  // (E-U-4:openid 未占用 → 微信;openid 缺/占用且 phone 未占用 → 手机;双缺/双占 → 28046,R3
  // 「不建无登录锚点的号」);③ 逐条判可建(缺 realName/birthDate/genderCode → 28047 提示先 F2 补录)。
  // 幂等:promoted 已离开 publicity → 重跑 28041、零重复建档(E-U-3);单发通道行为保持不变。
  async promoteSingle(
    applicationId: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<PromoteSingleResultDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.promote.single');

    const app = await this.prisma.recruitmentApplication.findFirst({
      where: { id: applicationId, deletedAt: null },
    });
    if (!app) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    const cycle = await this.prisma.recruitmentCycle.findFirst({
      where: { id: app.cycleId, deletedAt: null },
      select: { id: true },
    });
    if (!cycle) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_NOT_FOUND);
    }
    // 仅 publicity 可建(与批量同源目标态);promoted 重跑亦落此闸 = 幂等零重复(E-U-3)
    if (app.statusCode !== APP_STATUS_PUBLICITY) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
    }
    // 建档资料齐备闸(放行非大陆证件;缺派生字段/姓名 → 先走 F2 admin 改资料补录)
    if (app.realName == null || app.birthDate == null || app.genderCode == null) {
      throw new BizException(BizCode.RECRUITMENT_PROFILE_INCOMPLETE_FOR_PROMOTE);
    }
    // 十项收口刀A:发号前年龄闸(18-60,发号日复检)——非大陆证件此前从提交到建档全程零年龄校验
    // (submit 年龄闸包在大陆分支;F2 补录本刀同步加闸,此处兜底两通道)。大陆行提交期已校,
    // 此处为同口径复检(极端跨年发号超龄一并拒)。
    const age = computeAge(app.birthDate, now);
    if (age < RECRUITMENT_MIN_AGE || age > RECRUITMENT_MAX_AGE) {
      throw new BizException(BizCode.RECRUITMENT_AGE_OUT_OF_RANGE);
    }
    // 锚点择优(E-U-4;占用语义沿 User openid/phone @unique 含软删,镜像 loadBoundOpenids/Phones)
    const openidBound =
      app.openid != null &&
      (await this.prisma.user.findFirst({
        where: { openid: app.openid },
        select: { id: true },
      })) !== null;
    const phoneBound =
      app.phone != null &&
      (await this.prisma.user.findFirst({
        where: { phone: app.phone },
        select: { id: true },
      })) !== null;
    let channel: 'wechat' | 'phone';
    if (app.openid != null && !openidBound) {
      channel = 'wechat';
    } else if (app.phone != null && !phoneBound) {
      channel = 'phone';
    } else {
      throw new BizException(BizCode.RECRUITMENT_LOGIN_ANCHOR_UNAVAILABLE);
    }

    // bcrypt 预算在事务外(镜像批量超时硬化);VOL 归口部门守 ACTIVE(缺失 → 28044 清晰失败)
    const passwordHash = await bcrypt.hash(randomBytes(48).toString('base64'), BCRYPT_SALT_ROUNDS);
    const volOrgId = await this.resolveVolOrgIdOrThrow();

    // 与 batch 同一删除顺序：所有事务前校验成功后、紧贴业务 transaction 前 fail-closed 删除主体
    // 裁剪图。头像裁剪图继续在 transaction 内转为 User.avatarKey，不在此删除。
    await this.deleteCropBlobBeforeTransactionOrThrow(app.idCardCropImageKey);

    const promoted = await this.prisma.$transaction(
      async (tx) => {
        // 与批量共享同一原子号段:cycle 行锁自增 1(失败回滚撤销自增,号段连续无空洞)
        const bumped = await tx.recruitmentCycle.update({
          where: { id: app.cycleId },
          data: { memberNoSeq: { increment: 1 } },
          select: { memberNoSeq: true, year: true },
        });
        if (bumped.memberNoSeq > MEMBER_NO_MAX_SEQ) {
          throw new BizException(BizCode.RECRUITMENT_MEMBER_NO_EXHAUSTED);
        }
        const memberNo = formatMemberNo(bumped.year, bumped.memberNoSeq);
        try {
          const item = await this.buildOnePromotion(
            tx,
            app,
            memberNo,
            passwordHash,
            volOrgId,
            channel,
            user,
            meta,
            now,
            'promote-single',
          );
          await this.enqueuePromotionNotification(tx, app.id, item);
          return item;
        } catch (err) {
          // 撞既有 memberNo / openid / phone / username @unique → 回滚不跳号(28042,与批量同码)
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_PROMOTABLE);
          }
          throw err;
        }
      },
      { timeout: PROMOTE_TX_TIMEOUT_MS },
    );

    this.logger.log(
      `recruitment promote-single app=${app.id} member=${promoted.memberId} channel=${channel}`,
    );

    return { ...promoted, loginChannel: channel };
  }

  // === helpers ===

  // 单行建档内核(招新可用性收口 F3 抽取;批量 promote 与单人 promote-single 共用)。
  // 语义 = 原批量事务循环体逐字搬家:Member(volunteer)+ VOL 归口 PRIMARY + User(通道分流)+
  // MemberProfile + EmergencyContact + 标 promoted 清敏感 + audit。**不含** try/catch(P2002 处理
  // 留在调用方,批量整批回滚语义不变)。channel 由调用方决定:批量 = openid 有无派生(v0.40.0 逐字);
  // 单人 = E-U-4 锚点择优(可在 openid 被占时强制手机通道)。viaPath 仅单人传(audit extra additive)。
  // promote 的主体框裁剪图必须在业务 transaction 前删。provider 原始异常可能含 key / bucket /
  // 凭证状态，故不记录、不透传，统一收敛为安全 INTERNAL_ERROR；调用方据此保证删除失败零业务写。
  // 头像裁剪图不走此路：它会在 buildOnePromotion 内转为 User.avatarKey(同一 storage 对象)。
  private async deleteCropBlobBeforeTransactionOrThrow(key: string | null): Promise<void> {
    if (!key) return;
    try {
      await this.storage.deleteObject(key);
    } catch {
      throw new BizException(BizCode.INTERNAL_ERROR);
    }
  }

  private async buildOnePromotion(
    tx: Prisma.TransactionClient,
    a: RecruitmentApplication,
    memberNo: string,
    passwordHash: string,
    volOrgId: string,
    channel: 'wechat' | 'phone',
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
    viaPath?: string,
  ): Promise<PromotedItemDto> {
    // Member:招新闭环优化 S5(§5.2a)即赋志愿者身份 —— gradeCode='volunteer' + 同事务建 VOL
    // 归口部门(下一步)。入队(team-join 一键入队)才软删 VOL 行、换目标部门并升 level-1。
    const member = await tx.member.create({
      data: {
        memberNo,
        displayName: a.realName as string,
        status: 'ACTIVE',
        gradeCode: VOLUNTEER_GRADE_CODE,
      },
      select: { id: true },
    });
    // VOL 归口部门 —— 终态 scoped-authz PR2:重指向 member_organization_memberships 的 PRIMARY 行
    //(默认 membershipType=PRIMARY/status=ACTIVE = 旧单部门语义;primary_active_unique 兜底:此刻仅此一条 active PRIMARY)。
    await tx.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId: volOrgId },
    });
    // User:随机口令(密码登录天然关闭)、username=memberNo;passwordHash 取事务前预算结果
    // (bcrypt 不在事务回调内执行 = 超时硬化)。**登录通道分流(v0.40.0 H5 手机通道)**:
    // - wechat → openid-only,不写 phone(微信登录;批量对有 openid 行为锁逐字);
    // - phone → phone + phoneVerifiedAt=now(H5 手机经 RECRUITMENT_BIND 短信实证 / F3 管理员发号背书,
    //   镜像 grantAccountCore 先例),openid=null,可走 login-sms 登录。
    await tx.user.create({
      data: {
        username: memberNo,
        passwordHash,
        ...(channel === 'wechat'
          ? { openid: a.openid as string }
          : { phone: a.phone as string, phoneVerifiedAt: now }),
        // 十项收口刀E:OCR 头像裁剪图设为队员账号头像(schema 原注释「留后续 goal」本刀兑现;
        // 同一 storage 对象属主转 user,报名行 key 随下方清理清空,blob 不删)
        ...(a.idCardPortraitImageKey ? { avatarKey: a.idCardPortraitImageKey } : {}),
        role: 'USER',
        memberId: member.id,
      },
      select: { id: true },
    });
    // MemberProfile(§6 逐字段映射;email=null〔M-1〕;joinedDate=发号日;privacyConsentSigned=F5 搬真值)
    await tx.memberProfile.create({
      data: {
        memberId: member.id,
        realName: a.realName as string,
        genderCode: a.genderCode as string,
        birthDate: a.birthDate as Date, // 已在提交期归一 UTC 午夜
        documentTypeCode: toMemberProfileDocumentTypeCode(a.documentTypeCode),
        documentNumber: a.idCardNumber as string,
        mobile: a.phone as string,
        joinedDate: normalizeDateOnly(now.toISOString()),
        joinSourceCode: JOIN_SOURCE_RECRUITMENT,
        // F5(评审稿 §2.8;⚠️ 行为变更):privacyConsentSigned 由硬编码 true 改搬申请真值——
        // 报名期已确认知情同意(acceptedAt 置)才 true;存量历史行(F5 前无 consent 字段)→ false。
        // signedAt 一并搬真实确认时刻;签名图 key 搬入档案长期留存(R5,镜像 idCardImageKey)。
        privacyConsentSigned: a.privacyConsentAcceptedAt != null,
        ...(a.privacyConsentAcceptedAt
          ? { privacyConsentSignedAt: a.privacyConsentAcceptedAt }
          : {}),
        ...(a.idCardImageKey ? { idCardImageKey: a.idCardImageKey } : {}),
        ...(a.signatureImageKey ? { signatureImageKey: a.signatureImageKey } : {}),
        // 十项收口刀E:建档搬运补齐——此前 detailedAddress/profileExtra 在下方清理中被置空且无
        // 档案落点(真丢失),现搬 MP-34/MP-35;cityDistrict 搬现成 residenceArea(MP-13)。
        ...(a.cityDistrict ? { residenceArea: a.cityDistrict } : {}),
        ...(a.detailedAddress ? { detailedAddress: a.detailedAddress } : {}),
        ...(a.profileExtra != null ? { profileExtra: a.profileExtra } : {}),
      },
      select: { id: true },
    });
    // EmergencyContact(Json → 行;priority=序)
    // 本次修订前为「relationCode 原样 best-effort」→ 绕过字典校验持久化非法码(#399 F3)。
    // 现复用 canonical assertEmergencyRelationCodeValid(纯函数、直连 tx,不引 service;防环铁律不破):
    // 非法 relationCode → EMERGENCY_CONTACT_RELATION_CODE_INVALID,整批事务回滚(沿「失败可恢复」)。
    const contacts = this.parseContacts(a.emergencyContacts);
    for (let j = 0; j < contacts.length; j++) {
      await assertEmergencyRelationCodeValid(tx, contacts[j].relation);
      await tx.emergencyContact.create({
        data: {
          memberId: member.id,
          contactName: contacts[j].name,
          relationCode: contacts[j].relation,
          phonePrimary: contacts[j].phone,
          priority: j,
        },
        select: { id: true },
      });
    }
    // F7(R6)+ 证书审核只审一次(2026-07-14):为已上传证书图的类别自动建 Certificate(图 key 搬入,
    // blob 单一属主=certificate)。招新阶段已 approved 的类别**继承**审核结论建为 verified(审核人/时间/
    // 备注一并搬入),不再重建成 pending 让核验人二次审核;仅上传未审的类别仍建 pending 走既有
    // certificates verify/reject 核验流。legacy 行无 certificateImages → 零建行(批量 promote 行为锁)。
    const certImages = a.certificateImages as Record<string, string[]> | null;
    if (certImages) {
      for (const [category, keys] of Object.entries(certImages)) {
        if (!Array.isArray(keys) || keys.length === 0) continue;
        const issuance = certificateIssuanceForCategory(a.certificateIssuanceInfo, category);
        const review = certificateReviewForCategory(a.certificateReviewStatus, category);
        const data: Prisma.CertificateUncheckedCreateInput = {
          memberId: member.id,
          certTypeCode: category,
          issuingOrg: issuance?.issuingOrg ?? RECRUITMENT_CERT_ISSUING_ORG,
          issuedAt: normalizeDateOnly(issuance?.issuedAt ?? now.toISOString()),
          certStatusCode: CERT_STATUS_PENDING,
          isInternal: false,
          imageKeys: keys,
        };
        if (review?.status === 'approved') {
          // 继承审核状态/人/时间/备注:审核人 review.by 为 User.id,映射其 Member.id 作 verifiedBy;
          // 无 memberId(如 SUPER_ADMIN)合法为 null,沿 certificates.service Q-I2,不卡核验流。
          const reviewer = await tx.user.findUnique({
            where: { id: review.by },
            select: { memberId: true },
          });
          data.certStatusCode = CERT_STATUS_VERIFIED;
          data.verifiedBy = reviewer?.memberId ?? null;
          data.verifiedAt = new Date(review.at);
          if (review.note) data.verifyNote = review.note;
        }
        await tx.certificate.create({ data, select: { id: true } });
      }
    }
    // 标 promoted + 链 + 即时清敏感(PII 已搬 member/user;blob 归 member/user,留存 SOP 不再触 promoted 行)。
    // F12(#399):openid + reviewNote 亦属留存 SOP §1 须置 NULL 的敏感字段;promote 即时清后
    // SOP「WHERE sensitivePurgedAt IS NULL」永久跳过本行 —— 漏清则再识别字段在「已脱敏」行永久残留。
    // 十项收口刀C:补清 OCR 4 列 + 两裁剪图 key + 换绑史/原因(此前全部漏清 = promoted 行永久残留
    // 高敏 PII;民族/OCR 住址属敏感个人信息,换绑史含明文手机)。主体裁剪图 blob 已在 transaction
    // 前 fail-closed 删除；头像裁剪图 blob 已转 User.avatarKey(刀E)仅清 key。
    await tx.recruitmentApplication.update({
      where: { id: a.id },
      data: {
        statusCode: APP_STATUS_PROMOTED,
        promotedMemberId: member.id,
        sensitivePurgedAt: now,
        realName: null,
        idCardNumber: null,
        birthDate: null,
        phone: null,
        detailedAddress: null,
        emergencyContacts: Prisma.DbNull,
        profileExtra: Prisma.DbNull,
        idCardImageKey: null,
        openid: null,
        reviewNote: null,
        // F5(R5):签名图已搬 member_profiles 长期留存 → 报名行 key 清空(blob 单一属主=member);
        // privacyConsentAcceptedAt/Version 为脱敏留存字段,不清。
        signatureImageKey: null,
        // F7(R6):证书图已按类别搬 Certificate.imageKeys → 报名行清空(blob 单一属主=certificate)。
        certificateImages: Prisma.DbNull,
        certificateReviewStatus: Prisma.DbNull,
        certificateIssuanceInfo: Prisma.DbNull,
        // transaction 成功后两列一并清空；若 transaction 失败，key 暂留供 absent-delete 幂等重试。
        ocrAddress: null,
        ocrNation: null,
        ocrAuthority: null,
        ocrValidDate: null,
        idCardCropImageKey: null,
        idCardPortraitImageKey: null,
        phoneChangeReason: null,
        phoneBindingHistory: Prisma.DbNull,
      },
    });
    await this.auditLogs.log({
      event: 'recruitment-application.promote',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: a.id,
      meta,
      before: { statusCode: APP_STATUS_PUBLICITY },
      after: { statusCode: APP_STATUS_PROMOTED },
      extra: {
        memberNo,
        memberId: member.id,
        tempNo: a.tempNo,
        // 微信通道:掩码 openid(现状逐字不变);v0.40.0 H5 手机通道(无 openid):openid=null +
        // 记掩码手机(禁明文;auditability)。有 openid 者 openid 字段形状不变 = 行为锁。
        openid: a.openid != null ? this.maskOpenid(a.openid) : null,
        ...(a.openid == null && a.phone != null ? { phone: maskPhone(a.phone) } : {}),
        // F3 单人建档 additive:viaPath + 实际登录通道(批量不传 → extra 形状逐字不变 = 行为锁;
        // 单人在 openid 被占强制手机通道时,channel 是唯一能说明真实锚点的字段)。
        ...(viaPath ? { viaPath, channel } : {}),
      },
      tx,
    });
    return { applicationId: a.id, memberId: member.id, memberNo, realName: a.realName };
  }

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // VOL 归口部门解析(招新闭环优化 S5;§5.2a):Organization.code='VOL'(≠ VOD 志愿者组织部)+ ACTIVE。
  // 事务前调用 → 缺失/非 ACTIVE 在建任何 member 之前抛 28044(不留半成品 member;运维据此校正 seed/组织状态)。
  private async resolveVolOrgIdOrThrow(): Promise<string> {
    const org = await this.prisma.organization.findFirst({
      where: { code: VOL_ORG_CODE, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!org || org.status !== OrganizationStatus.ACTIVE) {
      throw new BizException(BizCode.RECRUITMENT_VOLUNTEER_ORG_UNAVAILABLE);
    }
    return org.id;
  }

  // F16(#399):openid 占用一次性批量查(沿 User.openid @unique 含软删占用语义)→ Set。
  // 取代原逐行 findFirst(N 顺序往返);空集免查。发号资格判定/skipReason 已并入 constants.decidePromotionIssuance。
  private async loadBoundOpenids(apps: readonly { openid: string | null }[]): Promise<Set<string>> {
    const openids = apps.map((a) => a.openid).filter((o): o is string => o != null);
    if (openids.length === 0) return new Set<string>();
    const rows = await this.prisma.user.findMany({
      where: { openid: { in: openids } },
      select: { openid: true },
    });
    return new Set(rows.map((r) => r.openid).filter((o): o is string => o != null));
  }

  // v0.40.0 H5 手机通道发号:phone 占用一次性批量查(沿 User.phone @unique 含软删占用语义)→ Set。
  // **仅无 openid 的 app 才走手机通道**,故只查这些 app 的 phone(镜像 loadBoundOpenids 只查相关值;
  // 有 openid 者走微信通道,其 phone 不参与占用判定 = 行为锁)。发号资格判定/skipReason 已并入
  // constants.decidePromotionIssuance。
  private async loadBoundPhones(
    apps: readonly { openid: string | null; phone: string | null }[],
  ): Promise<Set<string>> {
    const phones = apps
      .filter((a) => a.openid == null)
      .map((a) => a.phone)
      .filter((p): p is string => p != null);
    if (phones.length === 0) return new Set<string>();
    const rows = await this.prisma.user.findMany({
      where: { phone: { in: phones } },
      select: { phone: true },
    });
    return new Set(rows.map((r) => r.phone).filter((p): p is string => p != null));
  }

  private parseContacts(json: Prisma.JsonValue | null): EmergencyContactJson[] {
    if (!Array.isArray(json)) return [];
    const out: EmergencyContactJson[] = [];
    for (const raw of json) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const o = raw as Record<string, unknown>;
        if (
          typeof o.name === 'string' &&
          typeof o.relation === 'string' &&
          typeof o.phone === 'string'
        ) {
          out.push({ name: o.name, relation: o.relation, phone: o.phone });
        }
      }
    }
    return out;
  }

  private maskOpenid(openid: string): string {
    return openid.length <= 8 ? '***' : `${openid.slice(0, 4)}****${openid.slice(-4)}`;
  }
}

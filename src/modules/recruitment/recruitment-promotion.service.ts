import { Injectable, Logger } from '@nestjs/common';
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
import { RbacService } from '../permissions/rbac.service';
import {
  APP_STATUS_PROMOTED,
  APP_STATUS_PUBLICITY,
  MEMBER_NO_MAX_SEQ,
  comparePromotionOrder,
  decidePromotionIssuance,
  formatMemberNo,
} from './recruitment.constants';
import type { PromoteResultDto, PromoteSkippedItemDto, PromotedItemDto } from './recruitment.dto';

// 招新二期(后段)T3:一键发号(评审稿 D-R2-5/6 + E-R2-6/7 + §4 流程冻结)。
// 公示结束 → 对 cycle 内全部 publicity 报名按姓名拼音序批量发永久编号 {YY}{NNN}
// → 建 User + Member(+VOL 归口部门)+ member_profiles + emergency_contacts → 标 promoted + promotedMemberId + 清敏感。
//
// 铁律:
// - 单一事务(全或无、号段连续无空洞、无半建态;吸取 phase-1 FM-A);
// - 幂等(promoted 已离开 publicity,重跑命中 0 / promotedMemberId 置则不会重入 + @unique 兜底;不双建 VOL 部门);
// - 失败可恢复(事务任一步失败 → 整批回滚、seq 复位,admin 修后重跑);
// - 外籍/不可发号项 = 事务前分区 skip + report(不 block、不静默丢;M-1 维护者澄清);
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
    const boundOpenids = await this.loadBoundOpenids(apps);

    // 事务前分区(纯查询):先按发号序排,再用与公示预览共享的 decidePromotionIssuance 判定 —— 结构性
    // 保证「公示拟发号 = 实发」(#399 F9)、批内同 openid 仅首行发号余项 skip(#399 F15,免第二行入
    // 事务撞 User.openid @unique 整批回滚)。skip 项 report 不 block(外籍/缺字段/openid 占用;M-1)。
    const sortedApps = [...apps].sort(comparePromotionOrder);
    const promotable: RecruitmentApplication[] = [];
    const skipped: PromoteSkippedItemDto[] = [];
    for (const d of decidePromotionIssuance(sortedApps, boundOpenids)) {
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
            // VOL 归口部门(member_departments 单部门 partial unique:此刻仅此一条 active 归属)。
            await tx.memberDepartment.create({
              data: { memberId: member.id, organizationId: volOrgId },
            });
            // User(微信-only:openid 主、随机口令密码登录天然关闭、username=memberNo;零 auth 改)
            // passwordHash 取事务前预算结果(bcrypt 不在事务回调内执行 = 超时硬化)
            const passwordHash = passwordHashes[i];
            await tx.user.create({
              data: {
                username: memberNo,
                passwordHash,
                openid: a.openid,
                role: 'USER',
                memberId: member.id,
              },
              select: { id: true },
            });
            // MemberProfile(§6 逐字段映射;email=null〔M-1〕;joinedDate=发号日;privacyConsentSigned=true)
            await tx.memberProfile.create({
              data: {
                memberId: member.id,
                realName: a.realName as string,
                genderCode: a.genderCode as string,
                birthDate: a.birthDate as Date, // 已在提交期归一 UTC 午夜
                documentTypeCode: a.documentTypeCode,
                documentNumber: a.idCardNumber as string,
                mobile: a.phone as string,
                joinedDate: normalizeDateOnly(now.toISOString()),
                joinSourceCode: JOIN_SOURCE_RECRUITMENT,
                privacyConsentSigned: true,
                ...(a.idCardImageKey ? { idCardImageKey: a.idCardImageKey } : {}),
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
            // 标 promoted + 链 + 即时清敏感(PII 已搬 member;blob 归 member,留存 SOP 不再触 promoted 行)。
            // F12(#399):openid + reviewNote 亦属留存 SOP §1 须置 NULL 的敏感字段;promote 即时清后
            // SOP「WHERE sensitivePurgedAt IS NULL」永久跳过本行 —— 漏清则两再识别字段在「已脱敏」行永久残留。
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
                openid: this.maskOpenid(a.openid as string),
              },
              tx,
            });
            out.push({ applicationId: a.id, memberId: member.id, memberNo, realName: a.realName });
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

  // === helpers ===

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

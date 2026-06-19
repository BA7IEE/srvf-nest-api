import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma, type RecruitmentApplication } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { normalizeDateOnly } from '../../common/datetime/date-only.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import {
  APP_STATUS_PROMOTED,
  APP_STATUS_PUBLICITY,
  MEMBER_NO_MAX_SEQ,
  comparePromotionOrder,
  formatMemberNo,
  isPromotable,
} from './recruitment.constants';
import type { PromoteResultDto, PromoteSkippedItemDto, PromotedItemDto } from './recruitment.dto';

// 招新二期(后段)T3:一键发号(评审稿 D-R2-5/6 + E-R2-6/7 + §4 流程冻结)。
// 公示结束 → 对 cycle 内全部 publicity 报名按姓名拼音序批量发永久编号 {YY}{NNN}
// → 建 User + Member + member_profiles + emergency_contacts → 标 promoted + promotedMemberId + 清敏感。
//
// 铁律:
// - 单一事务(全或无、号段连续无空洞、无半建态;吸取 phase-1 FM-A);
// - 幂等(promoted 已离开 publicity,重跑命中 0 / promotedMemberId 置则不会重入 + @unique 兜底);
// - 失败可恢复(事务任一步失败 → 整批回滚、seq 复位,admin 修后重跑);
// - 外籍/不可发号项 = 事务前分区 skip + report(不 block、不静默丢;M-1 维护者澄清);
// - 两层身份:建的 Member **无部门、无级别**(gradeCode=null;不建 member_departments);
// - 不复用 members/users service(直连 prisma,防环 + 零行为漂移;E-R2-14)。

const BCRYPT_SALT_ROUNDS = 10; // 与 users.service / password-reset.service 同值(各模块级声明)
// 显式事务超时(超时硬化):bcrypt 已移出事务,回调内仅快速 DB 写;按最大公示批量(~数十人,
// 每人 ~7 次写)留充足余量取 60s,远超 Prisma 默认 5s,杜绝大批量发号被事务超时整批顶死回滚。
export const PROMOTE_TX_TIMEOUT_MS = 60_000;
const AUDIT_RESOURCE_TYPE = 'recruitment_application';
const JOIN_SOURCE_RECRUITMENT = 'recruitment'; // member_profiles.joinSourceCode(候选字典码,promote 直写)

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

    // 事务前分区(纯查询):promotable(大陆可派生 + openid 未占用)vs skip(外籍/缺字段/openid 已绑)。
    // skip 项 report 不 block(M-1);事务只处理 promotable,保证「不致整批因外籍卡死」。
    const promotable: RecruitmentApplication[] = [];
    const skipped: PromoteSkippedItemDto[] = [];
    for (const a of apps) {
      const openidBound = a.openid ? await this.openidAlreadyBound(a.openid) : false;
      if (isPromotable(a) && !openidBound) {
        promotable.push(a);
      } else {
        skipped.push({
          applicationId: a.id,
          realName: a.realName,
          reason: this.skipReason(a, openidBound),
        });
      }
    }
    promotable.sort(comparePromotionOrder);

    // 超时硬化:bcrypt(rounds=10,~80ms/个,CPU 密集)预算在**事务之外**完成。
    // 口令为随机高熵、与编号/事务无关,故可在事务前并发预算 n 个哈希,事务回调内逐个取用,
    // 杜绝串行 bcrypt 撑爆事务超时(大批量公示 → 整批回滚发不出号)。原子性模型一字不变。
    const passwordHashes = await Promise.all(
      promotable.map(() => bcrypt.hash(randomBytes(48).toString('base64'), BCRYPT_SALT_ROUNDS)),
    );

    // 单一事务:发号 + 建 User/Member/profile/contacts + 标 promoted + 清敏感(全或无)
    const promoted = await this.prisma.$transaction(
      async (tx) => {
        const n = promotable.length;
        if (n === 0) return [] as PromotedItemDto[];

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
            // Member(无 gradeCode = 无级别;不建 member_departments = 无部门;两层身份铁律)
            const member = await tx.member.create({
              data: { memberNo, displayName: a.realName as string, status: 'ACTIVE' },
              select: { id: true },
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
            // EmergencyContact(Json → 行;relationCode 原样 best-effort;priority=序)
            const contacts = this.parseContacts(a.emergencyContacts);
            for (let j = 0; j < contacts.length; j++) {
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
            // 标 promoted + 链 + 即时清敏感(PII 已搬 member;blob 归 member,留存 SOP 不再触 promoted 行)
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

  // openid 全局唯一含软删占用(沿 User.openid @unique 范式):已被任何 User(含软删)占用 → 不可建
  private async openidAlreadyBound(openid: string): Promise<boolean> {
    const existing = await this.prisma.user.findFirst({ where: { openid }, select: { id: true } });
    return existing !== null;
  }

  private skipReason(app: RecruitmentApplication, openidBound: boolean): string {
    if (app.isForeigner) return 'foreign-manual-build';
    if (openidBound) return 'openid-already-bound';
    if (app.openid == null) return 'missing-openid';
    if (app.birthDate == null || app.genderCode == null) return 'missing-derived-field';
    if (app.realName == null) return 'incomplete-data';
    return 'not-promotable';
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

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { normalizeDateOnly } from '../../common/datetime/date-only.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { assertEmergencyRelationCodeValid } from '../emergency-contacts/emergency-relation.validation';
import { RbacService } from '../permissions/rbac.service';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import { maskIdCard, maskName } from '../realname/realname.constants';
import {
  APP_INACTIVE_STATUS_CODES,
  APP_STATUS_MANUAL,
  APP_STATUS_PENDING,
  APP_STATUS_PENDING_EVALUATION,
  APP_STATUS_PROMOTED,
  APP_STATUS_PUBLICITY,
  APP_STATUS_REJECTED,
  APP_STATUS_VERIFIED,
  APP_STATUS_WITHDRAWN,
  CERTIFICATE_THRESHOLD_BY_CATEGORY,
  ELIM_STAGE_EVALUATION,
  ELIM_STAGE_THRESHOLD_TIMEOUT,
  RECRUITMENT_MAX_AGE,
  RECRUITMENT_MIN_AGE,
  RECRUITMENT_CERT_CATEGORIES,
  type RecruitmentCertificateCategory,
  type ThresholdCode,
  type ThresholdMarks,
  allThresholdsComplete,
  certificateCategoryForThreshold,
  computeAge,
  extractBirthDate,
  extractGenderCode,
  isMainlandId,
  isProfileExtraWithinLimit,
  isValidChineseId,
} from './recruitment.constants';
import {
  certificateJsonOrDbNull,
  certificateReviewForCategory,
} from './recruitment-certificate-json';
import { resolveBatchMatches } from './recruitment-batch-matching';
import { toAdminApplicationDto } from './recruitment-applications.presenter';
import type {
  BatchMarkThresholdDto,
  BatchMarkThresholdResultDto,
  BatchMarkThresholdRowResultDto,
  EvaluateRecruitmentApplicationDto,
  MarkThresholdDto,
  ReviewRecruitmentCertificateDto,
  RecruitmentApplicationAdminDto,
  UpdateRecruitmentApplicationDto,
} from './recruitment.dto';

// 招新报名 admin 评审写动作 service(god-service 拆分 2026-06-28)。
// 从 RecruitmentApplicationsService 抽出**核验之后**的 admin 评审工作流:门槛标记 / 批量标门槛 / 综合评定淘汰。
// 仍为 application service(持有各自写事务,沿 architecture-boundary §4「事务归属不下放」);状态机判定 +
// audit 仍内联(规模未达 StateMachine/AuditRecorder 抽离触发线,本次纯搬家,不改判定语义/事件名/BizCode)。
// 注:发临时编号的两条路径(submit / resolveManual,含 FM-C 容量原子兜底)留 RecruitmentApplicationsService;
// 本 service 三动作均不发号(markThreshold→pending_evaluation/verified、evaluate→publicity/rejected)。

const AUDIT_RESOURCE_TYPE = 'recruitment_application'; // 与 RecruitmentApplicationsService 同一资源类型(审计行为锁)

@Injectable()
export class RecruitmentApplicationReviewService {
  private readonly logger = new Logger(RecruitmentApplicationReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // ============ 招新二期:标/清门槛(M-3 / E-R2-2;幂等;末次完成自动推进 pending_evaluation)============
  async markThreshold(
    id: string,
    dto: MarkThresholdDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.mark.threshold');
    const canSensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "recruitment_applications" WHERE "id" = ${id} FOR UPDATE`,
      );
      const row = await tx.recruitmentApplication.findFirst({ where: { id, deletedAt: null } });
      if (!row) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
      }
      // 仅 verified / pending_evaluation 态可标(评定/公示/发号后门槛不可再动);他态 28041
      if (
        row.statusCode !== APP_STATUS_VERIFIED &&
        row.statusCode !== APP_STATUS_PENDING_EVALUATION
      ) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
      }
      const code = dto.thresholdCode as ThresholdCode; // DTO @IsIn 已校验 ∈ THRESHOLD_CODES
      const certificateCategory = certificateCategoryForThreshold(code);
      if (dto.completed && certificateCategory) {
        const images = (row.certificateImages as Record<string, string[]> | null) ?? {};
        if (
          !Array.isArray(images[certificateCategory]) ||
          images[certificateCategory].length === 0
        ) {
          throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_IMAGE_REQUIRED);
        }
        if (
          certificateReviewForCategory(row.certificateReviewStatus, certificateCategory)?.status !==
          'approved'
        ) {
          throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_NOT_APPROVED);
        }
      }
      const { marks, allComplete, nextStatus } = this.buildThresholdMutation(
        row.statusCode,
        row.thresholdMarks,
        code,
        dto.completed,
        user.id,
        now,
      );
      const updated = await tx.recruitmentApplication.update({
        where: { id },
        data: { thresholdMarks: marks as Prisma.InputJsonValue, statusCode: nextStatus },
      });
      await this.auditLogs.log({
        event: 'recruitment-application.mark-threshold',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: { statusCode: row.statusCode },
        after: { statusCode: nextStatus },
        extra: { thresholdCode: code, completed: dto.completed, allComplete },
        tx,
      });
      return toAdminApplicationDto(updated, !canSensitive);
    });
  }

  async reviewCertificate(
    id: string,
    category: string,
    dto: ReviewRecruitmentCertificateDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.review.certificate');
    if (!RECRUITMENT_CERT_CATEGORIES.includes(category as RecruitmentCertificateCategory)) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const canSensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "recruitment_applications" WHERE "id" = ${id} FOR UPDATE`,
      );
      const row = await tx.recruitmentApplication.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
      if (
        row.statusCode === APP_STATUS_PROMOTED ||
        row.statusCode === APP_STATUS_REJECTED ||
        row.statusCode === APP_STATUS_WITHDRAWN
      ) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
      }
      const typedCategory = category as RecruitmentCertificateCategory;
      const images = (row.certificateImages as Record<string, string[]> | null) ?? {};
      const categoryImages = Array.isArray(images[typedCategory]) ? images[typedCategory] : [];
      if (categoryImages.length === 0) {
        throw new BizException(BizCode.RECRUITMENT_CERTIFICATE_IMAGE_REQUIRED);
      }
      const reviews = (row.certificateReviewStatus as Record<string, unknown> | null) ?? {};
      const nextReviews = {
        ...reviews,
        [typedCategory]: {
          status: dto.approved ? 'approved' : 'rejected',
          at: now.toISOString(),
          by: user.id,
          ...(dto.note ? { note: dto.note } : {}),
        },
      };
      const thresholdCode = CERTIFICATE_THRESHOLD_BY_CATEGORY[typedCategory];
      const threshold = this.buildThresholdMutation(
        row.statusCode,
        row.thresholdMarks,
        thresholdCode,
        dto.approved,
        user.id,
        now,
      );
      const nextImages = { ...images };
      if (!dto.approved) delete nextImages[typedCategory];
      const updated = await tx.recruitmentApplication.update({
        where: { id },
        data: {
          certificateReviewStatus: certificateJsonOrDbNull(nextReviews),
          certificateImages: certificateJsonOrDbNull(nextImages),
          thresholdMarks: threshold.marks as Prisma.InputJsonValue,
          statusCode: threshold.nextStatus,
        },
      });
      await this.auditLogs.log({
        event: 'recruitment-application.certificate-review',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: { statusCode: row.statusCode },
        after: { statusCode: threshold.nextStatus },
        extra: {
          category: typedCategory,
          approved: dto.approved,
          imageCount: categoryImages.length,
        },
        tx,
      });
      return { updated, deleteKeys: dto.approved ? [] : categoryImages };
    });
    for (const key of result.deleteKeys) await this.safeDeleteBlob(key);
    return toAdminApplicationDto(result.updated, !canSensitive);
  }

  // ============ 招新闭环优化 S6:批量标门槛(评审稿 §8.1;复用单行 markThreshold,零第二套)============
  // 入参 = 匹配键数组(临时编号 / 手机 / 姓名+手机;「签到记录导入」由前端解析为本数组)+ thresholdCode + completed。
  // **逐行复用单行 markThreshold**(各自独立事务 → 逐行幂等 + 逐行容错:某行匹配不上/状态非法不整批回滚;
  // per-row mark-threshold DB 审计 + 自动推进语义全由单行逻辑承载,本方法零重复)。批次汇总走 logger.log
  // (沿 promote 批量操作范式:per-row DB 审计 + 操作性汇总日志;不扩 locked AuditEvent union)。
  async batchMarkThreshold(
    dto: BatchMarkThresholdDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<BatchMarkThresholdResultDto> {
    // 入口快速失败(单行 markThreshold 内仍逐行复判,防御不破)。
    await this.assertCanOrThrow(user, 'recruitment-application.mark.threshold');

    // 候选集(限定 scope + 未软删;仅取匹配所需字段)。缺 cycleId 时跨全部未软删报名匹配
    // (手机/姓名多命中 → ambiguous 安全留人工,不误标)。
    const candidates = await this.prisma.recruitmentApplication.findMany({
      where: { deletedAt: null, ...(dto.cycleId ? { cycleId: dto.cycleId } : {}) },
      select: { id: true, tempNo: true, phone: true, realName: true },
    });
    const resolutions = resolveBatchMatches(dto.matches, candidates);

    const results: BatchMarkThresholdRowResultDto[] = [];
    let marked = 0;
    let unmatched = 0;
    let failed = 0;
    let autoAdvanced = 0;

    for (let i = 0; i < resolutions.length; i++) {
      const r = resolutions[i];
      if (r.status === 'unmatched') {
        unmatched += 1;
        results.push({
          index: i,
          status: 'unmatched',
          applicationId: null,
          matchedBy: null,
          unmatchedReason: r.reason,
          errorCode: null,
          statusCode: null,
          thresholdsComplete: null,
        });
        continue;
      }
      // 命中 → 复用单行 markThreshold(自有事务:逐行幂等 + 逐行容错 + 自动推进 + per-row 审计)。
      try {
        const updated = await this.markThreshold(
          r.applicationId,
          { thresholdCode: dto.thresholdCode, completed: dto.completed },
          user,
          meta,
          now,
        );
        marked += 1;
        const advanced = dto.completed && updated.statusCode === APP_STATUS_PENDING_EVALUATION;
        if (advanced) autoAdvanced += 1;
        results.push({
          index: i,
          status: 'marked',
          applicationId: r.applicationId,
          matchedBy: r.matchedBy,
          unmatchedReason: null,
          errorCode: null,
          statusCode: updated.statusCode,
          thresholdsComplete: updated.thresholdsComplete,
        });
      } catch (err) {
        // 逐行容错:单行业务失败(如 28041 状态非法)记 failed,批次继续(不整批回滚)。
        failed += 1;
        results.push({
          index: i,
          status: 'failed',
          applicationId: r.applicationId,
          matchedBy: r.matchedBy,
          unmatchedReason: null,
          errorCode: err instanceof BizException ? err.biz.code : null,
          statusCode: null,
          thresholdsComplete: null,
        });
      }
    }

    // 批次汇总(操作性日志;per-row 审计已由单行 markThreshold 落库)。
    this.logger.log(
      `recruitment batch-mark-threshold code=${dto.thresholdCode} completed=${dto.completed} ` +
        `total=${dto.matches.length} marked=${marked} unmatched=${unmatched} failed=${failed} ` +
        `autoAdvanced=${autoAdvanced} by=${user.id}`,
    );

    return { results, total: dto.matches.length, marked, unmatched, failed, autoAdvanced };
  }

  // ============ 招新二期:综合评定 / 淘汰(单一人工闸;D-R2-3 / 流程冻结 §4)============
  // pending_evaluation:通过→公示 / 不通过→未通过(evaluation);
  // verified:仅 approved=false 淘汰(门槛超期/退出,threshold-timeout);approved=true→28041(门槛未齐);
  // 其余态→28041。
  async evaluate(
    id: string,
    dto: EvaluateRecruitmentApplicationDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.evaluate.assessment');
    const canSensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.recruitmentApplication.findFirst({ where: { id, deletedAt: null } });
      if (!row) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
      }
      let nextStatus: string;
      let eliminationStage: string | null = null;
      if (row.statusCode === APP_STATUS_PENDING_EVALUATION) {
        if (dto.approved) {
          nextStatus = APP_STATUS_PUBLICITY;
        } else {
          nextStatus = APP_STATUS_REJECTED;
          eliminationStage = ELIM_STAGE_EVALUATION;
        }
      } else if (row.statusCode === APP_STATUS_VERIFIED) {
        if (dto.approved) {
          // 门槛未齐不可直接过评定(必须先全完成自动到 pending_evaluation)
          throw new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
        }
        nextStatus = APP_STATUS_REJECTED;
        eliminationStage = ELIM_STAGE_THRESHOLD_TIMEOUT;
      } else {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
      }
      const updated = await tx.recruitmentApplication.update({
        where: { id },
        data: {
          statusCode: nextStatus,
          evaluatedByUserId: user.id,
          evaluatedAt: now,
          ...(dto.note !== undefined ? { evaluationNote: dto.note } : {}),
          ...(eliminationStage ? { eliminationStage } : {}),
        },
      });
      await this.auditLogs.log({
        event: 'recruitment-application.evaluate',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: { statusCode: row.statusCode },
        after: { statusCode: nextStatus },
        extra: { approved: dto.approved, eliminationStage },
        tx,
      });
      return toAdminApplicationDto(updated, !canSensitive);
    });
  }

  // ============ 招新可用性收口 F2:admin 改资料(评审稿 recruitment-usability-closeout-review.md §3 R1)============
  // 白名单 + 身份字段条件闸:
  // - 非身份字段(detailedAddress/cityDistrict/sourceChannel/emergencyContacts/profileExtra)恒可改;
  // - 身份字段(realName/idCardNumber/birthDate/genderCode)仅 statusCode='manual_review' **或** 非大陆证件记录
  //   可改(已 verified 的大陆记录 OCR 已核验 → 28045 不开);
  // - 大陆记录 birthDate/genderCode 恒由证件号派生(直接传 → 40000);大陆改 idCardNumber → 校验位 +
  //   年龄复检(28010)+ birthDate/genderCode 重派生 + 同轮活跃去重(28003;镜像 submit 语义);
  // - promoted / 已脱敏(sensitivePurgedAt 置)行不可改(28041)——回写 PII 会与留存 SOP「已清不再触」冲突;
  // - phone/openid 不在白名单(自助换绑通道已存在,admin 直改会绕过双验破坏身份锚;R3 取舍)。
  // 必落 audit('recruitment-application.update'):before/after 仅身份字段掩码值,非身份字段只记字段名。
  async updateApplication(
    id: string,
    dto: UpdateRecruitmentApplicationDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.update.record');
    const canSensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');

    const identityKeys = ['realName', 'idCardNumber', 'birthDate', 'genderCode'] as const;
    const nonIdentityKeys = [
      'detailedAddress',
      'cityDistrict',
      'sourceChannel',
      'emergencyContacts',
      'profileExtra',
    ] as const;
    const changedFields = [...identityKeys, ...nonIdentityKeys].filter((k) => dto[k] !== undefined);
    if (changedFields.length === 0) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const identityChanged = identityKeys.some((k) => dto[k] !== undefined);

    // 紧急联系人 relation 字典校验(免费 fail-fast;镜像 submit / promote 双层一致)
    if (dto.emergencyContacts !== undefined) {
      for (const contact of dto.emergencyContacts) {
        await assertEmergencyRelationCodeValid(this.prisma, contact.relation);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.recruitmentApplication.findFirst({ where: { id, deletedAt: null } });
      if (!row) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
      }
      // promoted / 已脱敏行:PII 已清并搬 member,回写与留存 SOP 冲突 → 一律不可改
      if (row.statusCode === APP_STATUS_PROMOTED || row.sensitivePurgedAt !== null) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
      }
      // 身份字段条件闸(R1):仅 manual_review 或非大陆证件记录可改
      if (identityChanged && row.statusCode !== APP_STATUS_MANUAL && !row.isForeigner) {
        throw new BizException(BizCode.RECRUITMENT_IDENTITY_FIELDS_LOCKED);
      }
      const mainland = isMainlandId(row.documentTypeCode);
      // 大陆记录 birthDate/genderCode 恒由证件号派生,不可直改(镜像「OCR 值不覆盖派生权威」口径)
      if (mainland && (dto.birthDate !== undefined || dto.genderCode !== undefined)) {
        throw new BizException(BizCode.BAD_REQUEST);
      }

      const data: Prisma.RecruitmentApplicationUpdateInput = {};
      if (dto.realName !== undefined) data.realName = dto.realName;
      if (dto.detailedAddress !== undefined) data.detailedAddress = dto.detailedAddress;
      if (dto.cityDistrict !== undefined) data.cityDistrict = dto.cityDistrict;
      if (dto.sourceChannel !== undefined) data.sourceChannel = dto.sourceChannel;
      if (dto.emergencyContacts !== undefined) {
        data.emergencyContacts = dto.emergencyContacts as unknown as Prisma.InputJsonValue;
      }
      if (dto.profileExtra !== undefined) {
        // 十项收口刀A:体积/键数上限(与 submit 共用同一判定)
        if (!isProfileExtraWithinLimit(dto.profileExtra)) {
          throw new BizException(BizCode.BAD_REQUEST);
        }
        data.profileExtra = dto.profileExtra as Prisma.InputJsonValue;
      }

      if (dto.idCardNumber !== undefined && dto.idCardNumber !== row.idCardNumber) {
        if (mainland) {
          // 镜像 submit 第 2 步:校验位 → 生日派生 → 年龄 → 性别派生(改号即重派生,派生权威不漂移)
          if (!isValidChineseId(dto.idCardNumber)) {
            throw new BizException(BizCode.BAD_REQUEST);
          }
          const birthDate = extractBirthDate(dto.idCardNumber);
          if (!birthDate) {
            throw new BizException(BizCode.BAD_REQUEST);
          }
          const age = computeAge(birthDate, now);
          if (age < RECRUITMENT_MIN_AGE || age > RECRUITMENT_MAX_AGE) {
            throw new BizException(BizCode.RECRUITMENT_AGE_OUT_OF_RANGE);
          }
          data.birthDate = birthDate;
          data.genderCode = extractGenderCode(dto.idCardNumber);
        }
        // 同轮活跃去重(排除自身;镜像 submit 第 5 步;partial unique P2002 兜底同码)
        const dup = await tx.recruitmentApplication.findFirst({
          where: {
            cycleId: row.cycleId,
            idCardNumber: dto.idCardNumber,
            deletedAt: null,
            statusCode: { notIn: [...APP_INACTIVE_STATUS_CODES] },
            id: { not: row.id },
          },
          select: { id: true },
        });
        if (dup) {
          throw new BizException(BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
        }
        data.idCardNumber = dto.idCardNumber;
      }
      // 非大陆证件补录(F3 手动建档前置):birthDate 归一日期,genderCode 直存。
      // 十项收口刀A:补录同样过 18-60 年龄闸——此前非大陆证件从提交到建档全程零年龄校验
      // (submit 年龄闸包在大陆分支;promote-single 齐备闸此前也只查非空)。
      if (!mainland && dto.birthDate !== undefined) {
        const birthDate = normalizeDateOnly(dto.birthDate);
        const age = computeAge(birthDate, now);
        if (age < RECRUITMENT_MIN_AGE || age > RECRUITMENT_MAX_AGE) {
          throw new BizException(BizCode.RECRUITMENT_AGE_OUT_OF_RANGE);
        }
        data.birthDate = birthDate;
      }
      if (!mainland && dto.genderCode !== undefined) {
        data.genderCode = dto.genderCode;
      }

      let updated;
      try {
        updated = await tx.recruitmentApplication.update({ where: { id }, data });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BizException(BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
        }
        throw err;
      }

      // audit:身份字段记掩码前后值;非身份字段只记字段名(PII 不进 audit 明文,沿 D6 掩码三不)
      const maskedIdentity = (r: {
        realName: string | null;
        idCardNumber: string | null;
        birthDate: Date | null;
        genderCode: string | null;
      }): Record<string, unknown> => ({
        ...(dto.realName !== undefined
          ? { realName: r.realName ? maskName(r.realName) : null }
          : {}),
        ...(dto.idCardNumber !== undefined
          ? { idCard: r.idCardNumber ? maskIdCard(r.idCardNumber) : null }
          : {}),
        ...(dto.birthDate !== undefined || dto.idCardNumber !== undefined
          ? { hasBirthDate: r.birthDate !== null }
          : {}),
        ...(dto.genderCode !== undefined || dto.idCardNumber !== undefined
          ? { genderCode: r.genderCode }
          : {}),
      });
      await this.auditLogs.log({
        event: 'recruitment-application.update',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: identityChanged ? maskedIdentity(row) : undefined,
        after: identityChanged ? maskedIdentity(updated) : undefined,
        extra: { changedFields, identityChanged },
        tx,
      });
      return toAdminApplicationDto(updated, !canSensitive);
    });
  }

  // === helpers ===

  private buildThresholdMutation(
    currentStatus: string,
    rawMarks: unknown,
    code: ThresholdCode,
    completed: boolean,
    by: string,
    now: Date,
  ): { marks: ThresholdMarks; allComplete: boolean; nextStatus: string } {
    const marks: ThresholdMarks = { ...((rawMarks as ThresholdMarks | null) ?? {}) };
    if (completed) marks[code] = { at: now.toISOString(), by };
    else delete marks[code];
    const allComplete = allThresholdsComplete(marks);
    const nextStatus =
      currentStatus === APP_STATUS_MANUAL || currentStatus === APP_STATUS_PENDING
        ? currentStatus
        : currentStatus === APP_STATUS_PUBLICITY && allComplete
          ? APP_STATUS_PUBLICITY
          : allComplete
            ? APP_STATUS_PENDING_EVALUATION
            : APP_STATUS_VERIFIED;
    return { marks, allComplete, nextStatus };
  }

  private async safeDeleteBlob(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (err) {
      this.logger.warn(
        `recruitment certificate rejected image cleanup failed key=${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }
}

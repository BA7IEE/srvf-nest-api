import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DictItemStatus,
  Prisma,
  type RecruitmentApplication,
  type RecruitmentCycle,
} from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { auditPlaceholder } from '../../common/audit/audit-placeholder';
import { PageResultDto } from '../../common/dto/pagination.dto';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { assertEmergencyRelationCodeValid } from '../emergency-contacts/emergency-relation.validation';
import { RbacService } from '../permissions/rbac.service';
import { RealnameVerificationService } from '../realname/realname.service';
import {
  isMainlandBoundPermitCategory,
  isOcrDocument,
  maskIdCard,
  maskName,
  normalizeIdForMatch,
  normalizeNameForMatch,
} from '../realname/realname.constants';
import type { RealnameOcrResult } from '../realname/realname.types';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import { WechatService } from '../wechat/wechat.service';
import {
  APP_STATUS_MANUAL,
  APP_STATUS_PENDING_EVALUATION,
  APP_STATUS_PUBLICITY,
  APP_STATUS_REJECTED,
  APP_STATUS_VERIFIED,
  CYCLE_STATUS_OPEN,
  ELIM_STAGE_EVALUATION,
  ELIM_STAGE_MANUAL,
  ELIM_STAGE_THRESHOLD_TIMEOUT,
  ID_CARD_IMAGE_ALLOWED_MIME,
  ID_CARD_IMAGE_KEY_PREFIX,
  ID_CARD_IMAGE_MAX_BYTES,
  ID_CARD_IMAGE_SIGNED_URL_TTL_SECONDS,
  MEMBER_NO_MAX_SEQ,
  RECRUITMENT_MAX_AGE,
  RECRUITMENT_MIN_AGE,
  type ThresholdCode,
  type ThresholdMarks,
  VERIFY_OUTCOME_CATEGORY_MISMATCH,
  VERIFY_OUTCOME_FORGERY_WARNING,
  VERIFY_OUTCOME_MANUAL,
  VERIFY_OUTCOME_MATCHED,
  VERIFY_OUTCOME_MISMATCH,
  VERIFY_OUTCOME_OCR_ERROR,
  VERIFY_OUTCOME_OCR_UNCLEAR,
  ageGroupOf,
  allThresholdsComplete,
  comparePromotionOrder,
  decidePromotionIssuance,
  computeAge,
  extractBirthDate,
  extractGenderCode,
  formatMemberNo,
  formatTempNo,
  isForeignDocument,
  isMainlandId,
  isPromotable,
  isValidChineseId,
} from './recruitment.constants';
import {
  RECRUITMENT_STAGE_DICT_TYPE,
  assembleRecruitmentProgress,
} from './recruitment-progress-presenter';
import type {
  EvaluateRecruitmentApplicationDto,
  IdCardImageUrlResponseDto,
  MarkThresholdDto,
  PublicityListItemDto,
  PublicityListResponseDto,
  RecruitmentApplicationAdminDto,
  RecruitmentApplicationProgressDto,
  RecruitmentApplicationPublicDto,
  RecruitmentOcrRecognizeResponseDto,
  RecruitmentSubmitPayloadDto,
  ResolveRecruitmentApplicationDto,
} from './recruitment.dto';

// 招新一期 T3(2026-06-18):招新报名 service(评审稿 §3.2 端点 4/5/10-13 + §4 校验流程冻结)。
// 公开提交/查询无账号(actor 置空);admin 走 rbac.can。付费实名核验为最后一道闸(配套①成本纪律)。

const AUDIT_RESOURCE_TYPE = 'recruitment_application';

// multipart 文件最小形(避免依赖 @types/multer;仅取用字段)
export interface UploadedImageFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}

@Injectable()
export class RecruitmentApplicationsService {
  private readonly logger = new Logger(RecruitmentApplicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    private readonly wechat: WechatService,
    private readonly realname: RealnameVerificationService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // ============ 公开 OCR 识别预填(open/v1;无账号;OCR 改造端点 4b;评审稿 §4)============
  // 无状态:OCR 后即弃图,不落库不发 token(分叉①A)。免费前置(open 轮 + mime/大小 + 是否 OCR 类型),
  // 再付费 OCR;通道未配 27030 / 上游失败 27031 **在此浮现**(前端 UX);不清晰返 clarityOk:false(非错误)。
  // 付费调用留 pino 运维 trace(掩码;无 DB resource——尚无申请记录;cost-DoS 已登记接受)。
  async recognize(
    documentTypeCode: string,
    image: UploadedImageFile | undefined,
    meta: AuditMeta,
  ): Promise<RecruitmentOcrRecognizeResponseDto> {
    void meta; // 公开识别不写 DB 审计(无 resource);保留签名一致
    await this.findOpenCycleOrThrow(); // 无 open 轮 → 28030(省 OCR);识别不卡容量
    if (!image) {
      throw new BizException(BizCode.RECRUITMENT_ID_CARD_IMAGE_REQUIRED);
    }
    if (
      image.size > ID_CARD_IMAGE_MAX_BYTES ||
      !ID_CARD_IMAGE_ALLOWED_MIME.includes(image.mimetype)
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    // 非 OCR 类型(台胞证/外国人永居/其余)→ ocrSupported:false(前端转手填,不调付费 OCR)
    if (!isOcrDocument(documentTypeCode)) {
      return {
        ocrSupported: false,
        clarityOk: false,
        recognized: null,
        antiForgeryWarnings: [],
        documentCategory: null,
        hint: '该证件类型需人工核验,请手动填写姓名与证件号',
      };
    }
    // 付费 OCR(27030/27031 在此抛出,供前端提示;不吞)
    const ocr = await this.realname.recognize({
      documentTypeCode,
      image: image.buffer,
      mimeType: image.mimetype,
    });
    // 回乡证类别(分叉②:识别端建议性校验 + 人工最终;不在提交端权威重判)
    const categoryOk =
      documentTypeCode !== 'hk_macau_permit' || isMainlandBoundPermitCategory(ocr.documentCategory);
    // pino 运维 trace(不含姓名/证件号明文;记类型 + 清晰 + 告警数 + 类别结论)
    this.logger.log(
      `recruitment ocr recognize type=${documentTypeCode} recognized=${ocr.recognized} ` +
        `warnings=${ocr.warnings.length} category=${categoryOk ? 'ok' : VERIFY_OUTCOME_CATEGORY_MISMATCH}`,
    );
    if (!ocr.recognized) {
      return {
        ocrSupported: true,
        clarityOk: false,
        recognized: null,
        antiForgeryWarnings: ocr.warnings,
        documentCategory: ocr.documentCategory ?? null,
        hint: '证件照不清晰,请重拍清晰证件照',
      };
    }
    return {
      ocrSupported: true,
      clarityOk: true,
      recognized: { realName: ocr.name, idCardNumber: ocr.idCardNumber },
      antiForgeryWarnings: ocr.warnings,
      documentCategory: ocr.documentCategory ?? null,
      hint: categoryOk ? null : '证件类别非来往内地通行证,提交后将转人工复核',
    };
  }

  // ============ 公开提交(open/v1;无账号 pre-auth;OCR 改造 §4 校验顺序冻结)============
  // OCR 前置 + 单事务建终态(分叉④):免费校验 → code2session → 去重 → (大陆)付费 OCR 权威判定 →
  // 落图 → **单事务建终态记录(verified 原子发号 / manual_review)+ audit**。OCR 在唯一事务之前,
  // 事务内只剩本地写,失败整体回滚无残留 —— **无 pending_verification 在途态、无 FM-A 卡死类**。
  async submit(
    payload: RecruitmentSubmitPayloadDto,
    image: UploadedImageFile | undefined,
    meta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentApplicationPublicDto> {
    // 1. 当前唯一 open 轮(无 → 28030;容量满 → 28031 快速失败,省付费 OCR)
    const cycle = await this.resolveOpenCycleOrThrow();

    const foreign = isForeignDocument(payload.documentTypeCode);
    const mainland = isMainlandId(payload.documentTypeCode);

    // 2. 大陆证件:校验位 + 年龄 18-60(纯,免费;非大陆跳过,走人工)
    let birthDate: Date | null = null;
    let genderCode: string | null = null;
    if (mainland) {
      if (!isValidChineseId(payload.idCardNumber)) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
      birthDate = extractBirthDate(payload.idCardNumber);
      if (!birthDate) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
      const age = computeAge(birthDate, now);
      if (age < RECRUITMENT_MIN_AGE || age > RECRUITMENT_MAX_AGE) {
        throw new BizException(BizCode.RECRUITMENT_AGE_OUT_OF_RANGE);
      }
      genderCode = extractGenderCode(payload.idCardNumber);
    }

    // 3. 紧急联系人 relation 字典校验(免费,fail-fast,省后续外部开销;F3 #399 报名侧与 promote 一致)
    for (const contact of payload.emergencyContacts) {
      await assertEmergencyRelationCodeValid(this.prisma, contact.relation);
    }

    // 4. code2session(免费 wechat;失败沿 wechat 25030/25031 上抛)→ openid
    const { openid } = await this.wechat.code2session(payload.wechatCode);

    // 5. 同轮去重预检(身份证号;P2002 兜底见单事务;省付费 OCR)
    const dup = await this.prisma.recruitmentApplication.findFirst({
      where: {
        cycleId: cycle.id,
        idCardNumber: payload.idCardNumber,
        deletedAt: null,
        statusCode: { not: APP_STATUS_REJECTED },
      },
      select: { id: true },
    });
    if (dup) {
      throw new BizException(BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
    }

    // 6. 证件照(缺 → 28011;mime/大小校验)
    if (!image) {
      throw new BizException(BizCode.RECRUITMENT_ID_CARD_IMAGE_REQUIRED);
    }
    if (
      image.size > ID_CARD_IMAGE_MAX_BYTES ||
      !ID_CARD_IMAGE_ALLOWED_MIME.includes(image.mimetype)
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    // 7. 付费 OCR 权威判定(分叉②:仅大陆重识别;护照/回乡证/非 OCR 类型恒 manual_review,提交端不再 OCR)。
    //    分叉③:大陆 OCR 通道未配/上游失败不外抛,转 manual_review(ocr_error,不误杀)。
    let createStatus: string;
    let verifyOutcome: string;
    let ocrCalled = false;
    if (mainland) {
      const decision = await this.decideMainlandOcr(payload, image);
      createStatus = decision.status;
      verifyOutcome = decision.outcome;
      ocrCalled = true;
    } else {
      createStatus = APP_STATUS_MANUAL;
      verifyOutcome = VERIFY_OUTCOME_MANUAL;
    }

    // 8. 落图 → key(失败不建记录)
    const ext = image.mimetype === 'image/png' ? 'png' : 'jpg';
    const idCardImageKey = `${ID_CARD_IMAGE_KEY_PREFIX}/${cycle.id}/${randomUUID()}.${ext}`;
    await this.storage.putObject({
      key: idCardImageKey,
      body: image.buffer,
      contentType: image.mimetype,
    });

    // 9. 单事务建终态:verified → 原子发号(容量同事务校验,FM-C)+ tempNo;manual_review → 无 tempNo。
    //    audit submit(actor 置空)+ (大陆)audit realname-verify(每次付费 OCR 必留痕,resourceId=新 id)。
    const ageGroup = birthDate ? ageGroupOf(computeAge(birthDate, now)) : null;
    let finalApp: RecruitmentApplication;
    try {
      finalApp = await this.prisma.$transaction(async (tx) => {
        let tempNo: string | null = null;
        let verifiedAt: Date | null = null;
        if (createStatus === APP_STATUS_VERIFIED) {
          tempNo = await this.issueTempNo(tx, cycle.id);
          verifiedAt = now;
        }
        const row = await tx.recruitmentApplication.create({
          data: {
            cycleId: cycle.id,
            statusCode: createStatus,
            ...(tempNo ? { tempNo } : {}),
            ...(verifiedAt ? { verifiedAt } : {}),
            openid,
            realName: payload.realName,
            idCardNumber: payload.idCardNumber,
            ...(birthDate ? { birthDate } : {}),
            phone: payload.phone,
            detailedAddress: payload.detailedAddress,
            idCardImageKey,
            emergencyContacts: payload.emergencyContacts as unknown as Prisma.InputJsonValue,
            ...(payload.profileExtra !== undefined
              ? { profileExtra: payload.profileExtra as Prisma.InputJsonValue }
              : {}),
            documentTypeCode: payload.documentTypeCode,
            isForeigner: foreign,
            genderCode,
            ageGroup,
            cityDistrict: payload.cityDistrict,
            sourceChannel: payload.sourceChannel,
            verifyOutcome,
          },
        });
        await this.auditLogs.log({
          event: 'recruitment-application.submit',
          actorUserId: null, // 无账号自助提交(评审稿 §3.5)
          actorRoleSnap: null,
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: row.id,
          meta,
          after: { cycleId: cycle.id, createStatus, isForeigner: foreign },
          extra: {
            phone: this.maskPhone(payload.phone),
            openid: this.maskOpenid(openid),
            idCard: maskIdCard(payload.idCardNumber),
          },
          tx,
        });
        // 配套③:每次付费 OCR 调用必留痕(仅大陆走付费 OCR);掩码 + outcome + 证件类型
        if (ocrCalled) {
          await this.auditLogs.log({
            event: 'recruitment-application.realname-verify',
            actorUserId: null,
            actorRoleSnap: null,
            resourceType: AUDIT_RESOURCE_TYPE,
            resourceId: row.id,
            meta,
            extra: {
              idCard: maskIdCard(payload.idCardNumber),
              name: maskName(payload.realName),
              documentType: payload.documentTypeCode,
              outcome: verifyOutcome,
            },
            tx,
          });
        }
        return row;
      });
    } catch (err) {
      // 单事务失败(并发撞 partial unique 或任何 DB 错误)→ 第 8 步刚落 storage 的证件照成孤儿。
      // best-effort 补偿删,失败仅告警、不掩盖原错(FM-B;系统性审查 §3)。
      await this.safeDeleteOrphanImage(idCardImageKey);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
      }
      throw err;
    }

    // 10. 通知触发:小程序展示数据已落库(application 状态 + cycle 通知配置);可选 SMS 为休眠 hook
    this.logger.log(
      `recruitment notify ready app=${finalApp.id} status=${finalApp.statusCode} tempNo=${finalApp.tempNo ?? '-'}`,
    );
    return this.toPublicDto(finalApp, cycle);
  }

  // 大陆身份证 OCR 权威判定(评审稿 §3.6 矩阵;分叉③/⑤/⑥)。
  // 返回终态 + verifyOutcome;OCR 通道未配/上游失败不外抛,转 manual_review(不误杀)。
  private async decideMainlandOcr(
    payload: RecruitmentSubmitPayloadDto,
    image: UploadedImageFile,
  ): Promise<{ status: string; outcome: string }> {
    let ocr: RealnameOcrResult;
    try {
      ocr = await this.realname.recognize({
        documentTypeCode: payload.documentTypeCode,
        image: image.buffer,
        mimeType: image.mimetype,
      });
    } catch (err) {
      // 分叉③:通道未配(27030)/ 上游失败(27031)→ manual_review,不外抛(提交端永不因 OCR 硬报错)
      if (
        err instanceof BizException &&
        (err.biz === BizCode.REALNAME_CHANNEL_NOT_CONFIGURED ||
          err.biz === BizCode.REALNAME_API_FAILED)
      ) {
        this.logger.warn('recruitment mainland OCR failed → manual_review (ocr_error)');
        return { status: APP_STATUS_MANUAL, outcome: VERIFY_OUTCOME_OCR_ERROR };
      }
      throw err;
    }
    if (!ocr.recognized) {
      return { status: APP_STATUS_MANUAL, outcome: VERIFY_OUTCOME_OCR_UNCLEAR };
    }
    if (ocr.warnings.length > 0) {
      return { status: APP_STATUS_MANUAL, outcome: VERIFY_OUTCOME_FORGERY_WARNING };
    }
    const nameMatch =
      ocr.name != null &&
      normalizeNameForMatch(ocr.name) === normalizeNameForMatch(payload.realName);
    const idMatch =
      ocr.idCardNumber != null &&
      normalizeIdForMatch(ocr.idCardNumber) === normalizeIdForMatch(payload.idCardNumber);
    if (nameMatch && idMatch) {
      return { status: APP_STATUS_VERIFIED, outcome: VERIFY_OUTCOME_MATCHED };
    }
    return { status: APP_STATUS_MANUAL, outcome: VERIFY_OUTCOME_MISMATCH };
  }

  // ============ 公开查询(凭新 wx.login code → openid → 本人最近报名)============
  // 招新闭环优化 S1(评审稿 §4/§6):出参 enrich 为新人进度模型(业务态 stage + 字典文案 +
  // 门槛 todoList 真投影);statusCode 流转逻辑 / 状态机零改动,纯展示派生。
  // 覆盖边界:promote 即清 openid → 本查询天然查不到发号后记录,故 stage 不会是 volunteer、
  // memberNo 恒 null(尾段经登录态 app 侧另见,非本切片)。
  async query(wechatCode: string): Promise<RecruitmentApplicationProgressDto> {
    const { openid } = await this.wechat.code2session(wechatCode);
    const app = await this.prisma.recruitmentApplication.findFirst({
      where: { openid, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!app) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    const cycle = await this.prisma.recruitmentCycle.findFirstOrThrow({
      where: { id: app.cycleId },
    });
    const stageTextByCode = await this.loadStageTextMap();
    return assembleRecruitmentProgress(app, cycle, stageTextByCode);
  }

  // recruitment_stage 字典 → { stage code → stageText } map(§4.1「展示文案在字典」)。
  // 仅取 ACTIVE 项;字典缺项时 presenter 回退 stage 机器码(prod 由 seed 兜底齐全)。
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

  // ============ admin 列表(PII 掩码;读 PII placeholder 审计)============
  async listForAdmin(
    query: PaginationQueryDto,
    filters: { cycleId?: string; statusCode?: string },
    user: CurrentUserPayload,
  ): Promise<PageResultDto<RecruitmentApplicationAdminDto>> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const where: Prisma.RecruitmentApplicationWhereInput = {
      deletedAt: null,
      ...(filters.cycleId ? { cycleId: filters.cycleId } : {}),
      ...(filters.statusCode ? { statusCode: filters.statusCode } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.recruitmentApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.recruitmentApplication.count({ where }),
    ]);
    auditPlaceholder('recruitment-application.read.other', {
      adminId: user.id,
      count: rows.length,
    });
    return {
      items: rows.map((r) => this.toAdminDto(r, true)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ============ admin 详情(PII 全显)============
  async detailForAdmin(
    id: string,
    user: CurrentUserPayload,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const row = await this.findAppOrThrow(id);
    auditPlaceholder('recruitment-application.read.other', { adminId: user.id, applicationId: id });
    return this.toAdminDto(row, false);
  }

  // ============ admin 取证件照 signed-URL(配套②;L3;短 TTL)============
  async getIdCardImageUrl(
    id: string,
    user: CurrentUserPayload,
  ): Promise<IdCardImageUrlResponseDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const row = await this.findAppOrThrow(id);
    if (!row.idCardImageKey) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    const result = await this.storage.generateDownloadUrl({
      key: row.idCardImageKey,
      expiresIn: ID_CARD_IMAGE_SIGNED_URL_TTL_SECONDS,
    });
    auditPlaceholder('recruitment-application.id-card-image.read', {
      adminId: user.id,
      applicationId: id,
    });
    // url 是 L3,不入日志/snapshot;仅出参回显
    return { url: result.url, expiresAt: result.expiresAt };
  }

  // ============ admin 人工 resolve(manual_review → verified 发号 / rejected)============
  // OCR 改造(2026-06-22 分叉④):报名 submit 改单事务建终态,**不再产生 pending_verification 在途态**,
  // FM-A 卡死恢复/在途守卫整类退役。可解态 = manual_review 唯一(护照/回乡证/其余人工 + 大陆 OCR
  // 不匹配·防伪告警·不清晰·上游失败转入)。**人工是 manual_review 的最终权威**:approve 即放行发号
  // (含 OCR 不匹配的——人工看图后可放行真实申请人,「对不上转人工不误杀」),reject → rejected。
  // approve 走容量原子校验(FM-C,issueTempNo);reject 不受容量限。
  async resolveManual(
    id: string,
    dto: ResolveRecruitmentApplicationDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.resolve.manual');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.recruitmentApplication.findFirst({ where: { id, deletedAt: null } });
      if (!row) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
      }
      if (row.statusCode !== APP_STATUS_MANUAL) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_PENDING_MANUAL);
      }
      let updated: RecruitmentApplication;
      if (dto.approved) {
        const tempNo = await this.issueTempNo(tx, row.cycleId);
        updated = await tx.recruitmentApplication.update({
          where: { id },
          data: {
            statusCode: APP_STATUS_VERIFIED,
            tempNo,
            reviewedByUserId: user.id,
            reviewedAt: now,
            ...(dto.reviewNote !== undefined ? { reviewNote: dto.reviewNote } : {}),
          },
        });
      } else {
        updated = await tx.recruitmentApplication.update({
          where: { id },
          data: {
            statusCode: APP_STATUS_REJECTED,
            eliminationStage: ELIM_STAGE_MANUAL,
            reviewedByUserId: user.id,
            reviewedAt: now,
            ...(dto.reviewNote !== undefined ? { reviewNote: dto.reviewNote } : {}),
          },
        });
      }
      await this.auditLogs.log({
        event: 'recruitment-application.resolve-manual',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta: auditMeta,
        before: { statusCode: row.statusCode },
        after: { statusCode: updated.statusCode },
        extra: { tempNo: updated.tempNo, eliminationStage: updated.eliminationStage },
        tx,
      });
      return this.toAdminDto(updated, false);
    });
  }

  // ============ 招新二期:标/清门槛(M-3 / E-R2-2;幂等;末次完成自动推进 pending_evaluation)============
  async markThreshold(
    id: string,
    dto: MarkThresholdDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.mark.threshold');
    return this.prisma.$transaction(async (tx) => {
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
      const marks: ThresholdMarks = { ...((row.thresholdMarks as ThresholdMarks | null) ?? {}) };
      const code = dto.thresholdCode as ThresholdCode; // DTO @IsIn 已校验 ∈ THRESHOLD_CODES
      if (dto.completed) {
        marks[code] = { at: now.toISOString(), by: user.id };
      } else {
        delete marks[code];
      }
      const allComplete = allThresholdsComplete(marks);
      // 单一真相源自动推进:全完成→pending_evaluation / 否→回退 verified(仅此二态切换)
      const nextStatus = allComplete ? APP_STATUS_PENDING_EVALUATION : APP_STATUS_VERIFIED;
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
      return this.toAdminDto(updated, false);
    });
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
      return this.toAdminDto(updated, false);
    });
  }

  // ============ 招新二期:公示名单(D-R2-4;姓名 + 拟发编号,拼音序,零敏感)============
  // 计算式预览:拟发编号 = 同一确定性拼音排序 + 当前 memberNoSeq 推算(发号时一致);
  // 仅大陆可发号项编号,外籍/不可发号项 needsManualBuild=true + proposedMemberNo=null(M-1 发号前可见)。
  // 公示名单读不记审计(配置台账类,姓名本就对外公示;评审稿 §3.5)。
  async publicityList(
    cycleId: string,
    user: CurrentUserPayload,
  ): Promise<PublicityListResponseDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const cycle = await this.prisma.recruitmentCycle.findFirst({
      where: { id: cycleId, deletedAt: null },
    });
    if (!cycle) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_NOT_FOUND);
    }
    const rows = await this.prisma.recruitmentApplication.findMany({
      where: { cycleId, statusCode: APP_STATUS_PUBLICITY, deletedAt: null },
    });
    // F9(#399):公示拟发号与一键发号共享 decidePromotionIssuance —— 同序(comparePromotionOrder)、同判
    // (isPromotable + openid 未被既有 User 占用 + 批内 openid 去重)→ 预览 = 实发,杜绝「公示显示拟发号、
    // promote 时因 openid 已占用/批内重复被 skip 致编号偏移、公示失真」。openid 仅内部判定用,不入出参。
    const candidateOpenids = rows.map((r) => r.openid).filter((o): o is string => o != null);
    const boundRows = candidateOpenids.length
      ? await this.prisma.user.findMany({
          where: { openid: { in: candidateOpenids } },
          select: { openid: true },
        })
      : [];
    const boundOpenids = new Set(
      boundRows.map((r) => r.openid).filter((o): o is string => o != null),
    );
    const sorted = [...rows].sort(comparePromotionOrder);
    let seq = cycle.memberNoSeq;
    const items: PublicityListItemDto[] = decidePromotionIssuance(sorted, boundOpenids).map(
      ({ app: r, willIssue }) => {
        let proposedMemberNo: string | null = null;
        if (willIssue) {
          seq += 1;
          // 超 999 预览置 null(实际发号撞上限 → 28043);保持预览与发号一致
          proposedMemberNo = seq <= MEMBER_NO_MAX_SEQ ? formatMemberNo(cycle.year, seq) : null;
        }
        return {
          applicationId: r.id,
          realName: r.realName,
          proposedMemberNo,
          isForeigner: r.isForeigner,
          needsManualBuild: !willIssue,
        };
      },
    );
    const promotableCount = items.filter((i) => !i.needsManualBuild).length;
    return {
      cycleId: cycle.id,
      cycleYear: cycle.year,
      items,
      promotableCount,
      manualBuildCount: items.length - promotableCount,
    };
  }

  // === helpers ===

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 当前唯一 open 轮(无 → 28030);**不卡容量**(识别端点用;OCR 改造 §4)
  private async findOpenCycleOrThrow(): Promise<RecruitmentCycle> {
    const cycle = await this.prisma.recruitmentCycle.findFirst({
      where: { statusCode: CYCLE_STATUS_OPEN, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!cycle) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_NOT_OPEN);
    }
    return cycle;
  }

  // open 轮 + 容量预检(提交端用;满 → 28031 快速失败省付费 OCR;原子兜底在 issueTempNo,FM-C)
  private async resolveOpenCycleOrThrow(): Promise<RecruitmentCycle> {
    const cycle = await this.findOpenCycleOrThrow();
    if (cycle.capacity !== null) {
      const issued = await this.prisma.recruitmentApplication.count({
        where: { cycleId: cycle.id, statusCode: APP_STATUS_VERIFIED, deletedAt: null },
      });
      if (issued >= cycle.capacity) {
        throw new BizException(BizCode.RECRUITMENT_CYCLE_CAPACITY_FULL);
      }
    }
    return cycle;
  }

  // 临时编号 T{year}{seq:04d}:行级原子自增取号(并发由 Postgres 行锁串行;partial unique 兜底)。
  // 容量校验在同一行锁内做:自增后 tempNoSeq 超 capacity → 抛 28031,事务回滚撤销自增,
  // 杜绝并发 TOCTOU 超发 + 人工 resolve 旁路超发(FM-C;系统性审查 §2)。
  // 前置 resolveOpenCycleOrThrow 的容量预检仅快速失败、省付费核验,不再是唯一闸。
  private async issueTempNo(tx: Prisma.TransactionClient, cycleId: string): Promise<string> {
    const cycle = await tx.recruitmentCycle.update({
      where: { id: cycleId },
      data: { tempNoSeq: { increment: 1 } },
      select: { tempNoSeq: true, year: true, capacity: true },
    });
    if (cycle.capacity !== null && cycle.tempNoSeq > cycle.capacity) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_CAPACITY_FULL);
    }
    return formatTempNo(cycle.year, cycle.tempNoSeq);
  }

  // tx1 失败时补偿删除刚落的证件照孤儿 blob(best-effort;失败仅告警,不掩盖原错)。
  // 留存 SOP 按库行 key 删 blob,无库行的孤儿清不到;此处在建库失败路径即时清理(FM-B;系统性审查 §3)。
  private async safeDeleteOrphanImage(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch (e) {
      this.logger.warn(
        `recruitment orphan id-card image cleanup failed key=${key}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async findAppOrThrow(id: string): Promise<RecruitmentApplication> {
    const row = await this.prisma.recruitmentApplication.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    return row;
  }

  private maskPhone(phone: string): string {
    return phone.length >= 11 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '***';
  }

  private maskOpenid(openid: string): string {
    return openid.length <= 8 ? '***' : `${openid.slice(0, 4)}****${openid.slice(-4)}`;
  }

  private toPublicDto(
    app: RecruitmentApplication,
    cycle: RecruitmentCycle,
  ): RecruitmentApplicationPublicDto {
    return {
      statusCode: app.statusCode,
      tempNo: app.tempNo,
      cycleName: cycle.name,
      meetingInfo: cycle.meetingInfo,
      qqGroup: cycle.qqGroup,
      notifyTemplate: cycle.notifyTemplate as Record<string, unknown> | null,
    };
  }

  private toAdminDto(app: RecruitmentApplication, masked: boolean): RecruitmentApplicationAdminDto {
    return {
      id: app.id,
      cycleId: app.cycleId,
      statusCode: app.statusCode,
      tempNo: app.tempNo,
      realName: app.realName,
      idCardNumber: app.idCardNumber
        ? masked
          ? maskIdCard(app.idCardNumber)
          : app.idCardNumber
        : null,
      phone: app.phone ? (masked ? this.maskPhone(app.phone) : app.phone) : null,
      documentTypeCode: app.documentTypeCode,
      isForeigner: app.isForeigner,
      genderCode: app.genderCode,
      ageGroup: app.ageGroup,
      cityDistrict: app.cityDistrict,
      verifyOutcome: app.verifyOutcome,
      eliminationStage: app.eliminationStage,
      hasIdCardImage: app.idCardImageKey !== null,
      thresholdMarks:
        (app.thresholdMarks as Record<string, { at: string; by: string }> | null) ?? null,
      thresholdsComplete: allThresholdsComplete(app.thresholdMarks as ThresholdMarks | null),
      evaluationNote: app.evaluationNote,
      promotedMemberId: app.promotedMemberId,
      needsManualBuild: !isPromotable(app),
      createdAt: app.createdAt,
    };
  }
}

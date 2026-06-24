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
} from '../realname/realname.constants';
import type { RealnameOcrResult } from '../realname/realname.types';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import { WechatService } from '../wechat/wechat.service';
import {
  APP_STATUS_MANUAL,
  APP_STATUS_PENDING_EVALUATION,
  APP_STATUS_PROMOTED,
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
import { resolveBatchMatches } from './recruitment-batch-matching';
import {
  RecruitmentIdentityService,
  type ConsumedPhoneIdentity,
} from './recruitment-identity.service';
import { type OcrOutcome, classifyOcrResult, routeOcrOutcome } from './recruitment-ocr-routing';
import {
  RECRUITMENT_STAGE_DICT_TYPE,
  assembleRecruitmentProgress,
  deriveRecruitmentStage,
} from './recruitment-progress-presenter';
import type {
  BatchMarkThresholdDto,
  BatchMarkThresholdResultDto,
  BatchMarkThresholdRowResultDto,
  EvaluateRecruitmentApplicationDto,
  ExportRecruitmentApplicationsDto,
  IdCardImageUrlResponseDto,
  MarkThresholdDto,
  PublicityListItemDto,
  PublicityListResponseDto,
  RecruitmentApplicationAdminDto,
  RecruitmentApplicationProgressDto,
  RecruitmentOcrRecognizeResponseDto,
  RecruitmentSubmitPayloadDto,
  RecruitmentSubmitResultDto,
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
    private readonly identity: RecruitmentIdentityService,
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
  ): Promise<RecruitmentSubmitResultDto> {
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

    // 4. 身份链(评审稿 §3.1 两套入口;E-P4-4):小程序 wechatCode → openid,或 H5 phoneVerificationToken。
    //    至少二选一(否则 40000,不全匿名);两者皆可(小程序用户也验了手机)。code2session 免费,失败沿 25030/25031 上抛。
    //    openid 最终在终态单事务内确定(可来自 wechat 或会话行);phone 身份链落点同事务消费会话行后写。
    const hasWechat = typeof payload.wechatCode === 'string' && payload.wechatCode.length > 0;
    const hasToken =
      typeof payload.phoneVerificationToken === 'string' &&
      payload.phoneVerificationToken.length > 0;
    if (!hasWechat && !hasToken) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const wechatOpenid = hasWechat
      ? (await this.wechat.code2session(payload.wechatCode as string)).openid
      : null;
    // H5 token 非消费预校验(fail-fast:省后续付费 OCR / 落图;真正消费在终态单事务内,建记录失败回滚则 token 保活可重试)
    if (hasToken) {
      await this.identity.assertPhoneSessionValid(
        payload.phoneVerificationToken as string,
        cycle.id,
        payload.phone,
        now,
      );
    }

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

    // 7. OCR 六分流分类(评审稿 §2.1;分叉②:仅大陆重识别;护照/回乡证/非 OCR 类型 → manual,提交端不再 OCR)。
    //    分叉③:大陆 OCR 通道未配/上游失败不外抛 → outcome='ocr_error'(classifyMainlandOcr try/catch 归一)。
    let outcome: OcrOutcome;
    let recognized: { realName: string | null; idCardNumber: string | null } | null = null;
    let ocrCalled = false;
    if (mainland) {
      const cls = await this.classifyMainlandOcr(payload, image);
      outcome = cls.outcome;
      recognized = cls.recognized;
      ocrCalled = true;
    } else {
      outcome = 'manual';
    }

    // 8. 会话计数态(H5 报名前身份会话行;Q-P4-1;无会话/小程序链传 null)→ 六分流路由(纯函数,零副作用)。
    let sessionPriorCount: number | null = null;
    let sessionPriorLastOutcome: string | null = null;
    if (hasToken) {
      const state = await this.identity.readOcrAttemptState(
        payload.phoneVerificationToken as string,
      );
      sessionPriorCount = state?.ocrAttemptCount ?? 0;
      sessionPriorLastOutcome = state?.lastOcrOutcome ?? null;
    }
    const decision = routeOcrOutcome({
      outcome,
      applicantConfirmedOcrWrong: payload.applicantConfirmedOcrWrong ?? false,
      sessionPriorCount,
      sessionPriorLastOutcome,
    });

    // 9. 延迟分流(不落报名记录:模糊重拍 / 三选一待核对 / 上游首次重试):写会话行计数(若有会话,
    //    不消费 token → 身份链保活可重试)+ 返中性引导(不落图、不暴露 riskLevel/forgery);付费 OCR 仅 pino 留痕。
    if (decision.disposition !== 'submitted') {
      if (decision.sessionBump && hasToken) {
        await this.identity.writeOcrAttempt(
          payload.phoneVerificationToken as string,
          decision.sessionBump,
        );
      }
      this.logger.log(
        `recruitment ocr defer disposition=${decision.disposition} outcome=${outcome} ` +
          `phone=${this.maskPhone(payload.phone)} hasSession=${hasToken}`,
      );
      return this.buildDeferResult(decision.disposition, recognized, cycle);
    }
    const record = decision.record as NonNullable<typeof decision.record>; // disposition='submitted' → record 必有

    // 10. 落图 → key(失败不建记录)
    const ext = image.mimetype === 'image/png' ? 'png' : 'jpg';
    const idCardImageKey = `${ID_CARD_IMAGE_KEY_PREFIX}/${cycle.id}/${randomUUID()}.${ext}`;
    await this.storage.putObject({
      key: idCardImageKey,
      body: image.buffer,
      contentType: image.mimetype,
    });

    // 11. 单事务建终态:verified → 原子发号(容量同事务校验,FM-C)+ tempNo;manual_review → 无 tempNo + OCR 六分流字段。
    //    audit submit(actor 置空)+ (大陆)audit realname-verify(每次付费 OCR 必留痕,resourceId=新 id)。
    const ageGroup = birthDate ? ageGroupOf(computeAge(birthDate, now)) : null;
    let finalApp: RecruitmentApplication;
    try {
      finalApp = await this.prisma.$transaction(async (tx) => {
        // H5:事务内消费会话行(与建终态记录同事务,建失败回滚则 token 保活可重试);得手机身份链落点。
        let phoneIdentity: ConsumedPhoneIdentity | null = null;
        if (hasToken) {
          phoneIdentity = await this.identity.consumePhoneSession(
            tx,
            payload.phoneVerificationToken as string,
            cycle.id,
            now,
          );
        }
        const openid = wechatOpenid ?? phoneIdentity?.openid ?? null;
        let tempNo: string | null = null;
        let verifiedAt: Date | null = null;
        if (record.statusCode === APP_STATUS_VERIFIED) {
          tempNo = await this.issueTempNo(tx, cycle.id);
          verifiedAt = now;
        }
        const row = await tx.recruitmentApplication.create({
          data: {
            cycleId: cycle.id,
            statusCode: record.statusCode,
            ...(tempNo ? { tempNo } : {}),
            ...(verifiedAt ? { verifiedAt } : {}),
            ...(openid ? { openid } : {}),
            realName: payload.realName,
            idCardNumber: payload.idCardNumber,
            ...(birthDate ? { birthDate } : {}),
            phone: payload.phone,
            // H5 手机身份链落点(小程序链恒 null;§3.3/§3.4)
            ...(phoneIdentity
              ? {
                  phoneVerifiedAt: phoneIdentity.phoneVerifiedAt,
                  phoneVerificationMethod: phoneIdentity.phoneVerificationMethod,
                }
              : {}),
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
            // OCR 六分流落点(§2.2):verifyOutcome(机器判定,既有)+ manualReviewReason(后台分类)+
            // riskLevel(三栏分流)+ 三选一③标记 + lastOcrOutcome 快照。
            verifyOutcome: record.verifyOutcome,
            ...(record.manualReviewReason ? { manualReviewReason: record.manualReviewReason } : {}),
            ...(record.riskLevel ? { riskLevel: record.riskLevel } : {}),
            ...(record.applicantConfirmedOcrWrong ? { applicantConfirmedOcrWrong: true } : {}),
            lastOcrOutcome: record.lastOcrOutcome,
          },
        });
        await this.auditLogs.log({
          event: 'recruitment-application.submit',
          actorUserId: null, // 无账号自助提交(评审稿 §3.5)
          actorRoleSnap: null,
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: row.id,
          meta,
          after: {
            cycleId: cycle.id,
            createStatus: record.statusCode,
            isForeigner: foreign,
            riskLevel: record.riskLevel,
          },
          extra: {
            phone: this.maskPhone(payload.phone),
            openid: openid ? this.maskOpenid(openid) : null,
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
              outcome: record.verifyOutcome,
            },
            tx,
          });
        }
        return row;
      });
    } catch (err) {
      // 单事务失败(并发撞 partial unique 或任何 DB 错误)→ 第 10 步刚落 storage 的证件照成孤儿。
      // best-effort 补偿删,失败仅告警、不掩盖原错(FM-B;系统性审查 §3)。
      await this.safeDeleteOrphanImage(idCardImageKey);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
      }
      throw err;
    }

    // 12. 通知触发:小程序展示数据已落库(application 状态 + cycle 通知配置);可选 SMS 为休眠 hook
    this.logger.log(
      `recruitment notify ready app=${finalApp.id} status=${finalApp.statusCode} tempNo=${finalApp.tempNo ?? '-'}`,
    );
    return this.toSubmitResult(finalApp, cycle);
  }

  // 大陆身份证 OCR 六分流分类(评审稿 §2.1/§3.6 矩阵;复用纯函数 classifyOcrResult)。
  // 返回 outcome(matched/mismatch/forgery_warning/ocr_unclear/ocr_error)+ OCR 识别值(供 mismatch 三选一回填);
  // OCR 通道未配/上游失败不外抛 → outcome='ocr_error'(提交端永不因 OCR 硬报错,分叉③)。
  private async classifyMainlandOcr(
    payload: RecruitmentSubmitPayloadDto,
    image: UploadedImageFile,
  ): Promise<{
    outcome: OcrOutcome;
    recognized: { realName: string | null; idCardNumber: string | null } | null;
  }> {
    let ocr: RealnameOcrResult;
    try {
      ocr = await this.realname.recognize({
        documentTypeCode: payload.documentTypeCode,
        image: image.buffer,
        mimeType: image.mimetype,
      });
    } catch (err) {
      if (
        err instanceof BizException &&
        (err.biz === BizCode.REALNAME_CHANNEL_NOT_CONFIGURED ||
          err.biz === BizCode.REALNAME_API_FAILED)
      ) {
        this.logger.warn(
          'recruitment mainland OCR failed → ocr_error (六分流:首次重试/连续 2 次落系统异常)',
        );
        return { outcome: 'ocr_error', recognized: null };
      }
      throw err;
    }
    const outcome = classifyOcrResult(
      {
        recognized: ocr.recognized,
        name: ocr.name,
        idCardNumber: ocr.idCardNumber,
        warnings: ocr.warnings,
      },
      { realName: payload.realName, idCardNumber: payload.idCardNumber },
    );
    return {
      outcome,
      recognized: ocr.recognized ? { realName: ocr.name, idCardNumber: ocr.idCardNumber } : null,
    };
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
    filters: { cycleId?: string; statusCode?: string; riskLevel?: string },
    user: CurrentUserPayload,
  ): Promise<PageResultDto<RecruitmentApplicationAdminDto>> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const where: Prisma.RecruitmentApplicationWhereInput = {
      deletedAt: null,
      ...(filters.cycleId ? { cycleId: filters.cycleId } : {}),
      ...(filters.statusCode ? { statusCode: filters.statusCode } : {}),
      // S4b:人工队列三栏过滤(§2.4;normal/high/system)
      ...(filters.riskLevel ? { riskLevel: filters.riskLevel } : {}),
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

  // ============ admin 详情(敏感字段分级;S3 §11.1)============
  // 入口闸 = read.record(普通查看);持 read.sensitive → 明文证件号/手机,仅 read.record → 脱敏详情。
  // 响应字段集不随码变(只 masking 随码;biz-admin 同持双码,行为不回退)。
  async detailForAdmin(
    id: string,
    user: CurrentUserPayload,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const row = await this.findAppOrThrow(id);
    const canSensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');
    auditPlaceholder('recruitment-application.read.other', { adminId: user.id, applicationId: id });
    return this.toAdminDto(row, !canSensitive);
  }

  // ============ 招新闭环优化 S6:批量导出 CSV(评审稿 §8.1;脱敏随码复用 S3 toAdminDto,零第二套)============
  // 入口闸 = read.record(同 list/detail);**持 read.sensitive → 明文列 / 仅 read.record → 脱敏列**
  //(S3 §11.1 分级):脱敏单一真相源在 toAdminDto(masked = !canSensitive),CSV 仅消费已脱敏 DTO —— 明文
  // 绝不在无 read.sensitive 时出列。读操作 export placeholder 审计(含 admin / 范围 filter / 脱敏级;
  // 复用既有 read.other pino 事件 + operation 区分,沿 registrations export 范式,不扩 locked AuditEvent union)。
  // 返回纯 CSV 字符串(controller 包 StreamableFile + BOM,沿 activity-registrations CSV 导出范式;不引新依赖)。
  async exportApplicationsCsv(
    dto: ExportRecruitmentApplicationsDto,
    user: CurrentUserPayload,
  ): Promise<string> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const canSensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');
    const filter = dto.filter ?? 'all';

    const where: Prisma.RecruitmentApplicationWhereInput = {
      deletedAt: null,
      ...(dto.cycleId ? { cycleId: dto.cycleId } : {}),
      ...this.exportStatusWhere(filter),
    };
    const rows = await this.prisma.recruitmentApplication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    // threshold-incomplete:verified 且门槛未齐(post-filter,沿 stats tracking 口径;
    // verified 门槛齐为瞬态,markThreshold 末次完成即自动→pending_evaluation)。
    const filtered =
      filter === 'threshold-incomplete'
        ? rows.filter((r) => !allThresholdsComplete(r.thresholdMarks as ThresholdMarks | null))
        : rows;

    // 脱敏随码:复用 S3 toAdminDto(masked = !canSensitive)→ 零第二套口径。
    const dtos = filtered.map((r) => this.toAdminDto(r, !canSensitive));

    auditPlaceholder('recruitment-application.read.other', {
      adminId: user.id,
      operation: 'export',
      filter,
      maskLevel: canSensitive ? 'plain' : 'masked',
      rowsCount: dtos.length,
    });

    return this.formatApplicationsCsv(dtos);
  }

  // 导出筛选 → statusCode where(threshold-incomplete 先按 verified 取,再 post-filter 门槛未齐)。
  private exportStatusWhere(filter: string): Prisma.RecruitmentApplicationWhereInput {
    switch (filter) {
      case 'manual':
        return { statusCode: APP_STATUS_MANUAL };
      case 'verified':
      case 'threshold-incomplete':
        return { statusCode: APP_STATUS_VERIFIED };
      case 'pending-evaluation':
        return { statusCode: APP_STATUS_PENDING_EVALUATION };
      case 'publicity':
        return { statusCode: APP_STATUS_PUBLICITY };
      case 'promoted':
        return { statusCode: APP_STATUS_PROMOTED };
      case 'rejected':
        return { statusCode: APP_STATUS_REJECTED };
      case 'all':
      default:
        return {};
    }
  }

  // 简单 CSV encoder(沿 activity-registrations「不引入新依赖」):双引号转义 + 含逗号/换行/双引号字段加引号。
  // 入参为**已脱敏** RecruitmentApplicationAdminDto(idCardNumber/phone 列已随 S3 码掩码/明文);CSV 只投影,不二次脱敏。
  private formatApplicationsCsv(rows: RecruitmentApplicationAdminDto[]): string {
    const HEADERS = [
      'id',
      'cycle_id',
      'status_code',
      'temp_no',
      'real_name',
      'id_card_number',
      'phone',
      'document_type_code',
      'is_foreigner',
      'gender_code',
      'age_group',
      'city_district',
      'verify_outcome',
      'risk_level',
      'manual_review_reason',
      'elimination_stage',
      'thresholds_complete',
      'needs_manual_build',
      'created_at',
    ];
    const escapeField = (value: string | number | boolean | Date | null): string => {
      if (value === null || value === undefined) return '';
      const s = value instanceof Date ? value.toISOString() : String(value);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const lines: string[] = [HEADERS.join(',')];
    for (const r of rows) {
      lines.push(
        [
          escapeField(r.id),
          escapeField(r.cycleId),
          escapeField(r.statusCode),
          escapeField(r.tempNo),
          escapeField(r.realName),
          escapeField(r.idCardNumber),
          escapeField(r.phone),
          escapeField(r.documentTypeCode),
          escapeField(r.isForeigner),
          escapeField(r.genderCode),
          escapeField(r.ageGroup),
          escapeField(r.cityDistrict),
          escapeField(r.verifyOutcome),
          escapeField(r.riskLevel),
          escapeField(r.manualReviewReason),
          escapeField(r.eliminationStage),
          escapeField(r.thresholdsComplete),
          escapeField(r.needsManualBuild),
          escapeField(r.createdAt),
        ].join(','),
      );
    }
    return lines.join('\n');
  }

  // ============ admin 取证件照 signed-URL(配套②;L3;短 TTL;S3:敏感查看 read.sensitive)============
  async getIdCardImageUrl(
    id: string,
    user: CurrentUserPayload,
  ): Promise<IdCardImageUrlResponseDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.sensitive');
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

  // 落记录提交结果(outcome='submitted';verified/manual_review;statusCode 为中性机器态,不含 riskLevel/分类)。
  private toSubmitResult(
    app: RecruitmentApplication,
    cycle: RecruitmentCycle,
  ): RecruitmentSubmitResultDto {
    return {
      outcome: 'submitted',
      statusCode: app.statusCode,
      tempNo: app.tempNo,
      stage: null,
      stageText: null,
      nextAction: null,
      hint: null,
      recognized: null,
      cycleName: cycle.name,
      meetingInfo: cycle.meetingInfo,
      qqGroup: cycle.qqGroup,
      notifyTemplate: cycle.notifyTemplate as Record<string, unknown> | null,
    };
  }

  // 延迟引导结果(不落记录;六分流 retake/confirm/retry)。**中性文案,绝不暴露 riskLevel/forgery**(goal 三③隐私口径):
  // - retake/confirm 经 deriveRecruitmentStage 派生会话态 stage(单一真相源)+ 字典文案;retry 无业务态(系统瞬态)。
  // - confirm(mismatch 三选一)回带 OCR 识别值供申请人选「①用 OCR 回填」(申请人本人 PII,等同 recognize 端)。
  private async buildDeferResult(
    disposition: 'retake' | 'confirm' | 'retry',
    recognized: { realName: string | null; idCardNumber: string | null } | null,
    cycle: RecruitmentCycle,
  ): Promise<RecruitmentSubmitResultDto> {
    let stage: string | null = null;
    let stageText: string | null = null;
    let nextAction: string | null = null;
    let hint: string | null = null;
    if (disposition === 'retake') {
      const d = deriveRecruitmentStage({
        statusCode: APP_STATUS_VERIFIED, // 占位:requiresRetake 短路在 switch 之前,statusCode 不参与
        thresholdMarks: null,
        tempNo: null,
        promotedMemberId: null,
        requiresRetake: true,
      });
      stage = d.stage; // STAGE_RETAKE
      nextAction = d.nextAction; // NEXT_ACTION_RETAKE
      hint = '证件照不清晰或需重拍,请重新拍摄清晰的证件原件后再次提交';
    } else if (disposition === 'confirm') {
      const d = deriveRecruitmentStage({
        statusCode: APP_STATUS_VERIFIED, // 占位:pendingOcrConfirm 短路
        thresholdMarks: null,
        tempNo: null,
        promotedMemberId: null,
        pendingOcrConfirm: true,
      });
      stage = d.stage; // STAGE_CONFIRM
      nextAction = d.nextAction; // NEXT_ACTION_CONFIRM_OCR
      hint = '证件识别与填写不一致,请核对:使用识别结果、修改填写、或确认识别有误后再次提交';
    } else {
      // retry(上游首次失败):系统瞬态,无业务 stage;中性提示重试。
      hint = '当前核验繁忙,请稍后重试';
    }
    if (stage !== null) {
      const map = await this.loadStageTextMap();
      stageText = map.get(stage) ?? stage;
    }
    return {
      outcome: disposition,
      statusCode: null,
      tempNo: null,
      stage,
      stageText,
      nextAction,
      hint,
      recognized: disposition === 'confirm' ? recognized : null,
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
      riskLevel: app.riskLevel,
      manualReviewReason: app.manualReviewReason,
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

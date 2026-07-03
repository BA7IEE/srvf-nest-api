import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DictItemStatus,
  Prisma,
  type RecruitmentApplication,
  type RecruitmentCycle,
} from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
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
  APP_STATUS_REJECTED,
  APP_STATUS_VERIFIED,
  CYCLE_STATUS_OPEN,
  ELIM_STAGE_MANUAL,
  ID_CARD_CROP_IMAGE_KEY_PREFIX,
  ID_CARD_IMAGE_ALLOWED_MIME,
  ID_CARD_IMAGE_KEY_PREFIX,
  ID_CARD_IMAGE_MAX_BYTES,
  ID_CARD_PORTRAIT_IMAGE_KEY_PREFIX,
  RECRUITMENT_MAX_AGE,
  RECRUITMENT_MIN_AGE,
  VERIFY_OUTCOME_CATEGORY_MISMATCH,
  ageGroupOf,
  computeAge,
  extractBirthDate,
  extractGenderCode,
  formatTempNo,
  isForeignDocument,
  isMainlandId,
  isValidChineseId,
} from './recruitment.constants';
import {
  RecruitmentIdentityService,
  type ConsumedPhoneIdentity,
} from './recruitment-identity.service';
import { type OcrOutcome, classifyOcrResult, routeOcrOutcome } from './recruitment-ocr-routing';
import {
  RECRUITMENT_STAGE_DICT_TYPE,
  assembleRecruitmentProgress,
} from './recruitment-progress-presenter';
import {
  buildOcrRecognizeDetail,
  buildRecruitmentDeferResult,
  maskOpenid,
  maskPhone,
  toAdminApplicationDto,
  toRecruitmentSubmitResult,
} from './recruitment-applications.presenter';
import type {
  RecruitmentApplicationAdminDto,
  RecruitmentApplicationProgressDto,
  RecruitmentOcrRecognizeResponseDto,
  RecruitmentSubmitPayloadDto,
  RecruitmentSubmitResultDto,
  ResolveRecruitmentApplicationDto,
} from './recruitment.dto';

// 招新一期 T3(2026-06-18):招新报名 service(评审稿 §3.2 端点 4/5/10-13 + §4 校验流程冻结)。
// 公开提交/查询无账号(actor 置空);admin 走 rbac.can。付费实名核验为最后一道闸(配套①成本纪律)。
//
// god-service 拆分(2026-06-28):本 service 收口在「公开申请人自助管道」+ 发临时编号的两条路径
// (submit 自动 / resolveManual 人工,共享 issueTempNo 容量原子兜底 FM-C)。其余职责已抽离:
// 视图塑形/脱敏/CSV → recruitment-applications.presenter.ts(纯函数);admin 读面 →
// recruitment-applications-query.service.ts;核验后评审写动作(标门槛/批量/评定)→
// recruitment-application-review.service.ts(沿 architecture-boundary §3.1/§3.2/§4)。

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
        ocrDetail: null,
      };
    }
    // dev 安全诊断(logger.debug:生产默认不输出;无 PII)——核对 multipart 文件是否正常读入
    this.logger.debug(
      `[recruitment ocr recognize] documentType=${documentTypeCode} mime=${image.mimetype} ` +
        `size=${image.size} bufferLen=${image.buffer.length}`,
    );
    // 付费 OCR(27030/27031 在此抛出,供前端提示;不吞)。映射失败(IDCardInfo 缺)亦走 27031 不当不清晰。
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
    // 鉴伪版充分利用:顾问式扩展回显(字段级/卡片级告警 + 证件类型;不改判定)。不清晰时一并回显——
    // 此时字段级 reflect/incomplete 最能帮申请人定位「哪栏拍糊/反光」。**裁剪图 base64 绝不进响应**(纯函数不取)。
    const ocrDetail = buildOcrRecognizeDetail(ocr);
    if (!ocr.recognized) {
      return {
        ocrSupported: true,
        clarityOk: false,
        recognized: null,
        antiForgeryWarnings: ocr.warnings,
        documentCategory: ocr.documentCategory ?? null,
        hint: '证件照不清晰,请重拍清晰证件照',
        ocrDetail,
      };
    }
    return {
      ocrSupported: true,
      clarityOk: true,
      recognized: { realName: ocr.name, idCardNumber: ocr.idCardNumber },
      antiForgeryWarnings: ocr.warnings,
      documentCategory: ocr.documentCategory ?? null,
      hint: categoryOk ? null : '证件类别非来往内地通行证,提交后将转人工复核',
      ocrDetail,
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
    // 鉴伪版充分利用:mainland OCR 完整结果(扩展字段 + 裁剪图 base64);仅 submitted 路径消费(落 4 列 + 2 裁剪图)。
    let mainlandOcr: RealnameOcrResult | null = null;
    if (mainland) {
      const cls = await this.classifyMainlandOcr(payload, image);
      outcome = cls.outcome;
      recognized = cls.recognized;
      mainlandOcr = cls.ocr;
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
          `phone=${maskPhone(payload.phone)} hasSession=${hasToken}`,
      );
      // 文案字典仅在有业务态(retake/confirm)时加载;retry 系统瞬态无 stage → 不查库(保留原行为)。
      const stageTextByCode =
        decision.disposition === 'retry'
          ? new Map<string, string>()
          : await this.loadStageTextMap();
      return buildRecruitmentDeferResult(decision.disposition, recognized, cycle, stageTextByCode);
    }
    const record = decision.record as NonNullable<typeof decision.record>; // disposition='submitted' → record 必有

    // 10. 落图 → key(失败不建记录)。collect 全部已落 storage key,失败逐个 best-effort 补偿删(FM-B 扩为多 key)。
    //     主证件照 putObject + 两次裁剪图 storeCropImage 与下方事务同属一个失败域(见 catch)——
    //     任一环节抛错,此前已成功落 storage 的 key 都不留孤儿(系统性审查 review #484 G3)。
    const ext = image.mimetype === 'image/png' ? 'png' : 'jpg';
    const idCardImageKey = `${ID_CARD_IMAGE_KEY_PREFIX}/${cycle.id}/${randomUUID()}.${ext}`;
    const storedKeys: string[] = [idCardImageKey];

    // 11. 单事务建终态:verified → 原子发号(容量同事务校验,FM-C)+ tempNo;manual_review → 无 tempNo + OCR 六分流字段。
    //    audit submit(actor 置空)+ (大陆)audit realname-verify(每次付费 OCR 必留痕,resourceId=新 id)。
    const ageGroup = birthDate ? ageGroupOf(computeAge(birthDate, now)) : null;
    let finalApp: RecruitmentApplication;
    try {
      await this.storage.putObject({
        key: idCardImageKey,
        body: image.buffer,
        contentType: image.mimetype,
      });
      // 10b. 鉴伪版充分利用:主体框 / 头像裁剪图(腾讯返 base64 JPEG)解码入库(仅 mainland 鉴伪版返回时);
      //      缺省/接口未返 → key 留 null 不阻断提交(E3/E7)。裁剪图入库后即弃 base64(不入日志)。
      const idCardCropImageKey = await this.storeCropImage(
        mainlandOcr?.cardImageBase64,
        ID_CARD_CROP_IMAGE_KEY_PREFIX,
        cycle.id,
        storedKeys,
      );
      const idCardPortraitImageKey = await this.storeCropImage(
        mainlandOcr?.portraitImageBase64,
        ID_CARD_PORTRAIT_IMAGE_KEY_PREFIX,
        cycle.id,
        storedKeys,
      );

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
            // 鉴伪版充分利用(§5):4 OCR 列(顾问式存档,来自 extendedFields.*.content;缺 → null)+ 2 裁剪图 key
            // (storeCropImage 返 string|null)。**gender/birth 不在此组**(仍由 idCardNumber 推导,见第 2 步,不被 OCR 覆盖)。
            idCardCropImageKey,
            idCardPortraitImageKey,
            ocrAddress: mainlandOcr?.extendedFields?.address?.content ?? null,
            ocrNation: mainlandOcr?.extendedFields?.nation?.content ?? null,
            ocrAuthority: mainlandOcr?.extendedFields?.authority?.content ?? null,
            ocrValidDate: mainlandOcr?.extendedFields?.validDate?.content ?? null,
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
            phone: maskPhone(payload.phone),
            openid: openid ? maskOpenid(openid) : null,
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
      // 落图(原图/两次裁剪图 putObject)或单事务失败(并发撞 partial unique 或任何 DB 错误)→
      // 此前已成功落 storage 的证件照 + 裁剪图成孤儿。best-effort 逐个补偿删 storedKeys 里的 key
      // (裁剪图仅在 storeCropImage 自身 putObject 成功后才推入,失败的那次不会重复进来;
      // 删除本就未写入的 key 是空操作,不影响原错误照抛),失败仅告警、不掩盖原错
      // (FM-B;系统性审查 review #484 G3)。
      for (const k of storedKeys) {
        await this.safeDeleteOrphanImage(k);
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
      }
      throw err;
    }

    // 12. 通知触发:小程序展示数据已落库(application 状态 + cycle 通知配置);可选 SMS 为休眠 hook
    this.logger.log(
      `recruitment notify ready app=${finalApp.id} status=${finalApp.statusCode} tempNo=${finalApp.tempNo ?? '-'}`,
    );
    return toRecruitmentSubmitResult(finalApp, cycle);
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
    // 鉴伪版充分利用:回带完整 OCR 结果(扩展字段 + 裁剪图 base64),供 submit 落 4 列 + 2 裁剪图;
    // ocr_error(上游失败/通道未配)→ null(列/裁剪图全留 null,E7)。
    ocr: RealnameOcrResult | null;
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
        return { outcome: 'ocr_error', recognized: null, ocr: null };
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
      ocr,
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

  // ============ admin 人工 resolve(manual_review → verified 发号 / rejected)============
  // OCR 改造(2026-06-22 分叉④):报名 submit 改单事务建终态,**不再产生 pending_verification 在途态**,
  // FM-A 卡死恢复/在途守卫整类退役。可解态 = manual_review 唯一(护照/回乡证/其余人工 + 大陆 OCR
  // 不匹配·防伪告警·不清晰·上游失败转入)。**人工是 manual_review 的最终权威**:approve 即放行发号
  // (含 OCR 不匹配的——人工看图后可放行真实申请人,「对不上转人工不误杀」),reject → rejected。
  // approve 走容量原子校验(FM-C,issueTempNo);reject 不受容量限。
  // 注:与 submit 同享 issueTempNo(FM-C 唯一真相源),故 resolveManual 留本 service,不入 review service。
  async resolveManual(
    id: string,
    dto: ResolveRecruitmentApplicationDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.resolve.manual');
    const canSensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');
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
      return toAdminApplicationDto(updated, !canSensitive);
    });
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

  // 鉴伪版充分利用:裁剪图 base64 解码入库(主体框 / 头像;仅 mainland 鉴伪版返回时)。
  // base64 缺省/空 → 不落、返 null(列留空不阻断提交,E3/E7);落成功 → key 推入 storedKeys 供事务失败补偿删。
  // 裁剪图为腾讯返 JPEG base64,ext 恒 jpg;base64 入库后即弃(不入日志,L3)。
  private async storeCropImage(
    base64: string | null | undefined,
    prefix: string,
    cycleId: string,
    storedKeys: string[],
  ): Promise<string | null> {
    if (!base64) return null;
    const key = `${prefix}/${cycleId}/${randomUUID()}.jpg`;
    await this.storage.putObject({
      key,
      body: Buffer.from(base64, 'base64'),
      contentType: 'image/jpeg',
    });
    storedKeys.push(key);
    return key;
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
}

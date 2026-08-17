import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Prisma, type RecruitmentApplication } from '@prisma/client';

import appConfig from '../../config/app.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttachmentContentValidator } from '../attachments/attachment-content-validator';
import { assertEmergencyRelationCodeValid } from '../emergency-contacts/emergency-relation.validation';
import { RbacService } from '../permissions/rbac.service';
import { RealnameVerificationService } from '../realname/realname.service';
import { maskIdCard, maskName } from '../realname/realname.constants';
import type { RealnameOcrResult } from '../realname/realname.types';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import { WechatService } from '../wechat/wechat.service';
import {
  APP_INACTIVE_STATUS_CODES,
  APP_STATUS_MANUAL,
  APP_STATUS_REJECTED,
  APP_STATUS_VERIFIED,
  ELIM_STAGE_MANUAL,
  ID_CARD_CROP_IMAGE_KEY_PREFIX,
  ID_CARD_IMAGE_ALLOWED_MIME,
  ID_CARD_IMAGE_KEY_PREFIX,
  ID_CARD_IMAGE_MAX_BYTES,
  ID_CARD_PORTRAIT_IMAGE_KEY_PREFIX,
  SIGNATURE_IMAGE_KEY_PREFIX,
  RECRUITMENT_MAX_AGE,
  RECRUITMENT_MIN_AGE,
  ageGroupOf,
  computeAge,
  extractBirthDate,
  extractGenderCode,
  formatTempNo,
  isForeignDocument,
  isMainlandId,
  isProfileExtraWithinLimit,
  isValidChineseId,
} from './recruitment.constants';
import { withdrawClaimsOnApplicationTerminal } from './recruitment-application-terminal';
import { recomputeCertificateThresholds } from './recruitment-certificate-threshold-derive';
import { RecruitmentApplicationProgressService } from './recruitment-application-progress.service';
import { RecruitmentCycleAccessService } from './recruitment-cycle-access.service';
import { RecruitmentOcrService } from './recruitment-ocr.service';
import {
  RecruitmentIdentityService,
  type ConsumedPhoneIdentity,
} from './recruitment-identity.service';
import { type OcrOutcome, routeOcrOutcome } from './recruitment-ocr-routing';
import {
  buildRecruitmentDeferResult,
  maskOpenid,
  maskPhone,
  toAdminApplicationDto,
  toRecruitmentSubmitResult,
} from './recruitment-applications.presenter';
import { recruitmentDuplicateExceptionForP2002 } from './recruitment-prisma-errors';
import type {
  RecruitmentApplicationAdminDto,
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
    // 第三域第四刀:周期查找 / OCR 识别 / 进度查询三族抽出,本 service 保留同名薄委托作为唯一入口。
    private readonly cycles: RecruitmentCycleAccessService,
    private readonly ocr: RecruitmentOcrService,
    private readonly progress: RecruitmentApplicationProgressService,
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    private readonly wechat: WechatService,
    private readonly realname: RealnameVerificationService,
    private readonly identity: RecruitmentIdentityService,
    private readonly contentValidator: AttachmentContentValidator,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  // ============ 公开提交(open/v1;无账号 pre-auth;OCR 改造 §4 校验顺序冻结)============
  // OCR 前置 + 单事务建终态(分叉④):免费校验 → code2session → 去重 → (大陆)付费 OCR 权威判定 →
  // 落图 → **单事务建终态记录(verified 原子发号 / manual_review)+ audit**。OCR 在唯一事务之前,
  // 事务内只剩本地写,失败整体回滚无残留 —— **无 pending_verification 在途态、无 FM-A 卡死类**。

  // ============ OCR 识别 / 进度查询:薄委托(Phase 6-B 第三域第四刀)============
  //
  // 实现已迁至 recruitment-ocr.service.ts / recruitment-application-progress.service.ts
  // (仅"搬家":配额闸 / 分类 / 裁剪图存取 / 三条锚点查找次序逐字不变)。
  // 本 service 仍是本模块**唯一**对外入口 —— controller 调用面逐字不变。

  async recognize(...args: Parameters<RecruitmentOcrService['recognize']>) {
    return this.ocr.recognize(...args);
  }

  async query(...args: Parameters<RecruitmentApplicationProgressService['query']>) {
    return this.progress.query(...args);
  }

  async submit(
    payload: RecruitmentSubmitPayloadDto,
    image: UploadedImageFile | undefined,
    signatureImage: UploadedImageFile | undefined,
    meta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentSubmitResultDto> {
    // 0. F5 知情同意闸(评审稿 §2.8;⚠️ 契约收紧):必须显式 true(缺省由 DTO @IsBoolean 先挡)。
    if (payload.privacyConsentAccepted !== true) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    // 1. 当前唯一 open 轮(无 → 28030;容量满 → 28031 快速失败,省付费 OCR)
    const cycle = await this.cycles.resolveOpenCycleOrThrow();

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

    // 3b. 十项收口刀A:profileExtra 体积/键数上限(免费 fail-fast;与 F2 admin 改资料共用同一判定)
    if (payload.profileExtra && !isProfileExtraWithinLimit(payload.profileExtra)) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    // 4. 身份链:已验手机 phoneVerificationToken 必填;wechatCode 可选(提供时另取 openid)。
    //    小程序与 H5 均先验手机,缺 token → 40000。code2session 免费,失败沿 25030/25031 上抛。
    //    openid 最终在终态单事务内确定(可来自 wechat 或会话行);phone 身份链落点同事务消费会话行后写。
    const hasWechat = typeof payload.wechatCode === 'string' && payload.wechatCode.length > 0;
    const hasToken =
      typeof payload.phoneVerificationToken === 'string' &&
      payload.phoneVerificationToken.length > 0;
    if (!hasToken) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const wechatOpenid = hasWechat
      ? (await this.wechat.code2session(payload.wechatCode as string)).openid
      : null;
    // H5 token 非消费预校验(fail-fast:省后续付费 OCR / 落图;真正消费在终态单事务内,建记录失败回滚则 token 保活可重试)
    if (hasToken) {
      await this.identity.assertPhoneSessionValid(
        payload.phoneVerificationToken,
        cycle.id,
        payload.phone,
        now,
      );
    }

    // 5. 同轮去重预检(身份证号;P2002 兜底见单事务;省付费 OCR)。排除态集合共用
    //    APP_INACTIVE_STATUS_CODES(现 = rejected;F6 撤销落地后追加 withdrawn,单一真相源)。
    const dup = await this.prisma.recruitmentApplication.findFirst({
      where: {
        cycleId: cycle.id,
        idCardNumber: payload.idCardNumber,
        deletedAt: null,
        statusCode: { notIn: [...APP_INACTIVE_STATUS_CODES] },
      },
      select: { id: true },
    });
    if (dup) {
      throw new BizException(BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
    }

    // 5b. F1 防重前移(评审稿 §2.5/E-U-2):同轮活跃报名 openid / phone 去重,付费 OCR **之前**
    //     命中即拒 —— 换证件号也无法用同一微信/手机重复触发付费 OCR。openid 仅小程序链可判
    //     (code2session 已在第 4 步换得;H5 会话 openid 恒 null 不参与);phone 恒可判(payload 必填)。
    //     共用手机的罕见正常场景由 admin 单人手动建档兜底(评审稿已记为已知取舍)。
    if (wechatOpenid !== null) {
      const dupOpenid = await this.prisma.recruitmentApplication.findFirst({
        where: {
          cycleId: cycle.id,
          openid: wechatOpenid,
          deletedAt: null,
          statusCode: { notIn: [...APP_INACTIVE_STATUS_CODES] },
        },
        select: { id: true },
      });
      if (dupOpenid) {
        throw new BizException(BizCode.RECRUITMENT_DUPLICATE_OPENID_ACTIVE);
      }
    }
    const dupPhone = await this.prisma.recruitmentApplication.findFirst({
      where: {
        cycleId: cycle.id,
        phone: payload.phone,
        deletedAt: null,
        statusCode: { notIn: [...APP_INACTIVE_STATUS_CODES] },
      },
      select: { id: true },
    });
    if (dupPhone) {
      throw new BizException(BizCode.RECRUITMENT_DUPLICATE_PHONE_ACTIVE);
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
    // 6b. 签名图必填;校验镜像 idCardImage:jpeg/png ≤5MB → 否则 40000。
    if (
      !signatureImage ||
      signatureImage.size > ID_CARD_IMAGE_MAX_BYTES ||
      !ID_CARD_IMAGE_ALLOWED_MIME.includes(signatureImage.mimetype)
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    this.contentValidator.validateFromBuffer({ mime: image.mimetype, buffer: image.buffer });
    this.contentValidator.validateFromBuffer({
      mime: signatureImage.mimetype,
      buffer: signatureImage.buffer,
    });

    // 7. OCR 六分流分类(评审稿 §2.1;分叉②:仅大陆重识别;护照/回乡证/非 OCR 类型 → manual,提交端不再 OCR)。
    //    分叉③:大陆 OCR 通道未配/上游失败不外抛 → outcome='ocr_error'(classifyMainlandOcr try/catch 归一)。
    let outcome: OcrOutcome;
    let recognized: { realName: string | null; idCardNumber: string | null } | null = null;
    let ocrCalled = false;
    // 鉴伪版充分利用:mainland OCR 完整结果(扩展字段 + 裁剪图 base64);仅 submitted 路径消费(落 4 列 + 2 裁剪图)。
    let mainlandOcr: RealnameOcrResult | null = null;
    if (mainland) {
      // F1 成本线(评审稿 §2.5/E-U-1):付费 OCR 前按 IP 北京自然日封顶(与 recognize 共享计数;超限 28060)。
      await this.ocr.assertOcrDailyQuotaAndCount(meta.ip, now);
      const cls = await this.ocr.classifyMainlandOcr(payload, image);
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
      const state = await this.identity.readOcrAttemptState(payload.phoneVerificationToken);
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
        await this.identity.writeOcrAttempt(payload.phoneVerificationToken, decision.sessionBump);
      }
      this.logger.log({
        event: 'recruitment.ocr-submit.deferred',
        operation: 'submit',
        requestId: meta.requestId,
      });
      // 文案字典仅在有业务态(retake/confirm)时加载;retry 系统瞬态无 stage → 不查库(保留原行为)。
      const stageTextByCode =
        decision.disposition === 'retry'
          ? new Map<string, string>()
          : await this.progress.loadStageTextMap();
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
      const idCardCropImageKey = await this.ocr.storeCropImage(
        mainlandOcr?.cardImageBase64,
        ID_CARD_CROP_IMAGE_KEY_PREFIX,
        cycle.id,
        storedKeys,
      );
      const idCardPortraitImageKey = await this.ocr.storeCropImage(
        mainlandOcr?.portraitImageBase64,
        ID_CARD_PORTRAIT_IMAGE_KEY_PREFIX,
        cycle.id,
        storedKeys,
      );
      // 10c. 签名图落图(新提交必填;与主图/裁剪图同失败域,storedKeys 补偿删覆盖)
      let signatureImageKey: string | null = null;
      if (signatureImage) {
        const sigExt = signatureImage.mimetype === 'image/png' ? 'png' : 'jpg';
        signatureImageKey = `${SIGNATURE_IMAGE_KEY_PREFIX}/${cycle.id}/${randomUUID()}.${sigExt}`;
        await this.storage.putObject({
          key: signatureImageKey,
          body: signatureImage.buffer,
          contentType: signatureImage.mimetype,
        });
        storedKeys.push(signatureImageKey);
      }

      finalApp = await this.prisma.$transaction(async (tx) => {
        // H5:事务内消费会话行(与建终态记录同事务,建失败回滚则 token 保活可重试);得手机身份链落点。
        let phoneIdentity: ConsumedPhoneIdentity | null = null;
        if (hasToken) {
          phoneIdentity = await this.identity.consumePhoneSession(
            tx,
            payload.phoneVerificationToken,
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
            // F5 知情同意留痕 + 签名图(评审稿 §2.8;consent 已在第 0 步硬闸为 true)
            privacyConsentAcceptedAt: now,
            ...(payload.privacyConsentVersion
              ? { privacyConsentVersion: payload.privacyConsentVersion }
              : {}),
            ...(signatureImageKey ? { signatureImageKey } : {}),
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
            isNonMainlandDocument: foreign,
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
        await this.ocr.safeDeleteOrphanImage(k);
      }
      const duplicate = recruitmentDuplicateExceptionForP2002(err);
      if (duplicate) throw duplicate;
      throw err;
    }

    // 12. 通知触发:小程序展示数据已落库(application 状态 + cycle 通知配置);可选 SMS 为休眠 hook
    this.logger.log({
      event: 'recruitment.notification.ready',
      operation: 'submit',
      requestId: meta.requestId,
    });
    return toRecruitmentSubmitResult(finalApp, cycle);
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
      await claimAtStatus(tx, {
        target: 'recruitmentApplication',
        id: row.id,
        expectedStatus: row.statusCode,
        invalidStatusBiz: BizCode.RECRUITMENT_APPLICATION_NOT_PENDING_MANUAL,
      });
      const lockedRow = await tx.recruitmentApplication.findFirst({
        where: { id: row.id, deletedAt: null },
      });
      if (!lockedRow) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_PENDING_MANUAL);
      }
      let updated: RecruitmentApplication;
      let cascadedWithdrawnClaimCount = 0;
      if (dto.approved) {
        const tempNo = await this.issueTempNo(tx, lockedRow.cycleId);
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
        // 评审 findings H1:核验不通过同样是「报名进终态」,与综合评定淘汰、整份撤销、
        // 发号共用同一个收尾函数。修复前这条路径零级联 —— manual_review 期已经可以
        // 提交证书申报,它们会永久卡在非终态(rejected 之后一切 Claim 写路径皆拒),
        // 留存 SOP 扫不到、证据闸不拦。
        cascadedWithdrawnClaimCount = await withdrawClaimsOnApplicationTerminal(tx, id);
        // Claim 状态变了就必须重算派生门槛(唯一写者)。报名已是 rejected,
        // `recalcApplicationStatusForThresholds` 对终态原样返回,只清掉失去依据的标记。
        await recomputeCertificateThresholds(this.auditLogs, tx, id, {
          actorUserId: user.id,
          actorRoleSnap: user.role,
          meta: auditMeta,
          now,
        });
        updated =
          (await tx.recruitmentApplication.findFirst({ where: { id, deletedAt: null } })) ??
          updated;
      }
      await this.auditLogs.log({
        event: 'recruitment-application.resolve-manual',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta: auditMeta,
        before: { statusCode: lockedRow.statusCode },
        after: { statusCode: updated.statusCode },
        // 级联撤了几条证书申报 —— 只记条数,不记 claimId / 编号 / 图片 key。
        extra: {
          tempNo: updated.tempNo,
          eliminationStage: updated.eliminationStage,
          cascadedWithdrawnClaimCount,
        },
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
}

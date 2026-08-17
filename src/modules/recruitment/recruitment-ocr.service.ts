import { Inject, Injectable, Logger } from '@nestjs/common';
import { RecruitmentCycleAccessService } from './recruitment-cycle-access.service';
import type { UploadedImageFile } from './recruitment-applications.service';
import { ConfigType } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {} from '@prisma/client';

import appConfig from '../../config/app.config';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttachmentContentValidator } from '../attachments/attachment-content-validator';
import { RealnameVerificationService } from '../realname/realname.service';
import { isMainlandBoundPermitCategory, isOcrDocument } from '../realname/realname.constants';
import type { RealnameOcrResult } from '../realname/realname.types';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import {
  ID_CARD_IMAGE_ALLOWED_MIME,
  ID_CARD_IMAGE_MAX_BYTES,
  OCR_COUNTER_UNKNOWN_IP,
  beijingDateKey,
  recruitmentStorageCleanupFailureLog,
} from './recruitment.constants';
import {} from './recruitment-identity.service';
import { type OcrOutcome, classifyOcrResult } from './recruitment-ocr-routing';
import {} from './recruitment-progress-presenter';
import { buildOcrRecognizeDetail } from './recruitment-applications.presenter';
import type {
  RecruitmentOcrRecognizeResponseDto,
  RecruitmentSubmitPayloadDto,
} from './recruitment.dto';

/*
 * 招新报名的 **OCR 识别与裁剪图存取**(Phase 6-B 第三域第四刀,§3.2)。
 *
 * recognize 入口 + 大陆证件分类 + 每日配额闸 + 裁剪图落存储 + 孤儿图清理。
 * 抽出来的理由是职责正交:它不碰报名单据的状态,只把一张图变成结构化字段。
 *
 * ⚠️ safeDeleteOrphanImage 是**补偿路径**:识别失败/落库失败后清掉已上传的裁剪图。
 * 它刻意吞掉删除异常(清不掉只是留一张孤儿图,不该让主流程失败),
 * 这条"吞异常"是有意的,不要当成缺陷补上 rethrow。
 */
@Injectable()
export class RecruitmentOcrService {
  private readonly logger = new Logger(RecruitmentOcrService.name);

  constructor(
    private readonly prisma: PrismaService,
    // 周期查找与容量预检:被 OCR 与报名主链双方使用的共享底座。
    private readonly cycles: RecruitmentCycleAccessService,
    private readonly realname: RealnameVerificationService,
    private readonly contentValidator: AttachmentContentValidator,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
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
    // 公开识别不写 DB 审计(无 resource);meta 仅取 ip 供 F1 OCR 日封顶计数。
    await this.cycles.findOpenCycleOrThrow(); // 无 open 轮 → 28030(省 OCR);识别不卡容量
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
    // F1 成本线(评审稿 §2.5/E-U-1):付费 OCR 前按 IP 北京自然日封顶(免费分支不计;超限 28060)。
    await this.assertOcrDailyQuotaAndCount(meta.ip, new Date());
    this.logger.debug({
      event: 'recruitment.ocr-recognize.received',
      operation: 'recognize',
      requestId: meta.requestId,
    });
    // 付费 OCR(27030/27031 在此抛出,供前端提示;不吞)。映射失败(IDCardInfo 缺)亦走 27031 不当不清晰。
    const ocr = await this.realname.recognize({
      documentTypeCode,
      image: image.buffer,
      mimeType: image.mimetype,
    });
    // 回乡证类别(分叉②:识别端建议性校验 + 人工最终;不在提交端权威重判)
    const categoryOk =
      documentTypeCode !== 'hk_macau_permit' || isMainlandBoundPermitCategory(ocr.documentCategory);
    this.logger.log({
      event: 'recruitment.ocr-recognize.completed',
      operation: 'recognize',
      requestId: meta.requestId,
    });
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

  // 大陆身份证 OCR 六分流分类(评审稿 §2.1/§3.6 矩阵;复用纯函数 classifyOcrResult)。
  // 返回 outcome(matched/mismatch/forgery_warning/ocr_unclear/ocr_error)+ OCR 识别值(供 mismatch 三选一回填);
  // OCR 通道未配/上游失败不外抛 → outcome='ocr_error'(提交端永不因 OCR 硬报错,分叉③)。
  async classifyMainlandOcr(
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
        this.logger.warn({
          event: 'recruitment.ocr.failed',
          operation: 'recognize',
          safeErrorCategory: 'ocr-provider-failed',
          retryable: true,
          manualCleanupRequired: false,
        });
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

  // F1 成本线(评审稿 §2.5/E-U-1):付费 OCR 按 IP × 北京自然日封顶(recognize + submit 共享)。
  // 原子 upsert increment 后判限(Prisma 简单 upsert 走原生 ON CONFLICT,并发安全):
  // 先加后判 → 拒者恒拒;超限尝试也计数(保守防滥用,沿 sms 日限「含失败行」口径 E-11)。
  // 持久化计数表独立于 @RecruitmentThrottle 内存限流器,进程重启不清零;ip 缺省归一 'unknown' 桶不可绕计。
  async assertOcrDailyQuotaAndCount(ip: string | null, now: Date): Promise<void> {
    const ipKey = ip && ip.length > 0 ? ip : OCR_COUNTER_UNKNOWN_IP;
    const dateKey = beijingDateKey(now);
    const row = await this.prisma.recruitmentOcrDailyCounter.upsert({
      where: { ip_dateKey: { ip: ipKey, dateKey } },
      create: { ip: ipKey, dateKey, count: 1 },
      update: { count: { increment: 1 } },
      select: { count: true },
    });
    if (row.count > this.config.recruitmentOcr.dailyIpLimit) {
      this.logger.warn({
        event: 'recruitment.ocr.daily-limit',
        operation: 'recognize',
        safeErrorCategory: 'rate-limit',
        retryable: true,
        manualCleanupRequired: false,
      });
      throw new BizException(BizCode.RECRUITMENT_OCR_DAILY_LIMIT);
    }
  }

  // 鉴伪版充分利用:裁剪图 base64 解码入库(主体框 / 头像;仅 mainland 鉴伪版返回时)。
  // base64 缺省/空 → 不落、返 null(列留空不阻断提交,E3/E7);落成功 → key 推入 storedKeys 供事务失败补偿删。
  // 裁剪图为腾讯返 JPEG base64,ext 恒 jpg;base64 入库后即弃(不入日志,L3)。
  async storeCropImage(
    base64: string | null | undefined,
    prefix: string,
    cycleId: string,
    storedKeys: string[],
  ): Promise<string | null> {
    if (!base64) return null;
    const key = `${prefix}/${cycleId}/${randomUUID()}.jpg`;
    const body = Buffer.from(base64, 'base64');
    this.contentValidator.validateFromBuffer({ mime: 'image/jpeg', buffer: body });
    await this.storage.putObject({
      key,
      body,
      contentType: 'image/jpeg',
    });
    storedKeys.push(key);
    return key;
  }

  // tx1 失败时补偿删除刚落的证件照孤儿 blob(best-effort;失败仅告警,不掩盖原错)。
  // 留存 SOP 按库行 key 删 blob,无库行的孤儿清不到;此处在建库失败路径即时清理(FM-B;系统性审查 §3)。
  async safeDeleteOrphanImage(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch {
      this.logger.warn(recruitmentStorageCleanupFailureLog('delete-orphan-id-card-image'));
    }
  }
}

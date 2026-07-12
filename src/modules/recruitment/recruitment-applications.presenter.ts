import { Prisma, type RecruitmentApplication, type RecruitmentCycle } from '@prisma/client';

import { maskIdCard } from '../realname/realname.constants';
import type { RealnameOcrResult } from '../realname/realname.types';
import {
  APP_STATUS_MANUAL,
  APP_STATUS_PENDING_EVALUATION,
  APP_STATUS_PROMOTED,
  APP_STATUS_PUBLICITY,
  APP_STATUS_REJECTED,
  APP_STATUS_VERIFIED,
  APP_STATUS_WITHDRAWN,
  type ThresholdMarks,
  allThresholdsComplete,
  isPromotable,
} from './recruitment.constants';
import { deriveRecruitmentStage } from './recruitment-progress-presenter';
import type {
  RecruitmentApplicationAdminDto,
  RecruitmentOcrDetailDto,
  RecruitmentSubmitResultDto,
} from './recruitment.dto';

// 招新报名 Presenter(纯视图塑形;god-service 拆分 2026-06-28,沿 architecture-boundary §3.1)。
// 从 RecruitmentApplicationsService 极小「搬家」:Prisma 行 → 响应 DTO 的纯映射 + PII 掩码 + CSV 投影 +
// 导出筛选 where 构造。严守 §3.1「不写 DB / 不鉴权 / 不判流转 / 不审计 / 无副作用」。
// 沿本模块既有纯函数 presenter 风格(recruitment-progress-presenter / recruitment-ocr-routing,
// 零 @Injectable;入参显式传入),被 main / query / review 三服务共享,脱敏单一真相源在此。

/** 手机掩码(>=11 位留前 3 后 4;否则全掩)。 */
export function maskPhone(phone: string): string {
  return phone.length >= 11 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '***';
}

/** openid 掩码(<=8 全掩;否则留前 4 后 4)。 */
export function maskOpenid(openid: string): string {
  return openid.length <= 8 ? '***' : `${openid.slice(0, 4)}****${openid.slice(-4)}`;
}

/**
 * OCR 鉴伪版充分利用(2026-06-29):RealnameOcrResult → recognize 端顾问式 ocrDetail(纯映射)。
 * **不改判定**(只读 extendedFields/cardWarnings/documentType);**不取裁剪图 base64**(L3,绝不入响应)。
 * 无任何扩展数据(护照/回乡证/简单信封)→ null(前端不渲染扩展面板)。
 */
export function buildOcrRecognizeDetail(ocr: RealnameOcrResult): RecruitmentOcrDetailDto | null {
  const ext = ocr.extendedFields;
  const warn = ocr.cardWarnings;
  const docType = ocr.documentType ?? null;
  if (!ext && !warn && !docType) return null;
  return {
    sex: ext?.sex ?? null,
    nation: ext?.nation ?? null,
    birth: ext?.birth ?? null,
    address: ext?.address ?? null,
    authority: ext?.authority ?? null,
    validDate: ext?.validDate ?? null,
    documentType: docType,
    cardWarnings: warn ?? null,
  };
}

/**
 * admin 报名行 → admin DTO(敏感字段分级 S3:`masked=true` 掩码证件号/手机,`false` 明文)。
 * 响应字段集不随码变(只 masking 随码);脱敏单一真相源(list / detail / CSV 导出全复用本函数)。
 */
export function toAdminApplicationDto(
  app: RecruitmentApplication,
  masked: boolean,
): RecruitmentApplicationAdminDto {
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
    phone: app.phone ? (masked ? maskPhone(app.phone) : app.phone) : null,
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
    // OCR 鉴伪版充分利用(2026-06-29;S3 敏感分级):4 OCR 列随 read.sensitive 门控(masked → null);
    // 2 裁剪图 has-flag 为布尔(非 PII)恒回显,取图走 :id/id-card-image-url 的 crop/portrait URL。
    ocrAddress: masked ? null : app.ocrAddress,
    ocrNation: masked ? null : app.ocrNation,
    ocrAuthority: masked ? null : app.ocrAuthority,
    ocrValidDate: masked ? null : app.ocrValidDate,
    hasIdCardCropImage: app.idCardCropImageKey !== null,
    hasIdCardPortraitImage: app.idCardPortraitImageKey !== null,
    thresholdMarks:
      (app.thresholdMarks as Record<string, { at: string; by: string }> | null) ?? null,
    thresholdsComplete: allThresholdsComplete(app.thresholdMarks as ThresholdMarks | null),
    evaluationNote: app.evaluationNote,
    promotedMemberId: app.promotedMemberId,
    needsManualBuild: !isPromotable(app),
    createdAt: app.createdAt,
  };
}

// 落记录提交结果(outcome='submitted';verified/manual_review;statusCode 为中性机器态,不含 riskLevel/分类)。
export function toRecruitmentSubmitResult(
  app: RecruitmentApplication,
  cycle: RecruitmentCycle,
): RecruitmentSubmitResultDto {
  const canViewMeetingInfo =
    app.tempNo !== null &&
    app.statusCode !== APP_STATUS_REJECTED &&
    app.statusCode !== APP_STATUS_WITHDRAWN;
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
    meetingInfo: canViewMeetingInfo ? cycle.meetingInfo : null,
    qqGroup: canViewMeetingInfo ? cycle.qqGroup : null,
    notifyTemplate: canViewMeetingInfo
      ? (cycle.notifyTemplate as Record<string, unknown> | null)
      : null,
  };
}

// 延迟引导结果(不落记录;六分流 retake/confirm/retry)。**中性文案,绝不暴露 riskLevel/forgery**(goal 三③隐私口径):
// - retake/confirm 经 deriveRecruitmentStage 派生会话态 stage(单一真相源)+ 字典文案;retry 无业务态(系统瞬态)。
// - confirm(mismatch 三选一)回带 OCR 识别值供申请人选「①用 OCR 回填」(申请人本人 PII,等同 recognize 端)。
// stageText 由调用方传入的 `recruitment_stage` 字典 map 解析(本函数不碰 Prisma);retry 无 stage → map 不被读取。
export function buildRecruitmentDeferResult(
  disposition: 'retake' | 'confirm' | 'retry',
  recognized: { realName: string | null; idCardNumber: string | null } | null,
  cycle: RecruitmentCycle,
  stageTextByCode: ReadonlyMap<string, string>,
): RecruitmentSubmitResultDto {
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
    stageText = stageTextByCode.get(stage) ?? stage;
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
    meetingInfo: null,
    qqGroup: null,
    notifyTemplate: null,
  };
}

// 导出筛选 → statusCode where(threshold-incomplete 先按 verified 取,再 post-filter 门槛未齐)。
export function recruitmentExportStatusWhere(
  filter: string,
): Prisma.RecruitmentApplicationWhereInput {
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
    case 'withdrawn': // F6 自助撤销终态
      return { statusCode: APP_STATUS_WITHDRAWN };
    case 'all':
    default:
      return {};
  }
}

// 简单 CSV encoder(沿 activity-registrations「不引入新依赖」):双引号转义 + 含逗号/换行/双引号字段加引号。
// 入参为**已脱敏** RecruitmentApplicationAdminDto(idCardNumber/phone 列已随 S3 码掩码/明文);CSV 只投影,不二次脱敏。
export function formatApplicationsCsv(rows: RecruitmentApplicationAdminDto[]): string {
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

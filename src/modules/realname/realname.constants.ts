// 招新实名环节 OCR 改造(2026-06-22):模块常量
//
// 沿冻结评审稿 docs/archive/reviews/recruitment-realname-ocr-review.md(下称「评审稿」)。

// ===== 腾讯云 OCR 证件识别(D-RO-2/3;E-RO-2)=====
// 产品 = 腾讯云 OCR(ocr.tencentcloudapi.com,Version 2018-11-19,service ocr)。
// 按 documentTypeCode 分流三 action;复用 TC3-HMAC-SHA256 签名(原生 fetch + node crypto,零新依赖)。
// 真实通道**休眠**:DevStub 全验;真凭证 + region 由运维后填(评审稿 §10 + rollout checklist)。
// **放弃联网真实性核验**(D-RO-1):全仓不再调 faceid IdCardVerification 或任何公安库/比对接口。
export const REALNAME_TC_HOST = 'ocr.tencentcloudapi.com';
export const REALNAME_TC_ENDPOINT = `https://${REALNAME_TC_HOST}`;
export const REALNAME_TC_SERVICE = 'ocr';
export const REALNAME_TC_VERSION = '2018-11-19';
export const REALNAME_TC_SIGN_ALGORITHM = 'TC3-HMAC-SHA256';
// region 缺省(settings.region 为空时兜底;运维录真凭证时一并填真实 region)
export const REALNAME_TC_DEFAULT_REGION = 'ap-guangzhou';
// 原生 fetch + AbortSignal.timeout 上限(沿 #346 / wechat E-2;零新依赖)
export const REALNAME_REQUEST_TIMEOUT_MS = 8000;

// ===== 证件类型 → OCR action 映射(D-RO-3/6;评审稿 §3.6)=====
// 仅这三类做 OCR;taiwan_permit / foreigner_permit / 其余本期不 OCR(沿现状人工 manual_review)。
// action 字符串 = 腾讯云 OCR 接口名；documentTypeCode 是 recruitment/OCR 路由码。
// 队员档案的 document_type 字典真值由 promote 建档边界负责映射。
export const REALNAME_OCR_ACTION_MAINLAND_ID = 'RecognizeValidIDCardOCR'; // 身份证(自带图像防伪)
export const REALNAME_OCR_ACTION_PASSPORT = 'MLIDPassportOCR'; // 护照(仅可机读)
export const REALNAME_OCR_ACTION_HK_MACAU = 'MainlandPermitOCR'; // 港澳台来往内地/大陆通行证

const OCR_ACTION_BY_DOCUMENT_TYPE: Readonly<Record<string, string>> = {
  mainland_id: REALNAME_OCR_ACTION_MAINLAND_ID,
  passport: REALNAME_OCR_ACTION_PASSPORT,
  hk_macau_permit: REALNAME_OCR_ACTION_HK_MACAU,
};

/** documentTypeCode → 腾讯云 OCR action;非 OCR 类型返 null(调用方据此跳过付费 OCR) */
export function ocrActionFor(documentTypeCode: string): string | null {
  return OCR_ACTION_BY_DOCUMENT_TYPE[documentTypeCode] ?? null;
}

/** 该证件类型本期是否走 OCR(身份证 / 护照 / 回乡证) */
export function isOcrDocument(documentTypeCode: string): boolean {
  return ocrActionFor(documentTypeCode) !== null;
}

// ===== 回乡证(hk_macau)证件类别校验(D-RO-3;评审稿 §3.6)=====
// MainlandPermitOCR 可识别「来往内地通行证」与「往来港澳通行证」;本期**仅接受来往内地/大陆**,
// 拒往来港澳。真实字段取值以腾讯云文档为准、rollout 期校正;此处用「含内地/大陆」宽松判定(休眠)。
export function isMainlandBoundPermitCategory(category: string | null | undefined): boolean {
  if (!category) return false;
  return category.includes('内地') || category.includes('大陆');
}

// ===== 匹配口径(分叉⑤:完全一致,不做生僻字容错;评审稿 §3.6)=====
// 姓名:Unicode NFC 归一 + trim 后完全相等(OCR 误读 / 申请人改值致不一致 → manual_review,不误杀)。
// 证件号:trim + 大写('X' 校验位)后完全相等。
export function normalizeNameForMatch(name: string): string {
  return name.normalize('NFC').trim();
}
export function normalizeIdForMatch(idCardNumber: string): string {
  return idCardNumber.trim().toUpperCase();
}

// ===== 身份证号 / 姓名掩码(评审稿 §6;沿原 realname 安全铁律)=====
// 身份证号 / 姓名属高敏感;出现处(日志 / audit extra)一律先过本函数。
// 身份证号:保留前 3 后 4,中间打码(18 位 → 110***********1234)。
export function maskIdCard(idCardNumber: string): string {
  const s = idCardNumber.trim();
  if (s.length <= 7) return '***';
  return `${s.slice(0, 3)}${'*'.repeat(s.length - 7)}${s.slice(-4)}`;
}

// 姓名:仅保留姓氏首字(张** / 欧阳**);单字整体打码。
export function maskName(name: string): string {
  const s = name.trim();
  if (s.length <= 1) return '*';
  return `${s.slice(0, 1)}${'*'.repeat(s.length - 1)}`;
}

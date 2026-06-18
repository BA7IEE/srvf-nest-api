// 招新一期 · 实名核验通道 T2(2026-06-18):模块常量
//
// 沿冻结评审稿 docs/archive/reviews/recruitment-phase1-review.md(下称"评审稿")。

// ===== 腾讯云实名核验(二要素;E-R-3/E-R-5)=====
// 产品 = 慧眼 faceid 的 IdCardVerification(姓名 + 身份证号二要素核验)。
// 真实通道**休眠**:DevStub 全验;真凭证 + region 由运维后填(评审稿 E-R-24)。
// 请求经 TC3-HMAC-SHA256 签名(原生 fetch + node crypto,零新依赖;评审稿 E-R-5
// 选「原生 fetch」分支,沿 wechat E-2「不引 SDK」+ #346 外部请求 8s 上限先例)。
export const REALNAME_TC_HOST = 'faceid.tencentcloudapi.com';
export const REALNAME_TC_ENDPOINT = `https://${REALNAME_TC_HOST}`;
export const REALNAME_TC_SERVICE = 'faceid';
export const REALNAME_TC_ACTION = 'IdCardVerification';
export const REALNAME_TC_VERSION = '2018-03-01';
export const REALNAME_TC_SIGN_ALGORITHM = 'TC3-HMAC-SHA256';
// region 缺省(settings.region 为空时兜底;运维录真凭证时一并填真实 region)
export const REALNAME_TC_DEFAULT_REGION = 'ap-guangzhou';
// 原生 fetch + AbortSignal.timeout 上限(沿 #346 / wechat E-2;零新依赖)
export const REALNAME_REQUEST_TIMEOUT_MS = 8000;
// 腾讯云 IdCardVerification「一致」结果码(Result='0' 即二要素一致,其余视作不一致)
export const REALNAME_TC_RESULT_MATCHED = '0';

// ===== DevStub 确定性两路(E-R-6)=====
// 非生产联调通道:按身份证号**校验位奇偶**返确定性结果——
// 校验位(第 18 位)为偶(含 'X'=10)→ matched;为奇 → mismatch。
// e2e 可用不同尾号造「核验通过 / 未通过」两条链;production-like 下 DEV_STUB 写入与运行时双重被禁。
export function realnameDevStubMatched(idCardNumber: string): boolean {
  const last = idCardNumber.trim().slice(-1).toUpperCase();
  // 'X' 表示校验位 10(偶);其余取数字奇偶,非数字保守判 mismatch
  if (last === 'X') return true;
  const digit = Number.parseInt(last, 10);
  if (Number.isNaN(digit)) return false;
  return digit % 2 === 0;
}

// ===== 身份证号 / 姓名掩码(评审稿 §6)=====
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

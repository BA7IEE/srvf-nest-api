// SMS 基础设施 T2/T3(2026-06-10):模块常量
//
// 沿冻结评审稿 docs/archive/reviews/sms-verification-infra-review.md(下称"评审稿")。
// 验证码语义与防刷阈值是**业务常量**(D-SMS-5/6 拍板"DB 判断,常量"),
// 刻意不做 env 可调;IP throttler 的 limit/ttl 才走 app.config(评审稿 E-23)。

// ===== 验证码语义(D-SMS-5)=====
export const SMS_CODE_LENGTH = 6;
export const SMS_CODE_TTL_SECONDS = 300; // 5 分钟
export const SMS_CODE_MAX_ATTEMPTS = 5; // 错 5 次作废(统一 SMS_CODE_INVALID,防枚举)
// DevStub 固定码(评审稿 E-29):providerType=DEV_STUB 时签发固定此码;
// production-like 下 DEV_STUB 不可达(E-15 双重校验),固定码永不出现在生产。
export const SMS_DEV_STUB_FIXED_CODE = '888888';

// ===== 防刷 DB 两层(D-SMS-6;第三层 IP throttler 见 common/decorators)=====
export const SMS_SEND_MIN_INTERVAL_SECONDS = 60; // 同号 ≥60s 间隔
export const SMS_PHONE_DAILY_LIMIT = 10; // 同号自然日上限
// 自然日按 Asia/Shanghai 固定 UTC+8 计算日界(评审稿 E-10;大陆手机号场景;不引 tz 依赖)
export const SMS_DAILY_WINDOW_UTC_OFFSET_HOURS = 8;

// ===== 模板(E-22)=====
// 逻辑模板键(写入 sms_send_logs.templateKey);provider 侧模板 ID 存 sms_settings.templateIdVerifyCode
export const SMS_TEMPLATE_KEY_VERIFY_CODE = 'verify-code';
// 生日祝福(B 队列 F5-T2,queue-b 评审稿 §6.5):零变量模板;provider 侧模板 ID 存
// sms_settings.templateIdBirthday;生日批幂等防重发按本键 + 当日 + SENT 查 send_logs(E-B6)
export const SMS_TEMPLATE_KEY_BIRTHDAY = 'birthday-greeting';

// ===== 手机号(E-17/E-21)=====
// 大陆手机号(SMS 通道边界;不沿用 emergency-contacts 宽松座机 pattern)
export const MAINLAND_PHONE_PATTERN = /^1[3-9]\d{9}$/;

// 掩码 138****1234(保留前 3 后 4;评审稿 E-21)。
// send-logs 列表与 audit detail 的唯一掩码实现;users 模块 audit 复用本函数。
// 防御:非 11 位入参(理论不可达,DTO 已锁 pattern)整体打码,不泄露片段。
export function maskPhone(phone: string): string {
  if (!MAINLAND_PHONE_PATTERN.test(phone)) {
    return '***';
  }
  return `${phone.slice(0, 3)}****${phone.slice(7)}`;
}

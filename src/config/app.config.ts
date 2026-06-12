import { registerAs } from '@nestjs/config';

// V2.x production storage_settings fail-fast(2026-05-16):
// 'smoke' 是 CI Docker smoke job 专用 AppEnv;除 storage_settings fail-fast 外,
// 行为尽量贴近 production(JSON 日志 / 严格 CORS / 默认禁 Swagger /
// STORAGE_ENCRYPTION_KEY 必填 / 隐藏异常 message)。
// **不得用于真实部署**;真实部署必须 APP_ENV=production。
const VALID_APP_ENVS = ['development', 'test', 'production', 'smoke'] as const;
export type AppEnv = (typeof VALID_APP_ENVS)[number];

// V2.x production storage_settings fail-fast:production-like 联合判断 helper。
// 沿评审 §11 + 用户拍板 Q-pff-3 / Q-pff-4:smoke 几乎全部沿 production 行为,
// **唯一例外** = storage_settings fail-fast(在 storage-settings.service.ts 内
// 直接判 `env === 'production'`,**不**用本 helper)。
export function isProductionLike(env: AppEnv): boolean {
  return env === 'production' || env === 'smoke';
}

// V1.1 §11.5:LOG_LEVEL 允许值固定六个,silent 不在此清单(运行时为 test 环境兜底用)。
const VALID_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof VALID_LOG_LEVELS)[number];

function isAppEnv(value: string | undefined): value is AppEnv {
  return VALID_APP_ENVS.includes(value as AppEnv);
}

function isLogLevel(value: string): value is LogLevel {
  return VALID_LOG_LEVELS.includes(value as LogLevel);
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`APP_PORT 无效:"${raw ?? ''}",必须是 1-65535 的整数`);
  }
  return port;
}

function parseCorsOrigin(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// V1.1 §11.5:LOG_LEVEL 留空时默认按 APP_ENV 推断;production-like(production / smoke)=info,其他=debug。
// 显式赋值时必须 ∈ VALID_LOG_LEVELS,否则启动 fail-fast(.env.example 应留空,不写默认值)。
function parseLogLevel(raw: string | undefined, env: AppEnv): LogLevel {
  if (!raw || raw.trim() === '') {
    return isProductionLike(env) ? 'info' : 'debug';
  }
  const value = raw.trim();
  if (!isLogLevel(value)) {
    throw new Error(
      `LOG_LEVEL 无效:"${raw}",必须 ∈ { fatal | error | warn | info | debug | trace }`,
    );
  }
  return value;
}

// V1.1 §11.5 / TASKS.md 15.7:登录限流参数解析。
// 留空 → 用 ARCHITECTURE.md §11.5 表里给出的默认值(limit=5,ttl=60 秒)。
// 显式赋值必须为正整数且落在推荐区间;越界直接 fail-fast,禁止 fallback。
// 推荐区间来自 §11.5:LIMIT [1, 100],TTL [1, 3600]。
function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  fieldName: string,
  range: { min: number; max: number },
): number {
  if (!raw || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  // 允许的字面量:纯数字字符串,不接受 '5.0' / '5e1' / '+5' / 前导 0(超出 0 本身)。
  // 这里用整数正则 + parseInt 的组合,parseInt 容忍尾随字符(如 '5abc'→5),
  // 必须先用正则把整段挡下。
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${fieldName} 无效:"${raw}",必须是正整数(纯数字字符串)`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`${fieldName} 超出范围:"${raw}",必须 ∈ [${range.min}, ${range.max}](正整数)`);
  }
  return value;
}

export interface LoginThrottleConfig {
  // 单 TTL 窗口内允许的最大尝试次数。命中后抛 BizCode.TOO_MANY_REQUESTS。
  limit: number;
  // TTL 窗口长度,秒。app.config.ts 暴露秒数(更直观),传给 ThrottlerModule 时换算 ms。
  ttlSeconds: number;
}

// P0-D PR-3(2026-05-17):本人自助改密 IP 维度限流配置。
// 与 LoginThrottleConfig 结构相同但物理隔离:throttler.module 注册独立 throttler 实例
// (name: 'password-change'),计数器与登录限流互不影响。第一版固定 IP 维度,默认 5 次 / 60 秒
// (沿 docs/first-release-p0d-change-my-password-review.md §5.4)。
export interface PasswordChangeThrottleConfig {
  limit: number;
  ttlSeconds: number;
}

// P0-E PR-3(2026-05-18):POST /api/auth/v1/refresh IP 维度限流配置。
// 与 LoginThrottleConfig / PasswordChangeThrottleConfig 结构相同但物理隔离:throttler.module
// 注册独立 throttler 实例(name: 'refresh'),计数器互不影响。第一版固定 IP 维度,
// 默认 30 次 / 60 秒(沿 docs/first-release-p0e-refresh-token-review.md §3.7 D-7;
// 比登录 / 改密放宽,允许多 tab 并发 refresh,但仍挡爆破)。
export interface RefreshThrottleConfig {
  limit: number;
  ttlSeconds: number;
}

// V2.x C-6 RBAC 实施 PR #6:RBAC 进程内缓存配置(沿 D7 v1.1 §9.1 / D6 v1.0 / F8 v1.0)。
// TTL 默认 30 分钟(1800 秒);env `RBAC_CACHE_TTL_SECONDS` 可调;归 app.config.ts(沿 baseline §7)。
// 推荐区间 [60, 86400](1 分钟到 1 天;过短会让 invalidate 失去意义,过长会让"撤角色"延迟生效);
// 单实例(沿 V1.1 §17.3 不引入 Redis);多实例升级路径见 D7 §9.3。
export interface RbacCacheConfig {
  ttlSeconds: number;
}

// V2.x C-7.5 Provider 选型实施 PR #6:storage 凭证加密 key(沿 §6.6.1 + Q23 例外)。
// AES-256-GCM 需 32 字节 key;运行时由 StorageCryptoService 派生(scrypt)。
// production 严禁默认值 / 严禁留空(沿 v1 §14 JWT_SECRET 范式)。
// dev / test 允许留空 → StorageCryptoService.isAvailable() === false,凭证字段读写均抛。
//
// V2.x C-7.5 实施 PR #7:LocalStorageProvider 根目录(沿 Q-88-1 拍板 A)。
// production 不应使用 LocalProvider(沿 F2),本字段不做 production fail-fast;
// LocalProvider 实例化时若 providerType !== LOCAL 不会被调用(沿 PR #8 切换逻辑)。
export interface StorageConfig {
  encryptionKey: string; // 空字符串 = 未配置(dev / test 允许;production 启动已 fail)
  localRoot: string; // LocalProvider 根目录(env STORAGE_LOCAL_ROOT;default './tmp/storage')
}

// SMS 基础设施 T3(2026-06-10):App 发码 / 验码绑定 IP 维度限流配置(评审稿 D-SMS-6 / E-23)。
// 与既有三 throttler 结构相同但物理隔离:throttler.module 注册独立实例
// (name: 'sms-send' / 'sms-verify'),计数器互不影响。
// 默认 send 5 次 / 60 秒(短信有真实资费,从紧)、verify 10 次 / 60 秒
// (验码无资费,放宽一档,配合"错 5 次作废"双层防护)。
export interface SmsSendThrottleConfig {
  limit: number;
  ttlSeconds: number;
}

export interface SmsVerifyThrottleConfig {
  limit: number;
  ttlSeconds: number;
}

// 找回密码 T2(2026-06-11):password-reset 两个 pre-auth 端点 IP 限流配置
// (评审稿 password-reset-by-sms-review.md D-PR-4 / E-10)。
// 第 6 个独立 throttler 实例(name: 'password-reset'),计数器与既有五实例互不影响。
// 默认 3 次 / 60 秒,刻意严于 sms-send 5/60:公开端点,是防枚举侧信道采样与
// 费用滥用的第一道闸(DB 层同号 60s 间隔 / 日 10 条对无效号不可达,只有 IP 层兜底)。
export interface PasswordResetThrottleConfig {
  limit: number;
  ttlSeconds: number;
}

// B 队列 F4-T2(2026-06-11):OTP 登录两个 pre-auth 端点 IP 限流配置
// (评审稿 queue-b-otp-birthday-infra-review.md E-O3)。
// 第 7 个独立 throttler 实例(name: 'login-sms'),计数器与既有六实例互不影响。
// 默认 5 次 / 60 秒(goal 拍板值;登录是高频正常操作,较 password-reset 3/60 放宽一档,
// 仍配合 DB 层同号 60s 间隔 / 日 10 条与"错 5 次作废"双层防护)。
export interface LoginSmsThrottleConfig {
  limit: number;
  ttlSeconds: number;
}

// 微信小程序登录 T3(2026-06-12):微信 pre-auth 三端点 IP 限流配置
// (冻结评审稿 wechat-mini-login-review.md E-17)。
// 第 8 个独立 throttler 实例(name: 'login-wechat'),计数器与既有七实例互不影响。
// 默认 5 次 / 60 秒(镜像 login-sms 拍板值;wechat-bind/send-code 对有效号另有
// DB 层同号 60s 间隔 / 日 10 条兜底)。
export interface LoginWechatThrottleConfig {
  limit: number;
  ttlSeconds: number;
}

// SMS 基础设施 T2(2026-06-10):sms_settings 凭证加密 key(评审稿 D-SMS-8;沿 STORAGE 范式)。
// 独立 env `SMS_ENCRYPTION_KEY`,与 STORAGE_ENCRYPTION_KEY 互不复用;
// production / smoke fail-fast,dev / test 留空允许 → SmsCryptoService.isAvailable()=false。
export interface SmsConfig {
  encryptionKey: string; // 空字符串 = 未配置(dev / test 允许;production / smoke 启动已 fail)
}

// 微信小程序登录 T2(2026-06-12):wechat_settings 凭证加密 key(评审稿 E-5;沿 SMS 范式)。
// 独立 env `WECHAT_ENCRYPTION_KEY`,与 STORAGE / SMS 两把 key 互不复用(独立派生 salt);
// production / smoke fail-fast,dev / test 留空允许 → WechatCryptoService.isAvailable()=false。
export interface WechatConfig {
  encryptionKey: string; // 空字符串 = 未配置(dev / test 允许;production / smoke 启动已 fail)
}

// V2.x C-7.5 实施 PR #7:LocalStorageProvider 根目录(沿 Q-88-1 拍板 A)。
// 留空默认 './tmp/storage'(相对仓库根目录;.gitignore 已排除 tmp/);
// 显式可以是绝对路径或相对路径;由 LocalStorageProvider 调 path.resolve 归一化。
function parseStorageLocalRoot(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed || './tmp/storage';
}

// V2.x C-7.5 实施 PR #6:沿 Q-87-4(宽松校验)。
// 启动校验只挡明显短(< 32 字符);具体派生留 StorageCryptoService;
// 推荐 `openssl rand -base64 32`(44 字符 base64 = 32 字节)。
function parseStorageEncryptionKey(raw: string | undefined, env: AppEnv): string {
  if (!raw || raw.trim() === '') {
    if (isProductionLike(env)) {
      throw new Error(
        'STORAGE_ENCRYPTION_KEY 不能为空(production / smoke);推荐 openssl rand -base64 32 生成 32 字节 key',
      );
    }
    return '';
  }
  const trimmed = raw.trim();
  if (trimmed.length < 32) {
    throw new Error(
      `STORAGE_ENCRYPTION_KEY 太短:长度 ${trimmed.length}(至少 32 字符;推荐 openssl rand -base64 32)`,
    );
  }
  return trimmed;
}

// SMS 基础设施 T2:沿 parseStorageEncryptionKey 同款宽松校验(只挡空值与明显短;
// 具体派生留 SmsCryptoService)。
function parseSmsEncryptionKey(raw: string | undefined, env: AppEnv): string {
  if (!raw || raw.trim() === '') {
    if (isProductionLike(env)) {
      throw new Error(
        'SMS_ENCRYPTION_KEY 不能为空(production / smoke);推荐 openssl rand -base64 32 生成 32 字节 key',
      );
    }
    return '';
  }
  const trimmed = raw.trim();
  if (trimmed.length < 32) {
    throw new Error(
      `SMS_ENCRYPTION_KEY 太短:长度 ${trimmed.length}(至少 32 字符;推荐 openssl rand -base64 32)`,
    );
  }
  return trimmed;
}

// 微信小程序登录 T2:沿 parseSmsEncryptionKey 同款宽松校验(只挡空值与明显短;
// 具体派生留 WechatCryptoService)。
function parseWechatEncryptionKey(raw: string | undefined, env: AppEnv): string {
  if (!raw || raw.trim() === '') {
    if (isProductionLike(env)) {
      throw new Error(
        'WECHAT_ENCRYPTION_KEY 不能为空(production / smoke);推荐 openssl rand -base64 32 生成 32 字节 key',
      );
    }
    return '';
  }
  const trimmed = raw.trim();
  if (trimmed.length < 32) {
    throw new Error(
      `WECHAT_ENCRYPTION_KEY 太短:长度 ${trimmed.length}(至少 32 字符;推荐 openssl rand -base64 32)`,
    );
  }
  return trimmed;
}

export interface AppConfig {
  env: AppEnv;
  port: number;
  corsOrigin: string[];
  swaggerEnabled: boolean;
  logLevel: LogLevel;
  loginThrottle: LoginThrottleConfig;
  passwordChangeThrottle: PasswordChangeThrottleConfig;
  refreshThrottle: RefreshThrottleConfig;
  rbacCache: RbacCacheConfig;
  storage: StorageConfig;
  sms: SmsConfig;
  wechat: WechatConfig;
  smsSendThrottle: SmsSendThrottleConfig;
  smsVerifyThrottle: SmsVerifyThrottleConfig;
  passwordResetThrottle: PasswordResetThrottleConfig;
  loginSmsThrottle: LoginSmsThrottleConfig;
  loginWechatThrottle: LoginWechatThrottleConfig;
}

export default registerAs('app', (): AppConfig => {
  const env = process.env.APP_ENV;
  if (!isAppEnv(env)) {
    throw new Error(`APP_ENV 无效:"${env ?? ''}",必须是 development | test | production | smoke`);
  }

  const port = parsePort(process.env.APP_PORT);
  const corsOrigin = parseCorsOrigin(process.env.APP_CORS_ORIGIN);

  if (isProductionLike(env)) {
    if (corsOrigin.length === 0) {
      throw new Error('生产 / smoke 环境 APP_CORS_ORIGIN 不能为空');
    }
    if (corsOrigin.includes('*')) {
      throw new Error('生产 / smoke 环境 APP_CORS_ORIGIN 禁止使用 *,必须显式列出前端域名');
    }
  }

  // ENABLE_SWAGGER 必须严格字符串判断 === 'true'
  // 禁止 Boolean(process.env.ENABLE_SWAGGER) 等 truthy 判断,否则字符串 'false' 会被误判为开启
  // production-like(production / smoke)默认禁,显式 ENABLE_SWAGGER=true 才开。
  const swaggerEnabled = !isProductionLike(env) || process.env.ENABLE_SWAGGER === 'true';

  const logLevel = parseLogLevel(process.env.LOG_LEVEL, env);

  const loginThrottle: LoginThrottleConfig = {
    limit: parsePositiveInt(process.env.LOGIN_THROTTLE_LIMIT, 5, 'LOGIN_THROTTLE_LIMIT', {
      min: 1,
      max: 100,
    }),
    ttlSeconds: parsePositiveInt(
      process.env.LOGIN_THROTTLE_TTL_SECONDS,
      60,
      'LOGIN_THROTTLE_TTL_SECONDS',
      { min: 1, max: 3600 },
    ),
  };

  // P0-D PR-3(2026-05-17):本人自助改密限流配置。
  // 推荐区间沿 LOGIN_THROTTLE_*;默认 5/60(沿 docs/first-release-p0d-change-my-password-review.md §5.4)。
  const passwordChangeThrottle: PasswordChangeThrottleConfig = {
    limit: parsePositiveInt(
      process.env.PASSWORD_CHANGE_THROTTLE_LIMIT,
      5,
      'PASSWORD_CHANGE_THROTTLE_LIMIT',
      { min: 1, max: 100 },
    ),
    ttlSeconds: parsePositiveInt(
      process.env.PASSWORD_CHANGE_THROTTLE_TTL_SECONDS,
      60,
      'PASSWORD_CHANGE_THROTTLE_TTL_SECONDS',
      { min: 1, max: 3600 },
    ),
  };

  // P0-E PR-3(2026-05-18):refresh 接口限流配置。
  // 推荐区间沿 LOGIN_THROTTLE_*;默认 30/60(沿 docs/first-release-p0e-refresh-token-review.md §3.7 D-7;
  // 比登录 / 改密放宽,允许多 tab 并发 refresh)。
  const refreshThrottle: RefreshThrottleConfig = {
    limit: parsePositiveInt(process.env.REFRESH_THROTTLE_LIMIT, 30, 'REFRESH_THROTTLE_LIMIT', {
      min: 1,
      max: 100,
    }),
    ttlSeconds: parsePositiveInt(
      process.env.REFRESH_THROTTLE_TTL_SECONDS,
      60,
      'REFRESH_THROTTLE_TTL_SECONDS',
      { min: 1, max: 3600 },
    ),
  };

  const rbacCache: RbacCacheConfig = {
    ttlSeconds: parsePositiveInt(
      process.env.RBAC_CACHE_TTL_SECONDS,
      1800,
      'RBAC_CACHE_TTL_SECONDS',
      { min: 60, max: 86400 },
    ),
  };

  const storage: StorageConfig = {
    encryptionKey: parseStorageEncryptionKey(process.env.STORAGE_ENCRYPTION_KEY, env),
    localRoot: parseStorageLocalRoot(process.env.STORAGE_LOCAL_ROOT),
  };

  const sms: SmsConfig = {
    encryptionKey: parseSmsEncryptionKey(process.env.SMS_ENCRYPTION_KEY, env),
  };

  const wechat: WechatConfig = {
    encryptionKey: parseWechatEncryptionKey(process.env.WECHAT_ENCRYPTION_KEY, env),
  };

  // SMS 基础设施 T3:发码 / 验码限流(评审稿 D-SMS-6;推荐区间沿 LOGIN_THROTTLE_*)。
  const smsSendThrottle: SmsSendThrottleConfig = {
    limit: parsePositiveInt(process.env.SMS_SEND_THROTTLE_LIMIT, 5, 'SMS_SEND_THROTTLE_LIMIT', {
      min: 1,
      max: 100,
    }),
    ttlSeconds: parsePositiveInt(
      process.env.SMS_SEND_THROTTLE_TTL_SECONDS,
      60,
      'SMS_SEND_THROTTLE_TTL_SECONDS',
      { min: 1, max: 3600 },
    ),
  };

  const smsVerifyThrottle: SmsVerifyThrottleConfig = {
    limit: parsePositiveInt(
      process.env.SMS_VERIFY_THROTTLE_LIMIT,
      10,
      'SMS_VERIFY_THROTTLE_LIMIT',
      { min: 1, max: 100 },
    ),
    ttlSeconds: parsePositiveInt(
      process.env.SMS_VERIFY_THROTTLE_TTL_SECONDS,
      60,
      'SMS_VERIFY_THROTTLE_TTL_SECONDS',
      { min: 1, max: 3600 },
    ),
  };

  // 找回密码 T2(2026-06-11):pre-auth 两端点限流(评审稿 D-PR-4;默认 3/60 从紧)。
  const passwordResetThrottle: PasswordResetThrottleConfig = {
    limit: parsePositiveInt(
      process.env.PASSWORD_RESET_THROTTLE_LIMIT,
      3,
      'PASSWORD_RESET_THROTTLE_LIMIT',
      { min: 1, max: 100 },
    ),
    ttlSeconds: parsePositiveInt(
      process.env.PASSWORD_RESET_THROTTLE_TTL_SECONDS,
      60,
      'PASSWORD_RESET_THROTTLE_TTL_SECONDS',
      { min: 1, max: 3600 },
    ),
  };

  // B 队列 F4-T2(2026-06-11):OTP 登录两端点限流(评审稿 E-O3;默认 5/60,goal 拍板值)。
  const loginSmsThrottle: LoginSmsThrottleConfig = {
    limit: parsePositiveInt(process.env.LOGIN_SMS_THROTTLE_LIMIT, 5, 'LOGIN_SMS_THROTTLE_LIMIT', {
      min: 1,
      max: 100,
    }),
    ttlSeconds: parsePositiveInt(
      process.env.LOGIN_SMS_THROTTLE_TTL_SECONDS,
      60,
      'LOGIN_SMS_THROTTLE_TTL_SECONDS',
      { min: 1, max: 3600 },
    ),
  };

  // 微信小程序登录 T3(2026-06-12):微信 pre-auth 三端点限流(评审稿 E-17;默认 5/60 镜像 login-sms)。
  const loginWechatThrottle: LoginWechatThrottleConfig = {
    limit: parsePositiveInt(
      process.env.LOGIN_WECHAT_THROTTLE_LIMIT,
      5,
      'LOGIN_WECHAT_THROTTLE_LIMIT',
      { min: 1, max: 100 },
    ),
    ttlSeconds: parsePositiveInt(
      process.env.LOGIN_WECHAT_THROTTLE_TTL_SECONDS,
      60,
      'LOGIN_WECHAT_THROTTLE_TTL_SECONDS',
      { min: 1, max: 3600 },
    ),
  };

  return {
    env,
    port,
    corsOrigin,
    swaggerEnabled,
    logLevel,
    loginThrottle,
    passwordChangeThrottle,
    refreshThrottle,
    rbacCache,
    storage,
    sms,
    wechat,
    smsSendThrottle,
    smsVerifyThrottle,
    passwordResetThrottle,
    loginSmsThrottle,
    loginWechatThrottle,
  };
});

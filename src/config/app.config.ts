import { registerAs } from '@nestjs/config';

const VALID_APP_ENVS = ['development', 'test', 'production'] as const;
export type AppEnv = (typeof VALID_APP_ENVS)[number];

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

// V1.1 §11.5:LOG_LEVEL 留空时默认按 APP_ENV 推断;production=info,非 production=debug。
// 显式赋值时必须 ∈ VALID_LOG_LEVELS,否则启动 fail-fast(.env.example 应留空,不写默认值)。
function parseLogLevel(raw: string | undefined, env: AppEnv): LogLevel {
  if (!raw || raw.trim() === '') {
    return env === 'production' ? 'info' : 'debug';
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
export interface StorageConfig {
  encryptionKey: string; // 空字符串 = 未配置(dev / test 允许;production 启动已 fail)
}

// V2.x C-7.5 实施 PR #6:沿 Q-87-4(宽松校验)。
// 启动校验只挡明显短(< 32 字符);具体派生留 StorageCryptoService;
// 推荐 `openssl rand -base64 32`(44 字符 base64 = 32 字节)。
function parseStorageEncryptionKey(raw: string | undefined, env: AppEnv): string {
  if (!raw || raw.trim() === '') {
    if (env === 'production') {
      throw new Error(
        'STORAGE_ENCRYPTION_KEY 不能为空(production);推荐 openssl rand -base64 32 生成 32 字节 key',
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

export interface AppConfig {
  env: AppEnv;
  port: number;
  corsOrigin: string[];
  swaggerEnabled: boolean;
  logLevel: LogLevel;
  loginThrottle: LoginThrottleConfig;
  rbacCache: RbacCacheConfig;
  storage: StorageConfig;
}

export default registerAs('app', (): AppConfig => {
  const env = process.env.APP_ENV;
  if (!isAppEnv(env)) {
    throw new Error(`APP_ENV 无效:"${env ?? ''}",必须是 development | test | production`);
  }

  const port = parsePort(process.env.APP_PORT);
  const corsOrigin = parseCorsOrigin(process.env.APP_CORS_ORIGIN);

  if (env === 'production') {
    if (corsOrigin.length === 0) {
      throw new Error('生产环境 APP_CORS_ORIGIN 不能为空');
    }
    if (corsOrigin.includes('*')) {
      throw new Error('生产环境 APP_CORS_ORIGIN 禁止使用 *,必须显式列出前端域名');
    }
  }

  // ENABLE_SWAGGER 必须严格字符串判断 === 'true'
  // 禁止 Boolean(process.env.ENABLE_SWAGGER) 等 truthy 判断,否则字符串 'false' 会被误判为开启
  const swaggerEnabled = env !== 'production' || process.env.ENABLE_SWAGGER === 'true';

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
  };

  return {
    env,
    port,
    corsOrigin,
    swaggerEnabled,
    logLevel,
    loginThrottle,
    rbacCache,
    storage,
  };
});

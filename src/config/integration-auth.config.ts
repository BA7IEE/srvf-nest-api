import { createHash } from 'node:crypto';

/**
 * Integration Foundation v1 PR3(规格书 §11–§14;T0 冻结稿 §9):
 * Integration Token 的独立信任域配置。
 *
 * ⭐ 独立信任域(不可协商,§11):
 *   - 密钥独立(INTEGRATION_JWT_SECRET ≠ JWT_SECRET;production 至少 48 字符);
 *   - issuer `srvf-dp` / audience `srvf-integration`(与真人 JWT 不同域);
 *   - Service/Delegated Token ≤30 分钟,无 refresh;
 *   - `INTEGRATION_API_ENABLED=false` 时 token 签发与 Integration Surface 全体 fail-closed(§48)。
 *
 * ⚠️ 本文件只加载配置;判 Gate 的运行时方法在 `integration-auth.gate.ts`。
 */
export interface IntegrationAuthConfig {
  enabled: boolean;
  jwtSecret: string;
  issuer: string;
  audience: string;
  /** Service Token TTL(秒)。规格书 §11.2:最长 30 分钟,默认 600(10m)。 */
  serviceTokenTtlSeconds: number;
  /** Delegated Token TTL(秒)。同属 Integration 短 Token,最长 30 分钟,默认 600(10m)。 */
  delegatedTokenTtlSeconds: number;
  /** 限流(规格书 §11.2 env):默认 10 次 / 60 秒。 */
  throttleLimit: number;
  throttleTtlSeconds: number;
}

export const INTEGRATION_JWT_ISSUER = 'srvf-dp';
export const INTEGRATION_JWT_AUDIENCE = 'srvf-integration';

export const SERVICE_TOKEN_MAX_TTL_SECONDS = 30 * 60;
export const SERVICE_TOKEN_DEFAULT_TTL_SECONDS = 10 * 60;

function isProductionLikeAppEnv(appEnv: string | undefined): boolean {
  return appEnv === 'production' || appEnv === 'smoke';
}

function parseIntegrationApiEnabled(raw: string | undefined, appEnv: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') {
    if (isProductionLikeAppEnv(appEnv)) {
      throw new Error(
        'INTEGRATION_API_ENABLED 不能为空(production / smoke 必须显式设置 true 或 false)',
      );
    }
    return false;
  }
  if (raw !== 'true' && raw !== 'false') {
    throw new Error('INTEGRATION_API_ENABLED 必须严格为 true 或 false');
  }
  return raw === 'true';
}

/**
 * Integration Token TTL 统一收敛为秒。
 *
 * - 规格书示例 `10m` 必须按 600 秒解释;
 * - 保留既有纯秒数配置(例如 `600`)兼容;
 * - 不再让 parseInt 吞掉尾随单位或垃圾字符。
 */
function parseIntegrationTokenTtlSeconds(fieldName: string, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return SERVICE_TOKEN_DEFAULT_TTL_SECONDS;

  const value = raw.trim();
  const secondsMatch = /^(\d+)$/.exec(value);
  const durationMatch = /^(\d+)(s|m)$/.exec(value);
  if (!secondsMatch && !durationMatch) {
    throw new Error(`${fieldName} 无效:必须是正整数秒或带单位的正整数(s/m)`);
  }

  const amount = Number(secondsMatch?.[1] ?? durationMatch?.[1]);
  const seconds = durationMatch?.[2] === 'm' ? amount * 60 : amount;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`${fieldName} 无效:解析结果必须是安全正整数秒`);
  }
  if (seconds > SERVICE_TOKEN_MAX_TTL_SECONDS) {
    throw new Error(`${fieldName} 超出允许范围:最长 ${SERVICE_TOKEN_MAX_TTL_SECONDS} 秒`);
  }
  return seconds;
}

export function loadIntegrationAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationAuthConfig {
  const appEnv = env.APP_ENV;
  const enabled = parseIntegrationApiEnabled(env.INTEGRATION_API_ENABLED, appEnv);
  const jwtSecret = env.INTEGRATION_JWT_SECRET ?? '';
  const ttl = parseIntegrationTokenTtlSeconds(
    'INTEGRATION_SERVICE_TOKEN_EXPIRES_IN',
    env.INTEGRATION_SERVICE_TOKEN_EXPIRES_IN,
  );
  const delegatedTtl = parseIntegrationTokenTtlSeconds(
    'INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN',
    env.INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN,
  );
  const limitRaw = Number.parseInt(env.SERVICE_TOKEN_THROTTLE_LIMIT ?? '', 10);
  const ttlThrottleRaw = Number.parseInt(env.SERVICE_TOKEN_THROTTLE_TTL_SECONDS ?? '', 10);
  const config: IntegrationAuthConfig = {
    enabled,
    jwtSecret,
    issuer: INTEGRATION_JWT_ISSUER,
    audience: INTEGRATION_JWT_AUDIENCE,
    serviceTokenTtlSeconds: ttl,
    delegatedTokenTtlSeconds: delegatedTtl,
    throttleLimit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10,
    throttleTtlSeconds: Number.isFinite(ttlThrottleRaw) && ttlThrottleRaw > 0 ? ttlThrottleRaw : 60,
  };
  assertIntegrationSecretProductionGrade(config, appEnv, env.JWT_SECRET);
  return config;
}

/**
 * 独立信任域边界:
 * - production/smoke 无条件要求独立、至少 48 字符的密钥;
 * - 任意环境一旦开 Gate,至少必须配置非空密钥；只要配置了密钥就不得与真人 JWT 共用。
 */
export function assertIntegrationSecretProductionGrade(
  config: IntegrationAuthConfig,
  appEnv: string | undefined,
  humanJwtSecret: string | undefined,
): void {
  const productionLike = isProductionLikeAppEnv(appEnv);
  const secretRequired = productionLike || config.enabled;

  if (secretRequired && config.jwtSecret.trim() === '') {
    throw new Error('INTEGRATION_JWT_SECRET 未设置');
  }
  if (productionLike && config.jwtSecret.length < 48) {
    throw new Error('INTEGRATION_JWT_SECRET 在 production/smoke 下至少 48 字符(规格书 §11.2)');
  }
  if (
    config.jwtSecret.trim() !== '' &&
    humanJwtSecret !== undefined &&
    config.jwtSecret === humanJwtSecret
  ) {
    throw new Error('INTEGRATION_JWT_SECRET 不得与 JWT_SECRET 相同(规格书 §11.2)');
  }
}

/**
 * dummy hash(规格书 §12.4 失败归一):clientId 不存在时也做一次同代价 SHA-256 比较,
 * 让「不存在」与「Secret 错」不可从耗时区分。
 */
export function dummySecretHash(): string {
  return createHash('sha256').update('dummy-client-secret-probe', 'utf8').digest('hex');
}

import { registerAs } from '@nestjs/config';

export default registerAs(
  'integrationAuth',
  (): IntegrationAuthConfig => loadIntegrationAuthConfig(),
);

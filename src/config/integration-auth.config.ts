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
  /** 限流(规格书 §11.2 env):默认 10 次 / 60 秒。 */
  throttleLimit: number;
  throttleTtlSeconds: number;
}

export const INTEGRATION_JWT_ISSUER = 'srvf-dp';
export const INTEGRATION_JWT_AUDIENCE = 'srvf-integration';

export const SERVICE_TOKEN_MAX_TTL_SECONDS = 30 * 60;
export const SERVICE_TOKEN_DEFAULT_TTL_SECONDS = 10 * 60;

export function loadIntegrationAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationAuthConfig {
  const enabled = env.INTEGRATION_API_ENABLED === 'true';
  const jwtSecret = env.INTEGRATION_JWT_SECRET ?? '';
  const ttlRaw = Number.parseInt(env.INTEGRATION_SERVICE_TOKEN_EXPIRES_IN ?? '', 10);
  const ttl =
    Number.isFinite(ttlRaw) && ttlRaw > 0
      ? Math.min(ttlRaw, SERVICE_TOKEN_MAX_TTL_SECONDS)
      : SERVICE_TOKEN_DEFAULT_TTL_SECONDS;
  const limitRaw = Number.parseInt(env.SERVICE_TOKEN_THROTTLE_LIMIT ?? '', 10);
  const ttlThrottleRaw = Number.parseInt(env.SERVICE_TOKEN_THROTTLE_TTL_SECONDS ?? '', 10);
  return {
    enabled,
    jwtSecret,
    issuer: INTEGRATION_JWT_ISSUER,
    audience: INTEGRATION_JWT_AUDIENCE,
    serviceTokenTtlSeconds: ttl,
    throttleLimit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10,
    throttleTtlSeconds: Number.isFinite(ttlThrottleRaw) && ttlThrottleRaw > 0 ? ttlThrottleRaw : 60,
  };
}

/** production/smoke 下密钥长度校验(≥48 字符;dev 可宽松)。 */
export function assertIntegrationSecretProductionGrade(
  config: IntegrationAuthConfig,
  appEnv: string,
): void {
  if ((appEnv === 'production' || appEnv === 'smoke') && config.jwtSecret.length < 48) {
    throw new Error(
      'INTEGRATION_JWT_SECRET 在 production/smoke 下至少 48 字符,且不得与 JWT_SECRET 相同(规格书 §11.2)',
    );
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

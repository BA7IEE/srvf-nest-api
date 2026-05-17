import { registerAs } from '@nestjs/config';

const DEFAULT_JWT_SECRET = 'please-change-me-in-production-min-32-chars';

export interface JwtConfig {
  secret: string;
  expiresIn: string;
  // P0-E PR-3(2026-05-18):refresh token TTL(absolute expiration,90d 不滑动续期;
  // 沿 docs/first-release-p0e-refresh-token-review.md §3.5 D-5)。
  // 字段名沿 v1 `expiresIn` 范式(TTL 配置;非响应字段);
  // 响应字段叫 `refreshExpiresAt`(ISO 8601 UTC 绝对时刻字符串),由 auth.service 内
  // `new Date(now + ttlMs).toISOString()` 计算后返给客户端;两者职责分离。
  refreshExpiresIn: string;
}

// 启动强校验(详见 ARCHITECTURE.md §8 + CLAUDE.md §14):
// - JWT_SECRET 必须存在且 ≥ 32 字符
// - APP_ENV=production 时 JWT_SECRET 不能等于 .env.example 默认值
// - JWT_EXPIRES_IN 必须存在
// - JWT_REFRESH_EXPIRES_IN 必须存在(P0-E PR-3)
//
// jwt.config 的 callback 在 ConfigModule 加载阶段执行,直接读 process.env
// 是允许的(.env 已被 ConfigModule 加载到 process.env);业务代码不得直接
// process.env.JWT_*,必须通过 ConfigService.get<JwtConfig>('jwt')。
export default registerAs('jwt', (): JwtConfig => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET 未设置');
  }
  if (secret.length < 32) {
    throw new Error(`JWT_SECRET 长度不足:实际 ${secret.length} 字符,要求 ≥ 32`);
  }
  if (process.env.APP_ENV === 'production' && secret === DEFAULT_JWT_SECRET) {
    throw new Error(
      "生产环境 JWT_SECRET 不能等于 .env.example 默认值;推荐用 'openssl rand -base64 48' 生成",
    );
  }

  const expiresIn = process.env.JWT_EXPIRES_IN;
  if (!expiresIn) {
    throw new Error('JWT_EXPIRES_IN 未设置');
  }

  const refreshExpiresIn = process.env.JWT_REFRESH_EXPIRES_IN;
  if (!refreshExpiresIn) {
    throw new Error('JWT_REFRESH_EXPIRES_IN 未设置');
  }

  return { secret, expiresIn, refreshExpiresIn };
});

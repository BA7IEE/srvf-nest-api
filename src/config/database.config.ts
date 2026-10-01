import { registerAs } from '@nestjs/config';

export interface DatabaseConfig {
  url: string | undefined;
  contributionShadowUrl: string | undefined;
}

// 第 4 阶段不强校验 DATABASE_URL —— Prisma 自身在连接失败时会抛出明确错误。
// 后续若 PrismaService 改用 ConfigService 注入 URL,可在此补强校验。
export default registerAs(
  'database',
  (): DatabaseConfig => ({
    url: process.env.DATABASE_URL,
    // Optional independent runtime identity; never fall back to DATABASE_URL.
    // Configuration alone neither creates a client nor enables shadow mode.
    contributionShadowUrl: process.env.CONTRIBUTION_SHADOW_DATABASE_URL || undefined,
  }),
);

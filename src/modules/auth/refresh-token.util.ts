import { createHash, randomBytes } from 'node:crypto';

// P0-E PR-3:refresh token 生成与哈希纯函数(沿
// docs/first-release-p0e-refresh-token-review.md §5.1)。
//
// 设计取舍:
//   - **生成**用 `crypto.randomBytes(32).toString('base64url')`:256 bit 熵;
//     base64url 不含 `+ / =`,URL / Header / Body 全兼容;输出长度 43 字符。
//   - **哈希**用 `sha256(raw).hex`:不需要 bcrypt / argon2(高熵随机串无暴破语义;
//     sha256 sub-ms 性能远优,refresh 接口高频路径无负担);输出长度 64 字符 hex。
//   - **明文绝不入库**:DB 字段 `refresh_tokens.tokenHash @unique` 只存 hash;
//     login / refresh 接口响应里 `data.refreshToken` 是明文(也只在该响应里出现一次)。
//   - **明文绝不入日志 / audit / OpenAPI 示例 / 测试 fixture / 测试快照 / 文档示例**
//     (沿评审稿 §5.1 + CLAUDE.md §9 P0-E 子节)。
//
// 不引入第三方依赖(`crypto` 是 Node 内置;沿评审稿"0 新依赖")。

// 256 bit 熵 base64url string;输出长度恒为 43 字符。
export function generateRefreshTokenRaw(): string {
  return randomBytes(32).toString('base64url');
}

// sha256(raw) hex;输出长度恒为 64 字符。确定性:同 raw 同 hash。
export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// family id:128 bit 熵 hex(32 字符);与 cuid 语义等价(都是不可预测随机 id)。
// 不引入 @paralleldrive/cuid2 / nanoid 等新依赖(沿评审稿 §13.3 "0 新依赖")。
export function generateFamilyId(): string {
  return randomBytes(16).toString('hex');
}

// 最小 ms 解析器:只支持本项目用到的 ms 兼容字符串(`Nd` / `Nh` / `Nm` / `Ns` / `Nms`);
// 不引入 `ms` 包(transitive 依赖在 pnpm hoist 之外,直接 import 不稳定;沿"0 新依赖")。
// jsonwebtoken 自己解析 `expiresIn` 走它自己的内部 ms,不与本函数共享。
//
// 用于:JWT_REFRESH_EXPIRES_IN 解析 → ms 数字 → new Date(now + ms) 计算 family expiresAt。
//
// 不合法输入(非数字 / 不含单位 / 单位非 d/h/m/s/ms / 负值)返 null;调用方负责抛错。
export function parseMsString(value: string): number | null {
  const trimmed = value.trim();
  // 顺序敏感:ms 必须在 m / s 之前匹配
  const match = /^(\d+)\s*(ms|d|h|m|s)$/.exec(trimmed);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (match[2]) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
    case 'd':
      return n * 24 * 60 * 60 * 1000;
    default:
      return null; // 防御性 fallback;regex 已限定 5 个单位之一
  }
}

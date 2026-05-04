import { PrismaClient, Role, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

// v1 唯一允许创建 SUPER_ADMIN 的入口(详见 ARCHITECTURE.md §7.11 + §8 + §13)。
// seed 直接读 process.env(§14 显式例外):SUPER_ADMIN_* 不进 ConfigService,
// 避免运行时被业务代码误读到默认凭据。
//
// 启动强校验:
// - SUPER_ADMIN_USERNAME 必须符合 username 格式(归一化后小写)
// - SUPER_ADMIN_PASSWORD 必须设置
// - APP_ENV=production 时禁用默认 username 'admin' 与默认 password 'ChangeMe123456'
//
// 幂等性:用户已存在时 **不覆盖** 密码 / 角色 / 邮箱,只打印提示。

const DEFAULT_PASSWORD = 'ChangeMe123456';
const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/;
const BCRYPT_SALT_ROUNDS = 10;

async function main(): Promise<void> {
  const usernameRaw = process.env.SUPER_ADMIN_USERNAME ?? '';
  const username = usernameRaw.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD ?? '';
  const emailRaw = process.env.SUPER_ADMIN_EMAIL ?? '';
  const emailNormalized = emailRaw.trim().toLowerCase();
  // 空字符串视为未填写(不写入 email 字段);保持 §5 + §3 字段校验铁律一致
  const email: string | undefined = emailNormalized === '' ? undefined : emailNormalized;
  const env = process.env.APP_ENV;

  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      `[seed] SUPER_ADMIN_USERNAME 格式无效:"${usernameRaw}";归一化后必须匹配 ${USERNAME_PATTERN.toString()}`,
    );
  }
  if (!password) {
    throw new Error('[seed] SUPER_ADMIN_PASSWORD 未设置');
  }

  if (env === 'production') {
    if (username === 'admin') {
      throw new Error(
        '[seed] APP_ENV=production 时禁止 SUPER_ADMIN_USERNAME=admin(默认值过于通用)',
      );
    }
    if (password === DEFAULT_PASSWORD) {
      throw new Error(
        `[seed] APP_ENV=production 时禁止 SUPER_ADMIN_PASSWORD='${DEFAULT_PASSWORD}'(.env.example 默认值)`,
      );
    }
  }

  const prisma = new PrismaClient();
  try {
    // 唯一性预检查必须用 findUnique 包含软删记录(详见 §7.8)
    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true, role: true, status: true, deletedAt: true },
    });

    if (existing) {
      console.log(
        `[seed] User '${username}' already exists ` +
          `(id=${existing.id}, role=${existing.role}, status=${existing.status}, ` +
          `deletedAt=${existing.deletedAt ? existing.deletedAt.toISOString() : 'null'}); ` +
          'skipping. No password / role / email is overwritten.',
      );
      return;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const created = await prisma.user.create({
      data: {
        username,
        email,
        passwordHash,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });
    console.log('[seed] Created super admin:');
    console.log(JSON.stringify(created, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

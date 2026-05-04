import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus, type User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../src/database/prisma.service';

// 默认测试密码,同时满足:
// - LoginDto(IsString + IsNotEmpty,无长度规则)
// - CreateUserDto 未来要求(8+ 字母数字组合)
export const TEST_PASSWORD = 'Passw0rd1!';

// 模块级常量化 hash:bcrypt 10 rounds 慢(~80ms),所有 createTestUser 共用同一个 hash。
// 用 hashSync 在模块加载时一次性算出;Node 22 同步 bcrypt 阻塞主线程一次,可接受。
export const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 10);

// fixture **不**做 username 归一化(trim/lowercase),caller 必须传想要的 db 实际值。
// 大小写归一化是 service 层的职责(auth.service 内 trim().toLowerCase());
// 想测归一化路径,fixture 存 lowercase,login 时传大写——用 spec 体现 service 行为,
// 而不是用 fixture 隐式吸收。
export interface CreateTestUserProps {
  username: string;
  password?: string; // 默认走 TEST_PASSWORD_HASH;传值会重新 hash(慢,慎用)
  role?: Role;
  status?: UserStatus;
  deletedAt?: Date | null;
  email?: string | null;
  nickname?: string | null;
}

export async function createTestUser(
  app: INestApplication,
  props: CreateTestUserProps,
): Promise<User> {
  const prisma = app.get(PrismaService);
  const passwordHash = props.password ? await bcrypt.hash(props.password, 10) : TEST_PASSWORD_HASH;

  return prisma.user.create({
    data: {
      username: props.username,
      passwordHash,
      role: props.role ?? Role.USER,
      status: props.status ?? UserStatus.ACTIVE,
      deletedAt: props.deletedAt ?? null,
      email: props.email ?? null,
      nickname: props.nickname ?? null,
    },
  });
}

import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { assertTestDatabaseUrl } from './test-db';

// 每个 spec 文件 beforeAll 调用一次,在 createTestApp() 之后,
// 把 User 表清空,保证文件间互不干扰(隔离粒度到 spec 文件级,
// 不下沉到 it 级,避免 fixtures 反复重建拖慢套件)。
//
// 双保险:即使 setupFiles 没把 .env.test 加载好,这里再断言一次 DATABASE_URL 含 'app_test',
// 任何路径上 truncate 误打到开发库 app 都会被这条护栏拒绝。
//
// 设计选择:
// - 复用 app.get(PrismaService),不新开 PrismaClient,避免连接池泄漏
// - $executeRawUnsafe 而非 $executeRaw:RESTART IDENTITY / CASCADE 是 SQL 关键字片段,
//   $executeRaw 模板字符串会把它们当参数转义
// - RESTART IDENTITY 对 cuid 主键无效但不报错,留作未来加自增列时的防御
// - CASCADE 防外键引用阻塞;v1 单表无外键,留作未来防御
// - 表名 "User" PascalCase 必须双引号,Prisma 默认生成的物理表名大小写敏感
export async function resetDb(app: INestApplication): Promise<void> {
  assertTestDatabaseUrl(process.env.DATABASE_URL);

  const prisma = app.get(PrismaService);
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
}

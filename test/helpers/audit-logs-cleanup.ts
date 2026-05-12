import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { assertTestDatabaseUrl } from '../setup/test-db';

// V2 第一阶段批次 6 audit_logs 单表清理 helper(D6 v1.1 §12.1 / D-E 拍板)。
//
// 用途:e2e 在 beforeEach / afterEach / spec 内中间点 TRUNCATE audit_logs,
// 避免一个测试块写入的审计记录污染下一个测试块的 list 断言。
//
// 红线(D6 v1.1 §12.1):
// - 测试库**豁免** audit_logs DELETE 红线(audit_logs 在生产代码层是写入后不可删,
//   但 e2e 必须能清表)
// - 生产代码层无 trigger 限制 DELETE,红线仅由 controller 不开放 DELETE 接口实现(F10)
// - 本 helper 内部双保险:
//   (1) assertTestDatabaseUrl 强制 DATABASE_URL 含 'app_test'(沿 test/setup/test-db.ts)
//   (2) APP_ENV 必须 !== 'production'(防御性,即便测试库 URL 检查通过)
// - 命名带 test-only 含义:**仅 test/ 引用,生产代码绝不可调用**;
//   AI / 维护者发现 src/ 内 import 本 helper,应立即拒绝
//
// 物理表名:`audit_logs`(Prisma `@@map("audit_logs")`;小写带下划线)。
// 既无被其他表 FK 引用,也无自引用,CASCADE 不起实际作用,留作未来扩展防御。
// RESTART IDENTITY 对 cuid 主键无效,留作防御。
export async function truncateAuditLogsTestOnly(app: INestApplication): Promise<void> {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  if (process.env.APP_ENV === 'production') {
    throw new Error(
      'truncateAuditLogsTestOnly 拒绝在 APP_ENV=production 下执行;此 helper 仅供 e2e 使用',
    );
  }

  const prisma = app.get(PrismaService);
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');
}

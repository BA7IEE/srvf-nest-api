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
//
// V2 第一阶段 Step 3 起追加 V2 字典表(DictItem / DictType);随后 Step 4-6
// 模块开发时,可按需在此追加 Member / Organization / MemberDepartment 等。
// 多表 TRUNCATE 用 comma 分隔(PostgreSQL 原生支持)。
//
// V2 第一阶段批次 1 追加(2026-05-10):MemberProfile / EmergencyContact 两张扩展表。
// 顺序约束:子表(MemberProfile / EmergencyContact / MemberDepartment / User)在前,
// Member / Organization / DictItem / DictType 在后;CASCADE 兜底跨外键依赖。
//
// V2 第一阶段批次 2 追加(2026-05-10):Certificate 一张扩展表,放在 EmergencyContact
// 之后的扩展子表段;Certificate.memberId / verifiedBy 引用 Member.id,supersededByCertId
// 自引用 Certificate.id,全部 ON DELETE Restrict;CASCADE 兜底自引用与跨表依赖。
//
// V2 第一阶段批次 3 追加(2026-05-11):4 张新表(Activity / ActivityRegistration /
// AttendanceSheet / AttendanceRecord);全部 FK ON DELETE Restrict(沿 R20 / Q-S21);
// 顺序:孙表(AttendanceRecord)→ 子表(AttendanceSheet / ActivityRegistration)→ 父表(Activity)
// 在前;CASCADE 兜底跨外键依赖。
//   - AttendanceRecord.sheetId → AttendanceSheet.id
//   - AttendanceRecord.registrationId → ActivityRegistration.id(Q-S21 Restrict)
//   - AttendanceSheet.activityId / ActivityRegistration.activityId → Activity.id
//   - Activity.organizationId → Organization.id
//   - AttendanceSheet.finalReviewerUserId → User.id(批次 4-A 新增)
//
// V2 第一阶段批次 4-A 追加(2026-05-12):ContributionRule 1 张表;
// 仅持有 3 条审计 FK(createdByUserId / updatedByUserId / deletedByUserId)指向 User,
// **不被任何其它表 FK 引用**;真实业务关联 activityTypeCode / attendanceRoleCode 是字典 code 字符串,
// 非外键。因此放在 User 之前即可由 CASCADE 自然清理,放在列首作为独立的小表。
//   - ContributionRule.createdByUserId / updatedByUserId / deletedByUserId → User.id(Restrict)
//
// V2 第一阶段批次 6 追加(2026-05-12):audit_logs 1 张表(物理名小写,Prisma `@@map`);
// 仅持有 1 条 FK actorUserId → User.id(Restrict);**不被任何其它表 FK 引用**;
// 放在 User 之前,确保 TRUNCATE User 时不被 Restrict FK 阻塞(CASCADE 兜底亦可)。
// 单 spec 内频繁清表用 test/helpers/audit-logs-cleanup.ts(truncateAuditLogsTestOnly)。
//
// V2.x C-6 RBAC 追加(2026-05-14;实施 PR #3):4 张 RBAC 表(物理名小写,Prisma `@@map`):
//   user_roles / role_permissions / roles / permissions
// FK 关系(沿 D7 v1.1 §4.3 / §4.4):
//   - user_roles.userId / createdBy → User.id(Cascade / SetNull)
//   - user_roles.roleId → roles.id(Cascade)
//   - role_permissions.roleId → roles.id(Cascade)
//   - role_permissions.permissionId → permissions.id(Cascade)
//   - role_permissions.createdBy → User.id(SetNull)
// 顺序:孙表(user_roles / role_permissions)→ 父表(roles / permissions);
// roles / permissions 放 audit_logs 之前(都是 User 之前的子表段);CASCADE 兜底跨表依赖。
//
// 取代了 permissions.e2e-spec.ts 中的 spec-local TRUNCATE workaround
// (PR #2 临时方案;PR #3 公共基建统一处理)。
//
// V2.x C-7 attachments 追加(2026-05-15;实施 PR #4):4 张 attachment 表(物理名小写,Prisma `@@map`):
//   attachment_mime_configs / attachment_size_limit_configs / attachments / attachment_type_configs
// FK 关系(沿 D7 v1.0 §4.1-§4.4):
//   - attachments.uploadedBy → User.id(Restrict)
//   - attachment_mime_configs.typeConfigId → attachment_type_configs.id(Restrict)
//   - attachment_size_limit_configs.typeConfigId → attachment_type_configs.id(Restrict)
// 顺序:子表(mime / size)→ 独立表(attachments)→ 根表(type_configs);CASCADE 兜底跨表依赖。
// attachments 表与 type_configs 无 DB FK(多态外键;沿 D6 Q4 A),独立位置即可。
//
// 取代了 attachment-type-configs.e2e-spec.ts 中的 spec-local TRUNCATE workaround
// (PR #3 临时方案;PR #4 公共基建统一处理;沿 PR #2 / PR #3 公共基建迁移范式)。
// SMS 基础设施 T1/T3 追加(2026-06-10):3 张 sms 表(物理名小写,Prisma `@@map`):
//   sms_settings / sms_verification_codes / sms_send_logs
// 三表均无 DB FK(评审稿 E-28:userId / codeId / updatedBy 纯 String),独立位置即可;
// 放在 audit_logs 之后的无 FK 独立段。
export async function resetDb(app: INestApplication): Promise<void> {
  assertTestDatabaseUrl(process.env.DATABASE_URL);

  const prisma = app.get(PrismaService);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "user_roles", "role_permissions", "roles", "permissions", "audit_logs", "sms_settings", "sms_verification_codes", "sms_send_logs", "attachment_mime_configs", "attachment_size_limit_configs", "attachments", "attachment_type_configs", "ContributionRule", "AttendanceRecord", "AttendanceSheet", "ActivityRegistration", "Activity", "MemberProfile", "EmergencyContact", "Certificate", "User", "MemberDepartment", "Organization", "Member", "DictItem", "DictType" RESTART IDENTITY CASCADE',
  );
}

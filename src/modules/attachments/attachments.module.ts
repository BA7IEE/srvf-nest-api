import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { AttachmentsMeLegacyController } from './controllers/attachments-me-legacy.controller';

// V2.x C-7 attachments 实施 PR #6b / #6c + PR #90:attachments 主模块声明。
//
// **依赖**:
// - DatabaseModule:PrismaService(主表 + 配置三表查询 + 业务表 ownerId 校验)
// - PermissionsModule:RbacService(Service 层 rbac.can();PermissionsModule export RbacService)
// - AuditLogsModule(PR #6c):AuditLogsService(create / delete 同事务 fail-fast 落 audit;
//     沿 cert / emergency-contacts / activities 范式)
// - StorageModule(PR #90):STORAGE_PROVIDER + StorageSettingsService;接通 accessUrl + delete 事务外删 Provider
//
// P1-C step 2(2026-05-21):新增 AttachmentsMeLegacyController(`GET /api/v2/attachments/me/uploaded`
// mobile-like 端点);endpoint path / DTO / service / Guard / RBAC / Swagger Tag 全部 zero drift
// (沿 docs/api-surface-policy.md §5 项 4 + §7 P1-C step 2 + §8 P1 禁止事项)。
//
// **controllers 数组顺序硬约束**:`AttachmentsMeLegacyController` 必须**先于**
// `AttachmentsController` 注册。两者共用 `@Controller('v2/attachments')` 前缀;`AttachmentsController`
// 含 `@Get(':id')` / `@Patch(':id')` / `@Delete(':id')` 通配方法,NestJS / Express 按注册顺序
// 匹配路由。若 `AttachmentsController` 在前,`/v2/attachments/me/uploaded` 会被匹配为
// `getById({ id: 'me/uploaded' })`(实际是 `:id` 通配吞掉 `me`),`me` 因 `IdParamDto` 长度 8-64
// 校验失败 → 400 BAD_REQUEST。沿"物理拆分零行为变更"原则,通过注册顺序保 `/me/uploaded`
// 命中字面段(沿 PR #169 users/me 拆分经验)。
@Module({
  imports: [DatabaseModule, PermissionsModule, AuditLogsModule, StorageModule],
  controllers: [AttachmentsMeLegacyController, AttachmentsController],
  providers: [AttachmentsService],
})
export class AttachmentsModule {}

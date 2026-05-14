import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';

// V2.x C-6 RBAC 实施 PR #2:permissions 模块声明。
// 沿 D7 v1.1 §4.2 / §5.1 端点 1-4。
//
// **本 PR 仅 Permission CRUD**:
// - 不写 Role / RolePermission / UserRole CRUD(留 PR #3 / PR #4 / PR #5)
// - 不写 RbacService / rbac.can() / @RbacRequired(留 PR #6)
// - 不接入任何业务模块判权(本 PR 范围之外)
@Module({
  imports: [DatabaseModule],
  controllers: [PermissionsController],
  providers: [PermissionsService],
})
export class PermissionsModule {}

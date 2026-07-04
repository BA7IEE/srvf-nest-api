import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';

// F1/A7(路线图 §4 A7;net-new 模块):跨资源批量 id→label 解析(resolve-labels)。
// imports PermissionsModule 供 MetaService 注入 RbacService(R 模式 rbac.can;沿
// positions/contribution-rules 范式)。**只读查询各资源自身的表,不注入其它业务模块的
// service**(镜像 authz 模块 ResourceResolverService 的自包含范式);无 AuditLogsModule
// (诊断读,无 audit)。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [MetaController],
  providers: [MetaService],
})
export class MetaModule {}

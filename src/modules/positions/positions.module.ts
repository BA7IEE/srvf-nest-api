import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { PositionRulesController } from './position-rules.controller';
import { PositionRulesService } from './position-rules.service';
import { PositionsController } from './positions.controller';
import { PositionsService } from './positions.service';

// 终态 scoped-authz PR3(2026-07-01;冻结稿 §3.2/§3.3/§7.2):职务定义 + 职务规则配置面模块。
// 单模块两 controller(PositionsController 5 路由 + PositionRulesController 4 路由);
// imports PermissionsModule 供 service 注入 RbacService(R 模式 rbac.can;沿 contribution-rules 范式)。
// 无 AuditLogsModule(配置面不落 audit;沿 dictionaries / memberships 范式)。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [PositionsController, PositionRulesController],
  providers: [PositionsService, PositionRulesService],
})
export class PositionsModule {}

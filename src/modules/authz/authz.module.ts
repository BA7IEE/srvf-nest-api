import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuthzService } from './authz.service';
import { ResourceResolverService } from './resource-resolver.service';

// 终态 scoped-authz PR8「AuthzService / ResourceResolver」(2026-07-02;冻结稿 §5.1/§5.2/§5.3):
// 统一判权模块(第 33 模块)。**0 controller / 0 端点 / 0 新权限码 / 0 schema** —— 只建大脑:
// AuthzService(统一鉴权,三源推导 + covers + ActionConstraint)+ ResourceResolverService(11 类资源归属解析)。
//
// 依赖:imports DatabaseModule(Prisma)+ PermissionsModule(注入 RbacService —— 无 ref 退化路径逐字
// 复用 rbac.judge〔行为锁〕+ getRoleIdsWithPermission〔角色含码批量判定,PR8 additive〕)。
// **🔴 本模块是叶子(无被反向 import;PermissionsModule 不依赖本模块),不成模块环**(forwardRef 零使用铁律)。
//
// **本刀零消费者**:exports AuthzService 但全仓无业务调用点(grep 自证)——第一个消费者是 PR9 考勤终审,
// explain 端点是 PR10,逐面迁移是 PR12。现网行为零变化。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  providers: [AuthzService, ResourceResolverService],
  exports: [AuthzService],
})
export class AuthzModule {}

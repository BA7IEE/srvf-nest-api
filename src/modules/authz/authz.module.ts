import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuthzController } from './authz.controller';
import { AuthzExplainService } from './authz-explain.service';
import { AuthzService } from './authz.service';
import { ResourceResolverService } from './resource-resolver.service';

// 终态 scoped-authz PR8「AuthzService / ResourceResolver」(2026-07-02;冻结稿 §5.1/§5.2/§5.3):
// 统一判权模块(第 33 模块)。**0 schema** —— 判权大脑:
// AuthzService(统一鉴权,三源推导 + covers + ActionConstraint)+ ResourceResolverService(11 类资源归属解析)。
//
// PR10「authz/explain 端点」(2026-07-02;冻结稿 §7.6):挂本模块第一个 controller ——
// POST admin/v1/authz/explain 权限解释(可解释性出口,1 端点 + 1 码 `authz.explain.decision`);
// AuthzExplainService 是纯消费者薄编排,**AuthzService/resolver/constraints 判权语义不动**。
//
// 依赖:imports DatabaseModule(Prisma)+ PermissionsModule(注入 RbacService —— 无 ref 退化路径逐字
// 复用 rbac.judge〔行为锁〕+ getRoleIdsWithPermission〔角色含码批量判定,PR8 additive〕)。
// **🔴 本模块是叶子(无被反向 import;PermissionsModule 不依赖本模块),不成模块环**(forwardRef 零使用铁律)。
//
// 消费者接线进度:PR9 考勤终审(finalApprove/finalReject)+ PR10 explain 端点;逐面迁移是 PR12。
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [AuthzController],
  providers: [AuthzService, ResourceResolverService, AuthzExplainService],
  exports: [AuthzService],
})
export class AuthzModule {}

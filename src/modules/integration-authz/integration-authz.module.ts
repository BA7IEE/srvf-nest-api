import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { PrismaService } from '../../database/prisma.service';
import { DirectPrincipalAuthzService } from './direct-principal-authz.service';
import { RoleBindingScopeCoveragePolicy } from './role-binding-scope-coverage.policy';

/** closure 回调:PrismaService 只在装配层出现,Policy 本体零 DB 依赖(lint 铁律 D-7)。 */
const makeClosureLookup =
  (prisma: PrismaService) =>
  async (ancestorId: string, descendantId: string): Promise<boolean> => {
    const row = await prisma.organizationClosure.findFirst({
      where: { ancestorId, descendantId },
      select: { depth: true },
    });
    return row !== null;
  };

/**
 * Integration Foundation v1 PR4(规格书 §41/§60):Principal-neutral Authz。
 *
 * DirectPrincipalAuthzService:SP 只认 direct binding,零 SUPER_ADMIN/职务/分管旁路。
 * ScopeCoveragePolicy:与 User direct binding 语义一致的共享判定(closure 查库以回调注入,
 * Policy 本体零 DB 依赖 —— lint 铁律 D-7)。
 *
 * ⭐ 本模块**不改现有 AuthzService/RbacService 一行**(characterization 全绿是 PR4 的
 * 验收前置,规格书 §60);消费方是 PR6 的 Integration Surface Guard。
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    DirectPrincipalAuthzService,
    {
      provide: RoleBindingScopeCoveragePolicy,
      useFactory: (prisma: PrismaService) =>
        new RoleBindingScopeCoveragePolicy(makeClosureLookup(prisma)),
      inject: [PrismaService],
    },
  ],
  exports: [DirectPrincipalAuthzService, RoleBindingScopeCoveragePolicy],
})
export class IntegrationAuthzModule {}

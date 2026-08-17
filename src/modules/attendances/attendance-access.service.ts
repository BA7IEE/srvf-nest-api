import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { RbacService } from '../permissions/rbac.service';

/*
 * 考勤路径的**共享准入层**(Phase 6-B 第三域第一刀,§3.2)。
 *
 * ⚠️ 文件名刻意**不叫** policy:harness eslint 规则 (j) `srvf/harness:service-boundary`
 * 禁止 src 下以 `.policy.ts` 结尾的文件 import `prisma.service` —— D-7 的 Policy 必须是纯函数(入参即全部依赖)。
 * 本层要取 Activity 聚合根锁、要回读 Sheet,**本来就不是纯 Policy**,叫 Service 才名副其实。
 * (初稿误命名为 .policy.ts,由该规则拦下 —— 命名在这里是有执行位的,不是风格问题。)
 *
 * 这一层不是"某一族"的私产 —— 它承载的是 submit / edit / softDelete / 审批八式 / 读侧
 * **三段都要过**的前置:判权、managed 面校验、聚合根锁、Sheet 回读。抽出来的直接理由是:
 * 审批族与读侧要各自成类,而这些前置被三段共用;若不先降为共享底座,被抽出的族就得
 * import 回 AttendancesService(循环依赖)—— 与 #1033 抽 invariants、#1041 抽 locator 同一理由。
 *
 * ⚠️ 做成 @Injectable 而不是模块级纯函数,是**刻意**的:这些方法要吃 authz / rbac / prisma。
 * 若改成纯函数、把判权**结果**当入参传进各族,就把「同一方法体内的数据流」变成了「跨类入参」——
 * 那会开出一个全新的失败面:**漏传一个参数 = 一条判权凭空消失,而全仓单测可以零红**
 * (6-B 第三域实测踩过)。做成注入式,则每一族的判权调用仍在**它自己的方法体内**,
 * 漏调是显式的少一行,不是隐式的少一个实参。
 *
 * ⚠️ lockActivityForAttendanceWrite 的注释随身迁来,一字不改 —— **任何 surface 都必须取**。
 * 把它挂在 `authorization === 'managed'` 这类判权分支上,会让另一条 surface 对 Activity 与
 * Registration 完全裸奔,而单读那一处看不出来(并发审计 K1 / 第七种形状 S7)。
 *
 * ⚠️ 两个写侧 select 常量随本层迁来(此前在 AttendancesService 内):它们服务写路径回读与
 * §4「loading the aggregate root」,被三段共用,是**单一真相源**。读侧查询构造仍在
 * attendance-sheet-query.service.ts,两者不重叠。
 */

export type PrismaTx = Prisma.TransactionClient;

// Sheet 简化 select(不含 records 数组 + 不含 previousSnapshot)。
// 批次 4-B 新增 finalReviewer* 3 字段(D-S5;UserResponseDto 同步,沿 baseline §11.3 可选字段)。
export const sheetSafeSelect = {
  id: true,
  activityId: true,
  submitterUserId: true,
  submittedAt: true,
  statusCode: true,
  reviewerUserId: true,
  reviewedAt: true,
  reviewNote: true,
  finalReviewerUserId: true,
  finalReviewedAt: true,
  finalReviewNote: true,
  lastSubmittedByUserId: true,
  lastSubmittedAt: true,
  returnedByUserId: true,
  returnedAt: true,
  returnNote: true,
  returnedFromStageCode: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.AttendanceSheetSelect;

// Sheet 完整 select(含 previousSnapshot,用于 edit 事务内读取上一版本快照)。
export const sheetFullSelect = {
  ...sheetSafeSelect,
  previousSnapshot: true,
  activityId: true,
} as const satisfies Prisma.AttendanceSheetSelect;

export type AttendanceSheetFullRow = Prisma.AttendanceSheetGetPayload<{
  select: typeof sheetFullSelect;
}>;

@Injectable()
export class AttendanceAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
  ) {}

  async assertCanOrThrow(
    user: CurrentUserPayload,
    action: string,
    ref?: ResourceRef,
  ): Promise<void> {
    const decision = await this.authz.explain(user, action, ref);
    if (decision.allow) return;
    if (
      decision.reason === 'self_approval_forbidden' &&
      (action === 'attendance.approve.sheet' ||
        action === 'attendance.reject.sheet' ||
        action === 'attendance.return.sheet')
    ) {
      throw new BizException(BizCode.ATTENDANCE_SELF_FIRST_REVIEW_FORBIDDEN);
    }
    if (ref && decision.reason === 'resource_not_found' && (await this.rbac.can(user, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  // 考勤写路径的 Activity 聚合锁。**任何 surface 都必须取**(并发审计 K1 / 第七种形状 S7):
  // 把它挂在 `authorization === 'managed'` / `managedActivityId !== undefined` 这类判权分支上,
  // 会让另一条 surface 对 Activity 与 Registration 完全裸奔,单读该方法看不出来。
  // 名字里刻意不带 "Managed" —— 它不是 managed 面的专属物。
  async lockActivityForAttendanceWrite(activityId: string, tx: PrismaTx): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    if (rows.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  async assertManagedAttendanceAccess(
    activityId: string,
    currentUser: CurrentUserPayload,
    tx?: PrismaTx,
  ): Promise<void> {
    if (!currentUser.memberId) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const assignment = await (tx ?? this.prisma).activityResponsibilityAssignment.findFirst({
      where: {
        activityId,
        memberId: currentUser.memberId,
        status: 'active',
        canManageAttendance: true,
      },
      select: { id: true },
    });
    if (!assignment) throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  assertManagedSheetActivity(sheetActivityId: string, managedActivityId: string | undefined): void {
    if (managedActivityId !== undefined && sheetActivityId !== managedActivityId) {
      throw new BizException(BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    }
  }

  // 找 Sheet 完整数据(含 previousSnapshot,用于 edit 路径)。
  async findSheetOrThrow(id: string, tx: PrismaTx): Promise<AttendanceSheetFullRow> {
    const sheet = await tx.attendanceSheet.findFirst({
      where: notDeletedWhere({ id }),
      select: sheetFullSelect,
    });
    if (!sheet) throw new BizException(BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    return sheet;
  }
}

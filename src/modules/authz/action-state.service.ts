import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityRegistrationStateMachine } from '../activity-registrations/activity-registration-state-machine';
import { ActivityStateMachine } from '../activities/activity-state-machine';
import { AttendanceSheetStateMachine } from '../attendances/attendance-sheet-state-machine';
import { RbacService } from '../permissions/rbac.service';
import { buildActionStateChecks, type ActionStateCheck } from './action-state-checks';
import { AuthzService } from './authz.service';
import type {
  ActionStateBatchDto,
  ActionStateBatchResponseDto,
  ActionStateItemDto,
  ActionStateResultItemDto,
} from './authz.dto';

// F3/C3「action-state/batch」(路线图 §4 C3 / D8;2026-07-04):批量业务态闸薄编排。
// 判定对象 = **调用者本人**(「这组按钮对我该不该亮」;入参无 userId,区别于 explain-batch 的目标用户);
// 逐项:authz.explain(caller, action, {type,id}) → deny 原样归因(11 值);allow 后已注册 action 再经
// 状态机只读复核(action-state-checks.ts 注册表)→ 状态不允许 = 'state_forbidden'。
//
// **不新增判权语义(D8 红线)**:判权(三源 / covers / ActionConstraint 自审同人)全部由
// AuthzService.explain 原样承载,本 service 只消费其 decision;状态层只消费 decide().allowed 布尔,
// statusCode 取自 decision.resource(resolver 已解析,零额外查询)。deny 是 200 数据(沿 explain 决断②)。
// 调用者判权:rbac.can('authz.action-state.decision')(R 模式单轨;缺码 → 30100),无 audit(沿 explain 决断④)。

const ACTION_STATE_PERMISSION_CODE = 'authz.action-state.decision';

@Injectable()
export class ActionStateService {
  private readonly checks: ReadonlyMap<string, ActionStateCheck>;

  constructor(
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
    attendanceSheet: AttendanceSheetStateMachine,
    activity: ActivityStateMachine,
    activityRegistration: ActivityRegistrationStateMachine,
  ) {
    this.checks = buildActionStateChecks({ attendanceSheet, activity, activityRegistration });
  }

  async batch(
    caller: CurrentUserPayload,
    dto: ActionStateBatchDto,
  ): Promise<ActionStateBatchResponseDto> {
    if (!(await this.rbac.can(caller, ACTION_STATE_PERMISSION_CODE))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    // echo() 承载三处 push 共用的入参回显字段(action/resourceType/resourceId + 可选 key);
    // key 仅当请求携带时才透传进响应对象,缺省该 key 完全不存在(不是 undefined 值)。
    const echo = (item: ActionStateItemDto) => ({
      action: item.action,
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      ...(item.key !== undefined ? { key: item.key } : {}),
    });

    const items: ActionStateResultItemDto[] = [];
    for (const item of dto.items) {
      const decision = await this.authz.explain(caller, item.action, {
        type: item.resourceType,
        id: item.resourceId,
      });
      if (!decision.allow) {
        items.push({ ...echo(item), allowed: false, reason: decision.reason });
        continue;
      }

      // 状态机只读复核:仅当 action 已注册且入参 resourceType 与注册面一致时咬合;
      // statusCode 缺失(resolver 对该类型未解析出状态)= 判不了不判(镜像约束层边界哲学)。
      const check = this.checks.get(item.action);
      const statusCode = decision.resource?.statusCode ?? null;
      if (check && check.resourceType === item.resourceType && statusCode !== null) {
        if (!check.decide(statusCode)) {
          items.push({ ...echo(item), allowed: false, reason: 'state_forbidden' });
          continue;
        }
      }

      items.push({ ...echo(item), allowed: true, reason: decision.reason });
    }
    return { items };
  }
}

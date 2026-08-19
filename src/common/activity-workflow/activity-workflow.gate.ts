import { Inject, Injectable } from '@nestjs/common';

import appConfig from '../../config/app.config';
import type { AppConfig } from '../../config/app.config';
import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';

/**
 * 活动 v1.1 上线切换闸 —— 合同 §16.2 的**单一 cutover gate**。
 *
 * 合同红线原文:「不能拆成多个可独立开启的开关让同一实例进入『新打卡＋旧结算』混合状态。
 * 子能力可以有 UI 灰度,但业务真相切换必须单轨。」
 *
 * 执行位在于**本类是 `ACTIVITY_V11_WORKFLOW_ENABLED` 在 src 生产代码里的唯一读取处**:
 * 三项受控面(新结算真相写 / 旧考勤写 / 统计读面取数)全部经由本类取值,谁都无法各读各的开关。
 * 这条「唯一读取处」由 `pnpm gate:v11:check` 机器执法:把任一项改成读别的开关或写死
 * true / false,判据立刻转红(该脚本自带正对照,见 activity-workflow-gate.spec.ts)。
 *
 * ⚠️ 闸控范围**不是**合同字面的全部五项。维护者 2026-08-19 拍板:只闸**结算真相链**
 * (Punch / Settlement / Ledger / Closure / Correction)。原因是实测发现 `ActivitySession`
 * 写是**两条路径的共用前置** —— 发布活动硬性要求 live session
 * (`ACTIVITY_PUBLISH_REVIEW_LIVE_SESSION_REQUIRED`),而旧 AttendanceSheet 链只能在
 * 已发布活动上跑;若闸关时连 Session 写一起拒绝,活动根本发布不了,旧写路径会跟着一起死,
 * 那就违反了「闸关 ⇒ 旧写路径放行(今天的行为)」这条安全底线。
 * 合同点名要防的混合态是「新打卡＋旧结算」—— 两端都在本类闸控的结算真相链里。
 */
@Injectable()
export class ActivityWorkflowGate {
  constructor(@Inject(appConfig.KEY) private readonly config: AppConfig) {}

  /**
   * 闸位当前取值。**这是 src 生产代码里唯一一处读 `activityV11Workflow`**;
   * 三项受控面都必须经过本类,不得自己再读一遍配置(判据 C1 机器执法)。
   */
  isV11Enabled(): boolean {
    return this.config.activityV11Workflow.enabled;
  }

  /**
   * 新结算真相链写路径的判闸位:闸关时拒绝。
   *
   * 形状沿既有 `ACTIVITY_RESPONSIBILITY_WORKFLOW_NOT_ENABLED`(20036 / 503)——
   * 「开关没开」不是「状态不对」,而是本部署还没切到 v1.1,客户端据此隐藏入口。
   */
  assertV11WriteAllowed(): void {
    if (!this.isV11Enabled()) {
      throw new BizException(BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED);
    }
  }

  /**
   * 旧 ActivityCheckIn / AttendanceSheet 写路径的判闸位:闸**开**时拒绝。
   *
   * 与上一个方法读同一个 `isV11Enabled()` —— 这正是「单轨」的执行位:
   * 两端不可能同时放行,故实例永远进不了合同禁止的「新打卡＋旧结算」混合态。
   */
  assertLegacyWriteAllowed(): void {
    if (this.isV11Enabled()) {
      throw new BizException(BizCode.ACTIVITY_LEGACY_ATTENDANCE_WRITE_CLOSED);
    }
  }

  /**
   * 统计读面取数源:闸开读 committed 账本,闸关读 approved 考勤(今天的行为)。
   *
   * ⚠️ 与本方法**并存但刻意不一致**的是入队门槛(team-join)与
   * `computeCappedContribution` —— 维护者已拍板它们恒按 approved 算,不随本闸切换。
   * 后人见此不一致先读这条注释,别「顺手统一」:那会改掉入队门槛的业务口径。
   * 该刻意差异由判据 C4 反向锁住(入队门槛侧不得调用本闸)。
   */
  participationReadSource(): 'committed-ledger' | 'approved-attendance' {
    return this.isV11Enabled() ? 'committed-ledger' : 'approved-attendance';
  }
}

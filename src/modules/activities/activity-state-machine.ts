import { Injectable } from '@nestjs/common';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';

// Activity lifecycle 状态机(纯决策类,单一职责)。
// 沿 PR #199 characterization tests 锁定的现状行为,从 `ActivitiesService` 中
// 极小抽出(仅"搬家",不动业务行为);不持有任何依赖,不接触 DB / audit / event / DTO。
//
// **职责边界(严守"搬家不优化")**:
// - ✅ 给定 action + 当前 statusCode → 返回 decision(allowed + nextStatusCode | biz)
// - ❌ 不写 DB / 不写 audit / 不抛异常(由调用方根据 decision 抛 BizException)
// - ❌ 不接触 dictionary / organization / start-end / Q-A12 之外的业务校验
// - `completed` 唯一推进通路是管理端 `complete` 端点(published → completed)。
//
// **action 语义(对应 PR #199 characterization cases + v0.40.0 complete)**:
// - create:  → draft(initial;沿 service create 路径初始状态)
// - update:  状态机不改 status；completed/cancelled 的字段白名单由 service 校验
// - publish:  draft → published;其他态拒(沿 service line 573 + PR #199 A1 / A2 ×3)
// - cancel:   draft|published → cancelled；completed/cancelled 拒
// - terminate:published → terminated；只由已开始活动的生命周期入口在时间闸后调用
// - complete: published → completed(v0.40.0 管理端手动完结;其他态拒)
// - archive:   draft|published|completed|terminated → archived(2026-08-25 拍板;cancelled 不在内)
// - unarchive: archived → 归档时冻下来的 archivedFromStatusCode(不猜、不用常量兜底)
//
// 错误码统一沿现状:wrong state → `BizCode.ACTIVITY_STATUS_INVALID`
// (沿 PR #199 A2 / B2 / C2 全部 wrong-state cases 锁定 + v0.40.0 complete)。
//
// 与 `attendance-sheet-state-machine.ts` (PR #183) + `activity-registration-state-machine.ts`
// (PR #197) 范式一致:仅 `decide(action, currentStatusCode?)` 一个公开方法;
// `allowed: true` 总是带 `nextStatusCode`(update echo currentStatusCode,沿 attendance edit
// on PENDING 返回 nextStatusCode=PENDING 的同等范式),避免调用方 `!` 非空断言。

export const ACTIVITY_STATE_ACTIONS = [
  'create',
  'update',
  'publish',
  'cancel',
  'terminate',
  'complete',
  'archive',
  'unarchive',
] as const;

export type ActivityStateAction = (typeof ACTIVITY_STATE_ACTIONS)[number];

/** 状态闭集第 6 值(2026-08-25 归档拍板)。⚠️ DB 层无 CHECK —— 闭集只由本文件守。 */
export const ACTIVITY_STATUS_ARCHIVED = 'archived';

/**
 * 可归档的来源状态闭集,同时也是 `unarchive` 的**合法复原目标**闭集。
 *
 * ⚠️ `cancelled` 刻意不在内:维护者 2026-08-25 只拍了两套开工条件
 * (长期无人处理草稿 / 结算已关账且过等待期),取消掉的活动两套都不属于。
 * 把它顺手放进来 = 自造第三套条件。缺口如实登记,不假装已覆盖。
 */
export const ACTIVITY_ARCHIVABLE_FROM_STATUS_CODES = [
  'draft',
  'published',
  'completed',
  'terminated',
] as const;

function isArchivableFromStatus(statusCode: string): boolean {
  return (ACTIVITY_ARCHIVABLE_FROM_STATUS_CODES as readonly string[]).includes(statusCode);
}

export type ActivityStateDecision =
  | { allowed: true; nextStatusCode: string }
  | { allowed: false; biz: BizCodeEntry };

@Injectable()
export class ActivityStateMachine {
  /**
   * @param restoreStatusCode 仅 `unarchive` 读:归档时冻在 `Activity.archivedFromStatusCode`
   *   里的来源状态。**刻意不给默认值** —— 拿不到它就拒,而不是猜一个常量回退:
   *   猜错就是在静默改写活动状态,而那种错在读代码时看不出来。
   */
  decide(
    action: ActivityStateAction,
    currentStatusCode = '',
    restoreStatusCode?: string,
  ): ActivityStateDecision {
    switch (action) {
      case 'create':
        return { allowed: true, nextStatusCode: 'draft' };
      case 'update':
        // 归档 =「收进抽屉」:抽屉里的活动不接受编辑,要改先撤销归档。
        // ⚠️ 这是**新增**分支,既有五态一格未动(archived 是本刀新值,此前不可能出现)。
        if (currentStatusCode === ACTIVITY_STATUS_ARCHIVED) {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        return { allowed: true, nextStatusCode: currentStatusCode };
      case 'publish':
        if (currentStatusCode !== 'draft') {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        return { allowed: true, nextStatusCode: 'published' };
      case 'cancel':
        if (currentStatusCode !== 'draft' && currentStatusCode !== 'published') {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        return { allowed: true, nextStatusCode: 'cancelled' };
      case 'terminate':
        if (currentStatusCode !== 'published') {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        return { allowed: true, nextStatusCode: 'terminated' };
      case 'complete':
        // v0.40.0 参与域生命周期收口③:管理端手动完结,仅 published → completed;其他态拒。
        if (currentStatusCode !== 'published') {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        return { allowed: true, nextStatusCode: 'completed' };
      case 'archive':
        // 状态机只判「这个态能不能归档」;**两套开工条件**(草稿陈旧度 / 关账 + 等待期)
        // 由 ActivityArchivePolicy 单独判 —— 那是业务量的判断,不是状态边。
        if (!isArchivableFromStatus(currentStatusCode)) {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        return { allowed: true, nextStatusCode: ACTIVITY_STATUS_ARCHIVED };
      case 'unarchive':
        if (currentStatusCode !== ACTIVITY_STATUS_ARCHIVED) {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        // 复原目标必须是归档时冻下来的、且本身在可归档闭集内的值。
        // 缺失或越界一律拒:宁可让维护者看到一条明确的拒绝,也不静默写出一个新状态。
        if (restoreStatusCode === undefined || !isArchivableFromStatus(restoreStatusCode)) {
          return { allowed: false, biz: BizCode.ACTIVITY_STATUS_INVALID };
        }
        return { allowed: true, nextStatusCode: restoreStatusCode };
    }
  }
}

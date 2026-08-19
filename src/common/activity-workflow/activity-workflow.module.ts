import { Module } from '@nestjs/common';

import { ActivityWorkflowGate } from './activity-workflow.gate';

/**
 * 活动 v1.1 cutover gate 的 DI 承载。
 *
 * Nest 的模块实例在一个应用内是单例:activities 与 attendances 两个模块各自 import 本模块,
 * 拿到的是**同一个** `ActivityWorkflowGate`,而不是两份。因此不需要 `@Global()`,
 * 也就不必改 `app.module.ts`(红区,要维护者授权)—— 少动一处红区就少一道审批。
 *
 * 「只有一个闸」这条性质并不依赖实例个数:真正的执行位是判据 C1 ——
 * `ACTIVITY_V11_WORKFLOW_ENABLED` 在 src 生产代码里**只允许被 gate 一处读取**。
 * 就算将来有人多 new 出一份,它读的仍是同一份 config,不可能分叉出第二个真相。
 */
@Module({
  providers: [ActivityWorkflowGate],
  exports: [ActivityWorkflowGate],
})
export class ActivityWorkflowModule {}

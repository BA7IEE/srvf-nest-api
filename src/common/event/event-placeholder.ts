import { Logger } from '@nestjs/common';

// V2 第一阶段批次 3 业务事件占位函数(详见 docs:批次3_schema草案_*.md §19 + 决议表 Q-D6)。
//
// 设计:批次 3 不引入 @nestjs/event-emitter / 队列(沿项目铁律 R6);所有业务事件
// 经统一函数转 pino 结构化日志;批次 4 接入贡献值核算时,**仅替换本函数实现**
// (订阅 + 计算分值),业务代码零修改。
//
// 事件名锁死为 union type,新增业务事件须先经 Plan / 草案 / API 前评审,**禁止**自行扩展。
//
// 触发时机(R28 / Q-S9 / Q-S13 决议):
// - attendance.recorded:AttendanceSheet 审核通过(pending → approved)同事务内触发,
//   sheet 级事件 + records 数组(详见草案 §19.4 context schema)。
// - **approved-only**:rejected / submit / edit / delete 均不触发。
//
// 与 audit-placeholder 关系:走独立函数 / 独立 logger(R6);业务事件 vs 审计事件语义不同,
// 不共享 logger 标签。
//
// 禁止散落 TODO 注释,禁止业务代码内裸 console.log;所有业务事件必须经本函数。
export type BusinessEvent = 'attendance.recorded';

const eventLogger = new Logger('Event');

export function eventPlaceholder(event: BusinessEvent, context: Record<string, unknown>): void {
  eventLogger.log({ event: true, name: event, ...context });
}

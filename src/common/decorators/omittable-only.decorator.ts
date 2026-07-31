import { ValidateIf } from 'class-validator';

// 「可省略」与「可为空」是两件不同的事 —— 这个装饰器只表达前者。
//
// 背景(第三轮评审 findings H3 / 第四轮 P1):`@IsOptional()` 的实现是
// 「值为 `null` **或** `undefined` 时跳过后续所有校验器」。而本仓 service 判
// 「客户端到底传没传这个键」用的一律是 `=== undefined` / `!== undefined` / `??`。
// 两者语义错位,于是一个显式的 `null` 会**穿过整个契约层**抵达 service,
// 再被当成「传了」或「没传」,产生三种后果(都已实测复现):
//
//   1. 静默写错事实 —— `issuedAt: null` 走到 `new Date(null)` = **1970-01-01**,
//      作为一条正式审核事实落库,还照常参与资质门槛派生;
//   2. 500 而非 400 —— `certNumberMode: null` 一路走到 Prisma 非空列写入异常;
//   3. 200 且什么都没改 —— `dto.kind ?? before.kind` 把 `null` 当「没传」吞掉,
//      客户端拿到 200 以为改成功了。
//
// 三者里最难查的是第 3 种:没有报错、没有日志、没有异常指标。
//
// 用法(与 `@IsOptional()` 二选一,按字段的**业务语义**选,不是按写起来方便):
//
//   业务上真的可以清空        → `@IsOptional()` + TS 类型标 `T | null`
//                               + `@ApiPropertyOptional({ nullable: true, type: X })`
//                               + service 显式区分 `undefined`(保持)与 `null`(清空)
//   业务上必须有值、只是可省略 → `@OmittableOnly()` + 原有校验器,`null` 稳定 400
//
// 为什么写成具名装饰器而不是每处抄一遍 `@ValidateIf((_o, v) => v !== undefined)`:
// 抄写版下一次新增字段就会漏,而「漏一个字段」正是本轮反复抓到的那个形状。
// 具名之后它还能被机器认出来 —— eslint 执法块的 `no-nullable-is-optional`
// (eslint.harness.mjs)正是拿「有没有改用它」当唯一合规出口。
//
// 实现说明:`ValidateIf` 的回调返回 false 时,class-validator 会跳过该属性的
// **全部**校验器,所以 `undefined` 照常放行;值为 `null` 时回调返回 true,
// `null` 会落到后面的 `@IsString()` / `@IsEnum()` 之类上,由它们拒成 400。
export const OmittableOnly = (): PropertyDecorator =>
  ValidateIf((_o, value) => value !== undefined);

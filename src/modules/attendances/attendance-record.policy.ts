import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AttendanceRecordInputDto } from './attendances.dto';

// 考勤 record 域校验策略(Phase 6-B 第二域第二刀;docs/architecture-boundary.md §3.3 Policy
// 的 "domain-specific validation" + "invariant checks")。
//
// **入参即全部依赖**(比 eslint 规则 (j) 要求的更严):
// - ❌ 不 import `prisma.service` —— 文件名用**点号** `*.policy.ts`,命中
//      `eslint.harness.mjs` 规则 (j) 的 files glob,机器闸真的管得住
//      (既有 `time-overlap-policy.ts` 用横线,结构上不在该规则内)
// - ❌ 连**传入的 client** 也不收:3 次 IN 预取(dictItem / member / activityRegistration)
//      与锁后复读留在 `AttendancesService`,查询**结果**当入参传进来
// - ❌ 不判权、不写 audit、不开事务
// - ✅ 只做「这条 record 的取值合不合法」的域判定,并抛既有 BizCode
//
// ⚠️ **错误优先级即契约**:下面 `validateAndNormalizeRecord` 的判定顺序逐条复刻搬家前的
// 原始顺序(角色码 → 状态码 → 队员存在 → 保险缺报名 → 报名归属活动 → 报名归属队员/pass →
// normalize → 时间窗 → 未来签退)。**改动顺序 = 改错误码契约**,不是重构。
//
// ⚠️ 刻意**没有**搬过来的(不是遗漏):
// - `assertLockedReviewSeparation` / `assertManagedSheetActivity` —— 两者虽是纯判定,
//   但属**审核分离 / managed 面归属**,与 record 字段校验不是同一职责;并进来这个文件
//   就成了 §7 明禁的 grab-bag。它们留在 service,等有独立立项再单独成类。
// - 3 次 IN 预取本身 —— 是查询,不是判定(见上)。

// dict_type code(seed 内置真实值)。service 侧预取 where 与本文件的 key 比对共用同一份常量,
// 不另起第二份字面量。
export const DICT_TYPE_ATTENDANCE_ROLE = 'attendance_role';
export const DICT_TYPE_ATTENDANCE_STATUS = 'attendance_status';

/** normalize 后的入库形态(serviceHours 显式 number,后续在创建时转 Decimal)。 */
export type NormalizedAttendanceRecord = {
  memberId: string;
  roleCode: string;
  checkInAt: Date;
  checkOutAt: Date;
  serviceHours: number;
  attendanceStatusCode: string;
  note: string | null;
  registrationId: string | null;
};

/** 预取到的报名行:只列本策略真正读的字段(结构子类型,调用方多带字段无妨)。 */
export type RegistrationFacts = {
  id: string;
  activityId: string;
  memberId: string;
  statusCode: string;
  activityPosition: { startAt: Date | null; endAt: Date | null } | null;
};

/** 考勤时间窗来源:岗位独立时段优先,否则回落活动窗。 */
export type ScheduleWindow = { startAt: Date; endAt: Date };

/** `registrationId` 已由 `canonicalizeRecordInputs` 归一为 `string | undefined` 的入参形态。 */
export type CanonicalRecordInput = AttendanceRecordInputDto & { registrationId?: string };

export type RecordValidationContext = {
  activity: { id: string; startAt: Date; endAt: Date; requiresInsurance: boolean };
  /** `${dictTypeCode}:${itemCode}` 的命中集合(由 service 预取 dictItem 后拼装)。 */
  dictKeys: ReadonlySet<string>;
  existingMemberIds: ReadonlySet<string>;
  registrationById: ReadonlyMap<string, RegistrationFacts>;
  /** 服务端统一 `now`(C-QUAL:拒绝未来签退)。 */
  now: Date;
  windowToleranceHours: number;
};

// `@IsOptional()` 会放行运行时 null;contract 仍保持 string optional,但在共享批校验入口
// 将 null 规范化为「未传」,避免 null 进入 Prisma `in` 查询,并确保 submit/edit 对保险活动
// 使用同一缺失报名语义。
export function canonicalizeRecordInputs(
  inputs: readonly AttendanceRecordInputDto[],
): CanonicalRecordInput[] {
  return inputs.map((input) => ({
    ...input,
    registrationId: input.registrationId ?? undefined,
  }));
}

// 计算服务时长(小时,Decimal(5,2) 精度);D14 / D45 / D46 / D51。
export function spanHours(checkInAt: Date, checkOutAt: Date): number {
  const ms = checkOutAt.getTime() - checkInAt.getTime();
  return Math.round((ms / 3_600_000) * 100) / 100; // 保留 2 位小数
}

// 规范化一条 record:校验时间 + 自动计算 / 校验 serviceHours。
export function normalizeRecord(input: AttendanceRecordInputDto): NormalizedAttendanceRecord {
  const checkInAt = new Date(input.checkInAt);
  const checkOutAt = new Date(input.checkOutAt);
  if (!(checkOutAt.getTime() > checkInAt.getTime())) {
    throw new BizException(BizCode.CHECK_OUT_BEFORE_CHECK_IN);
  }
  const span = spanHours(checkInAt, checkOutAt);

  let serviceHours: number;
  if (input.serviceHours === undefined) {
    serviceHours = span;
    if (serviceHours <= 0) {
      // 极端罕见:跨度极短,四舍五入到 0;视作 invalid
      throw new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_INVALID);
    }
  } else {
    serviceHours = input.serviceHours;
    if (serviceHours <= 0) {
      throw new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_INVALID);
    }
    if (serviceHours > span) {
      throw new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN);
    }
  }

  return {
    memberId: input.memberId,
    roleCode: input.roleCode,
    checkInAt,
    checkOutAt,
    serviceHours,
    attendanceStatusCode: input.attendanceStatusCode,
    note: input.note ?? null,
    registrationId: input.registrationId ?? null,
  };
}

// F4:岗位配置了独立时段就按岗位窗判,否则回落活动窗。
export function resolveScheduleWindow(
  activityPosition: { startAt: Date | null; endAt: Date | null } | null | undefined,
  activity: ScheduleWindow,
): ScheduleWindow {
  return activityPosition !== undefined &&
    activityPosition !== null &&
    activityPosition.startAt !== null &&
    activityPosition.endAt !== null
    ? { startAt: activityPosition.startAt, endAt: activityPosition.endAt }
    : activity;
}

export function assertRecordWithinActivityWindow(
  record: Pick<NormalizedAttendanceRecord, 'checkInAt' | 'checkOutAt'>,
  schedule: ScheduleWindow,
  windowToleranceHours: number,
): void {
  const toleranceMs = windowToleranceHours * 3_600_000;
  if (
    record.checkInAt.getTime() < schedule.startAt.getTime() - toleranceMs ||
    record.checkOutAt.getTime() > schedule.endAt.getTime() + toleranceMs
  ) {
    throw new BizException(BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW);
  }
}

// 报名归属的两条判定(归属活动 / 归属队员 + pass)。submit/edit 的普通批校验与
// claim 锁后复判**共用这一份** —— 两处原本是逐字重复的两段,漂移一处就出安全缺口。
export function assertRegistrationConsistent(
  registration: RegistrationFacts | undefined,
  expect: { activityId: string; memberId: string },
): void {
  if (!registration || registration.activityId !== expect.activityId) {
    throw new BizException(BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH);
  }
  if (registration.memberId !== expect.memberId || registration.statusCode !== 'pass') {
    throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
  }
}

// 单条 record 的完整域校验 + normalize。**判定顺序即错误码契约,禁止重排**。
export function validateAndNormalizeRecord(
  input: CanonicalRecordInput,
  ctx: RecordValidationContext,
): NormalizedAttendanceRecord {
  if (!ctx.dictKeys.has(`${DICT_TYPE_ATTENDANCE_ROLE}:${input.roleCode}`)) {
    throw new BizException(BizCode.ATTENDANCE_ROLE_CODE_INVALID);
  }
  if (!ctx.dictKeys.has(`${DICT_TYPE_ATTENDANCE_STATUS}:${input.attendanceStatusCode}`)) {
    throw new BizException(BizCode.ATTENDANCE_STATUS_CODE_INVALID);
  }
  if (!ctx.existingMemberIds.has(input.memberId)) {
    throw new BizException(BizCode.MEMBER_NOT_FOUND);
  }
  const registration =
    input.registrationId === undefined ? undefined : ctx.registrationById.get(input.registrationId);
  if (ctx.activity.requiresInsurance && input.registrationId === undefined) {
    throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
  }
  if (input.registrationId !== undefined) {
    assertRegistrationConsistent(registration, {
      activityId: ctx.activity.id,
      memberId: input.memberId,
    });
  }

  const normalized = normalizeRecord(input);
  const schedule = resolveScheduleWindow(registration?.activityPosition, ctx.activity);
  assertRecordWithinActivityWindow(normalized, schedule, ctx.windowToleranceHours);
  if (normalized.checkOutAt.getTime() > ctx.now.getTime()) {
    throw new BizException(BizCode.ATTENDANCE_CHECK_OUT_IN_FUTURE);
  }
  return normalized;
}

// claim 锁后复判:按锁后重读的报名行重跑归属与时间窗判定。
// (`claimAtStatus` 只保证「锁到手时仍是 pass」,其余事实来自 claim 之前那次普通读。)
export function assertRecordAgainstLockedRegistration(
  record: NormalizedAttendanceRecord,
  registration: RegistrationFacts | undefined,
  activity: { id: string } & ScheduleWindow,
  windowToleranceHours: number,
): void {
  assertRegistrationConsistent(registration, {
    activityId: activity.id,
    memberId: record.memberId,
  });
  const schedule = resolveScheduleWindow(registration?.activityPosition, activity);
  assertRecordWithinActivityWindow(record, schedule, windowToleranceHours);
}

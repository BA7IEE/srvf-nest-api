import { Prisma } from '@prisma/client';
import { ActivityListItemDto, ActivityResponseDto } from './activities.dto';
import { deriveEffectiveActivityCapacity } from './activity-capacity';
import { deriveActivityPhase } from './activity-phase';
import type { ActivityFullRow, ActivityListRow } from './activity-access.service';
import type { ActivitySignedCover, ActivitySignedImages } from './activity-image-signing.service';

/*
 * 活动的**序列化层**(Phase 6-B 第三域第三刀,D-7 Presenter)。
 *
 * 五个纯映射:Decimal → string · JsonValue → 对象/字符串数组 · 行 → ResponseDto / ListItemDto。
 * 实测**零外部 this 依赖**(只族内互调),故做成模块级纯函数而非 @Injectable:
 * 不进 DI 图,调用方直接 import。
 *
 * ⚠️ 本文件名不含 presenter 以外的语义,且**不得 import prisma.service** ——
 * harness eslint 规则 (j) 对 *presenter*.ts 有结构性禁令(D-7:Presenter 不碰 DB,入参即全部依赖)。
 * 需要落库的判定放回 Service;需要取数的放回调用方,查询**结果**当入参传进来。
 */

// Prisma Decimal 字段 → string;null 透传。NaN 不会出现(@db.Decimal 兜底)。
export function decimalToString(d: Prisma.Decimal | null): string | null {
  return d === null ? null : d.toString();
}

// Json 字段 → 强类型;Prisma 返回 JsonValue,DTO 用 Record<string, unknown> / string[]。
export function jsonAsObject(v: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  return v;
}

export function jsonAsStringArray(v: Prisma.JsonValue | null): string[] | null {
  if (v === null || !Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string');
}

/*
 * P2-14 刀 A:封面 / 图集不再从行上直读。
 *
 * `row.coverImageUrl` / `row.galleryImageUrls` 是**裸 URL 遗留列**(已零写入路径,刀 B 删);
 * 对外的同名字段一律是**现签的短时效 URL**,由 `ActivityImageSigningService` 解析后
 * 当入参传进来。本文件是纯函数层,不能自己取数 —— 见文件头的 Presenter 契约。
 *
 * ⚠️ 参数是**必填**而不是可选带默认值:可选参数会让漏传的调用方静默返回 undefined /
 * 旧值,而那正是「读出侧看起来没坏、其实没走签名」的形状。必填 ⇒ 漏传是编译错误。
 */
export function toResponseDto(
  row: ActivityFullRow,
  images: ActivitySignedImages,
): ActivityResponseDto {
  return {
    id: row.id,
    title: row.title,
    activityTypeCode: row.activityTypeCode,
    allocationModeCode: row.allocationModeCode,
    organizationId: row.organizationId,
    initiatorMemberId: row.initiatorMemberId,
    workflowRevision: row.workflowRevision,
    startAt: row.startAt,
    endAt: row.endAt,
    location: row.location,
    description: row.description,
    capacity: deriveEffectiveActivityCapacity(row.capacity, row.activityPositions),
    genderRequirementCode: row.genderRequirementCode,
    registrationDeadline: row.registrationDeadline,
    registrationNotes: row.registrationNotes,
    statusCode: row.statusCode,
    phase: deriveActivityPhase(row.startAt, row.endAt),
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
    cancelledBy: row.cancelledBy,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    isPublicRegistration: row.isPublicRegistration,
    requiresInsurance: row.requiresInsurance,
    registrationModeCode: row.registrationModeCode,
    visibilityCode: row.visibilityCode,
    defaultCheckInRadiusMeters: row.defaultCheckInRadiusMeters,
    defaultLocationRequired: row.defaultLocationRequired,
    archiveWaitingDays: row.archiveWaitingDays,
    registrationSchema: jsonAsObject(row.registrationSchema),
    coverImageUrl: images.coverImageUrl,
    galleryImageUrls: images.galleryImageUrls,
    content: jsonAsObject(row.content),
    locationLongitude: decimalToString(row.locationLongitude),
    locationLatitude: decimalToString(row.locationLatitude),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toListItemDto(
  row: ActivityListRow,
  cover: ActivitySignedCover,
): ActivityListItemDto {
  return {
    id: row.id,
    title: row.title,
    activityTypeCode: row.activityTypeCode,
    organizationId: row.organizationId,
    startAt: row.startAt,
    endAt: row.endAt,
    location: row.location,
    description: row.description,
    capacity: deriveEffectiveActivityCapacity(row.capacity, row.activityPositions),
    genderRequirementCode: row.genderRequirementCode,
    registrationDeadline: row.registrationDeadline,
    statusCode: row.statusCode,
    phase: deriveActivityPhase(row.startAt, row.endAt),
    isPublicRegistration: row.isPublicRegistration,
    requiresInsurance: row.requiresInsurance,
    coverImageUrl: cover.coverImageUrl,
    locationLongitude: decimalToString(row.locationLongitude),
    locationLatitude: decimalToString(row.locationLatitude),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

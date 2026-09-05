import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { CreateActivityDto } from './activities.dto';
import type { AppActivityCreationPlaceDto } from './dto/app/app-managed-activity-creation-place.dto';
import type {
  AppQuickActivityCreationDto,
  AppEmergencyActivityCreationDto,
} from './dto/app/app-managed-activity-creation.dto';
import type { AppProfessionalActivityCreationDto } from './dto/app/app-managed-activity-creation-professional.dto';
import type { RegistrationFormDefinitionInput } from './registration-form-definition';

function iso(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BizException(BizCode.BAD_REQUEST);
  return date.toISOString();
}
function dateOrNull(value: string | null | undefined): string | null {
  return value == null ? null : iso(value);
}

/** Explicit wire -> command mapping. Unknown fields can never become Prisma inputs/hash omissions. */
export function mapCreationPlace(dto: AppActivityCreationPlaceDto) {
  return {
    sessionCode: dto.sessionCode,
    roleCode: dto.roleCode,
    visibilityCode: dto.visibilityCode,
    presetId: dto.presetId,
    inline:
      dto.inline === undefined
        ? undefined
        : {
            name: dto.inline.name,
            addressText: dto.inline.addressText,
            instruction: dto.inline.instruction,
            coordinate:
              dto.inline.coordinate === undefined
                ? undefined
                : {
                    longitude: dto.inline.coordinate.longitude,
                    latitude: dto.inline.coordinate.latitude,
                    coordinateSystemCode: dto.inline.coordinate.coordinateSystemCode,
                  },
            providerCode: dto.inline.providerCode,
            providerPlaceId: dto.inline.providerPlaceId,
            checkInEligible: dto.inline.checkInEligible,
            radiusMeters: dto.inline.radiusMeters,
          },
  };
}
export type CreationPlaceCommand = ReturnType<typeof mapCreationPlace>;

export function mapQuickCreation(dto: AppQuickActivityCreationDto) {
  return {
    template: {
      templateVersionId: dto.templateVersionId,
      title: dto.title,
      organizationId: dto.organizationId,
      startAt: iso(dto.startAt),
      endAt: iso(dto.endAt),
      location: dto.location,
      initiatorMemberId: dto.initiatorMemberId,
      operationKey: dto.operationKey,
    },
    confirmedCapacity: dto.confirmedCapacity,
    defaultPlaceVisibilityCode: dto.defaultPlaceVisibilityCode,
    places: (dto.places ?? []).map(mapCreationPlace),
  };
}
export type QuickCreationCommand = ReturnType<typeof mapQuickCreation>;

export function mapProfessionalCreation(dto: AppProfessionalActivityCreationDto) {
  const activity: CreateActivityDto = {
    title: dto.title,
    organizationId: dto.organizationId,
    startAt: iso(dto.startAt),
    endAt: iso(dto.endAt),
    location: dto.location,
    activityTypeCode: dto.activityTypeCode,
    allocationModeCode: dto.allocationModeCode,
    initiatorMemberId: dto.initiatorMemberId,
    description: dto.description,
    capacity: dto.capacity ?? undefined,
    genderRequirementCode: dto.genderRequirementCode,
    registrationDeadline: dateOrNull(dto.registrationDeadline),
    registrationNotes: dto.registrationNotes,
    isPublicRegistration: dto.isPublicRegistration,
    requiresInsurance: dto.requiresInsurance,
    registrationModeCode: dto.registrationModeCode,
    visibilityCode: dto.visibilityCode,
    defaultLocationRequired: dto.defaultLocationRequired,
    defaultCheckInRadiusMeters: dto.defaultCheckInRadiusMeters,
    archiveWaitingDays: dto.archiveWaitingDays,
  };
  const form: RegistrationFormDefinitionInput | undefined =
    dto.form === undefined
      ? undefined
      : {
          fields: dto.form.fields.map((field) => ({
            fieldCode: field.fieldCode,
            typeCode: field.typeCode,
            label: field.label,
            helpText: field.helpText,
            required: field.required,
            visibilityCode: field.visibilityCode,
            exportable: field.exportable,
            sortOrder: field.sortOrder,
            minValue: field.minValue,
            maxValue: field.maxValue,
            minLength: field.minLength,
            maxLength: field.maxLength,
            maxSelections: field.maxSelections,
            options: field.options?.map((option) => ({ value: option.value, label: option.label })),
            governance:
              field.governance == null
                ? field.governance
                : {
                    purposeCode: field.governance.purposeCode,
                    dataClassCode: field.governance.dataClassCode,
                    retentionPolicyCode: field.governance.retentionPolicyCode,
                    maskingPolicyCode: field.governance.maskingPolicyCode,
                    prefillSourceCode: field.governance.prefillSourceCode,
                  },
          })),
        };
  const sessions = dto.sessions.map(({ session: s, positions }) => ({
    session: {
      code: s.code,
      name: s.name,
      startAt: iso(s.startAt),
      endAt: iso(s.endAt),
      locationText: s.locationText,
      meetingPoint: s.meetingPoint,
      executionPoint: s.executionPoint,
      evacuationPoint: s.evacuationPoint,
      longitude: s.longitude,
      latitude: s.latitude,
      capacity: s.capacity,
      checkInOpenAt: iso(s.checkInOpenAt),
      checkInCloseAt: iso(s.checkInCloseAt),
      checkOutOpenAt: iso(s.checkOutOpenAt),
      checkOutCloseAt: iso(s.checkOutCloseAt),
      preparationStartAt: dateOrNull(s.preparationStartAt),
      locationRequired: s.locationRequired,
      radiusMeters: s.radiusMeters,
      lateGraceMinutes: s.lateGraceMinutes,
      earlyLeaveThresholdMinutes: s.earlyLeaveThresholdMinutes,
      sortOrder: s.sortOrder,
    },
    positions: positions.map((p) => ({
      code: p.code,
      name: p.name,
      attendanceRoleCode: p.attendanceRoleCode,
      capacity: p.capacity,
      startAt: dateOrNull(p.startAt),
      endAt: dateOrNull(p.endAt),
      genderRequirementCode: p.genderRequirementCode,
      locationRequired: p.locationRequired,
      radiusMeters: p.radiusMeters,
      leaderMemberId: p.leaderMemberId,
      description: p.description,
      equipmentNotes: p.equipmentNotes,
      sortOrder: p.sortOrder,
    })),
  }));
  const qualificationRuleSets = (dto.qualificationRuleSets ?? []).map((set) => ({
    sessionCode: set.sessionCode,
    positionCode: set.positionCode,
    rules: set.rules.map((rule) => ({
      ruleTypeCode: rule.ruleTypeCode,
      enforcementCode: rule.enforcementCode,
      operator: rule.operator,
      codes: rule.codes?.slice().sort(),
      organizationIds: rule.organizationIds?.slice().sort(),
      standardIds: rule.standardIds?.slice().sort(),
      minYears: rule.minYears,
      maxYears: rule.maxYears,
      warnScore: rule.warnScore,
      message: rule.message,
      sortOrder: rule.sortOrder,
    })),
  }));
  return {
    operationKey: dto.operationKey,
    activity,
    form,
    places: (dto.places ?? []).map(mapCreationPlace),
    sessions,
    qualificationRuleSets,
  };
}
export type ProfessionalCreationCommand = ReturnType<typeof mapProfessionalCreation>;

export function mapEmergencyCreation(dto: AppEmergencyActivityCreationDto) {
  return {
    operationKey: dto.operationKey,
    activity: {
      title: dto.title,
      organizationId: dto.organizationId,
      startAt: iso(dto.startAt),
      endAt: iso(dto.endAt),
      location: dto.location,
      activityTypeCode: dto.activityTypeCode,
      allocationModeCode: dto.allocationModeCode,
      initiatorMemberId: dto.initiatorMemberId,
    },
    organizationIds: dto.organizationIds?.slice().sort(),
    memberIds: dto.memberIds?.slice().sort(),
  };
}
export type EmergencyCreationCommand = ReturnType<typeof mapEmergencyCreation>;

/** Creation requests contain decimal coordinates/form bounds, not settlement amounts. */
function canonicalInput(input: unknown): string {
  if (input === null || typeof input === 'string' || typeof input === 'boolean')
    return JSON.stringify(input);
  if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
  if (Array.isArray(input)) {
    const items: readonly unknown[] = input;
    return `[${items.map(canonicalInput).join(',')}]`;
  }
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalInput(record[key])}`).join(',')}}`;
  }
  throw new BizException(BizCode.BAD_REQUEST);
}

export function creationRequestHash(mode: string, actorUserId: string, command: unknown): string {
  return createHash('sha256').update(canonicalInput({ mode, actorUserId, command })).digest('hex');
}

export function isCreationReceiptConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
    return false;
  const target = error.meta?.target;
  return (
    target === 'activity_creation_command_receipt_actor_command_key' ||
    (Array.isArray(target) &&
      target.length === 3 &&
      ['actorUserId', 'commandCode', 'operationKey'].every((field) => target.includes(field)))
  );
}

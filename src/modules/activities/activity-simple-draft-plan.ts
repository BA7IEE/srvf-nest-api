import { createHash } from 'node:crypto';
import { beijingDateOnly } from '../../common/datetime/date-only.util';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { ActivityTemplateDefinitionV1 } from './activity-template-definition-v1';
import { canonicalize, type CanonicalValue } from './settlement-content-hash';

/** Instance facts only. Template identity, policies, eligibility and insurance are never overrides. */
export interface SimpleActivityInstance {
  readonly capacity: number | null;
  readonly registrationDeadline: string | null;
  readonly description: string | null;
  readonly registrationNotes: string | null;
}

function invalid(): never {
  throw new BizException(BizCode.BAD_REQUEST);
}

export function parseSimpleActivityInstance(value: unknown): SimpleActivityInstance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const keys = ['capacity', 'registrationDeadline', 'description', 'registrationNotes'];
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key)))
    invalid();
  const capacity = input.capacity;
  if (
    capacity !== null &&
    (!Number.isInteger(capacity) || Number(capacity) < 1 || Number(capacity) > 2147483647)
  )
    invalid();
  const text = (key: string, limit: number) => {
    const value = input[key];
    if (value !== null && (typeof value !== 'string' || value.length > limit)) invalid();
    return value;
  };
  const registrationDeadline = text('registrationDeadline', 64);
  if (registrationDeadline !== null && !Number.isFinite(new Date(registrationDeadline).getTime()))
    invalid();
  return {
    capacity: capacity as number | null,
    registrationDeadline:
      registrationDeadline === null ? null : new Date(registrationDeadline).toISOString(),
    description: text('description', 2000),
    registrationNotes: text('registrationNotes', 2000),
  };
}

/** A deliberately narrow layout. No extra sessions, shortened duties or differentiated capacities. */
export function simpleDraftLayout(
  definition: ActivityTemplateDefinitionV1,
  startAt: Date,
  endAt: Date,
  capacity: number | null,
  location: string,
) {
  const session = definition.sessions[0];
  const position = session?.positions[0];
  for (const key of ['timePolicySelection', 'contributionPolicySelection']) {
    const selection = (definition as unknown as Record<string, unknown>)[key];
    if (selection && typeof selection === 'object') {
      for (const [field, overrides] of Object.entries(selection)) {
        if (field.endsWith('Overrides') && Array.isArray(overrides) && overrides.length > 0)
          invalid();
      }
    }
  }
  if (
    definition.activity.allocationModeCode !== 'first_come' ||
    definition.sessions.length !== 1 ||
    !session ||
    session.positions.length !== 1 ||
    !position ||
    session.startOffsetMinutes !== 0 ||
    (session.capacity ?? null) !== (definition.activity.capacity ?? null) ||
    (position.capacity ?? null) !== (definition.activity.capacity ?? null) ||
    !position.attendanceRoleCode ||
    !(
      (position.startOffsetMinutes == null && position.endOffsetMinutes == null) ||
      (position.startOffsetMinutes === 0 && position.endOffsetMinutes === session.endOffsetMinutes)
    )
  )
    invalid();
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || startAt >= endAt)
    invalid();
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 2147483647))
    invalid();
  if (beijingDateOnly(startAt).getTime() !== beijingDateOnly(endAt).getTime()) invalid();
  const add = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60000);
  const planned = {
    startAt,
    endAt,
    capacity,
    locationText: location,
    checkInOpenAt: add(startAt, session.checkInOpenOffsetMinutes),
    checkInCloseAt: add(startAt, session.checkInCloseOffsetMinutes),
    checkOutOpenAt: add(endAt, session.checkOutOpenOffsetMinutes),
    checkOutCloseAt: add(endAt, session.checkOutCloseOffsetMinutes),
    preparationStartAt:
      session.preparationStartOffsetMinutes == null
        ? null
        : add(startAt, session.preparationStartOffsetMinutes),
  };
  if (
    planned.checkInOpenAt < startAt ||
    planned.checkOutOpenAt < startAt ||
    planned.checkOutCloseAt > endAt ||
    planned.checkInOpenAt > planned.checkInCloseAt ||
    planned.checkInCloseAt > planned.checkOutCloseAt ||
    planned.checkOutOpenAt > planned.checkOutCloseAt ||
    (planned.preparationStartAt !== null &&
      (planned.preparationStartAt < startAt || planned.preparationStartAt > startAt))
  )
    throw new BizException(BizCode.ACTIVITY_SESSION_WINDOW_INVALID);
  return {
    session: planned,
    position: {
      capacity,
      startAt: position.startOffsetMinutes == null ? null : startAt,
      endAt: position.endOffsetMinutes == null ? null : endAt,
    },
  };
}

/** Fixed caller-selected aggregate projection; never an identity, authorization or request receipt. */
export function isSimpleDraftTemplate(definition: ActivityTemplateDefinitionV1): boolean {
  const start = new Date('2000-01-01T00:00:00.000Z');
  const end = new Date(start.getTime() + (definition.sessions[0]?.endOffsetMinutes ?? 0) * 60000);
  try {
    simpleDraftLayout(definition, start, end, definition.activity.capacity ?? null, 'template');
    return true;
  } catch (error) {
    if (error instanceof BizException) return false;
    throw error;
  }
}

export function simpleDraftHash(facts: CanonicalValue): string {
  return createHash('sha256').update(canonicalize(facts)).digest('hex');
}

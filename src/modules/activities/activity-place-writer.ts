import type { ActivityPlace, Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { CreationPlaceCommand } from './activity-creation-command';
import {
  selectActivityLegacyCoordinate,
  selectSessionLegacyCoordinate,
} from './activity-place-coordinate-projection';
import {
  CREATION_PLACE_ROLES,
  CREATION_PLACE_VISIBILITIES,
} from './dto/app/app-managed-activity-creation-place.dto';

export interface CreationSessionPlaceScope {
  id: string;
  code: string;
  locationText: string;
}

function badPlace(): never {
  throw new BizException(BizCode.BAD_REQUEST);
}

/** Activity-local snapshot writer. Caller owns a newly created Activity and its root transaction. */
export async function writeCreationPlaces(
  tx: Prisma.TransactionClient,
  input: {
    activityId: string;
    sessions: readonly CreationSessionPlaceScope[];
    places: readonly CreationPlaceCommand[];
    fallback?: { location: string; visibilityCode: (typeof CREATION_PLACE_VISIBILITIES)[number] };
  },
): Promise<number> {
  const sessions = new Map(input.sessions.map((s) => [s.code, s]));
  const groups = new Map<string | null, CreationPlaceCommand[]>();
  for (const place of input.places) {
    if (
      !CREATION_PLACE_ROLES.includes(place.roleCode) ||
      !CREATION_PLACE_VISIBILITIES.includes(place.visibilityCode) ||
      (place.presetId === undefined) === (place.inline === undefined)
    )
      badPlace();
    const scope = place.sessionCode ?? null;
    if (scope !== null && !sessions.has(scope)) badPlace();
    const group = groups.get(scope) ?? [];
    group.push(place);
    groups.set(scope, group);
  }
  if (input.fallback) {
    const fallback = input.fallback;
    if (!CREATION_PLACE_VISIBILITIES.includes(fallback.visibilityCode)) badPlace();
    for (const scope of [null, ...sessions.keys()]) {
      if (groups.has(scope)) continue;
      const addressText = scope === null ? fallback.location : sessions.get(scope)!.locationText;
      groups.set(scope, [
        {
          sessionCode: scope ?? undefined,
          roleCode: 'primary',
          visibilityCode: fallback.visibilityCode,
          presetId: undefined,
          inline: {
            name: addressText,
            addressText,
            instruction: undefined,
            coordinate: undefined,
            providerCode: undefined,
            providerPlaceId: undefined,
            checkInEligible: false,
            radiusMeters: undefined,
          },
        },
      ]);
    }
  }
  if (groups.size === 0) return 0;
  for (const places of groups.values()) {
    if (places.filter((p) => p.roleCode === 'primary').length !== 1) badPlace();
    for (const role of ['meeting', 'execution', 'evacuation']) {
      if (places.filter((p) => p.roleCode === role).length > 1) badPlace();
    }
  }
  // One creation command never overlays a pre-existing local snapshot.
  if (await tx.activityPlace.count({ where: { activityId: input.activityId } })) badPlace();

  // Sorted locks avoid inversion when two creations select the same presets in opposite order.
  const presetIds = [
    ...new Set(input.places.flatMap((p) => (p.presetId === undefined ? [] : [p.presetId]))),
  ].sort();
  const presets = new Map<string, Awaited<ReturnType<typeof tx.placePreset.findUniqueOrThrow>>>();
  for (const id of presetIds) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PlacePreset" WHERE "id" = ${id} FOR SHARE
    `;
    if (locked.length !== 1) badPlace();
    const preset = await tx.placePreset.findUnique({ where: { id } });
    if (!preset) badPlace();
    presets.set(id, preset);
  }
  let count = 0;
  for (const [scope, places] of groups) {
    const sessionId = scope === null ? null : sessions.get(scope)!.id;
    const rows: ActivityPlace[] = [];
    for (const place of places) {
      const preset = place.presetId === undefined ? undefined : presets.get(place.presetId);
      const local =
        preset ??
        (place.inline && {
          name: place.inline.name,
          addressText: place.inline.addressText,
          instruction: place.inline.instruction ?? null,
          longitude: place.inline.coordinate?.longitude ?? null,
          latitude: place.inline.coordinate?.latitude ?? null,
          coordinateSystemCode: place.inline.coordinate?.coordinateSystemCode ?? null,
          providerCode: place.inline.providerCode ?? null,
          providerPlaceId: place.inline.providerPlaceId ?? null,
          checkInEligible: place.inline.checkInEligible,
          radiusMeters: place.inline.radiusMeters ?? null,
        });
      if (!local || !local.name.trim() || !local.addressText.trim()) badPlace();
      rows.push(
        await tx.activityPlace.create({
          data: {
            activityId: input.activityId,
            sessionId,
            roleCode: place.roleCode,
            visibilityCode: place.visibilityCode,
            name: local.name,
            addressText: local.addressText,
            instruction: local.instruction,
            longitude: local.longitude,
            latitude: local.latitude,
            coordinateSystemCode: local.coordinateSystemCode,
            providerCode: local.providerCode,
            providerPlaceId: local.providerPlaceId,
            checkInEligible: local.checkInEligible,
            radiusMeters: local.radiusMeters,
            sourcePresetId: place.presetId ?? null,
            workflowRevision: 0,
          },
        }),
      );
      count += 1;
    }
    const candidates = rows.map((row) => ({
      id: row.id,
      activityId: row.activityId,
      sessionId: row.sessionId,
      roleCode: row.roleCode,
      longitude: row.longitude?.toString() ?? null,
      latitude: row.latitude?.toString() ?? null,
      coordinateSystemCode: row.coordinateSystemCode,
    }));
    const primary = rows.filter((row) => row.roleCode === 'primary')[0];
    const projection =
      sessionId === null
        ? selectActivityLegacyCoordinate(input.activityId, candidates)
        : selectSessionLegacyCoordinate(input.activityId, sessionId, candidates);
    // A failed safe projection leaves both legacy coordinates untouched (including professional input).
    const coordinates =
      projection.kind === 'projectable'
        ? { longitude: projection.longitude, latitude: projection.latitude }
        : {};
    if (sessionId === null) {
      await tx.activity.update({
        where: { id: input.activityId },
        data: {
          location: primary.addressText,
          ...(projection.kind === 'projectable'
            ? {
                locationLongitude: projection.longitude,
                locationLatitude: projection.latitude,
              }
            : {}),
        },
      });
    } else {
      const roleText = (role: string) => rows.find((row) => row.roleCode === role)?.addressText;
      await tx.activitySession.update({
        where: { id: sessionId },
        data: {
          locationText: primary.addressText,
          ...coordinates,
          ...(roleText('meeting') === undefined ? {} : { meetingPoint: roleText('meeting') }),
          ...(roleText('execution') === undefined ? {} : { executionPoint: roleText('execution') }),
          ...(roleText('evacuation') === undefined
            ? {}
            : { evacuationPoint: roleText('evacuation') }),
        },
      });
    }
  }
  return count;
}

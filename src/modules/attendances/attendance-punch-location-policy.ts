import { Injectable } from '@nestjs/common';

import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';

export interface AttendancePunchLocationInput {
  longitude: number | null | undefined;
  latitude: number | null | undefined;
  accuracy: number | null | undefined;
}

export interface AttendancePunchLocationPolicyInput {
  required: boolean;
  radiusMeters: number | null;
  activityLongitude: number | null;
  activityLatitude: number | null;
  accuracyWarningMeters: number;
  request: AttendancePunchLocationInput;
}

export type AttendancePunchLocationDecision =
  | {
      allowed: true;
      longitude: number | null;
      latitude: number | null;
      accuracy: number | null;
      distanceMeters: number | null;
      geoVerified: boolean;
      outOfRange: boolean;
      lowAccuracy: boolean;
    }
  | { allowed: false; bizCode: BizCodeEntry };

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function legalPoint(longitude: number, latitude: number): boolean {
  return longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
}

function haversineMeters(
  from: { longitude: number; latitude: number },
  to: { longitude: number; latitude: number },
): number {
  const radians = Math.PI / 180;
  const lat = (to.latitude - from.latitude) * radians;
  const lon = (to.longitude - from.longitude) * radians;
  const a =
    Math.sin(lat / 2) ** 2 +
    Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) * Math.sin(lon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

@Injectable()
export class AttendancePunchLocationPolicy {
  evaluate(input: AttendancePunchLocationPolicyInput): AttendancePunchLocationDecision {
    const { longitude, latitude, accuracy } = input.request;
    const hasLongitude = longitude !== null && longitude !== undefined;
    const hasLatitude = latitude !== null && latitude !== undefined;
    if (hasLongitude !== hasLatitude) return { allowed: false, bizCode: BizCode.ATTENDANCE_PUNCH_LOCATION_REQUIRED };
    if (!hasLongitude && !hasLatitude) {
      if (input.required) return { allowed: false, bizCode: BizCode.ATTENDANCE_PUNCH_LOCATION_REQUIRED };
      return {
        allowed: true,
        longitude: null,
        latitude: null,
        accuracy: null,
        distanceMeters: null,
        geoVerified: false,
        outOfRange: false,
        lowAccuracy: false,
      };
    }
    if (!finite(longitude) || !finite(latitude) || !legalPoint(longitude, latitude)) {
      return { allowed: false, bizCode: BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE };
    }
    if (accuracy !== null && accuracy !== undefined && (!finite(accuracy) || accuracy < 0)) {
      return { allowed: false, bizCode: BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE };
    }
    const normalizedAccuracy = accuracy ?? null;
    const lowAccuracy =
      normalizedAccuracy === null || normalizedAccuracy > Math.max(0, input.accuracyWarningMeters);
    if (!input.required) {
      return {
        allowed: true,
        longitude,
        latitude,
        accuracy: normalizedAccuracy,
        distanceMeters: null,
        geoVerified: false,
        outOfRange: false,
        lowAccuracy,
      };
    }
    if (
      !finite(input.activityLongitude) ||
      !finite(input.activityLatitude) ||
      !legalPoint(input.activityLongitude, input.activityLatitude) ||
      input.radiusMeters === null ||
      !Number.isFinite(input.radiusMeters) ||
      input.radiusMeters < 0
    ) {
      return { allowed: false, bizCode: BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE };
    }
    const distanceMeters = haversineMeters(
      { longitude, latitude },
      { longitude: input.activityLongitude, latitude: input.activityLatitude },
    );
    if (distanceMeters > input.radiusMeters) {
      return { allowed: false, bizCode: BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE };
    }
    return {
      allowed: true,
      longitude,
      latitude,
      accuracy: normalizedAccuracy,
      distanceMeters,
      geoVerified: true,
      outOfRange: false,
      lowAccuracy,
    };
  }
}

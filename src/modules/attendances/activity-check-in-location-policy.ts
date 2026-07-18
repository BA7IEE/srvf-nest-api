import { Injectable } from '@nestjs/common';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { haversineDistanceMeters } from './haversine-distance';

export interface ActivityCheckInLocationInput {
  longitude: number | null | undefined;
  latitude: number | null | undefined;
  // accuracy 只随请求进入证据；location policy 刻意不把它并入 geofence 半径。
  accuracy?: number | null;
}

export type ActivityCheckInLocationDecision =
  | {
      allowed: true;
      distanceMeters: number;
      geoVerified: true;
      outOfRange: false;
    }
  | { allowed: false; biz: BizCodeEntry };

@Injectable()
export class ActivityCheckInLocationPolicy {
  evaluate(
    activityLocation: ActivityCheckInLocationInput,
    requestLocation: ActivityCheckInLocationInput,
    radiusMeters: number,
  ): ActivityCheckInLocationDecision {
    const activityPoint = this.toGeoPoint(activityLocation);
    const requestPoint = this.toGeoPoint(requestLocation);
    if (
      activityPoint === null ||
      requestPoint === null ||
      !Number.isFinite(radiusMeters) ||
      radiusMeters < 0
    ) {
      return this.denied();
    }

    try {
      const distanceMeters = haversineDistanceMeters(requestPoint, activityPoint);
      if (distanceMeters > radiusMeters) return this.denied();
      return {
        allowed: true,
        distanceMeters,
        geoVerified: true,
        outOfRange: false,
      };
    } catch (error) {
      // 数值异常同样 fail closed；未知编程错误不吞掉。
      if (error instanceof RangeError) return this.denied();
      throw error;
    }
  }

  private toGeoPoint(
    input: ActivityCheckInLocationInput,
  ): { longitude: number; latitude: number } | null {
    const { longitude, latitude } = input;
    if (
      typeof longitude !== 'number' ||
      typeof latitude !== 'number' ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90
    ) {
      return null;
    }
    return { longitude, latitude };
  }

  private denied(): ActivityCheckInLocationDecision {
    return {
      allowed: false,
      biz: BizCode.ACTIVITY_CHECK_IN_LOCATION_VERIFICATION_FAILED,
    };
  }
}

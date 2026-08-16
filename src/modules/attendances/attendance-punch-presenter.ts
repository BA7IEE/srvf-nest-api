import { Injectable } from '@nestjs/common';

import type {
  AppActivityPunchReceiptDto,
  AppActivityPunchStateDto,
} from './dto/app/app-activity-punch.dto';

export interface AttendancePunchPresentation {
  eventId: string;
  eventTypeCode: string;
  occurredAt: Date;
  segmentStatusCode: 'open' | 'closed_valid' | 'closed_zero';
  distanceMeters: number | null;
  geoVerified: boolean;
  lowAccuracy: boolean;
  nextAllowedAction: 'check_in' | 'check_out';
}

@Injectable()
export class AttendancePunchPresenter {
  presentReceipt(
    row: AttendancePunchPresentation,
    serverTime: Date,
  ): AppActivityPunchReceiptDto {
    return {
      eventId: row.eventId,
      eventTypeCode: row.eventTypeCode,
      occurredAt: row.occurredAt,
      segmentStatusCode: row.segmentStatusCode,
      serverTime,
      distanceMeters: row.distanceMeters === null ? null : row.distanceMeters.toFixed(2),
      geoVerified: row.geoVerified,
      lowAccuracy: row.lowAccuracy,
      nextAllowedAction: row.nextAllowedAction,
    };
  }

  presentState(input: {
    isPresent: boolean;
    checkInAt: Date | null;
    checkOutAllowedAt: Date | null;
    distanceMeters: number | null;
    geoVerified: boolean;
    lowAccuracy: boolean;
    serverTime: Date;
  }): AppActivityPunchStateDto {
    return {
      isPresent: input.isPresent,
      checkInAt: input.checkInAt,
      checkOutAllowedAt: input.checkOutAllowedAt,
      distanceMeters: input.distanceMeters === null ? null : input.distanceMeters.toFixed(2),
      geoVerified: input.geoVerified,
      lowAccuracy: input.lowAccuracy,
      serverTime: input.serverTime,
      nextAllowedAction: input.isPresent ? 'check_out' : 'check_in',
    };
  }
}

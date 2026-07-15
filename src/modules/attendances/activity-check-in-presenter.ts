import { Injectable } from '@nestjs/common';
import {
  ActivityCheckInFieldPolicy,
  type AppActivityCheckInRow,
} from './activity-check-in-field-policy';
import { AppActivityCheckInDto } from './dto/app/app-activity-check-in.dto';

@Injectable()
export class ActivityCheckInPresenter {
  constructor(private readonly fields: ActivityCheckInFieldPolicy) {}

  toAppDto(row: AppActivityCheckInRow): AppActivityCheckInDto {
    const dto: AppActivityCheckInDto = {
      id: row.id,
      activityId: row.activityId,
      registrationId: row.registrationId,
      checkInAt: row.checkInAt,
      checkOutAt: row.checkOutAt,
      checkInDistance: row.checkInDistance?.toString() ?? null,
      checkOutDistance: row.checkOutDistance?.toString() ?? null,
      geoVerified: row.geoVerified,
      outOfRange: row.outOfRange,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    this.fields.assertAppResponse(dto as unknown as Record<string, unknown>);
    return dto;
  }
}

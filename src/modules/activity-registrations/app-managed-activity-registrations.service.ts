import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityRegistrationBulkService } from './activity-registration-bulk.service';
import type {
  ActivityRegistrationListItemDto,
  ActivityRegistrationResponseDto,
} from './activity-registrations.dto';
import { ActivityRegistrationsService } from './activity-registrations.service';
import type {
  AppManagedRegistrationBulkResponseDto,
  AppManagedRegistrationDto,
  AppManagedRegistrationListItemDto,
  AppManagedRegistrationsQueryDto,
  ApproveAppManagedRegistrationDto,
  BulkReviewAppManagedRegistrationsDto,
  CancelAppManagedRegistrationDto,
  RejectAppManagedRegistrationDto,
} from './dto/app/app-managed-registration.dto';

@Injectable()
export class AppManagedActivityRegistrationsService {
  constructor(
    private readonly registrations: ActivityRegistrationsService,
    private readonly bulk: ActivityRegistrationBulkService,
  ) {}

  async list(
    activityId: string,
    query: AppManagedRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AppManagedRegistrationListItemDto>> {
    const result = await this.registrations.list(activityId, query, currentUser, 'managed');
    return {
      ...result,
      items: result.items.map((item) => this.toListItem(item)),
    };
  }

  async approve(
    activityId: string,
    registrationId: string,
    dto: ApproveAppManagedRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedRegistrationDto> {
    const result = await this.registrations.approve(
      activityId,
      registrationId,
      dto,
      currentUser,
      auditMeta,
      'managed',
    );
    return this.toDto(result);
  }

  async reject(
    activityId: string,
    registrationId: string,
    dto: RejectAppManagedRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedRegistrationDto> {
    const result = await this.registrations.reject(
      activityId,
      registrationId,
      dto,
      currentUser,
      auditMeta,
      'managed',
    );
    return this.toDto(result);
  }

  async cancel(
    activityId: string,
    registrationId: string,
    dto: CancelAppManagedRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedRegistrationDto> {
    const result = await this.registrations.cancelAdmin(
      activityId,
      registrationId,
      dto,
      currentUser,
      auditMeta,
      'managed',
    );
    return this.toDto(result);
  }

  async reopen(
    activityId: string,
    registrationId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedRegistrationDto> {
    const result = await this.registrations.reopen(
      activityId,
      registrationId,
      currentUser,
      auditMeta,
      'managed',
    );
    return this.toDto(result);
  }

  async bulkApprove(
    activityId: string,
    dto: BulkReviewAppManagedRegistrationsDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedRegistrationBulkResponseDto> {
    return this.bulk.approve(activityId, dto, currentUser, auditMeta, 'managed');
  }

  async bulkReject(
    activityId: string,
    dto: BulkReviewAppManagedRegistrationsDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedRegistrationBulkResponseDto> {
    return this.bulk.reject(activityId, dto, currentUser, auditMeta, 'managed');
  }

  private toListItem(item: ActivityRegistrationListItemDto): AppManagedRegistrationListItemDto {
    return {
      registrationId: item.id,
      activityId: item.activityId,
      activityPosition: item.activityPosition,
      member: {
        id: item.memberId,
        memberNo: item.memberNo,
        displayName: item.memberDisplayName,
      },
      statusCode: item.statusCode,
      waitlistPosition: item.waitlistPosition,
      registeredAt: item.registeredAt,
      reviewedAt: item.reviewedAt,
      cancelledAt: item.cancelledAt,
      createdAt: item.createdAt,
    };
  }

  private toDto(item: ActivityRegistrationResponseDto): AppManagedRegistrationDto {
    return {
      registrationId: item.id,
      activityId: item.activityId,
      memberId: item.memberId,
      statusCode: item.statusCode,
      registeredAt: item.registeredAt,
      reviewedAt: item.reviewedAt,
      reviewNote: item.reviewNote,
      extras: item.extras,
      cancelledAt: item.cancelledAt,
      cancelReason: item.cancelReason,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}

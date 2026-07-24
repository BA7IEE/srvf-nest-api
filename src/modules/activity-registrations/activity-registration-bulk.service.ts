import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  BulkReviewRegistrationsDto,
  BulkReviewRegistrationsResponseDto,
} from './activity-registrations.dto';
import {
  ActivityRegistrationsService,
  type RegistrationAuthorization,
} from './activity-registrations.service';

// 审计刀 5 F6：薄批量编排层。每个 id 完整调用既有单条 approve/reject，因此每条各自拥有
// authz ref 判权、事务、状态机、capacity FOR UPDATE、audit 与 commit 后通知；主 god-service 零增长。
@Injectable()
export class ActivityRegistrationBulkService {
  constructor(private readonly registrations: ActivityRegistrationsService) {}

  async approve(
    activityId: string,
    dto: BulkReviewRegistrationsDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: RegistrationAuthorization = 'authz',
  ): Promise<BulkReviewRegistrationsResponseDto> {
    return this.execute(dto.ids, async (id) => {
      await this.registrations.approve(
        activityId,
        id,
        { ...(dto.reviewNote !== undefined ? { reviewNote: dto.reviewNote } : {}) },
        currentUser,
        auditMeta,
        authorization,
      );
    });
  }

  async reject(
    activityId: string,
    dto: BulkReviewRegistrationsDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: RegistrationAuthorization = 'authz',
  ): Promise<BulkReviewRegistrationsResponseDto> {
    const reviewNote = dto.reviewNote?.trim() || '批量驳回';
    return this.execute(dto.ids, async (id) => {
      await this.registrations.reject(
        activityId,
        id,
        { reviewNote },
        currentUser,
        auditMeta,
        authorization,
      );
    });
  }

  private async execute(
    ids: string[],
    reviewOne: (id: string) => Promise<void>,
  ): Promise<BulkReviewRegistrationsResponseDto> {
    const result: BulkReviewRegistrationsResponseDto = { succeeded: [], failed: [] };
    // 刻意串行：保持输入/响应顺序，并让同一活动 capacity 锁的竞争路径可预测。
    for (const id of ids) {
      try {
        await reviewOne(id);
        result.succeeded.push(id);
      } catch (error) {
        const biz = error instanceof BizException ? error.biz : BizCode.INTERNAL_ERROR;
        result.failed.push({ id, code: biz.code, message: biz.message });
      }
    }
    return result;
  }
}

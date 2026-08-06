import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import {
  ActivitySettlementHttpService,
  type SettlementHttpReviewCommand,
} from '../activity-settlement-http.service';
import {
  AdminSettlementApproveCommandDto,
  AdminSettlementReviewParamsDto,
  AdminSettlementReviewResponseDto,
  AdminSettlementReturnCommandDto,
} from '../dto/admin/admin-settlement-review.dto';
import {
  AdminAttendanceSettlementListItemDto,
  AdminSettlementPostingBatchDto,
  AdminSettlementPostingBatchParamsDto,
  AdminSettlementReviewDetailDto,
  AdminSettlementVersionReadParamsDto,
  ListAdminAttendanceSettlementsQueryDto,
} from '../dto/admin/admin-settlement-read.dto';

@ApiTags('Admin - Attendance Settlements')
@ApiBearerAuth()
@Controller('admin/v1/attendance-settlements')
export class AdminAttendanceSettlementsController {
  constructor(private readonly settlements: ActivitySettlementHttpService) {}

  @Get()
  @ApiOperation({ summary: '跨活动结算审核工作台（分页） [rbac: attendance.read.sheet]' })
  @ApiWrappedPageResponse(AdminAttendanceSettlementListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: ListAdminAttendanceSettlementsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<PageResultDto<AdminAttendanceSettlementListItemDto>> {
    return this.settlements.reviewWorkbench(query, user);
  }

  @Get(':settlementVersionId/review-detail')
  @ApiOperation({
    summary: '查看结算版本不可变审核详情、seal、差异与缺口 [rbac: attendance.read.sheet]',
  })
  @ApiWrappedOkResponse(AdminSettlementReviewDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  reviewDetail(
    @Param() params: AdminSettlementVersionReadParamsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AdminSettlementReviewDetailDto> {
    return this.settlements.reviewDetail(params.settlementVersionId, user);
  }

  @Get(':id/posting-batch')
  @ApiOperation({ summary: '查看结算版本账本批次进度 [rbac: attendance.read.sheet]' })
  @ApiWrappedOkResponse(AdminSettlementPostingBatchDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  postingBatch(
    @Param() params: AdminSettlementPostingBatchParamsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AdminSettlementPostingBatchDto> {
    return this.settlements.postingBatch(params.id, user);
  }

  @Post(':id/first-approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '一审通过结算版本 [rbac: activity.settlement-first-review.record]' })
  @ApiWrappedOkResponse(AdminSettlementReviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.SETTLEMENT_REVIEW_EXPECTED_VERSION_MISMATCH,
    BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID,
    BizCode.SETTLEMENT_REVIEW_VERSION_STATUS_INVALID,
    BizCode.SETTLEMENT_REVIEW_VERSION_MISSING,
    BizCode.SETTLEMENT_REVIEW_EVIDENCE_SEAL_STALE,
    BizCode.SETTLEMENT_REVIEW_EVIDENCE_REVISION_CHANGED,
    BizCode.SETTLEMENT_REVIEW_WORKFLOW_REVISION_CHANGED,
    BizCode.SETTLEMENT_REVIEW_CONTENT_HASH_CHANGED,
    BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
    BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT,
    BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN,
  )
  async firstApprove(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AdminSettlementReviewParamsDto,
    @Body() dto: AdminSettlementApproveCommandDto,
    @Req() req: Request,
  ): Promise<AdminSettlementReviewResponseDto> {
    return await this.settlements.review(
      params.id,
      'first',
      'approve',
      this.toApprovalCommand(dto),
      user,
      this.auditMeta(req),
    );
  }

  @Post(':id/first-return')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '一审退回结算版本 [rbac: activity.settlement-first-review.record]' })
  @ApiWrappedOkResponse(AdminSettlementReviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.SETTLEMENT_REVIEW_EXPECTED_VERSION_MISMATCH,
    BizCode.SETTLEMENT_REVIEW_RETURN_REASON_REQUIRED,
    BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID,
    BizCode.SETTLEMENT_REVIEW_VERSION_STATUS_INVALID,
    BizCode.SETTLEMENT_REVIEW_VERSION_MISSING,
    BizCode.SETTLEMENT_REVIEW_EVIDENCE_SEAL_STALE,
    BizCode.SETTLEMENT_REVIEW_EVIDENCE_REVISION_CHANGED,
    BizCode.SETTLEMENT_REVIEW_WORKFLOW_REVISION_CHANGED,
    BizCode.SETTLEMENT_REVIEW_CONTENT_HASH_CHANGED,
    BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
    BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT,
    BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN,
  )
  async firstReturn(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AdminSettlementReviewParamsDto,
    @Body() dto: AdminSettlementReturnCommandDto,
    @Req() req: Request,
  ): Promise<AdminSettlementReviewResponseDto> {
    return await this.settlements.review(
      params.id,
      'first',
      'return',
      this.toReturnCommand(dto),
      user,
      this.auditMeta(req),
    );
  }

  @Post(':id/final-approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '终审通过结算版本并准备账本批次 [rbac: activity.settlement-final-review.record]',
  })
  @ApiWrappedOkResponse(AdminSettlementReviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.SETTLEMENT_REVIEW_EXPECTED_VERSION_MISMATCH,
    BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID,
    BizCode.SETTLEMENT_REVIEW_VERSION_STATUS_INVALID,
    BizCode.SETTLEMENT_REVIEW_VERSION_MISSING,
    BizCode.SETTLEMENT_REVIEW_EVIDENCE_SEAL_STALE,
    BizCode.SETTLEMENT_REVIEW_EVIDENCE_REVISION_CHANGED,
    BizCode.SETTLEMENT_REVIEW_WORKFLOW_REVISION_CHANGED,
    BizCode.SETTLEMENT_REVIEW_CONTENT_HASH_CHANGED,
    BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
    BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT,
    BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN,
    BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN,
  )
  async finalApprove(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AdminSettlementReviewParamsDto,
    @Body() dto: AdminSettlementApproveCommandDto,
    @Req() req: Request,
  ): Promise<AdminSettlementReviewResponseDto> {
    return await this.settlements.review(
      params.id,
      'final',
      'approve',
      this.toApprovalCommand(dto),
      user,
      this.auditMeta(req),
    );
  }

  @Post(':id/final-return')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '终审退回结算版本 [rbac: activity.settlement-final-review.record]' })
  @ApiWrappedOkResponse(AdminSettlementReviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.SETTLEMENT_REVIEW_EXPECTED_VERSION_MISMATCH,
    BizCode.SETTLEMENT_REVIEW_RETURN_REASON_REQUIRED,
    BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID,
    BizCode.SETTLEMENT_REVIEW_VERSION_STATUS_INVALID,
    BizCode.SETTLEMENT_REVIEW_VERSION_MISSING,
    BizCode.SETTLEMENT_REVIEW_BATCH_ALREADY_COMMITTED,
    BizCode.SETTLEMENT_REVIEW_EVIDENCE_SEAL_STALE,
    BizCode.SETTLEMENT_REVIEW_EVIDENCE_REVISION_CHANGED,
    BizCode.SETTLEMENT_REVIEW_WORKFLOW_REVISION_CHANGED,
    BizCode.SETTLEMENT_REVIEW_CONTENT_HASH_CHANGED,
    BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
    BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT,
    BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN,
    BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN,
  )
  async finalReturn(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AdminSettlementReviewParamsDto,
    @Body() dto: AdminSettlementReturnCommandDto,
    @Req() req: Request,
  ): Promise<AdminSettlementReviewResponseDto> {
    return await this.settlements.review(
      params.id,
      'final',
      'return',
      this.toReturnCommand(dto),
      user,
      this.auditMeta(req),
    );
  }

  private toApprovalCommand(dto: AdminSettlementApproveCommandDto): SettlementHttpReviewCommand {
    return {
      operationKey: dto.operationKey,
      expectation: {
        evidenceSealId: dto.evidenceSealId,
        evidenceRevision: dto.evidenceRevision,
        populationRevision: dto.populationRevision,
        workflowRevision: dto.workflowRevision,
        contentHash: dto.contentHash,
      },
      ...(dto.note === undefined ? {} : { note: dto.note }),
    };
  }

  private toReturnCommand(dto: AdminSettlementReturnCommandDto): SettlementHttpReviewCommand {
    return {
      operationKey: dto.operationKey,
      expectation: {
        evidenceSealId: dto.evidenceSealId,
        evidenceRevision: dto.evidenceRevision,
        populationRevision: dto.populationRevision,
        workflowRevision: dto.workflowRevision,
        contentHash: dto.contentHash,
      },
      note: dto.note,
    };
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}

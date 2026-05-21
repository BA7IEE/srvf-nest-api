import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { AttachmentResponseDto } from '../attachments.dto';
import { AttachmentsService } from '../attachments.service';

// P1-C step 2(2026-05-21)Mixed Controller 物理拆分:
//   把 AttachmentsController 中 1 个 Mobile-tag 方法 `me/uploaded` 物理迁出到独立 Controller。
//   沿 docs/api-surface-policy.md §5 项 4 + §7 P1-C step 2;P1-B 第二单(PR #170)已在
//   test/e2e/attachments-me-uploaded-legacy.e2e-spec.ts 中锁定 12 项现状行为。
//
// 拆分硬约束(沿 docs/api-surface-policy.md §8 P1 禁止事项):
//   ❌ 不改 endpoint path(@Controller('v2/attachments') + @Get('me/uploaded') zero drift)
//   ❌ 不改 DTO 字段(PaginationQueryDto / AttachmentResponseDto 不变)
//   ❌ 不改 service 行为(全部委托 attachmentsService.listMyUploaded)
//   ❌ 不改 Guard / RBAC(沿"本人查自己"豁免;仅 JwtAuthGuard 兜底)
//
// 端点列表(全部 path 与 HTTP method 与拆分前 zero drift):
//   GET /api/v2/attachments/me/uploaded — 本人上传列表
//     (自动按 uploadedBy=currentUser.id 筛;不走 RBAC;沿 D7 §5.1 端点 7)
//
// 沿 PR #169 范式:类装饰器统一 `Mobile - Attachments` tag;原 dual tag
// `["Admin - Attachments", "Mobile - Attachments"]` 收敛为单 tag(沿 docs/api-surface-policy.md
// §2.1 不再新增 Mixed Controller dual tag 的终态)。
@ApiTags('Mobile - Attachments')
@ApiBearerAuth()
@Controller('v2/attachments')
export class AttachmentsMeLegacyController {
  constructor(private readonly service: AttachmentsService) {}

  @Get('me/uploaded')
  @ApiOperation({
    summary: '列出本人上传的附件(自动按 uploadedBy=currentUser.id 筛;不走 RBAC;沿"本人查自己"豁免)',
  })
  @ApiWrappedPageResponse(AttachmentResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED)
  listMyUploaded(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<PageResultDto<AttachmentResponseDto>> {
    return this.service.listMyUploaded(query, user);
  }
}

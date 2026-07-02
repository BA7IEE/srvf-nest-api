import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AnnouncementImportService } from './announcement-import.service';
import {
  AnnouncementImportRequestDto,
  AnnouncementImportResultDto,
} from './announcement-import.dto';

// 终态 scoped-authz PR11(2026-07-02;冻结稿 §8.4 / §11 PR11):公告导入两段式管理面 controller(2 路由)。
// 判权单轨 service 层 rbac.can(announcement-import.{preview,execute}.record);入口仅全局 JwtAuthGuard,
// **不**挂 @Roles。两路由复用同一请求/响应 DTO 形状(preview 零写入诊断 / execute 落库;决断④⑤)。

// 从 @Req() 构造 AuditMeta(沿 content-admin / position-assignments 范式;D8 拍板不引入 ALS)。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Announcement Import')
@ApiBearerAuth()
@Controller('admin/v1')
export class AnnouncementImportController {
  constructor(private readonly service: AnnouncementImportService) {}

  @Post('announcement-import/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '公告导入预览(零写入,逐行回显 ok/blocked/already-exists/needs-manual)[rbac: announcement-import.preview.record]',
  })
  @ApiWrappedOkResponse(AnnouncementImportResultDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  preview(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: AnnouncementImportRequestDto,
    @Req() req: Request,
  ): Promise<AnnouncementImportResultDto> {
    return this.service.preview(user, dto, buildAuditMeta(req));
  }

  @Post('announcement-import/execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '公告导入执行(逐行落库,幂等可重跑,单行失败不影响其它行)[rbac: announcement-import.execute.record]',
  })
  @ApiWrappedOkResponse(AnnouncementImportResultDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  execute(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: AnnouncementImportRequestDto,
    @Req() req: Request,
  ): Promise<AnnouncementImportResultDto> {
    return this.service.execute(user, dto, buildAuditMeta(req));
  }
}

import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { AuditLogQueryDto, AuditLogResponseDto } from './audit-logs.dto';
import { AuditLogsService } from './audit-logs.service';

// V2 第一阶段批次 6 audit_logs controller(D6 v1.1 §5 / §6 / §15.3 模块 6 文件之一)。
//
// 仅 2 个 GET 接口:list / detail。
// **禁止**新增 POST / PATCH / PUT / DELETE / export / 聚合接口(F5;红线:写入后不可改不可删)。
//
// 权限统一(§6.1):2 接口均 @Roles(SUPER_ADMIN, ADMIN);
// USER 越权 → 通用 FORBIDDEN(40300),不开 14102 模块码(沿 baseline §1.3 / D6 v1.1 §9)。
// ADMIN 越级查 SUPER_ADMIN 的 detail → 14101 FORBIDDEN_AUDIT_LOG_READ(§6.4 / D-D)。

@ApiTags('audit-logs')
@ApiBearerAuth()
@Controller('v2/audit-logs')
export class AuditLogsController {
  constructor(private readonly service: AuditLogsService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '列出审计记录(分页 + 过滤 resourceType / resourceId / event / actorUserId / startDate / endDate;ADMIN 仅看自己 OR USER 操作的记录;稳定排序 createdAt desc + id desc)',
  })
  @ApiWrappedPageResponse(AuditLogResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(
    @Query() query: AuditLogQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AuditLogResponseDto>> {
    return this.service.list(query, currentUser);
  }

  @Get(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '审计记录详情(ADMIN 越级查 SUPER_ADMIN 操作记录 → 14101;不存在 → 14001;无 update / delete 接口)',
  })
  @ApiWrappedOkResponse(AuditLogResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.AUDIT_LOG_NOT_FOUND,
    BizCode.FORBIDDEN_AUDIT_LOG_READ,
  )
  findOne(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AuditLogResponseDto> {
    return this.service.findOne(params.id, currentUser);
  }
}

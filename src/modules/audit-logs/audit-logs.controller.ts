import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
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
// 权限统一(沿 P0-F PR-4B 评审稿 §8.1,2026-05-18 落地):
// - controller 仅留 JwtAuthGuard;@Roles 装饰器已移除
// - 入口判权迁移到 Service 层 rbac.can('audit-log.read.entry')(沿评审稿 §4.2 / §6.1 / §8.2)
// - 入口拒返 RBAC_FORBIDDEN(30100)
// - **数据范围 service 层全部保留**:list ADMIN where 注入(actorUserId=self OR actorRoleSnap=USER)
// - detail 业务级越级码 FORBIDDEN_AUDIT_LOG_READ(14101)完全保留(ADMIN 越级查 SUPER_ADMIN;§6.4 / D-D)
// - AUDIT_LOG_NOT_FOUND(14001)完全保留(findOne 命中但不存在)

@ApiTags('Ops - Audit Logs')
@ApiBearerAuth()
@Controller('v2/audit-logs')
export class AuditLogsController {
  constructor(private readonly service: AuditLogsService) {}

  @Get()
  @ApiOperation({
    summary:
      '列出审计记录(分页 + 过滤 resourceType / resourceId / event / actorUserId / startDate / endDate;ADMIN 仅看自己 OR USER 操作的记录;稳定排序 createdAt desc + id desc)',
  })
  @ApiWrappedPageResponse(AuditLogResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: AuditLogQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AuditLogResponseDto>> {
    return this.service.list(query, currentUser);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      '审计记录详情(ADMIN 越级查 SUPER_ADMIN 操作记录 → 14101;不存在 → 14001;无 update / delete 接口)',
  })
  @ApiWrappedOkResponse(AuditLogResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
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

import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreateEmergencyContactDto,
  EmergencyContactResponseDto,
  UpdateEmergencyContactDto,
} from './emergency-contacts.dto';
import { EmergencyContactsService } from './emergency-contacts.service';

// V2 第一阶段批次 1 emergency_contacts controller。
// 路径嵌套在 members/:memberId/emergency-contacts 下,N:1 子资源 + 单条 CRUD。
//
// 权限(Slow-4 T2,2026-06-11,评审稿 §3.3;取代批次 1 临时 @Roles 兜底):
// 入口仅 JwtAuthGuard,判权下沉 service 层 `rbac.can('emergency-contact.*')`
// (SUPER_ADMIN 短路;biz-admin 绑全部 4 码);**不开放** USER 自助(沿批次 1)。

@ApiTags('Admin - Emergency Contacts')
@ApiBearerAuth()
@Controller('admin/v1/members/:memberId/emergency-contacts')
export class EmergencyContactsController {
  constructor(private readonly service: EmergencyContactsService) {}

  // V2 批次 6 PR #2:从 @Req() 构造 AuditMeta 显式传给 service(D6 v1.1 §11.2 / D8 拍板;
  // 不引入 cls-rs / AsyncLocalStorage)。供本 controller 读写操作复用。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @ApiOperation({
    summary:
      '列出队员紧急联系人(无分页;按 priority ASC, createdAt ASC 排序;软删项不返回) [rbac: emergency-contact.read.record]',
  })
  @ApiWrappedArrayResponse(EmergencyContactResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  list(
    @Param('memberId') memberId: string,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<EmergencyContactResponseDto[]> {
    return this.service.list(memberId, currentUser, this.buildAuditMeta(req));
  }

  @Post()
  @ApiOperation({ summary: '新增一条紧急联系人 [rbac: emergency-contact.create.record]' })
  @ApiWrappedOkResponse(EmergencyContactResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID,
  )
  create(
    @Param('memberId') memberId: string,
    @Body() dto: CreateEmergencyContactDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<EmergencyContactResponseDto> {
    return this.service.create(memberId, dto, currentUser, this.buildAuditMeta(req));
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '更新一条紧急联系人(全字段 optional;**禁止** memberId / id 入参) [rbac: emergency-contact.update.record]',
  })
  @ApiWrappedOkResponse(EmergencyContactResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.EMERGENCY_CONTACT_NOT_FOUND,
    BizCode.EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER,
    BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID,
  )
  update(
    @Param('memberId') memberId: string,
    @Param('id') id: string,
    @Body() dto: UpdateEmergencyContactDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<EmergencyContactResponseDto> {
    return this.service.update(memberId, id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Delete(':id')
  @ApiOperation({
    summary: '软删一条紧急联系人(写 deletedAt;不物理删除) [rbac: emergency-contact.delete.record]',
  })
  @ApiWrappedOkResponse(EmergencyContactResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.EMERGENCY_CONTACT_NOT_FOUND,
    BizCode.EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER,
  )
  softDelete(
    @Param('memberId') memberId: string,
    @Param('id') id: string,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<EmergencyContactResponseDto> {
    return this.service.softDelete(memberId, id, currentUser, this.buildAuditMeta(req));
  }
}

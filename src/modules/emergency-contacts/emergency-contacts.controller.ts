import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
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
import { Roles } from '../../common/decorators/roles.decorator';
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
// 临时权限(批次 1 评审 §5.1):全部 ADMIN / SUPER_ADMIN 兜底,**不开放** USER 自助。

@ApiTags('Admin - Emergency Contacts')
@ApiBearerAuth()
@Controller([
  'v2/members/:memberId/emergency-contacts',
  'admin/v1/members/:memberId/emergency-contacts',
])
export class EmergencyContactsController {
  constructor(private readonly service: EmergencyContactsService) {}

  // V2 批次 6 PR #2:从 @Req() 构造 AuditMeta 显式传给 service(D6 v1.1 §11.2 / D8 拍板;
  // 不引入 cls-rs / AsyncLocalStorage)。仅供本 controller 写操作内部复用。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '列出队员紧急联系人(无分页;按 priority ASC, createdAt ASC 排序;软删项不返回)',
  })
  @ApiWrappedArrayResponse(EmergencyContactResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  list(
    @Param('memberId') memberId: string,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<EmergencyContactResponseDto[]> {
    return this.service.list(memberId, currentUser);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '新增一条紧急联系人' })
  @ApiWrappedOkResponse(EmergencyContactResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '更新一条紧急联系人(全字段 optional;**禁止** memberId / id 入参)',
  })
  @ApiWrappedOkResponse(EmergencyContactResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '软删一条紧急联系人(写 deletedAt;不物理删除)' })
  @ApiWrappedOkResponse(EmergencyContactResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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

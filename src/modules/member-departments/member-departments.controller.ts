import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { MemberDepartmentResponseDto, SetMemberDepartmentDto } from './member-departments.dto';
import { MemberDepartmentsService } from './member-departments.service';

// 路径嵌套在 members/:memberId/ 下作为子资源(语义"队员的部门");contract §5.1 锁定。
// 模块独立(src/modules/member-departments/),路径仍嵌套(controller 路径配置)。
//
// 单数 'department':一人一部门(D7-min MD-6;V2 第一阶段不做多部门)。
//
// 路径参数 memberId 由 NestJS 自动绑定;不通过 IdParamDto(因为 IdParamDto 字段名固定 'id'),
// 直接 @Param('memberId') 拿值,DTO 校验由 service 层 findMemberOrThrow 兜底。
//
// **权限标注**(P0-F PR-2A,2026-05-18):入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;
// 全部判权迁移到 MemberDepartmentsService 内 `rbac.can()`,失败抛
// BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 PR-1 attachments F3 v1.0 范本。
// D4=A:动词采用 set.current / clear.current(业务语义清晰优先;沿 PR-1 rbac.config.reload 范式)。
// 映射 seed 新增 3 条权限点:member-department.{read,set,clear}.current。

@ApiTags('member-departments')
@ApiBearerAuth()
@Controller('v2/members/:memberId/department')
export class MemberDepartmentsController {
  constructor(private readonly service: MemberDepartmentsService) {}

  @Get()
  @ApiOperation({ summary: '查队员当前部门归属(无归属返 data: null)' })
  @ApiWrappedOkResponse(MemberDepartmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  findCurrent(
    @CurrentUser() user: CurrentUserPayload,
    @Param('memberId') memberId: string,
  ): Promise<MemberDepartmentResponseDto | null> {
    return this.service.findCurrent(user, memberId);
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '幂等设置队员正式部门(已有归属时软删旧 + 创建新;同 org 直接返回)',
  })
  @ApiWrappedOkResponse(MemberDepartmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.MEMBER_INACTIVE,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.MEMBER_DEPARTMENT_ALREADY_EXISTS,
  )
  set(
    @CurrentUser() user: CurrentUserPayload,
    @Param('memberId') memberId: string,
    @Body() dto: SetMemberDepartmentDto,
  ): Promise<MemberDepartmentResponseDto> {
    return this.service.set(user, memberId, dto);
  }

  @Delete()
  @ApiOperation({ summary: '解除当前部门归属(软删中间表行;非 SA 也可)' })
  @ApiWrappedOkResponse(MemberDepartmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_DEPARTMENT_NOT_FOUND,
  )
  remove(
    @CurrentUser() user: CurrentUserPayload,
    @Param('memberId') memberId: string,
  ): Promise<MemberDepartmentResponseDto> {
    return this.service.remove(user, memberId);
  }
}

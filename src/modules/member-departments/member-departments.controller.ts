import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
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

@ApiTags('member-departments')
@ApiBearerAuth()
@Controller('v2/members/:memberId/department')
export class MemberDepartmentsController {
  constructor(private readonly service: MemberDepartmentsService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '查队员当前部门归属(无归属返 data: null)' })
  @ApiWrappedOkResponse(MemberDepartmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  findCurrent(@Param('memberId') memberId: string): Promise<MemberDepartmentResponseDto | null> {
    return this.service.findCurrent(memberId);
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '幂等设置队员正式部门(已有归属时软删旧 + 创建新;同 org 直接返回)',
  })
  @ApiWrappedOkResponse(MemberDepartmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.MEMBER_INACTIVE,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.MEMBER_DEPARTMENT_ALREADY_EXISTS,
  )
  set(
    @Param('memberId') memberId: string,
    @Body() dto: SetMemberDepartmentDto,
  ): Promise<MemberDepartmentResponseDto> {
    return this.service.set(memberId, dto);
  }

  @Delete()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '解除当前部门归属(软删中间表行;非 SA 也可)' })
  @ApiWrappedOkResponse(MemberDepartmentResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_DEPARTMENT_NOT_FOUND,
  )
  remove(@Param('memberId') memberId: string): Promise<MemberDepartmentResponseDto> {
    return this.service.remove(memberId);
  }
}

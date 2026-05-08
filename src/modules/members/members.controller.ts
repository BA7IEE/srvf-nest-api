import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  CreateMemberDto,
  ListMembersQueryDto,
  MemberResponseDto,
  UpdateMemberDto,
  UpdateMemberStatusDto,
} from './members.dto';
import { MembersService } from './members.service';

// /api/v2/members(6 接口);路径前缀:全局 /api(main.ts)+ 'v2/members'。
// 权限:GET/POST/PATCH = ADMIN/SUPER_ADMIN;DELETE = SUPER_ADMIN 专属(高危)。

@ApiTags('members')
@ApiBearerAuth()
@Controller('v2/members')
export class MembersController {
  constructor(private readonly service: MembersService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '列出队员(分页;memberNo 精确查询 / gradeCode / status 过滤)' })
  @ApiWrappedPageResponse(MemberResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(@Query() query: ListMembersQueryDto): Promise<PageResultDto<MemberResponseDto>> {
    return this.service.list(query);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '创建队员(memberNo 必填,全局唯一不复用;不接收任何敏感字段)',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NO_ALREADY_EXISTS,
    BizCode.MEMBER_GRADE_CODE_INVALID,
  )
  create(@Body() dto: CreateMemberDto): Promise<MemberResponseDto> {
    return this.service.create(dto);
  }

  @Get(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '队员详情(返回 memberNo)' })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  findOne(@Param() params: IdParamDto): Promise<MemberResponseDto> {
    return this.service.findOne(params.id);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '更新队员(displayName / gradeCode;**禁止改 memberNo / status**)',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_GRADE_CODE_INVALID,
  )
  update(@Param() params: IdParamDto, @Body() dto: UpdateMemberDto): Promise<MemberResponseDto> {
    return this.service.update(params.id, dto);
  }

  @Patch(':id/status')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '切换队员 status(ACTIVE↔INACTIVE);不自动解除部门归属',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  updateStatus(
    @Param() params: IdParamDto,
    @Body() dto: UpdateMemberStatusDto,
  ): Promise<MemberResponseDto> {
    return this.service.updateStatus(params.id, dto);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: '软删队员(SUPER_ADMIN 专属;有 active 部门归属 / 绑定 user 则拒绝;非常规离队入口)',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_HAS_ACTIVE_DEPARTMENT,
    BizCode.MEMBER_HAS_LINKED_USER,
  )
  softDelete(@Param() params: IdParamDto): Promise<MemberResponseDto> {
    return this.service.softDelete(params.id);
  }
}

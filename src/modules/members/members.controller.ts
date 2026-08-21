import {
  type ArgumentsHost,
  Body,
  Catch,
  Controller,
  Delete,
  type ExceptionFilter,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiWrappedCreatedResponse,
  ApiBizErrorResponse,
  ApiNoContentResponse,
  ApiWrappedArrayResponse,
  ApiWrappedNullableResponse,
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
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  BindMemberAccountDto,
  BulkGrantMemberAccountsDto,
  BulkGrantMemberAccountsResponseDto,
  CorrectMemberIdentityDto,
  CreateMemberDto,
  GrantMemberAccountDto,
  GrantMemberAccountResponseDto,
  ListMembersQueryDto,
  MemberOffboardImpactResponseDto,
  MemberOffboardResponseDto,
  MemberAudienceTagsResponseDto,
  MemberOptionsQueryDto,
  MemberOptionsResponseDto,
  MemberResponseDto,
  UpdateMemberAccountStatusDto,
  UpdateMemberDto,
  UpdateMemberStatusDto,
  ReplaceMemberAudienceTagsDto,
  MemberOfficialPortraitDto,
  VoidMemberOfficialPortraitDto,
} from './members.dto';
import { MemberOfficialPortraitService } from './member-official-portrait.service';
import { MembersService } from './members.service';
import { RequiresPermission } from '../../common/decorators/route-authz.decorator';

// /api/admin/v1/members(14 接口,含 F1/A1 options 与队员账号闭环 v1+v2 account 全生命周期 + 批量开号 + v0.40.0 一键离队 offboard);
// 路径前缀:全局 /api(main.ts)+ 'admin/v1/members'。
// 权限(Slow-4 T2,2026-06-11,评审稿 §3.1):入口仅 JwtAuthGuard,判权下沉 service 层
// `rbac.can('member.*')`(SUPER_ADMIN 短路;biz-admin 绑 read/create/update/status);
// DELETE 走 `member.delete.record`(不绑 biz-admin,仅 SUPER_ADMIN 短路,D1=A 镜像);
// POST :id/account 走 `member.grant.account`(队员账号闭环 v1,2026-07-07;绑 **ops-admin**
// 而非 biz-admin —— 账号铸造归系统/账号面,与 user.*.account 族一致)。
// 队员账号闭环 v2(2026-07-07;冻结评审稿 docs/archive/reviews/member-account-loop-v2-review.md):
// POST :id/account/bind 与 /unbind 走 `member.bind.account`(绑 ops-admin,同族);
// POST :id/account/reopen 复用 `member.grant.account`;PATCH :id/account/status 复用既有
// `user.update.status`(零新权限码扩散,均绑 ops-admin,不绑 biz-admin)。

// issue #1055 T4:标准照 multipart。
//
// ⚠️ 与 `app-me.controller.ts` / `app-registration-upload-sessions.controller.ts` 是**同形的三份**。
// 刻意不抽公共:共享处只能落在 `src/common/filters/**`(`global-pipeline` 红区,全局
// Guard/Filter/Interceptor 影响每个请求)。三个各十行、无共享清单的 filter 各自漂移
// 也不会互相影响,代价小于动红区。
type PortraitMultipartFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

// Busboy 在「已解析字节数等于配置值」时才发 limit,故配置值取上限 +1:
// 对外接受的最大值仍是 10 MiB,第 1 个超出字节在进路由前被拒。
const PORTRAIT_MULTIPART_FILE_SIZE_LIMIT = 10 * 1024 * 1024 + 1;

// 全局 filter 把通用 multipart 413 保持在 40000。本路由有固定附件契约,
// 解析层的体积拒绝必须保住 13013,否则客户端拿到的错误码会随「在哪一层被拒」漂移。
@Catch(PayloadTooLargeException)
class PortraitUploadFileSizeFilter implements ExceptionFilter<PayloadTooLargeException> {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    response.status(BizCode.ATTACHMENT_SIZE_EXCEEDED.httpStatus).json({
      code: BizCode.ATTACHMENT_SIZE_EXCEEDED.code,
      message: BizCode.ATTACHMENT_SIZE_EXCEEDED.message,
      data: null,
    });
  }
}

@ApiTags('Admin - Members')
@ApiBearerAuth()
@Controller('admin/v1/members')
export class MembersController {
  constructor(
    private readonly service: MembersService,
    private readonly portraits: MemberOfficialPortraitService,
  ) {}

  @Get()
  @RequiresPermission('member.read.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '列出队员(分页;memberNo 精确查询 / gradeCode / status 过滤) [rbac: member.read.record]',
  })
  @ApiWrappedPageResponse(MemberResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: ListMembersQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<MemberResponseDto>> {
    return this.service.list(query, currentUser);
  }

  // F1/A1(路线图 §4;D2/D3 拍板):选择器投影,必须先于 /:id 定义(specific-before-dynamic)。
  @Get('options')
  @RequiresPermission('member.read.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '队员选择器投影(q 模糊 memberNo+realName+nickname,与列表同一套五级相关性;' +
      'limit≤100,默认 20) [rbac: member.read.record]',
  })
  @ApiWrappedOkResponse(MemberOptionsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  options(
    @Query() query: MemberOptionsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberOptionsResponseDto> {
    return this.service.options(query, currentUser);
  }

  // 队员账号闭环 v2(2026-07-07;冻结评审稿 docs/archive/reviews/member-account-loop-v2-review.md
  // §1.2 E-12):批量开号,必须先于 /:id 定义(specific-before-dynamic,镜像 options 先例)。
  // 镜像 announcement-import 批模式:逐行 skip-on-error + 逐行结果回报,非全或无。
  @Post('accounts/bulk-grant')
  @RequiresPermission('member.grant.account', { require: 'all', engine: 'rbac-global' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '批量开号(逐行 skip-on-error,单行失败不影响其余行;≤200 条) [rbac: member.grant.account]',
  })
  @ApiWrappedOkResponse(BulkGrantMemberAccountsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  bulkGrantAccounts(
    @Body() dto: BulkGrantMemberAccountsDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<BulkGrantMemberAccountsResponseDto> {
    return this.service.bulkGrantAccounts(dto, currentUser, this.buildAuditMeta(req));
  }

  @Post()
  @RequiresPermission('member.create.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '创建队员(memberNo 必填,全局唯一不复用;不接收任何敏感字段) [rbac: member.create.record]',
  })
  @ApiWrappedCreatedResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NO_ALREADY_EXISTS,
    BizCode.MEMBER_GRADE_CODE_INVALID,
  )
  create(
    @Body() dto: CreateMemberDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    return this.service.create(dto, currentUser);
  }

  // ===== issue #1055 T4:队员标准照 =====
  //
  // 四个端点(issue §8.1 写的是五个,upload-url + confirm-upload 按 T3 已拍板的口径
  // 合成一次 multipart POST —— 服务端要规范化就必须看见字节)。
  //
  // ⚠️ 装饰器沿本 controller 既有形状用 `rbac-global` 做**粗判**(有没有这个码),
  // **组织数据范围在 service 内判**(`getVisibleOrganizationScope` 取范围,再验目标 memberId
  // 在不在范围内)。issue §8.1 要求的 scoped 就落在后半截 —— 只验前半截的话,
  // A 部门的队长拿着 org-scoped 绑定就能改 B 部门队员的标准照,而 `hasPermission` 照样为 true。

  @Get(':id/official-portrait')
  @RequiresPermission('member.read.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '当前生效的队员标准照(无则返 null;另按调用者的组织数据范围过滤) [rbac: member.read.record]',
  })
  @ApiWrappedNullableResponse(MemberOfficialPortraitDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN, BizCode.MEMBER_NOT_FOUND)
  getOfficialPortrait(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberOfficialPortraitDto | null> {
    return this.portraits.getCurrent(params.id, currentUser);
  }

  @Get(':id/official-portraits')
  @RequiresPermission('member-portrait.read.history', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '队员标准照版本历史(含已顶替 / 已作废,version 倒序;另按组织数据范围过滤) [rbac: member-portrait.read.history]',
  })
  @ApiWrappedArrayResponse(MemberOfficialPortraitDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN, BizCode.MEMBER_NOT_FOUND)
  listOfficialPortraits(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberOfficialPortraitDto[]> {
    return this.portraits.listHistory(params.id, currentUser);
  }

  @Post(':id/official-portrait')
  @RequiresPermission('member-portrait.manage.record', { require: 'all', engine: 'rbac-global' })
  @HttpCode(HttpStatus.OK)
  @UseFilters(PortraitUploadFileSizeFilter)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: PORTRAIT_MULTIPART_FILE_SIZE_LIMIT, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'JPEG / PNG 原图,≤10 MiB,**5:7 ±1%** 且不低于 826×1158(服务端规范化成 826×1158 JPEG q90、白底、清 EXIF/GPS)',
        },
      },
    },
  })
  @ApiOperation({
    summary:
      '上传 / 替换队员标准照(multipart;旧版转 SUPERSEDED 同事务保留;另按组织数据范围判权) [rbac: member-portrait.manage.record]',
  })
  @ApiWrappedOkResponse(MemberOfficialPortraitDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_OFFICIAL_PORTRAIT_CONFLICT,
    BizCode.ATTACHMENT_MIME_NOT_ALLOWED,
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
    BizCode.ATTACHMENT_IMAGE_UNDECODABLE,
    BizCode.ATTACHMENT_IMAGE_ANIMATED_NOT_ALLOWED,
    BizCode.ATTACHMENT_IMAGE_TOO_SMALL,
    BizCode.ATTACHMENT_IMAGE_ASPECT_RATIO_INVALID,
    BizCode.ATTACHMENT_IMAGE_PIXELS_EXCEEDED,
  )
  uploadOfficialPortrait(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @UploadedFile() file: PortraitMultipartFile | undefined,
    @Req() req: Request,
  ): Promise<MemberOfficialPortraitDto> {
    if (file === undefined) throw new BizException(BizCode.BAD_REQUEST);
    return this.portraits.replace(
      params.id,
      currentUser,
      {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },
      this.buildAuditMeta(req),
    );
  }

  @Delete(':id/official-portrait')
  @RequiresPermission('member-portrait.manage.record', { require: 'all', engine: 'rbac-global' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      '作废当前队员标准照(ACTIVE → VOIDED,必填 reason;**不**自动回退到上一版;另按组织数据范围判权) [rbac: member-portrait.manage.record]',
  })
  @ApiNoContentResponse()
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_OFFICIAL_PORTRAIT_NOT_FOUND,
  )
  async voidOfficialPortrait(
    @Param() params: IdParamDto,
    @Body() dto: VoidMemberOfficialPortraitDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<void> {
    await this.portraits.void(params.id, currentUser, dto.reason, this.buildAuditMeta(req));
  }

  @Get(':id/audience-tags')
  @RequiresPermission('member.read.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '查询会员受众标签 [rbac: member.read.record]' })
  @ApiWrappedOkResponse(MemberAudienceTagsResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.SERVICE_UNAVAILABLE,
  )
  audienceTags(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberAudienceTagsResponseDto> {
    return this.service.getAudienceTags(params.id, currentUser);
  }

  @Put(':id/audience-tags')
  @RequiresPermission('member.update.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '全量替换会员受众标签(空数组撤销全部) [rbac: member.update.record]' })
  @ApiWrappedOkResponse(MemberAudienceTagsResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.SERVICE_UNAVAILABLE,
  )
  replaceAudienceTags(
    @Param() params: IdParamDto,
    @Body() dto: ReplaceMemberAudienceTagsDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<MemberAudienceTagsResponseDto> {
    return this.service.replaceAudienceTags(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Get(':id')
  @RequiresPermission('member.read.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '队员详情(返回 memberNo) [rbac: member.read.record]' })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  findOne(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    return this.service.findOne(params.id, currentUser);
  }

  @Patch(':id')
  @RequiresPermission('member.update.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '更新队员(realName / nickname / gradeCode;**禁止改 memberNo / status / memberSinceDate / memberOriginCode**) [rbac: member.update.record]',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_GRADE_CODE_INVALID,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    return this.service.update(params.id, dto, currentUser);
  }

  @Patch(':id/status')
  @RequiresPermission('member.update.status', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary: '切换队员 status；置 INACTIVE 时同步结束全部当前授权来源 [rbac: member.update.status]',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_OFFBOARD_ACTIVITY_HANDOFF_REQUIRED,
    BizCode.MEMBER_OFFBOARD_REGISTRATION_CLEANUP_REQUIRED,
  )
  updateStatus(
    @Param() params: IdParamDto,
    @Body() dto: UpdateMemberStatusDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<MemberResponseDto> {
    return this.service.updateStatus(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  // ===== 第七轮评审 R7-A-01:队员身份主档订正 =====
  //
  // 独立端点,不并进 PATCH /:id —— 理由见 members.service.correctIdentity 头注,
  // 以及 members.dto.ts 里 UpdateMemberDto 上方那份禁止清单(本刀一个字段都没放宽它)。
  // 路径取复数资源名 `identity-corrections`:一次订正是一条**新登记的事实**
  //(登记体落在审计事件 `member.identity.correct` 上),不是把某个开关拨一下。
  //
  // ⚠️ 装饰器沿本 controller 既有形状用 `rbac-global` 做粗判(有没有这个码),
  // **组织数据范围在 service 内判** —— assertCanOrThrow 带 { type: 'member', id } ref
  // 走三源 scoped authz,org-admin 只能订正自己范围内的队员。
  @Post(':id/identity-corrections')
  @RequiresPermission('member.correct.identity', { require: 'all', engine: 'rbac-global' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '订正队员身份事实(memberNo / memberSinceDate / memberOriginCode;必填订正理由,' +
      '改编号需二次确认;写 1 条 member.identity.correct 审计) [rbac: member.correct.identity]',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_IDENTITY_CORRECTION_NO_CHANGE,
    BizCode.MEMBER_NO_CORRECTION_NOT_CONFIRMED,
    BizCode.MEMBER_NO_ALREADY_EXISTS,
  )
  correctIdentity(
    @Param() params: IdParamDto,
    @Body() dto: CorrectMemberIdentityDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<MemberResponseDto> {
    return this.service.correctIdentity(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Delete(':id')
  @RequiresPermission('member.delete.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '软删队员(码不绑 biz-admin,仅 SUPER_ADMIN 短路;有 active 部门归属 / 绑定 user 则拒绝;非常规离队入口) [rbac: member.delete.record]',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_HAS_ACTIVE_DEPARTMENT,
    BizCode.MEMBER_HAS_LINKED_USER,
  )
  softDelete(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberResponseDto> {
    return this.service.softDelete(params.id, currentUser);
  }

  // 队员账号闭环 v1(MVP,2026-07-07):给已存在队员开通"手机验证码登录"账号(不设密码)。
  // 以后想设密码走既有"手机验证码找回/设置密码"(auth/v1/password-reset,队员自己手机号收码)。
  @Post(':id/account')
  @RequiresPermission('member.grant.account', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '给已存在队员开通登录账号(手机验证码登录,不设密码;队员已有绑定账号则拒绝) [rbac: member.grant.account]',
  })
  @ApiWrappedCreatedResponse(GrantMemberAccountResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_INACTIVE,
    BizCode.MEMBER_HAS_LINKED_USER,
    BizCode.USERNAME_ALREADY_EXISTS,
    BizCode.PHONE_ALREADY_BOUND,
  )
  grantAccount(
    @Param() params: IdParamDto,
    @Body() dto: GrantMemberAccountDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<GrantMemberAccountResponseDto> {
    return this.service.grantAccount(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  // 队员账号闭环 v2(2026-07-07;冻结评审稿 docs/archive/reviews/member-account-loop-v2-review.md):
  // 绑定既有悬空账号 / 解绑(只断链)/ 退号重开 / 队员面启停账号。均在 admin/v1、member 轴,
  // 无 App 自助面;`src/modules/auth/**` 零改动。
  @Post(':id/account/bind')
  @RequiresPermission('member.bind.account', { require: 'all', engine: 'rbac-global' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '绑定既有悬空账号到队员(账号保留原登录方式,不强制手机号) [rbac: member.bind.account]',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_INACTIVE,
    BizCode.MEMBER_HAS_LINKED_USER,
    BizCode.USER_NOT_FOUND,
    BizCode.MEMBER_ACCOUNT_TARGET_ALREADY_LINKED,
    BizCode.MEMBER_ACCOUNT_TARGET_ROLE_NOT_ALLOWED,
    BizCode.MEMBER_ACCOUNT_TARGET_NOT_ACTIVE,
  )
  bindAccount(
    @Param() params: IdParamDto,
    @Body() dto: BindMemberAccountDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<MemberResponseDto> {
    return this.service.bindAccount(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Post(':id/account/unbind')
  @RequiresPermission('member.bind.account', { require: 'all', engine: 'rbac-global' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '解绑队员账号(只断链,不停用/软删账号) [rbac: member.bind.account]',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_HAS_NO_LINKED_USER,
  )
  unbindAccount(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<MemberResponseDto> {
    return this.service.unbindAccount(params.id, currentUser, this.buildAuditMeta(req));
  }

  @Post(':id/account/reopen')
  @RequiresPermission('member.grant.account', { require: 'all', engine: 'rbac-global' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '退号重开:软删旧号 + 开新号(新手机号),单事务原子("账号打错了"一步修复) [rbac: member.grant.account]',
  })
  @ApiWrappedOkResponse(GrantMemberAccountResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_INACTIVE,
    BizCode.MEMBER_HAS_NO_LINKED_USER,
    BizCode.MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE,
    BizCode.USERNAME_ALREADY_EXISTS,
    BizCode.PHONE_ALREADY_BOUND,
  )
  reopenAccount(
    @Param() params: IdParamDto,
    @Body() dto: GrantMemberAccountDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<GrantMemberAccountResponseDto> {
    return this.service.reopenAccount(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Patch(':id/account/status')
  @RequiresPermission('user.update.status', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '队员面启/停关联账号(禁自我操作;置 DISABLED 时联动撤销 refresh) [rbac: user.update.status]',
  })
  @ApiWrappedOkResponse(MemberResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_HAS_NO_LINKED_USER,
    BizCode.MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE,
    BizCode.CANNOT_OPERATE_SELF,
  )
  updateAccountStatus(
    @Param() params: IdParamDto,
    @Body() dto: UpdateMemberAccountStatusDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<MemberResponseDto> {
    return this.service.updateAccountStatus(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Get(':id/offboard-impact')
  @RequiresPermission('member.offboard.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '离队影响预检(活动发起/负责人/协办及当前未来报名安全摘要) [rbac: member.offboard.record]',
  })
  @ApiWrappedOkResponse(MemberOffboardImpactResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  offboardImpact(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<MemberOffboardImpactResponseDto> {
    return this.service.getOffboardImpact(params.id, currentUser);
  }

  // 参与域生命周期收口⑤(v0.40.0):一键离队编排。POST(action 非幂等更新语义);无 body;
  // 单事务关闭 member、全部 active 归属、linked 账号/refresh、任职、分管与直接 RoleBinding，
  // 并写 1 条伞 audit；响应中的残留数是锁后不变式探针，正常终态恒为 0。
  @Post(':id/offboard')
  @RequiresPermission('member.offboard.record', { require: 'all', engine: 'rbac-global' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '一键离队并结束全部当前授权来源(归属/账号/任职/分管/直接绑定) [rbac: member.offboard.record]',
  })
  @ApiWrappedOkResponse(MemberOffboardResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE,
    BizCode.CANNOT_OPERATE_SELF,
    BizCode.MEMBER_OFFBOARD_ACTIVITY_HANDOFF_REQUIRED,
    BizCode.MEMBER_OFFBOARD_REGISTRATION_CLEANUP_REQUIRED,
  )
  offboard(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<MemberOffboardResponseDto> {
    return this.service.offboard(params.id, currentUser, this.buildAuditMeta(req));
  }

  // 沿 users.controller.ts / emergency-contacts.controller.ts 范式:从 @Req() 显式构造
  // AuditMeta 传给 service(D6 v1.1 §11.2 / D8 拍板;不引入 cls-rs / AsyncLocalStorage)。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}

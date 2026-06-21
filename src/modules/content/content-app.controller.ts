import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ContentAttachmentDto,
  ContentReadDetailDto,
  ContentReadListItemDto,
  ListContentReadQueryDto,
} from './content.dto';
import { ContentReadService } from './content-read.service';

// CMS 内容发布模块(第 28 模块)T4(2026-06-21):app/v1 会员读取面(评审稿 §4/§8 app)。
//
// 入口仅全局 JwtAuthGuard;**不**挂 @Roles / @Public / RBAC / 限流。准入(canUseApp=false → 403)+
// 5 档可见性(public / member / formal_member / department / management)全前置在 service;读者出参零敏感
// (无 authorUserId / 无 visibleOrganizationIds)。详情命中不可见档 → 404 防枚举;签名 URL 是范围例外 a(§5.7),
// 仅在可见级通过后返回。
@ApiTags('Mobile - Content')
@ApiBearerAuth()
@ApiExtraModels(ContentReadListItemDto, ContentReadDetailDto, ContentAttachmentDto)
@Controller('app/v1/contents')
export class ContentAppController {
  constructor(private readonly service: ContentReadService) {}

  @Get()
  @ApiOperation({
    summary:
      '会员内容列表(准入 canUseApp;按 5 档可见性过滤;keyword/tags/contentTypeCode;无 body) [auth]',
  })
  @ApiWrappedPageResponse(ContentReadListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(@Query() query: ListContentReadQueryDto, @CurrentUser() currentUser: CurrentUserPayload) {
    return this.service.appList(currentUser, query);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      '会员内容详情(准入 canUseApp;可见级不通过 → 404 防枚举;正文占位改写 + 附件签名 + viewCount 自增) [auth]',
  })
  @ApiWrappedOkResponse(ContentReadDetailDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN, BizCode.CONTENT_NOT_FOUND)
  detail(
    @Param('id') id: string,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<ContentReadDetailDto> {
    return this.service.appDetail(currentUser, id);
  }
}

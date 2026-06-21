import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { ContentPublicThrottle } from '../../common/decorators/content-public-throttle.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ContentAttachmentDto,
  ContentReadDetailDto,
  ContentReadListItemDto,
  ListContentReadQueryDto,
} from './content.dto';
import { ContentReadService } from './content-read.service';

// CMS 内容发布模块(第 28 模块)T3(2026-06-21):open/v1 公开读取面(评审稿 §8 open)。
//
// `@Public` 跳过 JwtAuthGuard(无账号公开消费,小程序前端直连);`@ContentPublicThrottle` 走第 10
// throttler `content-public` 按 IP 限流(默认 60/60s)。仅 published+public 可见;详情命中非 public →
// 404 防枚举(不区分「存在但不可见」);分页上限 50 + DTO 白名单防注入/防滥取;读者出参零敏感
// (无 authorUserId / 无 visibleOrganizationIds)。签名 URL(封面/正文图/附件)是范围例外 a(§5.7),
// 仅在可见级通过后返回。
@ApiTags('Public - Content')
@ApiExtraModels(ContentReadListItemDto, ContentReadDetailDto, ContentAttachmentDto)
@Controller('open/v1/contents')
export class ContentPublicController {
  constructor(private readonly service: ContentReadService) {}

  @Public()
  @ContentPublicThrottle()
  @Get()
  @ApiOperation({
    summary:
      '公开内容列表(仅 published+public;keyword/tags/contentTypeCode 过滤;无 body;throttler content-public) [public]',
  })
  @ApiWrappedPageResponse(ContentReadListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.TOO_MANY_REQUESTS)
  list(@Query() query: ListContentReadQueryDto) {
    return this.service.publicList(query);
  }

  @Public()
  @ContentPublicThrottle()
  @Get(':id')
  @ApiOperation({
    summary:
      '公开内容详情(仅 published+public,否则 404 防枚举;正文占位改写 + 附件签名 + viewCount 自增;throttler content-public) [public]',
  })
  @ApiWrappedOkResponse(ContentReadDetailDto)
  @ApiBizErrorResponse(BizCode.CONTENT_NOT_FOUND, BizCode.TOO_MANY_REQUESTS)
  detail(@Param('id') id: string): Promise<ContentReadDetailDto> {
    return this.service.publicDetail(id);
  }
}

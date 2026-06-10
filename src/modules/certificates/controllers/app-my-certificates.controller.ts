import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { AppMyCertificatesService } from '../app-my-certificates.service';
import { AppMyCertificateDto } from '../dto/app/app-my-certificate.dto';
import { ListAppMyCertificatesQueryDto } from '../dto/app/list-app-my-certificates-query.dto';

// Phase 2 P2-7 App /api/app/v1/my/certificates Mobile Controller(1 endpoint)。
// 沿 docs/app-api-p2-7-my-certificates-review.md §7.2 + D-P2-7-10:
//   - **新建** @Controller('app/v1/my');物理路径 src/modules/certificates/controllers/
//   - 与 P2-5 / P2-6 共享前缀 'app/v1/my'(NestJS 允许多 controller 共享前缀,
//     endpoint path 不重叠:此处 /certificates vs /registrations / /activities /
//     /attendance-records)
//   - **不**挂 @Roles(沿 P2-2 ~ P2-6 范式;App 不用 Role 短路);ADMIN 兼队员可用走
//     AppIdentityResolver(D-P2-7-13 linked-member self perspective)
//   - **不**挂 @Public(全部要登录);依赖全局 JwtAuthGuard
//   - **不**挂限流装饰器(沿 default throttler)
//   - **不**追加方法到既有 CertificatesController(沿 D-P2-7-15;admin/v1 路径整文件 0 diff)
//
// 准入沿 §8.1 / §8.2:canUseApp=false → 403 FORBIDDEN(memberId=null / member 软删 /
// member.status!=ACTIVE / Admin 无 member 统一 403);**不**沿 D-P2-3-1 admin-without-member
// 例外(沿 D-P2-7-12)。准入校验全部前置在 AppMyCertificatesService 内统一做。
//
// 数据范围沿 §4 过滤铁律:where 永远含 memberId = currentUser.memberId(由 service 内
// access.member.id 锁定;**禁止** role 短路 / 接收 query memberId,DTO 严格白名单已挡)。
@ApiTags('Mobile - My Certificates')
@ApiBearerAuth()
@Controller('app/v1/my')
export class AppMyCertificatesController {
  constructor(private readonly appMyCertificates: AppMyCertificatesService) {}

  // ============ GET /api/app/v1/my/certificates(P2-7)============

  @Get('certificates')
  @ApiOperation({
    summary:
      '我的证书列表(本人 pending / verified / expired / rejected 全部可见;分页 + 可选 certStatusCode / certTypeCode 过滤) [auth]',
  })
  @ApiWrappedPageResponse(AppMyCertificateDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.INTERNAL_ERROR,
  )
  listMyCertificates(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListAppMyCertificatesQueryDto,
  ): Promise<PageResultDto<AppMyCertificateDto>> {
    return this.appMyCertificates.listMyCertificates(query, currentUser);
  }
}

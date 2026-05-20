import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

// Phase 2 P2-7 `GET /api/app/v1/my/certificates` query DTO。
// 沿 docs/app-api-p2-7-my-certificates-review.md §6.1 D-P2-7-7 严格 4 字段
// (`page` / `pageSize` 沿 `PaginationQueryDto` + 可选 `certStatusCode` + 可选 `certTypeCode`)。
//
// 沿 §6.2 严禁字段:`memberId` / `userId`(本人查本人,后端从 currentUser.memberId 推导);
// `verifiedBy` / `verifier` / `verifierMemberId`(审核人是 admin 视角字段);
// `includeDeleted` / `withDeleted`(软删 row 永远不可见);
// `supersededByCertId`(替代链路 App 不暴露);
// `dateFrom` / `dateTo` / `issuedAt[gte]` / `expiredAt[lte]`(P2.x 单独立项);
// `sortBy` / `sortOrder`(默认 createdAt desc;沿 D-P2-7-8);
// `isInternal` filter(若需要 P2.x 立项)。
// `forbidNonWhitelisted: true` 兜底任何越界字段(沿 ARCHITECTURE.md §7.2)。
//
// `extends PaginationQueryDto` 是唯一允许例外(沿 §6.3 + P2-5a / P2-6 范式):
// `PaginationQueryDto` 来自 `common/dto/pagination.dto.ts` 跨模块公共 DTO,**非** admin
// 模块 DTO,不违反 D-P2-7-3 "禁止 extends admin DTO" 铁律。
export class ListAppMyCertificatesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按核验状态过滤(可选;cert_status 4 态闭集);默认全集',
    enum: ['pending', 'verified', 'expired', 'rejected'],
  })
  @IsOptional()
  @IsIn(['pending', 'verified', 'expired', 'rejected'])
  certStatusCode?: string;

  @ApiPropertyOptional({
    description: '按证书大类 code 过滤(可选;cert_type 字典 code);默认全集',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  certTypeCode?: string;
}

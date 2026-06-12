import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

// 保险模块 T2(GET /api/app/v1/me/insurances)query DTO。
// 仅分页两字段(评审稿 E-14:v1 无过滤参数);严禁 memberId / userId / includeDeleted
// (self-scope 本人查本人;软删行永不可见);`forbidNonWhitelisted: true` 兜底越界字段。
// extends PaginationQueryDto 是唯一允许例外(common 跨模块公共 DTO,非 admin 模块 DTO)。
export class ListAppMeInsurancesQueryDto extends PaginationQueryDto {}

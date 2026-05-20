import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { AppMyCertificateDto } from './dto/app/app-my-certificate.dto';
import { ListAppMyCertificatesQueryDto } from './dto/app/list-app-my-certificates-query.dto';

// Phase 2 P2-7 App /api/app/v1/my/certificates 独立 App service。
// 沿 docs/app-api-p2-7-my-certificates-review.md §7.3 + D-P2-7-9:
//   controller → AppMyCertificatesService → PrismaService 直查 Certificate
//   (**不** thin-wrap CertificatesService.list;**不**新增 CertificatesService.listForMember)
//
// 职责(沿 §7.3 + §7.5):
//   1. 准入:AppIdentityResolver.resolve + assertCanUseAppOrThrow(canUseApp=false 统一
//      FORBIDDEN=40300;沿 §8.1 + §8.2;**不**沿 D-P2-3-1 admin-without-member 例外,
//      沿 D-P2-7-12 同范式)
//   2. 直查 prisma.certificate.findMany / count(**不**调 admin CertificatesService;
//      admin list 写 `certificate.read.other` 审计 + admin scope,语义不匹配)
//   3. where 锁:memberId = access.member.id(本人) + deletedAt: null(软删过滤) +
//      可选 certStatusCode filter + 可选 certTypeCode filter
//   4. orderBy createdAt desc(沿 D-P2-7-8;App 视角按时间线最直观)
//   5. 私有静态 mapper:Prisma row → AppMyCertificateDto(沿 §5.1 严格白名单 12 项)
//
// 铁律(沿 §11.1 + D-P2-7-9):
//   - **不**改 certificates.service.ts(整文件 0 diff)
//   - **不**新增 listForMember 或任何 admin service method
//   - **不**调用 admin CertificatesService.list / findOne / isQualified
//   - **不**做 expiredAt < now() → expired 实时映射(沿 D-P2-7-6;持久态由后台任务维护)
//   - admin-as-member 走 linked-member self perspective(沿 D-P2-7-13);
//     **禁止** role 短路 / 接收 query memberId(DTO 严格白名单已挡)
//   - 纯只读,**不写 audit**(沿 D-P2-7-16;App self-read 不算 admin-perspective read.other)
//
// 例外退路(沿 §7.4):如发现 §5.1 12 字段集仍不足 / 4 态枚举与 Prisma 实际不一致 /
// admin-as-member 边界与 AppIdentityResolver 不符,**必须**暂停回到对话,**禁止**自行
// 解锁或扩字段。
@Injectable()
export class AppMyCertificatesService {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly prisma: PrismaService,
  ) {}

  // ============ GET /api/app/v1/my/certificates(P2-7)============

  async listMyCertificates(
    query: ListAppMyCertificatesQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AppMyCertificateDto>> {
    const memberId = await this.assertCanUseAppOrThrow(currentUser);

    const where: Prisma.CertificateWhereInput = {
      memberId,
      deletedAt: null,
      ...(query.certStatusCode !== undefined ? { certStatusCode: query.certStatusCode } : {}),
      ...(query.certTypeCode !== undefined ? { certTypeCode: query.certTypeCode } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.certificate.findMany({
        where,
        select: AppMyCertificatesService.appSelect,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.certificate.count({ where }),
    ]);

    return {
      items: rows.map((row) => AppMyCertificatesService.toAppDto(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ============ 内部 helpers ============

  // 沿 §8.1 / §8.2 准入硬约束:canUseApp=false → FORBIDDEN(40300)
  // (memberId=null / member 软删 / member.status!=ACTIVE / Admin 无 member 统一 403);
  // **不**沿 D-P2-3-1 admin-without-member 例外(沿 D-P2-7-12)。
  // 返回 resolved member.id 给 caller 锁 where(沿 D-P2-7-13 linked-member self perspective)。
  private async assertCanUseAppOrThrow(currentUser: CurrentUserPayload): Promise<string> {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp || access.member === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    return access.member.id;
  }

  // findMany select 严格 12 字段白名单(沿 §5.1 + D-P2-7-4);**不** include verifier /
  // member / supersededBy / supersedes(沿 §5.3 不暴露审核人 / 替代链路 / Member 嵌套)。
  // 字段顺序刻意与 §5.1 表格 #1-#12 对齐,便于代码 review 比对。
  private static readonly appSelect = {
    id: true,
    certTypeCode: true,
    certSubTypeCode: true,
    issuingOrg: true,
    certNumber: true,
    issuedAt: true,
    expiredAt: true,
    certStatusCode: true,
    isInternal: true,
    verifyNote: true,
    verifiedAt: true,
    createdAt: true,
  } as const satisfies Prisma.CertificateSelect;

  // 私有 mapper(沿 §7.1 + D-P2-7-14 + P2-5 / P2-6 P0/P1 过渡;不抽独立 Presenter class)。
  // 直 spread:appSelect 已锁定 12 字段集 = AppMyCertificateDto 字段集,无字段名转换。
  // **绝不** include 关联 row(verifier / member / supersededBy),appSelect 已确保。
  private static toAppDto(
    row: Prisma.CertificateGetPayload<{ select: typeof AppMyCertificatesService.appSelect }>,
  ): AppMyCertificateDto {
    return {
      id: row.id,
      certTypeCode: row.certTypeCode,
      certSubTypeCode: row.certSubTypeCode,
      issuingOrg: row.issuingOrg,
      certNumber: row.certNumber,
      issuedAt: row.issuedAt,
      expiredAt: row.expiredAt,
      certStatusCode: row.certStatusCode,
      isInternal: row.isInternal,
      verifyNote: row.verifyNote,
      verifiedAt: row.verifiedAt,
      createdAt: row.createdAt,
    };
  }
}

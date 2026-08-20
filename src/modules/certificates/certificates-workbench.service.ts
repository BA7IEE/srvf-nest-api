import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toMemberLabelFields } from '../../common/identity/member-label.util';
import { maskIdentifier } from '../../common/audit/mask-pii.util';
import { beijingDateOnly } from '../../common/datetime/date-only.util';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { MembershipType } from '@prisma/client';
import { OrganizationsService } from '../organizations/organizations.service';
import type {
  CertificateWorkbenchFilterDto,
  CertificateWorkbenchItemDto,
  CertificateWorkbenchStatsDto,
  ListCertificateWorkbenchQueryDto,
} from './certificates-workbench.dto';

// 证书标准库 PR-5(冻结稿 §13.6 / §14 / §15.2 / §15.7):全局证书工作台。
//
// 判权入口码复用 `certificate.read.record`(零新增码)。但入口过了不等于能看全库 ——
// 可见组织范围必须**先下推到 SQL**,再分页、再计数(§15.7 明列
// 「工作台 total 和 stats 必须先下推 scope,再计数」)。
// 先查后裁会让 total 泄露范围外的存在数量:列表看不到那些行,计数却把它们算进去了。
//
// 归属只认 **active PRIMARY** membership(与 members.service 的
// `buildOrganizationScopeFilter` 同口径)——SECONDARY / TEMPORARY / SUPPORT 不得扩大可见范围。

const CERT_STATUS_PENDING = 'pending';
const CERT_STATUS_VERIFIED = 'verified';
const CERT_STATUS_EXPIRED = 'expired';
const CERT_STATUS_REJECTED = 'rejected';

/** §14 的 60 天窗口。与到期提醒 cron 的窗口同宽,但两者各自算 —— 统计不依赖 cron 跑过。 */
const EXPIRING_WINDOW_DAYS = 60;

// 工作台 select:严格白名单。§15.2 永不返回完整 certNumber / verifyNote / verifiedBy /
// imageKeys / signed URL / sourceClaimId —— 它们**不在这个 select 里**,
// 所以不是「取出来再剥掉」,而是根本没查。
const workbenchSelect = {
  id: true,
  issuingOrg: true,
  certNumber: true, // 只用于算掩码,presenter 不外传原值
  issuedAt: true,
  expiredAt: true,
  certStatusCode: true,
  sourceCode: true,
  createdAt: true,
  member: { select: { id: true, memberNo: true, realName: true, nickname: true } },
  standard: { select: { id: true, code: true, name: true, categoryCode: true, levelCode: true } },
  // 证据只判「有没有」,不取 key。RECRUITMENT 来源看 Claim 的图(有关联,随行取回);
  // ADMIN 来源的 attachment 是**多态归属**(ownerType/ownerId,无 Prisma 关联),
  // 只能另查 —— 见 loadAdminEvidenceOwnerIds:整页一次 groupBy,不做 N+1。
  sourceClaim: { select: { imageKeys: true } },
} as const satisfies Prisma.CertificateSelect;

/** §13.5:ADMIN 来源的证据是 `ownerType='certificate'` 的标准 Attachment。 */
const ATTACHMENT_OWNER_TYPE_CERTIFICATE = 'certificate';

type WorkbenchRow = Prisma.CertificateGetPayload<{ select: typeof workbenchSelect }>;

@Injectable()
export class CertificatesWorkbenchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly auditLogs: AuditLogsService,
    private readonly organizations: OrganizationsService,
  ) {}

  /**
   * §14:当前有效展示状态。`verified` 且最后有效日已早于北京 today → `expired`。
   *
   * **不是第五个持久状态**(§14 明令):它不入库、每次读时按今天算,
   * 所以不依赖到期 cron 是否已经跑过 —— cron 每天 09:00 才翻态,
   * 在它跑之前持久状态仍是 verified,而那批证书事实上已经过期了。
   */
  private effectiveStatus(certStatusCode: string, expiredAt: Date | null, today: Date): string {
    if (certStatusCode !== CERT_STATUS_VERIFIED) return certStatusCode;
    if (expiredAt === null) return CERT_STATUS_VERIFIED;
    return expiredAt.getTime() < today.getTime() ? CERT_STATUS_EXPIRED : CERT_STATUS_VERIFIED;
  }

  /**
   * 整页一次查出「哪些证书有 ADMIN 来源证据」。
   * groupBy 而不是逐行 count:后者是 pageSize 次查询,20 行就是 20 次往返。
   * 只返回 id 集合 —— attachment 的 key / 文件名一律不出这个方法(§15.6)。
   */
  private async loadAdminEvidenceOwnerIds(certificateIds: string[]): Promise<Set<string>> {
    if (certificateIds.length === 0) return new Set();
    const rows = await this.prisma.attachment.groupBy({
      by: ['ownerId'],
      where: {
        ownerType: ATTACHMENT_OWNER_TYPE_CERTIFICATE,
        ownerId: { in: certificateIds },
      },
      _count: { _all: true },
    });
    return new Set(rows.filter((r) => r._count._all > 0).map((r) => r.ownerId));
  }

  private present(
    row: WorkbenchRow,
    today: Date,
    adminEvidenceIds: Set<string>,
  ): CertificateWorkbenchItemDto {
    return {
      id: row.id,
      // issue #1048 T1:`label` 由后端拼装,Prisma 行里没有。
      member: { id: row.member.id, ...toMemberLabelFields(row.member) },
      standard: row.standard,
      issuingOrg: row.issuingOrg,
      certNumberMasked: maskIdentifier(row.certNumber),
      issuedAt: row.issuedAt,
      expiredAt: row.expiredAt,
      certStatusCode: row.certStatusCode,
      effectiveStatusCode: this.effectiveStatus(row.certStatusCode, row.expiredAt, today),
      sourceCode: row.sourceCode,
      evidenceAvailable:
        (Array.isArray(row.sourceClaim?.imageKeys) && row.sourceClaim.imageKeys.length > 0) ||
        adminEvidenceIds.has(row.id),
      createdAt: row.createdAt,
    };
  }

  /**
   * §15.7 的核心:把「可见组织范围 ∩ 用户请求的组织过滤」下推成 `where` 片段。
   *
   * 与 `members.service.buildOrganizationScopeFilter` 同口径(只认 active PRIMARY),
   * 但落点是 `Certificate.member.memberOrganizationMemberships` 而不是 `Member` 自身。
   * 没有抽公共函数:两边的 where 根类型不同(Member vs Certificate),
   * 强行抽会变成一个带泛型开关的东西,而开关是漂移的开始。
   */
  private async buildScopeWhere(
    user: CurrentUserPayload,
    organizationId: string | undefined,
    includeDescendants: boolean | undefined,
  ): Promise<Prisma.CertificateWhereInput | undefined> {
    const scope = await this.authz.getVisibleOrganizationScope(user, 'certificate.read.record');
    if (!scope.hasPermission) throw new BizException(BizCode.RBAC_FORBIDDEN);

    const requestedOrgIds =
      organizationId === undefined
        ? undefined
        : includeDescendants === true
          ? await this.organizations.queryDescendantOrgIds(organizationId)
          : [organizationId];

    // 全局可见且未按组织过滤 → 无需任何组织条件(不要塞一个恒真片段,那会白 join)。
    if (scope.global && requestedOrgIds === undefined) return undefined;

    const orgIds = scope.global
      ? (requestedOrgIds ?? [])
      : requestedOrgIds === undefined
        ? scope.organizationIds
        : requestedOrgIds.filter((id) => scope.organizationIds.includes(id));

    // 交集为空 → 返一个必然不成立的条件,而不是「不加条件」。
    // 后者会把无权的人放成全库可见 —— 这一格写错就是越权,不是少几行。
    return {
      member: {
        memberOrganizationMemberships: {
          some: {
            deletedAt: null,
            status: 'ACTIVE',
            membershipType: MembershipType.PRIMARY,
            organizationId: { in: orgIds },
          },
        },
      },
    };
  }

  /** 非分页过滤 → where 片段(§14:列表与 stats 共用同一组,故只有这一处实现)。 */
  private buildFilterWhere(filter: CertificateWorkbenchFilterDto): Prisma.CertificateWhereInput {
    const where: Prisma.CertificateWhereInput = {};

    if (filter.memberId !== undefined) where.memberId = filter.memberId;
    if (filter.certStatusCode !== undefined) where.certStatusCode = filter.certStatusCode;
    if (filter.sourceCode !== undefined) where.sourceCode = filter.sourceCode;

    // Standard 维度的三个过滤都经关联 —— 类别 / 等级只有一个权威(§6)。
    const standardWhere: Prisma.CertificateStandardWhereInput = {};
    if (filter.standardCode !== undefined) standardWhere.code = filter.standardCode;
    if (filter.categoryCode !== undefined) standardWhere.categoryCode = filter.categoryCode;
    if (filter.levelCode !== undefined) standardWhere.levelCode = filter.levelCode;
    if (Object.keys(standardWhere).length > 0) where.standard = standardWhere;

    const issued: Prisma.DateTimeFilter = {};
    if (filter.issuedFrom !== undefined) issued.gte = beijingDateOnly(new Date(filter.issuedFrom));
    if (filter.issuedTo !== undefined) issued.lte = beijingDateOnly(new Date(filter.issuedTo));
    if (Object.keys(issued).length > 0) where.issuedAt = issued;

    // 到期区间刻意**不匹配终身有效**(expiredAt IS NULL):
    // 「2026 年内到期的证书」这个问题的答案里不该出现永不到期的证书。
    const expires: Prisma.DateTimeFilter = {};
    if (filter.expiresFrom !== undefined) {
      expires.gte = beijingDateOnly(new Date(filter.expiresFrom));
    }
    if (filter.expiresTo !== undefined) expires.lte = beijingDateOnly(new Date(filter.expiresTo));
    if (Object.keys(expires).length > 0) where.expiredAt = expires;

    // §13.6:q 只搜四项。**不含完整证书编号** —— 那是 L2,可搜即可枚举。
    const q = filter.q?.trim();
    if (q !== undefined && q !== '') {
      where.OR = [
        { member: { memberNo: { contains: q, mode: 'insensitive' } } },
        { member: { realName: { contains: q, mode: 'insensitive' } } },
        { standard: { name: { contains: q, mode: 'insensitive' } } },
        { standard: { code: { contains: q, mode: 'insensitive' } } },
        { issuingOrg: { contains: q, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  private async buildWhere(
    user: CurrentUserPayload,
    filter: CertificateWorkbenchFilterDto,
  ): Promise<Prisma.CertificateWhereInput> {
    const scopeWhere = await this.buildScopeWhere(
      user,
      filter.organizationId,
      filter.includeDescendants,
    );
    // notDeletedWhere 负责 deletedAt: null(§14 第一条)。
    // AND 组合而不是浅合并:scope 与 filter 都可能带 `member` 键,浅合并会让后者覆盖前者 ——
    // 那正好把 scope 条件整段丢掉,即越权。
    return notDeletedWhere({
      AND: [this.buildFilterWhere(filter), ...(scopeWhere ? [scopeWhere] : [])],
    });
  }

  async list(
    query: ListCertificateWorkbenchQueryDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<PageResultDto<CertificateWorkbenchItemDto>> {
    const where = await this.buildWhere(user, query);
    const today = beijingDateOnly(new Date());

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.certificate.findMany({
        where,
        select: workbenchSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.certificate.count({ where }),
    ]);

    // 敏感读审计 fail-closed:先落账再返数据(与既有 admin 读面同款)。
    // extra 只记字段名与安全计数,绝不记 q 的原文 —— 它可能含队员姓名(§15.6)。
    await this.auditLogs.log({
      event: 'certificate.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'certificate',
      resourceId: null,
      meta: auditMeta,
      extra: {
        operation: 'workbench-list',
        filterFields: Object.keys(query)
          .filter((k) => k !== 'page' && k !== 'pageSize')
          .sort(),
        count: rows.length,
        total,
      },
    });

    const adminEvidenceIds = await this.loadAdminEvidenceOwnerIds(rows.map((r) => r.id));

    return {
      items: rows.map((r) => this.present(r, today, adminEvidenceIds)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * §14 六个计数器。全部共用 `buildWhere` 的结果 —— scope 先下推,再计数(§15.7)。
   *
   * 六条谓词逐字照 §14,尤其 `expired` 的第二个分支:
   * `certStatusCode=verified AND expiredAt < today`。只信持久状态会在 cron 跑之前少算,
   * 而那正是「统计不依赖 Cron 已经完成翻态」这句话的含义。
   */
  async stats(
    filter: CertificateWorkbenchFilterDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<CertificateWorkbenchStatsDto> {
    const base = await this.buildWhere(user, filter);
    const today = beijingDateOnly(new Date());
    const horizon = new Date(today.getTime() + EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const count = (extra: Prisma.CertificateWhereInput): Prisma.PrismaPromise<number> =>
      this.prisma.certificate.count({ where: { AND: [base, extra] } });

    const [pending, verified, expired, rejected, expiringWithin60Days, permanent] =
      await this.prisma.$transaction([
        count({ certStatusCode: CERT_STATUS_PENDING }),
        count({
          certStatusCode: CERT_STATUS_VERIFIED,
          OR: [{ expiredAt: null }, { expiredAt: { gte: today } }],
        }),
        count({
          OR: [
            { certStatusCode: CERT_STATUS_EXPIRED },
            { certStatusCode: CERT_STATUS_VERIFIED, expiredAt: { lt: today } },
          ],
        }),
        count({ certStatusCode: CERT_STATUS_REJECTED }),
        count({
          certStatusCode: CERT_STATUS_VERIFIED,
          expiredAt: { gte: today, lte: horizon },
        }),
        count({ certStatusCode: CERT_STATUS_VERIFIED, expiredAt: null }),
      ]);

    await this.auditLogs.log({
      event: 'certificate.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'certificate',
      resourceId: null,
      meta: auditMeta,
      extra: {
        operation: 'workbench-stats',
        filterFields: Object.keys(filter).sort(),
      },
    });

    return { pending, verified, expired, rejected, expiringWithin60Days, permanent };
  }
}

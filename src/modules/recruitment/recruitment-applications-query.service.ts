import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type RecruitmentApplication, type RecruitmentCycle } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { STORAGE_PROVIDER } from '../storage/storage.constants';
import type { StorageProvider } from '../storage/storage.interface';
import {
  APP_STATUS_PUBLICITY,
  ID_CARD_IMAGE_SIGNED_URL_TTL_SECONDS,
  MEMBER_NO_MAX_SEQ,
  type ThresholdMarks,
  allThresholdsComplete,
  comparePromotionOrder,
  decidePromotionIssuance,
  formatMemberNo,
} from './recruitment.constants';
import {
  formatApplicationCsvRow,
  RECRUITMENT_APPLICATION_CSV_HEADERS,
  recruitmentExportStatusWhere,
  toAdminApplicationDto,
} from './recruitment-applications.presenter';
import type {
  ExportRecruitmentApplicationsDto,
  IdCardImageUrlResponseDto,
  PublicRecruitmentPublicityResponseDto,
  PublicityListItemDto,
  PublicityListResponseDto,
  RecruitmentApplicationAdminDto,
  RecruitmentCertificateImageUrlsResponseDto,
  RecruitmentCertificateImagesItemDto,
} from './recruitment.dto';

const RECRUITMENT_CSV_BATCH_SIZE = 500;
const recruitmentCsvSelect = {
  id: true,
  cycleId: true,
  statusCode: true,
  tempNo: true,
  realName: true,
  idCardNumber: true,
  phone: true,
  documentTypeCode: true,
  isForeigner: true,
  genderCode: true,
  ageGroup: true,
  cityDistrict: true,
  verifyOutcome: true,
  riskLevel: true,
  manualReviewReason: true,
  eliminationStage: true,
  thresholdMarks: true,
  birthDate: true,
  openid: true,
  createdAt: true,
} as const satisfies Prisma.RecruitmentApplicationSelect;

type RecruitmentCsvRow = Prisma.RecruitmentApplicationGetPayload<{
  select: typeof recruitmentCsvSelect;
}>;

// 招新报名 admin 读面 QueryService(god-service 拆分 2026-06-28,沿 architecture-boundary §3.2 QueryService)。
// 从 RecruitmentApplicationsService 抽出读侧查询构造 + 脱敏分级读取 + CSV 导出 + 公示预览,
// 严守 §3.2「不做业务状态突变 / 不审计写 / 不持有写事务」。脱敏复用 presenter(单一真相源)。
// 入口闸仍 rbac.can(本仓 R 模式,无 @RequirePermissions);读 PII fail-closed 落真实 audit_logs。

@Injectable()
export class RecruitmentApplicationsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // ============ admin 列表(PII 掩码;读 PII fail-closed 落真实审计)============
  async listForAdmin(
    query: PaginationQueryDto,
    filters: { cycleId?: string; statusCode?: string; riskLevel?: string },
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<PageResultDto<RecruitmentApplicationAdminDto>> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const where: Prisma.RecruitmentApplicationWhereInput = {
      deletedAt: null,
      ...(filters.cycleId ? { cycleId: filters.cycleId } : {}),
      ...(filters.statusCode ? { statusCode: filters.statusCode } : {}),
      // S4b:人工队列三栏过滤(§2.4;normal/high/system)
      ...(filters.riskLevel ? { riskLevel: filters.riskLevel } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.recruitmentApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.recruitmentApplication.count({ where }),
    ]);
    const filterFields = (['cycleId', 'statusCode', 'riskLevel'] as const).filter(
      (field) => filters[field] !== undefined,
    );
    await this.auditLogs.log({
      event: 'recruitment-application.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: filters.cycleId === undefined ? 'recruitment_application' : 'recruitment_cycle',
      resourceId: filters.cycleId ?? null,
      meta: auditMeta,
      extra: { operation: 'list', filterFields, maskLevel: 'masked', count: rows.length },
    });
    return {
      items: rows.map((r) => toAdminApplicationDto(r, true)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ============ admin 详情(敏感字段分级;S3 §11.1)============
  // 入口闸 = read.record(普通查看);持 read.sensitive → 明文证件号/手机,仅 read.record → 脱敏详情。
  // 响应字段集不随码变(只 masking 随码;biz-admin 同持双码,行为不回退)。
  async detailForAdmin(
    id: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const row = await this.findAppOrThrow(id);
    const canSensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');
    await this.auditLogs.log({
      event: 'recruitment-application.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'recruitment_application',
      resourceId: id,
      meta: auditMeta,
      extra: { operation: 'detail', maskLevel: canSensitive ? 'plain' : 'masked' },
    });
    return toAdminApplicationDto(row, !canSensitive);
  }

  // ============ 招新闭环优化 S6:批量导出 CSV(评审稿 §8.1;脱敏随码复用 S3 toAdminDto,零第二套)============
  // 入口闸 = read.record(同 list/detail);**持 read.sensitive → 明文列 / 仅 read.record → 脱敏列**
  //(S3 §11.1 分级):脱敏单一真相源在 presenter(masked = !canSensitive),CSV 仅消费已脱敏 DTO —— 明文
  // 绝不在无 read.sensitive 时出列。读操作 export 真实审计(含 admin / 范围 filter / 脱敏级;
  // 复用 read.other DB 事件 + operation 区分,沿 registrations export 范式)。
  // 返回游标分页 async generator(controller 用 Readable.from 包 StreamableFile;不引新依赖)。
  async exportApplicationsCsv(
    dto: ExportRecruitmentApplicationsDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AsyncGenerator<string, void, undefined>> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const canSensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');
    const filter = dto.filter ?? 'all';

    const where: Prisma.RecruitmentApplicationWhereInput = {
      deletedAt: null,
      ...(dto.cycleId ? { cycleId: dto.cycleId } : {}),
      ...recruitmentExportStatusWhere(filter),
    };
    const filterFields = (['cycleId', 'filter'] as const).filter(
      (field) => dto[field] !== undefined,
    );
    await this.auditLogs.log({
      event: 'recruitment-application.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: dto.cycleId === undefined ? 'recruitment_application' : 'recruitment_cycle',
      resourceId: dto.cycleId ?? null,
      meta: auditMeta,
      extra: {
        operation: 'export',
        filterFields,
        maskLevel: canSensitive ? 'plain' : 'masked',
      },
    });
    return this.streamApplicationsCsv(where, filter, !canSensitive);
  }

  private async *streamApplicationsCsv(
    where: Prisma.RecruitmentApplicationWhereInput,
    filter: string,
    masked: boolean,
  ): AsyncGenerator<string, void, undefined> {
    yield '\uFEFF';
    yield RECRUITMENT_APPLICATION_CSV_HEADERS.join(',');

    let cursor: string | undefined;
    while (true) {
      const rows: RecruitmentCsvRow[] = await this.prisma.recruitmentApplication.findMany({
        where,
        select: recruitmentCsvSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: RECRUITMENT_CSV_BATCH_SIZE,
        ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const row of rows) {
        // threshold-incomplete:verified 且门槛未齐(post-filter,沿 stats tracking 口径)。
        if (
          filter === 'threshold-incomplete' &&
          allThresholdsComplete(row.thresholdMarks as ThresholdMarks | null)
        ) {
          continue;
        }
        yield `\n${formatApplicationCsvRow(row, masked)}`;
      }
      if (rows.length < RECRUITMENT_CSV_BATCH_SIZE) break;
      cursor = rows.at(-1)!.id;
    }
  }

  // ============ admin 取证件照 signed-URL(配套②;L3;短 TTL;S3:敏感查看 read.sensitive)============
  // OCR 鉴伪版充分利用(2026-06-29;D4):同时返三图 signed-URL —— 原图 + 主体框裁剪(CardImage)+ 头像裁剪
  // (PortraitImage)。裁剪图仅身份证鉴伪版且已入库才有 key;无 key → URL null(不阻断,前端不渲染)。
  async getIdCardImageUrl(
    id: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<IdCardImageUrlResponseDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.sensitive');
    const row = await this.findAppOrThrow(id);
    if (!row.idCardImageKey) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    const fields = [
      'idCardImage',
      ...(row.idCardCropImageKey ? ['idCardCropImage'] : []),
      ...(row.idCardPortraitImageKey ? ['idCardPortraitImage'] : []),
    ];
    await this.auditLogs.log({
      event: 'recruitment-application.id-card-image.read',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'recruitment_application',
      resourceId: id,
      meta: auditMeta,
      extra: { operation: 'id-card-image', fields },
    });
    const result = await this.storage.generateDownloadUrl({
      key: row.idCardImageKey,
      expiresIn: ID_CARD_IMAGE_SIGNED_URL_TTL_SECONDS,
    });
    // 裁剪图 key 存在才生成签名 URL(键缺 → null);TTL 同原图。
    const cropImageUrl = await this.maybeSignedUrl(row.idCardCropImageKey);
    const portraitImageUrl = await this.maybeSignedUrl(row.idCardPortraitImageKey);
    // url 是 L3,不入日志/snapshot;仅出参回显
    return { url: result.url, expiresAt: result.expiresAt, cropImageUrl, portraitImageUrl };
  }

  // ============ 招新可用性收口 F7:admin 取证书图 signed-URL(镜像 id-card-image-url;评审稿 §2.9)============
  // 复用 read.sensitive(0 新码;证书图=申请人自报材料,与证件照同敏感面);短 TTL;L3 不入日志。
  // 无图类别不出现;全无 → items 空数组(200,不 404——「有没有传」本身是合法业务信息)。
  async getCertificateImageUrls(
    id: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<RecruitmentCertificateImageUrlsResponseDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.sensitive');
    const row = await this.findAppOrThrow(id);
    const images = (row.certificateImages as Record<string, string[]> | null) ?? {};
    const imageCount = Object.values(images).reduce(
      (sum, keys) => sum + (Array.isArray(keys) ? keys.length : 0),
      0,
    );
    await this.auditLogs.log({
      event: 'recruitment-application.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'recruitment_application',
      resourceId: id,
      meta: auditMeta,
      extra: { operation: 'certificate-images', count: imageCount },
    });
    const expiresAt = new Date(Date.now() + ID_CARD_IMAGE_SIGNED_URL_TTL_SECONDS * 1000);
    const items: RecruitmentCertificateImagesItemDto[] = [];
    for (const [category, keys] of Object.entries(images)) {
      if (!Array.isArray(keys) || keys.length === 0) continue;
      const urls: string[] = [];
      for (const key of keys) {
        const r = await this.storage.generateDownloadUrl({
          key,
          expiresIn: ID_CARD_IMAGE_SIGNED_URL_TTL_SECONDS,
        });
        urls.push(r.url);
      }
      items.push({ category, urls });
    }
    return { items, expiresAt };
  }

  // 裁剪图 key → signed-URL(null key → null;TTL 同原图)。
  private async maybeSignedUrl(key: string | null): Promise<string | null> {
    if (!key) return null;
    const r = await this.storage.generateDownloadUrl({
      key,
      expiresIn: ID_CARD_IMAGE_SIGNED_URL_TTL_SECONDS,
    });
    return r.url;
  }

  // ============ 招新二期:公示名单(D-R2-4;姓名 + 拟发编号,拼音序,零敏感)============
  // 计算式预览:拟发编号 = 同一确定性拼音排序 + 当前 memberNoSeq 推算(发号时一致);
  // 资料齐备且登录锚可用的项编号;其余 needsManualBuild=true + proposedMemberNo=null(发号前可见)。
  // 公示名单读不记审计(配置台账类,姓名本就对外公示;评审稿 §3.5)。
  async publicityList(
    cycleId: string,
    user: CurrentUserPayload,
  ): Promise<PublicityListResponseDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');
    const cycle = await this.prisma.recruitmentCycle.findFirst({
      where: { id: cycleId, deletedAt: null },
    });
    if (!cycle) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_NOT_FOUND);
    }
    return this.buildPublicityList(cycle);
  }

  // ============ 十项收口刀F:公开公示名单(open/v1 无账号;拍板「后端出公开名单接口」)============
  // 悬空动作收口:公开进度返回 nextAction='view-publicity',但公开 surface 此前无任何公示资源可看。
  // 与 admin 公示预览共用 buildPublicityList 取数内核 → 公示所见 = 后台预览 = 实发(结构性一致);
  // 出参收敛为 { cycleYear, items:[{ realName, proposedMemberNo }] }——姓名本就对外公示,拟发号
  // 待人工建档者为 null;不出 applicationId / isNonMainlandDocument / needsManualBuild(内部运营语义不外露)。
  // 轮次解析:取最近(createdAt desc)存在公示中报名行的轮(公示期可能已闭轮,不锚 open 轮);
  // 无任何公示中名单 → 200 + cycleYear=null + items=[](空窗是合法状态);不记审计(公开台账类)。
  async publicPublicityList(): Promise<PublicRecruitmentPublicityResponseDto> {
    const cycle = await this.prisma.recruitmentCycle.findFirst({
      where: {
        deletedAt: null,
        applications: { some: { statusCode: APP_STATUS_PUBLICITY, deletedAt: null } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!cycle) {
      return { cycleYear: null, items: [] };
    }
    const full = await this.buildPublicityList(cycle);
    return {
      cycleYear: full.cycleYear,
      items: full.items.map((i) => ({
        realName: i.realName,
        proposedMemberNo: i.proposedMemberNo,
      })),
    };
  }

  // 公示名单取数内核(admin 预览 + 刀F 公开名单共用;单一真相源,公示=实发的结构保证在此)。
  private async buildPublicityList(cycle: RecruitmentCycle): Promise<PublicityListResponseDto> {
    const rows = await this.prisma.recruitmentApplication.findMany({
      where: { cycleId: cycle.id, statusCode: APP_STATUS_PUBLICITY, deletedAt: null },
    });
    // F9(#399):公示拟发号与一键发号共享 decidePromotionIssuance —— 同序(comparePromotionOrder)、同判
    // (isPromotable + openid/phone 未被既有 User 占用 + 批内去重)→ 预览 = 实发,杜绝「公示显示拟发号、
    // promote 时因 openid/phone 已占用/批内重复被 skip 致编号偏移、公示失真」。openid/phone 仅内部判定用,不入出参。
    // v0.40.0 H5 手机通道:无 openid 走手机通道,同查 phone 占用(仅无 openid 的行;镜像 openid)。
    const candidateOpenids = rows.map((r) => r.openid).filter((o): o is string => o != null);
    const boundRows = candidateOpenids.length
      ? await this.prisma.user.findMany({
          where: { openid: { in: candidateOpenids } },
          select: { openid: true },
        })
      : [];
    const boundOpenids = new Set(
      boundRows.map((r) => r.openid).filter((o): o is string => o != null),
    );
    const candidatePhones = rows
      .filter((r) => r.openid == null)
      .map((r) => r.phone)
      .filter((p): p is string => p != null);
    const boundPhoneRows = candidatePhones.length
      ? await this.prisma.user.findMany({
          where: { phone: { in: candidatePhones } },
          select: { phone: true },
        })
      : [];
    const boundPhones = new Set(
      boundPhoneRows.map((r) => r.phone).filter((p): p is string => p != null),
    );
    const sorted = [...rows].sort(comparePromotionOrder);
    let seq = cycle.memberNoSeq;
    const items: PublicityListItemDto[] = decidePromotionIssuance(
      sorted,
      boundOpenids,
      boundPhones,
    ).map(({ app: r, willIssue }) => {
      let proposedMemberNo: string | null = null;
      if (willIssue) {
        seq += 1;
        // 超 999 预览置 null(实际发号撞上限 → 28043);保持预览与发号一致
        proposedMemberNo = seq <= MEMBER_NO_MAX_SEQ ? formatMemberNo(cycle.year, seq) : null;
      }
      return {
        applicationId: r.id,
        realName: r.realName,
        proposedMemberNo,
        isNonMainlandDocument: r.isForeigner,
        needsManualBuild: !willIssue,
      };
    });
    const promotableCount = items.filter((i) => !i.needsManualBuild).length;
    return {
      cycleId: cycle.id,
      cycleYear: cycle.year,
      items,
      promotableCount,
      manualBuildCount: items.length - promotableCount,
    };
  }

  // === helpers ===

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async findAppOrThrow(id: string): Promise<RecruitmentApplication> {
    const row = await this.prisma.recruitmentApplication.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) {
      throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
    }
    return row;
  }
}

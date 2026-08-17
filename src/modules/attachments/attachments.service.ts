import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { StorageSettingsService } from '../storage/storage-settings.service';
import {} from '../storage/upload-token.util';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import {
  AttachmentAccessService,
  ATTENDANCE_IMPORT_PREVIEW_OWNER_TYPE,
  OwnerAttachmentView,
  SafeAttachment,
  isInternalRegistrationAttachmentOwner,
} from './attachment-access.service';

// 类型面逐字不变:视图与阶段类型随共享层迁走,既有消费者(registration-upload-session /
// attendance 等)仍从本 service import —— 在此 re-export,让「实现搬家」不外溢成「消费者改 import」。
// 类型面逐字不变:视图与阶段类型随共享层迁走,既有消费者(registration-command /
// registration-upload-session / attendance-import-attachment 等)仍从本 service import ——
// 在此 re-export,让「实现搬家」不外溢成「消费者改 import」。
// ⚠️ 这一段看起来"未被本文件使用",但删掉会让上述三个模块编译失败 ——
// 清理未用 import 的自动化在这里必须绕开(实测被误删过一次)。
export type {
  ATTENDANCE_IMPORT_PREVIEW_OWNER_TYPE,
  AttendanceImportPreviewAttachmentFinalized,
  AttendanceImportPreviewAttachmentPrepared,
  AttendanceImportPreviewAttachmentValidated,
  AttendanceImportPreviewAttachmentVerified,
  AttendanceImportPreviewAttachmentView,
  OwnerAttachmentView,
  RegistrationUploadAttachmentView,
  RegistrationUploadSubmissionBinding,
  SafeAttachment,
} from './attachment-access.service';
import { AttachmentContentUploadConfirmService } from './attachment-content-upload-confirm.service';
import { AttachmentImportPreviewUploadService } from './attachment-import-preview-upload.service';
import { AttachmentRegistrationUploadService } from './attachment-registration-upload.service';
import { AttachmentWriteService } from './attachment-write.service';
import { AttachmentStorageOrchestrator } from './attachment-storage-orchestrator';
import type {
  ContentAttachmentReferenceBoundaryInput,
  ContentPublishStorageBoundaryInput,
} from './attachment-storage.types';
import { AttachmentOwnerType } from './attachment-validation';
import {
  AttachmentResponseDto,
  ListAttachmentsByOwnerQueryDto,
  ListAttachmentsQueryDto,
} from './attachments.dto';
import { attachmentSelect } from './attachments.select';

// V2.x C-7 attachments 实施 PR #6b / #6c:attachments 主模块业务逻辑。
//
// 沿 D7-attachments v1.0 §5 / §6 / §7 + 用户 PR #6b 14 项 Q + PR #6c 8 项 Q 拍板:
// - F3 v1.0:Controller 入口仅 @UseGuards JwtAuthGuard;**所有判权在 Service 层** rbac.can()
// - F5 v1.0:RBAC 失败统一抛 BizException(BizCode.RBAC_FORBIDDEN)(30100)
// - Q1 v1.0:ownerType 双层校验 — 先查 attachment_type_configs(权威);enum 兜底
// - Q5 v1.0:Update 仅 description / accessLevel / tags / expireAt 四字段
// - Q8 v1.0:detail / update / delete 软删 / 不存在 / 无权统一返 13001
//   (沿 docs/reference/soft-delete-transactions.md §10 信息泄漏防御)
// - Q11 v1.0:DELETE 物理删,不查跨表引用(不抛 IN_USE 13030)
// - Q13 v1.0:RBAC 写失败复用 30100;读路径用 13001 信息泄漏防御
// - Q14 v1.0:accessUrl 占位恒返 null(Provider 接通前;沿 D7 §5.5 / §5.6)
//
// **PR #6c audit_logs 集成**(沿 D7 §7.1 / §7.2 + 用户 Q1-Q8 拍板):
// - 仅接入 2 个写端点:POST create → 'attachment.upload' / DELETE delete → 'attachment.delete'
// - 不审计 PATCH metadata(Q7 v0.2 锁:沿"只审高价值写操作")
// - 不审计 view / list(沿 D6 R4)
// - 不审计失败操作(沿 D6 F6 fail-fast:RBAC / mime / size / PII 拒绝时事务未开,自然无 audit)
// - 同事务 wrap:校验链留事务外(Q7 PR #6c);事务内只 tx.attachment.{create,delete} + auditLogs.log({ tx })
// - 配置三表 'attachment.config.change' **不在本 PR**(留 PR #6d)

// 全局兜底:无 mime 配置 + type 无 defaultMimeWhitelist 时,**不允许**任何 mime
// (fail-close;沿 docs/reference/soft-delete-transactions.md §10 / baseline 安全默认拒绝;
// 由 13012 命中)

@Injectable()
export class AttachmentsService {
  constructor(
    // 第七刀:共享层 + 四族实现持有者;本 service 仅保留同名薄委托作为唯一对外入口。
    private readonly access: AttachmentAccessService,
    private readonly regs: AttachmentRegistrationUploadService,
    private readonly imports: AttachmentImportPreviewUploadService,
    private readonly confirms: AttachmentContentUploadConfirmService,
    private readonly writes: AttachmentWriteService,
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly storageConsistency: AttachmentStorageOrchestrator,
    private readonly storageSettings: StorageSettingsService,
    @Inject(appConfig.KEY)
    private readonly cfg: ConfigType<typeof appConfig>,
  ) {}

  // ===== CMS 内容模块可信只读(content-module-review §5.4;α 决议)=====
  // content 读取面在**文章可见级校验通过后**调用,取某 owner 的全部附件(已签 URL),**不**走
  // attachment.view RBAC(公开读者亦可见,附件随文章可见级)。
  // **仅限 content-* owner**(content-image / content-file):本方法无 RBAC,若被误用于 member /
  // certificate / activity 等 owner,将无鉴权签出(含 PII 的)附件下载 URL。故方法体开头加运行时护栏
  // 限定 content-* owner(元核验加固,2026-06-21 维护者);其余 owner 的读**必须**走 attachment.view
  // RBAC(getById / list)。resolveSignedUrlTrusted 只签传入 key、无 owner 上下文,风险低,不加此栏。
  async listOwnerAttachmentsTrusted(
    ownerType: AttachmentOwnerType,
    ownerId: string,
  ): Promise<OwnerAttachmentView[]> {
    if (ownerType !== 'content-image' && ownerType !== 'content-file') {
      throw new Error(
        'listOwnerAttachmentsTrusted: content-* owner types only (no-RBAC trusted view)',
      );
    }
    const rows = await this.prisma.attachment.findMany({
      where: { ownerType, ownerId },
      select: {
        id: true,
        ownerType: true,
        mime: true,
        originalName: true,
        size: true,
        key: true,
        createdAt: true,
        expireAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const readable = await this.storageConsistency.filterMetadataVisible(
      rows.filter((row) => row.expireAt === null || row.expireAt.getTime() > Date.now()),
    );
    return Promise.all(
      readable.map(async (row) => ({
        id: row.id,
        ownerType: row.ownerType,
        mime: row.mime,
        originalName: row.originalName,
        size: row.size,
        createdAt: row.createdAt,
        accessUrl: await this.access.resolveAccessUrl(row.key, row.expireAt),
      })),
    );
  }

  // 给 storage key 直接签下载 URL(列表封面缩略图反范式 key 直签,免 per-row Attachment 查询;
  // key null → null)。可信语义同上:调用方先做可见级校验。
  async resolveSignedUrlTrusted(key: string | null): Promise<string | null> {
    if (!key) return null;
    return this.access.resolveAccessUrl(key);
  }

  /**
   * Content-only storage facade. The caller must already hold the Content root FOR UPDATE lock and
   * must have completed its scoped authorization. This method performs no Provider or audit work.
   */
  async lockContentPublishStorageBoundaryTrusted(
    tx: Prisma.TransactionClient,
    input: ContentPublishStorageBoundaryInput,
  ): Promise<void> {
    return this.storageConsistency.lockContentPublishBoundary(tx, input);
  }

  /**
   * Content writer fence. The caller holds the Content root; matching owned Attachment rows are
   * share-locked so a concurrent delete either waits and sees the new reference or has already
   * committed a tombstone that this method rejects.
   */
  async lockContentReferenceStorageBoundaryTrusted(
    tx: Prisma.TransactionClient,
    input: ContentAttachmentReferenceBoundaryInput,
  ): Promise<void> {
    return this.storageConsistency.lockContentReferenceBoundary(tx, input);
  }

  // ============ helpers:校验链(沿 D7 v1.0 §6.2 9 步)============

  // ============ 7 端点业务逻辑 ============

  // GET /api/admin/v1/attachments(管理后台列表;按入参 query 过滤;逐条 ownership 过滤)。

  // ============ 五族薄委托(Phase 6-B 第三域第七刀)============
  //
  // 实现已迁至 attachment-{access,registration-upload,import-preview-upload,
  // content-upload-confirm,write}.service.ts(仅"搬家";判权 / 锁序 / 阶段令牌 /
  // 状态闸 / 审计逐字不变)。本 service 仍是本模块**唯一**对外入口 ——
  // 全仓约 100 处调用面因此逐字不变。

  async validateRegistrationUploadOutsideTransactionTrusted(
    ...args: Parameters<
      AttachmentRegistrationUploadService['validateRegistrationUploadOutsideTransactionTrusted']
    >
  ): ReturnType<
    AttachmentRegistrationUploadService['validateRegistrationUploadOutsideTransactionTrusted']
  > {
    return this.regs.validateRegistrationUploadOutsideTransactionTrusted(...args);
  }

  async prepareRegistrationUploadInTransactionTrusted(
    ...args: Parameters<
      AttachmentRegistrationUploadService['prepareRegistrationUploadInTransactionTrusted']
    >
  ): ReturnType<
    AttachmentRegistrationUploadService['prepareRegistrationUploadInTransactionTrusted']
  > {
    return this.regs.prepareRegistrationUploadInTransactionTrusted(...args);
  }

  async putRegistrationUploadAndVerifyOutsideTransactionTrusted(
    ...args: Parameters<
      AttachmentRegistrationUploadService['putRegistrationUploadAndVerifyOutsideTransactionTrusted']
    >
  ): ReturnType<
    AttachmentRegistrationUploadService['putRegistrationUploadAndVerifyOutsideTransactionTrusted']
  > {
    return this.regs.putRegistrationUploadAndVerifyOutsideTransactionTrusted(...args);
  }

  async finalizeRegistrationUploadInTransactionTrusted(
    ...args: Parameters<
      AttachmentRegistrationUploadService['finalizeRegistrationUploadInTransactionTrusted']
    >
  ): ReturnType<
    AttachmentRegistrationUploadService['finalizeRegistrationUploadInTransactionTrusted']
  > {
    return this.regs.finalizeRegistrationUploadInTransactionTrusted(...args);
  }

  registrationUploadResponseTrusted(
    ...args: Parameters<AttachmentRegistrationUploadService['registrationUploadResponseTrusted']>
  ): ReturnType<AttachmentRegistrationUploadService['registrationUploadResponseTrusted']> {
    return this.regs.registrationUploadResponseTrusted(...args);
  }

  async inspectRegistrationUploadsForSubmissionInTransactionTrusted(
    ...args: Parameters<
      AttachmentRegistrationUploadService['inspectRegistrationUploadsForSubmissionInTransactionTrusted']
    >
  ): ReturnType<
    AttachmentRegistrationUploadService['inspectRegistrationUploadsForSubmissionInTransactionTrusted']
  > {
    return this.regs.inspectRegistrationUploadsForSubmissionInTransactionTrusted(...args);
  }

  async consumeRegistrationUploadsForFormAnswersInTransactionTrusted(
    ...args: Parameters<
      AttachmentRegistrationUploadService['consumeRegistrationUploadsForFormAnswersInTransactionTrusted']
    >
  ): ReturnType<
    AttachmentRegistrationUploadService['consumeRegistrationUploadsForFormAnswersInTransactionTrusted']
  > {
    return this.regs.consumeRegistrationUploadsForFormAnswersInTransactionTrusted(...args);
  }

  async validateAttendanceImportPreviewUploadOutsideTransactionTrusted(
    ...args: Parameters<
      AttachmentImportPreviewUploadService['validateAttendanceImportPreviewUploadOutsideTransactionTrusted']
    >
  ): ReturnType<
    AttachmentImportPreviewUploadService['validateAttendanceImportPreviewUploadOutsideTransactionTrusted']
  > {
    return this.imports.validateAttendanceImportPreviewUploadOutsideTransactionTrusted(...args);
  }

  async prepareAttendanceImportPreviewUploadInTransactionTrusted(
    ...args: Parameters<
      AttachmentImportPreviewUploadService['prepareAttendanceImportPreviewUploadInTransactionTrusted']
    >
  ): ReturnType<
    AttachmentImportPreviewUploadService['prepareAttendanceImportPreviewUploadInTransactionTrusted']
  > {
    return this.imports.prepareAttendanceImportPreviewUploadInTransactionTrusted(...args);
  }

  async putAttendanceImportPreviewUploadAndVerifyOutsideTransactionTrusted(
    ...args: Parameters<
      AttachmentImportPreviewUploadService['putAttendanceImportPreviewUploadAndVerifyOutsideTransactionTrusted']
    >
  ): ReturnType<
    AttachmentImportPreviewUploadService['putAttendanceImportPreviewUploadAndVerifyOutsideTransactionTrusted']
  > {
    return this.imports.putAttendanceImportPreviewUploadAndVerifyOutsideTransactionTrusted(...args);
  }

  async finalizeAttendanceImportPreviewUploadInTransactionTrusted(
    ...args: Parameters<
      AttachmentImportPreviewUploadService['finalizeAttendanceImportPreviewUploadInTransactionTrusted']
    >
  ): ReturnType<
    AttachmentImportPreviewUploadService['finalizeAttendanceImportPreviewUploadInTransactionTrusted']
  > {
    return this.imports.finalizeAttendanceImportPreviewUploadInTransactionTrusted(...args);
  }

  attendanceImportPreviewUploadResponseTrusted(
    ...args: Parameters<
      AttachmentImportPreviewUploadService['attendanceImportPreviewUploadResponseTrusted']
    >
  ): ReturnType<
    AttachmentImportPreviewUploadService['attendanceImportPreviewUploadResponseTrusted']
  > {
    return this.imports.attendanceImportPreviewUploadResponseTrusted(...args);
  }

  async readAttendanceImportPreviewBytesOutsideTransactionTrusted(
    ...args: Parameters<
      AttachmentImportPreviewUploadService['readAttendanceImportPreviewBytesOutsideTransactionTrusted']
    >
  ): ReturnType<
    AttachmentImportPreviewUploadService['readAttendanceImportPreviewBytesOutsideTransactionTrusted']
  > {
    return this.imports.readAttendanceImportPreviewBytesOutsideTransactionTrusted(...args);
  }

  async guardContentUploadConfirm(
    ...args: Parameters<AttachmentContentUploadConfirmService['guardContentUploadConfirm']>
  ): ReturnType<AttachmentContentUploadConfirmService['guardContentUploadConfirm']> {
    return this.confirms.guardContentUploadConfirm(...args);
  }

  async prepareContentUploadConfirmInTransactionTrusted(
    ...args: Parameters<
      AttachmentContentUploadConfirmService['prepareContentUploadConfirmInTransactionTrusted']
    >
  ): ReturnType<
    AttachmentContentUploadConfirmService['prepareContentUploadConfirmInTransactionTrusted']
  > {
    return this.confirms.prepareContentUploadConfirmInTransactionTrusted(...args);
  }

  async verifyContentUploadConfirmEvidenceOutsideTransaction(
    ...args: Parameters<
      AttachmentContentUploadConfirmService['verifyContentUploadConfirmEvidenceOutsideTransaction']
    >
  ): ReturnType<
    AttachmentContentUploadConfirmService['verifyContentUploadConfirmEvidenceOutsideTransaction']
  > {
    return this.confirms.verifyContentUploadConfirmEvidenceOutsideTransaction(...args);
  }

  async finalizeContentUploadConfirmInTransactionTrusted(
    ...args: Parameters<
      AttachmentContentUploadConfirmService['finalizeContentUploadConfirmInTransactionTrusted']
    >
  ): ReturnType<
    AttachmentContentUploadConfirmService['finalizeContentUploadConfirmInTransactionTrusted']
  > {
    return this.confirms.finalizeContentUploadConfirmInTransactionTrusted(...args);
  }

  async resolveContentUploadConfirmResponseTrusted(
    ...args: Parameters<
      AttachmentContentUploadConfirmService['resolveContentUploadConfirmResponseTrusted']
    >
  ): ReturnType<
    AttachmentContentUploadConfirmService['resolveContentUploadConfirmResponseTrusted']
  > {
    return this.confirms.resolveContentUploadConfirmResponseTrusted(...args);
  }

  async create(
    ...args: Parameters<AttachmentWriteService['create']>
  ): ReturnType<AttachmentWriteService['create']> {
    return this.writes.create(...args);
  }

  async update(
    ...args: Parameters<AttachmentWriteService['update']>
  ): ReturnType<AttachmentWriteService['update']> {
    return this.writes.update(...args);
  }

  async delete(
    ...args: Parameters<AttachmentWriteService['delete']>
  ): ReturnType<AttachmentWriteService['delete']> {
    return this.writes.delete(...args);
  }

  async deleteContentAttachmentTrusted(
    ...args: Parameters<AttachmentWriteService['deleteContentAttachmentTrusted']>
  ): ReturnType<AttachmentWriteService['deleteContentAttachmentTrusted']> {
    return this.writes.deleteContentAttachmentTrusted(...args);
  }

  async createUploadUrl(
    ...args: Parameters<AttachmentWriteService['createUploadUrl']>
  ): ReturnType<AttachmentWriteService['createUploadUrl']> {
    return this.writes.createUploadUrl(...args);
  }

  async confirmUpload(
    ...args: Parameters<AttachmentWriteService['confirmUpload']>
  ): ReturnType<AttachmentWriteService['confirmUpload']> {
    return this.writes.confirmUpload(...args);
  }

  async list(
    query: ListAttachmentsQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<AttachmentResponseDto>> {
    const { page, pageSize, ownerType, ownerId, uploadedBy, mime, accessLevel, tags } = query;
    if (ownerType !== undefined && isInternalRegistrationAttachmentOwner(ownerType)) {
      return { items: [], total: 0, page, pageSize };
    }

    const where: Prisma.AttachmentWhereInput = {
      ...(ownerType !== undefined
        ? { ownerType }
        : {
            ownerType: {
              notIn: [
                'registration-upload-session',
                'registration-form-answer',
                ATTENDANCE_IMPORT_PREVIEW_OWNER_TYPE,
              ],
            },
          }),
      ...(ownerId !== undefined ? { ownerId } : {}),
      ...(uploadedBy !== undefined ? { uploadedBy } : {}),
      ...(mime !== undefined ? { mime } : {}),
      ...(accessLevel !== undefined ? { accessLevel } : {}),
      ...(tags !== undefined && tags.length > 0 ? { tags: { hasSome: tags } } : {}),
    };

    // 先取全部命中行(沿 D7 v1.0 §6.x:逐条 ownership 过滤后再分页;
    // 用户拍板 Q12:total 按"过滤后可见数量"返,避免泄露不可见资源数量)。
    // 性能边界:finding #11 certificate scope 已批量映射;#10 全量扫描+内存分页按现规模接受。
    const allRows = await this.prisma.attachment.findMany({
      where,
      select: attachmentSelect,
      orderBy: { createdAt: 'desc' },
    });
    const readableRows = await this.storageConsistency.filterMetadataVisible(allRows);
    const certificateMemberById = await this.access.loadCertificateMemberMap(
      readableRows.filter((row) => row.ownerType === 'certificate').map((row) => row.ownerId),
    );

    const visible: SafeAttachment[] = [];
    for (const row of readableRows) {
      if (await this.access.canViewAttachment(user, row, certificateMemberById)) {
        visible.push(row);
      }
    }
    const total = visible.length;
    const start = (page - 1) * pageSize;
    const items = await Promise.all(
      visible.slice(start, start + pageSize).map((row) => this.access.toResponseDto(row)),
    );
    return { items, total, page, pageSize };
  }

  // GET /api/admin/v1/attachments/:id
  async getById(id: string, user: CurrentUserPayload): Promise<AttachmentResponseDto> {
    // 1. 查活跃记录(不存在 → 13001)
    const row = await this.access.findByIdOrThrow(id);
    if (!(await this.storageConsistency.isMetadataVisible(row.key))) {
      throw new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    }

    // 2. 判 view 权限(Q13:不存在 + 无权统一返 13001)
    const { resource, scope } = await this.access.buildRbacResourceAndScope(
      row.ownerType as AttachmentOwnerType,
      row.ownerId,
      user,
    );
    const action = `attachment.view.${row.ownerType}${scope ? '.' + scope : ''}`;
    await this.access.assertReadAllowedOrThrowNotFound(user, action, resource);

    return this.access.toResponseDto(row);
  }

  // GET /api/admin/v1/attachments/by-owner?ownerType=&ownerId=
  // 逐条 ownership 过滤;total 按可见数量返(沿 list 范式)。
  async listByOwner(
    query: ListAttachmentsByOwnerQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<AttachmentResponseDto>> {
    if (isInternalRegistrationAttachmentOwner(query.ownerType)) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    }
    // 1. ownerType 双层校验(避免 enum 之外的字符串被传)
    await this.access.assertOwnerTypeAllowed(query.ownerType);

    // 2. ownerId 真实性校验(避免无效 cuid 返空列表泄露语义)。certificate 同批量映射查询合并。
    const certificateMemberById =
      query.ownerType === 'certificate'
        ? await this.access.loadCertificateMemberMap([query.ownerId])
        : undefined;
    if (query.ownerType === 'certificate') {
      if (!certificateMemberById?.has(query.ownerId)) {
        throw new BizException(BizCode.ATTACHMENT_OWNER_NOT_FOUND);
      }
    } else {
      await this.access.assertOwnerExists(query.ownerType as AttachmentOwnerType, query.ownerId);
    }

    // 3. 拉全部归属附件,逐条 ownership 过滤
    const allRows = await this.prisma.attachment.findMany({
      where: { ownerType: query.ownerType, ownerId: query.ownerId },
      select: attachmentSelect,
      orderBy: { createdAt: 'desc' },
    });
    const readableRows = await this.storageConsistency.filterMetadataVisible(allRows);
    const visible: SafeAttachment[] = [];
    for (const row of readableRows) {
      if (await this.access.canViewAttachment(user, row, certificateMemberById)) {
        visible.push(row);
      }
    }
    const total = visible.length;
    const start = (query.page - 1) * query.pageSize;
    const items = await Promise.all(
      visible.slice(start, start + query.pageSize).map((row) => this.access.toResponseDto(row)),
    );
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // listMyUploaded — 本人上传列表(uploadedBy = currentUser.id;沿 D7 §5.1 端点 7:
  // **自动按 uploadedBy 筛**,不需要 RBAC,本人查自己豁免)。原 `GET /me/uploaded` 路由已于
  // Route B Phase 4e 删除,本方法暂无 live route,保留为未来 `app/v1/my/attachments` building block。
  async listMyUploaded(
    query: PaginationQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<AttachmentResponseDto>> {
    const { page, pageSize } = query;
    const where: Prisma.AttachmentWhereInput = {
      uploadedBy: user.id,
      ownerType: {
        notIn: [
          'registration-upload-session',
          'registration-form-answer',
          ATTENDANCE_IMPORT_PREVIEW_OWNER_TYPE,
        ],
      },
    };

    const rows = await this.prisma.attachment.findMany({
      where,
      select: attachmentSelect,
      orderBy: { createdAt: 'desc' },
    });
    const readable = await this.storageConsistency.filterMetadataVisible(rows);
    const total = readable.length;
    const start = (page - 1) * pageSize;
    const items = await Promise.all(
      readable.slice(start, start + pageSize).map((row) => this.access.toResponseDto(row)),
    );
    return {
      items,
      total,
      page,
      pageSize,
    };
  }

  // ============ 内部:list / by-owner 共用 view ownership 判定 ============

  // ============ V2.x C-7.5 PR #10:upload-url + confirm-upload ============
  //
  // 沿评审 §8.3 + §8.4 + Q-10-1 到 Q-10-15 拍板:
  // - upload-url:校验 owner/RBAC/mime/size/PII → 预写 durable storage intent → 生成 key + signed
  //   URL + uploadToken;尚不创建 Attachment / 不写业务 audit
  // - confirm-upload:验 token + headObject + size + 受支持 MIME 魔数一致 → 落库 + audit `attachment.upload`
  // - v0.44.0 finding #23 唯一新增 13016(内容与声明 MIME 不符);其余继续复用既有码
  // - 0 新 AuditLogEvent(沿 B4)
  // - 0 新 RBAC 权限点(沿 B3;复用 attachment.upload.<type>.<scope>)
}

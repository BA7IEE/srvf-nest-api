import { Injectable } from '@nestjs/common';
import {
  CertificateStandardKind,
  CertificateStandardStatus,
  DictItemStatus,
  DictTypeStatus,
  Prisma,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { CertificateStandardAuditRecorder } from './certificate-standard-audit-recorder';
import {
  assertParentCategoryMatches,
  assertParentUsable,
  assertStandardTransitionAllowed,
} from './certificate-standard-policy';
import {
  CertificateStandardOptionItemDto,
  CertificateStandardOptionsQueryDto,
  CertificateStandardOptionsResponseDto,
  CertificateStandardQueryDto,
  CertificateStandardResponseDto,
  CreateCertificateStandardDto,
  UpdateCertificateStandardDto,
  UpdateCertificateStandardStatusDto,
} from './certificate-standards.dto';
import {
  certificateStandardOptionSelect,
  certificateStandardSafeSelect,
  type CertificateStandardOptionRow,
  type SafeCertificateStandard,
} from './certificate-standards.select';

// 证书标准库 PR-3(冻结稿 §5.2 / §7.1 / §13.1):通用证书标准管理面 service。
//
// 判权单轨 service 层 `rbac.can`(GLOBAL 主数据配置面,§16.4 明确「走 RbacService.can()」,
// **不**走 Certificate 实例的 scoped AuthzService)。沿 positions / dictionaries 范式。
//
// 与 positions 的一处差别:本 service **落 audit**(§17 高价值事件)——
// 理由见 certificate-standard-audit-recorder.ts 顶部。

const DICT_TYPE_CERT_TYPE = 'cert_type';
const DICT_TYPE_CERT_SUB_TYPE = 'cert_sub_type';

// §16.4:options 端点的替代入口码。
//
// 为什么需要这个清单:证书标准是 GLOBAL 配置面,8 条管理码只绑 ops-admin
// (PR-2 的设计订正 —— 业务面码集与 ops-admin 码集必须互不相交)。
// 但真正要用 options 下拉的是 biz-admin / org-admin / 招新审核员:
// 他们持 certificate.create / verify 或 recruitment-application.review.certificate,
// 却不持 certificate-standard.read.record。§16.4 为此明确写了
// 「options endpoint 可以接受 Standard read,**或由持 certificate create/verify、
//   recruitment certificate review 的角色获得专门只读绑定**」。
// 少了这条清单,建证表单的标准下拉对 biz-admin 恒空 —— 而且不会有任何测试变红。
const STANDARD_OPTIONS_ENTRY_CODES = [
  'certificate-standard.read.record',
  'certificate.create.record',
  'certificate.verify.record',
  'recruitment-application.review.certificate',
] as const;

@Injectable()
export class CertificateStandardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly audit: CertificateStandardAuditRecorder,
  ) {}

  // ============ helpers ============

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 任一码命中即放行(§16.4);全不命中才 30100。
  private async assertCanReadOptions(user: CurrentUserPayload): Promise<void> {
    for (const code of STANDARD_OPTIONS_ENTRY_CODES) {
      if (await this.rbac.can(user, code)) return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private async assertDictItemValid(
    typeCode: string,
    code: string,
    biz: BizCodeEntry,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const item = await tx.dictItem.findFirst({
      where: {
        code,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: { code: typeCode, status: DictTypeStatus.ACTIVE, deletedAt: null },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(biz);
  }

  private toResponseDto(row: SafeCertificateStandard): CertificateStandardResponseDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      kind: row.kind,
      categoryCode: row.categoryCode,
      levelCode: row.levelCode,
      parentId: row.parentId,
      isInternal: row.isInternal,
      status: row.status,
      sortOrder: row.sortOrder,
      activatedAt: row.activatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toOptionItem(row: CertificateStandardOptionRow): CertificateStandardOptionItemDto {
    const active = row.policies[0];
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      categoryCode: row.categoryCode,
      levelCode: row.levelCode,
      isInternal: row.isInternal,
      currentlyRecognized: active !== undefined,
      currentPolicy:
        active === undefined
          ? null
          : {
              id: active.id,
              version: active.version,
              issuerPolicy: active.issuerPolicy,
              validityMode: active.validityMode,
              validityMonths: active.validityMonths,
              certNumberMode: active.certNumberMode,
              issuers: active.issuers.map((i) => ({ id: i.id, name: i.name })),
            },
    };
  }

  private async findStandardOrThrow(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<SafeCertificateStandard> {
    const row = await tx.certificateStandard.findFirst({
      where: notDeletedWhere({ id }),
      select: certificateStandardSafeSelect,
    });
    if (!row) throw new BizException(BizCode.CERTIFICATE_STANDARD_NOT_FOUND);
    return row;
  }

  /**
   * 锁 Standard 行 + 锁后复读(评审 findings F5:R2 / R3 / R4 共用)。
   *
   * 锁模式与 `CertificateRecognitionPoliciesService.lockStandardOrThrow` **逐字一致**
   * (`FOR NO KEY UPDATE`)—— 那边是「该 Standard 全部 Policy 写路径的串行点」,
   * 这边是 Standard 自身的状态迁移与软删。两边用同一把锁,
   * 「删标准」与「给标准建规则」才会互斥;各用各的锁等于没锁。
   *
   * 修复前这三条路径都只 `findFirst` 就往下判:
   *   - `updateStatus` 非 CAS 无行锁 → 并发双激活都成功,`activatedAt` 被后者覆盖,
   *     两条 `activate` 审计,而 §7.1 说 `activatedAt` 记的是**首次**;
   *   - `softDelete` 在锁外数引用 → 与「建 Policy」并发可留下指向已软删 Standard 的 Policy;
   *   - `update` 在锁外判 DRAFT → 身份字段可以在并发激活的窗口里改进去。
   */
  private async lockStandardOrThrow(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<SafeCertificateStandard> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "CertificateStandard"
      WHERE "id" = ${id} AND "deletedAt" IS NULL
      FOR NO KEY UPDATE
    `);
    if (locked.length === 0) throw new BizException(BizCode.CERTIFICATE_STANDARD_NOT_FOUND);
    return this.findStandardOrThrow(id, tx);
  }

  // ============ list ============

  async list(
    user: CurrentUserPayload,
    query: CertificateStandardQueryDto,
  ): Promise<PageResultDto<CertificateStandardResponseDto>> {
    await this.assertCanOrThrow(user, 'certificate-standard.read.record');
    const { page, pageSize, kind, categoryCode, levelCode, status, parentId, q } = query;

    const filters: Prisma.CertificateStandardWhereInput = {};
    if (kind !== undefined) filters.kind = kind;
    if (categoryCode !== undefined) filters.categoryCode = categoryCode;
    if (levelCode !== undefined) filters.levelCode = levelCode;
    if (status !== undefined) filters.status = status;
    if (parentId !== undefined) filters.parentId = parentId;
    if (q !== undefined) {
      filters.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { code: { contains: q, mode: 'insensitive' } },
      ];
    }
    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.certificateStandard.findMany({
        where,
        select: certificateStandardSafeSelect,
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.certificateStandard.count({ where }),
    ]);

    return { items: rows.map((r) => this.toResponseDto(r)), total, page, pageSize };
  }

  // ============ options(§13.1;必须先于 :id 声明,由 controller 保证)============

  // 只返 CREDENTIAL(§13.1)—— FAMILY 是目录节点,放进建证下拉就会被选中,
  // 而 FAMILY 不可持有(D-CERT-003)。
  async options(
    user: CurrentUserPayload,
    query: CertificateStandardOptionsQueryDto,
  ): Promise<CertificateStandardOptionsResponseDto> {
    await this.assertCanReadOptions(user);
    const { recognizedOnly, categoryCode, q, limit } = query;

    const filters: Prisma.CertificateStandardWhereInput = {
      kind: CertificateStandardKind.CREDENTIAL,
    };
    if (categoryCode !== undefined) filters.categoryCode = categoryCode;
    if (q !== undefined) {
      filters.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { code: { contains: q, mode: 'insensitive' } },
      ];
    }
    // 评审 findings F5(R5):**两档都只返 ACTIVE**。
    //
    // 修复前 `recognizedOnly` 缺省时返 ACTIVE + INACTIVE,而 INACTIVE 标准
    // 在 Resolver 那里是硬拒(`assertStandardIsActive`)—— 于是下拉里明明列着、
    // 甚至因为它还挂着一条 ACTIVE Policy 而显示 `currentlyRecognized: true`,
    // 选中提交却被拒。「能选但选了就报错」是最难排查的一类前端问题:
    // 报错信息指向标准状态,而用户看到的界面上根本没有状态这一列。
    //
    // 两档的区别因此收窄为「要不要**同时**有 ACTIVE Policy」:
    //   recognizedOnly=true  → ACTIVE 标准 **且** 有 ACTIVE 认定规则(可直接建证)
    //   缺省                 → ACTIVE 标准(含 §11.2「已收录、待认定」那一档)
    filters.status = CertificateStandardStatus.ACTIVE;
    if (recognizedOnly === true) {
      // §13.1:recognizedOnly=true 要求 Standard ACTIVE **且**有 ACTIVE Policy。
      filters.policies = {
        some: { status: 'ACTIVE', deletedAt: null },
      };
    }

    const rows = await this.prisma.certificateStandard.findMany({
      where: notDeletedWhere(filters),
      select: certificateStandardOptionSelect,
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      take: limit ?? 50,
    });

    return { items: rows.map((r) => this.toOptionItem(r)) };
  }

  // ============ findOne ============

  async findOne(user: CurrentUserPayload, id: string): Promise<CertificateStandardResponseDto> {
    await this.assertCanOrThrow(user, 'certificate-standard.read.record');
    const row = await this.prisma.certificateStandard.findFirst({
      where: notDeletedWhere({ id }),
      select: certificateStandardSafeSelect,
    });
    if (!row) throw new BizException(BizCode.CERTIFICATE_STANDARD_NOT_FOUND);
    return this.toResponseDto(row);
  }

  // ============ create ============

  // 初始恒 DRAFT(§7.1):新标准必须显式走一次 status 迁移才可用,
  // 避免「建完就能建证」跳过人工确认。
  //
  // 关于父子循环(§5.2「禁止形成父子循环」):`parentId` 只在 create 期可设、
  // Update DTO 不含它,而新建行此刻还没有任何后代 —— 因此循环在结构上不可能形成,
  // 不需要运行时环检测。这条不变量由**字段不可变性**保证,不是靠检查漏没漏。
  async create(
    user: CurrentUserPayload,
    dto: CreateCertificateStandardDto,
    meta: AuditMeta,
  ): Promise<CertificateStandardResponseDto> {
    await this.assertCanOrThrow(user, 'certificate-standard.create.record');
    return this.prisma.$transaction(async (tx) => {
      await this.assertDictItemValid(
        DICT_TYPE_CERT_TYPE,
        dto.categoryCode,
        BizCode.CERTIFICATE_TYPE_CODE_INVALID,
        tx,
      );
      if (dto.levelCode !== undefined) {
        await this.assertDictItemValid(
          DICT_TYPE_CERT_SUB_TYPE,
          dto.levelCode,
          BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID,
          tx,
        );
      }

      if (dto.parentId !== undefined) {
        const parent = await tx.certificateStandard.findFirst({
          where: notDeletedWhere({ id: dto.parentId }),
          select: { kind: true, categoryCode: true, status: true },
        });
        if (!parent) throw new BizException(BizCode.CERTIFICATE_STANDARD_NOT_FOUND);
        assertParentUsable(parent);
        assertParentCategoryMatches(dto.categoryCode, parent.categoryCode);
      }

      const data: Prisma.CertificateStandardUncheckedCreateInput = {
        code: dto.code,
        name: dto.name,
        kind: dto.kind,
        categoryCode: dto.categoryCode,
        status: CertificateStandardStatus.DRAFT,
      };
      if (dto.description !== undefined) data.description = dto.description;
      if (dto.levelCode !== undefined) data.levelCode = dto.levelCode;
      if (dto.parentId !== undefined) data.parentId = dto.parentId;
      if (dto.isInternal !== undefined) data.isInternal = dto.isInternal;
      if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

      let created: SafeCertificateStandard;
      try {
        created = await tx.certificateStandard.create({
          data,
          select: certificateStandardSafeSelect,
        });
      } catch (err) {
        // code 是全量 @unique:**含软删行**仍占用该 code(D-CERT-004
        // 「不可复用」正是靠这一点 —— 软删一个标准不会释放它的 code)。
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BizException(BizCode.CERTIFICATE_STANDARD_CODE_EXISTS);
        }
        throw err;
      }

      await this.audit.recordStandardChange({
        currentUser: user,
        meta,
        standardId: created.id,
        operation: 'create',
        after: this.audit.toStandardSnapshot(created),
        tx,
      });

      return this.toResponseDto(created);
    });
  }

  // ============ update(仅文案与排序)============

  // DTO 只有 name / description / sortOrder(§7.1「只允许修正名称、说明、排序」)。
  // 身份字段不在白名单里,所以「ACTIVE 后身份字段不可改」这条不变量在**契约层**
  // 就成立了,不依赖运行时判状态 —— forbidNonWhitelisted 会把 code / kind /
  // categoryCode 之类直接拒成 40000。
  // `CERTIFICATE_STANDARD_IMMUTABLE` 因此在本刀没有触发路径,留给 PR-4a 若开放
  // DRAFT 期身份编辑时使用。
  async update(
    user: CurrentUserPayload,
    id: string,
    dto: UpdateCertificateStandardDto,
    meta: AuditMeta,
  ): Promise<CertificateStandardResponseDto> {
    await this.assertCanOrThrow(user, 'certificate-standard.update.record');
    return this.prisma.$transaction(async (tx) => {
      // 锁 + 复读:身份字段可改与否取决于行状态,而状态可能正被并发的
      // `updateStatus` 改成 ACTIVE。锁前判等于让「首次启用后永久锁死」出现一个窗口。
      const before = await this.lockStandardOrThrow(tx, id);

      const data: Prisma.CertificateStandardUncheckedUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.description !== undefined) data.description = dto.description;
      if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

      // 评审 findings F5(R2):身份字段在 DRAFT 且**从未启用过**时可改。
      //
      // 判据用 `activatedAt !== null` 而不是只看 `status !== DRAFT`:
      // 状态机允许 ACTIVE → INACTIVE → ACTIVE,`activatedAt` 记的是**首次**启用时刻
      // 且永不被覆盖 —— 它才是「这个标准有没有对外生效过」的那个事实。
      // 只看 status 的话,一个 INACTIVE 标准会被误判成可改身份,
      // 而它可能已经被一批历史证书引用着。
      const identityTouched =
        dto.kind !== undefined ||
        dto.categoryCode !== undefined ||
        dto.levelCode !== undefined ||
        dto.parentId !== undefined ||
        dto.isInternal !== undefined;
      if (identityTouched) {
        if (before.status !== CertificateStandardStatus.DRAFT || before.activatedAt !== null) {
          throw new BizException(BizCode.CERTIFICATE_STANDARD_IMMUTABLE);
        }
        const nextKind = dto.kind ?? before.kind;
        const nextCategoryCode = dto.categoryCode ?? before.categoryCode;
        const nextLevelCode = dto.levelCode !== undefined ? dto.levelCode : before.levelCode;
        const nextParentId = dto.parentId !== undefined ? dto.parentId : before.parentId;

        // 字典与父级按**本次写入后的最终值**复校,不是只校验传了什么 ——
        // 只改 categoryCode 时也必须拿新 category 和旧 parent 比一次。
        await this.assertDictItemValid(
          DICT_TYPE_CERT_TYPE,
          nextCategoryCode,
          BizCode.CERTIFICATE_TYPE_CODE_INVALID,
          tx,
        );
        if (nextLevelCode !== null) {
          await this.assertDictItemValid(
            DICT_TYPE_CERT_SUB_TYPE,
            nextLevelCode,
            BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID,
            tx,
          );
        }
        if (nextParentId !== null) {
          // 自己不能当自己的父级。DRAFT 行此刻可能已经有子节点(别的 DRAFT 挂上来),
          // 所以 create 期「结构上不可能成环」的论证在这里不成立,必须显式拦。
          if (nextParentId === id) {
            throw new BizException(BizCode.CERTIFICATE_STANDARD_PARENT_INVALID);
          }
          const parent = await tx.certificateStandard.findFirst({
            where: notDeletedWhere({ id: nextParentId }),
            select: { kind: true, categoryCode: true, status: true },
          });
          if (!parent) throw new BizException(BizCode.CERTIFICATE_STANDARD_NOT_FOUND);
          assertParentUsable(parent);
          assertParentCategoryMatches(nextCategoryCode, parent.categoryCode);
        }

        if (dto.kind !== undefined) data.kind = nextKind;
        if (dto.categoryCode !== undefined) data.categoryCode = nextCategoryCode;
        if (dto.levelCode !== undefined) data.levelCode = nextLevelCode;
        if (dto.parentId !== undefined) data.parentId = nextParentId;
        if (dto.isInternal !== undefined) data.isInternal = dto.isInternal;
      }

      const updated = await tx.certificateStandard.update({
        where: { id },
        data,
        select: certificateStandardSafeSelect,
      });

      await this.audit.recordStandardChange({
        currentUser: user,
        meta,
        standardId: id,
        operation: 'update',
        before: this.audit.toStandardSnapshot(before),
        after: this.audit.toStandardSnapshot(updated),
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ updateStatus(状态机)============

  async updateStatus(
    user: CurrentUserPayload,
    id: string,
    dto: UpdateCertificateStandardStatusDto,
    meta: AuditMeta,
  ): Promise<CertificateStandardResponseDto> {
    await this.assertCanOrThrow(user, 'certificate-standard.update.record');
    return this.prisma.$transaction(async (tx) => {
      // 锁 + 锁后复读:并发的两次 DRAFT→ACTIVE 里,后到的那个在这里看到
      // status 已是 ACTIVE,`assertStandardTransitionAllowed(ACTIVE → ACTIVE)` 直接拒。
      // 修复前两次都成功:各自读到 DRAFT、各自过状态机、各自写 activatedAt
      // (后者覆盖前者,而 §7.1 说它记的是**首次**启用时刻),留下两条 activate 审计。
      const before = await this.lockStandardOrThrow(tx, id);
      assertStandardTransitionAllowed(before.status, dto.status);

      // §7.1 INACTIVE→ACTIVE:「恢复 ACTIVE 前重新校验字典和父级」——
      // 停用期间字典项可能被停用/删除,直接恢复会造出引用已停用字典的 ACTIVE 标准。
      if (dto.status === CertificateStandardStatus.ACTIVE) {
        await this.assertDictItemValid(
          DICT_TYPE_CERT_TYPE,
          before.categoryCode,
          BizCode.CERTIFICATE_TYPE_CODE_INVALID,
          tx,
        );
        if (before.levelCode !== null) {
          await this.assertDictItemValid(
            DICT_TYPE_CERT_SUB_TYPE,
            before.levelCode,
            BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID,
            tx,
          );
        }
        if (before.parentId !== null) {
          const parent = await tx.certificateStandard.findFirst({
            where: notDeletedWhere({ id: before.parentId }),
            select: { kind: true, categoryCode: true, status: true },
          });
          if (!parent) throw new BizException(BizCode.CERTIFICATE_STANDARD_NOT_FOUND);
          assertParentUsable(parent);
          assertParentCategoryMatches(before.categoryCode, parent.categoryCode);
        }
      }

      const data: Prisma.CertificateStandardUncheckedUpdateInput = { status: dto.status };
      // activatedAt 记**首次**启用时刻,不被后续 INACTIVE→ACTIVE 覆盖 ——
      // 它是「这个标准何时进入可用状态」的历史事实,不是「最近一次启用」。
      if (dto.status === CertificateStandardStatus.ACTIVE && before.activatedAt === null) {
        data.activatedAt = new Date();
      }

      const updated = await tx.certificateStandard.update({
        where: { id },
        data,
        select: certificateStandardSafeSelect,
      });

      await this.audit.recordStandardChange({
        currentUser: user,
        meta,
        standardId: id,
        operation: dto.status === CertificateStandardStatus.ACTIVE ? 'activate' : 'deactivate',
        before: this.audit.toStandardSnapshot(before),
        after: this.audit.toStandardSnapshot(updated),
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ softDelete ============

  // 删除守卫(§18 CERTIFICATE_STANDARD_IN_USE):被任何**未软删**的
  // 子节点 / Policy / Claim(建议或已解析)/ Certificate 引用时禁删。
  // 四类引用一次查清,不逐个 early-return —— 逐个查会让「同时被两类引用」时
  // 报出的原因取决于查询顺序,排障时看着像随机。
  //
  // 评审 findings F5(R3)加了两道:
  //   ① **只有 DRAFT 可删**。修复前 ACTIVE / INACTIVE 也能软删,而它们可能已经
  //      被历史证书引用 —— 软删一个 ACTIVE 标准,`options` 立刻看不到它,
  //      但存量证书还挂着它的 id,资质查询会 join 到一个「已删」的标准。
  //      引用计数确实拦得住有引用的,但零引用的 ACTIVE 标准照样能删,
  //      而那意味着「这个 code 被永久占用且再也建不出来」。
  //   ② **先锁再数**。修复前引用计数在锁外跑,与「给这个标准建 Policy」并发时:
  //      删除数到 0 条 Policy,建 Policy 提交,删除也提交 —— 留下一条
  //      指向已软删 Standard 的 Policy。现在两条路径抢同一把 Standard 行锁。
  async softDelete(user: CurrentUserPayload, id: string, meta: AuditMeta): Promise<void> {
    await this.assertCanOrThrow(user, 'certificate-standard.delete.record');
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lockStandardOrThrow(tx, id);
      if (before.status !== CertificateStandardStatus.DRAFT || before.activatedAt !== null) {
        throw new BizException(BizCode.CERTIFICATE_STANDARD_IN_USE);
      }

      const [children, policies, certificates, claimsResolved, claimsSuggested] = await Promise.all(
        [
          tx.certificateStandard.count({ where: { parentId: id, deletedAt: null } }),
          tx.certificateRecognitionPolicy.count({ where: { standardId: id, deletedAt: null } }),
          tx.certificate.count({ where: { standardId: id, deletedAt: null } }),
          tx.recruitmentCertificateClaim.count({ where: { standardId: id, deletedAt: null } }),
          tx.recruitmentCertificateClaim.count({
            where: { suggestedStandardId: id, deletedAt: null },
          }),
        ],
      );
      if (children + policies + certificates + claimsResolved + claimsSuggested > 0) {
        throw new BizException(BizCode.CERTIFICATE_STANDARD_IN_USE);
      }

      await tx.certificateStandard.update({ where: { id }, data: { deletedAt: new Date() } });

      await this.audit.recordStandardChange({
        currentUser: user,
        meta,
        standardId: id,
        operation: 'delete',
        before: this.audit.toStandardSnapshot(before),
        tx,
      });
    });
  }
}

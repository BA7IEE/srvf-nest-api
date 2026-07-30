import { Injectable } from '@nestjs/common';
import { CertificateRecognitionPolicyStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { CertificateStandardAuditRecorder } from './certificate-standard-audit-recorder';
import {
  assertIssuerCountMatchesPolicy,
  assertPolicyIsDraft,
  assertPolicyTransitionAllowed,
  assertStandardIsActive,
  assertStandardIsCredential,
  assertValidityCombination,
  normalizeIssuerName,
} from './certificate-standard-policy';
import {
  CertificateRecognitionIssuerInputDto,
  CertificateRecognitionPolicyListResponseDto,
  CertificateRecognitionPolicyResponseDto,
  CreateCertificateRecognitionPolicyDto,
  UpdateCertificateRecognitionPolicyDto,
  UpdateCertificateRecognitionPolicyStatusDto,
} from './certificate-recognition-policies.dto';

// 证书标准库 PR-3(冻结稿 §5.3 / §5.4 / §7.2 / §13.2):队内认定规则管理面 service。
//
// 本 service 是整个 PR-3 里唯一有真并发正确性要求的地方,三条不变量:
//   D-CERT-006  每个 Standard 同时至多一个 ACTIVE Policy
//   D-CERT-007  已激活 / 已退役的规则永久不可修改
//   D-CERT-008  已锁定该 Policy 的 pending Certificate 与 APPROVED Claim 不因新版上线而移动目标
//
// 并发策略(§5.3 固定顺序):所有会改动「某 Standard 的 Policy 集合」的写路径,
// **一律先锁该 Standard 行**。这样同一 Standard 的建版 / 激活 / 退役天然串行化,
// 不同 Standard 之间互不阻塞。DB 侧的 partial unique
// (`certificate_recognition_policy_one_active_per_standard`)是最终兜底 ——
// 万一将来有人加了绕过行锁的新写路径,它仍然挡得住双 ACTIVE。
//
// 为什么不只靠 partial unique:激活是「RETIRE 旧 + ACTIVATE 新」两步写。
// 没有行锁时两个事务可以都先读到「当前 ACTIVE 是 v1」,各自 RETIRE v1 再各自
// ACTIVATE 自己 —— 其中一个会撞 unique 而回滚,但**回滚前它已经把 v1 retire 了**,
// 在 READ COMMITTED 下另一个事务看不到这次回滚,最终可能出现「谁都没生效」。
// 行锁把这个窗口整个消掉。

@Injectable()
export class CertificateRecognitionPoliciesService {
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

  // 锁 Standard 行 = 该 Standard 全部 Policy 写路径的串行点(§5.3 固定锁序第 1 步)。
  //
  // 用 `FOR NO KEY UPDATE` 而非 `FOR UPDATE`:我们并不改 Standard 自己的主键或
  // 被引用列,只是拿它当互斥量;NO KEY 变体不会给 Standard 造出多余的 tuple 版本,
  // 也不会和并发的 Standard 文案修改互相升级成阻塞(沿仓库 claimAtStatus 同款考量)。
  private async lockStandardOrThrow(
    tx: Prisma.TransactionClient,
    standardId: string,
  ): Promise<{ id: string; kind: 'FAMILY' | 'CREDENTIAL'; status: string; code: string }> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "CertificateStandard"
      WHERE "id" = ${standardId} AND "deletedAt" IS NULL
      FOR NO KEY UPDATE
    `);
    if (locked.length === 0) throw new BizException(BizCode.CERTIFICATE_STANDARD_NOT_FOUND);

    // 锁到之后再读业务字段:锁内读到的必然是最新已提交状态。
    const row = await tx.certificateStandard.findFirst({
      where: { id: standardId },
      select: { id: true, kind: true, status: true, code: true },
    });
    if (!row) throw new BizException(BizCode.CERTIFICATE_STANDARD_NOT_FOUND);
    return row;
  }

  private async loadIssuers(
    tx: Prisma.TransactionClient,
    policyId: string,
  ): Promise<Array<{ id: string; name: string; sortOrder: number }>> {
    return tx.certificateRecognitionIssuer.findMany({
      where: { policyId, deletedAt: null },
      select: { id: true, name: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private toResponseDto(
    row: {
      id: string;
      standardId: string;
      version: number;
      status: CertificateRecognitionPolicyStatus;
      issuerPolicy: CertificateRecognitionPolicyResponseDto['issuerPolicy'];
      validityMode: CertificateRecognitionPolicyResponseDto['validityMode'];
      validityMonths: number | null;
      certNumberMode: CertificateRecognitionPolicyResponseDto['certNumberMode'];
      activatedAt: Date | null;
      retiredAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
    issuers: Array<{ id: string; name: string; sortOrder: number }>,
  ): CertificateRecognitionPolicyResponseDto {
    return {
      id: row.id,
      standardId: row.standardId,
      version: row.version,
      status: row.status,
      issuerPolicy: row.issuerPolicy,
      validityMode: row.validityMode,
      validityMonths: row.validityMonths,
      certNumberMode: row.certNumberMode,
      activatedAt: row.activatedAt,
      retiredAt: row.retiredAt,
      issuers: issuers.map((i) => ({ id: i.id, name: i.name, sortOrder: i.sortOrder })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private readonly policySelect = {
    id: true,
    standardId: true,
    version: true,
    status: true,
    issuerPolicy: true,
    validityMode: true,
    validityMonths: true,
    certNumberMode: true,
    activatedAt: true,
    retiredAt: true,
    createdAt: true,
    updatedAt: true,
  } as const satisfies Prisma.CertificateRecognitionPolicySelect;

  private async findPolicyOrThrow(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.certificateRecognitionPolicy.findFirst({
      where: notDeletedWhere({ id }),
      select: this.policySelect,
    });
    if (!row) throw new BizException(BizCode.CERTIFICATE_POLICY_NOT_FOUND);
    return row;
  }

  // 机构名归一后同一集合内不得重复(§5.4:归一只用于 DRAFT 内去重)。
  // 这里先在内存里拦一次,给出清晰的 18013;DB 的 partial unique 仍是兜底。
  private normalizeIssuerInputs(
    issuers: CertificateRecognitionIssuerInputDto[],
  ): Array<{ name: string; normalizedName: string; sortOrder: number }> {
    const mapped = issuers.map((i, idx) => ({
      name: i.name.trim(),
      normalizedName: normalizeIssuerName(i.name),
      sortOrder: i.sortOrder ?? idx,
    }));
    const seen = new Set(mapped.map((m) => m.normalizedName));
    if (seen.size !== mapped.length) {
      throw new BizException(BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID);
    }
    return mapped;
  }

  // P2002 → 业务码的显式映射(§5.3 第 7 步)。两条索引语义不同,不能合并成一个码。
  private mapPolicyP2002(err: unknown): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = JSON.stringify(err.meta?.['target'] ?? '');
      if (target.includes('one_active_per_standard')) {
        throw new BizException(BizCode.CERTIFICATE_POLICY_ACTIVE_CONFLICT);
      }
      throw new BizException(BizCode.CERTIFICATE_POLICY_VERSION_CONFLICT);
    }
    throw err;
  }

  // ============ list(某 Standard 的全部版本)============

  async list(
    user: CurrentUserPayload,
    standardId: string,
  ): Promise<CertificateRecognitionPolicyListResponseDto> {
    await this.assertCanOrThrow(user, 'certificate-recognition-policy.read.record');
    const standard = await this.prisma.certificateStandard.findFirst({
      where: notDeletedWhere({ id: standardId }),
      select: { id: true },
    });
    if (!standard) throw new BizException(BizCode.CERTIFICATE_STANDARD_NOT_FOUND);

    const rows = await this.prisma.certificateRecognitionPolicy.findMany({
      where: notDeletedWhere({ standardId }),
      select: this.policySelect,
      orderBy: [{ version: 'desc' }],
    });
    const issuersByPolicy = await this.prisma.certificateRecognitionIssuer.findMany({
      where: { policyId: { in: rows.map((r) => r.id) }, deletedAt: null },
      select: { id: true, policyId: true, name: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    // 一次取回全部 issuer 再在内存分组 —— 不按 policy 逐条查(禁 N+1)。
    const grouped = new Map<string, Array<{ id: string; name: string; sortOrder: number }>>();
    for (const i of issuersByPolicy) {
      const list = grouped.get(i.policyId) ?? [];
      list.push({ id: i.id, name: i.name, sortOrder: i.sortOrder });
      grouped.set(i.policyId, list);
    }

    return { items: rows.map((r) => this.toResponseDto(r, grouped.get(r.id) ?? [])) };
  }

  // ============ findOne ============

  async findOne(
    user: CurrentUserPayload,
    id: string,
  ): Promise<CertificateRecognitionPolicyResponseDto> {
    await this.assertCanOrThrow(user, 'certificate-recognition-policy.read.record');
    const row = await this.findPolicyOrThrow(this.prisma, id);
    const issuers = await this.loadIssuers(this.prisma, id);
    return this.toResponseDto(row, issuers);
  }

  // ============ create(建新 DRAFT 版本)============

  // §5.3:「新建 DRAFT Policy 时,必须在 Standard 行锁内读取 MAX(version) 并写入下一版本;
  // 并发撞 (standardId, version) 时显式转换 P2002」。
  //
  // MAX(version) **不过滤软删**:版本号一旦用过就不复用,否则「v2 被软删后新建又叫 v2」
  // 会让历史证书引用的 policyVersion 指向两个不同规则。
  async create(
    user: CurrentUserPayload,
    standardId: string,
    dto: CreateCertificateRecognitionPolicyDto,
    meta: AuditMeta,
  ): Promise<CertificateRecognitionPolicyResponseDto> {
    await this.assertCanOrThrow(user, 'certificate-recognition-policy.create.record');
    return this.prisma.$transaction(async (tx) => {
      const standard = await this.lockStandardOrThrow(tx, standardId);
      // FAMILY 不能配 Policy(§5.2:「FAMILY 不允许配置 Policy」/ D-CERT-003)。
      assertStandardIsCredential(standard.kind);

      assertValidityCombination(dto.validityMode, dto.validityMonths);
      assertIssuerCountMatchesPolicy(dto.issuerPolicy, dto.issuers.length);
      const issuers = this.normalizeIssuerInputs(dto.issuers);

      const agg = await tx.certificateRecognitionPolicy.aggregate({
        where: { standardId },
        _max: { version: true },
      });
      const nextVersion = (agg._max.version ?? 0) + 1;

      let created;
      try {
        created = await tx.certificateRecognitionPolicy.create({
          data: {
            standardId,
            version: nextVersion,
            status: CertificateRecognitionPolicyStatus.DRAFT,
            issuerPolicy: dto.issuerPolicy,
            validityMode: dto.validityMode,
            validityMonths: dto.validityMonths ?? null,
            certNumberMode: dto.certNumberMode,
          },
          select: this.policySelect,
        });
      } catch (err) {
        this.mapPolicyP2002(err);
      }

      if (issuers.length > 0) {
        await tx.certificateRecognitionIssuer.createMany({
          data: issuers.map((i) => ({
            policyId: created.id,
            name: i.name,
            normalizedName: i.normalizedName,
            sortOrder: i.sortOrder,
          })),
        });
      }

      const savedIssuers = await this.loadIssuers(tx, created.id);
      await this.audit.recordPolicyChange({
        currentUser: user,
        meta,
        policyId: created.id,
        operation: 'create-policy',
        after: this.audit.toPolicySnapshot(
          created,
          savedIssuers.map((i) => i.name),
        ),
        tx,
      });

      return this.toResponseDto(created, savedIssuers);
    });
  }

  // ============ update(仅 DRAFT;issuer 整体替换)============

  async update(
    user: CurrentUserPayload,
    id: string,
    dto: UpdateCertificateRecognitionPolicyDto,
    meta: AuditMeta,
  ): Promise<CertificateRecognitionPolicyResponseDto> {
    await this.assertCanOrThrow(user, 'certificate-recognition-policy.update.record');
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.findPolicyOrThrow(tx, id);
      await this.lockStandardOrThrow(tx, existing.standardId);
      // 锁后复读:等锁期间它可能已被别的事务激活(D-CERT-007 不许改已激活规则)。
      const locked = await this.findPolicyOrThrow(tx, id);
      assertPolicyIsDraft(locked.status);

      const beforeIssuers = await this.loadIssuers(tx, id);

      // 最终态校验按「本次写入后的值」算,不是只看传了什么 ——
      // 只改 validityMode 不改 validityMonths 时,必须拿新 mode 配旧 months 复核。
      const nextIssuerPolicy = dto.issuerPolicy ?? locked.issuerPolicy;
      const nextValidityMode = dto.validityMode ?? locked.validityMode;
      const nextValidityMonths =
        dto.validityMonths !== undefined
          ? dto.validityMonths
          : dto.validityMode !== undefined
            ? // 改了 mode 但没给 months:按新 mode 从零开始判(FIXED_MONTHS 缺 months 即 18015)
              null
            : locked.validityMonths;
      assertValidityCombination(nextValidityMode, nextValidityMonths);

      const replacing = dto.issuers !== undefined;
      const nextIssuers = replacing ? this.normalizeIssuerInputs(dto.issuers ?? []) : null;
      assertIssuerCountMatchesPolicy(
        nextIssuerPolicy,
        nextIssuers !== null ? nextIssuers.length : beforeIssuers.length,
      );

      const data: Prisma.CertificateRecognitionPolicyUncheckedUpdateInput = {};
      if (dto.issuerPolicy !== undefined) data.issuerPolicy = dto.issuerPolicy;
      if (dto.validityMode !== undefined) data.validityMode = dto.validityMode;
      if (dto.validityMode !== undefined || dto.validityMonths !== undefined) {
        data.validityMonths = nextValidityMonths;
      }
      if (dto.certNumberMode !== undefined) data.certNumberMode = dto.certNumberMode;

      const updated = await tx.certificateRecognitionPolicy.update({
        where: { id },
        data,
        select: this.policySelect,
      });

      if (nextIssuers !== null) {
        // 整体替换 = 软删旧集合 + 建新集合(§13.2)。软删而非硬删:
        // partial unique 只约束未软删行,所以同名机构可以在替换后再次出现,
        // 同时保留「这个 DRAFT 曾经列过哪些机构」的痕迹。
        await tx.certificateRecognitionIssuer.updateMany({
          where: { policyId: id, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        if (nextIssuers.length > 0) {
          await tx.certificateRecognitionIssuer.createMany({
            data: nextIssuers.map((i) => ({
              policyId: id,
              name: i.name,
              normalizedName: i.normalizedName,
              sortOrder: i.sortOrder,
            })),
          });
        }
      }

      const afterIssuers = await this.loadIssuers(tx, id);
      await this.audit.recordPolicyChange({
        currentUser: user,
        meta,
        policyId: id,
        operation: replacing ? 'replace-draft-issuers' : 'update-draft-policy',
        before: this.audit.toPolicySnapshot(
          locked,
          beforeIssuers.map((i) => i.name),
        ),
        after: this.audit.toPolicySnapshot(
          updated,
          afterIssuers.map((i) => i.name),
        ),
        tx,
      });

      return this.toResponseDto(updated, afterIssuers);
    });
  }

  // ============ updateStatus(激活 / 退役)============

  // §5.3 激活七步,逐条对应下面的代码:
  //   1. 锁 Standard                      → lockStandardOrThrow
  //   2. 校验 Standard 为 ACTIVE CREDENTIAL → assertStandardIsCredential + assertStandardIsActive
  //   3. 校验 Policy 和 issuer 最终态       → assertValidityCombination + assertIssuerCountMatchesPolicy
  //   4. 锁并 RETIRE 当前 ACTIVE Policy     → updateMany(status=ACTIVE → RETIRED)
  //   5. 激活新 Policy                     → update(status=ACTIVE)
  //   6. 全部在同一事务提交                → $transaction
  //   7. 并发由 partial unique + 显式 P2002 兜底 → mapPolicyP2002
  async updateStatus(
    user: CurrentUserPayload,
    id: string,
    dto: UpdateCertificateRecognitionPolicyStatusDto,
    meta: AuditMeta,
  ): Promise<CertificateRecognitionPolicyResponseDto> {
    await this.assertCanOrThrow(user, 'certificate-recognition-policy.update.record');
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.findPolicyOrThrow(tx, id);
      const standard = await this.lockStandardOrThrow(tx, existing.standardId);

      // 锁后复读本 Policy:并发的同一激活请求里,后到的那个在这里看到 status 已是
      // ACTIVE,`assertPolicyTransitionAllowed(ACTIVE → ACTIVE)` 直接拒 18037。
      // 这就是「并发激活只有一个成功」的落点 —— 靠行锁 + 锁后复读,不靠捕异常。
      const locked = await this.findPolicyOrThrow(tx, id);
      assertPolicyTransitionAllowed(locked.status, dto.status);

      const issuers = await this.loadIssuers(tx, id);
      const now = new Date();
      // 激活时被自动退役的那一版(R8);非激活路径恒 null。
      let supersededPolicy: { id: string; version: number } | null = null;

      if (dto.status === CertificateRecognitionPolicyStatus.ACTIVE) {
        assertStandardIsCredential(standard.kind);
        // §7.1:DRAFT / INACTIVE 的 Standard 不可用于 Policy 激活。
        assertStandardIsActive(standard.status as never);
        assertValidityCombination(locked.validityMode, locked.validityMonths);
        assertIssuerCountMatchesPolicy(locked.issuerPolicy, issuers.length);

        // 原子退役当前 ACTIVE(§13.2:不让客户端分两步操作)。
        // 只会命中 0 或 1 行 —— partial unique 保证了至多一个 ACTIVE。
        //
        // 评审 findings F5(R8):退役前先把「被顶掉的是哪一版」读出来。
        // 修复前这一步只有一条 `updateMany`,审计里完全看不出激活 v3 的同时
        // 退役了 v2 —— 而「上一版是什么时候、被哪次激活顶掉的」正是事后复原
        // 「这张证书当时按哪版规则认定」的关键线索。
        const superseded = await tx.certificateRecognitionPolicy.findFirst({
          where: notDeletedWhere({
            standardId: locked.standardId,
            status: CertificateRecognitionPolicyStatus.ACTIVE,
          }),
          select: { id: true, version: true },
        });
        supersededPolicy = superseded;
        await tx.certificateRecognitionPolicy.updateMany({
          where: { standardId: locked.standardId, status: 'ACTIVE', deletedAt: null },
          data: { status: CertificateRecognitionPolicyStatus.RETIRED, retiredAt: now },
        });
      }

      let updated;
      try {
        updated = await tx.certificateRecognitionPolicy.update({
          where: { id },
          data: {
            status: dto.status,
            ...(dto.status === CertificateRecognitionPolicyStatus.ACTIVE
              ? { activatedAt: now }
              : { retiredAt: now }),
          },
          select: this.policySelect,
        });
      } catch (err) {
        this.mapPolicyP2002(err);
      }

      await this.audit.recordPolicyChange({
        currentUser: user,
        meta,
        policyId: id,
        operation:
          dto.status === CertificateRecognitionPolicyStatus.ACTIVE
            ? 'activate-policy'
            : 'retire-policy',
        before: this.audit.toPolicySnapshot(
          locked,
          issuers.map((i) => i.name),
        ),
        after: this.audit.toPolicySnapshot(
          updated,
          issuers.map((i) => i.name),
        ),
        supersededPolicy,
        tx,
      });

      return this.toResponseDto(updated, issuers);
    });
  }

  // ============ softDelete(仅 DRAFT)============

  // ACTIVE / RETIRED 不可删(§7.2:它们可能被 pending Certificate 与 APPROVED Claim
  // 锁定引用,D-CERT-008)。DRAFT 从未生效过,删掉不影响任何历史事实。
  async softDelete(user: CurrentUserPayload, id: string, meta: AuditMeta): Promise<void> {
    await this.assertCanOrThrow(user, 'certificate-recognition-policy.delete.record');
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.findPolicyOrThrow(tx, id);
      await this.lockStandardOrThrow(tx, existing.standardId);
      const locked = await this.findPolicyOrThrow(tx, id);
      assertPolicyIsDraft(locked.status);

      const issuers = await this.loadIssuers(tx, id);
      const now = new Date();

      // 一并软删其 issuer 行:留着未软删的 issuer 会继续占用
      // (policyId, normalizedName) 的 partial unique 名额。
      await tx.certificateRecognitionIssuer.updateMany({
        where: { policyId: id, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.certificateRecognitionPolicy.update({ where: { id }, data: { deletedAt: now } });

      await this.audit.recordPolicyChange({
        currentUser: user,
        meta,
        policyId: id,
        operation: 'delete',
        before: this.audit.toPolicySnapshot(
          locked,
          issuers.map((i) => i.name),
        ),
        tx,
      });
    });
  }
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type {
  ServicePrincipalCredentialCreatedDto,
  ServicePrincipalCredentialResponseDto,
  ServicePrincipalResponseDto,
} from './service-principals.dto';

type PrismaTx = Prisma.TransactionClient;

/**
 * Integration Foundation v1 PR2(P1-30;规格书 §12/§27/§28/§35):ServicePrincipal 控制面。
 *
 * ⭐ 密钥纪律(规格书 §12.1,逐条):
 *   - 原始 Secret = `crypto.randomBytes(32).toString('base64url')`,**只在创建响应里出现一次**;
 *   - 库里只存 SHA-256 hash(高熵随机 ⇒ 不用 bcrypt;规格书明文);
 *   - 常数时间比较(供 PR3 的 token 交换复用,本刀暴露为静态方法);
 *   - clientId 服务端生成、前缀 `srvf_sp_`、永不复用(软删后仍占唯一约束)。
 *
 * ⭐ 同 SP ≤2 条 ACTIVE 未过期凭证(§28):**锁主体后再数**(SELECT ... FOR UPDATE 序列化),
 *   不是跨行 DB CHECK。
 *
 * 审计:每操作一条,事件 `service-principal.*`(规格书 §24);extra 不带任何 hash/secret。
 */
@Injectable()
export class ServicePrincipalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ===== 静态原语(PR3 token 交换复用;不挂实例状态)=====

  static generateClientId(): string {
    return `srvf_sp_${randomBytes(12).toString('base64url')}`;
  }

  static generateClientSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  static hashClientSecret(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  /** 常数时间比较(§12.1;防 timing 侧信道)。 */
  static secretsMatch(a: string, b: string): boolean {
    const ha = createHash('sha256').update(a, 'utf8').digest();
    const hb = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(ha, hb);
  }

  // ===== CRUD =====

  async create(
    dto: { name: string; description?: string | null; ownerOrganizationId?: string | null },
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ServicePrincipalResponseDto> {
    const created = await this.prisma.$transaction(async (tx) => {
      if (dto.ownerOrganizationId != null) {
        await this.assertOrganizationExists(tx, dto.ownerOrganizationId);
      }
      const sp = await tx.servicePrincipal.create({
        data: {
          clientId: ServicePrincipalsService.generateClientId(),
          name: dto.name,
          description: dto.description ?? null,
          status: 'ACTIVE',
          ownerOrganizationId: dto.ownerOrganizationId ?? null,
          createdByUserId: currentUser.id,
        },
      });
      await this.audit(tx, 'service-principal.create', sp.id, currentUser, auditMeta, {
        clientId: sp.clientId,
        name: sp.name,
      });
      return sp;
    });
    return this.present(created);
  }

  async list(query: { status?: 'ACTIVE' | 'SUSPENDED'; page: number; pageSize: number }): Promise<{
    items: ServicePrincipalResponseDto[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where: Prisma.ServicePrincipalWhereInput = {
      deletedAt: null,
      ...(query.status !== undefined ? { status: query.status } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.servicePrincipal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.servicePrincipal.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.present(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findById(id: string): Promise<ServicePrincipalResponseDto> {
    return this.present(await this.findOrThrow(this.prisma, id));
  }

  async update(
    id: string,
    dto: { name?: string; description?: string | null; ownerOrganizationId?: string | null },
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ServicePrincipalResponseDto> {
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.findOrThrow(tx, id, { forUpdate: true });
      if (dto.ownerOrganizationId != null) {
        await this.assertOrganizationExists(tx, dto.ownerOrganizationId);
      }
      const sp = await tx.servicePrincipal.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.ownerOrganizationId !== undefined
            ? { ownerOrganizationId: dto.ownerOrganizationId }
            : {}),
        },
      });
      await this.audit(tx, 'service-principal.update', id, currentUser, auditMeta, {
        fields: Object.keys(dto),
      });
      return sp;
    });
    return this.present(updated);
  }

  async updateStatus(
    id: string,
    status: 'ACTIVE' | 'SUSPENDED',
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ServicePrincipalResponseDto> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const sp = await this.findOrThrow(tx, id, { forUpdate: true });
      if (sp.status === status) {
        throw new BizException(BizCode.SERVICE_PRINCIPAL_ALREADY_SUSPENDED_OR_ACTIVE);
      }
      const next = await tx.servicePrincipal.update({ where: { id }, data: { status } });
      await this.audit(tx, 'service-principal.status-change', id, currentUser, auditMeta, {
        from: sp.status,
        to: status,
      });
      return next;
    });
    return this.present(updated);
  }

  // ===== 凭证(§28)=====

  async createCredential(
    servicePrincipalId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ServicePrincipalCredentialCreatedDto> {
    const secret = ServicePrincipalsService.generateClientSecret();
    const secretHash = ServicePrincipalsService.hashClientSecret(secret);
    const created = await this.prisma.$transaction(async (tx) => {
      // 锁主体后再数(§28:并发突破 ≤2 上限的唯一防线就是这把行锁)。
      await this.findOrThrow(tx, servicePrincipalId, { forUpdate: true });
      const activeCount = await tx.servicePrincipalCredential.count({
        where: {
          servicePrincipalId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
      if (activeCount >= 2) {
        throw new BizException(BizCode.SERVICE_CREDENTIAL_LIMIT_EXCEEDED);
      }
      const credential = await tx.servicePrincipalCredential.create({
        data: {
          servicePrincipalId,
          secretHash,
          createdByUserId: currentUser.id,
        },
      });
      await this.audit(
        tx,
        'service-principal.credential-create',
        servicePrincipalId,
        currentUser,
        auditMeta,
        {
          credentialId: credential.id,
        },
      );
      return credential;
    });
    // 原始 Secret 只在此处返回(§12.1);audit 里只有 credentialId,零 secret 零 hash。
    return { id: created.id, createdAt: created.createdAt, clientSecret: secret };
  }

  async listCredentials(
    servicePrincipalId: string,
  ): Promise<ServicePrincipalCredentialResponseDto[]> {
    await this.findOrThrow(this.prisma, servicePrincipalId);
    const rows = await this.prisma.servicePrincipalCredential.findMany({
      where: { servicePrincipalId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, expiresAt: true, revokedAt: true, lastUsedAt: true },
    });
    return rows;
  }

  async revokeCredential(
    servicePrincipalId: string,
    credentialId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ServicePrincipalCredentialResponseDto> {
    const revoked = await this.prisma.$transaction(async (tx) => {
      await this.findOrThrow(tx, servicePrincipalId, { forUpdate: true });
      const credential = await tx.servicePrincipalCredential.findFirst({
        where: { id: credentialId, servicePrincipalId },
      });
      if (credential === null) throw new BizException(BizCode.SERVICE_CREDENTIAL_NOT_FOUND);
      if (credential.revokedAt !== null) {
        throw new BizException(BizCode.SERVICE_CREDENTIAL_ALREADY_REVOKED);
      }
      const next = await tx.servicePrincipalCredential.update({
        where: { id: credentialId },
        data: { revokedAt: new Date(), revokedByUserId: currentUser.id },
        select: { id: true, createdAt: true, expiresAt: true, revokedAt: true, lastUsedAt: true },
      });
      await this.audit(
        tx,
        'service-principal.credential-revoke',
        servicePrincipalId,
        currentUser,
        auditMeta,
        {
          credentialId,
        },
      );
      return next;
    });
    return revoked;
  }

  // ===== 内部 =====

  private present(sp: {
    id: string;
    clientId: string;
    name: string;
    description: string | null;
    status: string;
    ownerOrganizationId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ServicePrincipalResponseDto {
    return {
      id: sp.id,
      clientId: sp.clientId,
      name: sp.name,
      description: sp.description,
      status: sp.status,
      ownerOrganizationId: sp.ownerOrganizationId,
      createdAt: sp.createdAt,
      updatedAt: sp.updatedAt,
    };
  }

  private async findOrThrow(client: PrismaTx, id: string, options?: { forUpdate?: boolean }) {
    if (options?.forUpdate === true) {
      const rows = await client.$queryRaw<
        Array<{
          id: string;
          clientId: string;
          name: string;
          description: string | null;
          status: string;
          ownerOrganizationId: string | null;
          createdAt: Date;
          updatedAt: Date;
          deletedAt: Date | null;
        }>
      >`
        SELECT "id", "clientId", "name", "description", "status"::text AS "status",
               "ownerOrganizationId", "createdAt", "updatedAt", "deletedAt"
        FROM "service_principals"
        WHERE "id" = ${id} AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      if (rows[0] === undefined) throw new BizException(BizCode.SERVICE_PRINCIPAL_NOT_FOUND);
      return rows[0];
    }
    const sp = await client.servicePrincipal.findFirst({
      where: { id, deletedAt: null },
    });
    if (sp === null) throw new BizException(BizCode.SERVICE_PRINCIPAL_NOT_FOUND);
    return sp;
  }

  private async assertOrganizationExists(tx: PrismaTx, organizationId: string): Promise<void> {
    // 核谓词(id 主键 + 软删过滤是 Organization 核允许的读法;select id 是核字段)。
    // 判据侧若升级为更严口径,这里应改走 organizations 模块导出的 Query API。
    const org = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, deletedAt: true },
    });
    if (org === null || org.deletedAt !== null) {
      throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    }
  }

  private async audit(
    tx: PrismaTx,
    event: string,
    servicePrincipalId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    extra: Record<string, unknown>,
  ): Promise<void> {
    // 事件名 ∈ {service-principal.create|update|status-change|credential-create|credential-revoke}
    // (规格书 §24 控制面 8 条的前 5 条;后 3 条 delegation-grant.* 归 PR5)。
    // extra 逐字段白名单:**永不**放 secretHash / 原始 Secret(§12.6 红线)。
    await this.auditLogs.log({
      event: event as never, // 事件名 ∈ §24 控制面五条(见调用侧注释);union 扩展在 audit-logs.types 是 PR3 一并
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'service-principal',
      resourceId: servicePrincipalId,
      meta: auditMeta,
      extra,
      tx,
    });
  }
}

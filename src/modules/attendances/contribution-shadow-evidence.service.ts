import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import { ContributionShadowEvidenceQueryService } from './contribution-shadow-evidence.query.service';
import { ContributionShadowEvidencePresenter } from './contribution-shadow-evidence.presenter';
import {
  ContributionShadowEvidenceAuditRecorder,
  type ShadowEvidenceReadOperation,
} from './contribution-shadow-evidence.audit-recorder';

const READ_PERMISSION = 'contribution-shadow.read.evidence';
const READ_TRANSACTION = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  timeout: 5_000,
} as const;

@Injectable()
export class ContributionShadowEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly query: ContributionShadowEvidenceQueryService,
    private readonly presenter: ContributionShadowEvidencePresenter,
    private readonly audit: ContributionShadowEvidenceAuditRecorder,
  ) {}

  private async authorize(tx: Prisma.TransactionClient, user: CurrentUserPayload) {
    const actor = await loadActiveUserIdentityInTx(tx, user.id);
    if (!actor) throw new BizException(BizCode.UNAUTHORIZED);
    if (
      !(await this.rbac.can(actor, READ_PERMISSION, undefined, tx)) ||
      !(await this.rbac.getUserPermissionCodes(actor.id, undefined, tx)).has(READ_PERMISSION)
    )
      throw new BizException(BizCode.FORBIDDEN);
    // SQL locks current Human/role/grant rows and rechecks actual DB time after
    // every wait. It cannot infer a grant from SUPER_ADMIN or a snapshot cache.
    try {
      await tx.$queryRaw`SELECT csd3_authorize_read_fn(${actor.id})::text`;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2010' &&
        (error.meta as { code?: unknown } | undefined)?.code === '42501'
      )
        throw new BizException(BizCode.FORBIDDEN);
      throw error;
    }
    return actor;
  }

  private read<T>(
    user: CurrentUserPayload,
    meta: AuditMeta,
    operation: ShadowEvidenceReadOperation,
    target: { windowId?: string; auditLogId?: string; attemptId?: string },
    work: (tx: Prisma.TransactionClient) => Promise<{ result: T; count: number }>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.authorize(tx, user);
      const { result, count } = await work(tx);
      const actor = await this.authorize(tx, user);
      await this.audit.record(tx, actor, meta, operation, target, count);
      return result;
    }, READ_TRANSACTION);
  }

  listWindows(query: PaginationQueryDto, user: CurrentUserPayload, meta: AuditMeta) {
    const { page, pageSize } = query;
    return this.read(user, meta, 'windows', {}, async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('SRVF:E3-2:observation-window-registration',0))::text`;
      const rows = await this.query.windows(tx, (page - 1) * pageSize, pageSize);
      return {
        result: {
          items: rows.items.map((row) => this.presenter.window(row)),
          total: rows.total,
          page,
          pageSize,
        },
        count: rows.items.length,
      };
    });
  }

  summary(windowId: string, user: CurrentUserPayload, meta: AuditMeta) {
    return this.read(user, meta, 'summary', { windowId }, async (tx) => {
      const window = await this.query.findWindow(tx, windowId);
      if (!window) throw new BizException(BizCode.NOT_FOUND);
      const summary = await this.query.summary(tx, windowId);
      return { result: this.presenter.summary(summary, this.presenter.window(window)), count: 1 };
    });
  }

  listCandidates(
    windowId: string,
    query: PaginationQueryDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ) {
    const { page, pageSize } = query;
    return this.read(user, meta, 'candidates', { windowId }, async (tx) => {
      if (!(await this.query.findWindow(tx, windowId))) throw new BizException(BizCode.NOT_FOUND);
      const rows = await this.query.candidates(tx, windowId, (page - 1) * pageSize, pageSize);
      return {
        result: {
          items: rows.items.map((row) => this.presenter.candidate(row)),
          total: rows.total,
          page,
          pageSize,
        },
        count: rows.items.length,
      };
    });
  }

  candidate(windowId: string, auditLogId: string, user: CurrentUserPayload, meta: AuditMeta) {
    return this.read(user, meta, 'candidate', { windowId, auditLogId }, async (tx) => {
      if (!(await this.query.findWindow(tx, windowId))) throw new BizException(BizCode.NOT_FOUND);
      const rows = await this.query.candidates(tx, windowId, 0, 1, auditLogId);
      if (!rows.items[0]) throw new BizException(BizCode.NOT_FOUND);
      return { result: this.presenter.candidate(rows.items[0]), count: 1 };
    });
  }

  listComparisons(
    windowId: string,
    attemptId: string,
    query: PaginationQueryDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ) {
    const { page, pageSize } = query;
    return this.read(user, meta, 'comparisons', { windowId, attemptId }, async (tx) => {
      if (!(await this.query.findWindow(tx, windowId))) throw new BizException(BizCode.NOT_FOUND);
      const locked = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "ContributionShadowAttemptReceipt"
        WHERE id=${attemptId} AND "windowId"=${windowId} FOR SHARE`;
      if (!locked[0] || !(await this.query.findAttempt(tx, windowId, attemptId)))
        throw new BizException(BizCode.NOT_FOUND);
      const rows = await this.query.comparisons(tx, attemptId, (page - 1) * pageSize, pageSize);
      return {
        result: {
          items: rows.items.map((row) => this.presenter.comparison(row)),
          total: rows.total,
          page,
          pageSize,
        },
        count: rows.items.length,
      };
    });
  }
}

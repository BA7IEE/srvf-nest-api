import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import {
  ParticipationTimeProofPresenter,
  type ParticipationTimeProofResponse,
} from './participation-time-proof.presenter';
import { ParticipationTimeTruthQueryService } from './participation-time-truth-query.service';

const PROOF_READ_ACTION = 'attendance.read.sheet';

export interface ParticipationTimeProofQuery {
  dateFrom: string;
  dateTo: string;
  page: number;
  pageSize: number;
}

export function validateParticipationTimeProofRange(query: ParticipationTimeProofQuery): void {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      throw new BizException(BizCode.ACTIVITY_TIME_PROOF_RANGE_INVALID);
    }
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
      throw new BizException(BizCode.ACTIVITY_TIME_PROOF_RANGE_INVALID);
    }
    return timestamp;
  };
  const from = parse(query.dateFrom);
  const to = parse(query.dateTo);
  const days = (to - from) / (24 * 60 * 60 * 1000) + 1;
  if (
    from > to ||
    days > 366 ||
    !Number.isInteger(query.page) ||
    query.page < 1 ||
    !Number.isInteger(query.pageSize) ||
    query.pageSize < 1 ||
    query.pageSize > 100
  ) {
    throw new BizException(BizCode.ACTIVITY_TIME_PROOF_RANGE_INVALID);
  }
}

@Injectable()
export class ParticipationTimeProofQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly appIdentity: AppIdentityResolver,
    private readonly truth: ParticipationTimeTruthQueryService,
    private readonly presenter: ParticipationTimeProofPresenter,
  ) {}

  async forCurrentMember(
    query: ParticipationTimeProofQuery,
    currentUser: CurrentUserPayload,
  ): Promise<ParticipationTimeProofResponse> {
    validateParticipationTimeProofRange(query);
    return this.prisma.$transaction(
      async (tx) => {
        const access = await this.appIdentity.resolve(currentUser, tx);
        if (!access.canUseApp || !access.member) {
          throw new BizException(BizCode.FORBIDDEN);
        }
        return this.presentInTx(tx, access.member.id, query);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 2_000,
        timeout: 7_000,
      },
    );
  }

  async forAdminMember(
    memberId: string,
    query: ParticipationTimeProofQuery,
    currentUser: CurrentUserPayload,
  ): Promise<ParticipationTimeProofResponse> {
    validateParticipationTimeProofRange(query);
    return this.prisma.$transaction(
      async (tx) => {
        await this.assertCanReadMember(tx, currentUser, memberId);
        const member = await tx.member.findFirst({
          where: { id: memberId, deletedAt: null },
          select: { id: true },
        });
        if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);
        return this.presentInTx(tx, member.id, query);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 2_000,
        timeout: 7_000,
      },
    );
  }

  private async presentInTx(
    tx: Prisma.TransactionClient,
    memberId: string,
    query: ParticipationTimeProofQuery,
  ): Promise<ParticipationTimeProofResponse> {
    try {
      const truth = await this.truth.readMemberTruthInTx(tx, {
        memberId,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
      });
      return this.presenter.present({ memberId, ...query, truth });
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) {
        throw new BizException(BizCode.ACTIVITY_TIME_PROOF_INVALID);
      }
      throw error;
    }
  }

  private async assertCanReadMember(
    tx: Prisma.TransactionClient,
    currentUser: CurrentUserPayload,
    memberId: string,
  ): Promise<void> {
    const decision = await this.authz.explain(
      currentUser,
      PROOF_READ_ACTION,
      { type: 'member', id: memberId },
      tx,
    );
    if (decision.allow) return;
    if (
      decision.reason === 'resource_not_found' &&
      (await this.rbac.can(currentUser, PROOF_READ_ACTION, undefined, tx))
    ) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }
}

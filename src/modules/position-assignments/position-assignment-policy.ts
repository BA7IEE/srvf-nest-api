import { Injectable } from '@nestjs/common';
import { AssignmentStatus, PolicyStatus, Prisma } from '@prisma/client';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { MembershipTermStateMachine } from '../member-departments/membership-term-state-machine';

type PrismaTx = Prisma.TransactionClient;

type PositionPolicyRow = {
  id: string;
  allowMultiple: boolean;
  allowConcurrent: boolean;
  status: PolicyStatus;
};

type RulePolicyRow = {
  id: string;
  required: boolean;
  minCount: number | null;
  maxCount: number | null;
  requireMembership: boolean;
  allowConcurrent: boolean;
  status: PolicyStatus;
};

export type PositionAssignmentPolicyInput = {
  organizationId: string;
  nodeTypeCode: string;
  positionId: string;
  memberId: string;
  now: Date;
};

export type PositionAssignmentPolicyResult = {
  positionId: string | null;
  violations: BizCodeEntry[];
};

// 任命规则的唯一执行点。事务归 PositionAssignmentsService 所有，本 policy 只负责锁、读取与判定：
// - 写路径锁序固定 Member(调用方) → Position → matching PositionRule；锁后再读人数/兼任事实。
// - allowMultiple=false 等价于 position 上限 1；与 rule.maxCount 取更严格的较小上限。
// - allowConcurrent 取 Position && Rule 严格交集；新任职或任一既有任职禁止兼任都拒绝并存。
// - required/minCount 是配置一致性已校验的建议下限。没有补位/合规工作流前不在此阻断撤销、
//   offboard 或任命；本 policy 只执行任命时可安全保证的上限、兼任与归属约束。
@Injectable()
export class PositionAssignmentPolicy {
  async evaluate(
    tx: PrismaTx,
    input: PositionAssignmentPolicyInput,
    options: { lock: boolean },
  ): Promise<PositionAssignmentPolicyResult> {
    const violations: BizCodeEntry[] = [];
    const position = await this.loadPosition(tx, input.positionId, options.lock);
    if (!position) {
      return { positionId: null, violations: [BizCode.POSITION_NOT_FOUND] };
    }

    // INACTIVE position 与无 ACTIVE rule 都表示“不可新任命”；不追溯撤销既有 assignment。
    if (position.status !== PolicyStatus.ACTIVE) {
      return {
        positionId: position.id,
        violations: [BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED],
      };
    }

    const rule = await this.loadRule(tx, input.nodeTypeCode, position.id, options.lock);
    if (!rule || rule.status !== PolicyStatus.ACTIVE) {
      return {
        positionId: position.id,
        violations: [BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED],
      };
    }

    if (rule.requireMembership) {
      const ancestorRows = await tx.organizationClosure.findMany({
        where: { descendantId: input.organizationId },
        select: { ancestorId: true },
      });
      const membership = await tx.memberOrganizationMembership.findFirst({
        where: {
          ...MembershipTermStateMachine.effectiveWhere(input.now),
          memberId: input.memberId,
          organizationId: { in: ancestorRows.map(({ ancestorId }) => ancestorId) },
        },
        select: { id: true },
      });
      if (!membership) violations.push(BizCode.POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED);
    }

    const activeAssignments = await tx.organizationPositionAssignment.findMany({
      where: {
        memberId: input.memberId,
        status: AssignmentStatus.ACTIVE,
        deletedAt: null,
      },
      select: {
        organizationId: true,
        positionId: true,
        organization: { select: { nodeTypeCode: true } },
        position: {
          select: {
            allowConcurrent: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });

    const targetAllowsConcurrent = position.allowConcurrent && rule.allowConcurrent;
    if (activeAssignments.length > 0) {
      let concurrentForbidden = !targetAllowsConcurrent;
      if (!concurrentForbidden) {
        const pairs = [
          ...new Map(
            activeAssignments.map((assignment) => {
              const pair = {
                nodeTypeCode: assignment.organization.nodeTypeCode,
                positionId: assignment.positionId,
              };
              return [this.ruleKey(pair.nodeTypeCode, pair.positionId), pair] as const;
            }),
          ).values(),
        ];
        const existingRules = await tx.organizationPositionRule.findMany({
          where: {
            deletedAt: null,
            OR: pairs,
          },
          select: {
            nodeTypeCode: true,
            positionId: true,
            allowConcurrent: true,
            status: true,
          },
        });
        const ruleByPair = new Map(
          existingRules.map((existingRule) => [
            this.ruleKey(existingRule.nodeTypeCode, existingRule.positionId),
            existingRule,
          ]),
        );
        concurrentForbidden = activeAssignments.some((assignment) => {
          const existingRule = ruleByPair.get(
            this.ruleKey(assignment.organization.nodeTypeCode, assignment.positionId),
          );
          return (
            assignment.position.deletedAt !== null ||
            assignment.position.status !== PolicyStatus.ACTIVE ||
            !assignment.position.allowConcurrent ||
            !existingRule ||
            existingRule.status !== PolicyStatus.ACTIVE ||
            !existingRule.allowConcurrent
          );
        });
      }
      if (concurrentForbidden) {
        violations.push(BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN);
      }
    }

    const duplicate = activeAssignments.some(
      (assignment) =>
        assignment.organizationId === input.organizationId && assignment.positionId === position.id,
    );
    if (duplicate) violations.push(BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS);

    const effectiveMax = position.allowMultiple ? rule.maxCount : Math.min(1, rule.maxCount ?? 1);
    if (!duplicate && effectiveMax !== null) {
      const holderCount = await tx.organizationPositionAssignment.count({
        where: {
          organizationId: input.organizationId,
          positionId: position.id,
          status: AssignmentStatus.ACTIVE,
          deletedAt: null,
        },
      });
      if (holderCount >= effectiveMax) {
        violations.push(BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER);
      }
    }

    return { positionId: position.id, violations };
  }

  private async loadPosition(
    tx: PrismaTx,
    positionId: string,
    lock: boolean,
  ): Promise<PositionPolicyRow | null> {
    if (!lock) {
      return tx.organizationPosition.findFirst({
        where: { id: positionId, deletedAt: null },
        select: {
          id: true,
          allowMultiple: true,
          allowConcurrent: true,
          status: true,
        },
      });
    }
    const rows = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT "id"
        FROM "organization_positions"
        WHERE "id" = ${positionId} AND "deletedAt" IS NULL
        FOR UPDATE
      `,
    );
    if (rows.length === 0) return null;
    return tx.organizationPosition.findFirst({
      where: { id: positionId, deletedAt: null },
      select: {
        id: true,
        allowMultiple: true,
        allowConcurrent: true,
        status: true,
      },
    });
  }

  private async loadRule(
    tx: PrismaTx,
    nodeTypeCode: string,
    positionId: string,
    lock: boolean,
  ): Promise<RulePolicyRow | null> {
    if (!lock) {
      return tx.organizationPositionRule.findFirst({
        where: { nodeTypeCode, positionId, deletedAt: null },
        select: {
          id: true,
          required: true,
          minCount: true,
          maxCount: true,
          requireMembership: true,
          allowConcurrent: true,
          status: true,
        },
      });
    }
    const rows = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT "id"
        FROM "organization_position_rules"
        WHERE "nodeTypeCode" = ${nodeTypeCode}
          AND "positionId" = ${positionId}
          AND "deletedAt" IS NULL
        FOR UPDATE
      `,
    );
    if (rows.length === 0) return null;
    return tx.organizationPositionRule.findFirst({
      where: { nodeTypeCode, positionId, deletedAt: null },
      select: {
        id: true,
        required: true,
        minCount: true,
        maxCount: true,
        requireMembership: true,
        allowConcurrent: true,
        status: true,
      },
    });
  }

  private ruleKey(nodeTypeCode: string, positionId: string): string {
    return `${nodeTypeCode}\u0000${positionId}`;
  }
}

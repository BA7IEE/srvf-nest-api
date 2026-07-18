import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { PositionAssignmentPolicy } from './position-assignment-policy';

const INPUT = {
  organizationId: 'org1',
  nodeTypeCode: 'rescue-team',
  positionId: 'p1',
  memberId: 'm1',
  now: new Date('2026-07-18T00:00:00.000Z'),
};

function makeTx() {
  return {
    organizationPosition: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'p1',
        allowMultiple: true,
        allowConcurrent: true,
        status: 'ACTIVE',
      }),
    },
    organizationPositionRule: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'r1',
        required: false,
        minCount: null,
        maxCount: null,
        requireMembership: false,
        allowConcurrent: true,
        status: 'ACTIVE',
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    organizationClosure: {
      findMany: jest.fn().mockResolvedValue([{ ancestorId: 'org1' }]),
    },
    memberOrganizationMembership: {
      findFirst: jest.fn().mockResolvedValue({ id: 'membership1' }),
    },
    organizationPositionAssignment: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
}

const evaluate = (tx: ReturnType<typeof makeTx>) =>
  new PositionAssignmentPolicy().evaluate(tx as unknown as Prisma.TransactionClient, INPUT, {
    lock: false,
  });

const violationCodes = (result: Awaited<ReturnType<typeof evaluate>>) =>
  result.violations.map(({ code }) => code);

describe('PositionAssignmentPolicy', () => {
  it('INACTIVE position 不可新任命', async () => {
    const tx = makeTx();
    tx.organizationPosition.findFirst.mockResolvedValue({
      id: 'p1',
      allowMultiple: true,
      allowConcurrent: true,
      status: 'INACTIVE',
    });

    const result = await evaluate(tx);

    expect(violationCodes(result)).toEqual([BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED.code]);
    expect(tx.organizationPositionRule.findFirst).not.toHaveBeenCalled();
  });

  it('INACTIVE rule 不可新任命', async () => {
    const tx = makeTx();
    tx.organizationPositionRule.findFirst.mockResolvedValue({
      id: 'r1',
      required: false,
      minCount: null,
      maxCount: null,
      requireMembership: false,
      allowConcurrent: true,
      status: 'INACTIVE',
    });

    const result = await evaluate(tx);

    expect(violationCodes(result)).toEqual([BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED.code]);
  });

  it('requireMembership 按本组织+祖先的当前有效任期口径执行', async () => {
    const tx = makeTx();
    tx.organizationPositionRule.findFirst.mockResolvedValue({
      id: 'r1',
      required: false,
      minCount: null,
      maxCount: null,
      requireMembership: true,
      allowConcurrent: true,
      status: 'ACTIVE',
    });
    tx.organizationClosure.findMany.mockResolvedValue([
      { ancestorId: 'org1' },
      { ancestorId: 'parent1' },
    ]);
    tx.memberOrganizationMembership.findFirst.mockResolvedValue(null);

    const result = await evaluate(tx);

    expect(violationCodes(result)).toContain(BizCode.POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED.code);
    expect(tx.memberOrganizationMembership.findFirst).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        startedAt: { lte: INPUT.now },
        endedAt: null,
        memberId: INPUT.memberId,
        organizationId: { in: ['org1', 'parent1'] },
      },
      select: { id: true },
    });
  });

  // 杀死“只执行 allowMultiple、忽略 rule.maxCount”的变异。
  it('allowMultiple=true 仍执行 rule.maxCount 上限', async () => {
    const tx = makeTx();
    tx.organizationPositionRule.findFirst.mockResolvedValue({
      id: 'r1',
      required: false,
      minCount: null,
      maxCount: 2,
      requireMembership: false,
      allowConcurrent: true,
      status: 'ACTIVE',
    });
    tx.organizationPositionAssignment.count.mockResolvedValue(2);

    const result = await evaluate(tx);

    expect(violationCodes(result)).toContain(BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER.code);
  });

  // 杀死“rule.maxCount 放宽 Position.allowMultiple=false”的变异。
  it('allowMultiple=false 与 rule.maxCount=6 冲突时仍取上限 1', async () => {
    const tx = makeTx();
    tx.organizationPosition.findFirst.mockResolvedValue({
      id: 'p1',
      allowMultiple: false,
      allowConcurrent: true,
      status: 'ACTIVE',
    });
    tx.organizationPositionRule.findFirst.mockResolvedValue({
      id: 'r1',
      required: false,
      minCount: null,
      maxCount: 6,
      requireMembership: false,
      allowConcurrent: true,
      status: 'ACTIVE',
    });
    tx.organizationPositionAssignment.count.mockResolvedValue(1);

    const result = await evaluate(tx);

    expect(violationCodes(result)).toContain(BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER.code);
  });

  // 杀死“上限判定使用 > 而非 >=”的变异。
  it('maxCount=0 表示禁止新任命', async () => {
    const tx = makeTx();
    tx.organizationPositionRule.findFirst.mockResolvedValue({
      id: 'r1',
      required: false,
      minCount: null,
      maxCount: 0,
      requireMembership: false,
      allowConcurrent: true,
      status: 'ACTIVE',
    });

    const result = await evaluate(tx);

    expect(violationCodes(result)).toContain(BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER.code);
  });

  // 杀死“只看 Position.allowConcurrent、忽略目标 Rule”的变异。
  it('目标 rule.allowConcurrent=false 与 position=true 冲突时拒绝兼任', async () => {
    const tx = makeTx();
    tx.organizationPositionRule.findFirst.mockResolvedValue({
      id: 'r1',
      required: false,
      minCount: null,
      maxCount: null,
      requireMembership: false,
      allowConcurrent: false,
      status: 'ACTIVE',
    });
    tx.organizationPositionAssignment.findMany.mockResolvedValue([
      {
        organizationId: 'org-existing',
        positionId: 'p-existing',
        organization: { nodeTypeCode: 'rescue-team' },
        position: { allowConcurrent: true, status: 'ACTIVE', deletedAt: null },
      },
    ]);

    const result = await evaluate(tx);

    expect(violationCodes(result)).toContain(BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN.code);
  });

  // 杀死“只看新任职、忽略已有任职限制”的变异。
  it('已有 rule.allowConcurrent=false 时也拒绝新的 permissive 任职', async () => {
    const tx = makeTx();
    tx.organizationPositionAssignment.findMany.mockResolvedValue([
      {
        organizationId: 'org-existing',
        positionId: 'p-existing',
        organization: { nodeTypeCode: 'rescue-team' },
        position: { allowConcurrent: true, status: 'ACTIVE', deletedAt: null },
      },
    ]);
    tx.organizationPositionRule.findMany.mockResolvedValue([
      {
        nodeTypeCode: 'rescue-team',
        positionId: 'p-existing',
        allowConcurrent: false,
        status: 'ACTIVE',
      },
    ]);

    const result = await evaluate(tx);

    expect(violationCodes(result)).toContain(BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN.code);
  });

  // 杀死“既有任职配置停用/软删后被扩成全局兼任禁令”的变异。
  it('既有 Position/Rule 已停用或软删但 allowConcurrent=true 时仍允许新兼任', async () => {
    const tx = makeTx();
    tx.organizationPositionAssignment.findMany.mockResolvedValue([
      {
        organizationId: 'org-existing',
        positionId: 'p-existing',
        organization: { nodeTypeCode: 'rescue-team' },
        position: {
          allowConcurrent: true,
          status: 'INACTIVE',
          deletedAt: new Date('2026-07-18T00:00:00.000Z'),
        },
      },
    ]);
    tx.organizationPositionRule.findMany.mockResolvedValue([
      {
        nodeTypeCode: 'rescue-team',
        positionId: 'p-existing',
        allowConcurrent: true,
        status: 'INACTIVE',
        deletedAt: new Date('2026-07-18T00:00:00.000Z'),
      },
    ]);

    const result = await evaluate(tx);

    expect(violationCodes(result)).not.toContain(
      BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN.code,
    );
    expect(tx.organizationPositionRule.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ nodeTypeCode: 'rescue-team', positionId: 'p-existing' }],
      },
      select: {
        nodeTypeCode: true,
        positionId: true,
        allowConcurrent: true,
      },
    });
  });

  it('既有任职 matching Rule 真缺失时继续 fail-close', async () => {
    const tx = makeTx();
    tx.organizationPositionAssignment.findMany.mockResolvedValue([
      {
        organizationId: 'org-existing',
        positionId: 'p-existing',
        organization: { nodeTypeCode: 'rescue-team' },
        position: { allowConcurrent: true, status: 'ACTIVE', deletedAt: null },
      },
    ]);
    tx.organizationPositionRule.findMany.mockResolvedValue([]);

    const result = await evaluate(tx);

    expect(violationCodes(result)).toContain(BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN.code);
  });
});

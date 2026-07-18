import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { RbacService } from '../permissions/rbac.service';
import { PositionRulesService } from './position-rules.service';
import { PositionsService } from './positions.service';

// 终态 scoped-authz PR3 service-level characterization spec(纯构造器注入 mock,不连库、不起 Nest)。
// 锁定本刀关键契约(DB 唯一约束 / 字典校验属 DB 层,由 migration 重放 + e2e 兜底):
//   PositionsService:create P2002 → POSITION_CODE_DUPLICATE;update / softDelete 找不到 → POSITION_NOT_FOUND;
//     **删除守卫**:职务被未软删规则引用(count>0)→ POSITION_IN_USE;无引用 → 写 deletedAt。
//   PositionRulesService:create 校验 nodeType 字典有效 + positionId 存在;P2002 → POSITION_RULE_ALREADY_EXISTS;
//     required/min/max 基数语义一致;update / softDelete 找不到 → POSITION_RULE_NOT_FOUND。
// 边界:rbac.can 恒 true(判权归 e2e)。

const USER: CurrentUserPayload = {
  id: 'u1',
  username: 'admin',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: null,
};

const realP2002 = new Prisma.PrismaClientKnownRequestError('unique', {
  code: 'P2002',
  clientVersion: 'test',
});

type CallArg = { where?: Record<string, unknown>; data?: Record<string, unknown> };
const arg0 = (m: jest.Mock): CallArg => (m.mock.calls as unknown[][])[0]?.[0] ?? {};

function makeTx() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'r1' }]),
    organizationPosition: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'p1' }),
      update: jest.fn().mockResolvedValue({ id: 'p1' }),
    },
    organizationPositionRule: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'r1' }),
      update: jest.fn().mockResolvedValue({ id: 'r1' }),
    },
    dictItem: { findFirst: jest.fn().mockResolvedValue({ id: 'dt1' }) },
  };
}

function makePrisma(tx: ReturnType<typeof makeTx>): PrismaService {
  const $transaction = jest.fn((cb: unknown) =>
    typeof cb === 'function'
      ? (cb as (t: unknown) => Promise<unknown>)(tx)
      : Promise.all(cb as Promise<unknown>[]),
  );
  return {
    $transaction,
    organizationPosition: tx.organizationPosition,
    organizationPositionRule: tx.organizationPositionRule,
    dictItem: tx.dictItem,
  } as unknown as PrismaService;
}

const rbacAllow = { can: jest.fn().mockResolvedValue(true) } as unknown as RbacService;

describe('PositionsService', () => {
  it('create 透传 code / name / categoryCode', async () => {
    const tx = makeTx();
    const svc = new PositionsService(makePrisma(tx), rbacAllow);
    await svc.create(USER, { code: 'team-leader', name: '队长', categoryCode: 'LEADER' });
    const data = arg0(tx.organizationPosition.create).data ?? {};
    expect(data.code).toBe('team-leader');
    expect(data.name).toBe('队长');
    expect(data.categoryCode).toBe('LEADER');
  });

  it('create 撞 P2002 → POSITION_CODE_DUPLICATE', async () => {
    const tx = makeTx();
    tx.organizationPosition.create.mockRejectedValue(realP2002);
    const svc = new PositionsService(makePrisma(tx), rbacAllow);
    await expect(
      svc.create(USER, { code: 'dup', name: 'x', categoryCode: 'LEADER' }),
    ).rejects.toEqual(new BizException(BizCode.POSITION_CODE_DUPLICATE));
  });

  it('update 找不到 → POSITION_NOT_FOUND', async () => {
    const svc = new PositionsService(makePrisma(makeTx()), rbacAllow);
    await expect(svc.update(USER, 'nope', { name: 'x' })).rejects.toEqual(
      new BizException(BizCode.POSITION_NOT_FOUND),
    );
  });

  it('softDelete 删除守卫:职务被未软删规则引用(count>0)→ POSITION_IN_USE', async () => {
    const tx = makeTx();
    tx.organizationPosition.findFirst.mockResolvedValue({ id: 'p1' });
    tx.organizationPositionRule.count.mockResolvedValue(2);
    const svc = new PositionsService(makePrisma(tx), rbacAllow);
    await expect(svc.softDelete(USER, 'p1')).rejects.toEqual(
      new BizException(BizCode.POSITION_IN_USE),
    );
    // 守卫命中时不得写 deletedAt
    expect(tx.organizationPosition.update).not.toHaveBeenCalled();
    // 守卫按未软删规则计数(deletedAt=null)
    const where = arg0(tx.organizationPositionRule.count).where ?? {};
    expect(where.positionId).toBe('p1');
    expect(where.deletedAt).toBeNull();
  });

  it('softDelete 无引用 → 写 deletedAt(软删)', async () => {
    const tx = makeTx();
    tx.organizationPosition.findFirst.mockResolvedValue({ id: 'p1' });
    tx.organizationPositionRule.count.mockResolvedValue(0);
    const svc = new PositionsService(makePrisma(tx), rbacAllow);
    await svc.softDelete(USER, 'p1');
    const data = arg0(tx.organizationPosition.update).data ?? {};
    expect(data.deletedAt).toBeInstanceOf(Date);
  });

  it('softDelete 职务不存在 → POSITION_NOT_FOUND', async () => {
    const svc = new PositionsService(makePrisma(makeTx()), rbacAllow);
    await expect(svc.softDelete(USER, 'nope')).rejects.toEqual(
      new BizException(BizCode.POSITION_NOT_FOUND),
    );
  });
});

describe('PositionRulesService', () => {
  it('create nodeTypeCode 非有效字典项 → POSITION_RULE_NODE_TYPE_INVALID', async () => {
    const tx = makeTx();
    tx.dictItem.findFirst.mockResolvedValue(null); // node_type 无此项
    const svc = new PositionRulesService(makePrisma(tx), rbacAllow);
    await expect(svc.create(USER, { nodeTypeCode: 'bad-node', positionId: 'p1' })).rejects.toEqual(
      new BizException(BizCode.POSITION_RULE_NODE_TYPE_INVALID),
    );
  });

  it('create positionId 不存在 → POSITION_NOT_FOUND', async () => {
    const tx = makeTx();
    tx.dictItem.findFirst.mockResolvedValue({ id: 'dt1' });
    tx.organizationPosition.findFirst.mockResolvedValue(null); // 职务不存在
    const svc = new PositionRulesService(makePrisma(tx), rbacAllow);
    await expect(
      svc.create(USER, { nodeTypeCode: 'rescue-team', positionId: 'nope' }),
    ).rejects.toEqual(new BizException(BizCode.POSITION_NOT_FOUND));
  });

  it('create 透传 nodeTypeCode / positionId(校验通过)', async () => {
    const tx = makeTx();
    tx.dictItem.findFirst.mockResolvedValue({ id: 'dt1' });
    tx.organizationPosition.findFirst.mockResolvedValue({ id: 'p1' });
    const svc = new PositionRulesService(makePrisma(tx), rbacAllow);
    await svc.create(USER, { nodeTypeCode: 'rescue-team', positionId: 'p1' });
    const data = arg0(tx.organizationPositionRule.create).data ?? {};
    expect(data.nodeTypeCode).toBe('rescue-team');
    expect(data.positionId).toBe('p1');
  });

  it('create 透传一致的 required/minCount/maxCount 配置', async () => {
    const tx = makeTx();
    tx.organizationPosition.findFirst.mockResolvedValue({ id: 'p1' });
    const svc = new PositionRulesService(makePrisma(tx), rbacAllow);

    await svc.create(USER, {
      nodeTypeCode: 'rescue-team',
      positionId: 'p1',
      required: true,
      minCount: 2,
      maxCount: 3,
    });

    const data = arg0(tx.organizationPositionRule.create).data ?? {};
    expect(data.required).toBe(true);
    expect(data.minCount).toBe(2);
    expect(data.maxCount).toBe(3);
  });

  // 杀死“仅依赖 DTO @Min、service 接受负数”的变异(内部调用同样守住)。
  it('create 拒绝负数 minCount/maxCount', async () => {
    const tx = makeTx();
    tx.organizationPosition.findFirst.mockResolvedValue({ id: 'p1' });
    const svc = new PositionRulesService(makePrisma(tx), rbacAllow);

    await expect(
      svc.create(USER, {
        nodeTypeCode: 'rescue-team',
        positionId: 'p1',
        minCount: -1,
      }),
    ).rejects.toEqual(new BizException(BizCode.BAD_REQUEST));
    await expect(
      svc.create(USER, {
        nodeTypeCode: 'rescue-team',
        positionId: 'p1',
        maxCount: -1,
      }),
    ).rejects.toEqual(new BizException(BizCode.BAD_REQUEST));
    expect(tx.organizationPositionRule.create).not.toHaveBeenCalled();
  });

  // 杀死“required=false 与正 minCount 冲突仍入库”的变异。
  it('create 拒绝 required=false 但 minCount>0', async () => {
    const tx = makeTx();
    tx.organizationPosition.findFirst.mockResolvedValue({ id: 'p1' });
    const svc = new PositionRulesService(makePrisma(tx), rbacAllow);

    await expect(
      svc.create(USER, {
        nodeTypeCode: 'rescue-team',
        positionId: 'p1',
        required: false,
        minCount: 1,
      }),
    ).rejects.toEqual(new BizException(BizCode.BAD_REQUEST));
  });

  it('create 拒绝 required=true 但 minCount=0', async () => {
    const tx = makeTx();
    tx.organizationPosition.findFirst.mockResolvedValue({ id: 'p1' });
    const svc = new PositionRulesService(makePrisma(tx), rbacAllow);

    await expect(
      svc.create(USER, {
        nodeTypeCode: 'rescue-team',
        positionId: 'p1',
        required: true,
        minCount: 0,
      }),
    ).rejects.toEqual(new BizException(BizCode.BAD_REQUEST));
  });

  // 杀死“未比较建议下限与硬上限”的变异。
  it('create 拒绝 minCount>maxCount', async () => {
    const tx = makeTx();
    tx.organizationPosition.findFirst.mockResolvedValue({ id: 'p1' });
    const svc = new PositionRulesService(makePrisma(tx), rbacAllow);

    await expect(
      svc.create(USER, {
        nodeTypeCode: 'rescue-team',
        positionId: 'p1',
        required: true,
        minCount: 2,
        maxCount: 1,
      }),
    ).rejects.toEqual(new BizException(BizCode.BAD_REQUEST));
  });

  it('create 撞 P2002 → POSITION_RULE_ALREADY_EXISTS', async () => {
    const tx = makeTx();
    tx.dictItem.findFirst.mockResolvedValue({ id: 'dt1' });
    tx.organizationPosition.findFirst.mockResolvedValue({ id: 'p1' });
    tx.organizationPositionRule.create.mockRejectedValue(realP2002);
    const svc = new PositionRulesService(makePrisma(tx), rbacAllow);
    await expect(
      svc.create(USER, { nodeTypeCode: 'rescue-team', positionId: 'p1' }),
    ).rejects.toEqual(new BizException(BizCode.POSITION_RULE_ALREADY_EXISTS));
  });

  it('update 找不到 → POSITION_RULE_NOT_FOUND', async () => {
    const svc = new PositionRulesService(makePrisma(makeTx()), rbacAllow);
    await expect(svc.update(USER, 'nope', { required: true })).rejects.toEqual(
      new BizException(BizCode.POSITION_RULE_NOT_FOUND),
    );
  });

  // 杀死“update 只验证 DTO 局部字段、不与已有配置合并”的变异。
  it('update 合并已有基数后拒绝新 maxCount 低于 minCount', async () => {
    const tx = makeTx();
    tx.organizationPositionRule.findFirst.mockResolvedValue({
      id: 'r1',
      required: true,
      minCount: 2,
      maxCount: 3,
    });
    const svc = new PositionRulesService(makePrisma(tx), rbacAllow);

    await expect(svc.update(USER, 'r1', { maxCount: 1 })).rejects.toEqual(
      new BizException(BizCode.BAD_REQUEST),
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.organizationPositionRule.update).not.toHaveBeenCalled();
  });

  it('update required=false 时必须同时清空原有正 minCount', async () => {
    const tx = makeTx();
    tx.organizationPositionRule.findFirst.mockResolvedValue({
      id: 'r1',
      required: true,
      minCount: 2,
      maxCount: 3,
    });
    const svc = new PositionRulesService(makePrisma(tx), rbacAllow);

    await expect(svc.update(USER, 'r1', { required: false })).rejects.toEqual(
      new BizException(BizCode.BAD_REQUEST),
    );
    await expect(
      svc.update(USER, 'r1', { required: false, minCount: null }),
    ).resolves.toBeDefined();
  });

  it('softDelete 找不到 → POSITION_RULE_NOT_FOUND', async () => {
    const svc = new PositionRulesService(makePrisma(makeTx()), rbacAllow);
    await expect(svc.softDelete(USER, 'nope')).rejects.toEqual(
      new BizException(BizCode.POSITION_RULE_NOT_FOUND),
    );
  });
});

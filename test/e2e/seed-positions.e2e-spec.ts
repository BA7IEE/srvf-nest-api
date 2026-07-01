import type { INestApplication } from '@nestjs/common';
import { execSync } from 'child_process';
import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// 终态 scoped-authz PR3(2026-07-01;冻结稿 §3.2 / §3.3 / §12 + R4 / R6 / R8):职务定义 seed e2e。
// 沿 seed-rbac.e2e-spec 子进程范式(execSync pnpm tsx prisma/seed.ts)。覆盖:
//   1. seed 6 领导职务(R4;code / categoryCode / allowMultiple / rank 逐条自证;STAFF 留口不 seed)
//   2. seed 30 默认职务规则(§2.2:2 + 4×4 + 6 + 4 + 2)
//   3. R6:rescue-team 同时登记队长 + 部长两套领导称谓(6 条规则)
//   4. R8:headquarters 队长/副队长 requireMembership=false;组级 requireMembership=true
//   5. 幂等:连续两次 seed counts 不变 + updatedAt 未被 bump(diff 空)

interface SeedRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSeed(envOverrides: Record<string, string>): SeedRunResult {
  const envForChild = { ...process.env, ...envOverrides };
  assertTestDatabaseUrl(envForChild.DATABASE_URL);
  try {
    const stdout = execSync('pnpm tsx prisma/seed.ts', {
      env: envForChild,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: e.status ?? -1,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? ''),
    };
  }
}

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_USERNAME: 'pos-seed-su',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
};

// 6 领导职务期望(R4 + goal DoD §3;rank 正职 10 < 副职 20 < 组长 30 < 副组长 40)。
const EXPECTED_POSITIONS = [
  { code: 'team-leader', categoryCode: 'LEADER', rank: 10, allowMultiple: false },
  { code: 'vice-captain', categoryCode: 'DEPUTY', rank: 20, allowMultiple: true },
  { code: 'dept-leader', categoryCode: 'LEADER', rank: 10, allowMultiple: false },
  { code: 'dept-deputy', categoryCode: 'DEPUTY', rank: 20, allowMultiple: true },
  { code: 'group-leader', categoryCode: 'LEADER', rank: 30, allowMultiple: true },
  { code: 'deputy-group-leader', categoryCode: 'DEPUTY', rank: 40, allowMultiple: true },
] as const;

describe('prisma/seed.ts — organization positions + rules', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  it('seed 6 领导职务(字段逐条自证)+ STAFF 留口不 seed', async () => {
    expect(runSeed(SEED_ENV).code).toBe(0);

    const positions = await prisma.organizationPosition.findMany({
      where: { deletedAt: null },
      select: {
        code: true,
        categoryCode: true,
        rank: true,
        isLeadership: true,
        allowMultiple: true,
        allowConcurrent: true,
      },
    });
    expect(positions).toHaveLength(6);

    const byCode = new Map(positions.map((p) => [p.code, p]));
    for (const exp of EXPECTED_POSITIONS) {
      const got = byCode.get(exp.code);
      expect(got).toBeDefined();
      expect(got!.categoryCode).toBe(exp.categoryCode);
      expect(got!.rank).toBe(exp.rank);
      expect(got!.allowMultiple).toBe(exp.allowMultiple);
      expect(got!.isLeadership).toBe(true); // 6 职务均为领导职务
      expect(got!.allowConcurrent).toBe(true); // 赵强兼任 → 全 true
    }
    // STAFF 干事留口不 seed(R4)
    expect(positions.some((p) => p.categoryCode === 'STAFF')).toBe(false);
  });

  it('seed 30 默认职务规则(§2.2:2 + 4×4 + 6 + 4 + 2)', async () => {
    expect(runSeed(SEED_ENV).code).toBe(0);

    const total = await prisma.organizationPositionRule.count({ where: { deletedAt: null } });
    expect(total).toBe(30);

    // 分布自证(volunteer 无规则)
    const rules = await prisma.organizationPositionRule.findMany({
      where: { deletedAt: null },
      select: { nodeTypeCode: true },
    });
    const perNode = new Map<string, number>();
    for (const r of rules) perNode.set(r.nodeTypeCode, (perNode.get(r.nodeTypeCode) ?? 0) + 1);
    expect(perNode.get('headquarters')).toBe(2);
    expect(perNode.get('professional-mountain')).toBe(4);
    expect(perNode.get('professional-water')).toBe(4);
    expect(perNode.get('professional-urban')).toBe(4);
    expect(perNode.get('professional-high')).toBe(4);
    expect(perNode.get('rescue-team')).toBe(6);
    expect(perNode.get('functional-dept')).toBe(4);
    expect(perNode.get('group')).toBe(2);
    expect(perNode.get('volunteer')).toBeUndefined(); // VOL 持有桶,无规则
  });

  it('R6:rescue-team 同时登记 队长 + 部长 两套领导称谓', async () => {
    expect(runSeed(SEED_ENV).code).toBe(0);

    const rules = await prisma.organizationPositionRule.findMany({
      where: { nodeTypeCode: 'rescue-team', deletedAt: null },
      select: { position: { select: { code: true } } },
    });
    const codes = rules.map((r) => r.position.code).sort();
    expect(codes).toEqual(
      [
        'dept-deputy',
        'dept-leader',
        'deputy-group-leader',
        'group-leader',
        'team-leader',
        'vice-captain',
      ].sort(),
    );
  });

  it('R8:headquarters 队长/副队长 requireMembership=false;组级 requireMembership=true', async () => {
    expect(runSeed(SEED_ENV).code).toBe(0);

    const hq = await prisma.organizationPositionRule.findMany({
      where: { nodeTypeCode: 'headquarters', deletedAt: null },
      select: { requireMembership: true },
    });
    expect(hq).toHaveLength(2);
    expect(hq.every((r) => r.requireMembership === false)).toBe(true);

    const grp = await prisma.organizationPositionRule.findMany({
      where: { nodeTypeCode: 'group', deletedAt: null },
      select: { requireMembership: true },
    });
    expect(grp).toHaveLength(2);
    expect(grp.every((r) => r.requireMembership === true)).toBe(true);
  });

  it('幂等:连续两次 seed counts 不变 + updatedAt 未被 bump(diff 空)', async () => {
    expect(runSeed(SEED_ENV).code).toBe(0);
    const posCount1 = await prisma.organizationPosition.count();
    const ruleCount1 = await prisma.organizationPositionRule.count();

    expect(runSeed(SEED_ENV).code).toBe(0);
    expect(await prisma.organizationPosition.count()).toBe(posCount1);
    expect(await prisma.organizationPositionRule.count()).toBe(ruleCount1);

    // update:{} 幂等 → 第二次不 bump updatedAt(updatedAt 恒等于 createdAt = diff 空)
    const positions = await prisma.organizationPosition.findMany({
      select: { createdAt: true, updatedAt: true },
    });
    expect(positions.every((p) => p.updatedAt.getTime() === p.createdAt.getTime())).toBe(true);
    const rules = await prisma.organizationPositionRule.findMany({
      select: { createdAt: true, updatedAt: true },
    });
    expect(rules.every((r) => r.updatedAt.getTime() === r.createdAt.getTime())).toBe(true);
  });
});

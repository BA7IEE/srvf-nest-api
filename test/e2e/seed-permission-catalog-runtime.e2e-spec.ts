import type { INestApplication } from '@nestjs/common';
import { execSync } from 'child_process';
import { PrismaService } from '../../src/database/prisma.service';
import {
  SEED_PERMISSION_CODES,
  SEED_PERMISSION_CODE_SET,
} from '../../src/modules/permissions/seed-permission-codes';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// 权限目录**运行时**闭包判据(P1-32 PR1 DoD 4;2026-08-22)。
//
// ──────────────────────────────────────────────────────────────────────────
// ⚠️ 为什么这条不能用源码扫描代替
//
// #1129 建的 `check-permission-catalog-closure.ts` 断言「各桶并集 == 权限码全集」,
// 两侧读的都是**源码**(运行时导出对象 + typed-AST 静态扫描)。
// 而运行时经 `POST /permissions` / `DELETE /permissions/:id` 往 DB 里增删权限行
// **不改任何源码** ⇒ 那条判据对这种漂移结构性失明,永远全绿。
//
// 「源码侧闭包」与「运行时 DB 与闭包一致」是两件事。本 spec 补的是第二件:
//   空库 → 实跑 `prisma/seed.ts` → 读 `permissions` 表 → 与闭包清单逐条对照。
//
// 它同时是 `seed-permission-codes.ts` 三段钉死链的第 (C) 段:
//   清单 ==(A)== 桶并集 ==(B)== typed-AST 全集 ==(C)== seed 后的 DB 行
// (A)(B) 在 `src/modules/permissions/seed-permission-codes.spec.ts`(单测,不连 DB)。
//
// ──────────────────────────────────────────────────────────────────────────
// 两个方向都查,理由与 #1129 同:
//   (a) 闭包有、DB 没有 → seed 漏 upsert 某个码(护栏管得住、seed 却没建)
//   (b) DB 有、闭包没有 → seed 建了目录外的码(护栏对它失明,且它守不住任何端点)

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

describe('权限目录运行时闭包(seed 后的 DB 必须恰好等于 seed 事实闭包)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dbCodes: string[];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'catalog-runtime-su',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(result.code).toBe(0);

    const rows = await prisma.permission.findMany({ select: { code: true } });
    dbCodes = rows.map((row) => row.code).sort();
  }, 180_000);

  afterAll(async () => {
    await app.close();
  });

  // ===========================================================================
  // 自证:先证明两侧都不是空的,再报数。
  // 空集 == 空集会静默变绿 —— 尤其是 seed 静默失败、resetDb 清完没重建这两种形态。
  // 用地板锚点(≥N),不用「恰 N 条」:后者每加一个权限码都要改判据。
  // ===========================================================================
  it('self-proves both sides are non-empty before comparing', () => {
    expect(SEED_PERMISSION_CODES.length).toBeGreaterThanOrEqual(200);
    expect(dbCodes.length).toBeGreaterThanOrEqual(200);
  });

  it('has every closure code present in the database after seed', () => {
    // (a) 闭包有、DB 没有。
    const dbSet = new Set(dbCodes);
    const missingInDb = SEED_PERMISSION_CODES.filter((code) => !dbSet.has(code));
    expect(missingInDb).toEqual([]);
  });

  it('has no database permission outside the closure after seed', () => {
    // (b) DB 有、闭包没有 —— 这一条才是「运行时漂移」的直接症状:
    // 经 API 凭空造出来的码、或 seed 建了没登记的码,都在这里现形。
    const extraInDb = dbCodes.filter((code) => !SEED_PERMISSION_CODE_SET.has(code));
    expect(extraInDb).toEqual([]);
  });

  it('matches the closure exactly, as an ordered set', () => {
    // 集合两向都查过之后,这条是冗余的 —— 留着是因为它的失败输出最好读:
    // 直接把两个排序后的清单 diff 给人看,不用再从 missing/extra 拼回全貌。
    expect(dbCodes).toEqual([...SEED_PERMISSION_CODES].sort());
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTLEMENT_DRAFT_SYNC_MAX_POPULATION } from './settlement-draft.service';

// ===== 结算草稿生成的**结构判据**(活动改造 v1.1 第 2 批第二刀)=====
//
// 行为判据在 `test/e2e/activity-settlement-draft.e2e-spec.ts`;本文件只钉三件
// 「行为测不出、但一旦破了就会静默出错」的事:
//   1. 活动模块里**不许出现第二套贡献规则查找**(goal 探针 5);
//   2. 活动模块里**不许出现第二套日期换算**(goal 探针 6);
//   3. 同步路径阈值是**具名常量 500**,不是散在代码里的魔法数(goal DoD 7)。
//
// 判据取"整个活动模块目录"而不是单个文件:第二套实现最可能落在**新加的兄弟文件**上,
// 只盯着本刀这两个文件等于没盯。

const MODULE_DIR = __dirname;

// 剥掉整行注释再匹配 —— 说明性注释里本来就写着这些词,对全文匹配会变成永远红的假判据
// (本刀在投影器 spec 上实测栽过一次)。
function readCodeOnly(fileName: string): string {
  return readFileSync(join(MODULE_DIR, fileName), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');
}

function moduleSourceFiles(): string[] {
  return readdirSync(MODULE_DIR).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
  );
}

describe('settlement draft — 结构判据', () => {
  it('反向对照:确实扫到了本刀的两个新文件(否则下面几条是空绿)', () => {
    const files = moduleSourceFiles();
    expect(files).toContain('settlement-draft.service.ts');
    expect(files).toContain('settlement-segment-projector.ts');
    expect(files.length).toBeGreaterThan(10);
  });

  // ===== 探针 5:活动模块内不得出现第二套贡献规则查找 =====
  //
  // 贡献规则的唯一查找入口是 `attendances/contribution-calculator.ts`(它带
  // 「同 pair 重复 ACTIVE 规则 fail-closed」不变量)。活动模块**只许调它**,
  // 不许自己 `prisma.contributionRule.findMany(...)` ——
  // 那样等于把那条不变量复制一份,而复制品迟早漂移。
  it('活动模块零处直接查 ContributionRule(唯一查找入口是复用的计算器)', () => {
    const offenders = moduleSourceFiles().filter((fileName) =>
      /\bcontributionRule\b/.test(readCodeOnly(fileName)),
    );
    expect(offenders).toStrictEqual([]);
  });

  it('结算草稿服务确实注入了 attendances 的那个计算器(复用不是重写)', () => {
    const code = readCodeOnly('settlement-draft.service.ts');
    expect(code).toMatch(
      /import \{ ContributionCalculator \} from '\.\.\/attendances\/contribution-calculator'/,
    );
    expect(code).toMatch(/applyContributionRulePrefill\(/);
  });

  // ===== 探针 6:活动模块内不得出现第二套日期换算 =====
  //
  // 北京日界的唯一实现是 `common/datetime/date-only.util.ts`(第一刀已收口)。
  // 本刀的投影器只做毫秒差、不做日历换算,所以整个模块都不该出现下面这些形状。
  it('活动模块零处手写时区换算(toLocaleString / 手写 +8h / Asia/Shanghai)', () => {
    const patterns: Array<[string, RegExp]> = [
      ['toLocaleString', /toLocaleString/],
      ['toLocaleDateString', /toLocaleDateString/],
      ['Asia/Shanghai 字面量', /Asia\/Shanghai/],
      // 手写 +8 小时的三种常见写法。
      ['手写 8 * 3600 * 1000', /8\s*\*\s*3600\s*\*\s*1000/],
      ['手写 8 * 60 * 60 * 1000', /8\s*\*\s*60\s*\*\s*60\s*\*\s*1000/],
      ['手写 28800000', /28800000/],
    ];
    const offenders: string[] = [];
    for (const fileName of moduleSourceFiles()) {
      const code = readCodeOnly(fileName);
      for (const [label, pattern] of patterns) {
        if (pattern.test(code)) offenders.push(`${fileName}: ${label}`);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  // ===== DoD 7:同步路径阈值是具名常量 =====

  it('同步生成上限是具名常量 500,并在注释里指向合同 §5.9', () => {
    expect(SETTLEMENT_DRAFT_SYNC_MAX_POPULATION).toBe(500);
    const source = readFileSync(join(MODULE_DIR, 'settlement-draft.service.ts'), 'utf8');
    expect(source).toMatch(/§5\.9[\s\S]{0,400}SETTLEMENT_DRAFT_SYNC_MAX_POPULATION = 500/);
  });

  // ===== 合同硬约束:本刀零 Punch 写路径 =====
  //
  // 「本批完成前不开放新 Punch 写入口」。行为侧有一条"生成前后事件表逐字不变"的 e2e;
  // 这里补结构侧:活动模块对 `attendancePunchEvent` 只许出现读操作。
  it('活动模块对 AttendancePunchEvent 零写调用(只读)', () => {
    const offenders: string[] = [];
    for (const fileName of moduleSourceFiles()) {
      const code = readCodeOnly(fileName);
      const writeCalls =
        /attendancePunchEvent\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.exec(
          code,
        );
      if (writeCalls !== null) offenders.push(`${fileName}: ${writeCalls[0]}`);
    }
    expect(offenders).toStrictEqual([]);
  });

  // ===== ⭐ 第一红线的结构侧:计划时间不许流进签退时刻 =====
  //
  // 行为侧已有两条 e2e(开放段三列全 null / 换任意 sessionEndAt 产出一字不变)。
  // 这里补一条**读代码就能判**的:全模块不许出现把 checkOutAt 落在任何计划时间上的赋值。
  it('全模块零处把 endAt / checkOutCloseAt / terminationCheckOutDeadline 赋给 checkOutAt', () => {
    const offenders: string[] = [];
    const forbidden =
      /checkOutAt\s*[:=][^,;\n]*\b(endAt|checkOutCloseAt|terminationCheckOutDeadline|sessionEndAt)\b/;
    for (const fileName of moduleSourceFiles()) {
      const code = readCodeOnly(fileName);
      const hit = forbidden.exec(code);
      if (hit !== null) offenders.push(`${fileName}: ${hit[0]}`);
    }
    expect(offenders).toStrictEqual([]);
  });
});

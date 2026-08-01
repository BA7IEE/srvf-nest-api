import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// GPS 审计口径(维护者 2026-08-01 拍板,canonical 见 docs/handoff/miniapp.md「活动 GPS 自助签到/签退」
// 与 docs/handoff/admin-web.md「活动 GPS 打卡 → 考勤草稿」):
//
//   ① 队员自助**签到/签退成功**豁免 AuditLog —— 事实记录就是 `ActivityCheckIn` 行本身
//      (含坐标、精度、距离与时间戳,不可变且已足够复盘);再写一条 audit 只是同一事实的副本。
//   ② **管理端对签到记录的任何修改/删除必须审计** —— 那是人改机器采集的证据,谁改的、改成什么
//      必须留痕。
//
// 本仓当前**不存在**任何管理端 `ActivityCheckIn` 写路径(管理端只经
// `activity-check-in-query.service.ts` 只读),所以 ② 现在没有对象。这条守护就是 ② 的执行位:
// 一旦有人新增第三处写调用(管理端改/删、批量订正、数据修复端点……),本用例立刻红,
// 逼他先决定审计怎么落,而不是默默写进库里。
//
// ⚠️ 把新路径加进 ALLOWED_WRITE_SITES 之前先问:它是不是「队员自助采集证据」?
// 只要是人代为改写,答案就是否 —— 该走 AttendanceAuditRecorder,而不是加白名单。
const WRITE_METHOD_PATTERN =
  /\bactivityCheckIn\s*\.\s*(createMany|create|updateMany|update|upsert|deleteMany|delete)\b/g;

// 允许清单:两处都是 App 队员自助 GPS 证据写(D-GPS fail-closed 后的成功路径)。
const ALLOWED_WRITE_SITES = new Set([
  'modules/attendances/app-activity-check-ins.service.ts::create',
  'modules/attendances/app-activity-check-ins.service.ts::updateMany',
]);

const RAW_SQL_WRITE_PATTERN = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?ActivityCheckIn"?/gi;

const SRC_ROOT = join(__dirname, '..', '..');

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectSourceFiles(full, acc);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    // spec 里的 mock 不是真实写路径。
    if (entry.name.endsWith('.spec.ts')) continue;
    acc.push(full);
  }
  return acc;
}

describe('ActivityCheckIn 审计口径守护', () => {
  const files = collectSourceFiles(SRC_ROOT);

  it('src/ 内没有未登记的 ActivityCheckIn 写路径', () => {
    const found = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const relPath = relative(SRC_ROOT, file).split(sep).join('/');
      for (const match of source.matchAll(WRITE_METHOD_PATTERN)) {
        found.add(`${relPath}::${match[1]}`);
      }
    }

    // 双向断言:既不许新增未登记的写路径,也不许允许清单里的条目悄悄消失后仍留在名单上
    // (陈旧白名单等于没有防线 —— 它会把下一个新增路径当成"本来就有"放行)。
    expect([...found].sort()).toEqual([...ALLOWED_WRITE_SITES].sort());
  });

  it('src/ 内没有绕过 Prisma 的 ActivityCheckIn 裸 SQL 写', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (RAW_SQL_WRITE_PATTERN.test(source)) {
        offenders.push(relative(SRC_ROOT, file).split(sep).join('/'));
      }
      RAW_SQL_WRITE_PATTERN.lastIndex = 0;
    }
    expect(offenders).toEqual([]);
  });
});

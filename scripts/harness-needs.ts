/**
 * harness-needs.ts — 开工前一次性算清「这活儿要哪些授权」(Harness 3.0 P6)
 *
 * 立项证据(实测):2026-07-28/29 通宵推进期间,AI **停下来问授权 6 次** ——
 * 每次都是「写到某个文件才发现是红区」→ 停 → 出简报 → 等维护者跑 grant → 继续。
 * 维护者是这条链上唯一的人类,每一次往返都要他放下手头的事。
 *
 * 根因不是闸门太严,是**发现得太晚**:goal 五要素里本来就有「写集声明」,
 * 但没有工具把「写集」翻译成「要跑哪几条 grant」,于是实际做法退化成边写边撞。
 *
 * 本脚本把 N 次往返压成 1 次:开工前把计划要碰的路径喂进来,它一次性给出
 *   ① 哪些受保护、命中哪条规则、为什么
 *   ② **一条可直接照抄的 grant 命令**(已按最小必要合并,不给多余的 glob)
 *   ③ 哪些不需要授权(免得维护者以为整批都要批)
 *
 * ⚠️ 它**不发放授权**,只做预算。发放仍然只能由维护者本人执行 ——
 *    「AI 不得自行发放授权」是这套设计的地基,不因为便利而松动。
 *
 * 用法:
 *   pnpm harness:needs src/modules/auth/auth.service.ts prisma/schema.prisma
 *   pnpm harness:needs --from-goal docs/goals/xxx.md     # 从 goal 的写集声明里抽路径
 *
 * ⚠️ 本文件在 harness/redzone.json 的 selfGuard 内(`scripts/*.ts` 具名清单)。
 */

import * as fs from 'fs';
import * as path from 'path';
import { judge, type Hit } from './check-redzone';

const ROOT = path.resolve(__dirname, '..');

/**
 * 把命中的路径收敛成**最少的** grant glob。
 *
 * 为什么要收敛:一条 `pnpm harness:grant 'src/modules/auth/**'` 比七条逐文件
 * grant 好按 —— 但**不能**为了少打字就给出 `**` 这种超范围 glob。
 * 折中:同一条红区规则下的多个文件,合并成该规则里**实际命中的那个 glob**;
 * 只命中一个文件时就用文件本身(最小权限优先)。
 */
export function planGrants(hits: readonly Hit[]): Array<{ glob: string; files: string[]; why: string }> {
  const byRule = new Map<string, Hit[]>();
  for (const h of hits) {
    const list = byRule.get(h.id) ?? [];
    list.push(h);
    byRule.set(h.id, list);
  }
  const out: Array<{ glob: string; files: string[]; why: string }> = [];
  for (const [id, list] of byRule) {
    const files = list.map((h) => h.file).sort();
    const why = `${id} — ${list[0].why}`;
    if (files.length === 1) {
      out.push({ glob: files[0], files, why });
      continue;
    }
    const segs = files.map((f) => f.split('/'));
    const common: string[] = [];
    for (let i = 0; i < segs[0].length - 1; i++) {
      const s = segs[0][i];
      if (segs.every((x) => x[i] === s)) common.push(s);
      else break;
    }
    if (common.length > 0) {
      out.push({ glob: `${common.join('/')}/**`, files, why });
    } else {
      // 无公共目录前缀(常见:同属「执法层」但散在 .claude/ scripts/ harness/)。
      // 首版在这里把多个路径**空格拼成一个字符串**当 glob 输出 ——
      // 生成的命令 `harness:grant 'a b c'` 是错的:grant 会把整串当成一个 glob,
      // 谁也匹配不上,而维护者照抄后只会得到「授权了但还是被拦」。
      // 实测于本工具落地当天(#814 合并后第一次真实使用)。
      // 正确做法:逐个出命令。宁可多打几行,也不能给一条跑了没用的命令。
      for (const f of files) out.push({ glob: f, files: [f], why });
    }
  }
  return out;
}

function pathsFromGoal(rel: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  // 写集声明通常是代码块或列表里的路径;宽松抽取「看起来像仓内路径」的 token
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s`'"(])([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*-]+)+)/g)) {
    const p = m[1];
    if (p.startsWith('http')) continue;
    found.add(p);
  }
  return [...found].sort();
}

function main(): void {
  const argv = process.argv.slice(2);
  const goalIdx = argv.indexOf('--from-goal');
  const paths = goalIdx >= 0 ? pathsFromGoal(argv[goalIdx + 1]) : argv.filter((a) => !a.startsWith('--'));

  if (paths.length === 0) {
    console.error('用法:pnpm harness:needs <路径…>  |  pnpm harness:needs --from-goal <goal 文件>');
    process.exit(2);
  }

  const hits: Hit[] = [];
  const free: string[] = [];
  for (const p of paths) {
    // 预算阶段按「文件尚不存在也当作要改」处理 —— archive 的新建豁免留到真写时判,
    // 这里宁可多报一条,也不要让维护者以为不用批、真写时又被拦一次(那就白省了)。
    const h = judge(p, false);
    if (h) hits.push(h);
    else free.push(p);
  }

  console.log(`检查 ${paths.length} 个路径:${hits.length} 个需要授权,${free.length} 个不需要\n`);

  if (free.length > 0) {
    console.log('无需授权(直接写即可):');
    for (const f of free) console.log(`  ${f}`);
    console.log('');
  }

  if (hits.length === 0) {
    console.log('✓ 本次写集不触碰红区与执法层 —— 不需要维护者授权。');
    return;
  }

  const plan = planGrants(hits);
  console.log('需要授权:');
  for (const g of plan) {
    console.log(`  ${g.glob}`);
    for (const f of g.files) console.log(`      ${f}`);
    console.log(`    理由:${g.why.length > 100 ? `${g.why.slice(0, 100)}…` : g.why}`);
  }

  console.log('\n─── 请维护者执行(一次性,不必分批)───');
  const reason = '<拍板出处,例如 goal 名或 PR 链接>';
  for (const g of plan) console.log(`pnpm harness:grant '${g.glob}' --reason "${reason}"`);
  console.log('\n完成后撤销:pnpm harness:grant --clear');
  console.log('\n注:本命令只做预算,**不发放授权** —— 发放只能由维护者本人执行。');
}

if (require.main === module) main();

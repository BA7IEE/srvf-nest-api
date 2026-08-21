import * as fs from 'fs';
import * as path from 'path';
import { assertSeedFactsClosure } from './docs-counts';
import { RBAC_SEED_CATALOG } from '../prisma/seed';

// Harness 3.0 P4a — RBAC_MAP 派生段生成器(镜像反转:AI 生成给人看,不再人写给 AI 读)。
//
// 背景:RBAC_MAP.md 曾是 130KB 手工维护的镜像 —— 每改一次权限就要人肉同步,
// 再靠 496 行 check 脚本检测它有没有漂移。「检测漂移」是在给一个不该存在的问题打补丁:
// 权限事实的权威源本来就是 seed 事实闭包与 controller 装饰器,文档只是它们的视图。
//
// 本脚本把「视图」真正变成生成物:
//   pnpm docs:rbacmap        写入(在 <!-- rbac:begin --> / <!-- rbac:end --> 之间)
//   pnpm docs:rbacmap:check  新鲜度校验(重新生成并比对,不一致即红)
//
// 只生成**纯派生**的两节(权限码全集 / controller × surface);
// 人类知识(保护不变式、缺口与冻结存量、AI 硬规则)在标记之外,生成器不碰。
//
// 权威源:seed 事实闭包(权限码)+ src/**/*.controller.ts(@Controller 前缀)。

const ROOT = path.resolve(__dirname, '..');
const DOC_REL = 'docs/ai-harness/RBAC_MAP.md';
const BEGIN = '<!-- rbac:begin -->';
const END = '<!-- rbac:end -->';

// 闭包必须与 docs-counts.ts / check-rbac-map.ts 逐项一致；selftest 交叉核验三份声明。
export const SEED_FACTS_CLOSURE = Object.freeze([
  'prisma/seed.ts',
  'src/modules/permissions/rbac-seed-facts.ts',
] as const);

// 与 scripts/check-rbac-map.ts 同源(改一处须同步另一处;由 harness-guards.selftest 守护)
const CODE_SHAPE = '[a-z][a-z-]*(?:\\.[a-z-]+)+';
const CANONICAL_PREFIXES = ['admin/v1', 'app/v1', 'auth/v1', 'system/v1', 'open/v1'] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function listControllerFiles(): string[] {
  const out: string[] = [];
  const walk = (dirRel: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dirRel), { withFileTypes: true })) {
      const rel = `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.controller.ts')) out.push(rel);
    }
  };
  walk('src');
  return out.sort();
}

function extractSeedCodes(): string[] {
  assertSeedFactsClosure(SEED_FACTS_CLOSURE);
  const codes = new Set<string>();
  for (const relPath of SEED_FACTS_CLOSURE) {
    const source = read(relPath);
    for (const re of [
      new RegExp(`code:\\s*'(${CODE_SHAPE})'`, 'g'),
      new RegExp(`_CODE\\s*=\\s*'(${CODE_SHAPE})'`, 'g'),
    ]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) codes.add(m[1]);
    }
  }
  return [...codes].sort();
}

interface ControllerDecl {
  readonly relPath: string;
  readonly prefix: string;
}

function extractControllers(files: string[]): ControllerDecl[] {
  const out: ControllerDecl[] = [];
  const re = /^@Controller\(\s*'([^']+)'/gm;
  for (const relPath of files) {
    const source = read(relPath);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.push({ relPath, prefix: m[1] });
  }
  return out.sort((a, b) => a.prefix.localeCompare(b.prefix));
}

function surfaceOf(prefix: string): string {
  const two = prefix.split('/').slice(0, 2).join('/');
  return (CANONICAL_PREFIXES as readonly string[]).includes(two) ? two : `⚠️ 非 canonical(${two})`;
}

function renderPermissionCodes(codes: string[]): string {
  const byDomain = new Map<string, string[]>();
  for (const c of codes) {
    const domain = c.split('.')[0];
    const list = byDomain.get(domain) ?? [];
    list.push(c);
    byDomain.set(domain, list);
  }
  const rows = [...byDomain.entries()]
    .sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]))
    .map(([domain, list]) => `| \`${domain}\` | ${list.length} | ${list.map((c) => `\`${c}\``).join(' · ')} |`);
  return [
    `### 权限码全集(${codes.length} 条,按一级域分组)`,
    '',
    '> 权威源 seed 事实闭包：`prisma/seed.ts`(幂等 upsert) + `src/modules/permissions/rbac-seed-facts.ts`(权限定义)。本表由 `pnpm docs:rbacmap` 生成,**禁手改**。',
    '',
    '| 一级域 | 条数 | 权限码 |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}

// 第七轮评审 R7-D-01:补上「角色 → 权限码」这一维。
//
// 此前 RBAC_MAP 只有「权限码全集」与「controller × surface」两张表 —— 两者都回答
// "有哪些码 / 码挂在哪个路由上",没有一张回答**"这条码谁拿得到"**。于是
// 「码建出来了、端点判着权、却没有任何角色持有它」这一类缺陷在地图上完全不可见
// (实测:6 条 attachment 维护码零持有,组长能传不能改删)。
//
// 本表只做**视图**,不做执法:零持有是否合规由
// `src/modules/permissions/permission-code-holders.spec.ts` 判据裁决。
interface RoleCoverage {
  readonly code: string;
  readonly permissionCodes: readonly string[];
}

function collectRoles(): RoleCoverage[] {
  return Object.values(RBAC_SEED_CATALOG.roles)
    .flatMap((entry): RoleCoverage[] =>
      Array.isArray(entry) ? entry.map((role: RoleCoverage) => role) : [entry as RoleCoverage],
    )
    .sort((a, b) => b.permissionCodes.length - a.permissionCodes.length || a.code.localeCompare(b.code));
}

function renderRoleCoverage(codes: string[], roles: RoleCoverage[]): string {
  const holders = new Map<string, string[]>();
  for (const role of roles) {
    for (const code of role.permissionCodes) {
      const list = holders.get(code) ?? [];
      if (!list.includes(role.code)) list.push(role.code);
      holders.set(code, list);
    }
  }
  const unheld = codes.filter((code) => (holders.get(code) ?? []).length === 0);
  const roleRows = roles.map(
    (role) =>
      `| \`${role.code}\` | ${role.permissionCodes.length} | ${[...role.permissionCodes]
        .sort()
        .map((c) => `\`${c}\``)
        .join(' · ')} |`,
  );
  return [
    `### 角色 → 权限码覆盖(${roles.length} 个内建角色;${codes.length - unheld.length}/${codes.length} 条码有持有人)`,
    '',
    '> 权威源:`prisma/seed.ts` 导出的 `RBAC_SEED_CATALOG.roles`。本表由 `pnpm docs:rbacmap` 生成,**禁手改**。',
    '> 「零持有」= 没有任何内建角色持有该码,只有 SUPER_ADMIN 短路可用;是否合规由',
    '> `src/modules/permissions/permission-code-holders.spec.ts` 判据执法(第七轮评审 R7-D-01),',
    '> 豁免必须显式登记(SA-only 保留码,或"链未接通"且写明到期条件)。',
    '',
    '| 角色 | 持有码数 | 权限码 |',
    '|---|---|---|',
    ...roleRows,
    '',
    `#### 零持有权限码(${unheld.length} 条)`,
    '',
    ...(unheld.length === 0
      ? ['(无 —— 每条权限码都至少有一个内建角色持有)']
      : ['| 权限码 |', '|---|', ...unheld.map((c) => `| \`${c}\` |`)]),
  ].join('\n');
}

function renderControllers(controllers: ControllerDecl[]): string {
  const bySurface = new Map<string, ControllerDecl[]>();
  for (const c of controllers) {
    const s = surfaceOf(c.prefix);
    const list = bySurface.get(s) ?? [];
    list.push(c);
    bySurface.set(s, list);
  }
  const blocks: string[] = [];
  for (const surface of [...bySurface.keys()].sort()) {
    const list = bySurface.get(surface) ?? [];
    blocks.push(
      `#### ${surface}(${list.length} 个 controller)`,
      '',
      '| 路由前缀 | 文件 |',
      '|---|---|',
      ...list.map((c) => `| \`${c.prefix}\` | \`${c.relPath}\` |`),
      '',
    );
  }
  return [
    `### controller × surface 对照(${controllers.length} 个 @Controller)`,
    '',
    '> 权威源:`src/**/*.controller.ts` 的 `@Controller(...)` 装饰器。本表由 `pnpm docs:rbacmap` 生成,**禁手改**。',
    '> 鉴权模式(R / A / P)与业务语义属人类知识,见本文件标记之外的章节。',
    '',
    ...blocks,
  ].join('\n');
}

interface GeneratedRbacBlock {
  readonly content: string;
  readonly permissionCodeCount: number;
  readonly controllerCount: number;
  readonly roleCount: number;
}

function buildBlock(): GeneratedRbacBlock {
  const codes = extractSeedCodes();
  const controllers = extractControllers(listControllerFiles());
  const roles = collectRoles();
  return {
    content: [
      BEGIN,
      '<!-- 由 `pnpm docs:rbacmap` 生成;禁止手改。新鲜度由 `pnpm docs:rbacmap:check` 守护。 -->',
      '',
      '## 派生对照表(生成物)',
      '',
      renderPermissionCodes(codes),
      '',
      renderRoleCoverage(codes, roles),
      '',
      renderControllers(controllers),
      END,
    ].join('\n'),
    permissionCodeCount: codes.length,
    controllerCount: controllers.length,
    roleCount: roles.length,
  };
}

function splice(doc: string, block: string): string {
  const b = doc.indexOf(BEGIN);
  const e = doc.indexOf(END);
  if (b === -1 || e === -1) {
    throw new Error(
      `${DOC_REL} 缺少 ${BEGIN} / ${END} 标记 —— 无法定位生成段。` +
        '首次接入请手工插入这对标记(可为空),再跑 pnpm docs:rbacmap。',
    );
  }
  return doc.slice(0, b) + block + doc.slice(e + END.length);
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  const docPath = path.join(ROOT, DOC_REL);
  const current = read(DOC_REL);
  const generated = buildBlock();
  const next = splice(current, generated.content);

  if (!checkMode) {
    if (next === current) {
      console.log(`✓ ${DOC_REL} 生成段已是最新,无需改动`);
      return;
    }
    fs.writeFileSync(docPath, next);
    console.log(
      `✓ 已重新生成 ${DOC_REL} 的派生段(${generated.permissionCodeCount} 条权限码 / ` +
        `${generated.roleCount} 个内建角色 / ${generated.controllerCount} 个 controller)`,
    );
    return;
  }

  if (next === current) {
    console.log(
      `✓ rbacmap 生成段与代码一致(${generated.permissionCodeCount} 条权限码 / ` +
        `${generated.roleCount} 个内建角色 / ${generated.controllerCount} 个 controller)`,
    );
    return;
  }
  console.error(
    `✗ ${DOC_REL} 的派生段与代码不一致(权限码或 controller 有变动却未重新生成)。\n` +
      `  修复:pnpm docs:rbacmap\n` +
      `  说明:该段是 seed 事实闭包与 @Controller 装饰器的**视图**,不是独立事实源;\n` +
      `       改了权限或路由就该重新生成,而不是手工同步文档。`,
  );
  process.exit(1);
}

if (require.main === module) main();

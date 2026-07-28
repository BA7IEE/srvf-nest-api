import * as fs from 'fs';
import * as path from 'path';

// Harness 3.0 P4a — RBAC_MAP 派生段生成器(镜像反转:AI 生成给人看,不再人写给 AI 读)。
//
// 背景:RBAC_MAP.md 曾是 130KB 手工维护的镜像 —— 每改一次权限就要人肉同步,
// 再靠 496 行 check 脚本检测它有没有漂移。「检测漂移」是在给一个不该存在的问题打补丁:
// 权限事实的权威源本来就是 prisma/seed.ts 与 controller 装饰器,文档只是它们的视图。
//
// 本脚本把「视图」真正变成生成物:
//   pnpm docs:rbacmap        写入(在 <!-- rbac:begin --> / <!-- rbac:end --> 之间)
//   pnpm docs:rbacmap:check  新鲜度校验(重新生成并比对,不一致即红)
//
// 只生成**纯派生**的两节(权限码全集 / controller × surface);
// 人类知识(保护不变式、缺口与冻结存量、AI 硬规则)在标记之外,生成器不碰。
//
// 权威源:prisma/seed.ts(权限码)+ src/**/*.controller.ts(@Controller 前缀)。

const ROOT = path.resolve(__dirname, '..');
const DOC_REL = 'docs/ai-harness/RBAC_MAP.md';
const BEGIN = '<!-- rbac:begin -->';
const END = '<!-- rbac:end -->';

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
  const source = read('prisma/seed.ts');
  const codes = new Set<string>();
  for (const re of [
    new RegExp(`code:\\s*'(${CODE_SHAPE})'`, 'g'),
    new RegExp(`_CODE\\s*=\\s*'(${CODE_SHAPE})'`, 'g'),
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) codes.add(m[1]);
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
    '> 权威源 `prisma/seed.ts`(幂等 upsert)。本表由 `pnpm docs:rbacmap` 生成,**禁手改**。',
    '',
    '| 一级域 | 条数 | 权限码 |',
    '|---|---|---|',
    ...rows,
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

function buildBlock(): string {
  const codes = extractSeedCodes();
  const controllers = extractControllers(listControllerFiles());
  return [
    BEGIN,
    '<!-- 由 `pnpm docs:rbacmap` 生成;禁止手改。新鲜度由 `pnpm docs:rbacmap:check` 守护。 -->',
    '',
    '## 派生对照表(生成物)',
    '',
    renderPermissionCodes(codes),
    '',
    renderControllers(controllers),
    END,
  ].join('\n');
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
  const next = splice(current, buildBlock());

  if (!checkMode) {
    if (next === current) {
      console.log(`✓ ${DOC_REL} 生成段已是最新,无需改动`);
      return;
    }
    fs.writeFileSync(docPath, next);
    console.log(`✓ 已重新生成 ${DOC_REL} 的派生段`);
    return;
  }

  if (next === current) {
    console.log(`✓ rbacmap 生成段与代码一致(权限码 / controller 对照表)`);
    return;
  }
  console.error(
    `✗ ${DOC_REL} 的派生段与代码不一致(权限码或 controller 有变动却未重新生成)。\n` +
      `  修复:pnpm docs:rbacmap\n` +
      `  说明:该段是 prisma/seed.ts 与 @Controller 装饰器的**视图**,不是独立事实源;\n` +
      `       改了权限或路由就该重新生成,而不是手工同步文档。`,
  );
  process.exit(1);
}

main();

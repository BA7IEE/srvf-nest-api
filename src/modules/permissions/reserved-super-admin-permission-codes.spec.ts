import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES,
  RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET,
} from './reserved-super-admin-permission-codes';

// F1(#399):冻结 SA-only 保留码集合。
// 改动本集合是 RBAC 授权事实变更 —— 本测试令任何增删都"显式可见、需同步 seed 与漂移哨兵"。
// 端到端的"集合 ↔ seed 不绑矩阵"一致性由 seed-rbac.e2e-spec.ts 漂移哨兵守。
//
// 🔴 本文件有**两条职责相反**的守护,缺一不可(第六轮评审 E-B1,2026-08-21):
//   ① 「恰 N 条」冻结断言 —— 锁**集合内容**。防有人往里塞不该塞的码,悄悄扩大 SA-only 面
//      (往里加 = 把某个码从 ops-admin 手里收走,是授权事实变更,必须显式)。
//      它的失败信息是"集合不匹配",**永远不会告诉你少了谁** —— 该进没进,它照样绿。
//   ② 「家族全登记」动态判据 —— 锁**该进的都进来了**。防有人漏登记,悄悄打开提权面。
//      E-B1 实测:`wecom-setting.reset.credentials`(企业微信 T2 后加)从未进过保留集 ⇒
//      `isControlPlanePermissionCode()` 放行 ⇒ 持 `rbac.role-permission.create` 的 ops-admin
//      可把它自授给任意角色,再调 POST /system/v1/wecom-settings/reset-credentials 覆盖
//      CorpSecret。① 对此**零反应**,因为它只问"是不是这几条",不问"该有的有没有"。
describe('RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES', () => {
  it('恰为这 7 条 SA-only 保留码(改动需同步 seed 不绑矩阵 + e2e 漂移哨兵)', () => {
    expect([...RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES].sort()).toEqual(
      [
        'member.delete.record',
        'realname-setting.reset.credentials',
        'sms-setting.reset.credentials',
        'storage-setting.reset.credentials',
        'user.update.role',
        'wechat-setting.reset.credentials',
        'wecom-setting.reset.credentials',
      ].sort(),
    );
  });

  it('无重复项', () => {
    expect(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES).toHaveLength(
      new Set(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES).size,
    );
  });

  it('Set 与数组同步,membership 查询正确', () => {
    expect(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.size).toBe(
      RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES.length,
    );
    expect(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has('member.delete.record')).toBe(true);
    expect(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has('member.read.list')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ② 「家族全登记」:全仓每一个 `*.reset.credentials` 权限码都必须在 SA-only 保留集内
// ---------------------------------------------------------------------------
//
// **为什么必须动态扫,不能写死名单**:写死名单就是把 ① 的缺陷复制一份 —— 第六个 provider
// 接进来时,名单和保留集会**一起**漏掉它,两条守护同时变成摆设。扫描面从 src/ + prisma/
// 现取,新 provider 的码一旦以字符串字面量出现在生产代码或 seed 里,就自动进入判定范围。
//
// **扫描面边界**(刻意,不是省事):
//   - 只扫 `src/**` + `prisma/**` 的 `.ts`,与本刀 goal 前提 P2 的口径逐字一致。`test/**`
//     不扫 —— 权限码在 seed 定义、在 src 消费,测试夹具只是消费方,纳进来只会让夹具误红。
//   - 跳过 `.spec.ts` / `.d.ts`,并**剥掉注释**再匹配(沿 clock-authority.spec.ts 同款范式)。
//     两者合起来解决自指:本文件上方注释里写的那些码不会把自己扫进来。
//   - 只认引号包裹的字符串字面量(`'x'` / `"x"`),不认反引号 —— 注释与行文里的
//     `` `x` `` 形态是引用,不是代码。
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCAN_ROOTS = ['src', 'prisma'] as const;

function listScannedTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listScannedTsFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const SCANNED_FILES: ReadonlyArray<{ rel: string; source: string }> = SCAN_ROOTS.flatMap((root) =>
  listScannedTsFiles(join(REPO_ROOT, root)),
)
  .map((full) => ({
    rel: relative(REPO_ROOT, full).split(sep).join('/'),
    source: stripComments(readFileSync(full, 'utf8')),
  }))
  .sort((a, b) => a.rel.localeCompare(b.rel));

// 首段形态沿 D7-RBAC v1.2 的 code 正则 `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`。
const CREDENTIAL_RESET_CODE_RE = /['"]([a-z][a-z0-9-]*\.reset\.credentials)['"]/g;

/** code → 出现该码的仓库相对路径(去重)。失败信息靠它点名"漏的那条在哪"。 */
const CREDENTIAL_RESET_SITES = new Map<string, string[]>();
for (const file of SCANNED_FILES) {
  for (const match of file.source.matchAll(CREDENTIAL_RESET_CODE_RE)) {
    const code = match[1];
    const sites = CREDENTIAL_RESET_SITES.get(code) ?? [];
    if (!sites.includes(file.rel)) sites.push(file.rel);
    CREDENTIAL_RESET_SITES.set(code, sites);
  }
}
const CREDENTIAL_RESET_FAMILY: readonly string[] = [...CREDENTIAL_RESET_SITES.keys()].sort();

describe('`*.reset.credentials` 家族必须全员登记进 SA-only 保留集(第六轮评审 E-B1)', () => {
  // 判据自证:先证明"这次运行真的扫到了东西",再报数。
  // 沿本仓教训:空集 == 空集会静默变绿 —— 扫描器坏掉(路径解析变了 / walker 抛空 /
  // 正则被改窄)时,下面那条断言会因为"没找到任何家族成员"而**全绿**,
  // 恰好在最需要它的时候失效。
  it('判据自证:扫描面非空,且确实读到了 seed 里的家族成员', () => {
    expect(SCANNED_FILES.length).toBeGreaterThan(100);
    // 地板值,不是普查数:家族只增不减,当前 5 个 provider(storage / sms / wechat /
    // realname / wecom)。真跌破 5 说明有 provider 被摘掉,该有人来看一眼。
    expect(CREDENTIAL_RESET_FAMILY.length).toBeGreaterThanOrEqual(5);
    // ── 锚点:证明扫描器真的走完了两个 SCAN_ROOT,而不是只扫到其中一半 ──────────
    //
    // P1-32 PR 1 之前,这里锚的是「storage 那条码出现在 prisma/seed.ts」。搬家后
    // `prisma/**` 里**一条权限码都不剩**(权限定义全在 permission-catalog.ts),
    // 那个锚点在结构上不可能再成立 —— 但它守的性质仍然要守,所以拆成三条各守一半:
    const storageSites = CREDENTIAL_RESET_SITES.get('storage-setting.reset.credentials') ?? [];
    // ① walker 仍然走到了 prisma/(该根现在零家族成员,只能锚文件本身;
    //    哪天有人把权限码写回 seed.ts,scan 面还在,判据就还看得见)。
    expect(SCANNED_FILES.map((f) => f.rel)).toContain('prisma/seed.ts');
    // ② **定义侧**被解析到了:权限目录里那条 `code: '<literal>'`。
    expect(storageSites).toContain('src/modules/permissions/permission-catalog.ts');
    // ③ **消费侧**也被解析到了:判权装饰器所在的 controller。少了这条,
    //    「扫描器只认目录文件」这种缩窄会静默通过 —— 而新 provider 漏登记时,
    //    最先出现那条码的地方恰恰是消费侧。
    expect(storageSites).toContain('src/modules/storage/storage-settings.controller.ts');
  });

  it('每一条 `*.reset.credentials` 权限码都在保留集内(漏登记即红并点名)', () => {
    const missing = CREDENTIAL_RESET_FAMILY.filter(
      (code) => !RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has(code),
    ).map(
      (code) =>
        `${code} —— 出现在 ${(CREDENTIAL_RESET_SITES.get(code) ?? []).join(' / ')},` +
        '但未登记进 rbac-seed-facts.ts 的 reservedSuperAdminOnlyPermissionCodes;' +
        '持 rbac.role-permission.create 的 ops-admin 可自授该码并覆盖对应 provider 凭证',
    );
    expect(missing).toEqual([]);
  });
});

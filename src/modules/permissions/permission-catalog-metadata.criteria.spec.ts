import {
  CRITICAL_RISK_TAGS,
  IDENTITY_ISSUANCE_PERMISSION_CODES,
  PERMISSION_CATALOG_GROUPS,
  PERMISSION_CATALOG_METADATA,
  PERMISSION_CATALOG_SECTIONS,
  PERMISSION_CATALOG_STATUSES,
  PERMISSION_GRANT_POLICIES,
  PERMISSION_RISK_LEVELS,
  PERMISSION_RISK_TAGS,
  PERMISSION_UI_VISIBILITIES,
} from './permission-catalog';
import { RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET } from './reserved-super-admin-permission-codes';
import {
  SEED_FACTS_CLOSURE,
  extractSeedFactsPermissionCodesAst,
  readSeedFactsClosure,
} from '../../../scripts/docs-counts';

// P1-32 PR 0(2026-08-22):权限元数据决策锁的执行位。
//
// ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
// 冻结稿把 PR 0 定性为「设计/文档,不改运行行为」。照字面做出来的产物是一份 237 条的
// markdown 目录 —— 而**纯文档的决策记录会漂**:新增一条权限码不会让任何文档变红,
// 三个月后目录里就少了它,没有任何症状。等 PR 3 把权限元数据变成 Catalog-owned、
// 禁运行时增删改,那条没人填过元数据的码才会以「后台显示空白 / 风险提示缺失」的形态爆出来。
//
// 所以本闸的职责**不是**当期快照(「今天这 237 条都填了」),而是:
//   🔴 **将来任何一条新码,不填元数据就进不了主干。**
// 这也是判据从**目录全集动态发现**、不写死 237 / 不写死任何清单的原因 ——
// Integration Foundation v1 的 PR2 会 +9 条控制面码,写死的判据那天会静默漏掉它们。
//
// ─── 全集取哪一份 ──────────────────────────────────────────────────────────
// 恒取 **seed 事实闭包的 typed-AST 提取**(与 `docs:counts` / `docs:rbacmap` 同源)。
//
// ⚠️ **不要改用 `RBAC_SEED_CATALOG.permissions.*` 当全集** —— 那四个桶是**具名子集不是闭包**
// (实测并集 224 < 闭包 237),差的那批里恰有 flag-gated 与动态拼接的码。
// 用它当全集 = 给判据装一个会静默饿死自己的过滤器,而「该进的没进」是没有症状的。
// 这一层同 `permission-code-holders.spec.ts` 的教训,复用同一个提取器,不新造第四份正则。
//
// ─── 与既有判据的分工(不重复执法)────────────────────────────────────────
// - 「码必须有持有人」+「保留码确实零持有」 → `permission-code-holders.spec.ts`
//   (维护者定案 ②「保留码一条都不进任何角色」在 seed 侧的执行位**已经在那里了**,
//    本闸只把「元数据里记的授予策略」与那份权威保留码集合钉在一起,不抄第二份清单)。
// - 「各桶并集 == 权限码全集」 → `permission-catalog-closure.spec.ts`
// - 「运行时 DB 行 == 清单」 → `test/e2e/seed-permission-catalog-runtime.e2e-spec.ts`
//
// ⚠️ 每条判据前先跑**自证**:全集扫不到东西 / 元数据表被清空时,判据必须当场红,
// 而不是「没有可检查的项 ⇒ 全过」。「判据失去输入 ≠ 通过」。

/** 权限码全集 = seed 事实闭包的 typed-AST 提取。动态发现,不写死条数。 */
const PERMISSION_UNIVERSE: ReadonlySet<string> = extractSeedFactsPermissionCodesAst(
  readSeedFactsClosure(SEED_FACTS_CLOSURE),
);

/**
 * 地板锚点。**刻意不写「恰 237 条」** —— 那会让每次新增权限码都要改判据,
 * 而「改判据才能过」正是判据失效的起点。地板只负责回答「扫描面塌没塌」。
 */
const UNIVERSE_FLOOR = 200;

const SECTION_CODES = new Set(PERMISSION_CATALOG_SECTIONS.map((s) => s.code));
const GROUP_BY_CODE = new Map(PERMISSION_CATALOG_GROUPS.map((g) => [g.code, g]));

const metadataEntries = Object.entries(PERMISSION_CATALOG_METADATA);
const activeEntries = metadataEntries.filter(([, meta]) => meta.status === 'ACTIVE');

/** 失败信息恒点名到具体权限码;`expect([]).toEqual([])` 的 diff 会把码打出来。 */
function offenders(
  entries: ReadonlyArray<readonly [string, (typeof metadataEntries)[number][1]]>,
  isBad: (meta: (typeof metadataEntries)[number][1]) => boolean,
): string[] {
  return entries
    .filter(([, meta]) => isBad(meta))
    .map(([code]) => code)
    .sort();
}

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

describe('权限元数据判据 —— 自证(先证明仪器没瞎,再报数)', () => {
  it('权限码全集非空且不低于地板(判据失去输入 ≠ 通过)', () => {
    expect(PERMISSION_UNIVERSE.size).toBeGreaterThanOrEqual(UNIVERSE_FLOOR);
    // 全集确实是权限码而不是别的什么(形状锚点:3-4 段小写)。
    const malformed = [...PERMISSION_UNIVERSE].filter(
      (code) => !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/.test(code),
    );
    expect(malformed).toEqual([]);
  });

  it('全集覆盖动态拼接码与保留码(扫描面锚点 —— 这两类最容易被过滤器吃掉)', () => {
    // 动态拼的:`attachment.delete.${ownerType}` 在 src 里 grep 字面量为 0。
    expect(PERMISSION_UNIVERSE.has('attachment.delete.member.other')).toBe(true);
    // flag-gated 且零持有的:具名子集当全集时第一个消失的就是它。
    expect(PERMISSION_UNIVERSE.has('activity-responsibility.override.record')).toBe(true);
    for (const code of RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET) {
      expect(PERMISSION_UNIVERSE.has(code)).toBe(true);
    }
  });

  it('元数据表非空、ACTIVE 条目不低于地板(被清空时必须红)', () => {
    expect(metadataEntries.length).toBeGreaterThanOrEqual(UNIVERSE_FLOOR);
    expect(activeEntries.length).toBeGreaterThanOrEqual(UNIVERSE_FLOOR);
  });

  it('信息架构注册表非空,且每个分组都挂在已声明的业务区下', () => {
    expect(PERMISSION_CATALOG_SECTIONS.length).toBeGreaterThan(0);
    expect(PERMISSION_CATALOG_GROUPS.length).toBeGreaterThan(0);
    const orphanGroups = PERMISSION_CATALOG_GROUPS.filter(
      (g) => !SECTION_CODES.has(g.sectionCode),
    ).map((g) => g.code);
    expect(orphanGroups).toEqual([]);
  });

  it('CRITICAL 判据的两个输入都非空(标签族 + 身份签发清单)', () => {
    expect(CRITICAL_RISK_TAGS.length).toBeGreaterThan(0);
    expect(IDENTITY_ISSUANCE_PERMISSION_CODES.length).toBeGreaterThan(0);
    // 标签族必须是冻结稿枚举里的值,不能是拼错的字符串(拼错 ⇒ 恒不命中 ⇒ 判据静默失效)。
    const unknown = CRITICAL_RISK_TAGS.filter(
      (t) => !(PERMISSION_RISK_TAGS as readonly string[]).includes(t),
    );
    expect(unknown).toEqual([]);
    // 身份签发清单不得留过期条目(码被改名 / 删掉后仍挂在这里 ⇒ 它守着一条不存在的码)。
    const stale = IDENTITY_ISSUANCE_PERMISSION_CODES.filter((c) => !PERMISSION_UNIVERSE.has(c));
    expect(stale).toEqual([]);
  });
});

describe('权限元数据判据 —— 覆盖完整性(双向集合相等)', () => {
  it('🔴 全集里的每一条码都有元数据条目(新增码不填元数据即红并点名)', () => {
    const missing = [...PERMISSION_UNIVERSE]
      .filter((code) => !(code in PERMISSION_CATALOG_METADATA))
      .sort();
    expect(missing).toEqual([]);
  });

  it('元数据表里没有全集之外的条目(码删掉后不得留下孤儿元数据)', () => {
    const orphans = metadataEntries
      .map(([code]) => code)
      .filter((code) => !PERMISSION_UNIVERSE.has(code))
      .sort();
    expect(orphans).toEqual([]);
  });
});

describe('权限元数据判据 —— 每条 ACTIVE 的字段完整且取值合法', () => {
  // ⚠️ 完整性只管 ACTIVE:退役码(DEPRECATED / INTERNAL)不受本组判据管辖,
  //    否则「想退役一条码」会变成「先把它的元数据补全」,退役码就永远删不掉了。
  //    但**存在性**对所有状态都要求(上一组),所以退役码不会从视野里消失。

  it('🔴 中文名与人话说明都不为空', () => {
    expect(offenders(activeEntries, (m) => isBlank(m.displayName))).toEqual([]);
    expect(offenders(activeEntries, (m) => isBlank(m.businessDescription))).toEqual([]);
  });

  it('🔴 分类完整:sectionCode / groupCode 已登记,且两者归属一致', () => {
    expect(offenders(activeEntries, (m) => !SECTION_CODES.has(m.sectionCode))).toEqual([]);
    expect(offenders(activeEntries, (m) => !GROUP_BY_CODE.has(m.groupCode))).toEqual([]);
    // 分组自己声明的 sectionCode 必须与条目上写的一致 —— 否则条目会在 UI 上挂错分区,
    // 而两个字段各自都「合法」,单看任一个都发现不了。
    expect(
      offenders(
        activeEntries,
        (m) => GROUP_BY_CODE.get(m.groupCode)?.sectionCode !== m.sectionCode,
      ),
    ).toEqual([]);
  });

  it('🔴 sortOrder 是正整数(0 会被消费方的 `if (!sortOrder)` 当成缺值)', () => {
    expect(
      offenders(activeEntries, (m) => !Number.isInteger(m.sortOrder) || m.sortOrder <= 0),
    ).toEqual([]);
  });

  it('🔴 风险等级 / 授予策略 / 状态 / 可见性都落在冻结稿枚举内', () => {
    expect(
      offenders(
        activeEntries,
        (m) => !(PERMISSION_RISK_LEVELS as readonly string[]).includes(m.riskLevel),
      ),
    ).toEqual([]);
    expect(
      offenders(
        activeEntries,
        (m) => !(PERMISSION_GRANT_POLICIES as readonly string[]).includes(m.grantPolicy),
      ),
    ).toEqual([]);
    expect(
      offenders(
        activeEntries,
        (m) => !(PERMISSION_UI_VISIBILITIES as readonly string[]).includes(m.uiVisibility),
      ),
    ).toEqual([]);
  });

  it('🔴 风险标签非空、无重复、且每个都在枚举内', () => {
    expect(offenders(activeEntries, (m) => m.riskTags.length === 0)).toEqual([]);
    expect(offenders(activeEntries, (m) => new Set(m.riskTags).size !== m.riskTags.length)).toEqual(
      [],
    );
    expect(
      offenders(activeEntries, (m) =>
        m.riskTags.some((t) => !(PERMISSION_RISK_TAGS as readonly string[]).includes(t)),
      ),
    ).toEqual([]);
  });

  it('每条恰好带 READ 或 WRITE 之一(读写性质不许留空,也不许自相矛盾)', () => {
    expect(
      offenders(activeEntries, (m) => {
        const rw = m.riskTags.filter((t) => t === 'READ' || t === 'WRITE');
        return rw.length !== 1;
      }),
    ).toEqual([]);
  });

  it('所有状态取值合法(含退役码 —— 它们不做完整性检查,但状态本身必须能被认出来)', () => {
    expect(
      offenders(
        metadataEntries,
        (m) => !(PERMISSION_CATALOG_STATUSES as readonly string[]).includes(m.status),
      ),
    ).toEqual([]);
  });
});

describe('权限元数据判据 —— 维护者 2026-08-22 拍板结论的执行位', () => {
  it('① CRITICAL 恰好等于「五族」:带 CRITICAL 标签族之一,或在身份签发清单里', () => {
    const shouldBeCritical = (code: string, tags: readonly string[]): boolean =>
      tags.some((t) => (CRITICAL_RISK_TAGS as readonly string[]).includes(t)) ||
      IDENTITY_ISSUANCE_PERMISSION_CODES.includes(code);

    // 该是 CRITICAL 却没标(判据变松时这一侧红)
    const understated = activeEntries
      .filter(([code, m]) => shouldBeCritical(code, m.riskTags) && m.riskLevel !== 'CRITICAL')
      .map(([code]) => code)
      .sort();
    expect(understated).toEqual([]);

    // 标了 CRITICAL 却不属于五族(有人手工把某条升到最高危而不说明依据时这一侧红)
    const overstated = activeEntries
      .filter(([code, m]) => m.riskLevel === 'CRITICAL' && !shouldBeCritical(code, m.riskTags))
      .map(([code]) => code)
      .sort();
    expect(overstated).toEqual([]);
  });

  it('① CONTROL_PLANE 只贴给写侧(贴到只读码上会把「查看谁有什么角色」升成最高危)', () => {
    expect(
      offenders(
        activeEntries,
        (m) => m.riskTags.includes('CONTROL_PLANE') && m.riskTags.includes('READ'),
      ),
    ).toEqual([]);
  });

  it('② 授予策略 SUPER_ADMIN_ONLY 的集合,恰等于正在执法的 SA-only 保留码集合', () => {
    // 🔴 复用权威集合,不抄第二份清单 —— 抄一份就是造第二个事实源,两份可以各自漂移,
    //    而「元数据说能授、控制面拦着」或反过来,都不会有任何症状。
    //    seed 侧「这 7 条零角色持有」的执行位在 permission-code-holders.spec.ts,本条不重复。
    const declared = metadataEntries
      .filter(([, m]) => m.grantPolicy === 'SUPER_ADMIN_ONLY')
      .map(([code]) => code)
      .sort();
    expect(declared).toEqual([...RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET].sort());
  });

  it('② 保留码在角色编辑器里不露面(HIDDEN)—— 露面就等于邀请人去授它', () => {
    const visible = metadataEntries
      .filter(
        ([code, m]) =>
          RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has(code) && m.uiVisibility !== 'HIDDEN',
      )
      .map(([code]) => code)
      .sort();
    expect(visible).toEqual([]);
  });

  it('③ 本期不出 scopeProfile 字段(Scope 首版只提示;字段在就会被当成强校验依据)', () => {
    const leaked = metadataEntries
      .filter(([, m]) => 'scopeProfile' in (m as unknown as Record<string, unknown>))
      .map(([code]) => code);
    expect(leaked).toEqual([]);
  });

  it('⑤ 旧 Permission 写 CRUD 仍是 ACTIVE(退役由 PR 8 前提触发,不定死日期)', () => {
    for (const code of [
      'rbac.permission.create',
      'rbac.permission.update',
      'rbac.permission.delete',
    ]) {
      expect(PERMISSION_CATALOG_METADATA[code]?.status).toBe('ACTIVE');
    }
  });
});

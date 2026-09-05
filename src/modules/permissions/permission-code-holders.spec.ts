import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RBAC_SEED_CATALOG } from '../../../prisma/seed';
import {
  SEED_FACTS_CLOSURE,
  countRbacRoleUpserts,
  extractSeedFactsPermissionCodesAst,
  readSeedFactsClosure,
} from '../../../scripts/docs-counts';
import { RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET } from './reserved-super-admin-permission-codes';
import { PERMISSION_CATALOG_METADATA } from './permission-catalog';

// 第七轮评审 R7-D-01(2026-08-21):「权限码必须有持有人」类闸。
//
// ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
// 权限码在 seed 里建出来、在 controller/service 上判着权,却**没有任何内建角色持有它** ⇒
// 该端点对除 SUPER_ADMIN 外的所有人恒 403。功能"看起来做完了",实际不可用。
//
// 实测触发本刀的实例(6 条,全部 attachment 维护码):
//   attachment.{update,delete}.{activity,certificate.other,member.other}
// 组长能替别人传附件(upload 三条码都在 group-manager 手上),传错了却改不了删不了。
// 对照本身就是判据:content 类有完整的传/删、self 类有完整的传/改/删 ⇒ 不存在
// 「本系统就是不给删」的设计原则,这三类是单独漏的。
//
// ─── 为什么此前零执法 ──────────────────────────────────────────────────────
// check-rbac-map.ts 的 A/D/E/F/G 五条判据没有一条断言「码必须挂到角色」;判据 F
// (seed 码在 src 有字面量引用)只把这类码记成「孤码候选」并 WARN,退出码仍是 0。
// RBAC_MAP.md 生成了权限码全集与 controller×surface 对照,也没有「角色→权限码」这一维。
//
// ─── 扫描面:为什么是 seed 事实闭包,不是 src 字面量 ────────────────────────
// 这 6 条码在 src 里 **grep 字面量为 0** —— 它们是动态拼的:
//   attachment-write.service.ts:169  `attachment.update.${row.ownerType}${scope ? '.' + scope : ''}`
//   attachment-write.service.ts:313  `attachment.delete.${row.ownerType}${scope ? '.' + scope : ''}`
// 判据若从 src 字面量出发,这一整类都在盲区。因此全集恒取**权限目录(seed 事实闭包)**:
// docs-counts 的 typed-AST 提取器逐条读 `code: '<literal>'` / `*_CODE = '<literal>'`,
// 与 RBAC_MAP.md 发布的权限码全集同一口径,不新造第四份正则。
//
// ⚠️ **不要改用 `RBAC_SEED_CATALOG.permissions.*` 当全集** —— 那四个桶
// (rbac / bootstrap / attachment / business)是**具名子集不是闭包**:实测并集 224,
// 而闭包 236,差的 12 条里就包含 `activity-responsibility.override.record` ——
// 恰恰是本闸最需要看见的那条。用它当全集 = 给判据装一个会静默饿死自己的过滤器。
// 下方「自证」把这层关系钉死:目录里的每条码都必须落在闭包内。
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** 权限码全集 = seed 事实闭包的 typed-AST 提取(与 docs:rbacmap 生成的全集同源)。 */
const PERMISSION_UNIVERSE: ReadonlySet<string> = extractSeedFactsPermissionCodesAst(
  readSeedFactsClosure(SEED_FACTS_CLOSURE),
);

interface CatalogRoleSeed {
  readonly code: string;
  readonly permissionCodes: readonly string[];
}

/**
 * 内建角色全集(15 个),取自 seed 导出的只读目录。
 *
 * `RBAC_SEED_CATALOG.roles` 的值是异构的:多数键是单个角色,`activityResponsibility` 是数组。
 * 这里逐项摊平,不假设任何一种形态 —— 将来再多一个数组键也不用改这里。
 */
const BUILTIN_ROLES: readonly CatalogRoleSeed[] = Object.values(RBAC_SEED_CATALOG.roles).flatMap(
  (entry): CatalogRoleSeed[] =>
    Array.isArray(entry) ? entry.map((role: CatalogRoleSeed) => role) : [entry as CatalogRoleSeed],
);

/** code → 持有它的内建角色(空数组 = 零持有)。失败信息靠它点名。 */
const HOLDERS_BY_CODE = new Map<string, string[]>();
for (const role of BUILTIN_ROLES) {
  for (const code of role.permissionCodes) {
    const holders = HOLDERS_BY_CODE.get(code) ?? [];
    if (!holders.includes(role.code)) holders.push(role.code);
    HOLDERS_BY_CODE.set(code, holders);
  }
}
const isHeld = (code: string): boolean => (HOLDERS_BY_CODE.get(code) ?? []).length > 0;

// ─── 豁免口 ①:SA-only 保留码(复用,不复制)─────────────────────────────────
//
// 这 7 条**刻意**不绑任何内建角色,语义是「仅 SUPER_ADMIN 短路通过」。它们已经有一份
// 正在执法的权威清单(rbac-seed-facts.ts 的 reservedSuperAdminOnlyPermissionCodes,
// 经 reserved-super-admin-permission-codes.ts 投影),控制面的 `isControlPlanePermissionCode()`
// 用同一份清单拦截 ops-admin 自授。
//
// 🔴 **必须复用而不是抄一份**:抄一份就是造第二个事实源 —— 两份清单可以各自漂移,
// 而「本闸放行了但控制面没拦」或反过来,都不会有任何症状。复用同一个 Set 之后,
// 「本闸的豁免面 ≠ 控制面的保留面」在结构上不可能发生。
//
// 逐条复核(2026-08-21,对照 app_probe_authz_reach 实测,7 条确认零角色持有):
//   user.update.role                    改用户角色 —— seed D1=A,连 ops-admin 都不绑
//   member.delete.record                软删队员 —— 评审稿 §6,破坏性,不绑 biz-admin
//   storage-setting.reset.credentials   COS 凭证重置 —— seed D2=A
//   sms-setting.reset.credentials       SMS 凭证重置 —— 镜像 D2=A
//   wechat-setting.reset.credentials    微信凭证重置 —— 镜像 D2=A
//   realname-setting.reset.credentials  实名核验凭证重置 —— 镜像 D2=A
//   wecom-setting.reset.credentials     企业微信凭证重置 —— 第六轮评审 E-B1 补登记
// 每条的权威理由写在 SoT 处,本文件不复述(复述=第二份可漂移的说明)。

// ─── 豁免口 ②:已建码但整条链尚未接通 ───────────────────────────────────────
//
// 与 ① 语义不同:① 是「永远只给 SUPER_ADMIN」,② 是「这条链还没接完,现在没人该拿」。
// 因此 ② 的每一条都**必须写到期条件** —— 到期条件成立时这条豁免要么删掉、要么升级成 ①。
//
// 🔴 为什么不按「当前是否可达」隐式排除:
//   `activity-responsibility.override.record` 的 6 个 admin 端点之所以现在不算缺口,
//   只是因为 ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED=false。而 app.config.ts:483 要求
//   production / smoke **必须显式设 true 或 false**(留空即 fail-closed 抛错)——
//   哪天设成 true,那 6 个端点立刻可达,而权限码仍零角色,同一个坑再踩一次。
//   若判据按「当前路径可达性」过滤,它在那一刻依然是绿的。所以扫描面恒覆盖**全部**码,
//   闸后的码走这里的显式白名单 + 到期条件(沿本仓 Phase 5「到期闸」范式)。
const UNWIRED_RESERVED_PERMISSION_CODES: ReadonlyMap<string, string> = new Map([
  [
    'activity-responsibility.override.record',
    '活动责任闭环 override(admin-activity-responsibilities.controller.ts 6 个端点)。' +
      'seed 建了 12 条 activity-responsibility 权限 + 6 个责任角色,override.record 是其中' +
      '唯一零角色的一条(另 11 条已绑到那 6 个角色);当前 ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED=false。' +
      '【到期条件】该开关在任一部署环境置为 true 之前,必须先给本码指定持有角色(或改判为 SA-only ' +
      '并登记进 reservedSuperAdminOnlyPermissionCodes),然后删掉本条豁免。',
  ],
]);

// ③ 维护者批准 C1 D2a：可由人工授予自定义角色，但 seed 不向内建角色分配。
// 只列这三条；不能按 CUSTOM_ROLE_ALLOWED 全量豁免。真实授码/撤码验证在 D2a HTTP E2E。
const MANUALLY_ASSIGNED_PERMISSION_CODES = new Set([
  'activity-metric.read.catalog',
  'activity-metric.manage.definition',
  'activity-metric.manage.set',
]);

/** 唯一豁免口 = ① ∪ ② ∪ 已批准的精确人工授码清单。 */
const isExempt = (code: string): boolean =>
  RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has(code) ||
  UNWIRED_RESERVED_PERMISSION_CODES.has(code) ||
  MANUALLY_ASSIGNED_PERMISSION_CODES.has(code);

describe('C1 D2a 人工授码例外边界', () => {
  it('仅三码例外；码必须真实存在、允许自定义角色、且确实无内建持有人', () => {
    expect([...MANUALLY_ASSIGNED_PERMISSION_CODES].sort()).toEqual([
      'activity-metric.manage.definition',
      'activity-metric.manage.set',
      'activity-metric.read.catalog',
    ]);
    for (const code of MANUALLY_ASSIGNED_PERMISSION_CODES) {
      expect(PERMISSION_UNIVERSE.has(code)).toBe(true);
      expect(PERMISSION_CATALOG_METADATA[code].grantPolicy).toBe('CUSTOM_ROLE_ALLOWED');
      expect(PERMISSION_CATALOG_METADATA[code].status).toBe('ACTIVE');
      expect(isHeld(code)).toBe(false);
      expect(RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has(code)).toBe(false);
      expect(UNWIRED_RESERVED_PERMISSION_CODES.has(code)).toBe(false);
    }
  });
  it('不会豁免其他自定义角色权限或同前缀的未批准权限', () => {
    expect(PERMISSION_CATALOG_METADATA['org.create.node'].grantPolicy).toBe('CUSTOM_ROLE_ALLOWED');
    expect(isExempt('org.create.node')).toBe(false);
    expect(isExempt('activity-metric.manage.future')).toBe(false);
    expect(isExempt('activity-metric.read.future')).toBe(false);
  });
});

describe('判据自证:仪器没瞎(先证明扫到了东西,再报数)', () => {
  // 全部用地板锚点(≥N),不用「恰 N 条」—— 写死数量的自证会过期,然后被人顺手改大,
  // 于是自证从「证明仪器活着」退化成「记录当前值」。
  it('权限码全集非空且规模合理(闭包提取真的跑起来了)', () => {
    expect(SEED_FACTS_CLOSURE.length).toBe(2);
    // 地板值:权限码只增不减的历史下当前 236。真跌破 200 说明提取器坏了或 seed 被大幅削减。
    expect(PERMISSION_UNIVERSE.size).toBeGreaterThanOrEqual(200);
  });

  it('角色集非空,且目录声明的角色数 == seed 实际 upsert 的角色数(双向锚点)', () => {
    const seedSource = readFileSync(join(REPO_ROOT, 'prisma', 'seed.ts'), 'utf-8');
    // 这一条同时挡住两个方向的漂移:
    //   - seed 新增角色但没投影进目录 ⇒ 目录少一个 ⇒ 本条红(否则该角色持有的码会被误判成零持有)
    //   - 目录里写了 seed 根本不建的幽灵角色 ⇒ 目录多一个 ⇒ 本条红(否则它会假装持有码,静默变绿)
    expect(BUILTIN_ROLES.length).toBe(countRbacRoleUpserts(seedSource));
    expect(BUILTIN_ROLES.length).toBeGreaterThanOrEqual(15);
  });

  it('角色绑定非空,且没有角色引用未声明的权限码', () => {
    expect(HOLDERS_BY_CODE.size).toBeGreaterThanOrEqual(200);
    const strays = [...HOLDERS_BY_CODE.keys()].filter((code) => !PERMISSION_UNIVERSE.has(code));
    expect(strays).toEqual([]);
  });

  it('全集确实覆盖动态拼接码与开关后的码(扫描面锚点)', () => {
    // 锚点 1:attachment 维护码在 src 里 grep 字面量为 0(动态拼),只有从 seed 闭包出发才看得见。
    expect(PERMISSION_UNIVERSE.has('attachment.delete.activity')).toBe(true);
    expect(PERMISSION_UNIVERSE.has('attachment.update.member.other')).toBe(true);
    // 锚点 2:feature flag 关着的码必须在扫描面内 —— 这正是「按当前可达性隐式排除」会漏掉的那条。
    expect(PERMISSION_UNIVERSE.has('activity-responsibility.override.record')).toBe(true);
    // 锚点 3:证明闭包里第二个文件(rbac-seed-facts.ts)也被读到了,不是只读了 seed.ts。
    expect(PERMISSION_UNIVERSE.has('rbac.config.reload')).toBe(true);
  });

  it('RBAC_SEED_CATALOG.permissions 的每条码都在闭包内(目录是子集,不得反超)', () => {
    // 若哪天目录里出现闭包没有的码,说明两者口径分叉,本闸的「持有」侧就不可信了。
    const declared = Object.values(RBAC_SEED_CATALOG.permissions).flatMap((bucket) =>
      bucket.map((permission) => permission.code),
    );
    expect(declared.filter((code) => !PERMISSION_UNIVERSE.has(code))).toEqual([]);
  });
});

describe('权限码必须有持有人(第七轮评审 R7-D-01)', () => {
  it('每一条权限码要么被至少一个内建角色持有,要么在显式豁免口内(零持有即红并点名)', () => {
    const orphans = [...PERMISSION_UNIVERSE]
      .filter((code) => !isHeld(code) && !isExempt(code))
      .sort()
      .map(
        (code) =>
          `${code} —— 零内建角色持有,且不在任何豁免口内。该码守着的端点对除 SUPER_ADMIN ` +
          '外的所有人恒 403(功能不可用)。修法二选一:① 在 prisma/seed.ts 给它指定持有角色;' +
          '② 若确属「刻意不给任何角色」,登记进 rbac-seed-facts.ts 的 ' +
          'reservedSuperAdminOnlyPermissionCodes(SA-only),或本文件的 ' +
          'UNWIRED_RESERVED_PERMISSION_CODES(链未接通,必须写到期条件)。',
      );
    expect(orphans).toEqual([]);
  });
});

describe('豁免口纪律:白名单必须是「有牙的豁免」而不是摆设', () => {
  it('两个豁免口不重叠(同一条码不得两处登记)', () => {
    const overlap = [...UNWIRED_RESERVED_PERMISSION_CODES.keys()].filter((code) =>
      RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET.has(code),
    );
    expect(overlap).toEqual([]);
  });

  it('豁免口里的每条码都真实存在于权限码全集(禁止留过期条目)', () => {
    const stale = [
      ...RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET,
      ...UNWIRED_RESERVED_PERMISSION_CODES.keys(),
    ]
      .filter((code) => !PERMISSION_UNIVERSE.has(code))
      .sort();
    expect(stale).toEqual([]);
  });

  it('豁免口里的每条码都确实零持有(豁免不得掩盖已被持有的码)', () => {
    // 反向纪律:如果某条豁免码其实已经被某个角色持有,那条豁免就是过期的噪声 ——
    // 留着它只会让下一个人以为「这条本来就该没人」,而事实相反。
    const wronglyExempt = [
      ...RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET,
      ...UNWIRED_RESERVED_PERMISSION_CODES.keys(),
    ]
      .filter((code) => isHeld(code))
      .map((code) => `${code} —— 已被 ${(HOLDERS_BY_CODE.get(code) ?? []).join(' / ')} 持有`)
      .sort();
    expect(wronglyExempt).toEqual([]);
  });

  it('② 号豁免口的每条都写了到期条件(不得只写理由不写怎么退出)', () => {
    const missingExpiry = [...UNWIRED_RESERVED_PERMISSION_CODES.entries()]
      .filter(([, reason]) => !reason.includes('【到期条件】'))
      .map(([code]) => code);
    expect(missingExpiry).toEqual([]);
  });
});

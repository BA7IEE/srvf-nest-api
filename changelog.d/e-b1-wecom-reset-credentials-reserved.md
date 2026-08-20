### Security

- **`wecom-setting.reset.credentials` 补进 SA-only 保留集**(第六轮全仓评审包 E · E-B1)。该码自企业微信 T2
  落地起从未登记进 `RBAC_SEED_FACTS.contract.reservedSuperAdminOnlyPermissionCodes`(6 条 → **7 条**),
  于是 `isControlPlanePermissionCode()` 对它返回 `false`,`RolePermissionsService.assign()` 的控制面闸放行 ——
  持 `rbac.role-permission.create` 的 ops-admin 可把该码**自授**给任意角色,再调
  `POST /api/system/v1/wecom-settings/reset-credentials` 覆盖 CorpSecret。同族的 storage / sms / wechat /
  realname 四条**正是靠这个集合**才安全,wecom 不在集合里,同一机制就不保护它;等于把 #399 F1 修过的
  同类洞重新打开一半。修复只改事实源,不给 `WecomSettingsService` 另加 `SUPER_ADMIN` 特判 ——
  五个家族成员继续统一走「保留集 + `rbac.can()` 短路」这一套机制。
- **根因是 seed 里一处一次性硬编码过滤器**。`OPS_ADMIN_PERMISSION_SEED` 中 wecom 那行写的是
  `filter((p) => p.code !== WECOM_RESET_CREDENTIALS_CODE)`,全仓仅此一处不走共享谓词
  `isNotReservedSuperAdminOnlyPermission`。后果不是 seed 绑错(ops-admin 确实没绑,行为看起来完全正常),
  而是**保留集永远学不到 wecom**,漏洞就藏在这条"看起来没问题"的缝里。现改回共享谓词:
  ops-admin 绑定集合逐码不变,但 seed 从此依赖保留集正确 —— 保留集再漏一条,seed 会跟着漏绑,
  漂移哨兵随即变红。

### Added

- **「`*.reset.credentials` 家族全登记」动态判据**(`reserved-super-admin-permission-codes.spec.ts`)。
  凭证重置是一个**家族**而非一串互不相干的码,而新成员漏登记**不会有任何症状** —— seed 照样不绑、
  端点照样能用,只有"ops-admin 自授该码"这条路径悄悄打开(wecom 就这样漏了半年多)。新判据从
  `src/**` + `prisma/**` 的 `.ts` **动态现取**所有 `*.reset.credentials` 字符串字面量(剥注释、
  跳过 `.spec.ts`),逐条要求出现在保留集中,漏一条即红并**点名是哪条码、出现在哪些文件、后果是什么**。
  刻意不写死名单 —— 写死名单等于把既有「恰 N 条」冻结断言的缺陷复制一份:第六个 provider 接进来时,
  名单与保留集会一起漏掉它,两条守护同时变成摆设。判据自带自证断言(扫描面非空 + 确实读到了
  `prisma/seed.ts` 里的家族成员),防扫描器坏掉时"空集 == 空集"静默变绿。
  与既有「恰 N 条」冻结断言**职责相反,两条都留**:前者锁**集合内容**(防塞进不该塞的码),
  后者锁**该进的都进来了**(防漏登记)。变异实测坐实二者不重叠:注入一个假的第六成员后,
  「恰 N 条」保持全绿,只有新判据变红。

### Harness / 执法层

- 「各桶并集必须等于权限码全集」类闸(`scripts/check-permission-catalog-closure.ts`,薄运行器 `src/modules/permissions/permission-catalog-closure.spec.ts` 由 `pnpm test` 收;第七轮评审顺带发现 ①)。`RBAC_SEED_CATALOG.permissions` 此前是**四个具名桶**而非闭包,并集 **225 / 全集 237**;漏的 12 条**恰好是整个 `ACTIVITY_RESPONSIBILITY_WORKFLOW_PERMISSION_SEED`** —— 责任闭环那批加了自己的权限数组却没人接进目录,而漏掉的偏偏是最新、最需要盯的 flag-gated 码(结算真相链 6 条 · 责任 override · 跨组织发起 · 考勤退回 2 条)。这种漏法**零症状**:类型对、数量看着合理、没有断言也没有命名提示,唯一发现方式是有人恰好去数一遍。R7-D-01 建「权限码必须有持有人」闸时差点把这四桶当全集用,那样会对这 12 条完全失明 —— 那次靠个人警觉绕开,本闸把它变成机制。

  ⭐ **两侧刻意取不同来源**:全集侧是 `docs-counts` 的 typed-AST **静态扫源码文本**,并集侧是 `RBAC_SEED_CATALOG.permissions` 的**运行时导出值**。实测证明这不是洁癖 —— 把全集侧换成「并集自己」后再摘掉一个桶,判据打印「并集 225 · 全集 225 · ✓ 相等」并**退 0**,而 12 条真缺陷就摆在那里(「拿生成器输出跟生成器输入比」的假绿)。

  两个方向都查:① 全集有、任何桶都没有(主用途);② 桶里有、全集没有 —— 后者是**全集侧失效的唯一症状**,提取器少认一种写法会让全集缩水,而缩水后的全集恒是并集子集,方向 ① 反而全绿。

  判据实质逻辑放在 `scripts/check-*.ts`(selfGuard 内),spec 只做薄运行器 —— `src/**/*.spec.ts` 不在 selfGuard,把逻辑放那里等于没锁。

- `RBAC_SEED_CATALOG.permissions` 新增 `activityWorkflow` 桶(12 条),并在定义处写明「新增权限数组必须加桶、不得用 `all` 桶兜底」及其机器执法出处。

### 文档

- `test/e2e/seed-position-role-policies.e2e-spec.ts` 头注的角色计数订正(第七轮评审顺带发现 ③)。原文写「内置角色 7→9 / org-admin 47 / biz-admin 69 / group-manager 20」,实测已是 15 个角色、group-manager 26 条,**三个数字全部失准**且无任何判据会发现。改为**指向权威源**(`RBAC_MAP.md` 的「角色 → 权限码覆盖」生成表)而不是填新数字 —— 填新数字只会把同一个缺陷再犯一遍。

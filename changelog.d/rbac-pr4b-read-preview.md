### RBAC 角色权限集:读 / 预览面(P1-32 PR 4b)

冻结稿 `## PR 4` 的另一半。4a(#1156)落的是 `PUT` + `permissionRevision` + 角色行锁,
本刀补 **`GET` 角色权限集** 与 **`POST .../preview`** 两个只读端点。**PR 4 至此两半齐全。**

**纯 additive,旧前端零影响** —— 实测 `pnpm gate:contract:semantic`:**`breaking=0 / additive=2`**,
两条 additive 全是 `[endpoint-added]`,零删除、零收窄、零可空性变更。现有端点一个不删不改。

#### ⭐ 主交付物不是端点,是「preview 与 PUT 同源」这条判据

4a 把多条写路径并进了**一条 replace 原语**。若 preview 自己再算一遍「会发生什么」,
就是**造第二份真相** —— 而「预览说能过、真 PUT 拒绝」(或反过来)**没有任何症状**。

实现照冻结稿 §1.7 点名的范式(逐字:「这套 preview + create 复用同一校验器的范式,应直接复用」),
仓内先例是 `role-bindings.service.ts:263`:preview 走**同一条原语**、`commit: null` 即零写入,
一个**边界 try/catch** 把 `BizException` 搬成 `blockingIssues[]`。判定一处都没有重写 ——
结论仍由 4a 那条原语在同一把行锁、同一个事务里算出。

判据 `scripts/check-role-permission-read-preview.ts` 钉住这一点,三轮变异全红:
preview 照抄判定 → `own-judgement` + `same-delegate`;dry-run 出口挪到方向闸之前 → `dryrun-exit`;
preview 路由闸换成 read 码 → `route-gate`。

⚠️ **一处诚实的代价**:`blockingIssues` 长度**恒为 0 或 1** —— 写路径本身 fail-fast,
第一道闸抛了就不跑后面的。硬凑多条就得在锁外再跑一遍判定,那才是第二份真相。
**不是全量诊断**,已写进 DTO 描述与 handoff。

#### 🔴 顺带修了一个缺陷类:P2-13 闸对通配码的结构性死路

本刀触发 P2-13「说明↔管辖面绑定」闸 4 条,3 条真码照常改 `businessDescription` 收口。
**第 4 条 `rbac.role-permission.*` 是死路**:

- 它不是权限码,是 `[rbac: <family>.*]` 后缀约定的产物 ——
  `scripts/check-rbac-map.ts:381` 的 `const code = rm[1]` 把 `[rbac: ` 之后**整串**当一个码,
  逗号分隔的两个单码会被判「不在 seed 闭包」⇒ **一个端点要两条码时只能退化成写通配族**。
- 通配码**没有 `businessDescription` 可改**;给它补一条会打红 P2-13 自己的
  `describedButUnknown` 自证 ⇒ 原口径「面变了 && 说明没变 ⇒ 拒绝」对它**恒成立且无路可走**。

**没有走 `--acknowledge-unchanged`** —— 那是它落地后第一次触发,第一次就用逃生门等于
把闸建成永远被绕过的;而且实测基线里**有 5 条**通配码
(`attachment.{delete,update,upload,view}.*` + `rbac.role-permission.*`)
⇒ 今后任何端点加入那 4 个 attachment 族都会撞同一条死路,**是缺陷类不是单点**。

改的是判定口径:两侧都无说明的通配码,**复核责任委派给该族的成员码**
(要求每个成员「面没变」或「说明已改」)。族成员是真权限码、有真说明,复核实质发生在那里。

🔴 **两道不许放松的守法,各自有对照**:

| 对照 | 期望 | 实测 |
|---|---|---|
| ① 真码「有说明却没改」 | 仍必须红 | ✅ 判红 + `--write` 拒绝,两处执行位都拦 |
| ② 委派成立(本刀情形) | 绿 | ✅ 退出码 0 |
| ③ **成员码面变了却没改说明** | 仍必须红 | ✅ 两处都红,**点名该成员码** |
| ④ 通配族零成员 | 仍拒绝 | 代码路径已覆盖(否则「族里没人」= 自动全绿) |

⚠️ **委派判定写成一个共用函数** `delegatedReview()` / `delegationSatisfied()`,
由 `formatFailures`(判红)与 `writeBaseline`(拒绝推进)**共同调用** ——
绑定型闸的执行位在这两处,各写一份就是在判据内部造第二份真相。

⚠️ **顺带修掉两个「半真陈述」**:原文案会对通配码打印「说明一字未动」(它没有说明可改,
这话误导),并建议 `--acknowledge-unchanged`(把刚焊死的口子又指出来)。
现在如实说委派为什么没成立,且**只对「有说明可改」的码建议 acknowledge**;
对通配码明写「没有说明可改,也不要 acknowledge —— 去改它族成员的说明」。

⏭ **登记未做**:更深的根因在 `check-rbac-map.ts:381` ——「端点要多条码」本该能逗号分隔
而不必退化成通配族。改解析口径打击面大,单独立项。

#### 两处台账订正

- `NEXT_TASKS` P1-32 原写「4b 零 schema 改动、**零红区(预估)**」—— **错**,实测 **7 条**红区路径。
  ⇒ **加端点类的刀不存在「零红区」**;预算一律用 `harness:needs` 喂「改动的后果」现算,别预估。
- contract spec 的端点数流水注释停在「PR 4a → 550」,与常量 552 脱节。
  只在尾部补「PR 4b +2 → 554」并注明流水有缺口,**不回补历史**。

两份台账口径已统一(`↔进行中 5/9` ↔ 状态行 `5/9`),两条跨台账闸实测绿。

#### 划给 PR 5 的(明确未做)

`impact{...}` 影响统计(冻结稿 `## PR 5` 第一项逐字)· `requiresStepUp` 与 step-up proof ·
`catalogHash` · `editPolicy.addBlocked/removeBlocked`(把控制面两层闸重新表达一遍,同属第二份真相形状)。

#### 分页

`GET` 角色权限集**不分页,也不进例外表** —— 它不是列表端点:响应是一个对象,
`permissionCodes` 是该资源的一个字段,与既有 `GET /roles/:id` 返 `permissions[]` 同一形状;
分页铁律管的是入参 `PaginationQueryDto` / 出参 `PageResultDto` 的查询型端点。
往「整取型只读目录」那张表加行会替它做一个「固定参考集合」的假声明(角色权限集是运行时数据)。
理由写在 controller 头注与 handoff。

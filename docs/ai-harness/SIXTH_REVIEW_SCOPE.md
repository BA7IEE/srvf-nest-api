# 第六轮全仓评审 —— 范围切分与投放包

> **性质**:跨模型评审的**投放准备**(工作计划,非冻结件)。
> findings 落点仍是 PR 评论,不进仓库正文 —— 沿 [`codex-review-sop.md`](codex-review-sop.md) §3。
>
> **为什么不放 `docs/archive/reviews/`**:归档区冻结不回改,而本文在评审推进中还要更新
> (投放进度、范围微调)。评审**结论**产出后另立冻结件入归档,那时才是不可变的。
>
> **起草日**:2026-08-20 · **范围基线**:`v0.66.0..bab3793e` · **拍板**:维护者 2026-08-20 选 B(跨模型评审)
>
> 📌 **范围 SHA 固定为 `bab3793e`**(A 包投放时的 main)。此后 main 继续前进(T3 等),
> 但**评审对象不动** —— findings 按该 SHA 归因。T3 未碰 `prisma/`,故 A 包对象逐字节未变。

---

## 0-pre. 🔴 A 包已完成 —— **投放 B–F 时必须一并给「已确认事实」**

A 包(schema + migration)已收回 findings 并**经本仓逐条复核**。
下列三条是**已定性的事实**,投放其余五包时**必须随投放模板一并给出**,理由见每条末尾。

### ① BLOCKER「migration 没包事务,失败留下半套 schema」—— **已实测证伪,不要再报**

原报告的推论链依赖一句前提:「Prisma 不自动包事务」。**该前提不成立。**

复现方式(任何人可重跑):建独立探针库 → 写一个**不含 `BEGIN/COMMIT`** 的 migration,
前半段建两张表、末尾对既有表加 CHECK,而库里预置一行违反该 CHECK 的脏数据 →
`prisma migrate deploy`。

实测读数:
```
Error: P3018 · Database error code: 23514
  check constraint "..." is violated by some row     ← 失败如期发生
库内:只剩预置表与 _prisma_migrations
      前半段两张表 —— 未建成
      那个 CHECK   —— 未留下                          ← 整个文件被回滚
```

旁证两条:本批 **零个** migration 使用 `CONCURRENTLY`(唯一不能进事务的例外);
**19 个** migration 自己还写了 `BEGIN;`。

⇒ **观察准确**(被点名的五个确实没写 `BEGIN`),**推论错误**(没写 ≠ 没事务)。
沿 SOP §1.5:**结论属实不等于机制正确** —— 本例是机制错导致结论也塌。

### ② BLOCKER「业务复合锚点未闭合」—— **已确认属实**

`ActivityParticipationIdentity` / `AttendancePunchEvent` / `ParticipationLedgerEntry` /
`OfflinePackageParticipant` 等表同时保存多个业务锚点(activity / session / member /
identity / position / revision),但**只有部分关系用了复合外键**,其余是单列 FK。

⇒ 数据库只证明「这些 ID 各自存在」,**不证明「它们属于同一条业务主链」**。

**这不是 Prisma/PostgreSQL 的能力限制** —— 同一张表里 `session` 与 `offlinePackage`
已经在用复合外键;而 `ActivityParticipationIdentity` 上**已存在**
`@@unique([id, activityId, sessionId, memberId])`,正是做复合 FK 所需的锚点,**建好了却没被引用**。

🔴 **这条必须转成 B / C / D 包的一个问题**(见 §2 各包「重点问过」新增项):

> 数据库**并不保证**这些组合合法。请找出**哪些代码路径依赖了数据库不提供的保证** ——
> 即:service 层是否在每个写入口都补上了跨活动 / 跨场次 / 跨队员的组合校验?
> 有没有哪条路径(尤其是导入、批量、worker、离线包)默认「有外键所以不用查」?

⚠️ **不给这条,B/C/D 的评审员可能反向假设「数据库已经保证了」,从而漏掉真正的缺口。**
这是本节存在的主要理由。

### ③ 两条 SHOULD-FIX —— **已确认属实,待修**

- `20260820100000` 的回填用 `COALESCE(p."realName", m."displayName")`,
  **未处理空白串**(`'   '` 会优先于有效值);随后只查 `IS NULL`,照样通过。
  建议 `COALESCE(NULLIF(BTRIM(...), ''), ...)`。
- `member_official_portraits.version` schema 注释写明「从 1 起」,
  但四条 CHECK 里**没有 `version >= 1`**,`0` / `-1` 均可入库。

---

## 0-pre-2. 投放并行性

**A 包已完成 ⇒ 其余五包(B / C / D / E / F)可并行投放。**

原 §4 的「A 先投 → F 第二 → …」顺序,其目的是「A 若有 BLOCKER,后面几包的前提就变了」——
**该目的已达成**。B–F 之间**无真实依赖**:F(判据)排在前面是**本仓判断「CI 全绿算不算数」**
所需,不是评审方的前置。

⇒ 并行的唯一前提:**每包都带上 §0-pre 的三条已确认事实**。

## 0. 为什么必须切包

| 项 | 读数 |
|---|---|
| 距上次全仓评审(`v0.57.0`,2026-07-17) | **9 个小版本 / 一个多月** |
| `v0.66.0..main` | **182 个提交** |
| 全部改动 | 1,037 文件 / 336,766 行 |
| **剔除生成物后的真实代码** | **579 文件 / 119,715 行** |
| 其中生成物(openapi / clients / ROUTE_AUTHZ / contract 快照) | 15 文件 / 125,903 行 |

🔴 **119,715 行不能整包投。** 任何模型面对这个体量都只会给出泛泛结论 ——
那正是 SOP §1.5 所述失效模式的镜像:「单 PR 看不见跨 PR 的结构性问题」,
而**包太大则连单点问题也看不见**。

⇒ 切成 **6 个包**,每包独立投放、独立收 findings。**包与包之间不共享上下文**,
所以每包必须自带「这批在干什么」。

## 1. 切包依据(按风险 × 体量,不按目录美观)

各路径实测,**生产代码与测试分列**(测试也要看,但问法不同):

| 路径 | 生产代码 | 测试 |
|---|---|---|
| `prisma/schema.prisma` | 1 文件 / 2,833 行 | — |
| `prisma/migrations` | 22 文件 / 5,524 行 | — |
| `src/modules/activities` | **109 文件 / 30,380 行** | 35 文件 / 7,577 行 |
| `src/modules/activity-registrations` | 54 文件 / 13,889 行 | 24 文件 / 4,653 行 |
| `src/modules/attendances` | 57 文件 / 12,846 行 | 15 文件 / 1,591 行 |
| `src/modules/attachments` | 23 文件 / 5,418 行 | 12 文件 / 4,702 行 |
| `src/modules/members` | 14 文件 / 1,997 行 | 7 文件 / 1,266 行 |
| `src/common` | 11 文件 / 2,636 行 | 6 文件 / 1,649 行 |
| `scripts` | 18 文件 / 15,594 行 | — |
| `src/modules/auth` | 9 文件 / 788 行 | — |
| `permissions` + `authz` + `role-bindings` | 20 文件 / 287 行 | — |

## 2. 六个包(体量均为**复算实测值**)

### 包 A —— schema + migration(**最高风险,最小体量,先投**)

```
范围:v0.66.0..main -- prisma/schema.prisma prisma/migrations
体量:23 文件 / 8,357 行 · 22 个新 migration
```

**为什么排第一**:D 档不可逆。migration 一旦 deploy 到生产就回不去,
而本批 **22 个 migration 一个都没在生产跑过**。缺陷代价最高、修复窗口最短。

**重点问过**:
- 22 个 migration 的**顺序依赖**:干净库从零重放能过吗?有没有隐式依赖前一个 migration 的数据状态?
- **不可逆操作**(DROP / 改类型 / 加 NOT NULL):有没有在**非空库**上会炸的?
- 新增 unique / partial unique 的**软删语义**:软删行是否仍占用唯一键?
- `Member` 的 `displayName → realName/nickname`(#1096):
  改名 migration **是否带数据搬运**,还是只改了列名?
- 新增外键的 `onDelete` 是否与业务语义一致(`Restrict` / `SetNull` / `Cascade` 各自的后果)?

### 包 B —— 活动 v1.1 结算真相链(**体量最大,业务最重**)

```
范围:v0.66.0..main -- src/modules/activities
体量:生产 109 文件 / 30,380 行(测试 35 文件 / 7,577 行)
对应:活动业务改造 v1.1 第 0–7 批(#905 / #906 起,至 #1079)
```

**背景**(投放时必须一并给):这是一份**冻结业务合同**的实现,合同在
`docs/archive/reviews/activity-business-overhaul-v1.1/`。核心是把结算真相链
(打卡 → 服务段 → 封场 → 结算 → 账本 → 关账 → 更正)整体重做;
**新旧链由单一开关 `ACTIVITY_V11_WORKFLOW_ENABLED` 原子切换**(默认关闭,尚未开)。

**重点问过**:
- **开关两侧的一致性**:开闸后旧写入口全部 410、读面改从已 committed 账本取数 ——
  有没有哪条读路径**忘了跟着切**,导致开闸后读到旧真相?
- **根锁序**:所有 `PunchEvent` 写与整单取消是否真的串行在同一 Activity 根锁上?
- 抽奖 / 排序录取(`rank` / `lottery`)的 **prepare / commit / void** 三段:
  中途失败是否零写?重放是否幂等?
- 容量预留(`CapacityReservation`)与 pointer / population 投影是否在**同一事务**?
- 🔴 **A 包已确认:数据库不保证跨活动/场次/队员的组合合法**(§0-pre ②)。
  ⇒ 请找出**哪些代码路径依赖了数据库不提供的保证** —— service 层是否在每个写入口
  都补上了组合校验?有没有路径默认「有外键所以不用查」?
- ⚠️ **已知缺口,不必重复报**:「终审改为提交 `LedgerPostingBatch`」那座桥**尚未实施**;
  未搭之前开闸,历史 approved 考勤不会出现在账本读面(已登记 `NEXT_TASKS` 第 7 批②)。

### 包 C —— 报名 + 考勤 runtime

```
范围:v0.66.0..main -- src/modules/activity-registrations src/modules/attendances
体量:生产 111 文件 / 26,735 行(测试 39 文件 / 6,244 行)
```

**重点问过**:
- 报名 create / approve / **递补**:锁后是否重验 live + ACTIVE?`reopen` 是否只回 pending?
- 打卡**离线包**(OfflinePackage):token 由 `JWT_SECRET` 经 HKDF/HMAC 域隔离、库内仅存 digest ——
  重放窗口、时钟偏移(`deviceTime` 验 60 秒凭据)有没有可利用面?
- 批量 / CSV 导入:worker fence 与 `AttendancePunchCommandService` **单一写入口**是否真的没被绕过?
- 邀请 accept 复用 canonical Form / 资格 / 保险 / 身份 / 容量链 —— 有没有哪条校验被跳过?
- 🔴 **A 包已确认:打卡事件的 identity / position / member / QR 凭据均为单列外键**(§0-pre ②),
  数据库允许「活动 A 的打卡引用活动 B 的 identity」。⇒ **导入 / 批量 / worker / 离线包**
  这四条路径是否各自补齐了组合校验?哪条最容易漏?

### 包 D —— 身份主档 + 视觉身份

```
范围:v0.66.0..main -- src/modules/members src/modules/users src/modules/attachments src/modules/team-join
体量:生产 55 文件 / 7,718 行
对应:issue #1048 T1–T4(#1096 / #1099 / #1100 / #1104)+ issue #1055 T1–T2(#1106 / #1108)
```

**背景**:`Member.displayName` 退役,`realName` / `nickname` / `memberSinceDate` /
`memberOriginCode` 上位;新建 `MemberOfficialPortrait`(队员标准照版本表)与
`User.avatarAttachmentId`;引入 `sharp` 做服务端图片解码 / EXIF 清除 / 重编码。
**这是一次对外契约破坏**,前端尚未投用,故刻意不做兼容层。

**重点问过**:
- `displayName` 是否**真的零活跃引用**?
  ⚠️ `RbacRole.displayName` 与 `AttachmentTypeConfig.displayName` 是**同名不同物**,不算数。
- `MemberReferenceResolver` 四态(`MATCHED` / `NOT_FOUND` / `AMBIGUOUS` / `CONFLICT`):
  **nickname 是否真的永远不能自动返回 `MATCHED`**?解析是否限定在调用者可见组织范围内(防跨范围枚举)?
- `MemberDirectory` 五级排序是否**绕过了 scoped authz**?
- 新引入的 `sharp`:图片解码是否有**资源耗尽面**(超大像素 / 恶意压缩比)?
  EXIF / GPS 清除是否**可断言**而非声称?
- generic attachment API 对两个新 ownerType 是否**真的 fail-closed**?
- 🔴 **A 包已确认:标准照 `version` 无 `>= 1` 约束**(§0-pre ③)。
  ⇒ 代码侧的「按 Member 单调递增、不复用不回退」是否**只靠行锁 + 读当前最大值**?
  并发下会不会产生 0 或负数?
- ⚠️ **已知设计选择,不必重复报**:`memberSinceDate` / `memberOriginCode`
  **建档可设、之后不可改**(`UpdateMemberDto` 刻意不暴露),维护者拍板靠流程而非接口订正。

### 包 E —— auth / 权限 / authz / common(**小而关键**)

```
范围:v0.66.0..main -- src/modules/auth src/modules/permissions src/modules/authz
      src/modules/role-bindings src/common src/bootstrap src/config
体量:生产 45 文件 / 3,798 行
```

**为什么单独成包**:体量小,但每一行都在信任边界上 —— 混进大包会被淹没。

**重点问过**:
- 新增的 step-up proof(`PHONE_BIND` 等)是否 **action-bound**?能否跨 action 复用?
- **时钟权威**改造:有没有写路径漏了显式写时间、退回库时钟?
- `APP_TRUSTED_PROXY_CIDRS` 的解析与使用:反代场景下客户端 IP 是否可伪造?
- 新增 BizCode / 权限码是否都有**真实消费者**(不是只登记不接线)?

### 包 F —— 治理层 / 判据 / harness(**评审「裁判」本身**)

```
范围:v0.66.0..main -- scripts eslint-rules harness .github/workflows
体量:生产 37 文件 / 28,645 行
      ⚠️ 比直觉大得多 —— 仅 scripts/ 一处就占 15,594 行
```

**为什么必须单独投**:这些是**判据本身**。SOP §1 把「harness 文档重写 / workflows」
列为必须评审项,理由是 —— **不锁住裁判,任何违规 PR 都能顺手把检查改成恒 PASS**。

**重点问过(与业务包问法不同)**:
- 新增 / 修改的判据,**有没有正对照**?即「构造一个应该红的输入,它真的红吗」?
- 有没有判据是**恒 PASS** 的(拿生成器输出跟生成器输入比 / 断言恒真)?
- 判据的**扫描面**是否覆盖它声称覆盖的范围?(真实先例:只扫 `create` 漏掉 `update` 家族)
- CI 工作流:`needs` 依赖失败导致的 `skipped` 是否被当成通过?
- ⚠️ **已知缺口,不必重复报**:`P2-8`(bootstrap 报错文案合并两种失败因)、
  `P2-9`(通知 outbox 守卫误判随机 id)、`P2-10`(`SENT` ≠ 已送达),均已登记待修。

## 3. 投放模板(每包一份,把 `<X>` 换成包名与范围)

> 请评审 SRVF API 的 `<范围>`(第六轮全仓评审 **包 <X>**)。
>
> **这批在干什么**:`<粘贴对应包的「背景」段>`
>
> 要求:
> ① 找**正确性 / 安全 / 并发**问题,每条给「文件:行号」证据;
> ② 对照 `AGENTS.md` §1 铁律速查与 §2 决策锁,标注任何违反;
> ③ 重点看:`<粘贴对应包的「重点问过」清单>`;
> ④ 结论分级 **BLOCKER / SHOULD-FIX / NIT**;**没有问题就明说,不要凑数**;
> ⑤ 「已知缺口」里列出的**不必重复报**,但若你认为定性有误请说明。
>
> 🔴 **已确认事实(A 包产出,已经本仓复核,请勿重复报)**:
> `<粘贴 §0-pre 的三条>`
>
> ⚠️ 本包是全仓评审的一部分,**其余部分另投**。不要因为看不到其他模块就假设那里有问题,
> 也不要把「本包外的代码没读到」写成 finding。

## 4. 投放顺序与理由

```
A(schema/migration)→ F(判据)→ E(auth/权限)→ D(身份)→ C(报名考勤)→ B(活动)
```

- **A 先投**:不可逆、体量小、缺陷代价最高。它若有 BLOCKER,后面几包的前提就变了。
- **F 第二**:判据是其余包的评审基础设施。判据本身若失效,其余包「CI 全绿」的说服力打折。
- **B 最后**:体量最大且依赖 A / C 的结论。先看完小包,投 B 时能带上已确认的事实。

## 5. findings 处置

沿 SOP §3:落点统一 PR 评论,总控逐条消化;**分歧不内部调和** ——
两模型结论相反时原样升级进人话简报由维护者裁(分歧点 = 维护者注意力的优先级信号)。

⚠️ SOP §1.5 的额外一条,本轮尤其要守:
> **报告里的机制描述必须自己复现后再采信** —— 结论属实不等于机制正确,
> 照着错的机制去修会修错地方。

⚠️ SOP §1.6:**本轮 findings 的修复批次,自己也要再过一轮**。

## 6. 本轮的已知偏倚(投放时应知)

`v0.66.0..main` 的 182 个提交中,**绝大多数由 Claude 会话完成,或由 Claude 起草的 goal 驱动**。
自评审在这种情况下价值显著打折 —— 依据 SOP 所本的公理 A5:
**同一模型自写自查,错误相关会一起漏**。

⇒ 本轮**明确选择跨模型评审,不做自评审**。

## 7. 投放进度 —— **六包全部回收完毕(2026-08-20)**

全部投放至 ChatGPT Pro,B–F 五包**并行**跑,每包带 §0-pre 三条已确认事实。

| 包 | BLOCKER | SHOULD-FIX | NIT | 状态 |
|---|---|---|---|---|
| A schema+migration | 3 → **2**(1 条**实测证伪**) | 2 | 0 | 修复刀已起草 |
| B 活动 | **3** | — | — | B-01 修复中;B-02 修复中;B-03 并入 A-2 |
| C 报名+考勤 | **1** | 3 | — | 修复中 |
| D 身份+视觉 | **0** | 5 | 1 | 待处置(无 BLOCKER) |
| E auth/权限/common | **1** | 1 | 0 | ✅ **已修并合入** |
| F 判据/harness | **1** | 0 | 0 | 判据缺口属实,**零实例**;待修 |

**净结果**:7 条 BLOCKER 中 —— **1 条证伪**、**1 条已修**、**1 条零敞口**、**4 条修复中**。

---

## 8. findings 定性留档(**主会话逐条复核后的结论,非报告原文**)

> 沿 SOP §1.5:**报告里的机制描述必须自己复现后再采信**。
> 下列每条都标注了主会话的复核方式与读数;**未复核的明确写「未复核」**。

### 8.1 🔴 已实测证伪:A 包「migration 没包事务,失败留下半套 schema」

原报告推论链依赖前提「Prisma 不自动包事务」。**该前提不成立。**

**复核方式**:建独立探针库 → 写一个**不含 `BEGIN/COMMIT`** 的 migration
(前半段建两表、末尾对既有表加 CHECK)→ 预置违反该 CHECK 的脏行 → `prisma migrate deploy`。

```
Error: P3018 · Database error code: 23514
  check constraint "..." is violated by some row     ← 失败如期发生
库内:只剩预置表与 _prisma_migrations
      前半段两张表 —— 未建成
      那个 CHECK   —— 未留下                          ← 整个文件被回滚
```

旁证:本批**零个** migration 用 `CONCURRENTLY`(唯一事务例外);**19 个**自己写了 `BEGIN;`。

⇒ **观察准确**(被点名的五个确实没写 `BEGIN`),**推论错误**(没写 ≠ 没事务)。

🔴 **不要照它去给 22 个 migration 补事务** —— 那是在修一个不存在的问题。

### 8.2 ✅ 已修:E-B1 控制面提权(`wecom-setting.reset.credentials`)

**复核方式**:读单一事实源 `RBAC_SEED_FACTS` 的**真实数据**(非注释)。

链条三段全部坐实:① 保留集恰 6 条不含 wecom;② 该码已 seed 成 Permission 可被授予;
③ `WecomSettingsService.resetCredentials` 无 SUPER_ADMIN 兜底(只有审计字段 `actorRoleSnap`)。

⇒ 持 `rbac.role-permission.create` 的 ops-admin 可自授该码,再覆盖 CorpSecret。

⭐ **真根因比报告更准**:`prisma/seed.ts` 里同族五条,四条走共享谓词
`isNotReservedSuperAdminOnlyPermission`,**只有 wecom 那行**写成
`filter((p) => p.code !== WECOM_RESET_CREDENTIALS_CODE)` —— 全仓仅此一处不走共享谓词。

⚠️ **而这个 bespoke 过滤器行为完全正确** —— ops-admin 确实没被绑上,seed 数据一行不差。
**正因为没有任何症状,「保留集永远学不到 wecom」这件事没有任何东西会报警。**

**已修**(#1115):改回共享谓词;并新增机器闸 —— 全仓每个 `*.reset.credentials`
码必须在保留集内,扫描面**动态现取**、漏一条即红并点名。三条变异实测已贴 PR。

### 8.3 🟡 判据缺口属实,但**零实例**:F-B01 R8 deny 分支可被冒充

**复核方式**:直接调 R8 的 `hasThrowOrReturn()` 判据,喂两段代码。

```
样本 1: if (!allowed) { if (other) { return; } }   ⇒ 判定「有 deny 分支」  ← 语义上会漏过
样本 2: if (!allowed) { throw new Error(...); }    ⇒ 判定「有 deny 分支」
```

**判据分不出真假 deny** —— 属实。

⭐ **但又扫了全仓**:所有「授权否定式 + deny 分支」的实例,**终止都是直达的**,
「非直达终止」实例 **0 处**。

⇒ 准确定性:**未来的防线漏洞,不是当下的授权洞**。两本账不能混
(判据缺口 ≠ 风险敞口)。

### 8.4 ✅ 已坐实,且比报告更严重:B-01 参与真相读面漏接闸

报告点名一处。**主会话复核发现是三处。**

| 读面 | 接闸命中 |
|---|---|
| `attendances/participation-summary-query.service.ts` | **3** ✅ |
| `activities/activity-participation-query.service.ts` | **0** ❌ ← 报告点名的 |
| `meta/participation-overview-query.service.ts` | **0** ❌ |
| `team-join/team-join-progress.ts` | **0** ❌ |

⭐ **第四处后果最重**:它算的是 `CONTRIBUTION_THRESHOLD` / `contributionCutoff` ——
**入队资格判定**。开闸后入队门槛会继续用旧真相判,不只是某个页面显示错数字。

### 8.5 ✅ 已坐实:B-02 批任务状态变更漏 fence

**复核方式**:逐处检查 `activity-batch.worker.ts` 的 job/item 写操作。

`:781` 用 `updateMany({ where: { leaseOwner, leaseGeneration, ... }})` ✅;
`:761` `:859` `:871` `:884` 四处用 `update({ where: { id } })` ❌。

⇒ **同一文件里一处带 fence、四处不带**。不是能力限制,是不一致。

⚠️ 报告称「`preparedCount` 是累加式投影,所以幂等消不掉竞态」——
**主会话未复核该机制**,已在修复 goal 里要求实施方自行核实并按实测修正后果论述。

### 8.6 ✅ 已坐实:C-1 递补路径漏锁后重验

`promoteAfterCancellationInTransactionTrusted()` **零处**检查 Member 仍 ACTIVE,
而**同文件 `:1379`** 与另外三条兄弟路径都查。

⇒ 同文件、不同路径、写法不一致 —— **遗漏而非设计选择**(最硬的证据形状)。

### 8.7 ✅ 已坐实(抽验):D 包 SHOULD-FIX 2 —— trim 口径不一致

写入端 `realName!: string` 只有 `@IsString()` 无 trim;
查询端 `member-reference-resolver.ts:155/164` **两处都 trim**。
⇒ 存 `"张三 "`、用 `"张三"` 解析对不上。

**D 包 0 BLOCKER**,是六包里最干净的一份。其余 4 条 SHOULD-FIX + 1 NIT **未逐条复核**。

### 8.8 ⚠️ 未复核的 findings(**不因未复核就当不成立**)

- A 包:BLOCKER-3(离线包信任链)、两条 SHOULD-FIX 中的细节论证
- B 包:B-03 的完整论证(已并入 A-2 修复刀)
- C 包:三条 SHOULD-FIX(CSV `itemKey` 排序、10k 行 `createMany` 撞 bind 上限、
  bulk/import 对 `terminated` 活动的拒绝口径)
- D 包:除 8.7 外的 4 条 SHOULD-FIX + 1 NIT

⇒ 这些在起草对应修复刀时**逐条过**,不因「本轮没验」而当作不成立。

## 9. 本轮的方法论收获

1. **切包是对的**。119,715 行整包投必然只得到泛泛结论;切成 6 包后,
   每包都给出了带「文件:行号」的具体 finding,**NIT 总数为 1** —— 没有凑数。
2. **把 A 包结论前喂给 B/C/D 起了作用**。B-03 与 A-2 被独立指认为同一根因,
   C 包主动去查了「导入/批量/worker/离线包四条路径」—— 正是前喂那条追问要的。
3. **「结论属实 ≠ 机制正确」再次应验**,而且这次更进一步:机制错导致结论也塌(8.1)。
4. **判据缺口与风险敞口是两本账**(8.3)。混为一谈会导致优先级排错。
5. **最值钱的两条 finding 都是「同文件里两种写法并存」**(8.5 / 8.6)——
   有人写对过一次,后来的人没照抄。这个形状值得单独做成扫描项。

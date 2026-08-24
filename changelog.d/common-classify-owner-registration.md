### `src/common` 三件定性 —— 登记 owner 不搬走,并给「登记」补上它一直没有的执行位(R15)

维护者 2026-08-25 拍板:`activity-workflow` / `identity` / `security` 三个此前 ⏳ 待定性的
`src/common` 子目录,全部照 `member-advisory-lock` 先例办理 —— **登记 `ownerDomain` 而非搬走文件**。

| 文件 | `ownerDomain` | 定性依据 |
|---|---|---|
| `activity-workflow/activity-workflow.gate.ts` | `participation` | 编码「活动 v1.1 新旧真相链走哪条」的业务真相切换;闸控的 `Activity` / `ActivityCheckIn` / `AttendanceSheet` / 账本 / 关闭 / 更正在 `modelOwnership` 里**全部**属 participation |
| `identity/member-label.util.ts` | `identity-org` | 队员展示名的业务展示格式(含「外号全空白不显示括号」这条业务判定) |
| `identity/member-origin.constant.ts` | `identity-org` | `Member.memberOriginCode` 的业务词汇表,跨 seed / 招新转入 / 管理员建档三个运行时共享 |
| `security/role-permission-step-up-proof.ts` | `platform-access` | 绑定三元组 `roleId` / `permissionRevision` / 权限码集合指纹 |

⭐ **`security` 那条是按「绑定什么」判的,不是按「长什么样」判的。** 它形态上百分之百是技术件
(HMAC/HKDF + JWT 薄封装、零 Prisma、零 model 名、零模块入边,R15 三条自动判据逐条为 0)——
按形态判会判成技术件,而那正是 `COMMON_GOVERNANCE.md` §3.2 自己写下要挡的判法:
**「合理的理由」不等于「定性为技术件」**。

#### 🔴 本刀的主交付不是登记表多四行,是「登记之后机器多守住了什么」

先说结论:**光登记,机器一点没多守。** `kernel.primitives` 在此之前只被比过一次**名字集合**
(`check-boundaries.ts` 的 `expectedPrimitives`)—— 没有任何判据验过登记的 `path` 还在不在、
`ownerDomain` 是不是个真域,更没有任何判据**用**这张表去约束 `src/common` 的文件。

实测把这句话钉成读数(登记前,`origin/main` = `28d1813c`):往 `src/common/identity/` 新建一个
零 Prisma、零模块入边的业务 helper,与把**同一个文件**放进 `src/modules/members/` 相比,
12 条静态判据的红集**逐条相同** —— 都只有 `docs:authz:check` / `docs:codemap:check` 两条
**陈旧型**红,`pnpm docs:refresh` 一刷全绿。⇒ 当时**没有任何判据**在看「common 子目录里的文件
有没有被定性过」。

R15 §3.2 早把这个缺口写在纸上,只是没人接执行位:

> 挡不住「另建 `src/common/security/` 下的第二个文件」—— 新子目录由本表这条集合相等断言接住,
> 但**同一子目录内新增文件仍是「人得看一眼」的那一步**。

#### 交付的执行位:有主子目录的**文件级闭包**

`scripts/check-boundaries.ts` 新增 `kernelOwnershipErrors()`,挂在 `--metadata`
(CI 的 `pnpm docs:boundaries:check`,A 类元数据闸,**无 `|| true`**):

- **有主子目录**(`src/common/<sub>/` 下至少有一个文件登记为 kernel primitive)从登记表**推出来**,
  不写第二份名单;
- 有主子目录里每个非 `*.spec.ts` 的 `.ts` 必须要么是 primitive(业务内核),
  要么在新增的 `kernel.commonTechnicalArtifacts`(技术件);
- 登记的 `path` 必须真实存在、`ownerDomain` 必须是 `domains` 里的真域;
- **两个方向都比**(同 `expectedPrimitives` 的 missing / unexpected 范式),
  同一文件不得既是 primitive 又是技术件。

#### ⭐ 保护面前后对照(本机实测;判据恒为「**做错时 CI 会不会红**」)

| # | 越界写法 | **前** | **后** |
|---|---|---|---|
| 1 | 往 `src/common/identity/` 新建未定性业务 helper | 只有 authz / codemap 两条**陈旧型**红,`docs:refresh` 一刷即全绿 | `docs:boundaries:check` **EXIT 1**,逐字点名该文件 |
| 2 | 同上,落在 `src/common/security/`(§3.2 逐字点名的缺口) | 全绿 | **EXIT 1**,点名该文件 |
| 3 | 同上,落在 `activity-workflow/` 或 `prisma/` | 全绿 | **EXIT 1**,点名该文件 |
| 4 | 把已登记文件改名 / 搬走而不改登记表 | 全绿(登记表变成假话,没人验) | **EXIT 1**:`kernel.primitives path does not exist: …` |
| 5 | `ownerDomain` 打错字 | 全绿 | **EXIT 1**:`kernel.primitives unknown ownerDomain: …` |
| 6 | 把 `kernel.commonTechnicalArtifacts` 整块删掉(想关掉闭包判据) | — | **不会变绿**:`kernel.commonTechnicalArtifacts must be an object`(fail-closed) |

**反向样本**(判据没有过度绑定):把 ① 的探针登记进 `commonTechnicalArtifacts` ⇒
错误数 4 → 3、**恰好那一条消失** —— 判据判的是「未定性」,不是「新文件」。
对照组探针(`src/modules/members/`)在任何一轮变异里**都没被点过名**。

变异后树已逐字节还原:`git diff --numstat harness/domain-map.json` = `50 0`(纯新增),
全仓 `grep -ran 'cls28d\|CLS28D'` 命中 0。

#### ⚠️ 射程边界,别读大

本判据只覆盖**有主**子目录。`decorators` / `guards` / `dto` 等整目录技术件**不在射程内**,
仍由 `harness-guards.selftest.ts` 的**子目录**集合相等断言 + §3 人工定性接住。
一条判目录、一条判文件,两件事,互不顶替。

不把闭包铺到全部 15 个子目录是**选择不是疏漏**:那要一次性把 41 个文件逐个登记,
而其中大半从没人真的逐个看过 —— **照抄进登记表等于把「没看过」包装成「已定性」**。

#### 顺带订正的过期事实(动手才发现,与文档原文不符)

- `COMMON_GOVERNANCE.md` §3.1 写的「`activity-workflow`(3 文件)」在 `#1165` 之后已是 **2** ——
  `activity-workflow-gate.criteria.ts`(766 行)的实质逻辑搬进 selfGuard、该文件被删。
  派生的「扫描面 **42**」随之订正为 **41**。这是本文件自己记过的「数字漂移」缺陷类的又一次复发:
  **搬走一个文件时,引用它的计数没人回头改**。
- 三条自动判据读数一字未变(`businessTableAccess 6` / `businessPredicate 0` /
  `moduleImportEdges 0` / `rawSqlDynamic 1`),本刀不动 §2.2 的 6 条债务基线、不翻 report→blocking。

#### 顺带登记(不实施)

`NEXT_TASKS.md` 新增 **P2-19**:`feedback.eligibilityCorrected` 在真更正链上**结构性恒 `false`**
(`wasEligibleBeforeLatestClosure()` 找旧 closure 的结果行时带 `statusCode: 'committed'`,
而更正 commit 事务把旧行一律置 `superseded`)⇒ 那句说明文字永不显示。
维护者 2026-08-25 拍板**现在不修**(前端未上线、收益为零,且它在活动结算核心链上),
建议修法 = **改判据**(查询接受 `superseded`)而不是改投影。
⚠️ 真正的闸 `canSubmit` 工作正常,**不是安全问题**。

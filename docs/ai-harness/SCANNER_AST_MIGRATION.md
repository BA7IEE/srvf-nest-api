# 扫描器 typed-AST 化 —— 能力对比与 R8 重扫报告

> 状态：Phase 3 **前置**收口。三个扫描器已 typed-AST 化，**未转任何规则为 blocking**。
> 依据：v4 §7 EC-COMMON 第 3/4 条、终审【九】（债务终局身份 = call-site 结构身份）。
> 口径：本文所有数字均为本 lane 实测，非引述。

## 1. 一句话结论

三个扫描器**都不是正则**——它们本来就是语法 AST（`ts.createSourceFile`），靠的是**名字启发式**。
真正的缺口是**未 typed**。typed 化后，本仓当期读数几乎不变（+1 条 / +0 条 / ±0 条），
**收益是免疫力，不是当期发现**：本仓恰好在命名与 DI 上高度一致，名字启发式因此"看起来准"，
但它对任何一次改名都不设防。能力差距只能用对抗样例证明，不能用实仓读数证明。

## 2. 能力对比表（横轴 = 语法 AST + 名字启发式 **vs** 类型 AST）

### 2.1 R5/R6 数据访问（`scripts/check-boundaries.ts`）

判据锚点从「接收者叫不叫 `prisma`/`tx`/`client`/`db`」换成「该成员访问的**类型**是否恰好解析到
一个生成的 `<Model>Delegate`」。锚在 delegate 而非接收者，四类绕过一次性全部结构不可达。

| 对抗样例 | 名字启发式 | 类型 AST |
|---|---|---|
| 直接访问 `prisma.member.create` | HIT | HIT |
| **变量中转** `const anythingAtAll = prisma; anythingAtAll.member.create` | **miss** | HIT |
| **解构** `const { member } = prisma; member.create` | **miss** | HIT |
| **import 别名** `import { PrismaClient as Renamed }` | **miss** | HIT |
| **re-export** 经中转文件再导出 | **miss** | HIT |
| tx 参数改名 `(handle: Prisma.TransactionClient)` | **miss** | HIT |
| 窄口 port `interface AudiencePort { member: MemberDelegate }` | **miss** | HIT |
| 计算属性（字面量键）`prisma['member']` | HIT | HIT |
| 负样例：同形但非 Prisma 的 interface | **误报** | 正确忽略 |
| 负样例：同形 inline 类型且变量名叫 `db` | **误报** | 正确忽略 |

**正样例 8/8 vs 2/8；负样例 2/2 vs 0/2。** 全部固化在 `scripts/harness-guards.selftest.ts`，
且走 `check-boundaries.ts` 导出的 `probeDelegateResolution`（与生产同一条代码路径，
不是自测里重写的副本 —— 重写一份的话解析器退化了自测照样绿）。

**实仓读数：511 → 512 条，0 条消失。** 唯一新增 = `notification-sms-dispatch.service.ts:371`
的 `audienceClient.user.findMany`（`audienceClient` 不是 `client` 的整段匹配，旧启发式看不见）。

### 2.2 R2/R3 依赖图（同文件）

依赖图**本来就是 AST**（`ts.isImportDeclaration`）。它漏的是另外三种形态，而这三种在本仓
**实测各 0 条**：

| 形态 | 本仓实测 | 处置 |
|---|---|---|
| 跨域 `export … from`（re-export） | **0** | 已补解析 + 正样例；「当前为 0」写成断言 |
| 跨域动态 `import()` | **0** | 同上 |
| 跨域 `import = require()` | **0** | 同上 |

维护者拍板降级为「覆盖面证明」小刀：不改判定，只证明解析器认得它们，并把「当前为 0」
钉成断言 —— **第一条真出现时自测即红**（本仓「此刻不存在型判据必须写明到期条件」范式）。
findings **512 → 512，零变化**，正是预期。

**type-only 边**：623 条跨域边中 179 条（29%）是 `import type`，41 条 R2 违规中 4 条是。
按拍板**照算并打 `typeOnly` 标记**，不静默豁免 —— 其中 3 条正是 v4 §4 要求恒 0 的
`platform-access→participation` 反向边，静默豁免会让"恒 0"当场变成假话。标记保留了
将来一行配置切换豁免的可能，信息不丢。每条边同时带 `form` 字段。

### 2.3 R8 声明↔实现闭环（`eslint-rules/authz-declaration-closure.mjs`）

注入依赖原按**注解文本**与登记的 `receiverTypes` 比对；改为按类型在**声明处**的名字判定。
`import { AuthzService as A }` / re-export / 局部 `type X = AuthzService` 改名后不再误判整端点。
解析不出类型时回落注解读法，不会静默漏报。

**重扫分布与 Phase 1 逐项相同**：

| | Phase 1 | 本次（typed） |
|---|---|---|
| T1 | 4 | 4 |
| T2 | 2 | 2 |
| T3 candidate | 113 | 113 |
| N/A | 9 | 9 |
| 总计 | 128 | 128 |

119 条 warning 的**理由字符串逐条相同**（`diff` 为空）。

**为什么没有 T3→T1/T2 迁移**：实测本仓**无别名导入、无 `@Inject()`、无缺类型注解的构造参数**，
名字读法没有任何活的反例。且 T1/T2 的边界是 v4 的**政策**（handler + 同模块一层），
不是技术限制 —— typed 化不会、也不应该把更深的调用链变成"可判"。

## 3. 三个扫描器的共同结论

| | 当期读数变化 | 对抗样例证明的能力差 |
|---|---|---|
| R5/R6 | +1（511→512） | 正 8/8 vs 2/8，负 2/2 vs 0/2 |
| R2/R3 | 0（512→512） | 三形态各 0 条实存，解析器已覆盖 |
| R8 | 0（分布逐项相同） | 别名改名样例：typed 通过，注解读法误判 T3 |

**三个都指向同一件事**：本仓在命名与 DI 上高度一致，所以名字启发式的当期准确率很高；
typed 化买到的是"改一次名就不设防"这条风险的消除。**Phase 3 转闸的理由应写成"判据不可
被改名绕过"，不能写成"typed 化发现了更多违规"** —— 后者会被实测数字当场证伪。

## 4. 债务身份迁移（终审【九】）

`callSiteId` 从 Phase 0 的 `hash(file | symbol | 序号 | 节点文本)` 升级为
`hash(file | 归一化 AST 路径 | 观察通道 | model | accessPath)`。

旧式的三个输入里有两个会因**不是"换了个调用点"**的原因而漂：`序号`是
per-(file, symbol) 计数器，同方法内**别的**发现增减就会移位；`节点文本`一改就换身份，
而那是 `shapeDigest` 的职责。新式按语法脊柱命名每一步，优先用声明自己的名字。

同一 AST 节点可合法承载多条债，故身份再带三项判别：
- 48 对：跨属主写 + 子域观察落在同一节点（不同观察通道）
- 1 对：一条 raw 语句命中两张物理表（不同 model）

**迁移自证**（`pnpm docs:boundaries:ids:check`，已成为常驻判据）：

| 项 | 值 |
|---|---|
| 台账总条目 | 222 → 222 |
| 具 call-site 身份的条目 | 201，**全部迁移**，`supersedes` 记旧 id |
| 域级 `undeclared-edge` 条目 | 21，**不适用**（无 call-site，非"迁移失败"） |
| 未匹配 / 歧义 | 0 / 0 |
| 新身份碰撞 | 0 |
| 除 `callSiteId`/`supersedes` 外发生变化的字段 | **无** |

迁移器在非一一对应时**拒绝写入** —— 强行迁移会把台账伪装成「旧债全消失 + 新债全出现」，
那正是真回归的形状。

## 5. Known gaps（typed 化后仍不可判，具名）

已同步更新 `harness/architecture-debt.json` 的 `knownGaps`（原文列的四类绕过已被证明关闭，
留着就是假话）：

1. 经 `any` 类型或无注解边界拿到的 Prisma 句柄解析不出 delegate，仍不可见。
2. 非字面量键的动态 delegate（`client[name]`）在类型上是**所有 delegate 的并集**；
   刻意**不归因到任意一个 model**，保持不可判（Phase 0 同样是跳过）。
3. 运行时模块加载（计算出的 `import()` 说明符、运行期 `require`）不解析。
4. 动态 `select`/`include`/`where` 形状无法证明归入任何读档。（未变）
5. 语义读只识别「静态时间窗 + 状态谓词」组合。（未变）
6. raw SQL 只匹配由 `@@map` / Prisma 默认表名派生的字面物理表名。（未变）
7. ~~**R8 的 `scope self` 判据缺失**~~ —— **已于 2026-08-14 的 `self-by-construction` 一刀
   部分关闭，见 §11**。当时「`self` 在本仓没有断言调用、由构造保证」的判断经复核**成立**；
   但当时预测「它需要的是**数据流判据**」**不准确**：实做证明**不需要**任何数据流追踪 ——
   在参数面上直接拒绝一切可作主体标识的调用方输入，既充分又严格更保守（连「可控 id 只流向
   资源位置」这种本可放行的情形也一并拒掉）。**剩余缺口换了形状**：不再是「没有判据」，
   而是 43 条里有 **18 条不可判**（8 `@Req` / 7 `@Param` 携带 `id` / 2 `@Body` 携带 `phone`
   / 1 `@UploadedFile`），其中 `@Req` 一类是**代码形态问题、不是判据问题**（见 §11.4）。
8. ESLint `no-restricted-syntax` 那一层（`eslint.harness.mjs` 内 5 条对抗样例）仍是**字面
   语法拦截**，其中就有 `const db = this.prisma; db.user.delete()` 这条中转绕过。
   本刀关掉的是**边界扫描器**里的同形缺口，**不是**那一层 —— 两层各自记账，别混算。

## 6. EC-COMMON 第 3/4 条达标声明

| 规则 | 第 3 条 typed-AST 化 | 第 4 条 四类绕过样例全绿 |
|---|---|---|
| R5 跨域写 | ✅ 已达标 | ✅ alias / destructuring / variable-forwarding / re-export 各有正样例，另加 tx 改名、窄口、计算属性，及 2 条负样例 |
| R6 跨域读 | ✅ 同上（同一解析层） | ✅ 同上 |
| R2/R3 依赖与环 | ✅ import 图 AST 天然可靠；四形态全覆盖 | ✅ re-export 正样例 + 三形态「当前为 0」到期闸（EC 表已注明 R2/R3 不适用第 5 条） |
| R8 T1/T2 | ✅ 已达标 —— 接收者**类型名**按声明处解析；接收者**表达式**的中转与解构均已覆盖 | ✅ 四类各一正一负，共 8 条样例 |

第 5 条（`$queryRaw` 通道）R5/R6 已纳入且接收者亦按类型判定。

### 6.1 R8 四类样例实测（收尾一刀补齐）

| 绕过类 | 正样例 | 负样例（形似但无后果分支，不得算断言） |
|---|---|---|
| 别名 | `type RenamedAuthz = AuthzService` → T2/closed | 同别名但裸调用 → T3/candidate |
| 中转 | `const svc = this.authz; svc.can(...)` → T2/closed | 同中转但裸调用 → T3/candidate |
| 解构 | `const { can } = this.authz; can(...)` → T2/closed | 同解构但裸调用 → T3/candidate |
| re-export | origin → hub → 探针（**真跨文件三段链**） → T2/closed | 同链但裸调用 → T3/candidate |

两处需要如实记账：

1. **中转本来就已支持**。上一版报告写「接收者表达式（中转/解构）仍不识别」是**错的** ——
   规则早有 `receiverAliases` 定点求解，中转正样例第一次跑就绿。真正缺的只有**解构**
   （`localBindings` 用 `ts.isIdentifier(node.name)` 过滤，`ObjectBindingPattern` 被丢掉）。
   本刀补的是解构一类，其余三类是**补样例、证明既有能力**，不是补能力。
2. **负样例落 T3/candidate 而不是 T2/mismatch**。没有任何观察命中时，规则连「够到了一层
   service」都没证成，于是诚实报不可判。两者都是「未获证明」，T3 更保守。样例钉的是
   **实测行为**，不是预期行为。

补完后**全仓分布不变**（T1=4 / T2=2 / T3=113 / N-A=9）—— 本仓没有解构接收者的实例，
与 D1/D2/D3 同形：新增的是免疫力，不是当期发现。

## 7. 本次未做

- **不转任何规则为 blocking**（转闸需观察期数据 + Exit Criteria 打勾单，另立项）。
- **不做 T3 标注补齐**（本刀只重扫出数）。
- **不做 R6 升级**（永久 report 已拍板）。
- ~~**`scope self` 数据流判据**（§5 第 7 条）~~ —— **已于 2026-08-14 另立一刀交付，见 §11**
  （形态与此处预测不同：是**参数面结构判据**，不是数据流判据）。本刀（Phase 3 前置）本身
  仍未消解那 43 条 T3。
- **`require:any` 的 OR 结构完整性**：现规则要求**每个**声明码都有对应断言（v4 逐码要求已满足），
  但**不验证这些分支确实是 OR 组合**。全仓仅 2 个端点声明 `require:any`，影响面已知且极小。
（CI 接线已于收尾一刀完成，见 §10。）

## 8. Phase 3 转闸的剩余前置

| EC-COMMON | 现状 |
|---|---|
| 1 baseline 冻结 + 棘轮 | ✅ 222 条持证；身份迁移后条目集恒等，新增 ids:check 常驻判据 |
| 2 known gaps 成文 | ✅ 本文 §5 + `architecture-debt.json.knownGaps` 已同步 |
| 3 typed-AST 化 | ✅ R2/R3/R5/R6/R8 全部（§6） |
| 4 四类绕过样例全绿 | ✅ R5/R6（10 条）+ R8（8 条，四类各一正一负） |
| 5 `$queryRaw` 通道 | ✅ 已纳入且按类型判定接收者 |
| 6 report 期误报逐条处理 | ❌ **未做** —— 需要观察期数据；本刀未新增误报（读数 +1/0/0） |
| 7 CI 连续稳定 ≥10 PR 或 ≥2 周 | ❌ **未开始计时** —— typed 版本刚落地 |
| 8 Journey 全绿 + zero-new-red | ❌ 本刀零 `src/**` 改动，但 Journey（1J）本身尚未立项 |
| 9 回滚路径一行开关 | ❌ **未做** —— 规则现为恒 report，尚无 blocking↔report 开关 |
| 10 错误信息五要素 | ⚠️ 部分 —— R8 消息含规则/位置/事实/处置，缺「引用 domain-map/manifest 的具体声明行」 |

**下一刀顺序（维护者 2026-08-14 拍板，非建议）**：~~`scope self` 判据~~ **已完成，见 §11**。

1. **给 §11.5 那 4 条「内存比对属主」端点加 e2e 行为锁**（C 档，可独立成刀，**最高优先**）。
   他人资源必须返 404 / 403，并**用变异证明**：删掉那行内存比较 → 用例必红。
   **目的不是改实现，是把「删一行无人知」变成「删一行必红」。**
   维护者定性：**这比转出 T3 重要得多**——它守的是真实越权风险，而 T3 只是可判性记账。
2. **`engine` 轴那 22 条先做归因、不做修复**（见 §11.2）。读那 22 条的实现，判定属于
   ① 判据过度要求（`engine` 非空 + `codes` 为空时不该强求 `authz.can`），还是
   ② **声明失真**（声明了 `engine: 'authz-scoped'` 但实际没走 authz 引擎）。
   **归因结论交拍板再定改哪边。** 若属 ②，修正会触发 R14 授权语义差异审批——
   **那是预期行为，不是障碍。**
3. 回滚开关 + 错误信息第④要素。
4. 然后才开始 EC 第 7 条的连续稳定计时。

（原列第一位的「补 R8 §6 缺口」已于收尾一刀完成。）

## 9. R8 的 113 条 T3 成因分布与标注工作量估算（交拍板）

按面：**app 103 / admin 10**。按失败轴的出现次数：engine 113 / scope 109 / admission 98 / code 18。

| 主因 | 条数 | 性质 | 处置成本 |
|---|---:|---|---|
| responsibility 断言不在 T1/T2 可达范围 | 58 | 断言在更深的 service 链里 | 逐条 `@AuthzChainVerified` 标注（每条须 reason/verifiedBy/reviewId/evidenceDigest + Environment 审批） |
| **`scope self` 没有任何已登记断言模式** | **43** | **已部分关闭（2026-08-14，§11）**：25 条 self 轴闭环 / 18 条不可判 | 已落地结构判据；剩 18 条见 §11.3 |
| visibility scope 下推不在 T1/T2 可达范围 | 8 | 同 responsibility | 逐条标注 |
| 码/engine 断言在更深层 | 4 | 同上 | 逐条标注 |

> **⚠️ 本表按「失败轴」计数，一条端点可同时出现在多行**——这正是 §11 那刀读数的关键：
> 关闭 `scope self` 一轴**并不等于**那些端点转出 T3，因为同一条端点的 `admission` / `engine`
> 轴仍未闭环。T3 实际只从 113 降到 **110**，详见 §11.2。

**更正一（收尾一刀实测，推翻本节初版的说法）**：初版写「补一个模式即可批量消解，是最省力的
下一步」，**不准确**。实读两处 `self` 端点后确认：`self` 在本仓**根本没有断言调用**——

```ts
list(@Query() query, @CurrentUser() currentUser: CurrentUserPayload) {
  return this.service.appList(currentUser, query);   // 没有任何 .can() / assert
}
```

`self` 是**由构造保证**的：handler 把调用者自己的身份传下去，从不接受调用方提供的主体 id。
现有 matcher 形状（receiverTypes / methods / outcome）在这里**匹配不到任何东西**，
硬塞一行等于编造一个不存在的调用。诚实的 `self` 判据是**数据流判据**——主体参数源自
`@CurrentUser()`，且没有调用方可控的 id 走到主体位置——属于**新的 matcher 类别**。

两条附加约束：① 其单源 `AUTHZ_ASSERTION_PATTERNS` 在 `src/common/authz/authz-context.ts`
（登记表 JSON 只是 `--write` 投影，直接改 JSON 会被 stale 检查拦下，也正是"不得分叉"所禁止），
故改动落在 `src/**` 且受 R15 治理；② 它的**负样例正是 IDOR 形状**（handler 收
`@Param('userId')` 并把它当主体）——判据写松就是给真实越权端点盖上「self 已证明」的章，
**比不做更糟**。**维护者 2026-08-13 拍板：另立项**，须自带 red-first 设计。

**更正二（2026-08-14 `self-by-construction` 一刀实测，推翻上面「数据流判据」的说法）**：
诚实的 `self` 判据**不需要数据流分析**。上文写「主体参数源自 `@CurrentUser()`，且没有调用方
可控的 id 走到主体位置」——后半句要求追踪 id 的去向，那是跨函数分析。实做证明只需前半句
加上一条**更强**的否定：**参数面上根本不存在可作主体标识的调用方输入**。它严格更保守
（连「可控 id 只流向资源位置」这种本可放行的情形也拒掉），因此不会给 IDOR 面盖章，
同时完全避开了跨函数追踪。详见 §11。

其余 70 条若走标注路线，按 v4 ⑯㉟ 每条都是受控事件（fragment + Environment 审批 +
evidenceDigest 新鲜度绑定），**不是一刀能完成的量**，建议按面分批并单独立项。

## 10. 债务身份一致性已接 CI（收尾一刀）

`pnpm docs:boundaries:ids:check` 接进 **Fast checks** 既有的
`Architecture governance A-metadata gate` 步骤，**不新增 required context**（沿 Phase 0 范式
「在既有 required job 内加步骤」）。

**定为 blocking，不加 `|| true`**。理由：它属 A 类（元数据完整性），判的是**台账**不是代码 ——
断言「每条已登记的 call-site 债务条目仍能解析到一个活的调用点」。不接 CI 的话，普通的代码移动
造成的身份失配会一直隐形，直到 R5/R6 转闸那天才炸，而那时它呈现的形状是
「旧债全部清偿 + 等量新债出现」—— 与真回归一模一样。

**真触发验证（不是结构断言）**：把 `XW-0001` 的 `callSiteId` 改成
`cs:deadbeefdeadbeefdeadbeef` → 门 **exit 1** 且逐条列出 `unmatched: ["XW-0001"]`；
还原后 **exit 0**。即这道闸能红，不是恒绿的摆设。

当前读数 `alreadyCurrent: 201 / migrated: 0 / unmatched: [] / collisions: 0`，幂等，
不会误伤既有 PR。

---

# 11. `scope self` 结构判据（2026-08-14 另立一刀交付）

> 本节记录 §5 第 7 条 / §9 那 43 条的处置结果。**口径与前十节一致：全部数字为实测。**

> ## ⚠️ 本刀收益口径（维护者 2026-08-14 拍板，引用本节时以此为准）
>
> **真实收益 = ① 一个新证明种类（「不可能冒充」）+ ② 25 条 `self` 轴闭环
> + ③ 7 条 IDOR 面具名。T3 仅降 3 条（113 → 110）。**
>
> **禁止出现「消解 36 条」「批量消解 N 条 T3」一类表述。** 「关掉一个失败轴」与
> 「端点转出 T3」是两件事：§9 成因表按**失败轴**计数，一条端点可同时占多行；
> 转出 T3 要求该端点**所有**轴都闭环。本刀只关了 `self` 一轴。

## 11.1 新证明种类：从「判权发生过」到「不可能冒充」

前五个断言族证的都是同一件事：**判权发生过**（一次已登记的调用 + 一个可观察的后果分支）。
`self` 证不了这件事——它的「资源 ⋂ 身份」是 **where 子句不是调用**，没有调用点可观察。

因此 R8 的「闭环」在本刀起扩为两类，**各自成文、不混用**：

| 证明种类 | 含义 | 成员 |
|---|---|---|
| 判权发生了 | 已登记调用 + 后果分支 | 既有五族 |
| **不可能冒充** | **结构性否定：handler 没有任何调用方可用来指定别人的输入面** | `self-by-construction` |

判据（**默认拒绝**，白名单归类）：handler 的**每个**参数必须被归类为
① 框架注入的身份（`@CurrentUser`）或 ② 可枚举名字的调用方输入（`@Param`/`@Query`/`@Body`）；
**其余一律落 T3**——`@Req` / `@Headers` / 自定义装饰器 / 无装饰器。再要求身份项存在且在
handler body 内被引用（向下传递）。DTO 携带的字段名由 TypeScript `TypeChecker` 展开
（继承 / `PickType` / `OmitType` 交给编译器，不在 R8 内重写第二个解析器）；
**拿不到 typed program 一律落 T3**，不回落字符串解析。

**为什么必须默认拒绝**：本族证的是「不存在 X」，负面证明的命门是穷尽性——漏一种参数来源
就是一次假阳性放行，而假阳性的形态恰好是**给一个真有 IDOR 面的端点盖章**，比不做更糟。
判据因此以白名单归类实现，**不得以「黑名单未命中就算安全」实现**。

## 11.2 实测读数（⚠️ 「self 轴闭环」≠「端点转出 T3」）

全仓 128 条 `[auth]` 记录：

| | Phase 3 前置 | 本刀后 |
|---|---:|---:|
| T1 | 4 | 4 |
| T2 | 2 | **5** |
| T3 | 113 | **110** |
| N/A | 9 | 9 |

43 条 `scopes:['self']` 端点：**25 条 self 轴闭环 / 18 条不可判**。
**但只有 3 条真正转出 T3**（`T3/candidate` → `T2/mismatch`）：

- `GET /api/app/v1/my/activities`
- `GET /api/app/v1/my/participation-ledger`
- `GET /api/app/v1/my/participation-summary`

**没有任何 self 端点达到 `closed`。** 其余 22 条 self 轴已闭环的端点仍是 T3，
被**另外两轴**挡着（各 22 条，同时命中）：

1. `admission app-member has no AppIdentityResolver.resolve deny branch`
2. `engine authz-scoped has no authz-can-explain assertion`

这两条都属既有五族，本刀硬边界明写不得改动，故如实留在 T3。**立项时把「self 轴闭环」
与「端点转出 T3」当成了一件事，实测证明是两件。** §9 那张表按失败轴计数，
一条端点可同时出现在多行——关闭一轴不等于该端点出表。

两条阻塞轴的性质**不同**，不要合并处置：

- **`admission` 那条是真实的声明↔实现不一致，不是判据缺陷。** 例：`GET /api/app/v1/me`
  在 handler 里确实调了 `appIdentity.resolve`，但把 `canUseApp` **放进响应体**而不是据此拒绝
  （该端点在 `canUseApp=false` 时仍需可读，用于告知原因）。声明写 `admission: 'app-member'`，
  实现并不据此拒——R8 报出来正是它的本职。处置属**声明口径**问题，不属判据问题。
- **`engine` 那条疑似既有 R8 的过度要求。** 这些端点是 `engine: 'authz-scoped'` + `codes: []`；
  现规则在 engine 非空时无条件要求一个 `authz-can-explain` 观察，而**没有码可查的纯 self 端点
  本就不该有那个调用**。此项**未经拍板，本刀不改**，登记在此交下一刀。

**零外溢旁证**：非 self 端点分布 `T1=4 / T2=2 / T3=70 / N/A=9` 与 Phase 3 **逐项相同**，
即新判据只作用于声明了 `scope self` 的端点，未波及其余 85 条。

## 11.3 18 条不可判的成因

| 成因 | 条数 | 性质 |
|---|---:|---|
| 未登记装饰器 `@Req` | 8 | **代码形态**，见 §11.4 |
| `@Param` 携带主体标识 `id` | 7 | 真有调用方提供的资源 id → 属 §11.5 的具名复核面 |
| `@Body` 携带主体标识 `phone` | 2 | 保守拒绝（`phone` 是待绑定的**新值**不是选择器，但参数面区分不了） |
| 未登记装饰器 `@UploadedFile` | 1 | 代码形态 |

主体名字集是**数据**（在 `AUTHZ_ASSERTION_PATTERNS` 内），可扩展；**新增名字须在同 PR 说明理由**。
裸 `id` 被列入是刻意的保守选择：参数面上无从区分资源 id 与主体 id。

## 11.4 `@Req` 一类是代码形态问题，不是判据问题

全仓共 **15 条** self 端点带 `@Req`。判据按参数顺序取**首个**命中的拒绝子句，故它们的
归因分散在四处（实测）：

| 实际拒它的子句 | 条数 |
|---|---:|
| `@Req` 本身 | 8 |
| 先被 `@Param` 携带 `id` 拒掉（即 §11.5 的 Shape B） | 4 |
| 先被 `@Body` 携带 `phone` 拒掉 | 2 |
| 先被 `@UploadedFile` 拒掉 | 1 |

**归因分散不影响结论**：这 15 条即使拿掉别的拒绝理由，也仍会因 `@Req` 落 T3。
它们都只用 `@Req` 做一件事：`buildAuditMeta(req)` 取 `requestId` / `ip`。
**实际无害，但不可放行**——`req` 上挂着
`req.user` / `req.params` / `req.body` / `req.headers`，是**通用冒充面**；要证明它没被用作主体
就必须做 `req` 的污点分析，那正是本判据刻意避开的跨函数分析。

**机械可解**：把这些 handler 的 `@Req() req: Request` 换成专用的 `@AuditMeta()` 参数装饰器
（只投影 `requestId`/`ip`），它们即可归类、self 轴随之可判。**属业务代码改动**（涉 15 个
handler），不在本刀写集内，**未立项**。

⚠️ 注意其收益上限：这 15 条里有 4 条同时是 §11.5 的 Shape B（有真实的调用方资源 id），
**改造后它们仍会被主体标识子句拒掉**，这是正确行为。故该改造最多让 **11 条**新增 self 轴闭环，
且**不等于**这 11 条转出 T3（同样受 §11.2 两条阻塞轴约束）。

## 11.5 7 条 Shape B —— 具名 IDOR 复核面（交拍板）

这 7 条另有调用方提供的资源 id，其「资源 ⋂ 身份」求交点在跨函数之后，**本刀不为它们出结构
判据**（那需要跨函数 + SQL 污点分析，属 v4 定义的 T3）。逐条具名如下，作为人工复核面：

| # | 路由 | 求交点 | 求交通道 | 跨函数层数 |
|---|---|---|---|---|
| 1 | `DELETE /api/app/v1/me/insurances/:id` | `src/modules/insurances/app-me-insurances.service.ts:90-91` | **raw SQL** | 2 |
| 2 | `PATCH /api/app/v1/me/insurances/:id` | 同上（`lockMyInsuranceOrThrow` 复用） | **raw SQL** | 2 |
| 3 | `PATCH /api/app/v1/me/team-join/applications/:id/targets` | `src/modules/team-join/team-join-applications.app.service.ts:242` | **Prisma where** | 2 |
| 4 | `PATCH /api/app/v1/my/registrations/:id/cancel` | `src/modules/activity-registrations/activity-registrations.service.ts:1833` | **内存比较** | 3 |
| 5 | `GET /api/app/v1/my/registrations/:id` | `src/modules/activity-registrations/activity-registrations.service.ts:1811` | **内存比较** | 2 |
| 6 | `GET /api/app/v1/notifications/:id` | `src/modules/notifications/notification-read.service.ts:228 → 234` | **内存比较** | 2 |
| 7 | `POST /api/app/v1/notifications/:id/read` | 同上（`findVisibleOrThrow` 复用） | **内存比较** | 2 |

求交通道的实际分布**推翻了立项时的预设**（原以为只有 raw SQL 与 Prisma where 两种）：

- raw SQL：2 条 —— `WHERE "id" = ${id} AND "memberId" = ${memberId}`
- Prisma where：1 条 —— `findFirst({ where: { id, memberId, deletedAt: null } })`
- **先按 id 无属主谓词取行、再在内存里比字段：4 条** ——
  `findFirst({ where: { id } })` 之后 `if (row.memberId !== memberId) throw`

**第三类复核优先级最高**：属主判定是一行**可删的 JS 比较**，删掉它**不会有任何结构性失败**
——没有 where 缺项、没有 SQL 变化、typecheck 照过、类型系统毫无察觉。前两类至少把属主
写进了查询条件。

> **已拍板处置（维护者 2026-08-14）**：这 4 条列为**下一刀最高优先**（C 档，可独立成刀）——
> 给每条加 **e2e 行为锁**（他人资源必须返 404 / 403），并**用变异证明**：删掉那行内存比较
> → 用例必红。**目的不是改实现，是把「删一行无人知」变成「删一行必红」。**
> 维护者定性:**这比转出 T3 重要得多**。

本刀**不写 `@AuthzChainVerified` 标注**（标注机制与 Environment 审批属 v4 ㉑ 的受控事件），
只产出清单与逐条证据。

## 11.6 ⚠️ 对 ALS 的硬约束（Phase 1A 前置，必须先读）

`self-by-construction` 的 `runtimeMarker` 是 `null`。**这表示「self 这一个轴不发运行时事件」，
不表示「这些端点不可观测」**——它们的服务链里 `assertCanUseAppOrThrow` / `appIdentity.resolve`
密集出现（`app-my-registrations` 9 处、`app-me-insurances` 6、`notification-read` 6、
`team-join-applications.app` 5、`notification-subscription` 4），ALS 上线后会照常观测到这些
**admission 轴**事件。

**由此产生一条对 ALS 设计的硬约束**：v4 §5.2 写「ALS 对全部 T3 端点恒观测」。
若 ALS 把「是否观测」挂在 R8 的 T3 状态上，**端点一旦因本族转出 T3 就会整体停止观测**——
那是真代价（本刀已让 3 条转出，后续刀会让更多条转出）。

> **ALS 必须按端点自身属性决定观测面，不得仅以 R8 的 T3 结论作为观测开关。**

该约束已同时写进 `src/common/authz/authz-context.ts` 内该族的注释（就近提示），
不只写在本报告里。

## 11.7 判据由变异对拍绑定（不是纸面设计）

三条子句各自独立，红集**不重叠**：

| 变异 | 翻红样例 | 条数 |
|---|---|---:|
| 拆「可控输入携带主体标识即拒」 | param 直给主体 / 资源 id / Body 字段 / **继承来的** Body 字段 | 4 |
| 拆「未登记装饰器即落 T3」 | 自定义装饰器 | 1 |
| 拆「主体名字集为空时的结构自保」 | 正样例（实测变成 `T1/closed`） | 1 |

第三条守的是**判据的结构、不是名字集的内容**：名字集写漏一个名字只是「少拒一条」，
但名字集**为空**若被当成「没有名字命中 ⇒ 全部放行」，就从一条假阴性升级成**整族盖章**，
方向正好反了。该用例改真 registry 跑真扫描后还原，**不给规则新增 patterns 覆盖选项**
（后者等于给 PR 多开一个把裁判改成恒 PASS 的入口）。

正样例覆盖 DTO 展开通道（无主体字段的 DTO 必须放行），否则「一律拒绝」也能让负样例全绿。
既有 19 条 R8 探针零回归；harness 自测 129 passed / 0 failed。

## 11.8 本刀未做

- **不做 Shape B 的自动判据**（§11.5 那 7 条）—— 需跨函数 + SQL 污点分析，属 T3。
  其中 4 条「内存比对属主」的 **e2e 行为锁**已拍板为下一刀最高优先（§8 第 1 项），
  本刀不做 —— 那是行为测试，不是静态判据。
- **不写 `@AuthzChainVerified` 标注**（受控事件，另立项）。
- **不转闸**：R8 仍恒 report-only。
- **不动其余五族** —— §11.2 那两条阻塞轴因此原样留在 T3。
- **不做 `@Req` → `@AuditMeta` 的代码形态改造**（§11.4，业务代码改动，未立项）。

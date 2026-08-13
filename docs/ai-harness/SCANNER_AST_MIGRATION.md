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
7. **R8 的接收者*表达式*形态未 typed 化**：本刀只把接收者**类型名**的解析改为 typed，
   `const svc = this.authz; svc.can(...)` 这类**中转/解构接收者**仍不识别。
   ⇒ 见 §6 的 EC-COMMON 第 4 条达标声明。
8. ESLint `no-restricted-syntax` 那一层（`eslint.harness.mjs` 内 5 条对抗样例）仍是**字面
   语法拦截**，其中就有 `const db = this.prisma; db.user.delete()` 这条中转绕过。
   本刀关掉的是**边界扫描器**里的同形缺口，**不是**那一层 —— 两层各自记账，别混算。

## 6. EC-COMMON 第 3/4 条达标声明

| 规则 | 第 3 条 typed-AST 化 | 第 4 条 四类绕过样例全绿 |
|---|---|---|
| R5 跨域写 | ✅ 已达标 | ✅ alias / destructuring / variable-forwarding / re-export 各有正样例，另加 tx 改名、窄口、计算属性，及 2 条负样例 |
| R6 跨域读 | ✅ 同上（同一解析层） | ✅ 同上 |
| R2/R3 依赖与环 | ✅ import 图 AST 天然可靠；四形态全覆盖 | ✅ re-export 正样例 + 三形态「当前为 0」到期闸（EC 表已注明 R2/R3 不适用第 5 条） |
| R8 T1/T2 | ⚠️ **部分达标** —— 接收者**类型名**解析已 typed；接收者**表达式**（中转 / 解构）未做 | ⚠️ **未达标** —— 只有别名一类有正样例；destructuring / variable-forwarding / re-export 三类**没有** R8 侧样例 |

**R8 的第 3/4 条是本刀未做完的部分，须在 R8 转 blocking 前补齐**（见 §7）。
其余规则的第 3/4 条已达标。第 5 条（`$queryRaw` 通道）R5/R6 已纳入且接收者亦按类型判定。

## 7. 本次未做

- **不转任何规则为 blocking**（转闸需观察期数据 + Exit Criteria 打勾单，另立项）。
- **不做 T3 标注补齐**（本刀只重扫出数）。
- **不做 R6 升级**（永久 report 已拍板）。
- **R8 接收者表达式的 typed 化**与其 destructuring / forwarding / re-export 三类样例（§6）。
- **`require:any` 的 OR 结构完整性**：现规则要求**每个**声明码都有对应断言（v4 逐码要求已满足），
  但**不验证这些分支确实是 OR 组合**。全仓仅 2 个端点声明 `require:any`，影响面已知且极小。
- **CI 接线**：`pnpm docs:boundaries:ids:check` 已可用，但未写入 `.github/workflows/ci.yml`
  —— 该文件不在本 goal 的授权写集内。

## 8. Phase 3 转闸的剩余前置

| EC-COMMON | 现状 |
|---|---|
| 1 baseline 冻结 + 棘轮 | ✅ 222 条持证；身份迁移后条目集恒等，新增 ids:check 常驻判据 |
| 2 known gaps 成文 | ✅ 本文 §5 + `architecture-debt.json.knownGaps` 已同步 |
| 3 typed-AST 化 | ✅ R2/R3/R5/R6；⚠️ R8 部分（§6） |
| 4 四类绕过样例全绿 | ✅ R5/R6；⚠️ R8 仅别名一类 |
| 5 `$queryRaw` 通道 | ✅ 已纳入且按类型判定接收者 |
| 6 report 期误报逐条处理 | ❌ **未做** —— 需要观察期数据；本刀未新增误报（读数 +1/0/0） |
| 7 CI 连续稳定 ≥10 PR 或 ≥2 周 | ❌ **未开始计时** —— typed 版本刚落地 |
| 8 Journey 全绿 + zero-new-red | ❌ 本刀零 `src/**` 改动，但 Journey（1J）本身尚未立项 |
| 9 回滚路径一行开关 | ❌ **未做** —— 规则现为恒 report，尚无 blocking↔report 开关 |
| 10 错误信息五要素 | ⚠️ 部分 —— R8 消息含规则/位置/事实/处置，缺「引用 domain-map/manifest 的具体声明行」 |

**建议的下一刀顺序**：① 补 R8 的 §6 缺口（否则 R8 不具备转闸资格）；
② 登记 `scope self` 的断言模式（见 §9，一次性消掉 43 条 T3）；③ 回滚开关 + 错误信息第④要素；
④ 然后才开始 EC 第 7 条的连续稳定计时。

## 9. R8 的 113 条 T3 成因分布与标注工作量估算（交拍板）

按面：**app 103 / admin 10**。按失败轴的出现次数：engine 113 / scope 109 / admission 98 / code 18。

| 主因 | 条数 | 性质 | 处置成本 |
|---|---:|---|---|
| responsibility 断言不在 T1/T2 可达范围 | 58 | 断言在更深的 service 链里 | 逐条 `@AuthzChainVerified` 标注（每条须 reason/verifiedBy/reviewId/evidenceDigest + Environment 审批） |
| **`scope self` 没有任何已登记断言模式** | **43** | **登记表缺口，不是代码缺口** | **一次性登记一个 self 模式即可批量消解**，无需逐条标注 |
| visibility scope 下推不在 T1/T2 可达范围 | 8 | 同 responsibility | 逐条标注 |
| 码/engine 断言在更深层 | 4 | 同上 | 逐条标注 |

**最省力的下一步是第二行**：`harness/authz-assertion-patterns.json` 现有五个族覆盖
codes / engine / scopes / admission 四轴，但 `scopes` 只登记了 `visible-organization-scope`
与 `responsibility-check` 两族，**`self` 一族缺失**。43 条 T3 因此不是"证明不了"，而是
"检测器没有可用来证明的模式"。补登记后需重扫确认实际消解条数（本文未预判该数字）。

其余 70 条若走标注路线，按 v4 ⑯㉟ 每条都是受控事件（fragment + Environment 审批 +
evidenceDigest 新鲜度绑定），**不是一刀能完成的量**，建议按面分批并单独立项。

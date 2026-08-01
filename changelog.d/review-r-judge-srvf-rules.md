- **整批评审 R 批次:裁判冻结四元组 + srvf 规则关逃生门(2026-08-01;2 P1 + 1 P1 + 1 P2,零 schema,Migration 恒 68,Cron 恒 2)**:

  ① **base-trusted 裁判冻结棘轮四元组**(R1)—— M4 只冻结 ratchet 的 **id**,于是「同 id 换载体」全绿:
  新增一份洗过的 `harness/<旧名>-v2.json`(多几条豁免),把注册表那条的 `baseline` 指过去,
  **旧文件一个字不动** —— 裁判读 base 注册表拿到旧路径,旧路径没改动 ⇒ 判成 `HEAD == BASE` ⇒ 放行;
  而 `eslint.harness.mjs` 读的是 head 注册表,吃的是 v2。判据从此守着一份**已经没人读**的文件。
  (改名有「基线不得删除 / 改名」兜着,但**拷贝一份再改指向**不涉及 rename,既有三条判据全都看不见它。)
  现在 base 里每个 id 的 `{baseline, rule, symbolShape}` 在 head 上必须**逐字不变**,违反即硬失败
  (scan 失败 ⇒ approval job 被 skip ⇒ **没有可点的审批按钮**)。仍允许新增全新 id、仍禁止摘掉登记。

  **顺带关掉一条平行绕过**(主会话复核时发现,不在原 finding 内):「允许新增全新 id」这条**必须保留**的
  合法通道自己就能洗豁免 —— 新增一条 id、`rule` 写成既有的 `srvf/no-nullable-is-optional`、
  `baseline` 指向一份全新文件塞满新豁免。四元组冻结管不到(它是新 id),逐基线单调性也管不到
  (base 注册表里没有它,裁判压根不会去读那份文件),而 lint 侧照样按 head 注册表**遍历**生成豁免块。
  判据因此必须落在真正的受害者「rule」上:**base 出现过的每条 rule,head 侧全部基线的
  `(file, symbol)` 并集 ⊆ base 侧并集**;base 里没有的 rule 不设限 —— 那正是「落地一条全新棘轮」的
  合法形状(新棘轮天生带着自己那份存量债)。

  ② **`srvf/*` 三条规则不再接受行内关闭**(R2)—— 修复前实测(真实 `pnpm lint` 入口,**RC=0 零命中无警告**):
  controller 里 `// eslint-disable-next-line srvf/no-param-id-string` **有效**、文件级 `/* eslint-disable srvf/… */`
  **有效**、非 `.dto.ts` 里关第 18 条**有效** —— `linterOptions.noInlineConfig` 刻意只配到 DTO。
  修法**不是**把 `noInlineConfig` 扩到 controller:那只是把范围从第一类文件扩到第二类,第三类文件落地时
  又是一个洞,而洞是静默的;何况 `noInlineConfig` 是整块语义,一扩就把 `src/` 现有 7 处**正当**的具名硬删豁免
  一起打死。改成一次**源码扫描**(`scripts/harness-eslint.selftest.ts`,红区受保护),拒两类写法:
  **A** 任何 disable 指令里出现 `srvf/` 开头的规则名;**B** 任何**不具名**的 disable(`/* eslint-disable */`)
  —— 它把 srvf/ 一并关掉,只是没写出名字,漏掉 B 等于只关了正门。判据从此绑在**规则身份**上而不是文件名形状上。
  扫描刻意跑在 eslint **之外**:一条 eslint 规则自己也能被 `/* eslint-disable */` 关掉。
  判据落在**注释节点**(共用 `pnpm lint` 同一个 parser),不是 raw grep —— 否则自测自己的合成片段会被报成违规,
  然后必然催生一条 allowlist,而 allowlist 就是下一个逃生门。全仓实测 A=0 / B=0,7 处具名非 srvf 豁免全部放行。

  ③ **装饰器身份解析补三种写法 + 新增第三条自定义规则**(R3)—— 修复前实测 8 个探针文件 RC=0、零命中:
  `@(CV['IsOptional']())` **计算属性**、`const Opt = CV.IsOptional` **namespace→局部**、
  `export { IsOptional as Opt } from 'class-validator'` **改名 re-export**(顺带 `const { IsOptional: Opt } = CV` 解构中转)。
  前两类(含动态键 `CV[k]`,按「宁可多判不可漏判」判成命中)在 `eslint-rules/decorator-identity.mjs` 内关掉;
  **改名 re-export 结构上关不进那里** —— 名字是在**另一个模块**换掉的,同文件 scope 看不见,
  跨模块解析要么依赖 type checker(自测里拿不到 parserServices,阳性对照做不了)、要么自写模块图(第二把尺子)。
  所以判据换方向:新增 **`srvf/no-decorator-realias`**,从**源头**禁掉改名导出(re-export / 本地改名导出 /
  `export const Opt = IsOptional` / `export default Param` 四种形态),**同名**转发与 `export *` 照常放行。
  于是任何抵达装饰器位置的名字都必然是原名,同文件解析就足够 —— 两条规则拼起来才是完整防线。
  ⚠️ 裸 `@CV['IsOptional']()` 是 **TS 语法错误**,真正能写出来的逃生门是加括号的 `@(CV['IsOptional']())`,
  探针必须用后者,否则测的是「TS 不让你这么写」。覆盖闭环 18 → **19**,且名单改为从
  `srvfEslintPlugin.rules` **数出来**:新增规则不补正向用例当场红,不再靠谁记得。

  ④ **`runMemberLinearizedTransaction` 显式事务预算**(R4,M3 遗留 P2)—— `lock_timeout` 显式 4s,
  而交互事务预算**继承 Prisma 默认的 5s**:真正排过一次队的事务,留给业务的只剩 1s,
  而 200 人终审实测 **14 次 SQL / 222 ms**,慢一个数量级的库当场跑穿 → P2028 → 50000
  「服务器内部错误」。它排了队、拿到了锁、什么都没做错,却拿到一个不可重试的 500 ——
  M3 花力气从 500 改成 40901 的那件事,从另一条路原样回来了。现在
  `MEMBER_TX_TIMEOUT_MS = MEMBER_LOCK_WAIT_BUDGET_MS(4s) + MEMBER_TX_WORK_BUDGET_MS(3s)`,
  三件事(RC 隔离级别 / 有界锁等待 / 事务预算)一起写死 —— 任何一个留给默认值,另外两个就白做。
  ⚠️ **不是给 N+1 兜底的额度**:批量化的判据仍是 **SQL 次数**(`MAX_TX_QUERIES < 40`),
  且规模用例的耗时上限改为**绑定** `MEMBER_TX_WORK_BUDGET_MS` 本身,抬预算不会顺带放松它。
  新增两条近预算 e2e:④-a 等 3.8s 拿到键后跑完整 200 人终审(回归闸);
  ④-b **真 red-first** —— `lock_timeout` 是 per-acquisition 语义,`claimAtStatus` 的 `FOR NO KEY UPDATE`
  与 member advisory 键两段串行等待**相加**,各自都在 4s 之内、合起来越过旧的 5s 默认预算,
  修复前实测 `timeout was 5000 ms, however 5746 ms passed`(P2028),修复后产出业务结果。

  **对照 S1–S7 形状表自审**(整批评审的教训:③⑤ 说明形状表**没有进入新代码的出生检查**)。
  本批唯一碰运行时的是 ④,且只改 `$transaction` 的 options,**不新增、不移动、不删除任何取锁点**:

  | 形状 | 本批自审结论 |
  |---|---|
  | S1 锁后不复读 | **不适用** —— 未改任何读写顺序;`finalApprove` 的 claim→复读→取键→再读顺序逐字未动 |
  | S2 相对某对象完全无锁 | **不适用** —— 未新增任何写路径 |
  | S3 守卫建立在锁前读上 | **不适用** —— 未新增守卫 |
  | S4 父实体终态不级联子实体 | **不适用** —— 未改任何状态迁移 |
  | S5 注释声称不变量但无执行位 | **主动核过**:本批每条新表述都配了执行位 —— 「四元组冻结」→ 裁判纯函数 + 5 条行为断言;「并集只减不增」→ 4 条行为断言;「srvf 不可行内关闭」→ 扫描器 8 正 6 反 + 全仓扫;「预算 = 锁 + 工作」→ ④-a/④-b 两条 e2e。**并且反向也钉了**:规模用例的耗时上限从手写的 4000 改成**绑定** `MEMBER_TX_WORK_BUDGET_MS`,覆盖闭环名单从手写数组改成**从 `srvfEslintPlugin.rules` 数出来** —— 两处原本都是「元数据描述实现而无人检查」的形状 |
  | S6 运行时与 `docs/handoff/**` 分叉 | **不适用** —— 零 endpoint / 零 DTO / 零 RBAC 码变更,OpenAPI 无漂移 |
  | S7 锁绑在 authorization 分支 / 跨行不变量无共同键 | **不适用** —— 未改锁的获取位置;`runMemberLinearizedTransaction` 的四个调用方(submit/edit/finalApprove/reopen 及 team-join / members / member-departments)全部**无条件**经它开事务,不存在「一条 surface 走、另一条裸奔」 |

  **变异对照(每刀都做,修复前后各跑一次)**:R1 三种「同 id 换载体」用
  `git show HEAD:` 取出的**真实旧裁判**实跑 —— 修复前 3/3 🟢 放行、修复后 3/3 🔴 拒,两条反向对照
  (四元组不变 / 新增全新 id)前后都放行 · R2 三个探针修复前 `pnpm lint` RC=0,修复后 `harness:selftest` **RC=1** ·
  R3 八个探针修复前零命中,修复后逐条命中(改名 re-export 报在**源头文件**) ·
  R4 ④-b 修复前 P2028、修复后 6/6 全绿。

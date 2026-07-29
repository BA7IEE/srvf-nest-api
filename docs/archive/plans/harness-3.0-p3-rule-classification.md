# P3 恒读层重写 — 铁律三分类逐条对照表(语义零放宽的证明)

> 冻结于 P3 施工 PR。**用途**:证明恒读层压缩过程中**没有任何一条规则被放宽** —— 每条只是换了投递方式。
>
> 三类:
> - **🔧 机器化**:已有确定性执法(lint / hook / CI / 权限规则 / 生成器),散文可压成指针,违反时物理拦截或 CI 红
> - **📍 路径注入**:判断型但触发点精确,可绑定文件路径在触碰时弹出(P5 落地;**当前仍留恒读层判断区**)
> - **📖 留散文**:无法机器化的判断型规则,**必须留在恒读层**,并标注「无机器守护,靠你自己」
>
> 分类依据:P0 冻结的 `harness-3.0-rule-enforcement-matrix.md`(114 条),按 P2a/P2b/P4a 实际落地 true-up。
>
> **删除的前提条件**:一条散文只有在对应载体已 enforce 且自测绿时才允许压成指针。凡「计划」列仍写未落地的,原文必须留着。

## AGENTS §1 铁律速查(22 行)

| 主题 | 分类 | 执法载体 | 恒读层处置 |
|---|---|---|---|
| 包管理(pnpm-only) | 🔧 | `settings.deny` 三条 + CI `--frozen-lockfile` | 压成指针 |
| 跨文件改动(先查引用链) | 📖 | 无(语义判断;typecheck 只兜语法级断链) | **原文保留** |
| 模块结构(平铺 / 禁 entity) | 🔧 | eslint 禁跨模块深引私有子目录 | 压成指针 |
| 命名(cuid / enum 从 prisma 引) | 🔧 | eslint `no-prisma-enum-redefine` | 压成指针 |
| 响应格式(统一包装 / 禁分页别名) | 🔧 | eslint `no-manual-response-wrap` + `no-pagination-alias` + 全局拦截器 | 压成指针 |
| 错误码(BizCode 集中 / 段位) | 🔧 | `biz-code.constant.spec.ts` 元属性断言 | 压成指针 |
| Swagger(禁裸 ApiOkResponse) | 🔧 | eslint `no-bare-api-ok-response` + contract | 压成指针 |
| 校验(全局 Pipe / IdParamDto) | 🔧 | eslint `no-local-validation-pipe` + `no-param-id-string`(19 文件 baseline) | 压成指针 |
| 鉴权(禁 @UseGuards / @Roles) | 🔧 | eslint 两条(实测零存量) | 压成指针 |
| 密码 / token(L3 不出响应) | 🔧+📖 | contract 快照;**refresh 行为冻结属决策锁 P0-E** | 指针 + 锁索引 |
| 软删除(禁 delete / notDeletedWhere) | 🔧+📖 | eslint 禁硬删(6 处带原因豁免);**「哪些查询该带过滤」是语义** | 指针 + 判断区一句 |
| 事务(多写必 $transaction) | 📖 | 无(事务常在 caller / 跨方法编排,AST 假阳性高) | **原文保留** |
| 角色保护(assertCanManageUser 单入口) | 📍 | `users.policy.spec` 3×3 矩阵 + e2e;归属判断留人 | 判断区一句 |
| 配置归属(禁散落 process.env) | 🔧 | eslint `no-process-env`(config/bootstrap/CLI 白名单) | 压成指针 |
| DTO 边界(App 禁派生 Admin) | 🔧 | eslint 禁 Mapped Types + App DTO 禁引 Admin(P2a 已消灭最后一处存量) | 压成指针 |
| API surface(5 canonical 前缀) | 🔧 | contract `CANONICAL_PREFIXES` + `EXPECTED_ROUTES` | 压成指针 |
| 测试纪律(禁删测试 / 放宽断言) | 📖 | **P2c exam-guard 未落地 → 当前无机器守护** | **原文保留 + 标注无守护** |
| snapshot SOP(禁盲 -u) | 🔧+📖 | `settings.ask` 拦 `-u` 变体;**「diff 逐行可解释」是判断** | 指针 + 判断区一句 |
| 受影响范围(动枢纽跑全量) | 📖 | CI 恒跑全量 e2e 兜底(只决定红在本地还是 CI) | 压成一句 |
| 机器守护(四 check) | 🔧 | 已 100% 挂 CI | **删除**(降为 process 指针) |
| git 安全(禁 force / 批量 -D) | 🔧 | `settings.deny/ask`(P2b 补齐 `--force-with-lease`、裸 `git pull`) | 压成指针 |
| 协作纪律(本次未做 / 给证据 / 不顺手修) | 📖 | 无(协作行为,无产物特征) | **原文保留,判断区置顶** |

**统计**:🔧 13 · 🔧+📖 3 · 📍 1 · 📖 5

## AGENTS §2 决策锁(13 条)

**锁的语义一条不动**(重开任一锁仍须先暂停声明)。形态从「一句话 + 细则链接」压成「锁名 + 一行 + 载体」。

| 锁 | 分类 | 载体 |
|---|---|---|
| D-1 contribution-rules 归 System | 🔧 | contract `EXPECTED_ROUTES` 锁死 5 条路由 |
| D-5 App 准入三条件 / capabilities ≠ 权限码 | 🔧+📖 | contract 断言 `/me/` `/my/` 物理分离;准入属运行期语义 |
| D-6 App DTO 禁派生 / L3 默认不返 | 🔧 | 同 §1 DTO 边界 + contract L3 检查 |
| D-7 六类职责边界 | 📍 | eslint 禁 Presenter/Policy 引 PrismaService;归属判断留人 |
| D-9 Route B 终态 5 前缀 | 🔧 | 与 §1 API surface **同载体 → §2 该行删除(重复)** |
| P0-E refresh token 冻结九条 | 📍 | 红区路径 `src/modules/auth/**` + auth e2e 行为锁 |
| 判权单轨(@Roles 归零) | 🔧 | eslint `no-roles-decorator` + `check-rbac-map` |
| 防枚举(登录失败统一 10004) | 🔧+📖 | contract documented4xx 断言;**耗时侧信道无法断言** |
| 身份 / 权限不缓存 | 🔧 | eslint `no-identity-cache` + `no-identity-timer` |
| 永久铁律(禁 LocalStrategy / entity / 中间件) | 🔧 | eslint 三条(零存量) |
| 基础设施冻结(cron 恰 2 / 禁 Redis queue) | 🔧 | `docs:counts` cron 计数 + eslint 禁引 |
| 敏感字段三问 | 📍 | P5 路径注入(绑 DTO / schema 路径);**当前留判断区** |
| 业务行为冻结(改断言即停) | 📖 | **P2c exam-guard 未落地 → 无机器守护** |

## AGENTS §3 红区与触发即停

- **红区路径清单** → 🔧 已收敛为唯一机读源 `harness/redzone.json`(hook 消费 + P2c 的 CI 消费)。
  AGENTS 保留红区**语义**并指向该文件,**不再抄第二份路径列表** —— 两处清单必然漂移。
- **触发即停 14 条** → 其中 4 条是同文件他节的逐字复述(#1 schema / #10 release / #13 红区文档 / #14 危险 git):**删复述不删约束**。其余按上表分类。
- **prisma 禁令**(migrate reset 恒需实时同意)→ 🔧 `settings.deny`。deny 而非 ask 正是「任何预授权都不算」的机器表达。**保留原文强调**——这是全仓设计最好的一条。

## 已知未覆盖(诚实登记,不假装安全)

| 规则 | 为何仍无机器守护 | 计划 |
|---|---|---|
| 禁删测试 / 放宽断言 | 需 diff 级审计 + PR body 结构化声明 | P2c exam-guard |
| 改既有断言 = 改行为契约 → 停下报告 | 同上 | P2c exam-guard |
| 事务纪律 / 跨文件引用链 / 协作纪律 | 语义与行为判断,无产物特征 | **永久留散文** |
| 敏感字段三问 / 职责归属 / characterization 先行 | 判断型但触发点精确 | P5 路径注入 |

> **本表的意义**:恒读层删掉的每一行,都能在此查到它去了哪里。
> 凡「计划」列仍未落地的,对应规则**必须**留在恒读层散文里。

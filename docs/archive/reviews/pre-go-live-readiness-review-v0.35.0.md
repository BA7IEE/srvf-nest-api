# SRVF 上线前就绪审计报告(v0.35.0 base,pre-go-live readiness review)

> **审计性质**:本仓库从未进入生产(pre-production),这是**首次 go-live** 前的就绪度审计——覆盖部署 / 安全边缘 / 密钥配置 / 数据安全 / 运维 / 可观测 / 文档一致性 7 个域(A–G),对应 goal「v0.35.0 上线前就绪审计」。
> **不是什么**:本审计**不是**代码正确性复扫。2026-07-03 已完成的全仓系统性 review(冻结报告 [`full-repo-systematic-review-v0.34.0.md`](full-repo-systematic-review-v0.34.0.md),31 findings 全部处置完毕,0 P0/P1 残余)覆盖了那条线;本报告只回答"能否安全首次上线"这一问题,与前者的 P0–P3 正确性维度不重复。
> **审计基线**:HEAD `ba428ecf`(= `origin/main`)、v0.35.0(package.json = Swagger = tag = GitHub Release 四方一致)、0 open PR、工作树 clean;权限码 191 / ops-admin 91 / `EXPECTED_ROUTES` 292 / controller 63 / 模块 34 / 角色 7 / migration 39。
> **方法**:4 个后台 agent 分域深读(A 边缘安全 / C 认证授权 / E 运维 / F 可观测),lead auditor 直接实跑(B 密钥配置的生产环境崩溃测试 / D 数据安全的干净库迁移重放与 seed 幂等 / G 文档一致性的核心校验命令),全部证据均为**本轮亲自产生**,非转述历史报告。
> **授权范围**:只读审阅 + 只读校验命令 + 用户实时同意后的隔离 scratch DB 操作(`app_readiness_scratch`,审计结束已 drop);**零** src/prisma/test 改动,**零**真实运维动作,**零**发版动作。

---

## 0. 结论(TL;DR)

- **🟢 结论:GO——无 🔴 上线阻断项。** 7 个域逐项核验,核心安全与可靠性机制全部亲核为真且无一失守:helmet 无条件开启 / CORS 强校验且校验值即生效值 / Swagger 生产可完全关闭(UI + JSON 均不可达)/ 10 个限流器(非常见印象中的 9 个)全部就位且 429 响应体与响应头不泄露任何阈值信息 / 错误响应结构性拒绝泄露 stack 与内部细节 / JWT 身份状态逐请求查库绝不缓存 / refresh token 轮换与家族吊销策略与文档逐字一致 / SUPER_ADMIN 铸造路径唯一且生产强校验 / 39 个 migration 干净库重放零报错 / seed 二跑幂等且计数与声称基线精确吻合 / 崩溃兜底链端到端亲核有效 / 优雅关闭双端实现 / 三个健康检查端点到位 / 生产日志为结构化 JSON / Dockerfile 显式禁止容器内自动迁移并给出多副本并发的具体理由。
- 共发现 **8 项就绪缺口**,分级 **0 🔴 / 5 🟡(应在上线前处理,非强阻断)/ 3 🟢(可延后)**。**全部是文档 / 配置模板 / 运维清单的完整性问题,没有一项是代码缺陷或可被现网利用的安全漏洞**——这与"昨天(2026-07-03)刚做完一轮全仓代码质量 review、0 P0/P1 残余"的既有结论完全兼容,本审计从一个不同的角度(能否安全上线而非代码是否正确)几乎没有发现新的风险敞口。
- **最值得优先处理的 2 项 🟡**:
  1. **C-1**:`docs/ops/scoped-authz-go-live-checklist.md` 关于"建第二人(副部长)终审绑定、避免单点故障"的建议只是正文里的一句散文,不是 §5 的勾选项,其最完整的风险提示还被放在标题看不出关联的 §7 里——一个仔细但赶时间的运维员完全可能只建 1 条 `attendance-final-reviewer` 绑定就认为完成了 §5,上线后即形成"仅此一人 + SUPER_ADMIN 兜底"的终审单点。
  2. **D-1**:`docs/deployment.md` 未记录任何 DB 备份 / 恢复策略——这是本系统首次装载真实业务数据(队员、活动、考勤、证书),一旦丢库或损坏,没有备份即不可逆丢失(goal 原文对此项的态度是"无 → advisory",此处按其中"应处理"一档呈现,供维护者最终定级)。
- 其余 3 项 🟡:**B-1** `.env.example` 与实际读取的 env 未完全对齐(缺 4 项限流器变量声明);**F-1** 结构化日志脱敏清单存在代码/文档口径漂移(`docs/security.md` 声称存在但代码里从未有过的 `oldPassword` 模式 + 5 个结构相同、同样自证敏感但未覆盖的字段);**E-1** COS 运维清单 27 处死链(2 个目标文件已被归档移动)+ 1 处权限守卫描述与代码不符。
- 3 项 🟢(可延后,详见 §7 批次表):**C-2** `docs/security.md` 未补 scoped-authz 交叉引用;**G-1** `CODEMAP.md` 漏引用 `## Unreleased` 内 #495 新增的 `organizations/CLAUDE.md`;**B-2** `jwt.config.ts` 的默认密钥拒绝校验对 `smoke` 环境不生效(仅现网 `production` 生效,`smoke` 只用于 CI docker-smoke,非现网风险)。
- **与已知债务对账(§6)**:`docs/current-state.md §3/§4` 记录的全部已接受项(单实例内存状态 / god-service 体量 / service 单测占比 / Mixed Controller 存量 / 身份证号 v1 明文 / 28003 同轮去重枚举 / 外籍 admin 手动建档 / SMS·招新 retention 手动 SOP / 保险到期无提醒 / contract snapshot 体量 / Docker Smoke non-required 等)**逐项核实其接受理由仍然成立,均未翻案**;本次 8 项新发现与已接受清单**零重叠**。

---

## 1. 亲核自证表(runner 直接实跑,非转述)

| 检查项 | 命令 / 方法 | 结果 |
|---|---|---|
| 开工 preflight | `git status --short` / `git branch --show-current` / `git rev-parse HEAD` vs `origin/main` / `gh pr list --state open` / 版本 | HEAD = origin/main = `ba428ecf`,工作树 clean,**0 open PR**,`package.json` version = `0.35.0` = 最新 tag `v0.35.0` |
| Docker/DB 可用性 | `docker ps` | Postgres 容器 `u-nest-api-postgres` healthy,可支持真实迁移/seed 验证(非降级为"仅 CI 亲核") |
| `pnpm lint` | eslint --max-warnings 0(src+test+prisma) | **0 错误** |
| `pnpm typecheck` | tsc --noEmit ×2(src 工程 + test 工程) | **0 错误** |
| `pnpm build` | nest build | 成功,`dist/main.js` 生成 |
| `pnpm test:contract` | jest --runInBand | **525/525 passed**,2 snapshot passed;`EXPECTED_ROUTES` 静态 grep 计数 **292** 与 contract 断言双确认一致 |
| `pnpm docs:codemap:check` | tsx scripts/check-codemap.ts | 0 FAIL / **2 WARN**(6 个 god-service 体量观察 = 已知接受项;**新增 1 个 = `claude-md-referenced`:`src/modules/organizations/CLAUDE.md` 未被 `CODEMAP.md` 引用,见 G-1)/ 1 INFO(4 个 500–700L 大文件观察 = 已知)/ 4 PASS(**34/34 模块**、32 条相对链接全部可解析、**migration 计数 39** 与 `prisma/CLAUDE.md` 声明一致) |
| `pnpm docs:rbacmap:check` | tsx scripts/check-rbac-map.ts | 0 FAIL / 1 WARN(`membership.read.record` 预埋孤码 = 已知接受项)/ 1 INFO(4 个动态模板前缀覆盖 24 条 seed 码)/ **权限码 191、controller 63** 均与 `RBAC_MAP.md` 声明一致、63/63 `@Controller` 前缀落 5 个 canonical 前缀、292 个 `@ApiOperation` 鉴权后缀一致 |
| `pnpm audit -P` | 生产依赖 CVE 扫描 | **3 moderate**(均为 `cos-nodejs-sdk-v5 → request` / `→ fast-xml-parser` 传递链),与 review #484(#489)修复后基线「9 → 3」精确吻合,**无新增** |
| **干净库迁移重放**(用户实时同意后执行;隔离 scratch DB `app_readiness_scratch`,审计后已 drop) | `DATABASE_URL=<scratch> pnpm prisma:deploy` | **39/39 migration 成功应用,零报错**;`_prisma_migrations` 表核实 `finished_at IS NOT NULL AND rolled_back_at IS NULL` 恰 39 行,与 `find prisma/migrations -maxdepth 1 -type d` 目录计数 39 一致 |
| **seed 幂等性**(同一 scratch DB 连续跑 2 次) | `prisma db seed` ×2(`APP_ENV=development`,合法非默认 SUPER_ADMIN 值) | 第二次仅追加"用户已存在"提示;直查 DB 确认 `User` 表行数两次运行后仍为 **1**;`role_permissions` 按角色分组精确吻合声称基线:`attendance-final-reviewer=3`、`biz-admin=72`、`group-manager=22`、`member=9`、`ops-admin=91`、`org-admin=56`、`org-supervisor=4`;`permissions` 总数 **191**、`roles` 总数 **7**、`role_bindings`(ACTIVE)恰 1(仅 seed 期 SUPER_ADMIN 的 ops-admin GLOBAL 绑定) |
| **SUPER_ADMIN 生产校验**(seed 负向测试,同一 scratch DB) | `APP_ENV=production SUPER_ADMIN_USERNAME=admin SUPER_ADMIN_PASSWORD=<合法值> pnpm prisma:seed` | **非零退出**,报错「`[seed] APP_ENV=production 时禁止 SUPER_ADMIN_USERNAME=admin`」 |
| | `APP_ENV=production SUPER_ADMIN_USERNAME=<合法值> SUPER_ADMIN_PASSWORD=ChangeMe123456 pnpm prisma:seed` | **非零退出**,报错「`[seed] APP_ENV=production 时禁止 SUPER_ADMIN_PASSWORD='ChangeMe123456'`」 |
| **JWT_SECRET 生产校验**(真实进程负向测试,`node dist/main.js`,其余全部 env 合法) | `APP_ENV=production JWT_SECRET='please-change-me-in-production-min-32-chars'(.env.example 字面默认值) ...` | **进程 exit code = 1**,报错「生产环境 JWT_SECRET 不能等于 .env.example 默认值」 |
| **CORS 空值生产校验**(同上) | `APP_ENV=production APP_CORS_ORIGIN='' ...` | **exit code = 1**,报错「生产 / smoke 环境 APP_CORS_ORIGIN 不能为空」 |
| **CORS 通配符生产校验**(同上) | `APP_ENV=production APP_CORS_ORIGIN='*' ...` | **exit code = 1**,报错「禁止使用 *,必须显式列出前端域名」 |
| **正对照**(全部合法生产 env:JWT_SECRET/CORS/4 把加密 key 均为合法随机值) | 同上真实进程 | 未被 JWT_SECRET / CORS 校验拦截(证伪"逢生产必崩"的假阳性可能),而是命中**另一个独立的、正确的**生产 fail-fast 闸(`StorageSettingsService.onApplicationBootstrap`:`storage_settings` 未初始化);该崩溃**以结构化 JSON**(含 `level`/`time`/`pid`/`hostname`/`err`/`msg` 字段)记录、经 `unhandledRejection→uncaughtException` 链路后 `exit(1)`——顺带亲核确认了崩溃兜底链(§4 E-2)与生产 JSON 日志(§4 F-2)均按设计工作,且验证了该项 fail-fast 与 COS 运维清单(`cos-production-rollout-checklist.md §7`)的指引一致 |
| **429 响应体/头实测**(对已运行的同 commit 影子实例做小批量只读探测,≤20 请求/端点) | 对 `POST /api/open/v1/recruitment/identity/send-code` 连续请求 | 命中限流后返回 `{"code":42900,"message":"请求过于频繁，请稍后再试","data":null}`,响应头**无** `X-RateLimit-*` / `Retry-After` / 任何配额字段 |
| **版本四方一致** | `package.json` / `apply-swagger.ts setVersion` / `git describe --tags` / `gh release list` | **`0.35.0` = `0.35.0` = `v0.35.0` = `v0.35.0`(标记 Latest)**,全一致 |
| **`## Unreleased` 2 条 vs 实况** | `gh pr view 494/495 --json state,mergedAt,mergeCommit` + `git log` | 均 `MERGED`;merge commit `c4f4ae10` / `790bf5c9` 与 main 提交历史精确吻合;CHANGELOG 描述与实际变更一致 |
| **`.env.example` ↔ 代码实际读取双向 diff** | 全仓 `process.env.*` 提取(排除 spec)vs `.env.example` 声明,`comm` 双向比对 | **反向(.env.example 声明但代码不读)= 0 项,干净**;**正向(代码读但 .env.example 未声明)= 4 项**,见 B-1 |
| **硬编码密钥扫描** | 全仓 grep(`AKID*`/PEM 私钥头/`sk-*`/`SecretId=`/`SecretKey=` 等字面量模式)+ 人工审 `.env.test` | **0 命中**;仅 `.env.example`/`.env.test` 两个 env 文件被跟踪,`.env`/`.env.local`/`.env.*.local` 均在 `.gitignore`;`.env.test` 核实为纯本地测试值(`APP_ENV=test`),无真实云凭证形态字符串 |
| **Dockerfile 迁移策略通读** | 全文阅读 `Dockerfile` | `CMD` 仅 `["node", "dist/main.js"]`,无 ENTRYPOINT / CMD 触发迁移;文末"生产迁移原则"注释块显式禁止容器内自动迁移,并给出两条具体理由(连库失败→重启风暴,K8s rollback 不可控;多副本并发 migrate→`migration_lock` 不保证安全) |

---

## 2. 域覆盖矩阵(自证无漏扫)

| 域 | 检查项(DoD 原文条目) | 方法 | 结果 |
|---|---|---|---|
| A 边缘/HTTP 安全 | helmet 默认开且无 env 开关 | Agent 深读 + 实测响应头 | PASS |
| | 生产 CORS 强校验且校验值即生效值 | Agent 深读(`app.config.ts`↔`apply-global-setup.ts`引用链) | PASS |
| | Swagger 生产可关且关闭后 UI+JSON 均不可达 | Agent 深读(`apply-swagger.ts` 提前 return 分支) | PASS |
| | 9(实为 **10**)个限流器就位且被消费 | Agent 深读 + lead 交叉核对 `throttle-options.ts` | PASS(计数更正,见 B-1) |
| | 429 不泄露阈值/配额/Retry-After | Agent 深读(`setHeaders:false`+`ThrottlerBizGuard`)+ 实测 | PASS |
| | 错误响应不外泄 stack/内部细节 | Agent 深读(`AllExceptionsFilter` 构造期注入 boolean) | PASS |
| | `x-request-id` 不进响应体/JWT payload | Agent 深读 + 实测响应头/body | PASS |
| B 密钥/配置 | `JWT_SECRET`=默认值生产拒绝 | **lead 直接实跑**(真实进程,exit 1) | PASS |
| | `APP_CORS_ORIGIN` 空/`*` 生产拒绝 | **lead 直接实跑**(真实进程,exit 1 ×2) | PASS |
| | `SUPER_ADMIN_PASSWORD`/`USERNAME=admin` seed 时生产拒绝 | **lead 直接实跑**(seed 负向测试 ×2) | PASS |
| | `.env.example` 与代码读取完全对齐 | **lead 直接实跑**(双向 diff) | **FINDING(B-1,🟡)** |
| | 全仓无硬编码密钥 | **lead 直接实跑**(全仓 grep) | PASS |
| C 认证/授权首次上线 | JwtStrategy 逐请求查库、不受 RBAC 缓存滞后影响 | Agent 深读(`jwt.strategy.ts`↔`rbac-cache.service.ts` 隔离性) | PASS |
| | refresh 轮换/家族撤销策略成立 | Agent 深读(`auth.service.ts`↔`AGENTS.md §9`) | PASS |
| | SUPER_ADMIN bootstrap 安全、铸造路径唯一 | Agent 深读(全仓 grep `Role.SUPER_ADMIN`) | PASS |
| | **scoped-authz day-1 陷阱**:清单是否清晰覆盖终审绑定初始化 + 单点风险警示 | Agent 深读(全文通读 checklist + `action-constraints.ts`) | **FINDING(C-1,🟡)** |
| | 22074 自审兜底恒拒(含 SUPER_ADMIN) | Agent 深读 + BizCode 定位 | PASS |
| D 数据安全 | 生产迁移只走 `migrate deploy`,Dockerfile 无自动迁移 | **lead 直接实跑**(通读 Dockerfile) | PASS |
| | 39 migration 干净库重放零报错 | **lead 直接实跑**(scratch DB,用户同意) | PASS |
| | seed 幂等且计数吻合基线 | **lead 直接实跑**(scratch DB ×2) | PASS |
| | #494 不可逆迁移仍为 pre-production 拍板、行为不变 | lead 直读 `prisma/CLAUDE.md` + CHANGELOG | PASS |
| | DB 备份/恢复策略说明(无→advisory) | lead 直接 grep `deployment.md` | **FINDING(D-1,🟡)** |
| | PII at rest(idCard v1 明文)仍为接受项、不翻案 | lead 直读 `current-state.md §3` | PASS(确认接受项仍成立) |
| E 运维就绪 | 5 份 ops 清单完整/准确/无死链/示例假数据 | Agent 深读(逐文件 + 逐链接 + 逐权限码交叉核对) | **FINDING(E-1,🟡ᐩ🟢,COS+realname 两清单)**,其余 3 份 PASS |
| | 自动重启说明 | Agent 深读 `deployment.md` | PASS |
| | 崩溃兜底(`uncaughtException`/`unhandledRejection`→fatal+exit(1)) | Agent 深读 + **lead 正对照实测复现该链路** | PASS |
| | 健康检查三端点(live/ready/health) | Agent 深读 `health.controller.ts` | PASS |
| | 优雅关闭 | Agent 深读(`main.ts`↔`prisma.service.ts`) | PASS |
| | 单实例前提 + 进程内缓存清单 + 唯一 cron 文档完整 | Agent 深读 `deployment.md` 顶部段 | **FINDING(并入 E-1,🟡,9→10 计数漂移)** |
| F 可观测/失败就绪 | 日志 redact 清单覆盖全部敏感字段 | Agent 深读(`logger-options.ts`↔`docs/security.md`↔DTO/schema 全仓扫描) | **FINDING(F-1,🟡)** |
| | 生产 stdout 为 JSON | Agent 深读 + **lead 正对照实测复现** | PASS |
| | 无 PII 明文进日志(ad-hoc 调用点扫描) | Agent 深读(60 处 `this.logger.*` 调用点逐一核) | PASS |
| | 关键写路径无静默吞错 | Agent 深读(audit-logs/auth/insurance 全模块 catch 块扫描) | PASS |
| G 文档↔代码↔清单一致性 | `current-state.md §1` 计数与实跑一致 | **lead 直接实跑**(全部 6 项计数逐一核对) | PASS |
| | `## Unreleased` 2 条与 main 实况一致 | **lead 直接实跑**(`gh pr view`+`git log`) | PASS |
| | 版本四方一致 | **lead 直接实跑** | PASS |
| | (副产品)`CODEMAP.md` 引用完整性 | **lead 直接实跑**(`docs:codemap:check` 输出解读) | **FINDING(G-1,🟢)** |

---

## 3. 🟡 应在上线前处理(5 项)

### B-1 — `.env.example` 未声明 4 个实际被读取的限流器环境变量,且相关文档仍写"9 个限流器"

- **现状**:`src/bootstrap/throttle-options.ts:27-91` 实际注册 **10** 个 `ThrottlerModuleOptions.throttlers[]` 实例(`default`/login、password-change、refresh、sms-send、sms-verify、password-reset、login-sms、login-wechat、recruitment、content-public),代码自身注释已标至"十实例"(`throttle-options.ts:84-86`)。但:
  1. `.env.example`(172 行)**未声明** `RECRUITMENT_THROTTLE_LIMIT`/`RECRUITMENT_THROTTLE_TTL_SECONDS`(2026-06-18 招新一期引入)与 `CONTENT_PUBLIC_THROTTLE_LIMIT`/`CONTENT_PUBLIC_THROTTLE_TTL_SECONDS`(2026-06-21 CMS 内容模块引入),而 `src/config/app.config.ts:512-528`(recruitment)与 `:531-544`(content-public)确实读取这两对变量——与其余 8 个限流器家族的声明方式不一致(每个都在 `.env.example` 有专属注释块)。
  2. `docs/deployment.md:4`(单实例前提段)仍写"**9** 个内存限流器",其变更记录称"2026-06-20 #399 F17/F19...限流器 8→9"——恰好在 content-public 于 2026-06-21 上线**前一天**做的最后一次 true-up,此后再未同步。
  3. `docs/ops/realname-verification-rollout-checklist.md:42` 提到 `RECRUITMENT_THROTTLE_*` 可配置,但未提示这两个变量其实不在 `.env.example` 里——依赖 `.env.example` 作为环境变量权威参考的运维员(其余 3 份清单都明确这样引导)不会发现这两个旋钮存在。
- **失败场景**:这两对变量都有硬编码 fallback(recruitment 10/3600、content-public 60/60),**不影响启动**,纯粹是"配置模板与代码实际可配置项不完全对齐"——运维员想要调整招新报名或内容读取的限流阈值时,`.env.example` 里找不到对应条目,可能误以为不可配置,或需要额外去读源码才能发现变量名。
- **证据**:`src/bootstrap/throttle-options.ts:27-91`;`src/config/app.config.ts:512-544`;`.env.example`(全文 grep 确认无 `RECRUITMENT_THROTTLE_*`/`CONTENT_PUBLIC_THROTTLE_*`);`docs/deployment.md:4`;`docs/ops/realname-verification-rollout-checklist.md:42`。
- **建议**:`.env.example` 补 2 组共 4 行声明(镜像既有节奏);`deployment.md:4` 的"9"改"10"并补 content-public 一行枚举。纯文档/模板改动,A 档。

### C-1 — scoped-authz 上线清单:考勤终审"两人互备"建议不是强制勾选项,风险提示位置不显眼

- **现状**:`docs/ops/scoped-authz-go-live-checklist.md` §5 的核心机制(为什么需要绑定 / 完整 `POST` 请求体 / 3 个前置 `GET` 查询)表达清晰准确,并且**确实包含**单点风险的文字提示:
  - §5 正文(约 L86-88):摘码后"**不再随 `biz-admin` 天然生效**...必须显式建立至少一条 `attendance-final-reviewer` 的 role-binding,否则**没有任何 `ADMIN` 能终审,只能靠 `SUPER_ADMIN` 兜底**"。
  - §5 代码块后的散文句(约 L108):"副部长同法再建一条(两人互为备份,规避'终审链只有一人'的单点风险;见 §7)"。
  - §7(约 L134):最完整的风险陈述——"若 §5 只建了一条绑定...该人请假/离职/换届期间终审链会中断到只剩 `SUPER_ADMIN` 可用;建议至少两人(正副部长)同时持有绑定"。
  - §6(约 L119)验收清单里**确实有**"只持 biz-admin、未建绑定的普通 ADMIN 应返回 `no_permission`"这条可执行验证,§8 排错表也有"终审返 30100 → 查 §5 绑定"这一行。
- **问题**:§5 唯一的 4 个 `- [ ] ` 勾选项都只覆盖"建第一条绑定"这条主线,建第二人这件事被表达成代码块**之后**的一句夹叙夹议的散文(不是勾选项),而措辞最完整的风险提示藏在标题看不出关联的 §7("env 项确认")里。一个从头到尾认真读的运维员会看到这句话,但一个"完成 §5 的 4 个勾选项就认为这一步做完了"的运维员——在真实上线的时间压力下相当可能——会跳过 §7(它读起来像是在确认环境变量,不像是在警告单点故障)和 L108 的夹叙夹议。
- **失败场景**:运维部署、走完 §1-§4,在 §5 只为部长建了 1 条 `attendance-final-reviewer` 绑定,勾完 4 个复选框后继续往下(或直接结束),上线后第 2 周部长请假,组织发现除 SUPER_ADMIN(按仓库惯例应保留、不用于日常运营)外没有任何人能终审考勤。
- **证据**:`docs/ops/scoped-authz-go-live-checklist.md` §5(勾选项结构 + 代码块后散文)、§6(验收用例存在但不是 §5 的强制出口条件)、§7(风险陈述最完整但标题无关联)、§8(排错表存在诊断路径)。
- **建议**:把"再建第二人绑定"从散文提升为 §5 内的第 5 个 `- [ ]` 勾选项,并在 §5 开头加一行引用块提示"完成本节前须至少建 2 条绑定"。纯文档改动,A 档,不改代码/权限。

### D-1 — `docs/deployment.md` 未记录任何 DB 备份 / 恢复策略

- **现状**:全文 grep `deployment.md` 的"备份"/"backup"/"恢复"/"restore"/`pg_dump`/`pg_restore` 关键词 **0 命中**(`current-state.md` 里出现的"恢复"字样均为"失败可恢复的原子性设计"语境,与 DB 灾备无关)。
- **失败场景**:本系统即将首次装载真实业务数据(队员、活动、考勤、证书、组织架构)。若磁盘故障、误操作(如管理员误跑破坏性 SQL)、宿主机丢失导致 Postgres 数据卷损坏或丢失,当前文档没有给出任何"如何恢复到某个时间点""多久备份一次""备份存在哪里"的指引——不是代码或架构缺陷(Postgres 本身支持标准的 `pg_dump`/WAL 归档/云托管商自带快照等多种方案,选型是纯运维决策),而是文档层面完全空白。
- goal 原文对此项的态度是"无 → advisory"(非强制阻断),此处按 5 项 🟡 中"风险量级最高"的一项呈现,供维护者按实际托管环境(自建 / 云托管商)决定具体方案后归档。
- **证据**:`docs/deployment.md` 全文关键词扫描 0 命中。
- **建议**:补一小节"数据备份与恢复"到 `deployment.md`,内容可以很简单(例如:托管数据库自带的每日快照 + 保留期,或自建场景下的 `pg_dump` cron + 异地存放建议),不需要在本 goal 内实现,只需要作为下一批文档改动的一项登记。

### E-1 — COS 生产运维清单:27 处死链 + 1 处权限守卫描述与代码不符

- **现状**(`docs/ops/cos-production-rollout-checklist.md`):
  1. **死链**:文中所有指向 `docs/批次7_provider选型_API前评审.md`(9 处引用)与 `docs/handoff/v0.11.0.md`(11 处引用)的相对链接均已失效——这两个文件已于 2026-05-21(commit `23362e86`)被移动到 `docs/archive/batches/`、`docs/archive/handoff/`,清单撰写/最后编辑时间晚于该次归档但从未更新链接,累计 **27 处**死链接出现(部分段落同一小节内重复引用同一目标)。
  2. **权限守卫描述不符**:§7.1(约 L404)声称 storage-settings 三端点挂 `@Roles(SUPER_ADMIN, ADMIN)`。实际 `src/modules/storage/storage-settings.controller.ts:41-82` **没有任何** `@Roles` 装饰器,鉴权完全走 Service 内 `rbac.can()` 判断(`storage-setting.{read,update}.singleton` / `.reset.credentials`);且 `reset-credentials` 是**仅 SUPER_ADMIN**(ADMIN 被排除),与文档写的"ADMIN"直接矛盾。
- **失败场景**:运维在执行 §11(红线依据交叉引用)时点开死链,拿不到期望的背景材料,需要自行搜索归档目录;运维在排查 `reset-credentials` 返回 403 时,若照文档以为"ADMIN 也应该能过",会误诊断为代码 bug 而不是"这本来就是仅 SUPER_ADMIN 的设计"。
- **证据**:文档全文的 9+11=27 处链接引用(死链目标已确认移动到 `docs/archive/batches/`、`docs/archive/handoff/`);`src/modules/storage/storage-settings.controller.ts:27-82` 无 `@Roles`;`src/modules/storage/CLAUDE.md`("入口判权当前事实"段)确认当前设计是 Service 层 `rbac.can()`、`reset.credentials` 仅 SA。
- **建议**:批量替换 27 处死链路径为 `archive/` 新址;更正 §7.1 一句描述为"Service 层 `rbac.can()` 判权,`reset-credentials` 仅 SUPER_ADMIN"。纯文档改动,A 档。
- **附带一项 🟢(已并入本条,不单独计数)**:`docs/ops/realname-verification-rollout-checklist.md` §1.1 提到 `RECRUITMENT_THROTTLE_*` 两个可配置变量,但正如 B-1 所述,这两个变量当前不在 `.env.example` 里——同一根因,修复应与 B-1 一并处理。

### F-1 — 结构化日志脱敏清单:文档记录了代码里不存在的字段,且 5 个自证敏感的字段未被覆盖

- **现状**:`src/bootstrap/logger-options.ts:27-102` 实际维护 **48** 条 redact 路径(HTTP 头 3 + body 字面量 5 + v1 通配符 7 + 身份证 4 + 联系方式 9 + 医疗 7 + 金融 6 + 地址 3 + 出生日期 3 + 第三方 ID 7)。对照发现两类问题:
  1. **文档记录了代码里从未存在过的字段**:`docs/security.md:33-55` 只记录了最初 17 条(2026-05-17 引入自助改密时的版本),且**声称**存在 `req.body.oldPassword` / `*.oldPassword` 两条 redact 规则(`docs/security.md:40,46`)——`git log -S "oldPassword" -- src/bootstrap/logger-options.ts` 返回 **0** 个历史提交,这两条规则从未在代码里出现过。`ChangeMyPasswordDto.oldPassword`(`src/modules/users/users.dto.ts:183`)是一个真实存在的活跃请求字段,当前**零** redact 覆盖(目前不可利用,因为 HTTP body 默认不会被自动整体打日志,但清单本身的可信度受损)。
  2. **代码层面的真实覆盖缺口**(不只是文档滞后):`RecruitmentOcrDetailDto` 的 6 个同构兄弟字段(`sex`/`nation`/`birth`/`authority`/`validDate`,`src/modules/recruitment/recruitment.dto.ts:182-198`,注释自证"申请人本人 PII;不入日志")里,只有 `address` 恰好命中既有的 `*.address` 通配符,其余 5 个零覆盖;`MemberProfile.documentNumber`(schema 注释"MP-5 高敏感")与 `realName` 类字段没有任何 `*.name`/`*.realName`/`*.documentNumber` 模式;命名口径不一致也造成漏网(`certNumber` vs 清单的 `certificateNo`、`policyNumber` vs `policyNo`)。`src/common/audit/mask-pii.util.ts:54-55` 的注释已自认 `documentNumber` "prepared but not yet wired"。
- **不构成 🔴 的理由**:F-3(见 §4)的独立 60 处 `this.logger.*` 调用点扫描确认,当前代码里没有任何调用点会把整个 DTO/实体/`req.body` 原样打进日志——都是显式构造只含安全字段的最小日志载荷。也就是说 redact 清单目前**没有被真正触发**去挡一个本该挡的字段,这是"设计上的兜底网有破洞"而非"现网正在漏 PII"。
- **证据**:`src/bootstrap/logger-options.ts:27-102`(实际 48 条清单);`docs/security.md:33-55`(声称的 17 条,含虚构的 `oldPassword`);`src/modules/users/users.dto.ts:183`;`src/modules/recruitment/recruitment.dto.ts:182-198`;`prisma/schema.prisma:549`;`src/common/audit/mask-pii.util.ts:54-55`。
- **建议**:①`docs/security.md` 的 redact 清单段落 true-up 到实际 48 条(去掉不存在的 `oldPassword`,补齐 V2 基线的 41 条);②给 `logger-options.ts` 补 5-8 条新通配符模式(`*.sex`/`*.nation`/`*.birth`/`*.authority`/`*.validDate`/`*.documentNumber`/`*.realName`/`*.certNumber`/`*.policyNumber`)作为防御性兜底。B 档(涉及安全配置文件改动,虽然是纯增量兜底,建议走正常 D 档降速流程而非 docs-only)。

---

## 4. 🟢 可延后(3 项)

### C-2 — `docs/security.md` 未补 scoped-authz 交叉引用

`docs/security.md` 全文 grep `scoped-authz|attendance-final-reviewer|22074|22075|role-binding|RoleBinding` **0 命中**。2026-07-01→07-03 的终态 scoped-authz 12-PR 序列 + 摘码微刀(#482)从未同步进这份文档。**不构成阻断**的理由:`docs/security.md` 在本仓自己的文档权威分层里从未被标注为 RBAC/authz 设计的权威源(那是 `AGENTS.md §8/§13` + `docs/ops/scoped-authz-go-live-checklist.md` + `src/modules/authz/CLAUDE.md`,三者内容均准确、C-1 已核实),按正确入口(current-state.md → 本文档权威表)寻找信息的运维/AI 都不会被这个缺口误导。建议在 `security.md` 现有 token/密码章节后加一行指向 go-live checklist 的交叉引用即可。

### G-1 — `CODEMAP.md` 漏引用 `organizations/CLAUDE.md`(由 `## Unreleased` 内 #495 引入)

`pnpm docs:codemap:check` 的 `claude-md-referenced` 规则(`scripts/check-codemap.ts:236-258`)标记 `src/modules/organizations/CLAUDE.md` 未被 `CODEMAP.md` 引用。溯源:该文件由 PR #495(`790bf5c9`,2026-07-04,当前挂在 `## Unreleased`)首次创建/大改,但 `CODEMAP.md` 第 35 行的 `organizations/` 表格行"本地约束"列仍是占位符 `—`,未同步补上 `[CLAUDE.md](src/modules/organizations/CLAUDE.md)` 链接(`CODEMAP.md:49` 本身写明"已存在的 module-local CLAUDE.md 均应在本表行内引用...可由 `pnpm docs:codemap:check` 检出")。零运行时影响,纯导航性 WARN,下次 A 档文档清扫可顺手补上一行链接。

### B-2 — `jwt.config.ts` 的默认密钥拒绝校验对 `smoke` 环境不生效

`src/config/app.config.ts:15-17` 的 `isProductionLike(env)` helper(`production` 或 `smoke` 均为 true)被 `STORAGE_ENCRYPTION_KEY`/`SMS_ENCRYPTION_KEY`/`WECHAT_ENCRYPTION_KEY`/`REALNAME_ENCRYPTION_KEY`/`APP_CORS_ORIGIN`/`ENABLE_SWAGGER` 等几乎所有生产态校验一致使用;唯独 `src/config/jwt.config.ts:33` 的默认密钥拒绝写的是严格 `process.env.APP_ENV === 'production'`,不覆盖 `smoke`。`app.config.ts` 头部注释(L11-14)明确写道 smoke "几乎全部沿 production 行为,**唯一例外** = storage_settings fail-fast",而 jwt.config.ts 这里实际上是第二个未被记录的例外。**不构成风险**的理由:`smoke` 是 CI Docker smoke test 专用环境,注释明确"不得用于真实部署",不会有真实生产流量流经该分支,也不会有人为 smoke 配置默认密钥去骗过生产检查后拿去真实部署。仅作为一处代码/文档双方"设计不变量"表述与实现之间的小漂移记录。

---

## 5. 覆盖边界说明(非漏扫的依据)

- **未做实时生产环境全链路联调**:所有负向测试(JWT_SECRET/CORS/SUPER_ADMIN)均针对单一配置项做最小化隔离验证(其余变量保持合法),未启动一个"配置完全合法、四把加密 key 与 storage_settings 均就绪"的完整生产态实例并跑通登录/业务全链路——这需要真实或高仿 COS 凭证与更多准备,超出"只读校验"授权边界,且核心崩溃/fail-fast 机制已通过更细粒度的分项测试逐一验证,联调收益边际递减。
- **未接真实第三方凭证**:COS / 短信 / 微信 / OCR 四条通道的"真实凭证可用性"本就不在本审计范围内(goal 明确排除),4 份对应运维清单只审"清单本身完整性/准确性",未执行清单里的落库步骤。
- **429 实测样本有限**:仅对 1 个公开限流端点做了 ≤20 请求的小批量探测(避免对共享的同 commit 影子实例造成滋扰),未逐一验证全部 10 个限流器的 429 响应体,但响应头抑制(`setHeaders:false`)与响应体构造(`ThrottlerBizGuard.throwThrottlingException`)是所有 10 个实例共用的同一段代码,单点验证足以代表全部。
- **未复扫代码正确性**:god-service 内部逻辑、业务规则正确性、RBAC 判权矩阵等已由 2026-07-03 review(#484)覆盖,本审计只读取其结论用于"对账"(§6),不重新验证。
- **service 单测覆盖率 / god-service 拆分等已接受架构债务**:按 goal 授权,只核实其接受理由仍成立(见 §6),不重新评估是否应该改变架构决策。

---

## 6. 与 `current-state.md §3/§4` 已知/已接受项对账

| 已接受项 | 记录位置 | 本轮核实结论 |
|---|---|---|
| 单实例架构(内存限流器状态 / RBAC 缓存 / 4 个 settings 缓存 / 唯一生日 cron) | `current-state.md §2`(v1.1 底座行)/ `deployment.md` 顶部 | **仍成立**,文档基本完整,唯一漂移是限流器计数 9→10(已升级为 B-1/E-1 新发现,而非重新质疑"是否应该单实例"这个架构决策本身) |
| god-service 体量观察(6 个 >700L) | `current-state.md §4` P2 行 | **仍成立且计数不变**——`pnpm docs:codemap:check` 本轮实测同样 6 个候选、同样的文件与行数,无新增(除 organizations 相关的 G-1,那是文档引用问题不是体量问题) |
| service 单测占比 ~11.8% | `current-state.md §4` P2 行 | 未重新测量(不在本审计方法范围内,goal 未要求),不翻案 |
| Mixed Controller 存量 2 处 | `current-state.md §4` P2 行 / `api-surface-policy.md §5.1` | 未在本轮触及(不属于 A-G 任一域的检查项),不翻案 |
| contract snapshot ~1MB/35,777 行 | `current-state.md §4` P2 行 | 本轮 `pnpm test:contract` 525 例全绿,未整读 snapshot,不翻案 |
| SMS / 招新失败者 retention 手动 SQL SOP(不解锁 cron) | `current-state.md §4` P3 行 / 对应两份 `*-data-retention-sop.md` | **仍成立**,E 域审计的 5 份清单未覆盖这两份 retention SOP(它们不在 goal 列出的"5 份 rollout 清单"范围内),不翻案 |
| 保险到期无自动提醒(cron 仅生日批) | `current-state.md §4` P3 行 | 不在本审计范围(non-cron 升级路径决策),不翻案 |
| 招新 28003 同轮去重可枚举 | `current-state.md §4` P3 行 | 不在 A-G 任一域范围内,不翻案 |
| 招新二期外籍 admin 手动建档 | `current-state.md §3` | 不在 A-G 任一域范围内,不翻案 |
| **身份证号 v1 明文入库**(`idCardNumber`/`member_profiles.documentNumber`) | `current-state.md §3` L77(2026-06-18 维护者拍板) | **核实接受理由仍成立**:拍板原文"留作审计痕迹"、"落库加密/哈希归既有 C-8 合规议题单独处理"的措辞与当前 schema 现状(`idCardNumber String?` 明文)一致,本轮**不翻案**,仅在 F-1 中作为"应覆盖但已确认不可逆改变加密方式"的字段提及其日志脱敏覆盖缺口(这与"是否应该加密落库"是两个独立问题) |
| Docker Smoke non-required(CI 非强制门禁) | goal 原文列举项 | 未在本轮重新验证 CI 配置(不在 A-G 任一域检查项内),不翻案 |

**结论**:本轮 8 项新发现与上表**零重叠**——没有一项是把已接受债务重新包装成"新问题"上报。

---

## 7. 修复分批建议(供后续 review-then-fix goal 立项;本 goal 不修)

| 批次 | finding | 档 | 备注 |
|---|---|---|---|
| **数据安全批**(需维护者先决定托管/备份方案,不是纯代码修复) | D-1(DB 备份/恢复策略缺失) | 待拍板 | goal 原文态度是 advisory;建议维护者先确定实际托管环境(自建 vs 云托管商自带快照)再落笔,不需要新增代码 |
| **上线运维清单硬化批** | C-1(scoped-authz 两人互备提升为勾选项)+ E-1(COS 死链 27 处 + 权限守卫描述纠正)+ 呼应 realname 清单的 `.env.example` 提示 | A | 三者均为纯 docs 改动,可一次性清完,建议随下一批"文档一次性大扫除"处理(沿 v0.34.0 review 报告 §7 的 A 档先例) |
| **配置模板对齐批** | B-1(`.env.example` 补 4 行 + `deployment.md` 限流器计数 9→10) | A | 纯文档/模板补全,零代码变更 |
| **日志脱敏硬化批** | F-1(`docs/security.md` true-up 到实际 48 条 + `logger-options.ts` 补 5-8 条新通配符) | **B**(涉及安全配置代码,虽是纯增量兜底,不建议塞进 docs-only PR) | 建议独立 goal,附带补 1-2 个 spec 断言新增字段确实被 redact |
| **文档导航批**(可与配置模板对齐批合并一次处理) | G-1(`CODEMAP.md` 补 organizations 行引用)· C-2(`docs/security.md` 补 scoped-authz 交叉引用) | A | 纯 docs,零风险,可顺手清 |
| **代码/文档不变量核对批**(极低优先级,仅记账) | B-2(`jwt.config.ts` smoke 例外未文档化) | A/记账 | 可选择"补一行注释说明这是第二个例外"或"改成 `isProductionLike` 让 smoke 也校验默认密钥"两种方向之一,需要维护者判断哪种更符合 smoke env 的设计初衷,建议先记 `NEXT_TASKS` 观察,非紧急 |

> 每批应循 `docs/process.md` 单独立项;A 档沿惯例可直接推进,B 档(F-1 日志脱敏代码改动)需维护者拍板后再开工。**本报告不构成任何 fix 授权**——本 goal 明确"只审不改",上述分批建议仅供下一个 review-then-fix goal 引用立项。

---

## 8. 附:本轮方法与规模

- **4 个后台 agent**(域 A/C/E/F,均为 `general-purpose` 类型)+ **lead auditor 直接实跑**(域 B/D/G 的全部命令与 scratch DB 操作)。
- agent 规模:约 523,780 tokens、196 次工具调用,分布:A(88,202 / 47)、C(118,740 / 24)、E(170,181 / 53)、F(146,657 / 72)。
- lead 直接产生的关键证据:39-migration 干净库重放、seed 幂等 ×2、SUPER_ADMIN 生产负向测试 ×2、JWT_SECRET/CORS 生产负向测试 ×3 + 正对照 ×1(共 4 次真实进程 boot)、429 实测、`.env.example` 双向 diff、全仓硬编码密钥扫描、Dockerfile 通读、6 条核心校验命令(lint/typecheck/build/test:contract/docs:codemap:check/docs:rbacmap:check)+ `pnpm audit -P`、版本四方核对、`## Unreleased` 2 条 PR 状态核对。
- 隔离资源:1 个 scratch database(`app_readiness_scratch`,审计结束已 `dropdb`),0 个持久化产物遗留于共享 DB 或代码库(除本报告文件本身)。

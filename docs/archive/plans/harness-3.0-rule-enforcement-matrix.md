# Harness 3.0 规则 × 执法载体 × 执行体矩阵(P0 冻结稿)

> 状态:随蓝图一并冻结(2026-07-28 拍板);本文件是 P2「执法迁移」与 P3「恒读重写」的施工依据。
> 生成方式:两个侦察 agent 逐条通读 AGENTS.md §1/§2/§3 与 process.md §2/§3/§4/§5.4/§7,并对照 eslint.config.mjs、.claude/settings.json、ci.yml、contract spec、scripts/ 与 src 抽样核实现状后产出;主会话通读复核。
> 分类语义:**机器化**=可落为 lint/hook/CI/权限规则/守护脚本;**路径注入**=判断型但可绑定文件路径在触碰时自动弹出;**留散文**=无法机器化的判断型规则,保留在恒读层判断原则区;**已冗余可删**=同文件他处已承载或执法已完备,删复述不删约束。
> **迁移铁律:任何散文只有在对应机器执法达 enforce 态且自测绿后才允许删;删除映射由 CI 在迁移期守护。**

## 总览:114 条规则

| 分类 | 条数 |
|---|---|
| 机器化 | 76 |
| 留散文 | 18 |
| 路径注入 | 10 |
| 已冗余可删 | 10 |

| 执行体覆盖 | 条数 |
|---|---|
| 双模型 | 76 |
| 仅Claude+需补agent无关层 | 38 |

注:「仅Claude+需补agent无关层」= 现有/规划载体为 Claude 专属(hooks/settings),矩阵已为每条配对 agent 无关补层(CI/git hooks/守护脚本);纯「仅Claude」为 0——**每条「绝不」规则都有对双模型生效的载体**。

## 第一部分:AGENTS.md §1 铁律速查 + §2 决策锁(R-01 ~ R-35)

### R-01 · AGENTS.md §1 表第 1 行(包管理)

- **规则**:pnpm-only,禁 npm / yarn / bun(lockfile 防漂移)
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:settings deny `Bash(npm *)`/`Bash(yarn *)`/`Bash(bun *)`(已有,.claude/settings.json:5-7)+ 新增 package.json `preinstall` 本地守卫(校验 `npm_config_user_agent` 前缀为 pnpm)+ CI job `harness-guards` 断言仓库无 package-lock.json / yarn.lock / bun.lockb
- **要点**:现状唯一载体是 settings deny = Claude 专属;preinstall + lockfile 断言才覆盖 Codex 与人手。preinstall 用仓内 5 行脚本,别用 `npx only-allow`(联网 + 引 npm)。CI 已 `pnpm install --frozen-lockfile`,lockfile 漂移本身已红。

### R-02 · AGENTS.md §1 表第 2 行(跨文件改动)

- **规则**:先符号 / 引用链确认再动手;grep 同名只定位候选,禁凭同名盲改
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区
- **要点**:typecheck 只兜住语法级断链,同名语义盲改无产物特征无法断言。可加的只有 Edit 前提示型 hook,约束力≈散文却增加噪音,不值得。散文写在 AGENTS 里双模型都读得到。

### R-03 · AGENTS.md §1 表第 3 行(模块结构)

- **规则**:4 文件基线平铺 `src/modules/`;禁嵌套子目录 / `*.entity.ts` / 跨模块 util grab-bag
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:结构测试 `src/common/harness/module-structure.spec.ts`(被 test/jest-unit.config.ts 的 `src/.*\.spec\.ts$` 捕获,CI `pnpm test` 必跑且不受 docs-only 跳过):①全仓 `**/*.entity.ts` 数 === 0 ②`src/modules/*` 子目录名 ∈ 白名单 {dto, controllers, providers, strategies} 且 dto 二级仅 {app, admin} ③每模块必有 `<name>.module.ts`;跨模块 grab-bag 用 eslint `no-restricted-imports` 禁跨模块深引(只许 `*.service|*.dto|*.module|*.types`)
- **要点**:⚠「禁嵌套子目录」已被现实解锁:实测 20+ 模块存在 dto/ controllers/ providers/ strategies/,且 dto/app、dto/admin 是二级。搬迁时必须把 AGENTS 该行绝对措辞改写成白名单表述(语义不放宽,只是把已解锁例外显式化),否则规则与代码互冲。`*.entity.ts` 实测 0 个,可直接硬判。

### R-04 · AGENTS.md §1 表第 4 行(命名)

- **规则**:`passwordHash` / `key` / `createdAt` / cuid 主键;enum 从 `@prisma/client` 导入;username / email 入库查询前 trim + lowercase
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:eslint `no-restricted-syntax` 禁本地重定义 Prisma enum:`TSEnumDeclaration[id.name=/^(Role|UserStatus|...)$/]`,名单由 `scripts/check-prisma-conventions.ts` 从 schema.prisma 生成;同脚本挂 CI 断言每 model 必 `id String @id @default(cuid())` + createdAt/updatedAt、禁 `Int @id @default(autoincrement())`;trim+lowercase 留散文
- **要点**:⚠ 不能一刀禁 `TSEnumDeclaration`:实测 6 个合法本地 enum(SmsCredentialStatus / StepUpAction / IdentityStepUpFactor / WechatCredentialStatus / CredentialStatus / RealnameCredentialStatus)不是 Prisma enum,selector 必须按 schema 生成的名单精确匹配。trim+lowercase 是运行期语义,只能靠 auth/users service 的既有范式 + e2e。

### R-05 · AGENTS.md §1 表第 5 行(响应格式)

- **规则**:一律 `{code,message,data}` 包装,业务只 return data;分页固定 DTO,禁 limit/offset/cursor;Swagger 路径不包装
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:已有全局 `src/common/interceptors/response.interceptor.ts` + contract `paths` 全量快照(结构性锁定);增量 eslint `no-restricted-syntax`:①禁 controller 内手工包装 `ReturnStatement > ObjectExpression:has(Property[key.name='code']):has(Property[key.name='message'])` ②禁 Query DTO 出现 `PropertyDefinition[key.name=/^(limit|offset|cursor|skip|take)$/]`(files 限 `src/**/*.dto.ts`)
- **要点**:⚠ 存量两处合法 `limit`(src/modules/activities/activities.dto.ts:674、src/modules/member-departments/memberships.dto.ts:322,注释明示「不分页,受 limit 截断」)须进 allowlist 或就地 eslint-disable,否则规则一开即红。包装本身由拦截器结构性保证,lint 只防手工二次包装。

### R-06 · AGENTS.md §1 表第 6 行(错误码)

- **规则**:`BizCode` 三字段 `as const` 集中一处;段位锁死(每模块 200 号段);禁自创 token 类 100xx;新码先说明场景
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:已落地:`src/common/exceptions/biz-code.constant.spec.ts` 断言 key 大写 SNAKE_CASE / code 正整数 / 落在已分段范围 / message 非空 / httpStatus 合法 / code 与 key 全局唯一;增量结构测试断言全仓仅该文件定义 BizCode 条目(禁第二处码表);「新码先说明场景」进 PR 模板
- **要点**:该行约 90% 已机器化,AGENTS 可压成一句指针 + spec 文件名。段位表就写在 spec 里,新模块开段 = 改 spec = 有 diff 可审,天然满足「段位锁死」。BizCode 计数 278 已进 current-state 计数守护。

### R-07 · AGENTS.md §1 表第 7 行(Swagger)

- **规则**:100% 覆盖;分页必用 `@ApiWrappedPageResponse`;禁裸 `@ApiOkResponse`
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:eslint `no-restricted-syntax` 禁 `Decorator[expression.callee.name='ApiOkResponse']`(message 指向 `ApiWrappedOkResponse`)+ contract 断言每 operation 有非空 summary 与至少一个 2xx(现有断言只查 responses 非空)+ 分页形状(items/total/page/pageSize)的 operation 必须由 `ApiWrappedPageResponse` 产出
- **要点**:实测全仓裸 `@ApiOkResponse` = 0 处,零存量违规 = 零成本翻 error。典型「散文靠自觉、事实已 100% 合规」样本:规则搬进 lint 后约束力从『下次可能忘』升为『下次不可能』。

### R-08 · AGENTS.md §1 表第 8 行(校验)

- **规则**:全局 ValidationPipe(whitelist + forbidNonWhitelisted + transform);禁局部重复;DTO 白名单是第一道防线;`:id` 一律 `IdParamDto`
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:eslint `no-restricted-syntax`:①禁局部 `NewExpression[callee.name='ValidationPipe']`(files override 放行 `src/main.ts` / `src/bootstrap/**`)②禁 `Decorator[expression.callee.name='Param'][expression.arguments.0.value='id']`,message 指向 `IdParamDto`
- **要点**:⚠ 关键冲突:实测 71 处 `@Param('id') id: string` 分布在 19 个 controller(team-join / recruitment / content / certificates / notifications / insurances …),与「`:id` 一律 IdParamDto」直接矛盾。语义零放宽 = 要么先起一轮统一重构再翻 error,要么落 baseline 白名单逐轮清零,不能直接开。ValidationPipe 那条零存量,可立即 error。

### R-09 · AGENTS.md §1 表第 9 行(鉴权)

- **规则**:Guard 全局注册禁 `@UseGuards`;`@Public` 与 `@Roles` 互斥;判权单轨;JwtPayload 仅 `{sub,username}`;身份有效性每请求查库不缓存
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:eslint `no-restricted-syntax` 禁 `Decorator[expression.callee.name='UseGuards']` 与 `Decorator[expression.callee.name='Roles']`(files override 放行 `src/common/guards/roles.guard.ts` 与 `src/common/decorators/*.decorator.ts` 定义处);JwtPayload 形状由 contract `components.schemas` 快照锁;不缓存见 R-31
- **要点**:实测 `@UseGuards` 与 `@Roles` 活跃使用均为 0(仅存在于注释与 decorator 定义文件),两条可直接 error。禁 `@Roles` 同时把 §2「判权单轨」的核心事实(全仓活跃 @Roles = 0)变成编译期不可破。

### R-10 · AGENTS.md §1 表第 10 行(密码 / token)

- **规则**:`passwordHash` 永不出响应;bcrypt 落库;refresh token 行为冻结(§2 P0-E)
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:新增 contract 断言「L3 字段禁出」:遍历 `doc.components.schemas` 全部属性名,命中 `/passwordHash|tokenHash|secretKey|secretId|refreshTokenHash|encrypted/i` → 拒;`accessToken|refreshToken` 仅 LoginResponseDto 等常量白名单 schema 可有;refresh 行为冻结走红区路径(R-28)
- **要点**:⚠ 本轮发现的真实执法缺口:test/contract/openapi.contract-spec.ts 里只有全量 schema 快照,没有属性名黑名单断言。快照能记录泄露字段,但一次盲 `-u` 就能洗掉;黑名单断言是快照之外的第二道、且无法被 `-u` 更新。

### R-11 · AGENTS.md §1 表第 11 行(软删除)

- **规则**:禁 `delete()` / 全局软删中间件;`notDeletedWhere` 统一过滤;唯一性预检查用 `findUnique`(含软删);详情用 `findFirst`
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:eslint `no-restricted-syntax`:①禁 `CallExpression[callee.property.name='$use']` 与 `[callee.property.name='$extends']`(Prisma 中间件 / client extension,零存量)②禁在 `src/modules/**/*.service.ts` 直写 `Property[key.name='deletedAt'][value.value=null]`(强制走 `notDeletedWhere`)③硬删 `.delete(` / `.deleteMany(` 走 baseline 白名单
- **要点**:⚠ 存量合法硬删须先冻结:`tx.rolePermission.delete`(role-permissions.service.ts:187)、`tx.permission.delete`(permissions.service.ts:204)、`tx.attachment.delete` ×2(attachment-storage-orchestrator.ts:1462/1787),以及 organizationClosure / recruitmentIdentitySession 的 deleteMany。`notDeletedWhere` 已 291 处在用,范式牢固。

### R-12 · AGENTS.md §1 表第 12 行(事务)

- **规则**:多写 / 先查后写 / 管理员保护操作必 `$transaction`;计数守护类不变式必须同事务
- **分类**:路径注入 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:`.claude/rules/transaction-boundary.md`,paths glob `src/modules/**/*.service.ts`;附 report-only AST 扫描脚本(同一方法体内 ≥2 次 prisma 写调用且无 `$transaction` → WARN,不 FAIL)
- **要点**:「多写 / 先查后写」是语义判定:事务常在 caller、编排跨方法,AST 计数假阳性高,只能 WARN。Codex 侧靠 AGENTS 保留该行散文 + PR 模板勾选;这是少数无法真正硬化的高危规则,建议在 §1 保留完整措辞。

### R-13 · AGENTS.md §1 表第 13 行(角色保护)

- **规则**:三层 Role 不是 RBAC;`assertCanManageUser` 统一入口;自我保护 + 最后 SUPER_ADMIN 事务内计数;禁加 SA 互斥
- **分类**:路径注入 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:`.claude/rules/role-protection.md`,paths glob `src/modules/users/**` + `src/common/guards/roles.guard.ts`;产物层已有 `src/modules/users/users.policy.spec.ts` 3×3 矩阵单测 + e2e 行为锁;增量 eslint:`Role.SUPER_ADMIN` 的比较表达式只许出现在 policy / guard 白名单文件
- **要点**:「统一入口」值得再加一条硬断言:users.service 之外禁直调 `prisma.user.update` 改 role/status —— v0.44.0 findings 记录过「经队员轴绕过 assertNotLastSuperAdmin + assertCanManageUser 两道护栏」的真实事故(biz-code.constant.ts:355 注释可佐证)。

### R-14 · AGENTS.md §1 表第 14 行(配置归属)

- **规则**:env 归 `*.config.ts` 注入,禁散落 `process.env`;业务判断只用 `APP_ENV`;production fail-fast 禁默认值兜底
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:eslint `no-restricted-syntax` 禁 `MemberExpression[object.object.name='process'][object.property.name='env']`,files override 放行 `src/config/**`、`prisma/seed.ts`、`src/modules/storage/storage-settings-bootstrap.ts`、`src/local-activity-frontend-fixture.cli.ts`;另单列 selector 禁 `process.env.NODE_ENV`(业务判断只用 APP_ENV)
- **要点**:实测越界仅 2 处且都是合法 bootstrap / CLI 入口(storage-settings-bootstrap.ts:110/117、local-activity-frontend-fixture.cli.ts:9),白名单一次冻结即可翻 error —— 本表性价比最高的规则之一。「production fail-fast 禁默认值兜底」留散文(app.config.ts 的 parse* 范式已是活样板)。

### R-15 · AGENTS.md §1 表第 15 行(DTO 边界)

- **规则**:App DTO 禁从 Admin DTO 派生(extends / Pick / Omit / …Type);出参 DTO 与 safeSelect 同步维护;Prisma 类型不出 service
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:eslint override on `src/**/dto/app/**` + `src/modules/**/app-*.dto.ts`:`no-restricted-imports` 禁 `@nestjs/swagger` 的 importNames `PickType|OmitType|PartialType|IntersectionType`,`no-restricted-syntax` 禁 `ClassDeclaration[superClass]`;Prisma 类型不出 service 用 `no-restricted-imports` 禁 `*.controller.ts` 从 `@prisma/client` 引入非 enum 类型
- **要点**:最典型的「散文搬 lint」样板:现状靠各 DTO 文件头注反复手写「严禁继承 / Pick / Omit / IntersectionType / PartialType / OmitType」——至少 10 处重复注释(activity-registrations/dto/app/*、users/dto/app/*、certificates/dto/app/*),全部可由 2 条 lint 规则替代,且零存量违规。safeSelect 同步留散文。

### R-16 · AGENTS.md §1 表第 16 行(API surface)

- **规则**:新 endpoint 只落 `admin/v1` · `app/v1` · `auth/v1` · `system/v1` · `open/v1`;禁新增 Mixed Controller;App 默认不返 L3
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:已落地:contract `CANONICAL_PREFIXES` 断言(test/contract/openapi.contract-spec.ts:1610-1623)+ EXPECTED_ROUTES 全量白名单(416 条,spec:74/1422);增量断言:按 controller 聚合 operationId,同一 controller 的路径前缀必须唯一(禁 Mixed Controller);App/Open surface schema 不得含 L3 字段(同 R-10)
- **要点**:5 前缀那半已 100% 机器化且改路由必须同步白名单(否则红),约束力已高于散文。缺的两条(Mixed Controller、L3)都能在同一个 contract 文件里补,不新增任何基础设施。

### R-17 · AGENTS.md §1 表第 17 行(测试纪律)

- **规则**:新 e2e 复用 `test/{setup,fixtures,helpers}`;错误断言同核 HTTP status 与 BizCode;改 service 编排先跑 characterization;禁删测试 / 放宽断言
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:新 CI job `guard-assertion-drift`:与 base 分支比对,`test/**` 的 `it(`/`test(` AST 计数不得下降、`*.e2e-spec.ts` 不得删除、`expect(` 行不得被删改 —— 除非 PR body 含 `[behavior-change: <评审稿路径>]`;「复用 setup/fixtures/helpers」与 characterization 先行留散文
- **要点**:「禁删测试 / 放宽断言」是本表最软却最危险的一条(AI 修不绿时的第一诱惑),做成 diff 级 CI 断言后约束力反而**高于**散文。计数用 ts AST 而非正则,直接复用 scripts/docs-counts.ts 的既有提取器范式(第五轮 review 已把 counts 改 AST)。

### R-18 · AGENTS.md §1 表第 18 行(snapshot SOP)

- **规则**:contract snapshot 仅随拍板范围内接口 PR 更新,diff 逐行可解释;EXPECTED_ROUTES 增删显式登记;禁盲 `-u`;L3 字段出现 = 拒
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:settings deny 新增 `Bash(* --updateSnapshot*)` / `Bash(pnpm test:contract * -u*)` / `Bash(npx jest * -u*)` 变体(Claude 侧硬拦盲更新)+ CI job `guard-pr-body`:diff 触碰 `test/contract/__snapshots__/**` 时 PR body 必须含「snapshot diff 说明」段;L3 拒收见 R-10
- **要点**:「EXPECTED_ROUTES 显式登记」那半已被 contract 白名单硬执法(改路由不改白名单必红)。盲 `-u` 目前对 Codex 与人手零拦截,`guard-pr-body` 是唯一 agent 无关兜底;该 job 可直接复用 ci.yml:45-66 已验证的 `gh pr view --json` 读取范式。

### R-19 · AGENTS.md §1 表第 19 行(受影响范围)

- **规则**:改哪个模块跑哪组 e2e + 横切组;动依赖枢纽(permissions / audit-logs / `common/*`)或全局横切 → 先列引用链、直接 `agent:check:full`
- **分类**:路径注入 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:`.claude/rules/hub-change.md`,paths glob `src/modules/permissions/**`、`src/modules/audit-logs/**`、`src/common/**` → 触碰即注入「先列引用链 + 直接 agent:check:full」
- **要点**:CI 恒跑全量 e2e(ci.yml:165),所以这条只决定「红在本地还是红在 CI」,不影响最终正确性 —— 因此做成按需注入的提示即可,不必升级为硬门。Codex 侧由 AGENTS 一行 + CI 兜底,风险可接受。

### R-20 · AGENTS.md §1 表第 20 行(机器守护)

- **规则**:`docs:counts:check` / `docs:readtax:check` / `docs:codemap:check` / `docs:rbacmap:check`;派生文档无守护不留
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:已落地:.github/workflows/ci.yml:128-129 `pnpm docs:readtax:check && pnpm docs:counts:check && pnpm docs:codemap:check && pnpm docs:rbacmap:check`(刻意不挂 docs-only 条件)
- **要点**:100% 已机器化,§1 该行可从铁律表删除、降级为 process §6 指针 + preflight 输出。「派生文档无守护不留」是元规则(约束未来新建文档),留 process 散文 + PR 模板 checkbox。注意 scripts/check-codemap.ts 头注仍写着「不接入 CI」,已与 ci.yml 事实不符,搬迁时顺手校正。

### R-21 · AGENTS.md §1 表第 21 行(git 安全)

- **规则**:禁 `reset --hard` / `push --force` / 批量 `-D` / `remove --force` / 动 unrelated worktree;squash 清理走 patch-equivalence 五项
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:已有 settings deny(reset --hard / push --force 全变体)+ ask(branch -D / worktree remove --force);补 `.githooks/pre-push`(拒 `--force`、拒非 fast-forward 推 main)+ `.githooks/pre-commit`,由 `scripts/agent-preflight.sh` 自动 `git config core.hooksPath .githooks`;patch-equivalence 五项脚本化为 `scripts/check-patch-equivalence.ts`
- **要点**:现状 Codex / 人手完全绕过 settings.json,git hook 是唯一 agent 无关拦截点(且对 Claude 也构成第二道)。patch-equivalence 曾出过 `main..branch` 非空假阳性(main 已前进),脚本必须以 squash 提交为基准而非分支名。settings.example.json 需同步。

### R-22 · AGENTS.md §1 表第 22 行(协作纪律)

- **规则**:授权清单内连续推进,清单外停;必须输出「本次未做」;判断给证据;审计发现不顺手修;不输出 secret;不确定不写成事实
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区(+ process §7 全文);唯一可机器化子项:settings deny `Bash(cat .env*)` 类读取 + CI secret 扫描 job
- **要点**:清单边界 / 本次未做 / 给证据 / 不顺手修都是协作行为,无产物特征。曾可考虑用 Stop hook 校验终稿含「本次未做」,但措辞变体多、假阴性高,不如留散文 + process §9 收尾模板。这是 Harness 3.0 里最该**保留原文**的一行。

### R-23 · AGENTS.md §2 决策锁 D-1

- **规则**:`contribution-rules` 归 System surface
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:已落地:contract EXPECTED_ROUTES 锁死 5 条 `/api/system/v1/contribution-rules*`(test/contract/openapi.contract-spec.ts:273-277)+ CANONICAL_PREFIXES 断言
- **要点**:挪 surface 必改白名单必红,执法已完备。§2 表可压成「锁名 + 断言指针」一行;保留一句原因说明仍有价值(新增端点时防止直觉性落到 admin/v1)。

### R-24 · AGENTS.md §2 决策锁 D-5

- **规则**:App 准入 = `memberId != null ∧ User.ACTIVE ∧ Member.ACTIVE`;capabilities ≠ raw permission code;`/me/*` 与 `/my/*` 物理分离
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:contract 增量断言:①同一 controller 不得同时出现 `/api/app/v1/me/` 与 `/api/app/v1/my/` 路径(现状 16 条 me + 51 条 my 已物理分离)②capabilities 出参字段值不得匹配权限码形状 `^[a-z][a-z-]*(\.[a-z-]+)+$`(正则直接复用 scripts/docs-counts.ts:124 的 CODE_SHAPE);准入三条件由 app e2e 行为锁承担
- **要点**:capabilities 那条是防「图省事直接吐权限码给端上」的关键闸,一旦破了就等于把 213 个权限码变成对外契约;正则已在仓内存在,复用零成本。准入三条件属运行期语义,机器化无解,靠 e2e + 散文。

### R-25 · AGENTS.md §2 决策锁 D-6

- **规则**:App DTO 禁派生自 Admin DTO;Mobile 默认 `scope = self`;L3 字段(passwordHash / *token* / secret* / 完整 signed URL)默认不返;唯一 content-* 读面例外
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:复用 R-15 的 eslint override(禁 extends / Mapped Types)+ 复用 R-10 的 contract L3 属性名黑名单(content-* 读面 signed URL 走白名单常量,与 api-surface-policy §9.6 一一对应)
- **要点**:与 R-15 / R-10 共用载体,不重复建设 —— 这也说明 §1 表第 15 行与 §2 D-6 在 Harness 3.0 里应合并为一条规则 + 一组载体。「Mobile 默认 scope=self」是 service 语义,留散文。

### R-26 · AGENTS.md §2 决策锁 D-7

- **规则**:六类职责边界(Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect)boundary-aware
- **分类**:路径注入 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:`.claude/rules/service-boundary.md`,paths glob `src/modules/**/*.service.ts` + `**/*presenter*.ts` + `**/*.policy.ts`;可硬化的一刀:eslint `no-restricted-imports` 禁 Presenter / Policy / StateMachine 文件 import `PrismaService` 或 `@prisma/client` 非类型入口(强制纯函数化)
- **要点**:职责归属本身是设计判断,不可机器化;但「Presenter / Policy 不碰 DB」是方向性可硬判的。前置条件是文件命名先收敛(现状有 `attendance-presenter.ts`、`users.policy.ts` 等已合规样本,可作为 glob 基础)。

### R-27 · AGENTS.md §2 决策锁 D-9

- **规则**:Route B 终态 = 5 canonical 前缀,老前缀已物理删除,contract 断言锁定(取代 D-2;D-3 / D-4 / D-8 为已履行的设计期流程锁)
- **分类**:已冗余可删 · **执行体覆盖**:双模型
- **执法载体**:contract spec:1610-1623 `CANONICAL_PREFIXES` 断言(现役)
- **要点**:与 §1 表第 16 行(API surface)语义完全重叠,且执法已 100% 落在活断言上;D-2/D-3/D-4/D-8 本身已被标注为「已履行的设计期流程锁」= 历史沿革。建议 §2 删该行,沿革移 archive,只在 §1 API surface 行尾附断言名。

### R-28 · AGENTS.md §2 决策锁 P0-E

- **规则**:refresh token 冻结九条(opaque+sha256 / rotation always / family revoke / 90d 绝对 / 失败统一 10007 / logout 幂等无限流 / access 15m 自然过期 / 联动撤销九场景同事务 / LoginDto·LoginResponseDto·JwtPayload zero drift)
- **分类**:路径注入 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:settings 新增 `ask` on `Edit(src/modules/auth/**)`(Claude 侧触碰即需授权)+ `.claude/rules/auth-p0e.md` 注入锁全文;产物层由 auth e2e 行为锁 + contract schema 快照(三个 DTO)承担;Codex 侧由 CI job `guard-redzone` 兜底
- **要点**:九条子约束中只有「三 DTO zero drift」与「失败统一 10007」能断言,rotation / family / 同事务只能靠 e2e。因此主执法必须是路径级「触碰即读全文 + 触碰即要授权」,而非产物级断言 —— 这条是路径注入 + 红区双载体的标准范例。

### R-29 · AGENTS.md §2 决策锁「判权单轨」

- **规则**:全仓活跃 `@Roles` = 0;业务判权走 Service 层 `rbac.can()`;`RolesGuard` 保留兜底不删;scope 不进权限码;`RbacService` 只读 GLOBAL
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:eslint 禁 `Decorator[expression.callee.name='Roles']`(同 R-09,零存量)+ 已有 `scripts/check-rbac-map.ts` 守护权限码形状(CODE_SHAPE 天然排除 scope 段)+ 新增结构测试:`rbac.service.ts` 内 `scope:` 只允许字面量 `'GLOBAL'`
- **要点**:实测 184 处 `rbac.can(` + 0 处活跃 `@Roles` = 现状已完全单轨。把 @Roles 从「散文禁用」变成 lint error 是零成本锁死;`RolesGuard` 保留不删可加一条结构测试(app.module.ts 全局 provider 列表必含 RolesGuard),防止「既然没人用就删了吧」。

### R-30 · AGENTS.md §2 决策锁「防枚举」

- **规则**:登录失败四场景统一 10004 + dummy bcrypt 抗 timing;SMS / 微信绑定沿 24010 泛化 200;refresh 失败不细分;任何 message / 错误码 / 耗时差异都算枚举漏洞
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:contract 断言 `/api/auth/v1/login`(spec:80)的 documented4xx 码集合恰为 {10004, 限流码},`/api/auth/v1/refresh` 恰为 {10007};直接复用 spec 内现成的 `documented4xxCodes` 助手与 `it.each` 范式(spec:1559-1592);dummy bcrypt 与耗时差异由 auth e2e + 散文
- **要点**:该锁最容易被「好心细化错误提示」破坏,而细化必然改 `@ApiBizErrorResponse` → 断言当场拦下,是高性价比的一条。耗时侧信道无法断言(测试机抖动),必须在 §2 保留散文措辞。

### R-31 · AGENTS.md §2 决策锁「身份 / 权限不缓存」

- **规则**:`JwtStrategy.validate` 每请求查身份;`RbacService` 每次判权直读 PostgreSQL 当前 GLOBAL 权限,零跨请求 Map / TTL / invalidate 正确性链
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:eslint override on `src/modules/permissions/**` + `src/modules/auth/strategies/**`:禁类字段 `PropertyDefinition[value.callee.name=/^(Map|WeakMap)$/]`、禁 `setInterval|setTimeout`;全仓 `no-restricted-imports` 禁 `@nestjs/cache-manager` / `cache-manager` / `ioredis`(与 R-33 共用禁引清单)
- **要点**:实测两目录零缓存痕迹,禁令目前只活在 src/modules/permissions/CLAUDE.md:23/45 的散文里 —— 正是「模块 CLAUDE.md 里的 ❌ 清单」可批量转 lint 的证据。规则可直接翻 error。

### R-32 · AGENTS.md §2 决策锁「永久铁律」

- **规则**:不引入 `LocalStrategy`;不建 `*.entity.ts`;不用 Prisma 全局软删中间件 / client extension
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:eslint `no-restricted-imports` 禁 `passport-local` + 禁 `AuthGuard('local')`;结构测试断言全仓 `**/*.entity.ts` 数 === 0(同 R-03);eslint 禁 `$use` / `$extends`(同 R-11)
- **要点**:三条全为「零存量 + 语法可判」,是整份矩阵里最干净的一行,应作为 Harness 3.0 执法迁移的首刀验证载体。搬完后 §2 该行可整行删除(语义 100% 由三条硬规则承载,零放宽)。

### R-33 · AGENTS.md §2 决策锁「基础设施冻结」

- **规则**:cron 全仓终态恰好 2 个,第 3 个起 = 新 D 档评审;Redis / queue / LLM / vector / 多租户不引入;数据清理走手动 SOP 不上 cron
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:已部分落地:`docs:counts:check` 把 Cron=2 写进 current-state 计数块并守护(第 3 个 cron 会让 :check 红);增量 `harness/forbidden-deps.json` + CI 断言 package.json 无 `ioredis|redis|bullmq|bull|@nestjs/bull|kafkajs|amqplib|openai|@anthropic-ai/*|langchain|pgvector|chromadb`;结构测试断言 `@Cron` name 恰为 {birthday-greeting, expiry-reminder}
- **要点**:依赖黑名单目前唯一载体是 `Bash(pnpm add*)` 的 ask = Claude 专属,Codex 直接改 package.json 加依赖零拦截,必须补 CI。cron 计数守护依赖有人回填 current-state,加一条独立结构断言更硬。

### R-34 · AGENTS.md §2 决策锁「敏感字段三问」

- **规则**:入 schema / DTO / 草案前必答:业务用途?查看角色与掩码?保存期限与退队清理?「先占位以后再用」视作越权;不假设合规方案
- **分类**:路径注入 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:PreToolUse hook(Edit|Write),paths glob `prisma/schema.prisma` + `src/**/dto/**` + `src/modules/**/*.dto.ts` → 注入三问全文并要求逐条作答;Codex 侧 = PR 模板必填「三问」段 + CI job `guard-pr-body`(diff 新增 schema 字段或 DTO 属性时校验该段存在)
- **要点**:教科书级路径注入场景:判断型、触发点精确、全文只在触碰时值钱。⚠ hook glob 必须同时匹配两种 DTO 布局(`src/**/dto/**` 子目录式 与 `src/modules/<m>/<m>.dto.ts` 平铺式),漏一种就等于没装。

### R-35 · AGENTS.md §2 决策锁「业务行为冻结」

- **规则**:业务行为由各冻结评审稿 + e2e 行为锁承载;改既有断言 = 改行为契约 → 停下报告
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:复用 R-17 的 CI job `guard-assertion-drift`:`test/**` 内 `expect(` 被删改 / spec 文件被删 → 要求 PR body 含 `[behavior-change: <docs/archive/reviews/*.md>]`,且引用的评审稿路径必须真实存在(防瞎填)
- **要点**:「停下报告」这个**动作**无法机器化,但「改了断言却没声明」这个**痕迹**可以 —— 把不可执法的动作换成可执法的痕迹,是本锁搬迁的关键转译,也是 Harness 3.0「语义零放宽、只换执法方式」的最佳示范。

## 第一部分 · agent 无关执法层设计(AL-1 ~ AL-10)

- **AL-1 eslint.config.mjs 扩容为主执法面(覆盖 R-03/04/05/07/08/09/11/14/15/26/29/31/32)** —— Codex 不读 .claude 但一定跑 `pnpm lint`(且 CI ci.yml:118-119 以 `--max-warnings 0` 硬判),因此凡能写成 lint 的规则一律优先写成 lint,而不是 hook。现有 eslint.config.mjs 只有 50 行、零条自定义约束,是最大的空载体。落法:新增一个 `harnessRules` 配置块(全仓 no-restricted-syntax / no-restricted-imports)+ 三个 files override 块(`src/**/dto/app/**` 与 `app-*.dto.ts` 禁派生;`src/config/**`+bootstrap+CLI 放行 process.env;`src/common/guards/roles.guard.ts` 与 decorator 定义处放行 @Roles/@UseGuards)。每条规则的 message 必须写成「规则一句话 + AGENTS 出处 + 正确做法」,让 lint 报错本身成为规则投递通道。
- **AL-2 `pnpm harness:guard` 单一守护脚本 + CI 新步骤(覆盖 R-01/03/06/13/32/33)** —— 新建 `scripts/harness-guards.ts`,聚合所有「AST/文件级、无 DB、秒级」的结构断言:①`**/*.entity.ts` 数 === 0 ②`src/modules/*` 子目录白名单 ③`@Cron` 恰 2 个且 name 集合固定 ④package.json 依赖黑名单(读 `harness/forbidden-deps.json`)⑤无 package-lock/yarn.lock/bun.lockb ⑥BizCode 只在 biz-code.constant.ts 定义 ⑦prisma schema 约定(cuid 主键 / createdAt / 禁 autoincrement)。挂进 ci.yml 现有「Docs guards」步骤同级、同样**不挂 docs-only 条件**。仓内已有 `scripts/harness-guards.selftest.ts`,自测范式现成可复用。
- **AL-3 `harness/redzone.json` + `harness/forbidden-deps.json` 作为双执行体共享的唯一机读清单** —— 红区路径(AGENTS §3 精确清单:六大红区文档 + `.github/workflows/**` + `prisma/{schema.prisma,migrations/**,seed.ts}` + `src/common/{guards,filters,interceptors}/**` + `src/modules/auth/**` + `src/modules/storage/storage-crypto.service.ts` + `docs/archive/**`)只写一份 JSON,由三处消费:Claude PreToolUse hook、CI job `guard-redzone`、CODEOWNERS 生成脚本。**这是防双执行体规则漂移的核心机制** —— 否则 hook 与 CI 的红区清单会各自演化。
- **AL-4 CI job `guard-redzone`(覆盖 R-28 及 §3 全部红区)** —— `git diff --name-only origin/main...HEAD` ∩ redzone.json;命中且 PR body 无 `[redzone-approved: <用户拍板出处>]` → 退出 1。这是 Codex / 人手触碰 auth、schema、workflows、storage-crypto 的唯一拦截点(settings.json 的 ask 对它们完全无效)。
- **AL-5 CI job `guard-assertion-drift`(覆盖 R-17/R-35)** —— 对 `test/**` 做 diff 级审计:`it(`/`test(` AST 计数不得下降、`*.e2e-spec.ts` 不得删除、`expect(` 行不得被删改,例外需 PR body `[behavior-change: <docs/archive/reviews/*.md>]` 且该路径真实存在。把「禁删测试 / 放宽断言 / 改断言即停下报告」这三条最软的规则一次性硬化。
- **AL-6 CI job `guard-pr-body`(覆盖 R-06/18/34 + §1 协作纪律的可痕迹化部分)** —— 用 ci.yml:45-66 已验证过的 `gh pr view --json body,files` 范式(注意其中记录的教训:用 JSON 原始路径,别用 `gh pr diff --name-only`,后者对非 ASCII 路径做 C 转义)。规则表:snapshot 变更 → 必须有「snapshot diff 逐行说明」段;schema/DTO 新增字段 → 必须有「敏感字段三问」段;新增 BizCode → 必须有「新码场景」段;所有 PR → 必须有「本次未做」段。配套 `.github/pull_request_template.md` 提供骨架。
- **AL-7 `.githooks/` + preflight 自动挂载(覆盖 R-21)** —— 仓内提交 `.githooks/pre-push`(拒 `--force`、拒非 fast-forward 推 main)与 `.githooks/pre-commit`(拒提交命中 redzone.json 且无 `REDZONE_OK=1` 的变更),由 `scripts/agent-preflight.sh` 执行 `git config core.hooksPath .githooks`。git hook 是唯一对 Claude / Codex / Cursor / 人手一视同仁的本地拦截层;settings.json 的 deny 只是 Claude 侧的第一道。
- **AL-8 AGENTS.md §1/§2 重写范式:每行 = 规则一句话 + 载体名 + 本地复现命令** —— Codex 只读 AGENTS,所以它必须从 AGENTS 同时学到「规则是什么」和「这条是机器判的、怎么在本地先跑一遍」。机器化行统一改写为 `| 主题 | 一句话 | 载体:eslint <ruleId> / harness:guard <checkId> / contract <断言名> |`,并在 §1 表前加一句「凡标载体的行,`pnpm lint && pnpm harness:guard && pnpm test:contract` 可本地自证」。判断型规则集中到新的「§1.5 判断原则区」(R-02/12/19/22/26 + 各锁的语义残留),明确标注「无机器守护,靠你自己」——**约束力标签化,防止模型把『没报错』误读成『合规』**。
- **AL-9 规则-载体注册表自证(Harness 3.0 刀七质检的落点)** —— 扩展已有 `scripts/harness-guards.selftest.ts`:解析 AGENTS §1/§2 表,提取每行声明的载体 id,断言该 id 在 eslint.config.mjs / harness-guards.ts / contract spec 中真实存在;反向亦然(存在的守护必须在 AGENTS 有对应行)。任何一侧删规则而不同步文档 → CI 红。这把「文档-代码冲突暂停上报」从人的义务变成机器的义务。
- **AL-10 CODEOWNERS 兜底** —— 由 redzone.json 生成 `.github/CODEOWNERS`,红区路径归维护者;配合分支保护,使任何绕过前述所有层的红区改动仍需人工点头。这是对『AI 自开自合 PR』的最后一道 agent 无关闸门(与 memory 里『主会话自开 PR 合并到 main 须用户明确点头』的既有约定同源)。

### 第一部分小结

逐条核对 AGENTS.md §1 铁律速查 22 行 + §2 决策锁 13 条,并用 eslint.config.mjs、.claude/settings.json、.github/workflows/ci.yml、test/contract/openapi.contract-spec.ts、scripts/*.ts 及 src 抽样验证现状后得出 35 行矩阵。分类结果:机器化 24 条、路径注入 7 条(R-12 事务 / R-13 角色保护 / R-19 受影响范围 / R-26 D-7 / R-28 P0-E / R-34 敏感字段三问)、留散文 2 条(R-02 跨文件改动 / R-22 协作纪律)、已冗余可删 1 条(R-27 D-9,与 §1 API surface 行重叠且断言现役)。

关键发现:(1) **eslint.config.mjs 现只有 50 行、零条自定义约束**,而至少 12 条铁律是纯语法可判且**零存量违规**(禁 @UseGuards / @Roles / 裸 ApiOkResponse / passport-local / *.entity.ts / Prisma $use·$extends / 局部 ValidationPipe / App DTO 派生 / 散落 process.env / 判权缓存),搬进 lint 是零成本、零语义放宽 —— 这是最大的空载体。(2) **两处规则与代码已冲突,搬迁前必须先解**:「`:id` 一律 IdParamDto」有 71 处 `@Param('id') id: string` 反例(19 个 controller);「禁嵌套子目录」已被 dto/ controllers/ 的现实全面解锁。(3) **一个真实执法缺口**:contract spec 只有全量快照,没有 L3 属性名黑名单断言,一次盲 `-u` 即可洗掉泄露字段。(4) **双模型执法断层集中在四处**:pnpm-only、危险 git 操作、依赖黑名单、盲 `-u` —— 目前唯一载体都是 .claude/settings.json,Codex 完全不受约束;agent_agnostic_layer 给出 10 项具体补法,主轴是「能写成 lint 的绝不写成 hook」+ 红区/禁引清单收敛成 harness/*.json 单一机读源供 hook 与 CI 共享,防双执行体规则漂移。

## 第二部分:AGENTS.md §3 + process.md §2/§3/§4/§5.4/§7(R-30 ~ R-108,编号独立)

### R-30 · AGENTS.md §3 读写分区 🟢

- **规则**:🟢 自由区(docs 权威源外 / test/** 新增 / ai-harness true-up)可直接写,无需拍板
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:.claude/hooks/redzone-guard.sh 内 ZONE_GREEN allowlist(PreToolUse matcher: Edit|Write|MultiEdit|NotebookEdit),命中即 exit 0 静默放行
- **要点**:自由区是三分区里唯一「放行」判定,写成 allowlist 可让红/黄区判定 fail-closed(不在 green 且不在 red → 黄区提示定档)。注意 test/** 只有『新增』自由:test/setup/** 与 test/contract/** 按评审结论已升红区(R-42/R-43),green glob 必须写成 test/** 减去这两支。

### R-31 · AGENTS.md §3 读写分区 🟡

- **规则**:🟡 谨慎区(src/** / 配置 / snapshot / 工具链)按 process §3 定档;C 档 goal 内免二次确认
- **分类**:路径注入 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:.claude/rules/grade-hint.md,frontmatter paths: ['src/**','test/contract/**','*.config.*','tsconfig*.json','.env*'];注入 process §3 五档表 + 档位归属五规则
- **要点**:「定档」是判断动作,无法在写入前机器判定;但可在触碰 src/** 的第一次写入时把五档表推到眼前。Codex 侧靠 AGENTS §3 散文 + CI 的 pr-grade-guard(R-74~R-78)事后兜底。

### R-32 · AGENTS.md §3 读写分区 🔴 + 红区精确清单

- **规则**:🔴 红区路径非用户授权不动
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:.claude/hooks/redzone-guard.sh(PreToolUse: Edit|Write|MultiEdit|NotebookEdit),路径命中 RED glob 表 → exit 2 + stderr 说明「红区,需用户授权;当前会话无授权令牌」
- **要点**:授权表达方式:hook 读 $(git rev-parse --git-path srvf-redzone-grant.json),该文件只能由用户跑 `pnpm harness:grant <glob> --reason` 生成(hook 自身把该路径列入 RED,模型改不了)。Codex 侧对称层 = scripts/check-redzone.ts(pnpm guard:redzone)在 CI job redzone-guard 上跑,PR diff 命中红区且 PR body 无「红区授权」结构化段 → 红。完整 glob 表见 summary(a)。

### R-33 · AGENTS.md §3 红区清单第 1 组

- **规则**:六大红区文档不改:AGENTS.md / ARCHITECTURE.md / CLAUDE.md / baseline / V2红线 / api-surface-policy
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:RED glob: AGENTS.md, ARCHITECTURE.md, CLAUDE.md, .claude/CLAUDE.md, docs/srvf-foundation-baseline.md, docs/V2红线与复活路径.md, docs/api-surface-policy.md
- **要点**:精确文件名已核实存在(AGENTS §0 行 32 + process §6 表)。注意 .claude/CLAUDE.md 是第二份 CLAUDE(项目背景),原文只说「CLAUDE.md」——glob 必须两份都收,否则模型可以改 .claude/CLAUDE.md 绕开。V2 红线文件名含中文,glob 要用 UTF-8 精确匹配不要用 ASCII 通配。

### R-34 · AGENTS.md §3 红区清单第 2 组 + 触发即停 7 + process §3 档位归属

- **规则**:.github/workflows/** 非授权不动(且必然 D 档)
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:RED glob: .github/workflows/**;+ CI job pr-grade-guard 断言「diff 含 workflows → PR body 档位 = D」
- **要点**:三处重复(AGENTS §3 清单 / §3 触发即停 7 / process §3 档位归属)。CI 侧检查存在自指陷阱:改 workflows 的 PR 跑的是改后的 workflow,必须把 redzone/grade 检查放在独立 workflow 文件并加入 branch protection required checks,否则一条删掉自己的 PR 就能静默通过。

### R-35 · AGENTS.md §3 红区清单第 3 组

- **规则**:prisma/{schema.prisma, migrations/**, seed.ts} 非授权不动
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:RED glob: prisma/schema.prisma, prisma/migrations/**, prisma/seed.ts;+ .claude/rules/prisma-d-lane.md(paths 同上)注入 srvf-prisma-change skill 与 migration token 要求
- **要点**:清单只列三项,但 prisma/ 下还有 tsconfig.eslint.json 与模块级 CLAUDE.md——不在红区属有意留白,glob 不要用 prisma/** 扩大(语义会被放宽为『更严』,同样违反零放宽原则的对称面:改档位=改流程)。migration 目录建议再加 append-only 检查(已应用 migration 文件内容/文件名不得改动),这是现清单没有的真空。

### R-36 · AGENTS.md §3 红区清单第 4 组 + 触发即停 8

- **规则**:src/common/{guards,filters,interceptors}/** 非授权不动(全局 Guard/Interceptor/Filter/Pipe 语义)
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:RED glob: src/common/guards/**, src/common/filters/**, src/common/interceptors/**;补 src/common/dto/**? 否——保持原清单
- **要点**:已核实实际文件:guards/{jwt-auth,roles,throttler-biz}.guard.ts、filters/all-exceptions.filter.ts、interceptors/response.interceptor.ts。触发即停 8 还提到 Pipe(全局 ValidationPipe),其真身在 src/bootstrap/* 不在 src/common/pipes(该目录不存在)→ glob 必须补 src/bootstrap/**,否则触发即停 8 的 Pipe 半条没有任何机器载体(现清单真空)。

### R-37 · AGENTS.md §3 红区清单第 5 组 + 触发即停 3

- **规则**:src/modules/auth/**(P0-E 冻结)非授权不动
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:RED glob: src/modules/auth/**;+ .claude/rules/auth-p0e.md(paths 同上 + src/modules/*/\*jwt\*)注入 P0-E 九场景与防枚举锁
- **要点**:触发即停 3「登录 / JWT / refresh / throttler」比路径宽:throttler 配置散在 app.module / throttler-biz.guard.ts(已被 R-36 覆盖),JwtStrategy 在 auth 模块内。建议 glob 再加 src/**/\*throttler\*,补齐语义。

### R-38 · AGENTS.md §3 红区清单第 6 组 + 触发即停 4

- **规则**:src/modules/storage/storage-crypto.service.ts 非授权不动
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:RED glob: src/modules/storage/storage-crypto.service.ts
- **要点**:触发即停 4 是「Storage / COS / 凭证」,远宽于这一个文件:已核实同目录还有 storage-settings.service.ts、providers/**、storage-object-ledger.service.ts 都碰凭证与对象生命周期。现清单是明确的『点』而非『面』——迁移时按零放宽原则照抄这一个文件进 RED,把面的部分放 .claude/rules/storage.md(paths: src/modules/storage/**)做路径注入,不擅自扩红区(扩红区=改语义,须走拍板)。

### R-39 · AGENTS.md §3 红区清单第 7 组 + §0 行 32

- **规则**:docs/archive/** 不回改(历史证据/冻结评审稿/handoff/harness-v1)
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:RED glob: docs/archive/**;+ CI job redzone-guard 断言 PR diff 中 docs/archive/** 只允许纯新增文件(A 状态),任何 M/D/R 状态即红
- **要点**:这条比其他红区更硬:归档是『只进不出』,新建归档文件是常规动作(release 收口第 5 阶段建 handoff)。所以 hook 不能一刀切拒,要按 Write(新文件)放行 / Edit(既有文件)拒绝区分——PreToolUse 里用 test -e 判断目标是否已存在即可,是可靠的机器判据。

### R-40 · AGENTS.md §3 红区清单第 8 组 + process §6 表

- **规则**:CHANGELOG.md 已发布段不改;## Unreleased 段可改
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:scripts/check-changelog-frozen.ts(pnpm guard:changelog),CI job redzone-guard 内;+ hook 侧对 CHANGELOG.md 的 Edit 做「old_string 是否落在 Unreleased 段之外」预判
- **要点**:唯一的行级(非文件级)红区,PreToolUse 只有 file_path 时判不了,必须靠脚本:以 origin/main 版 CHANGELOG 为基准,切出首个 `## Unreleased` 之后到下一个 `## v` 之间为可变区,其余任意行差异 → 红。changelog.d/ fragment 路径是自由区,不进红。

### R-41 · 评审补入(Harness 3.0 执法迁移;AGENTS §3 现清单未覆盖)

- **规则**:scripts/**(守护脚本与 preflight 自身)升入红区
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:RED glob: scripts/**;+ CI job redzone-guard 断言 scripts/ 变更必须同 PR 带 scripts/*.selftest.* 的对应变更或显式豁免声明
- **要点**:必补的理由:执法一旦从散文搬到 scripts/(check-redzone / squash-guard / exam-guard),这些脚本就成了唯一约束点,而现清单把 scripts/ 归在黄区『工具链』——模型可以合法地『重构守护脚本』把闸门改松。已存在的 agent-preflight.selftest.sh / harness-guards.selftest.ts 是好底子,应把「改守护必改自测」做成硬判。

### R-42 · 评审补入(AGENTS §3 现清单未覆盖;§3 自由区反而把 test/** 划为绿)

- **规则**:test/setup/** 升入红区(全局夹具、库派生、reset 逻辑)
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:RED glob: test/setup/**(已核实 8 文件:global-setup / load-env / reset-db / reset-test-db-cli / setup-files / test-app / test-db / worktree-db)
- **要点**:必补的理由:test/setup 是全量 e2e 的地基,改 global-setup 或 reset-db 可以让 147+ suites 集体『变绿』而无人察觉——这正是『考卷保护』要防的最高杠杆点,却落在现自由区 test/** 里。Codex 侧靠 exam-guard CI job(R-79 载体)覆盖。

### R-43 · 评审补入 + AGENTS §1「snapshot SOP」行 + 触发即停 6

- **规则**:contract snapshot 工具链升入红区:test/contract/openapi.contract-spec.ts 与 test/contract/__snapshots__/**
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:RED glob: test/contract/**;+ CI job exam-guard 对 EXPECTED_ROUTES 与 .snap 的 diff 做结构化声明校验(见 summary(d))
- **要点**:已核实:EXPECTED_ROUTES 唯一定义在 test/contract/openapi.contract-spec.ts(90KB),快照唯一在 test/contract/__snapshots__/openapi.contract-spec.ts.snap。AGENTS §1 已有「禁盲 -u」散文,但没有任何机器层拦 `jest -u`——建议同时把 settings deny 加 `Bash(*jest* -u*)` / `Bash(*test:contract* -u*)` / `Bash(*--updateSnapshot*)`,把盲更新做成先匹配先赢的 deny。

### R-44 · 评审补入(执法层自防护;现清单完全真空)

- **规则**:.claude/hooks/** 与 .claude/settings*.json 升入红区(执法层不得自我放宽)
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:RED glob: .claude/hooks/**, .claude/settings.json, .claude/settings.example.json, .claude/rules/**;+ CI job harness-selfguard 断言 settings.json ≡ settings.example.json 且 never-allow 清单模式未出现在 allow 数组
- **要点**:当前 settings.json 头部的 _comment_never_allow 是散文自律,零机器执法。已核实 settings.json 与 settings.example.json 当前逐字节相同,可直接把「两文件必须一致」做成 CI 硬判(diff 非空即红),等于给白名单加了一道『改动必成对且可见』的锁。这是全表最高优先级的补漏:所有 Claude 侧执法都建在这两个文件上。

### R-45 · 评审补入(旁路面;AGENTS §3 隐含语义)

- **规则**:红区保护必须覆盖 Bash 写侧旁路,不只是 Edit/Write 工具
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:.claude/hooks/bash-write-guard.sh(PreToolUse matcher: Bash),拦 sed -i / perl -i / tee / `> path` / `>> path` / cp / mv / git checkout -- / git restore / git apply / patch,解析目标路径后走同一 RED glob 表
- **要点**:没有这条,R-32~R-44 全部可被一条 `sed -i` 绕过。实现要点:命令解析必然不完备(变量展开、$(...)、eval),所以语义定为 fail-closed——解析不出确定目标路径且命令含写侧动词 → 拒绝并要求改用 Edit/Write。复合命令(&& ; |)逐子命令判定,与 settings.json 头注的既有语义一致。

### R-46 · AGENTS.md §3 触发即停 1

- **规则**:schema / migration / seed 触发即停(拍板才动)
- **分类**:已冗余可删 · **执行体覆盖**:双模型
- **执法载体**:—(由 R-35 红区 glob 完全覆盖:红区语义『非用户授权不动』已蕴含『拍板才动』)
- **要点**:同一节内重复:红区清单第 3 组逐字列了同样三条路径。建议 §3 触发即停删此条,改为红区清单行内加「(D 档)」标注。删的是复述不是约束——机器层由 R-35 承载,约束力不降。

### R-47 · AGENTS.md §3 触发即停 2

- **规则**:Role / 权限码 / 绑定 / Guard 语义变更触发即停
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:scripts/check-rbac-map.ts 已在跑(pnpm docs:rbacmap:check,已挂 CI);+ 新增 RED glob: prisma/seed.ts(已含)、src/modules/permissions/**、src/common/guards/**(已含);+ .claude/rules/rbac.md(paths 同上)注入 docs/ai-harness/RBAC_MAP.md 必读
- **要点**:这条是全表少数已有真机器守护的:rbacmap:check 已挂 ci.yml 行 128-129。缺口是「权限码总数变化」需拍板这一层——docs:counts:check 覆盖计数漂移,但计数改了同时改文档就能过。建议给权限码加 append-only lock 文件(类似 R-49 思路)。

### R-48 · AGENTS.md §3 触发即停 3

- **规则**:登录 / JWT / refresh / throttler 变更触发即停
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:见 R-37 的 RED glob(src/modules/auth/** + src/**/*throttler*)
- **要点**:与 R-37 同源,保留为独立行是因为它绑的是 §2 决策锁 P0-E(行为冻结)而非仅路径。路径注入应把 P0-E 九场景与「LoginDto/LoginResponseDto/JwtPayload zero drift」推到眼前;后者可再加一条 CI 断言(这三个类型的结构快照)——目前只有 contract snapshot 间接覆盖。

### R-49 · AGENTS.md §3 触发即停 5

- **规则**:audit_logs / AuditLogEvent 变更触发即停;A-1 不可改删
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:scripts/check-audit-events.ts(pnpm guard:auditevents)对比 AuditLogEvent union 成员与 docs/ai-harness/audit-events.lock,任何删除/重命名 → 红,新增需 PR body 登记;挂 CI
- **要点**:「不可改删」是标准的 append-only 语义,机器判据干净利落(集合差集)。现状只有 docs:counts:check 数个数(记忆载:99→111),数个数拦不住『删一个加一个』。这是把散文铁律真正升级为机器执法的样板条目。

### R-50 · AGENTS.md §3 触发即停 6

- **规则**:新 endpoint / DTO 字段 / BizCode 变更触发即停,snapshot diff 逐行解释进 PR
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:CI job exam-guard(见 summary(d)):检出 test/contract/__snapshots__/** 或 EXPECTED_ROUTES 变更 → 要求 PR body「## 行为变更声明」结构化段,且声明的条目数与 diff 计算出的条目数一致
- **要点**:「逐行可解释」不可机器验证语义,但「有没有写声明」「声明条目数对不对得上 diff」可以。设计要点:计数由 CI 从 diff 算出并回帖 PR 评论,不采信 AI 在 body 里的自述数字——这就把『自报完成』的口子堵成『数字对不上就红』。

### R-51 · AGENTS.md §3 触发即停 7

- **规则**:workflows / 依赖 / Dockerfile 变更触发即停
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:workflows 半条 → R-34(冗余);依赖 → settings ask 已有 Bash(pnpm add*)/Bash(pnpm remove*) + CI 断言 package.json dependencies 段 diff 非空则档位=D;Dockerfile → 补 RED glob: Dockerfile, .dockerignore, docker-compose.yml
- **要点**:拆开看三条覆盖度差别很大:workflows 已双覆盖;依赖有 settings ask(仅 Claude)+ pnpm-lock diff 可 CI 检;Dockerfile 目前零覆盖(既不在红区清单也无 CI 检查),而 docker-build job 依赖它。建议 workflows 半条删除(归 R-34),Dockerfile 补进红区 glob。

### R-52 · AGENTS.md §3 触发即停 8

- **规则**:全局 Guard · Interceptor · Filter · Pipe 变更触发即停
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:R-36 的 RED glob + 必补 src/bootstrap/**(全局 ValidationPipe / apply-swagger / 全局注册点均在此)
- **要点**:已核实 src/common/pipes 目录不存在,全局 Pipe 的注册在 bootstrap 层;不补 src/bootstrap/** 这条的 Pipe 半条就是空转。顺带:src/bootstrap/apply-swagger.ts 的 setVersion 是 E 档判据(R-78),同一路径两种档位,hook 提示文案要能区分行级意图。

### R-53 · AGENTS.md §3 触发即停 9

- **规则**:跨模块重构 / 拆 service 触发即停,characterization 先行
- **分类**:路径注入 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:.claude/rules/refactor-guard.md(paths: src/modules/**/*.service.ts)注入 srvf-god-service-refactor skill;+ CI 弱信号 job:单个 *.service.ts 行数净减 >30% 且同 PR 无 *.spec.ts 新增/修改 → 评论提醒(不硬判)
- **要点**:「跨模块」「拆 service」无法从路径先验判定(改两个模块可能只是修 bug)。characterization 是否先行更是过程属性。这条只能做到把 skill 推到眼前 + 事后弱信号提醒,不宜做成硬判(误杀率高会导致守护被绕)。Codex 侧只有 AGENTS §3 散文。

### R-54 · AGENTS.md §3 触发即停 10

- **规则**:release / tag 触发即停(E 档强串行)
- **分类**:已冗余可删 · **执行体覆盖**:双模型
- **执法载体**:—(process §3 五档表 E 档行已含「用户拍板 ✅ / 连续推进 ❌ 强串行」,且 §3 属恒读层;机器层由 R-78 setVersion→E 与 preflight bump 特征硬判承载)
- **要点**:process §3 是恒读层(AGENTS §0 明列),所以这条复述不是『恒读层补非恒读层』的必要冗余,是真重复。agent-preflight.sh 行 154-160 已对 lane 模式硬拒 bump 特征,是现成机器层。

### R-55 · AGENTS.md §3 触发即停 11

- **规则**:物理删数据 / 批量回填触发即停
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS §3 触发即停条目保留;+ settings deny 已覆盖 prisma migrate reset/db push;+ 弱机器层:CI 检出新增 scripts/**.ts 含 deleteMany/updateMany/executeRaw → 要求 PR body 影响面段
- **要点**:真正的『物理删数据』发生在运行时/一次性脚本,不在 diff 里必然可见,判断型为主。deleteMany 在业务代码里也可能是正常软删实现的一部分,硬判会误杀——保留散文 + 弱提醒是诚实的做法。注意本仓已有铁律「禁 delete()」,那条属 §1 可 eslint 化,与本条不同。

### R-56 · AGENTS.md §3 触发即停 12

- **规则**:敏感字段变更触发即停,三问(用途/查看角色与掩码/保存期限)先答
- **分类**:路径注入 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:.claude/rules/sensitive-fields.md(paths: prisma/schema.prisma, src/modules/**/*.dto.ts)注入 §2「敏感字段三问」锁全文;+ CI 弱判:schema/DTO 新增字段名匹配 /idCard|idNumber|phone|mobile|address|bank|realName|salary|health|insurance/i → 要求 PR body「三问」三行非空
- **要点**:与 §2 决策锁「敏感字段三问」是同一条,§3 只是触发点复述——但 §2/§3 同属恒读层同一文件,属真重复,可在 §3 只留指针。字段名正则是启发式,漏报必然存在(如 `remark` 里塞身份证),所以定位是『提醒 + 要求书面回答』而非『判定安全』。

### R-57 · AGENTS.md §3 触发即停 13

- **规则**:红区文档 / archive / 已发布 CHANGELOG 触发即停
- **分类**:已冗余可删 · **执行体覆盖**:双模型
- **执法载体**:—(与同节红区精确清单第 1/7/8 组 100% 重合,由 R-33/R-39/R-40 承载)
- **要点**:同一节内前后两段说同一件事,是恒读层字符预算(18,000)的纯浪费。删此条可为 §3 腾出空间容纳 R-41~R-45 四组补入路径,恒读层体积不增而覆盖面变大——这正是 readtax 预算下『语义零放宽、投递方式更优』的落点。

### R-58 · AGENTS.md §3 触发即停 14 + §1 git 安全行 + process §5.4 条 7

- **规则**:危险 git 操作触发即停(会话内二次授权)
- **分类**:已冗余可删 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:—(AGENTS §1 表 git 安全行已述;机器层由 settings deny/ask 与 R-91 squash guard 承载)
- **要点**:同一文件内 §1 与 §3 两处说同一条。已核实 settings.json deny 含 git reset --hard / push --force(4 变体 + git -C 变体)/ rm -rf,ask 含 git branch -D / worktree remove --force。缺口:`--force-with-lease` 在 process §5.4 条 7 禁止清单里但 settings 未列——deny 需补 `Bash(git push --force-with-lease*)` 与 `Bash(git push * --force-with-lease*)`,否则散文比机器层严,迁移就成了放宽。

### R-59 · AGENTS.md §3 触发即停 段首

- **规则**:触发即停项一律按 process §4.1 人话简报格式拍板;goal 已含范围的 C 档免二次确认
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS §3 段首句保留 + .claude/rules 各红区规则文件内嵌 §4.1 九行模板
- **要点**:「是否已在 goal 范围内」需要读 goal 文本做语义比对,机器判不了。可做的机器化只有『简报格式完整性』(九行齐不齐),但简报发生在对话里不在文件里,没有拦截点。这条是典型的判断型规则,应留在 AGENTS 判断原则区。

### R-60 · AGENTS.md §3 prisma 禁令(migrate dev|reset|db push)

- **规则**:prisma migrate dev / reset / db push 任何环境禁自动跑
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:settings deny(reset/db push 六模式已在)+ settings ask(migrate dev 三模式已在);补 deny: Bash(prisma migrate reset* --force*) 与 `pnpm prisma:migrate`(package.json 里 prisma:migrate = prisma migrate dev,现有模式串匹配不到)
- **要点**:已核实的真实缺口:package.json 定义了 `prisma:migrate: prisma migrate dev`,而 settings 的 ask 列表只匹配 `prisma migrate dev*` / `pnpm prisma migrate dev*` / `npx prisma migrate dev*`——`pnpm prisma:migrate` 这个别名不命中任何规则,直接走 allow 之外的默认路径。必须补 Bash(pnpm prisma:migrate*)。Codex 侧无 settings,需 .githooks/pre-commit + AGENTS 散文兜底。

### R-61 · AGENTS.md §3 prisma 禁令(reset 恒需实时同意)

- **规则**:prisma migrate reset 恒需用户实时同意,goal 预授权不算
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:settings deny(已在,deny 优先级最高、bypass 模式下仍拒);语义上 deny ≠ ask 正是『goal 预授权不算』的机器表达
- **要点**:这是全仓设计得最好的一条:deny 而非 ask,恰好编码了『任何预授权都不算,必须人当场手动执行』。迁移时不要为了『方便』把它降级为 ask——那就是语义放宽。记忆里已有教训(R13 G1 PR#485)。

### R-62 · AGENTS.md §3 prisma 禁令(生产只 deploy)

- **规则**:生产只跑 prisma migrate deploy 且必须是已审查 migration
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS §3 保留 + docs/ops runbook;机器层只能覆盖『本地不误跑』(R-60/R-61),生产执行不在 agent 触达面内
- **要点**:生产部署由维护者/CI 在仓库外执行,agent 没有执行面,写成 hook 也拦不到真实风险。ci.yml 行 146-148 已有 `Verify production migration command` 步骤跑 prisma:deploy 验证脚本可执行,是相关但不同的保障。诚实分类:留散文。

### R-63 · docs/process.md §2 开工 checklist(三条命令 + 五判断)

- **规则**:任何新任务开始前必须过 pnpm agent:preflight 硬门禁(工作树 clean / 无 open PR / 未落后 origin/main)
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:双件套:.claude/hooks/preflight-gate.sh(SessionStart)跑 scripts/agent-preflight.sh 并写通行标记;.claude/hooks/preflight-token-check.sh(PreToolUse: Edit|Write|MultiEdit|NotebookEdit|Bash)校验标记,缺失/失效 → exit 2
- **要点**:现状是『脚本存在但靠自觉调用』,这是恒读层里最容易被跳过的一条。标记设计见 summary(c):存 $(git rev-parse --git-path srvf-preflight.json)(每 worktree 独立、天然不入库),内容含 mode/lane/HEAD sha/origin-main sha/时间戳/worktree 路径。Codex 侧对称层 = .githooks/pre-commit 调同一脚本(core.hooksPath 提交进仓)。

### R-64 · docs/process.md §2 命令 2

- **规则**:README 启动入口仍指向 current-state
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:折进 scripts/agent-preflight.sh 硬门禁(现为人工 grep):grep -q 'current-state' README.md 失败即 exit 1
- **要点**:已核实 preflight 脚本当前不做这项检查(§2 把它写成让人手敲的第二条命令)。判据是纯字符串存在性,零歧义,应直接升为硬判——这是『散文 → 机器』零成本的一条。

### R-65 · docs/process.md §2 命令 3 + 判断 4

- **规则**:CHANGELOG ## Unreleased 段仍有未释放变更而 main HEAD 已超过该 release → 进 release 收口
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:折进 agent-preflight.sh:解析 Unreleased 段非空 + git describe --tags 与 package.json version 比对 → 打印结论(咨询级,不硬判)
- **要点**:判据可机器化但结论是『该进 release 收口』的流程建议,不是『禁止动手』,所以保持咨询级打印而非 exit 1(与脚本现有『其余咨询项只读打印』的设计一致)。加上 changelog.d/ fragment 存在性一并打印。

### R-66 · docs/process.md §2 判断 3

- **规则**:版本三方(package.json / Swagger setVersion / git tag)不一致 → 不开新功能
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:折进 agent-preflight.sh:三处取值比对,不一致时打印 ✗ 并给出结论(咨询级);+ CI job version-consistency 在 tag push 时硬判
- **要点**:preflight 现在只是分别打印三个值(行 133-140),要人肉比对——已有记忆教训『统计数必亲核』。改成脚本比对是纯增益。硬判位置放 CI 的 tag 触发更合适(bump PR 过程中三方短暂不一致是正常态)。

### R-67 · docs/process.md §2 判断 5

- **规则**:没有 docs/current-state.md → 先建立再开始任何任务
- **分类**:已冗余可删 · **执行体覆盖**:双模型
- **执法载体**:—(docs:readtax:check 已把 docs/current-state.md 作为必读文件读取,文件不存在时 readFileSync 直接抛错;CI 已挂)
- **要点**:scripts/docs-readtax.ts 的 BUDGETS 硬编码三文件并 readFileSync,缺文件必红。这条散文的机器层已经存在且已挂 CI(ci.yml 行 128-129),§2 保留一句指针即可。

### R-68 · docs/process.md §2 末段

- **规则**:fresh worktree 先 pnpm install --frozen-lockfile && pnpm prisma:generate,否则 typecheck 报 Prisma 假错
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:折进 SessionStart hook(R-63 同一脚本):检测 node_modules/.prisma/client 缺失,或 prisma/schema.prisma mtime > 生成物 mtime → 在通行标记里标 stale 并在 additionalContext 里给出两条命令
- **要点**:这是有真实血案的一条(记忆:reused-worktree-stale-prisma-client,几百个 unsafe-* 假错)。mtime 比对是可靠机器判据。Codex 侧同层可放 .githooks/post-checkout。注意别做成自动执行 install(会话启动时静默装依赖违背『只读门禁』设计)。

### R-69 · docs/process.md §2 lane 形态 + §8.4

- **规则**:lane 会话用 --lane <名>(clean/未落后仍硬判,open PR 降清单);E 档收口必须 global 模式
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:scripts/agent-preflight.sh 已完整实现(lane 名合法性校验 行 39-75、open-PR 分支 行 161-174、bump 特征硬拒 行 154-160)
- **要点**:全仓执法质量最高的一段,R5-08 已把『任意非空值都进 lane 模式』这个机械绕过面堵死。迁移时唯一要加的是让它被『必然调用』(R-63 双件套),脚本本身不用动。Codex lane 需靠 .githooks/pre-commit 复用同一脚本。

### R-70 · docs/process.md §3 表头

- **规则**:每个 PR 打开前先判定档位,不混档
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:CI job pr-grade-guard:PR body「## 档位」段必须为单个 A/B/C/D/E 字母;+ 从 diff 推导最低档位,声明档位 < 推导档位 → 红
- **要点**:「不混档」的机器表达 = 声明值必须单一 + 推导档位必须 ≤ 声明档位。推导规则就是 R-74~R-78 五条,全部是纯路径判据,可 100% 机器化。PR template 已有「## 档位」节(已核实 .github/pull_request_template.md 行 3-4),只差校验。

### R-71 · docs/process.md §3 表「必跑检查」列

- **规则**:A 档可省 / B 档 quick+受影响 e2e / C 档 full+snapshot 逐行 / D 档 full+评审稿 / E 档 full+handoff 锚点
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:CI 已实质承担(ci.yml test job 全跑 lint/typecheck/docs guards/build/unit/contract/e2e + docs-only 快速路径);+ pr-grade-guard 断言 PR body「## 验证」段非空且与档位匹配
- **要点**:CI 的全量跑已经让『必跑检查』事实上不可跳过(除 docs-only 路径,而该路径判据是白名单取反、fail-open 到全量,设计正确)。散文里剩下的独立价值是『本地先跑』的时机要求,那属于效率不属于约束——可大幅瘦身为指针。

### R-72 · docs/process.md §3 组合命令定义段

- **规则**:agent:check:quick = lint+typecheck+unit;api = quick+contract;full = api+build+e2e 全量
- **分类**:已冗余可删 · **执行体覆盖**:双模型
- **执法载体**:—(package.json#scripts 已是唯一权威定义,已核实逐字一致)
- **要点**:散文重述可执行配置 = 必然漂移源。process §3 保留一句『定义见 package.json#scripts』即可。若担心 package.json 被悄悄改松,加一条 CI 断言(full 必须包含 test:e2e 与 test:contract)比抄一遍散文有效得多。

### R-73 · docs/process.md §3 组合命令段末句

- **规则**:无 Docker 时跑 quick 并显式声明「contract / e2e 留给 CI」,不得谎报全绿
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区(诚实性条款);+ 弱机器层:PR template「## 验证」节保留提示语(已在,行 17)
- **要点**:『不得谎报』是诚实性要求,无拦截点。但真正的兜底已经存在且很硬:CI 无论 PR body 怎么写都会跑全量,谎报只会在 CI 红时暴露。所以这条的实际约束力来自 CI 而非散文,散文只需保留『别谎报』的价值声明,不必再写操作细节。

### R-74 · docs/process.md §3 档位归属规则 1

- **规则**:一个 PR 同时改 .md + .ts → 按更高档位算
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:scripts/check-pr-grade.ts:若 diff 含非 .md 文件,则声明档位不得为 A
- **要点**:与 ci.yml 现有 docs-only 判定同源(白名单取反:任一非 .md → 全量,行 45-66),可直接复用其 gh pr view --json files 取路径的做法(注释里已记录 `gh pr diff --name-only` 对非 ASCII 路径做 C 转义会误判的坑——新脚本必须照抄这个教训)。

### R-75 · docs/process.md §3 档位归属规则 2

- **规则**:改 prisma/schema.prisma 或 migrations/** 或 seed.ts → 必然 D 档
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:scripts/check-pr-grade.ts 推导表第 1 条
- **要点**:纯路径判据,零歧义。与 R-35(红区)是同一组路径的两种约束(写权限 vs 档位),两者都要,不互相替代。

### R-76 · docs/process.md §3 档位归属规则 3

- **规则**:改 .github/workflows/** → 必然 D 档
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:scripts/check-pr-grade.ts 推导表第 2 条
- **要点**:见 R-34 的自指陷阱说明:该检查必须放在独立 workflow 且列入 branch protection required checks。

### R-77 · docs/process.md §3 档位归属规则 4

- **规则**:改 package.json 依赖项 → 必然 D 档
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:scripts/check-pr-grade.ts:解析 package.json 的 diff hunk,仅 dependencies/devDependencies/packageManager/engines 段变动才触发(改 scripts 段不算)
- **要点**:要按段落而非整文件判,否则加一条 npm script 就被误判成 D 档,守护会因误杀被绕过。pnpm-lock.yaml 同步变动可作为佐证信号。

### R-78 · docs/process.md §3 档位归属规则 5

- **规则**:改 src/bootstrap/apply-swagger.ts 的 setVersion(...) → E 档
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:scripts/check-pr-grade.ts:diff 中匹配 `setVersion(` 行变动 → 档位必须 E;+ agent-preflight.sh 行 154-160 已对 lane 模式硬拒 bump 特征
- **要点**:行级判据但在 diff 上很好判(hunk 内含 setVersion)。这条与 R-52(该文件全局注册点属触发即停 8)共用路径,pr-grade-guard 要能区分:只有 setVersion 行变动才是 E,其他行变动是 D。

### R-79 · docs/process.md §3 C 档行 + AGENTS §1 snapshot SOP 行

- **规则**:C 档 snapshot diff 必须逐行可解释;EXPECTED_ROUTES 增删显式登记;禁盲 -u;L3 字段出现 = 拒
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:CI job exam-guard(见 summary(d));+ settings deny 补 `Bash(*--updateSnapshot*)` / `Bash(*jest*-u*)`;+ L3 字段扫描:.snap 新增行匹配 /passwordHash|[Tt]oken|secret|signedUrl/ → 直接红,无豁免
- **要点**:L3 字段出现 = 拒 这半条是全表最适合机器化的:正则扫 snapshot 新增行,零判断、零误杀成本(真需要例外走 D 档改白名单)。已核实唯一快照文件 test/contract/__snapshots__/openapi.contract-spec.ts.snap,EXPECTED_ROUTES 唯一定义在 test/contract/openapi.contract-spec.ts。

### R-80 · docs/process.md §3 表「连续推进」列(D 档 ❌ 必须分 PR / E 档 ❌ 强串行)

- **规则**:D 档必须分 PR;E 档强串行
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:CI job pr-grade-guard:档位=D 时断言 diff 中 D 档触发路径只属于单一类别(如同时改 prisma/ 与 auth/ → 红,要求拆 PR);档位=E 时由 agent-preflight global 模式 open-PR 硬判承载串行
- **要点**:『必须分 PR』的机器判据可做成『一个 PR 内不得同时命中两类 D 档特征』,这是保守但可执行的近似。E 档串行已有现成硬层(preflight global 模式 open PR ≠ 0 即 exit 1,脚本行 161-167)。

### R-81 · docs/process.md §4 降速七特征

- **规则**:七类特征(schema/权限 · 登录存储凭证 · audit · 删数据回填 · release/重构 · 全局 Guard 链 · BizCode 段位语义)任一命中必须降速
- **分类**:已冗余可删 · **执行体覆盖**:双模型
- **执法载体**:—(与 AGENTS §3 触发即停 14 条逐条对应;AGENTS §3 属恒读层,process §4 不属,应保留恒读层那份、§4 改指针)
- **要点**:逐条比对结论:§4 七特征全部被 §3 的 1/2/3/4/5/8/9/10/11 覆盖,唯一 §4 独有的是末条『修改 BizCode 段位语义(新增 BizCode 不算降速)』这个反向澄清——那半句有独立价值,应上提到 AGENTS §3 触发即停 6 的括注里,然后 §4 整块删。

### R-82 · docs/process.md §4 降速六步流程

- **规则**:①只读调研 ②风险表 ③方案 A/B 对比 ④用户拍板 ⑤评审稿冻结+立项 ⑥再实施(与拍板一致不夹带)
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区 + .claude/rules 各 D 档路径规则文件内嵌六步清单;+ 弱机器层:R-63 通行标记可扩展记录 `d-grade-research-only` 阶段,PreToolUse 在该阶段拒绝写 src/**
- **要点**:六步是过程编排,主体判断型。可机器化的只有第①步『只读调研不动代码』——用会话级阶段标记 + PreToolUse 拒写,是真能做且价值高的一小块(D 档最常见的失守就是调研中途顺手改了)。其余五步留散文。

### R-83 · docs/process.md §4 末段铁律

- **规则**:D 档禁止顺手做,超出本 PR 范围的小问题必须另开 PR
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:CI job writeset-guard:PR body「## 写集声明」段解析为 glob 列表,`gh pr diff --name-only` 全部路径必须落在写集内,越集即红
- **要点**:这是『顺手做』的精确机器判据,而且载体已经就位——PR template 行 6-7 已有「## 写集声明」节且明确写了『集成时 gh pr diff --name-only 按此核对』,现在靠总控人肉核对。做成 CI job 是本表性价比最高的一条。process §8.1 的总控集成动作也可同时受益。

### R-84 · docs/process.md §4.1 人话简报格式(九行)

- **规则**:C/D 档确认与 goal 中途新发现上报一律用九行人话简报格式
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区 + .claude/rules 内嵌模板(可复制粘贴的 markdown 块)
- **要点**:简报发生在对话流里,没有任何文件/命令拦截点,纯散文。降低遗忘率的唯一手段是把模板放在触碰红区时会被注入的规则文件里,让它在需要的时刻出现在上下文中,而不是靠恒读层记住。

### R-85 · docs/process.md §5.4 条 1(合并前确认五项)

- **规则**:合并前五项全过才许 merge:main+clean / 只剩目标 PR / OPEN+非草稿+MERGEABLE+CLEAN / checks 全绿 / diff 落写集;记录 headRefName
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:scripts/squash-merge-guard.sh 阶段 PRE(见 summary(b));入口 `pnpm merge:squash <PR> --writeset <file>`;settings 把 Bash(gh pr merge * --squash*) 从 allow 移出,只 allow 守护脚本入口
- **要点**:五项全部是可机器判定的(git status / gh pr list / gh pr view --json / gh pr checks / gh pr diff --name-only)。把 gh pr merge 从 allow 移出不是收紧语义——散文本就要求五项全过才许 merge,现状 allow 直放才是放宽。Codex 侧靠 .githooks/pre-push + CI required checks 兜底(无法拦 gh 调用,是已知缺口)。

### R-86 · docs/process.md §5.4 条 2(执行 + auto 形态 + exit≠0 判读)

- **规则**:必须 --squash --delete-branch;禁 --merge/--rebase/--admin 绕过;exit 非 0 先 gh pr view 判 MERGED 再决定,不得重跑 merge
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:squash-merge-guard.sh 独占执行 gh pr merge 并内建 exit 码判读逻辑;settings ask 已含 --merge/--rebase/--admin 六模式
- **要点**:『exit 非 0 ≠ 失败』这条有真实血案(记忆:worktree 报本地错但远端已成,查 mergedAt),写进脚本后就永不会再误判、也不会重跑造成二次合并。--admin 现在是 ask 而非 deny,与散文『沿第 7 条禁止清单语义,非当次明确授权不得使用』语义一致,不动。

### R-87 · docs/process.md §5.4 条 3(main 同步)

- **规则**:git pull --ff-only origin main;失败即停下报告;禁 pull --rebase / 默认 merge / reset --hard
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:squash-merge-guard.sh 阶段 POST 步骤 2;settings allow 已只放 Bash(git pull --ff-only*)、deny 已含 reset --hard;补 ask: Bash(git pull --rebase*) 与裸 Bash(git pull)
- **要点**:已核实缺口:allow 列表里 `Bash(git pull --ff-only)` 与 `Bash(git pull --ff-only *)` 在,但裸 `git pull`(默认 merge)与 `git pull --rebase` 不在任何列表 → 落默认路径。散文明确禁这两者,settings 应补 ask 或 deny,否则机器层比散文松。

### R-88 · docs/process.md §5.4 条 4(远端分支核验)

- **规则**:git ls-remote --heads origin <branch> 看 stdout 不看 exit code;stdout 非空才 push --delete;删后复跑确认为空;只许删本任务目标分支
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:squash-merge-guard.sh 阶段 POST 步骤 3,内建 [ -n "$OUT" ] 判定与删后复核
- **要点**:『看 stdout 不看 exit code』是命令语义陷阱(无匹配也 exit 0),写进脚本一次就永久正确——这类『AI 每次都要重新想对』的规则是执法迁移收益最大的类型。『只许删本任务目标分支』由脚本参数化的 headRefName(条 1 记录的那个)保证,不接受通配。

### R-89 · docs/process.md §5.4 条 5(worktree 清理)

- **规则**:顺序:确认 clean → remove → 删分支;status 非空立即停;禁 remove --force;唯一特例仅 `?? .DS_Store`;非本任务 worktree 一律不动
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:squash-merge-guard.sh 阶段 POST 步骤 4;settings ask 已含 worktree remove --force 两模式
- **要点**:.DS_Store 特例的判据非常精确(输出恰为 `?? .DS_Store` 一行),脚本可严格实现且不给任何扩展空间——散文写『不得借此处理任何其它 untracked』在脚本里就是『不等于这一行就停』。本仓 .claude/.DS_Store 确实存在,这个特例是有现实基础的。

### R-90 · docs/process.md §5.4 条 6(patch-equivalence 五项)

- **规则**:squash 后 branch -d 报 not fully merged 属预期;禁直接 -D;须过 patch-equivalence 五项(缺一即停)才许对本任务目标分支 -D
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:squash-merge-guard.sh 阶段 POST 步骤 5:五项逐项执行并打印证据;全过才调 git branch -d/-D 单分支;settings ask 已含 git branch -D 三模式
- **要点**:五项里第 ② 项(diff --stat main..<branch> 本分支 0 新增)有已知假阳性(记忆:main 已前进时 main..branch 非空),脚本实现必须按那条教训改用 squash 提交为基准核验,否则守护会在正常场景误报导致被绕过。这是把散文搬进脚本时必须一并修的一个已知 bug。

### R-91 · docs/process.md §5.4 条 7(禁止清单)

- **规则**:八类危险操作除非会话内看到具体风险描述后再次明确授权,否则禁止(含跳过本节任一步骤)
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:settings deny/ask(已覆盖 6/8);补 deny: git push --force-with-lease 两模式;『跳过本节任一步骤』由 squash-merge-guard.sh 的阶段令牌保证(未过 PRE 不给 POST)
- **要点**:逐项核对 settings 覆盖:reset --hard ✅deny / push --force ✅deny / --force-with-lease ❌缺 / worktree remove --force ✅ask / 批量或通配 branch -D ⚠️ask 但未区分单个与通配(散文只禁批量,ask 一刀切偏严,可接受)/ 清理非本任务对象 ❌无载体(靠脚本参数化)/ 跳过步骤 ❌无载体(靠阶段令牌)。

### R-92 · docs/process.md §5.4 条 8(收尾记录)

- **规则**:合并与清理结果及任何第 7 条授权记入 §9 收尾报告
- **分类**:机器化 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:squash-merge-guard.sh 结束时输出可直接粘贴的 markdown 收尾块(merge state / main HEAD / ls-remote 复核 / worktree 与 branch 处置 / patch-equivalence 五项原始输出)
- **要点**:让脚本产出报告文本,比要求 AI 事后回忆命令输出可靠得多——AI 复述命令输出是幻觉高发区。这条同时解决了『判断给证据』(R-99)在合并场景下的落地。

### R-93 · docs/process.md §7 条 1

- **规则**:不把历史 handoff 当作当前事实;当前事实以 current-state + 代码 + GitHub 当前状态为准
- **分类**:路径注入 · **执行体覆盖**:仅Claude+需补agent无关层
- **执法载体**:.claude/rules/archive-readonly.md(paths: docs/archive/handoff/**, docs/archive/**)注入『这是快照不是事实,当前事实见 current-state』
- **要点**:这条的失守场景是『读了归档文件后当成现状』,拦截点恰好在读取时——路径注入是天然匹配的载体。Codex 侧无对应机制,只能靠 AGENTS §0 背景层『archive 是历史证据不当当前事实』那句散文。

### R-94 · docs/process.md §7 条 2

- **规则**:open PR ≠ 0 时不开新任务(global 语义;lane 按 §8 写集研判;release 收口除外)
- **分类**:已冗余可删 · **执行体覆盖**:双模型
- **执法载体**:—(process §2 判断 1 已述且属恒读层;机器层 = agent-preflight.sh 行 161-167 硬判,已实现)
- **要点**:§2(恒读)与 §7(非恒读)重复,且机器层已 fail-closed(global 模式 gh 不可用也拒,脚本行 168-174)。§7 删此条即可。

### R-95 · docs/process.md §7 条 3

- **规则**:已立项/已授权任务清单内可连续推进下一 PR;清单外任何新工作停下等拍板
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区(与 §7.1 goal 授权清单合并表述)
- **要点**:『在不在清单内』是语义比对,机器判不了。唯一可机器化的近似是写集声明越集检查(R-83),它覆盖『改了清单外的文件』但覆盖不了『在授权文件里做了清单外的事』。保留散文,并明确它与 R-83 的分工。

### R-96 · docs/process.md §7 条 4 + §9

- **规则**:每次收尾必须输出「本次未做」段,防 AI 自报完成
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:CI job pr-body-guard:PR body「## 本次未做」节必须存在且正文非空、非仅占位符(排除 `-` 空条目与「无」「不适用」以外的空白)
- **要点**:PR template 行 12-14 已有该节但允许空;做成硬判即可。会话内收尾报告那一半仍是散文(无拦截点),但 PR 这一半是所有交付的必经关口,机器化后覆盖了大部分真实风险。允许写「不适用」是必要的逃生口,否则会被塞垃圾内容。

### R-97 · docs/process.md §7 条 5

- **规则**:遇到 D/E 档必须降速,禁止顺手做
- **分类**:已冗余可删 · **执行体覆盖**:双模型
- **执法载体**:—(§4 全节 + §4 末段铁律已述,同文件重复;机器层 = R-83 写集越集检查 + R-70 档位推导)
- **要点**:§7 是『规则总览』性质的复述,与 §4 同在 process.md 内,删之不损失任何约束。

### R-98 · docs/process.md §7 条 6

- **规则**:不擅自修复审计/调研发现的问题,即使发现明显 bug 也先汇报
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区(与 R-95 合并为『授权边界』一条);+ 弱机器层:R-82 的 research-only 阶段标记
- **要点**:这是全仓最反模型默认行为的一条(模型天然倾向顺手修),恰恰最需要留在恒读层显眼处而非移走。可加的机器辅助只有 D 档只读阶段的写入拒绝。分类为留散文但标注『高价值、不可删、建议在 AGENTS 判断原则区置顶』。

### R-99 · docs/process.md §7 条 7

- **规则**:所有判断必须给证据(文件路径/行号/命令输出/commit/PR 链接),不凭印象
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区;+ 局部机器化:R-92 让守护脚本自产证据块,R-50/R-79 让 CI 自算数字不采信 AI 自述
- **要点**:『给证据』本身不可判定,但可以用『让机器产出证据』来降低需求——凡是能让脚本打印的证据就不要求 AI 复述。这是执法迁移里的一个通用手法:不执法判断,而是消灭需要判断的场合。

### R-100 · docs/process.md §7 条 8

- **规则**:不擅自调和文档冲突(按 §6 优先级暂停汇报);不主动展开未授权的次要任务
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS §0『发现文档-代码冲突/权威源互冲 → 暂停上报,不擅自调和』已是恒读层唯一副本;process §7 改指针
- **要点**:AGENTS §0 行 30 已有逐字表述且属恒读层,process §7 这条是第二副本——按 process §6『全仓唯一副本在 AGENTS §0』的自身规定就该删。属于规则体系自我不一致的一处。

### R-101 · docs/process.md §7 条 9

- **规则**:不输出任何 secret(.env / bucket / APPID / SecretId / SecretKey / signed URL / JWT 内容),调研报告中亦然
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区;+ 部分机器兜底:settings deny 补 Bash(cat .env*) / Bash(env) / Bash(printenv*) / Bash(*SecretKey*);+ CI secret-scan 覆盖『写进 diff』那一半
- **要点**:诚实分类:核心风险是『在对话/报告里打印』,无拦截点,只能留散文。settings deny 与 CI 扫描各覆盖一个侧面(读取入口 / 提交出口),都不覆盖主风险面。不要因为加了两道边缘检查就把它标成机器化——那会让人误以为已受保护。

### R-102 · docs/process.md §7.1 条 1

- **规则**:goal 文本 = 立项 + 拍板凭据,goal 清单内连续推进无须逐 PR 回头确认
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS §4 lane 协议行(恒读层已有『goal = 立项 + 授权』)+ srvf-goal-author skill
- **要点**:授权语义本身是人类意图的表达,不可机器化。机器能做的是把 goal 文本落成文件(如 .goal/<name>.md)供写集检查(R-83)取用——这样 goal 从『对话里的一段话』变成『可被脚本读的授权清单』,是 Harness 3.0 值得考虑的一步。

### R-103 · docs/process.md §7.1 条 2

- **规则**:goal 五要素(DoD / 探针队列 / 授权清单 / 禁止域 / 写集声明)不齐 → 不享连续推进
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:scripts/check-goal.ts(pnpm guard:goal):解析 .goal/<name>.md 五个必需小节,缺一即拒并打印缺哪节;由 srvf-goal-author skill 在起草末尾自动调用
- **要点**:五要素是结构化清单,存在性检查零歧义。前提是 goal 落成文件而非只在对话里(见 R-102)。落文件还有额外收益:写集声明可被 R-83 的 CI job 直接读取,goal↔PR 的写集一致性成为闭环。

### R-104 · docs/process.md §7.1 条 3

- **规则**:C 档及以上 feature 默认以 goal 形态立项(A/B 档可免)
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS §5 流程指针行(恒读层已有同句)
- **要点**:『默认』意味着可例外,是软约束;且立项发生在动手之前、仓库里还没有任何 diff 可检。保留散文。AGENTS §5 已有逐字重复,process §7.1 可改指针。

### R-105 · docs/process.md §7.1 条 4

- **规则**:goal 内已写明范围的 C 档免二次确认;goal 外新发现的 C/D 档一律按 §4.1 上报,不顺手修
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区(与 R-95/R-98 合并为『授权边界三句』)+ 写集越集 CI(R-83)承担可判定的那一半
- **要点**:与 R-95/R-98 高度同源,三条讲的是同一件事的三个切面(清单内推进 / 不顺手修 / goal 内外分界)。建议合并为一条判断原则,恒读层字符预算受益。

### R-106 · docs/process.md §7.1 条 5

- **规则**:同一失败修复 ≤2 轮;需越权才能绿 → 人话简报后转下一项;连续 2 轮零推进 → 熔断停机报告
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区;无可靠机器计数点(『同一失败』『零推进』需语义判定)
- **要点**:这是防止 AI 死循环烧钱的关键条款,但『同一失败』的同一性判定是语义问题。可考虑的弱机器层:同一命令连续失败 N 次由 hook 计数并注入提醒——但命令相同不等于失败相同,容易误触。诚实归类为留散文。

### R-107 · docs/process.md §7.1 条 6

- **规则**:CI 等待期做只读预研不闲等;gh 早退/401 先 gh auth status 自检再降级轮询(≥60s);不得借等待跳过 §5.4 任一步
- **分类**:留散文 · **执行体覆盖**:双模型
- **执法载体**:AGENTS 判断原则区仅保留末半句(『不得借等待跳过 §5.4』);前半句(不闲等 / 轮询间隔 / auth 自检)建议删——属模型默认已覆盖的操作技巧
- **要点**:典型的『规则里混入操作技巧』:轮询策略与 auth 自检是当代模型的默认行为,写在流程文档里只消耗恒读预算。有独立约束力的只有末半句(它是 §5.4 的反绕过条款),应上提到 §5.4 条 7『跳过本节任一步骤』的括注里。

### R-108 · docs/process.md §7.1 条 7 + §9

- **规则**:每轮输出轮末报告(含「本次未做」),终态达成后输出终版报告,格式沿 §9
- **分类**:机器化 · **执行体覆盖**:双模型
- **执法载体**:CI job pr-body-guard(R-96)覆盖 PR 形态的报告;会话内轮末报告保留散文;§9 六节模板与 .github/pull_request_template.md 五节需对齐(现不一致)
- **要点**:已核实不一致:process §9 要求六节(修改文件清单 / 做了什么 / 未做什么 / 验证命令 / open PR 与 Release 状态 / 建议下一步),PR template 只有五节(档位 / 写集声明 / 做了什么 / 本次未做 / 验证)。两套模板并存会让『按格式输出』失去判据。Harness 3.0 应二选一或明确『§9 用于会话报告、template 用于 PR』的分工。

## 第二部分 · agent 无关执法层设计(L1 ~ L6)

- 【L1 CI 是双模型唯一真闸门】新建 .github/workflows/harness-guard.yml(改它自身=D 档+红区),含 5 个 job,全部加入 branch protection required checks(现有 required = 'Lint / Typecheck / E2E' + 'Docker image build',需扩)。job 清单:redzone-guard(scripts/check-redzone.ts:PR diff 命中红区 glob 且 PR body 无「## 红区授权」结构化段 → 红;docs/archive/** 特判只许新增)、exam-guard(scripts/check-exam.ts,见 summary(d))、pr-grade-guard(scripts/check-pr-grade.ts:档位声明 vs 从 diff 推导的最低档位,规则 = R-74~R-78 五条)、writeset-guard(scripts/check-writeset.ts:解析 PR body「## 写集声明」为 glob,gh pr diff --name-only 越集即红 —— 这是「禁止顺手做」的机器判据)、harness-selfguard(scripts/check-harness-self.ts:.claude/settings.json ≡ settings.example.json、never-allow 清单模式未出现在 allow 数组、scripts/ 变更须带 selftest 变更)。取 PR 文件列表统一用 `gh pr view --json files,changedFiles` 而非 `gh pr diff --name-only`(ci.yml 行 43-44 已记录后者对非 ASCII 路径做 C 转义会误判的坑,新脚本必须照抄)。
- 【L2 git hooks via core.hooksPath,提交进仓、对任何 agent 生效】新建 .githooks/{pre-commit,pre-push,post-checkout},仓库根 `git config core.hooksPath .githooks`(由 pnpm 的 prepare/postinstall 自动设置,fresh worktree 也覆盖)。pre-commit:跑 scripts/check-redzone.ts --staged(暂存区命中红区且无授权令牌 → 拒)+ 通行标记校验(R-63 的 agent 无关半边)。pre-push:跑 scripts/check-changelog-frozen.ts + check-audit-events.ts(append-only 锁)。post-checkout:检测 prisma 生成物陈旧(R-68)并打印两条命令。已知边界:`--no-verify` 可绕过、hooksPath 需每 clone 设置一次 —— 所以 git hook 定位为「快速反馈层」,L1 CI 才是 fail-closed 层,两层的检查脚本必须是同一份(scripts/check-*.ts),避免双份实现漂移。
- 【L3 npm script 作为唯一 sanctioned 入口】新增 pnpm guard:redzone / guard:exam / guard:grade / guard:writeset / guard:changelog / guard:auditevents / guard:goal,并聚合为 `pnpm guard:all`;把 guard:all 串进 agent:check:quick(秒级、无 DB 依赖,与四个 docs 守护同级)。另新增 `pnpm merge:squash <PR> --writeset <file>` 作为 squash 合并的唯一入口(见 summary(b))。这一层对 Codex 的意义:AGENTS.md 只需写一句「合并走 pnpm merge:squash,不直接 gh pr merge」,Codex 读得到、执行得了,且脚本内部把 §5.4 八条全部实现,不依赖模型记住细节。
- 【L4 AGENTS.md 内新增「§7 机器执法清单」小节(约 400 字符)】明确告诉两个模型:哪些规则已有机器执法、对应哪个命令、违反会在哪一步红。内容形如表格:红区路径→pnpm guard:redzone / 考卷→pnpm guard:exam / 档位→pnpm guard:grade / 写集→pnpm guard:writeset / 合并→pnpm merge:squash / 开工→pnpm agent:preflight。这一节替代被删掉的 R-46/R-54/R-57/R-58/R-72/R-81/R-94/R-97/R-100 等约 9 条冗余散文,恒读层净瘦身,覆盖面反增。对 Codex 尤其关键 —— 它不读 .claude/,这张表是它唯一能知道「有机器在盯着」的地方。
- 【L5 settings.json 的 Codex 对称缺口(须显式承认,不可假装已覆盖)】settings.json 的 deny/ask 仅对 Claude Code 生效。Codex 侧无等价机制,以下五类只能靠 L1/L2 事后拦:pnpm/npm/yarn/bun 包管理器选择、prisma migrate dev|reset|db push、git reset --hard / push --force、gh pr merge --merge|--rebase|--admin、rm -rf。缓解顺序:①能落到「产物可检」的(包管理器→pnpm-lock 存在性 + 无 package-lock.json/yarn.lock,CI 硬判;migration→migrations 目录 append-only,CI 硬判)优先做成 CI;②只有过程可见的(reset --hard / force push)靠 pre-push hook + branch protection(force push 到 main 已被 GitHub 拒);③剩余残口如实写进 AGENTS 判断原则区,标注「Codex 执行 A/B 档时此类操作须先问」。
- 【L6 已核实的 settings.json 三处真实缺口,须在迁移同批修补(否则机器层比散文松 = 迁移即放宽)】① `Bash(pnpm prisma:migrate*)` 未被任何规则命中,而 package.json 定义 prisma:migrate = prisma migrate dev(现有 ask 只匹配 `prisma migrate dev*` 系列字面量)→ 补 ask。② `--force-with-lease` 在 process §5.4 条 7 禁止清单内,但 deny 只有 `--force` 系列 → 补 deny 两模式。③ 裸 `git pull` 与 `git pull --rebase` 被 §5.4 条 3 明禁,但 allow 只放行 `--ff-only` 系列,这两者落默认路径未被 deny → 补 ask/deny。另建议补 deny:`Bash(*--updateSnapshot*)` / `Bash(*jest* -u*)`(对应 AGENTS §1「禁盲 -u」),补 RED 相关的 `Bash(cat .env*)` / `Bash(env)` / `Bash(printenv*)`(对应 §7 条 9 的读取侧)。

### 第二部分小结(含红区 glob 完整表 / squash 守护脚本设计 / 开工门禁双件套 / 考卷保护设计)

矩阵第二部分共 79 行(R-30~R-108,编号从 R-30 起以避开第一部分),覆盖 AGENTS §3 全节(读写分区 3 + 红区清单 8 组 + 评审补入 5 组 + 触发即停 14 + prisma 禁令 3)与 process §2(7)/§3(11)/§4(4)/§5.4(8)/§7 全 16 条。分类分布:机器化 42、路径注入 5、留散文 23、已冗余可删 9。执行体覆盖:双模型 41、仅Claude+需补agent无关层 38、纯仅Claude 0(所有 Claude-only 载体都已配对 agent 无关层)。

核心判断:AGENTS §3 触发即停 14 条里有 4 条(#1 schema/#10 release/#13 红区文档/#14 危险 git)是同文件内他节的逐字复述,process §4 七特征整块是 AGENTS §3 的复述,process §7 有 3 条(条2 open PR/条5 D-E降速/条8 不调和冲突)与 §2/§4/AGENTS §0 重复 —— 删这 9 条不损失任何约束力(机器层或恒读层他处已承载),腾出的恒读预算恰好容纳评审补入的 5 组红区路径。另发现两处规则体系自我不一致:process §6 自称「唯一副本在 AGENTS §0」却在 §7 条 8 又写了一份;process §9 收尾六节与 PR template 五节不对齐,导致「按格式输出」无判据。

=== (a) 红区 PreToolUse hook 匹配模式 ===
载体:.claude/hooks/redzone-guard.sh，PreToolUse matcher 字段填工具名正则 `Edit|Write|MultiEdit|NotebookEdit`(matcher 匹配的是工具名，不是路径)；路径 glob 表写在脚本内，对 stdin JSON 的 tool_input.file_path 做匹配，命中 → exit 2 + stderr 说明。另需 .claude/hooks/bash-write-guard.sh(matcher: `Bash`)拦 sed -i / perl -i / tee / `>` / `>>` / cp / mv / git checkout -- / git restore / git apply / patch，否则整套保护被一条 sed 绕过。

RED glob 完整表(原清单 8 组 + 评审补入 5 组):
  # 六大红区文档
  AGENTS.md · CLAUDE.md · .claude/CLAUDE.md · ARCHITECTURE.md · docs/srvf-foundation-baseline.md · docs/V2红线与复活路径.md · docs/api-surface-policy.md
  # 原清单其余
  .github/workflows/** · prisma/schema.prisma · prisma/migrations/** · prisma/seed.ts · src/common/guards/** · src/common/filters/** · src/common/interceptors/** · src/modules/auth/** · src/modules/storage/storage-crypto.service.ts · docs/archive/**(仅拦 Edit，Write 新文件放行) · CHANGELOG.md(行级，交 scripts/check-changelog-frozen.ts)
  # 语义补齐(原清单真空，不算扩权，是把散文已有语义落全)
  src/bootstrap/**(触发即停 8 的「全局 Pipe」真身；src/common/pipes 不存在) · src/**/*throttler*(触发即停 3) · Dockerfile · .dockerignore · docker-compose.yml(触发即停 7)
  # 评审结论补入
  scripts/**(守护脚本自身) · test/setup/**(8 文件：global-setup/load-env/reset-db/reset-test-db-cli/setup-files/test-app/test-db/worktree-db) · test/contract/**(openapi.contract-spec.ts + __snapshots__/openapi.contract-spec.ts.snap) · .claude/hooks/** · .claude/settings.json · .claude/settings.example.json · .claude/rules/**
注意 §3 自由区把 test/** 划为绿，与补入的 test/setup/** + test/contract/** 直接冲突 → GREEN glob 必须写成 test/** 减去这两支，且 §3 原文那一行要同步改(属规则语义澄清而非放宽)。授权表达:hook 读 `$(git rev-parse --git-path srvf-redzone-grant.json)`(每 worktree 独立、天然不入库)，该文件只能由用户跑 `pnpm harness:grant <glob> --reason` 生成，且该路径本身在 RED 表内 —— 模型改不了自己的授权。

=== (b) squash 八条收敛为 scripts/squash-merge-guard.sh ===
入口 `pnpm merge:squash <PR> --writeset <file> [--auto]`；settings 把 `Bash(gh pr merge * --squash*)` 从 allow 移出(散文本就要求五项全过才许 merge，现状直放才是放宽)，只 allow 守护入口。
阶段 PRE(对应条 1，全过才继续):①主仓在 main 且 `git status --short` 空 ②`gh pr list --state open` 只剩目标 PR ③`gh pr view --json state,isDraft,mergeable,mergeStateStatus` = OPEN/false/MERGEABLE/CLEAN(--auto 模式允许 BLOCKED，此时跳过 ④ 并记录「由 required checks 兜底」)④`gh pr checks` 全绿 ⑤`gh pr diff --name-only` ⊆ writeset ⑥记录 headRefName 与 baseSha 到阶段令牌。
阶段 MERGE(条 2):独占执行 `gh pr merge <PR> --squash --delete-branch`(或 --auto)；内建 exit≠0 判读 —— 先 `gh pr view --json state,mergedAt,mergeCommit`，MERGED 则进 POST 绝不重跑，OPEN 才算真失败；`--merge/--rebase/--admin` 在脚本内直接拒绝，不提供参数通道。
阶段 POST:①`git pull --ff-only origin main`，失败即停(条 3) ②`git ls-remote --heads origin <headRef>` 看 stdout 非空才 `push origin --delete`，删后复跑确认为空，分支名只取 PRE 记录的那个不接受通配(条 4) ③worktree:确认 clean → remove(禁 --force) → 删分支，`?? .DS_Store` 单行是唯一特例(条 5) ④patch-equivalence 五项逐项执行并打印原始输出，全过才对该单一分支 `-D`(条 6)；第 ② 项须按已知教训改用 squash 提交为基准，不用 `main..<branch>`(main 已前进时会假阳性) ⑤输出可直接粘贴的 markdown 收尾块(条 8)。
fail-closed 语义:任一步骤「无法判定」(gh 未登录/网络抖动/jq 缺失/ref 不可解析/writeset 文件缺失/PR body 无写集声明)一律 exit 1 并明说卡在哪一步，绝不「核对不了就放行」；PRE 未过则不生成阶段令牌，POST 拒绝执行(这就是条 7 末项「跳过本节任一步骤」的机器判据)；脚本只在 PRE 全过后执行破坏性动作，其余情况只打印下一条许可命令。

=== (c) 开工门禁双件套 ===
件一 SessionStart hook(.claude/hooks/preflight-gate.sh):跑 scripts/agent-preflight.sh(SRVF_LANE 有值则 --lane)。通过 → 写通行标记到 `$(git rev-parse --git-path srvf-preflight.json)`(每 worktree 私有目录、不入库、lane 天然隔离)，内容 {ts, mode: global|lane, lane, head_sha, origin_main_sha, worktree_path, prisma_generated_ok}；不通过 → 不写标记，用 additionalContext 把 preflight 的 ✗ 原文推进上下文。
件二 PreToolUse hook(.claude/hooks/preflight-token-check.sh，matcher `Edit|Write|MultiEdit|NotebookEdit|Bash`):读标记，任一条不成立即 exit 2 —— 标记缺失 / worktree_path 不匹配 / head_sha 已变 / origin_main_sha 已前进(main 动了要重新过门) / 超过 N 小时。只读工具(Read/Grep/Glob)绝不拦 —— D 档降速第①步就是「只读调研不动代码」，拦了会逼人绕过门禁。
关键防绕:标记路径本身列入 RED glob，模型不能自己签发；标记只能由用户可见地跑 `pnpm agent:preflight` 重新生成。可扩展位:标记里加 `phase: research-only`，让 D 档只读调研阶段的写入被 PreToolUse 拒(R-82 的机器化半边)。agent 无关对称层 = .githooks/pre-commit 调同一份 agent-preflight.sh(Codex 提交时同样过门)。preflight 脚本本身建议同批补三项已缺的硬判/打印:README current-state 指针(R-64，纯字符串存在性，可直接升硬判)、版本三方比对(R-66，现在只分别打印靠人肉核)、Unreleased 段与 tag 关系(R-65，咨询级)。

=== (d) 「考卷保护」CI job 设计 ===
job 名 exam-guard，落 .github/workflows/harness-guard.yml，加入 required checks。检测器 scripts/check-exam.ts 从 `gh pr view --json files` + `git diff origin/main...HEAD` 计算五类信号:
 ①既有 *.spec.ts 中 expect( / toBe / toEqual / toMatchSnapshot / .status / BizCode. 的净减少数
 ②it( / describe( 净减少数、测试文件删除数
 ③新增的 .skip / .only / xit / xdescribe、jest config testPathIgnorePatterns 新增项
 ④test/contract/__snapshots__/** 任意变更(逐 hunk 分类:新增路由 / 删除路由 / 字段增删)
 ⑤test/contract/openapi.contract-spec.ts 中 EXPECTED_ROUTES 的增删条目数
另加一条无豁免硬判:snapshot 新增行匹配 /passwordHash|[Tt]oken|secret|signedUrl/ → 直接红(AGENTS §1「L3 字段出现 = 拒」)。
任一信号非零 → 要求 PR body 存在结构化段:
  ## 行为变更声明
  - 变更类型: 行为契约变更 | 测试重构(行为等价) | 新增覆盖
  - 受影响断言: <file:line> × N
  - EXPECTED_ROUTES 增/删: +N / -N
  - snapshot 逐行解释: <...>
  - 拍板来源: goal 链接 | 会话 | 评审稿路径
硬判两层:段缺失/占位符未填 → 红；**声明的 N 与 CI 从 diff 算出的 N 不一致 → 红**(不采信 AI 自述数字，这一条是堵「自报完成」的关键)。CI 同时把 diff 派生的计数以评论回帖 PR，让维护者看到的是机器算的数不是 AI 写的数。
诚实的边界:PR body 由 AI 撰写，本 job 提供的是「说明义务 + 数字对账」，不是授权 —— 真正的授权仍需维护者 review。要让它真 fail-closed，必须①加入 branch protection required checks ②豁免只能走 CODEOWNERS/维护者标签，不能由 PR 作者自加 label。

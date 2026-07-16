# docs/ai-harness/ — AI Harness 操作层(单页)

> **性质**:derived 操作层,**非规则源**;与权威源(`AGENTS.md` / `current-state.md` / `process.md` / `api-surface-policy.md`)冲突时本页让步,并回头修本页。
> **必读三件套** = [`current-state.md`](../current-state.md)(当前事实)+ 本页 + [`process.md §2/§3`](../process.md)(开工门禁 + PR 五档);`AGENTS.md` 按任务主题选读对应节(节号见下表),baseline / V2 红线 / ARCHITECTURE / api-surface-policy 按需。
> 开工先跑 `pnpm agent:preflight`(硬判 工作树 clean / 无 open PR / 未落后 origin/main,任一不过 exit 1;余项只读);fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`。

## 1. 铁律速查(主题 → 一句话 → 出处)

| 主题 | 一句话 | 出处 |
|---|---|---|
| 包管理 | pnpm-only,禁 npm / yarn / bun | AGENTS §0 |
| 跨文件改动 | 先符号 / 引用链确认再动手;grep 同名只定位候选 | AGENTS §0 |
| 模块结构 | 4 文件基线 + 已解锁例外;平铺,禁嵌套子目录 / `*.entity.ts` / utils grab-bag | AGENTS §2 |
| 命名 | `passwordHash` / `key` / `createdAt` / cuid;enum 从 `@prisma/client` 导入 | AGENTS §3 |
| 响应格式 | `{ code, message, data }`;业务只 return data;分页固定 DTO,禁 limit/offset | AGENTS §4 |
| 错误码 | `BizCode` 三字段集中于 `biz-code.constant.ts`;段位锁死;禁自创 token 类 100xx | AGENTS §5 |
| Swagger | 100% 覆盖;分页必用 `@ApiWrappedPageResponse`;禁裸 `@ApiOkResponse`;summary 带鉴权后缀(检查项 G) | AGENTS §6 |
| 校验 | 全局 ValidationPipe(whitelist + forbidNonWhitelisted);禁局部重复配置 | AGENTS §7 |
| 鉴权 | Guard 全局注册,禁 `@UseGuards`;`@Public` 与 `@Roles` 互斥;JwtPayload 仅 `{sub, username}`;身份有效性不缓存 | AGENTS §8 |
| 密码 / token | passwordHash 永不出响应;refresh token 行为冻结(rotation always / family revoke / 联动撤销五场景) | AGENTS §9 |
| 软删除 | 禁 `delete()`;`notDeletedWhere` 统一过滤;唯一性预检查用 `findUnique`(含软删) | AGENTS §10 |
| DTO | 入参白名单第一道防线;App DTO 禁从 Admin DTO 派生(extends / Pick / Omit / …Type) | AGENTS §11 / §19.7 D-6 |
| 事务 | 多写 / 先查后写 / 管理员保护操作必须 `$transaction` | AGENTS §12 |
| 角色保护 | `assertCanManageUser` 统一入口;自我保护;最后 SUPER_ADMIN 事务内计数;禁加 SA 互斥 | AGENTS §13 |
| 配置归属 | env 归 `*.config.ts`;业务判断只用 `APP_ENV`;production fail-fast 禁默认值兜底 | AGENTS §14 |
| 测试纪律 | 新 e2e 必须复用 `test/{setup,fixtures,helpers}` 既有工具,禁重复造轮子;错误断言同核 HTTP status 与 BizCode;改 service 编排前先跑对应 characterization spec,行为差异 = 停下报告而非改断言 | AGENTS §16 / testing.md |
| 受影响范围 | 改哪个模块跑哪组 e2e + 横切组(response-format / bizcode / request-id);改依赖枢纽(permissions / audit-logs / `common/*`,扇入 9-19)或全局横切 → 先列引用链、直接 `agent:check:full` | process §3 / §4 |
| snapshot SOP | contract snapshot 仅随拍板范围内接口 PR 更新,diff 逐行检视;EXPECTED_ROUTES 增删显式登记;禁为过测试盲目 `-u`;L3 字段出现 = 拒 | AGENTS §16 / process §3 |
| 敏感字段三问 | 业务用途 / 查看角色与掩码 / 保存期限——入 schema / DTO 前必答 | AGENTS §18.4 |
| 决策锁 | D-1 ~ D-9 已拍板决策禁重开(contribution-rules 归 System / App 准入 / capabilities ≠ permission code / `/me` `/my` 物理分离 / Route B 四前缀终态…) | AGENTS §19.7 / §21 |
| API surface | 新 endpoint 只落 `admin/v1` · `app/v1` · `auth/v1` · `system/v1`;`open/v1` 预留禁占用;禁新增 Mixed Controller;App 永不返回 L3 字段 | api-surface-policy §0 |
| git 安全 | 禁 `reset --hard` / `push --force` / 批量 `-D` / 动 unrelated worktree;squash 后清理走 patch-equivalence | AGENTS §20 / process §5.4 |
| 协作纪律 | 授权清单内连续推进(清单外不得);必须输出"本次未做";判断给证据;不顺手修;不输出 secret | process §7 / §7.1 |

## 2. AI 修改三档 + 触发即停

- 🟢 **允许自动**(A/B 档,PR 评审仍必经):docs(权威源除外)/ 本目录 true-up;测试新增补强(**禁删既有测试、禁放宽断言**);不改字段集的 DTO 校验与 Swagger 注解;service 内局部重构(签名与行为契约不变);非破坏性 bug fix。
- 🟡 **谨慎**(C/D 档,沿 process §3/§4;C 档范围已含于 goal → 免二次确认):新 endpoint / DTO 字段 / 新 BizCode(C);schema·migration·seed(D,`srvf-prisma-change`);RBAC 码/绑定/Guard(D,`srvf-auth-security` + [`RBAC_MAP §6`](./RBAC_MAP.md));auth / JWT / throttler / 全局 interceptor·filter·pipe / bootstrap(D);`src/common/**` 导出物(先列引用链);依赖项 / workflows / Dockerfile(必然 D);跨模块重构 / 拆 service(`srvf-god-service-refactor`,characterization 先行)。
- 🔴 **禁止自动**(人工确认立项才可):删表 / 删字段 / 删 migration / 删既有测试 / 物理删数据;`memberNo` 规则与组织树形态;权限绕过 / SA·ops-admin 保护 / 防枚举一致性;token 逻辑(P0-E 冻结)/ 凭证加密 / audit 不可变(A-1);生产配置;`migrate dev|reset|db push` 任何环境禁自动跑;controller path 变更(Route B 终态由 contract 锁定);多租户 / Redis / queue / cron / LLM / 大型新依赖(AGENTS §1 评审解锁制);六大红区文档 / `docs/archive/**` / 已发布 CHANGELOG 段;把猜测当事实(不确定 → 标"需人工确认"并暂停)。

**触发即停**(动手前必须按 [`process.md §4.1`](../process.md) 人话简报拍板):① schema / migration / seed;② Role / Permission 码 / 绑定 / Guard 语义;③ 登录 / JWT / refresh / throttler;④ Storage / COS / 凭证;⑤ audit_logs / AuditLogEvent;⑥ 新 endpoint·DTO·错误码(goal 已含范围免二次确认;snapshot diff 逐行解释进 PR 描述);⑦ workflows / 依赖 / Dockerfile;⑧ 全局 Guard·Interceptor·Filter·Pipe;⑨ 跨模块重构 / 拆 service;⑩ release / tag(E 档强串行);⑪ 物理删数据 / 批量回填;⑫ 敏感字段(三问先答);⑬ 红区文档 / archive / 已发布 CHANGELOG;⑭ `reset --hard` / `push --force` / `remove --force` / 批量 `-D`(会话内二次授权)。

**发现类暂停**:文档-代码冲突、权威源互冲(按 process §6 优先级仍存疑)→ 停;审计 / 调研发现 bug 不顺手修,随报告上报(被采纳的长期风险由维护者转 [`current-state.md §4`](../current-state.md));改既有断言 = 改行为契约 → 停;范围外"看起来该一并修" → 禁夹带;不确定信息禁写成事实。**暂不启动清单**以 [`current-state.md §3`](../current-state.md) 为准——用户诉求命中时:说明状态 + 列影响面 + 判档位 + 给最小评审方案 + 等拍板(评审解锁制,不得仅凭旧条目直接拒绝,也不得直接实现)。

## 3. 全仓读写分区

| 分区 | 范围 | AI 行为 |
|---|---|---|
| 🟢 自由区 | docs(非权威源)/ `test/**` 新增 / 本目录 | 可直接修改,按 PR 档位走检查 |
| 🟡 谨慎区 | `src/**` 业务代码 / 配置 / contract snapshot / 工具链(eslint·tsconfig·jest 配置) | 按 process §3 定档;C 档 goal 内免二次确认;D 档一律拍板 |
| 🔴 红区 | 见下清单 | **非用户授权不动**;触碰即 D/E 档降速(评审稿 + 拍板) |

红区精确清单:六大红区文档(`AGENTS.md` / `ARCHITECTURE.md` / `CLAUDE.md` / `docs/srvf-foundation-baseline.md` / `docs/V2红线与复活路径.md` / `docs/api-surface-policy.md`)+ `.github/workflows/**` + `prisma/{schema.prisma, migrations/**, seed.ts}` + `src/common/{guards,filters,interceptors}/**` + `src/modules/auth/**`(P0-E 行为冻结)+ `src/modules/storage/storage-crypto.service.ts` + `docs/archive/**`(只读)+ 已发布 CHANGELOG 段。

定位路径:[`current-state.md`](../current-state.md) →(领任务)→ 根 [`CODEMAP.md`](../../CODEMAP.md)(src 模块地图,`docs:codemap:check` 守护)→ 模块级 `CLAUDE.md`(11 个:activities / activity-registrations / announcement-import / attachments / attendances / auth / authz / member-departments / notifications / permissions / storage,动模块时顺手校准;另有 `prisma/CLAUDE.md` 不在 src/modules 下但同守护〔review #484 G22 true-up:此前「9 个」漏列 authz/announcement-import/member-departments〕)→ 改权限再读 [`RBAC_MAP.md`](./RBAC_MAP.md)。**勿整读**:`docs/archive/**` 正文、contract snapshot(~36k 行,用 diff 看)、`pnpm-lock.yaml`。

## 4. 目录说明

本目录恰 4 文件:**README.md**(本页)/ **codex-review-sop.md**(跨模型评审 SOP,process §8.3)/ **RBAC_MAP.md**(权限地图:双轨现状、controller × 权限码对照、191 权限码全集〔review #484 G21 true-up:此前「76」〕、保护不变式、AI 硬规则;`pnpm docs:rbacmap:check` 守护)/ **NEXT_TASKS.md**(后续任务清单;逐项单独立项,AI 不自动启动)。

2026-06-10 Review 总报告与底座设计两份冻结档已归档至 [`archive/ai-harness/`](../archive/ai-harness/)(不回改;其内指向旧操作层文件的链接为预期死链)。本目录更新一律走 A 档 PR(权限**事实**变更本身是 D 档,本目录只能事后 true-up);沿 [`process.md §6`](../process.md)"无守护不留"原则,不再新增无守护的派生地图。

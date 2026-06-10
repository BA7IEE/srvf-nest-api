# PROJECT_RULES — 铁律索引 + AI 修改权限三档

> **性质**:索引文档,非规则源。**所有规则的原文与解释权在权威源**;本文件按"AI 开工视角"重排为可执行清单,每条都给出处。修订规则 = 修订权威源(D 档 / 用户拍板),**不是**改本文件。
> 冲突顺序(高→低):`current-state.md`(事实)> `AGENTS.md` > `srvf-foundation-baseline.md` > `V2红线与复活路径.md` > `api-surface-policy.md` > `process.md` > 本目录。

---

## 1. 任务前门禁(每个会话必做)

```bash
pnpm agent:preflight   # clean 工作树 / 期望分支 / 0 open PR / 版本三方一致
```

任一不满足 → **不开新任务**,先与维护者对齐([`process.md §2`](../process.md))。fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`(否则 typecheck 假错误)。

## 2. 铁律速查索引(按主题 → 权威源)

| 主题 | 一句话 | 出处 |
|---|---|---|
| 包管理 | pnpm-only,禁 npm/yarn/bun | AGENTS §0 |
| 跨文件改动 | 先符号/引用链确认再动手;grep 同名只定位候选 | AGENTS §0 |
| 模块结构 | 4 文件基线 + 已解锁例外(surface controller / dto/app / 6 类职责抽出);平铺,禁嵌套子目录,禁 `*.entity.ts`,禁 utils grab-bag | AGENTS §2 |
| 命名 | `passwordHash` / `key` / `createdAt` / cuid / enum 从 `@prisma/client` 导入 | AGENTS §3 |
| 响应格式 | `{ code, message, data }`;业务只 return data;分页固定 `PaginationQueryDto`/`PageResultDto`,禁 limit/offset | AGENTS §4 |
| 错误码 | `BizCode` 三字段对象,集中在 `biz-code.constant.ts`;段位锁死;禁自创 token 类 100xx | AGENTS §5 |
| Swagger | 100% 覆盖;分页必用 `@ApiWrappedPageResponse`;禁裸 `@ApiOkResponse` | AGENTS §6 |
| 校验 | 全局 ValidationPipe(whitelist + forbidNonWhitelisted);禁局部重复配置 | AGENTS §7 |
| 鉴权 | Guard 全局注册,禁 `@UseGuards`;`@Public` 与 `@Roles` 互斥;JwtPayload 仅 `{sub, username}`;身份有效性不缓存 | AGENTS §8 |
| 密码/token | passwordHash 永不出响应;refresh token 行为冻结(rotation always / family revoke / 联动撤销四场景) | AGENTS §9 |
| 软删除 | 禁 `delete()`;`notDeletedWhere` 统一过滤;唯一性预检查用 `findUnique`(含软删) | AGENTS §10 |
| DTO | 入参白名单第一道防线;App DTO 禁从 Admin DTO 派生(extends/Pick/Omit/…Type) | AGENTS §11 / §19.7 D-6 |
| 事务 | 多写 / 先查后写 / 管理员保护操作必须 `$transaction` | AGENTS §12 |
| 角色保护 | `assertCanManageUser` 统一入口;自我保护;最后 SUPER_ADMIN 事务内计数;SA 互操作是设计选择,禁加互斥 | AGENTS §13 |
| 配置归属 | env 归 `*.config.ts`;业务判断只用 `APP_ENV`;production fail-fast 禁默认值兜底 | AGENTS §14 |
| 敏感字段三问 | 业务用途 / 查看角色与掩码 / 保存期限——入 schema/DTO 前必答 | AGENTS §18.4 |
| 决策锁 | D-1 ~ D-9 已拍板决策禁重开(contribution-rules 归 System / App 准入 / capabilities ≠ permission code / `/me` `/my` 物理分离 / Route B 四前缀终态…) | AGENTS §19.7 / §21 |
| API surface | 新 endpoint 只落 `admin/v1 | app/v1 | auth/v1 | system/v1`;`open/v1` 预留禁占用;禁新增 Mixed Controller | api-surface-policy §0 / current-state §2.1 |
| git 安全 | 禁 `reset --hard` / `push --force` / 批量 `-D` / 动 unrelated worktree;squash 后清理走 patch-equivalence | AGENTS §20 / process §5.4 |
| 协作纪律 | 在用户已授权任务清单内可连续推进下一 PR(清单外不得);必须输出"本次未做"段;判断必须给证据;不擅自修复审计发现的问题;不输出 secret | process §7 |

## 3. AI 修改权限三档

### 🟢 允许自动修改(常规 A/B 档;PR 评审仍必经)

- 文档(权威源 6 文件除外)/ 本目录地图 true-up
- 测试新增与补强(unit / e2e / fixtures;**禁止删除既有测试或放宽既有断言**)
- 局部 DTO 校验与 Swagger 注解修正(不改字段集 / 不改 snapshot 语义)
- service 内部局部逻辑 / 私有方法重构(签名与行为契约不变)
- 非破坏性 bug fix(不动 endpoint / DTO 字段 / 错误码 / schema)

### 🟡 谨慎修改(C/D 档;按 process §3/§4 走——C 档范围已含于用户任务说明 / goal 时免二次确认,AI 自行发起仍须拍板;D 档一律拍板)

- 新 endpoint / DTO 字段增减 / 新 BizCode / 响应语义变化(C 档:范围在 goal 内免二次确认,否则动手前拍板;`agent:check:full`)
- `prisma/schema.prisma` / `migrations/` / `seed.ts`(D 档:`srvf-prisma-change` skill 全流程)
- RBAC(权限码 / 绑定 / Guard / 装饰器)(D 档:`srvf-auth-security` skill + [`RBAC_MAP.md §6`](./RBAC_MAP.md))
- auth / JWT / throttler / 全局 interceptor·filter·pipe / bootstrap 装配(D 档)
- `src/common/**` 任何导出物(扇入 9-19 模块,先列引用链)
- `package.json` 依赖项 / `.github/workflows/**` / Dockerfile / docker-compose(必然 D 档)
- seed 数据 / 配置文件 / `.env.example`
- 跨模块重构 / god-service 拆分(`srvf-god-service-refactor` skill;characterization 先行)

### 🔴 禁止自动修改(必须人工确认后才可立项)

- 删表 / 删字段 / 删 migration / 删既有测试 / 物理删业务数据
- `memberNo` 编号规则(长期固定不复用)与组织树形态(单树:队→部门→小组)
- 权限绕过逻辑 / super_admin 与 ops-admin 保护逻辑 / 防枚举一致性
- 认证 token 逻辑(P0-E 行为冻结)/ 凭证加密(AES-256-GCM)/ audit 不可变性(A-1)
- 生产配置 / 生产数据库命令(`migrate dev|reset|db push` 任何环境都禁自动跑)
- 大规模重构 / API 兼容性破坏 / controller path 变更(Route B 终态由 contract 断言锁定)
- 引入多租户 / Redis / queue / cron / LLM / 大型新依赖(AGENTS §1 B/C 档,评审解锁制)
- 六大红区文档:`AGENTS.md` / `ARCHITECTURE.md` / `CLAUDE.md` / `srvf-foundation-baseline.md` / `V2红线与复活路径.md` / `api-surface-policy.md`
- `docs/archive/**`(历史快照)与已发布 CHANGELOG 段
- 把临时方案伪装成最终方案;把猜测当事实(不确定 → 标记"需要人工确认"并暂停)

## 4. 证据与收尾

- 所有判断给证据:文件路径:行号 / 命令输出 / PR 链接(process §7)。
- 每任务收尾输出 process §8 标准段落(修改清单 / 做了什么 / **未做什么** / 验证命令 / open PR 状态 / 建议下一步);会话级状态用 [`templates/progress.md`](./templates/progress.md)。

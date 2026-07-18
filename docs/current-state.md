# SRVF API 当前状态入口

> **第一入口,当前事实唯一权威源**。事实与蓝图冲突以本文件为准;遇冲突不擅自调和,先报告等拍板。
> Harness 2.0 全指针形态(T0 `archive/reviews/harness-2.0-t0-review.md`):只留"现在是什么 + 往哪看",历史叙事在 CHANGELOG / `archive/handoff/`;§1 计数 `docs:counts(:check)` 生成守护,体积 `docs:readtax:check` 守护(≤4,500 字符);v1 快照 `archive/harness-v1/current-state.md`。

## 1. 当前版本状态

| 项 | 当前值 / 何处看 |
|---|---|
| 版本(六处一致) | **v0.58.0**(2026-07-17;package.json = Swagger = CHANGELOG = tag = GitHub Release = handoff OpenAPI;tag 指向 handoff #680 squash `30675e28`;最新 handoff `archive/handoff/v0.58.0.md`) |
| main HEAD / open PR / Unreleased | 实时看 `gh pr list` · [`CHANGELOG.md`](../CHANGELOG.md) `## Unreleased` + `changelog.d/`;当前:v0.58.0 回填点(第五轮 review #674 + 双 lane 修复 #675/#676 + 回填 #677 + 收口 #678-#680)|

<!-- counts:begin -->
<!-- 由 `pnpm docs:counts` 生成;禁止手改,`pnpm docs:counts:check` 守护 -->
| 计数项 | 值 |
|---|---|
| 模块 | 36 |
| Controller | 74 |
| Endpoint | 364 |
| Migration | 58 |
| BizCode | 253 |
| 权限码 | 206 |
| AuditLogEvent | 114 |
| 内建角色 | 9 |
| Cron | 2 |
<!-- counts:end -->

## 2. 能力清单(全指针)

- **接口与字段真相**:live `/api/docs-json` + contract snapshot + `EXPECTED_ROUTES`;**逐版本叙事**:[`CHANGELOG.md`](../CHANGELOG.md) + `archive/handoff/`
- **模块地图** `CODEMAP.md` · **权限地图** `ai-harness/RBAC_MAP.md`(各有 check 脚本守护)· **数据模型** `prisma/schema.prisma`
- **API surface 终态**:5 canonical 前缀(admin / app / auth / system / open 各 `/v1`),contract 断言锁定;规则见 `api-surface-policy.md`;❌不新增 Mixed Controller(存量 2 冻结)❌App 永不返回 L3(content-* 签名 URL 过可见级后返是唯一范围例外)
- **会话注销终态**:`POST /api/auth/v1/logout` 由任一可识别且未过期 row(含 rotated ancestor)幂等撤销所属 refresh family 全部活跃未过期 token;其他 family 与 access 不动;详见 `security.md`
- **限流多实例一致性**:10 个命名 throttler 共用 PostgreSQL `throttler_buckets`，保留 IP tracker / 包 hash key / limit+ttl+block / 42900 / 无 header 语义；DB/storage 异常严格 fail-closed 50000，零本地 Map fallback；过期桶手动 retention，Cron 仍恰好 2
- **贡献规则 ACTIVE 槽位**:`ContributionRule` 以 `activityTypeCode × attendanceRoleCode` 为未软删 ACTIVE partial unique；`durationThreshold` 仅是单规则内部档位参数。create/激活在事务内预查，真实并发由 DB unique + 23002 收口；calculator 若读到漂移重复 pair 立即 fail-closed，不按创建顺序任取。
- **通知 durable outbox**:`notification_outbox_intents` 以 eventKey 幂等、PostgreSQL `SKIP LOCKED` + lease/fencing 支持独立多实例 worker；生日/到期两个既有 cron 只 enqueue，notifications-owned marker/状态/audit 与 intent 同事务。微信广播与 admin SMS 均按 generation 留历史，并以各自 active-slot partial unique 收敛同通知/会员的并发 child；admin 临时 skip 后可由新 confirmation 重试，只有 `NotificationDelivery SENT` 跨 generation 永久去重。known title/body 在 producer 入表前 canonical 脱敏，worker 对直插 raw row exact+strict fail-closed。provider 在事务外按 at-least-once 发送；SMS 本地 SENT log+delivery 同短事务，provider accepted 到本地 commit/ack 前仍允许重复；失败 intent 可退避重试，耗尽后 dead。

## 3. 暂不启动清单(AI 不得自行启动;评审解锁制;详见 harness-v1 快照 §3 与各评审稿)

- 新 schema / migration / Permission seed / Role 扩展;**第 3 个及以后 cron**(终态恰 2);LLM / vector / Redis / queue / 多租户
- 延后模型:events / event_participants / member_profiles 扩展敏感字段(沿 V2 红线 §4.3)
- scoped 可见性余面(users / content / notifications / audit-logs / attachment self-scope);Recruitment 与 team-join 维持中央流程 + 显式授权,不入职务派生
- 招新后续(退队 / 晋升 / 多部门归属 / 级别版本化 / 证书自动核验 gate / 部门级细分);保险后续(理赔 / 核验流 / 保单图 attachments / App requiresInsurance);CMS 后续(已读回执 / 评论点赞 / 定时发布 / UV / 部门级权限)
- Slow-5(入队同意书 / 退队清理 N 值)与 Slow-7(uploadToken 黑名单等 storage 深化)— 等业务 / 真实反馈
- 运维侧真实通道(COS / 微信小程序 / 腾讯云 OCR)— `docs/ops/` SOP 就绪,维护者执行
- god-service 重开拆分(P1-4 已收口,需 architecture-boundary §6 新触发 + 立项);repository 抽象层;未立项的 controller path / snapshot 变更
- 数据清理自动化(SMS / 招新脱敏 = 手动 SOP,不上 cron);历史 handoff / 冻结评审稿不回改、不当当前事实
- 招新身份证号 v1 明文入库(2026-06-18 拍板留审计痕迹;加密 / 哈希归 C-8 议题)

## 4. 当前风险 / 债务(仅 open 项;全文与建议见 `ai-harness/NEXT_TASKS.md` + 各评审稿)

| 等级 | 债务 |
|---|---|
| P1 | 前端联调剩运维侧 P0-H 演练 + P0-I 排错 SOP(系统侧无动作) |
| P1 | P1-22 专业队 gate 配置化;P1-23 isForeigner 历史列改名(对外已用 isNonMainlandDocument) |
| P2 | scoped 余面(§3);god-service 体量观察(codemap 实时口径);v0.44 接受项(#8 / #10 / #19 / #20#21 中 notifications-owned producer 已由 outbox 收口，跨模块 producer 留后续接入);单测占比刻意低(e2e 为主);Mixed 存量 2;snapshot 用 diff 勿整读 |
| P3 | SMS / 招新脱敏 retention 手动 SOP(刻意);28003 同轮枚举面(v1 接受);首轮 review 接受 / 延后残项(F7/F8/F13/F18 等)在 NEXT_TASKS |

## 5. 开工门禁

`pnpm agent:preflight` 全过才开工(global 三硬判;lane 会话用 `--lane <lane名>`);fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`;D 档降速沿 process §4;拍板未到不动代码。

## 6. 读取协议

恒读三件套 = 根 `AGENTS.md` → **本文件** → `process.md §2/§3`(唯一权威表述在 AGENTS §0;Claude Code 另读 `CLAUDE.md`);`ai-harness/README.md` 与其余(baseline / V2 红线 / ARCHITECTURE / 边界图 / SOP / RBAC_MAP / archive)触碰才读。

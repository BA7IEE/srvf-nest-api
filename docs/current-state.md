# SRVF API 当前状态入口

> **当前事实唯一权威源**。冲突以本文件为准;先报告,不擅自调和。
> Harness 2.0 指针版(T0 `archive/reviews/harness-2.0-t0-review.md`):只留当前事实与去向;历史见 CHANGELOG / `archive/handoff/`。§1 由 `docs:counts(:check)` 生成守护;全文 ≤4,500 字符;v1 快照 `archive/harness-v1/current-state.md`。

## 1. 当前版本状态

| 项 | 当前值 / 何处看 |
|---|---|
| 版本(六处一致) | **v0.58.0**(2026-07-17;tag/handoff #680=`30675e28`;`archive/handoff/v0.58.0.md`) |
| main HEAD / open PR / Unreleased | 实时看 `gh pr list` · [`CHANGELOG.md`](../CHANGELOG.md) `## Unreleased` + `changelog.d/`;基线=v0.58.0 回填点(#674-#680)|

<!-- counts:begin -->
<!-- 由 `pnpm docs:counts` 生成;禁止手改,`pnpm docs:counts:check` 守护 -->
| 计数项 | 值 |
|---|---|
| 模块 | 36 |
| Controller | 74 |
| Endpoint | 365 |
| Migration | 61 |
| BizCode | 258 |
| 权限码 | 207 |
| AuditLogEvent | 123 |
| 内建角色 | 9 |
| Cron | 2 |
<!-- counts:end -->

## 2. 能力清单(全指针)

- **接口与字段真相**:live `/api/docs-json` + contract snapshot + `EXPECTED_ROUTES`;**逐版本叙事**:[`CHANGELOG.md`](../CHANGELOG.md) + `archive/handoff/`
- **模块地图** `CODEMAP.md` · **权限地图** `ai-harness/RBAC_MAP.md`(各有 check 脚本守护)· **数据模型** `prisma/schema.prisma`
- **API surface 终态**:5 canonical `/v1` 前缀,contract 锁定;见 `api-surface-policy.md`;❌新增 Mixed Controller(存量 2)❌App 返回 L3(content-* 可见级后签名 URL 是唯一例外)
- **会话注销终态**:`POST /api/auth/v1/logout` 由任一可识别且未过期 row(含 rotated ancestor)幂等撤销所属 refresh family 全部活跃未过期 token;其他 family 与 access 不动;详见 `security.md`
- **限流多实例一致性**:10 个命名 throttler 共用 PostgreSQL `throttler_buckets`，保留 IP tracker / 包 hash key / limit+ttl+block / 42900 / 无 header 语义；DB/storage 异常严格 fail-closed 50000，零本地 Map fallback；过期桶手动 retention，Cron 仍恰好 2
- **贡献规则 ACTIVE 槽位**:`ContributionRule` 以 `activityTypeCode × attendanceRoleCode` 为未软删 ACTIVE partial unique；`durationThreshold` 仅是单规则内部档位参数。create/激活在事务内预查，真实并发由 DB unique + 23002 收口；calculator 若读到漂移重复 pair 立即 fail-closed，不按创建顺序任取。
- **通知 durable outbox**:eventKey 幂等，PG `SKIP LOCKED` + lease/fencing；marker/状态/audit 与 intent 同事务，provider 事务外 at-least-once，失败退避至 dead；cron 仅 enqueue。
- **Attachment storage Phase1**:Attachment key namespace 已接 durable ledger；locator 固定、凭证取当前 settings；旧 binary expand 未加 `Attachment.key` FK，repo-wide closure 未完成；见 [`runbook`](ops/attachment-storage-consistency-rollout.md)。
- **保险 v3 PR3 可切换 cutover**:单 gate 控制 App CAS、verified-only、Activity/Team Join evidence 与入队闸；true 时缺/null/空白 expectedVersion→40000 且零写/审计，stale 仍 26011。Cycle 保险 flag 可配置/返回，仅 final join 以 26031 拒绝。非生产默认 false、production 必须显式；本次未部署，启用须 drain 旧 server 且禁混档。
- **敏感读审计(C-2,2026-07-19)**:`AuditLogEvent` 123，placeholder 退役；管理端敏感读鉴权/查询后、CSV 交 generator 前、签名 URL 调 provider 前 fail-closed 落库。extra 仅 operation/字段名/maskLevel/计数，禁 PII/filter 值/key/URL。

## 3. 暂不启动清单(AI 不得自行启动;评审解锁制;详见 harness-v1 快照 §3 与各评审稿)

- 新 schema / migration / Permission seed / Role 扩展;**第 3 个及以后 cron**(终态恰 2);LLM / vector / Redis / queue / 多租户
- 延后模型:events / event_participants / member_profiles 扩展敏感字段(沿 V2 红线 §4.3)
- scoped 可见性余面(users / content / notifications / audit-logs / attachment self-scope);Recruitment 与 team-join 维持中央流程 + 显式授权,不入职务派生
- 招新后续(退队 / 晋升 / 多部门归属 / 级别版本化 / 证书自动核验 gate / 部门级细分);保险 PR3 enable/deploy(drain 旧 server、禁混档)、PR4 约束及理赔/保单图/App 展示;CMS 后续(已读回执 / 评论点赞 / 定时发布 / UV / 部门级权限)
- Slow-5(入队同意书 / 退队清理 N 值)与 Slow-7(uploadToken 黑名单等 storage 深化)— 等业务 / 真实反馈
- 运维侧真实通道(COS / 微信小程序 / 腾讯云 OCR)— `docs/ops/` SOP 就绪,维护者执行
- god-service 重开拆分(P1-4 已收口,需 architecture-boundary §6 新触发 + 立项);repository 抽象层;未立项的 controller path / snapshot 变更
- 数据清理自动化(SMS / 招新脱敏 = 手动 SOP,不上 cron);历史 handoff / 冻结评审稿不回改、不当当前事实
- 招新身份证号 v1 明文入库(2026-06-18 拍板留审计痕迹;加密 / 哈希归 C-8 议题)

## 4. 当前风险 / 债务(仅 open 项;全文与建议见 `ai-harness/NEXT_TASKS.md` + 各评审稿)

| 等级 | 债务 |
|---|---|
| P1 | 前端联调剩运维侧 P0-H 演练 + P0-I 排错 SOP(系统侧无动作) |
| P1 | 保险 PR3 未启用；旧 server=0 未验证，须 drain/同档；PR4 约束未落 |
| P1 | P1-22 专业队 gate 配置化;P1-23 isForeigner 历史列改名(对外已用 isNonMainlandDocument) |
| P2 | scoped 余面(§3);god-service 体量观察(codemap 实时口径);v0.44 接受项(#8 / #10 / #19 / #20#21 已收口 notifications-owned + 招新/入队，participation producer 待接);单测占比刻意低(e2e 为主);Mixed 存量 2;snapshot 用 diff 勿整读 |
| P3 | SMS / 招新脱敏 retention 手动 SOP(刻意);28003 同轮枚举面(v1 接受);首轮 review 接受 / 延后残项(F7/F8/F13/F18 等)在 NEXT_TASKS |

## 5. 开工门禁

`pnpm agent:preflight` 全过才开工(global 三硬判;lane 会话用 `--lane <lane名>`);fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`;D 档降速沿 process §4;拍板未到不动代码。

## 6. 读取协议

恒读:根 `AGENTS.md` → **本文件** → `process.md §2/§3`(权威见 AGENTS §0;Claude Code 加读 `CLAUDE.md`);其余 baseline / V2 红线 / ARCHITECTURE / 边界 / SOP / RBAC_MAP / archive 按触碰读取。

# SRVF API 当前状态入口

> **当前事实唯一权威源**。冲突以本文件为准;先报告,不擅自调和。
> Harness 2.0 指针版(T0 `archive/reviews/harness-2.0-t0-review.md`):只留当前事实与去向;历史见 CHANGELOG / `archive/handoff/`。§1 由 `docs:counts(:check)` 生成守护;全文 ≤4,500 字符;v1 快照 `archive/harness-v1/current-state.md`。

## 1. 当前版本状态

| 项 | 当前值 / 何处看 |
|---|---|
| 版本(六处一致) | **v0.60.0**(2026-07-22;tag/handoff #739=`a64efe5c`;GitHub Release Latest;`archive/handoff/v0.60.0.md`) |
| main HEAD / open PR / Unreleased | 实时看 `gh pr list`;发布锚点=`v0.60.0`/`a64efe5c`;release 时 Unreleased=0、fragment=0 |

<!-- counts:begin -->
<!-- 由 `pnpm docs:counts` 生成;禁止手改,`pnpm docs:counts:check` 守护 -->
| 计数项 | 值 |
|---|---|
| 模块 | 36 |
| Controller | 75 |
| Endpoint | 366 |
| Migration | 64 |
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
- **身份/会话终态**:手机/微信换绑消费 5 分钟 step-up proof 并锁后重验身份快照；logout 可由未过期 rotated ancestor 幂等撤销同 refresh family，其他 family/access 不动；详见 `security.md`
- **多实例当前事实**:10 个 throttler 共用 PG bucket；RBAC 与 SMS/WeChat/Storage/Realname settings 每次直读已提交 PostgreSQL；Effect 绑定单份配置快照，DB 异常 fail-closed，零进程正确性缓存
- **首发 Storage production**:空库须 migration/seed 后离线 bootstrap；production 强制 COS + enabled + 可解密凭证，四把 encryption key 冻结且当前不可直接轮换；真实 COS/fleet 仍须现场验收
- **贡献规则 ACTIVE 槽位**:未软删 ACTIVE 按 `activityTypeCode × attendanceRoleCode` 唯一；迁移、并发与漂移重复 pair 均 fail-closed
- **通知 durable outbox**:PG lease/fence、generation/recipient/同事务 RBAC 快照及 quota marker；provider 事务外 at-least-once。生产 migration/gate 未 deploy，切换须排空旧 API/worker/intents 且禁混档
- **Attachment storage Phase1**:Attachment namespace 已接 durable ledger；locator 固定、凭证 live-read；Content publish/confirm 根锁接线、Provider 事务外；未加 key FK，repo-wide closure 未完成；见 [`runbook`](ops/attachment-storage-consistency-rollout.md)。
- **保险 v3(v0.59.0，未 deploy)**:PR1–PR4 审核/CAS/evidence/gate及2+7 CHECK/owner unique/member-match/immutable 已交付，脏数 fail-fast 零修删；Admin队员360 overview（自购+团队安全投影+北京日汇总）已补，旧列表/审核/资格服务不变；启用须 drain 旧 server/事务且禁混档
- **敏感读审计**:`AuditLogEvent` 123，管理端普通/CSV/签名 URL 敏感读均 fail-closed 落库，extra 禁 PII/filter/key/URL
- **可信代理边界**:`APP_TRUSTED_PROXY_CIDRS` 仅收 `none` 或精确 canonical CIDR；production/smoke 缺失拒启。真实 ingress/edge/backend ACL 尚须现场验证，反代部署不得用 `none`

## 3. 暂不启动清单(AI 不得自行启动;评审解锁制;详见 harness-v1 快照 §3 与各评审稿)

- 新 schema / migration / Permission seed / Role 扩展;**第 3 个及以后 cron**(终态恰 2);LLM / vector / Redis / queue / 多租户
- 延后模型:events / event_participants / member_profiles 扩展敏感字段(沿 V2 红线 §4.3)
- scoped 可见性余面(users / content / notifications / audit-logs / attachment self-scope);Recruitment 与 team-join 维持中央流程 + 显式授权,不入职务派生
- 招新后续(退队 / 晋升 / 多部门归属 / 级别版本化 / 证书自动核验 gate / 部门级细分);保险 PR3 enable/deploy(drain 旧 server、禁混档)及理赔/保单图/App 展示;CMS 后续(已读回执 / 评论点赞 / 定时发布 / UV / 部门级权限)
- Slow-5(入队同意书 / 退队清理 N 值)与 Slow-7(uploadToken 黑名单等 storage 深化)— 等业务 / 真实反馈
- 运维侧真实通道(COS / 微信小程序 / 腾讯云 OCR / SMS)— `docs/ops/` SOP 就绪,维护者执行
- god-service 重开拆分(P1-4 已收口,需 architecture-boundary §6 新触发 + 立项);repository 抽象层;未立项的 controller path / snapshot 变更
- 数据清理自动化(SMS / 招新脱敏 = 手动 SOP,不上 cron);历史 handoff / 冻结评审稿不回改、不当当前事实
- 招新身份证号 v1 明文入库(2026-06-18 拍板留审计痕迹;加密 / 哈希归 C-8 议题)

## 4. 当前风险 / 债务(仅 open 项;全文与建议见 `ai-harness/NEXT_TASKS.md` + 各评审稿)

| 等级 | 债务 |
|---|---|
| P1 | 前端联调剩运维侧 P0-H 演练 + P0-I 排错 SOP(系统侧无动作) |
| P1 | 保险 gate 未启用、旧 server=0 未验证；真实 ingress/ACL、COS、worker/fleet、registry digest 未验，均为 production GO 硬门 |
| P1 | P1-22 专业队 gate 配置化;P1-23 isForeigner 历史列改名(对外已用 isNonMainlandDocument) |
| P2 | scoped 余面(§3);god-service 体量观察(codemap 实时口径);v0.44 接受项(#8 / #10 / #19 / #20#21 已收口 notifications-owned + 招新/入队，participation producer 待接);单测占比刻意低(e2e 为主);Mixed 存量 2;snapshot 用 diff 勿整读 |
| P3 | SMS / 招新脱敏 retention 手动 SOP(刻意);28003 同轮枚举面(v1 接受);首轮 review 接受 / 延后残项(F7/F8/F13/F18 等)在 NEXT_TASKS |

## 5. 开工门禁

`pnpm agent:preflight` 全过才开工(global 三硬判;lane 会话用 `--lane <lane名>`);fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`;D 档降速沿 process §4;拍板未到不动代码。

## 6. 读取协议

恒读:根 `AGENTS.md` → **本文件** → `process.md §2/§3`(权威见 AGENTS §0;Claude Code 加读 `CLAUDE.md`);其余 baseline / V2 红线 / ARCHITECTURE / 边界 / SOP / RBAC_MAP / archive 按触碰读取。

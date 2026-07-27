# SRVF API 当前状态入口

> **当前事实唯一权威源**。冲突以本文件为准;先报告,不擅自调和。
> Harness 2.0 指针版([T0](archive/reviews/harness-2.0-t0-review.md))；历史见 CHANGELOG/archive；§1自动守护；≤4,500字；[v1](archive/harness-v1/current-state.md)。

## 1. 当前版本状态

| 项 | 当前值 / 何处看 |
|---|---|
| 版本(六处一致) | **v0.61.0**(2026-07-23;tag/handoff #754=`6adb0330`;GitHub Release Latest;`archive/handoff/v0.61.0.md`) |
| main HEAD / open PR / Unreleased | 实时看 `gh pr list`;发布锚点=`v0.61.0`/`6adb0330`;release 时 Unreleased=0、fragment=0 |

<!-- counts:begin -->
<!-- 由 `pnpm docs:counts` 生成;禁止手改,`pnpm docs:counts:check` 守护 -->
| 计数项 | 值 |
|---|---|
| 模块 | 36 |
| Controller | 82 |
| Endpoint | 416 |
| Migration | 65 |
| BizCode | 278 |
| 权限码 | 213 |
| AuditLogEvent | 123 |
| 内建角色 | 15 |
| Cron | 2 |
<!-- counts:end -->

## 2. 能力清单(全指针)

- **接口与字段真相**:live `/api/docs-json` + contract snapshot + `EXPECTED_ROUTES`;**逐版本叙事**:[`CHANGELOG.md`](../CHANGELOG.md) + `archive/handoff/`
- **模块地图** `CODEMAP.md` · **权限地图** `ai-harness/RBAC_MAP.md`(各有 check 脚本守护)· **数据模型** `prisma/schema.prisma`
- **API surface**:5 canonical `/v1` 前缀,contract 锁定;见 `api-surface-policy.md`;❌新增 Mixed Controller(存量 2)❌App 返回 L3(content-* 签名 URL 例外)
- **身份/会话终态**:手机/微信换绑消费 5 分钟 step-up proof 并锁后重验身份快照；logout 可由未过期 rotated ancestor 幂等撤销同 refresh family，其他 family/access 不动；详见 `security.md`
- **多实例当前事实**:10 个 throttler 共用 PG bucket；RBAC 与 SMS/WeChat/Storage/Realname settings 每次直读已提交 PostgreSQL；Effect 绑定单份配置快照，DB 异常 fail-closed，零进程正确性缓存
- **Storage production**:空库 migration/seed→窄配置 bootstrap；固定COS location+可解密凭证，disabled 重启不放行 Effect，null/LOCAL/unknown 禁回退；密钥不可轮换，真实 COS/fleet 待验
- **贡献规则 ACTIVE 槽位**:未软删 ACTIVE 按 `activityTypeCode × attendanceRoleCode` 唯一；迁移、并发与漂移重复 pair 均 fail-closed
- **Outbox**:PG lease/fence/gen/recipient/RBAC/quota；全 producer 业务事务同写 intent，provider事务外至少一次；考勤 capped before/after、同 application+threshold 一次；生产未部署；切换排空 API/worker/intents、禁混跑。取消=displayName（memberNo）/匿名(禁 Member.id)；T active owner/F legacy publisher；键/目标不变
- **队员/报名真值**:正式=ACTIVE+grade level-1..7；报名 create/approve/递补锁后重验 live+ACTIVE，reopen 只回 pending
- **Attachment storage Phase1**:ledger接 Attachment；Content根锁、provider外；无key FK/非 repo-wide closure；见 [`runbook`](ops/attachment-storage-consistency-rollout.md)
- **保险 v3(v0.59.0，未 deploy)**:PR1–PR4 gate/约束/evidence 已交付，脏数 fail-fast；Admin 360 overview 已补；切换须 drain 且禁混档
- **活动责任(未发·本地)**:取消闭环=cancelled/null;生产迁移/配置/认领/部署未做,按 [`runbook`](ops/activity-responsibility-workflow-rollout.md) 审批验 digest
- **安全**:审计SA全量/持码非SA=self|USER；敏感读闭锁/extra禁PII；Decision 15.1=B/15.2=B(业务负责人最终确认:2026-07-27):C/N管理=SA|GLOBAL读码(ADMIN不直通)，部门=PRIMARY/SECONDARY/TEMPORARY/SUPPORT 有效任职且组织 ACTIVE 未删；RBAC任期单轨；ops-admin现任+常驻/同锁重读
- **可信代理边界**:`APP_TRUSTED_PROXY_CIDRS` 仅收 `none` 或精确 canonical CIDR；production/smoke 缺失拒启。真实 ingress/edge/backend ACL 尚须现场验证，反代部署不得用 `none`

## 3. 暂不启动清单(AI 不得自行启动;评审解锁制;详见 harness-v1 快照 §3 与各评审稿)

- 新 schema / migration / Permission seed / Role 扩展;**第 3 个及以后 cron**(终态恰 2);LLM / vector / Redis / queue / 多租户
- 延后模型:events / event_participants / member_profiles 扩展敏感字段(沿 V2 红线 §4.3)
- Authz scoped余面(users / content / notifications / audit-logs / attachment self-scope);Recruitment 与 team-join 维持中央流程 + 显式授权,不入职务派生
- 招新后续(退队 / 晋升 / 多部门归属 / 级别版本化 / 证书自动核验 gate / 部门级细分);保险 PR3 enable/deploy(drain 旧 server、禁混档)及理赔/保单图/App 展示;CMS 后续(已读回执 / 评论点赞 / 定时发布 / UV / 部门级权限)
- Slow-5(入队同意书 / 退队清理 N 值)与 Slow-7(uploadToken 黑名单等 storage 深化)— 等业务 / 真实反馈
- 运维侧真实通道(COS / 微信小程序 / 腾讯云 OCR / SMS)— `docs/ops/` SOP 就绪,维护者执行
- god-service 重开拆分(P1-4 已收口,需 architecture-boundary §6 新触发 + 立项);repository 抽象层;未立项的 controller path / snapshot 变更
- 数据清理自动化(SMS / 招新脱敏 = 手动 SOP,不上 cron);历史 handoff / 冻结评审稿不回改、不当当前事实
- 招新身份证号 v1 明文入库(2026-06-18 拍板留审计痕迹;加密 / 哈希归 C-8 议题)

## 4. 当前风险 / 债务(仅 open 项;全文与建议见 `ai-harness/NEXT_TASKS.md` + 各评审稿)

| 等级 | 债务 |
|---|---|
| P1 | 前端联调包剩运维侧 P0-H 演练 + P0-I 排错 SOP(系统侧无动作) |
| P1 | 保险 gate 未启用、旧 server=0 未验证；真实 ingress/ACL、COS、worker/fleet、registry digest 未验，均为 production GO 硬门 |
| P1 | P1-22 专业队 gate 配置化;P1-23 isForeigner 历史列改名(对外已用 isNonMainlandDocument) |
| P2 | scoped余面(§3);god-service体量;单测低(e2e主);Mixed=2;snapshot勿整读 |
| P3 | 考勤审核自由备注是否永久原文进入不可变审计，待独立隐私口径确认 |

## 5. 开工门禁

`pnpm agent:preflight` 全过才开工(global 三硬判;lane 会话用 `--lane <lane名>`);fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`;D 档降速沿 process §4;拍板未到不动代码。

## 6. 读取协议

恒读:根 `AGENTS.md` → **本文件** → `process.md §2/§3`(权威见 AGENTS §0;Claude Code 加读 `CLAUDE.md`);其余 baseline / V2 红线 / ARCHITECTURE / 边界 / SOP / RBAC_MAP / archive 按触碰读取。

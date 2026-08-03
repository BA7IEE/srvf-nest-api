# SRVF API 当前状态入口

> **人类决策与现实世界状态的唯一权威源**。冲突以本文件为准;先报告,不擅自调和。
> Harness 3.0 起本文件**只留不可从代码/GitHub 查到的东西**:现实运维态(§1)、能力指针(§2)、
> 不做清单(§3)、债务(§4)。版本号 / main HEAD / open PR / tag run 等**机器可查事实已删** ——
> 现场跑 `pnpm agent:preflight`。§1 计数块由 `pnpm docs:counts` 生成。

## 1. 现实世界状态(机器查不到,必须人维护)

| 项 | 当前值 |
|---|---|
| **发布边界** | 🟡 **v0.66.0 仍 NO-GO,但原因已变**:7 BLOCKER + 2 SHOULD-FIX **全部已修并合入**(#897 第一刀 / #898 第二刀,2026-08-03),**卡点改为「修复批次自身未经外部评审」**(SOP §1.6:修复批次是整个改造里最危险的代码)。⇒ **禁止部署、禁开 `loginEnabled` / `messageEnabled`,直到再投一轮评审通过**;届时另发新版本(v0.66.0 的 tag 与 Release **永久不代表可部署**,已标 pre-release)。上一版 v0.65.0 仍持 🟢 GO(外部评审对 `56ea8480..b6a2f9d8` 判 0 P0/P1);**生产部署仍是独立硬门**,migration 67/68/**69** 生产执行、首批标准初始化、前端适配、企微联调按各 runbook 单独审批;活动责任、保险、Storage、外部通道、基础设施硬门仍开放(§4 / runbook) |
| 版本 / 卫生 | 现场查:`pnpm agent:preflight` |
| 本版 footprint | 即下方计数块(生成物) |

<!-- counts:begin -->
<!-- 由 `pnpm docs:counts` 生成;禁止手改,`pnpm docs:counts:check` 守护 -->
| 计数项 | 值 |
|---|---|
| 模块 | 37 |
| Controller | 86 |
| Endpoint | 450 |
| Migration | 70 |
| BizCode | 314 |
| 权限码 | 227 |
| AuditLogEvent | 136 |
| 内建角色 | 15 |
| Cron | 2 |
<!-- counts:end -->

## 2. 能力清单(全指针)

- **接口与字段真相**:live `/api/docs-json` + contract snapshot + `EXPECTED_ROUTES`;**逐版本叙事**:[`CHANGELOG.md`](../CHANGELOG.md) + `archive/handoff/`
- **模块地图** `CODEMAP.md` · **权限地图** `ai-harness/RBAC_MAP.md`(各有 check 脚本守护)· **数据模型** `prisma/schema.prisma`
- **API surface**:5前缀;跨 surface Mixed=1(禁增);同 surface 双 Controller文件=3(非 Mixed);App 禁返 L3(content-* signed URL 例外);见 `api-surface-policy.md`
- **身份/会话终态**:手机/微信换绑消费 5 分钟 step-up proof 并锁后重验身份快照；logout 可由未过期 rotated ancestor 幂等撤销同 refresh family，其他 family/access 不动；详见 `security.md`
- **多实例**:10 throttler 共用 PG bucket；RBAC/外部设置逐请求直读已提交 PG；Effect 单配置快照，DB 异常 fail-closed，零进程正确性缓存
- **Storage production**:空库 migration/seed→窄 bootstrap；固定 COS location+可解密凭证；disabled 重启不放行 Effect，null/LOCAL/unknown 禁回退；密钥不可轮换，真实 COS/fleet 待验
- **贡献规则 ACTIVE 槽位**:未软删 ACTIVE 按 `activityTypeCode × attendanceRoleCode` 唯一；重复 pair fail-closed
- **Outbox**:PG lease/fence/gen/recipient/RBAC/quota；producer 事务同写 intent，provider 事务外至少一次；考勤 capped before/after 且同 application+threshold 一次；生产未部署，切换排空 API/worker/intents、禁混跑；取消通知禁 Member.id；键/目标不变
- **队员/报名真值**:正式=ACTIVE+grade level-1..7；报名 create/approve/递补锁后重验 live+ACTIVE，reopen 只回 pending
- **Attachment storage Phase1**:ledger接 Attachment；Content根锁、provider外；无key FK/非 repo-wide closure；见 [`runbook`](ops/attachment-storage-consistency-rollout.md)
- **保险 v3(v0.59.0，未 deploy)**:PR1–PR4 gate/约束/evidence 已交付，脏数 fail-fast；Admin 360 overview 已补；切换须 drain 且禁混档
- **活动责任(v0.62.0 已 release·未部署)**:取消闭环=cancelled/null;生产迁移/配置/认领/部署未做,按 [`runbook`](ops/activity-responsibility-workflow-rollout.md) 审批验 digest
- **安全**:审计SA全量/持码非SA仅self|USER；敏感读闭锁/extra禁PII；Decision 15.1=B/15.2=B(业务负责人最终确认:2026-07-27):C/N管理=SA|GLOBAL读码(ADMIN不直通)，部门=PRIMARY/SECONDARY/TEMPORARY/SUPPORT有效任职+组织ACTIVE；RBAC任期单轨，ops-admin现任常驻/同锁重读
- **可信代理边界**:`APP_TRUSTED_PROXY_CIDRS` 仅收 `none` 或精确 canonical CIDR；production/smoke 缺失拒启。真实 ingress/edge/backend ACL 尚须现场验证，反代部署不得用 `none`
- **证书标准库(PR-1→PR-6 + 评审 findings F1–F6)**:类别/等级唯一权威=`CertificateStandard`(实例侧零副本);认定规则由录入时锁定的 `recognitionPolicyId` 记住、换版**不追溯**;招新申报一证一行,发号只搬 APPROVED 且不重判。**需求 = 冻结稿 + [`t0-amendments`](archive/reviews/certificate-standard-library-t0-amendments.md) 两份合起来**(冲突以后者为准);三份 runbook 见 `ops/certificate-*`

## 3. 暂不启动清单(AI 不得自行启动;评审解锁制;详见 harness-v1 快照 §3 与各评审稿)

- 新 schema / migration / Permission seed / Role 扩展;**第 3 个及以后 cron**(终态恰 2);LLM / vector / Redis / queue / 多租户
- 延后模型:events / event_participants / member_profiles 扩展敏感字段(沿 V2 红线 §4.3)
- Authz scoped余面(users / content / notifications / audit-logs / attachment self-scope);Recruitment 与 team-join 维持中央流程 + 显式授权,不入职务派生
- 招新后续(退队 / 晋升 / 多部门归属 / 级别版本化 / 证书自动核验 gate / 部门细分);保险 PR3 enable/deploy(drain 旧 server、禁混档)及理赔/保单图/App 展示;CMS 后续(已读 / 评论点赞 / 定时发布 / UV / 部门权限)
- Slow-5(入队同意书 / 退队清理 N 值)与 Slow-7(uploadToken 黑名单等 storage 深化)— 等业务 / 真实反馈
- 运维侧真实通道(COS / 微信小程序 / 腾讯云 OCR / SMS)— `docs/ops/` SOP 就绪,维护者执行
- god-service 重开拆分(P1-4 已收口,需 architecture-boundary §6 新触发 + 立项);repository 抽象层;未立项的 controller path / snapshot 变更
- 数据清理自动化(SMS / 招新脱敏 = 手动 SOP,不上 cron);历史 handoff / 冻结评审稿不回改、不当当前事实
- 招新身份证号 v1 明文入库(2026-06-18 拍板留审计痕迹;加密 / 哈希归 C-8 议题)

## 4. 当前风险 / 债务(仅 open 项;全文与建议见 `ai-harness/NEXT_TASKS.md` + 各评审稿)

| 等级 | 债务 |
|---|---|
| **P0** | **v0.66.0 修复已合入但未经评审 —— 仍禁止部署、禁开两个开关**。7 BLOCKER + 2 SHOULD-FIX 全部已修(#897/#898,2026-08-03,逐条 red-first 成对证据在 `NEXT_TASKS` P1-27),**唯一剩余卡点 = 修复批次自身再投一轮外部评审**(SOP §1.6)。评审通过后方可发新版本并重开部署议题。⚠️ 一处**必须让下轮评审复核**的结论:评审给的「三事务死锁」经**双方独立实测**均**复现不出来** —— PG 行锁没有「FIFO 挡住相容请求」,后到的 `FOR SHARE` 只与**持有者**比相容性,直接越过排队中的 `FOR UPDATE`(lane 与主会话各测一次,读数一致)。锁序倒置属实且已修,但性质是**结构隐患**而非已兑现的死锁;该 PG 语义已做成可执行护栏,升级 PG 或改锁模式即红 |
| P1 | 前端联调包剩运维演练 + 排错 SOP(系统侧无动作) |
| P1 | 保险 gate 未启用、旧 server=0 未验证；真实 ingress/ACL、COS、worker/fleet、registry digest 未验，均为 production GO 硬门 |
| P1 | P1-22 gate 配置化;P1-23 isForeigner 改名;**P1-26 + 复审 M1–M6 全收口**(锁序/入队身份/终审批量化+RC+有界等待/棘轮注册表;另修一新查出的 40P01;新码 28211/40901;⚠️行为变更);S6 亦收口 |
| P2 | 多次顺序锁等待可撞 7s 总预算(评审登记不入批,触碰 member 线性化框架时处理) |
| **P1** | 企微 T5B 未上线(69 未 deploy / `messageEnabled` 未开 / FE 未适配 / T6 未立项);⚠️ **开关前须确认 fleet 只剩新 worker**,见 [`runbook`](ops/wecom-message-channel-rollout.md) |
| **P1** | **证书标准库未上线三件事**(P0 修完前都不要动):① PR-4b 第 67 migration 是**不可逆** contract(DROP 七列),production 未部署,须按 [`go-live`](ops/certificate-standard-library-go-live.md) 停写→备份验证→探针→deploy(AI 对 `migrate deploy` 恒无权);② #826–#834 + F1–F6 的对外契约破坏**已随 v0.65.0 发版(2026-08-02)**,前端适配仍未做,清单见 [`handoff/admin-web.md`](handoff/admin-web.md) §3.2 / §3.2.1;③ 首批标准与认定规则未建(刻意不 seed,认定口径归维护者拍板)—— 零标准时建证与审核一律拒、招新选择器恒空,按 [`初始化`](ops/certificate-standard-library-initialization.md) 执行,⚠️ `code` 打错不可挽回 |
| P2 | scoped余面;god-service;单测低;snapshot勿整读;nullable primitive→OpenAPI object(D档另立) |
| P3 | 考勤审核自由备注是否永久原文进入不可变审计，待独立隐私口径确认 |

## 5. 开工门禁

`pnpm agent:preflight` 全过才开工(global 三硬判;lane 会话用 `--lane <lane名>`);fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`;D 档降速沿 process §4;拍板未到不动代码。

## 6. 读取协议

恒读:根 `AGENTS.md` → **本文件** → `process.md §2/§3`(权威见 AGENTS §0;Claude Code 加读 `CLAUDE.md`);其余 baseline / V2 红线 / ARCHITECTURE / 边界 / SOP / RBAC_MAP / archive 按触碰读取。

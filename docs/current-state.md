# SRVF API 当前状态入口

> **人类决策与现实世界状态的唯一权威源**。冲突以本文件为准;先报告,不擅自调和。
> Harness 3.0 起本文件**只留不可从代码/GitHub 查到的东西**:现实运维态(§1)、能力指针(§2)、
> 不做清单(§3)、债务(§4)。版本号 / main HEAD / open PR / tag run 等**机器可查事实已删** ——
> 现场跑 `pnpm agent:preflight`。§1 计数块由 `pnpm docs:counts` 生成。

## 1. 现实世界状态(机器查不到,必须人维护)

| 项 | 当前值 |
|---|---|
| **发布边界** | 🟡 **代码可继续推进,生产开关仍 NO-GO**。修复批次(#897/#898)已过第二轮外部评审:**GO WITH CONDITIONS**,直接安全 BLOCKER **0**。⇒ 二进制可在**两个开关保持关闭**下继续收口;**开 `loginEnabled` / `messageEnabled` 前必须先关掉 §4 P0 剩余账**。v0.66.0 的 tag 与 Release **永久不代表可部署**(已标 pre-release);修完另发新版本。上一版 v0.65.0 仍持 🟢 GO(外部评审对 `56ea8480..b6a2f9d8` 判 0 P0/P1);**生产部署仍是独立硬门**,migration 67/68/**69** 生产执行、首批标准初始化、前端适配、企微联调按各 runbook 单独审批;活动责任、保险、Storage、外部通道、基础设施硬门仍开放(§4 / runbook) |
| **部署拓扑** | **前端与 API 同源**(2026-08-03 维护者拍板)。企业微信登录的浏览器 nonce Cookie(`__Host-` + HttpOnly + `SameSite=Lax`)据此成立,**无需** credentialed CORS,`enableCors` 保持不开 `credentials`。⚠️ **改成跨 origin 部署前禁开 `loginEnabled`** —— 同 site 跨 origin 需红区改 CORS + 前端四处 `credentials:'include'`;跨 site 则 Lax 直接挡掉 Cookie,B1 设计不适用,须重新评审 |
| 版本 / 卫生 | 现场查:`pnpm agent:preflight` |
| 本版 footprint | 即下方计数块(生成物) |

<!-- counts:begin -->
<!-- 由 `pnpm docs:counts` 生成;禁止手改,`pnpm docs:counts:check` 守护 -->
| 计数项 | 值 |
|---|---|
| 模块 | 37 |
| Controller | 100 |
| Endpoint | 523 |
| Migration | 88 |
| BizCode | 445 |
| 权限码 | 234 |
| AuditLogEvent | 138 |
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
- **活动（activity-business-overhaul-v1.1）**：87；永久头/保险 revision/参与投影、D83 资格 runtime 已落。D84 mode 以 v4 根锁/20152 闭合；D85–87 的冻结、资格 hash、lottery 承诺、回执和候选/岗位 guard 均零回填。第 4 批 runtime：邀请 accept 复用 canonical Form/资格/保险/身份/容量链；first_come 按场次即时 `pass|waitlisted`、不建 batch；rank/lottery 走 prepare/commit/void/get、D86 replay 和 20147 零写，同一根事务写容量/pointer/population/audit/outbox；递补仅原场次岗位。default 仅兼容旧 server/存量；资格配置/发布激活已落（draft typed RuleSet、V5 冻结激活）；活动到点 expiry 已落：复用既有两条 worker 与 `ActivityBatchJob` reconciliation、无新 cron，按最早 live session start 在 Activity 根事务内关闭 canonical pending/waitlisted 与 pending invitation，pass/容量不动，drift 20147 业务零写；整单取消/legacy writer lifecycle 也已收口：Activity 根事务关闭 canonical pending/waitlisted、追加 revision 并 CAS 投影，pass 的 active reservation 保留；legacy writer 只匹配无永久 identity 的兼容 header，漂移 20147 业务零写。
- **第 5 批（已合 main #1032，未部署）**：复用既有 QR credential、PunchEvent、EvidenceState/Seal 和服务段 revision 地基，接入负责人签发/作废/受保护 SVG 渲染、本人 QR 签到/签退/安全状态、责任人早退闭合/void/replace。所有 PunchEvent 写与整单取消按同一 Activity 根锁序串行；扫码 token 只作为请求输入、不进入读面。本批不含第 6 批工作人员代扫、代理、批量、导入或离线流程。
- **第 6 批（本分支，未部署，尚未整体交付）**：工作人员短时成员凭证、staff scan、proxy、可重放 bulk job、CSV import preview/execute 已接统一 PunchCommand、Activity 根锁、责任复验与 worker lease/fence；import execute 会重读固定附件并重算 digest/parserVersion/rowHash/previewHash，覆盖 ADV-014 的替换文件零 PunchEvent 闸。migration 88 已为 `OfflinePackage`、`OfflinePackageParticipant`、`OfflinePunchReviewItem` 与 PunchEvent 离线锚落字段/约束；但补充合同尚未定义 package issue/revoke/upload/review 的精确 HTTP wire，离线模型本身不构成可用写入链。

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
| **P0** | **两轮 findings 全关 + T6-1 replay 运维闭环已交付(#897/#898/#901/#903,2026-08-03);但生产开 `loginEnabled` / `messageEnabled` 仍判 NO-GO**。⏸ **剩余账全部卡在「域名未注册下来」** —— 真浏览器 Cookie 行为、双标签页并发、真实上游耗时分布**均未验**(归 T6),连同 §15.1 身份链 GO 的 OAuth 回跳全链,都要真实 HTTPS 域名;`webBaseUrl` 须为 HTTPS origin 且与前端同 origin(见 §1 部署拓扑;域名/证书规划时就按这个来)。之后还有 **T6 后一轮总评审**才谈开两个开关。⚠️ **SOP §1.6「修复批次自己再投一轮」对第三刀已拍板豁免** —— 并进 T6 之后的总评审,**豁免的是「单独投一轮」不是「免评审」**,那轮仍是开两个开关的硬门。第二轮评审原始结论(GO WITH CONDITIONS / 直接安全 BLOCKER 0 / B4 机制经双方实测正式撤回)、#901+#903 已关的三笔(代际递增 / 错注释 / replay 终态与运维闭环)、B3 有界缓解的拍板(另见 AGENTS §3 防枚举锁)、以及「上一版锁序护栏是假的」那条取证教训 —— 均已归档,逐条见 `NEXT_TASKS` P1-27 |
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

恒读:根 `AGENTS.md` → **本文件**(权威见 AGENTS §0;Claude Code 加读 `CLAUDE.md`);`process` / baseline / V2 红线 / ARCHITECTURE / 边界 / SOP / RBAC_MAP / archive 一律按触碰读取。

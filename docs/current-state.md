# SRVF API 当前状态入口

> **人类决策与现实世界状态的唯一权威源**。冲突以本文件为准;先报告,不擅自调和。
> Harness 3.0 起本文件**只留不可从代码/GitHub 查到的东西**:现实运维态(§1)、能力指针(§2)、
> 不做清单(§3)、债务(§4)。版本号 / main HEAD / open PR / tag run 等**机器可查事实已删** ——
> 现场跑 `pnpm agent:preflight`。§1 计数块由 `pnpm docs:counts` 生成。

## 1. 现实世界状态(机器查不到,必须人维护)

| 项 | 当前值 |
|---|---|
| **发布边界** | 🟡 **代码可继续推进,生产开关仍 NO-GO**。修复批次(#897/#898)已过第二轮外部评审:**GO WITH CONDITIONS**,直接安全 BLOCKER **0**。⇒ 二进制可在**两个开关保持关闭**下继续收口;**开 `loginEnabled` / `messageEnabled` 前必须先关掉 §4 P0 的四笔剩余账**。v0.66.0 的 tag 与 Release **永久不代表可部署**(已标 pre-release);修完另发新版本。上一版 v0.65.0 仍持 🟢 GO(外部评审对 `56ea8480..b6a2f9d8` 判 0 P0/P1);**生产部署仍是独立硬门**,migration 67/68/**69** 生产执行、首批标准初始化、前端适配、企微联调按各 runbook 单独审批;活动责任、保险、Storage、外部通道、基础设施硬门仍开放(§4 / runbook) |
| **部署拓扑** | **前端与 API 同源**(2026-08-03 维护者拍板)。企业微信登录的浏览器 nonce Cookie(`__Host-` + HttpOnly + `SameSite=Lax`)据此成立,**无需** credentialed CORS,`enableCors` 保持不开 `credentials`。⚠️ **改成跨 origin 部署前禁开 `loginEnabled`** —— 同 site 跨 origin 需红区改 CORS + 前端四处 `credentials:'include'`;跨 site 则 Lax 直接挡掉 Cookie,B1 设计不适用,须重新评审 |
| 版本 / 卫生 | 现场查:`pnpm agent:preflight` |
| 本版 footprint | 即下方计数块(生成物) |

<!-- counts:begin -->
<!-- 由 `pnpm docs:counts` 生成;禁止手改,`pnpm docs:counts:check` 守护 -->
| 计数项 | 值 |
|---|---|
| 模块 | 37 |
| Controller | 89 |
| Endpoint | 477 |
| Migration | 76 |
| BizCode | 409 |
| 权限码 | 234 |
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
- **活动业务改造(第 0+1 批 ✅ 2026-08-04;39 表 / 第 71-75 migration；第 2 批代码面 ✅；第 3 批①.5 已落第 76 migration +2 表、零端点；后续推进中)**:**需求 = v1.1 四份 + [`AMENDMENTS-v1.1.1`](archive/reviews/activity-business-overhaul-v1.1/AMENDMENTS-v1.1.1.md) 合起来,冲突以后者为准**(合同缺口累计 13 条已裁定/登记;⛔③离线两表未定义=第 6 批开工硬门,⏸①容量索引缺列归第 4 批,⏸⑤四处取值集待业务方,#11/#12/#13 待下版修订件);万人锁原型**时间预算通过**(P95 197.7ms);**万人统一生效恒串行**(2026-08-04 定,因两场并发越 12800 共享锁表保底而 `out of shared memory`;⚠️须带执行位不能只写成文字);bind 上限 32767 走 unnest;逐条见 `NEXT_TASKS` P1-28

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
| **P0** | **两轮 findings 全关 + T6-1 replay 运维闭环已交付(#897/#898/#901/#903,2026-08-03)。⏸ 剩两笔全部卡在「域名未注册下来」** —— 真浏览器 Cookie/双标签页、真实上游耗时分布,连同 §15.1 身份链 GO 的 OAuth 回跳全链,都要真实 HTTPS 域名;`webBaseUrl` 须为 HTTPS origin 且按已拍板的**同源部署**与前端同 origin(域名/证书规划时就按这个来)。之后还有 **T6 后一轮总评审**才谈开两个开关。⚠️ **SOP §1.6「修复批次自己再投一轮」对第三刀已拍板豁免** —— 并进 T6 之后的总评审,**豁免的是「单独投一轮」不是「免评审」**,那轮仍是开两个开关的硬门。第三刀交付中抓到的最重要一件事:**上一版锁序护栏是假的**(评审称"会让它红"的改动实测照绿),主会话已独立变异复核修复后真会咬。以下为第二轮原始结论 —— **GO WITH CONDITIONS(2026-08-03)** —— 直接安全 BLOCKER **0**(账号接管 / 跨 CorpID 错投 / 可兑现死锁 / SENT 误记 / P0-E 破坏均未再发现);上一轮 B1/B2/B5/B6/B7 判**真修好**,**B4 的机制被评审方正式撤回**(五步环在当前锁模式下不成立,双方独立实测 + 文档核读一致;锁序倒置属实且已修,性质是结构隐患,已有可执行护栏)。**但生产开 `loginEnabled` / `messageEnabled` 仍判 NO-GO**,剩余账:①pre-auth bind/rebind **漏了 `wecomIdentityVersion` 递增**(migration 注释声称两条绑定事务递增,实际只有一条 —— 不重开 ABA 接管,但"单调代际"这个不变量目前不成立);②B3 是**有界缓解**不是严格闭环(规则已按拍板收窄,见 AGENTS §3);③SF2 replay 只有服务层原语,**无终态检查、无 RBAC/Audit/入口**,归 T6;④真浏览器 Cookie 行为、双标签页并发、真实上游耗时分布**均未验**,归 T6。逐条见 `NEXT_TASKS` P1-27 |
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

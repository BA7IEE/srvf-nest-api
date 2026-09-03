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
| **真机部署** | 🟢 **第一阶段 PASS(2026-08-20 实测)**:PG 16.15 / 89 migration 全过 / 正式镜像起来 / `health/ready` 报 `db:up`。⚠️ **`APP_ENV=smoke` 非生产态**;归档 `first-release-bootstrap-sop.md` **已漂移勿用** —— 见 [`ops/server-deployment-runbook.md`](ops/server-deployment-runbook.md) |
| 版本 / 卫生 | 现场查:`pnpm agent:preflight` |
| 本版 footprint | 即下方计数块(生成物) |

<!-- counts:begin -->
<!-- 由 `pnpm docs:counts` 生成;禁止手改,`pnpm docs:counts:check` 守护 -->
| 计数项 | 值 |
|---|---|
| 模块 | 43 |
| Controller | 108 |
| Endpoint | 570 |
| Migration | 108 |
| BizCode | 489 |
| 权限码 | 246 |
| AuditLogEvent | 157 |
| 内建角色 | 15 |
| Cron | 2 |
<!-- counts:end -->

## 2. 能力清单

**逐条摘要已迁出到 [`ai-harness/CAPABILITIES.md`](ai-harness/CAPABILITIES.md)**(2026-08-20;18 条逐字搬运,无删减)。
⚠️ 新增能力条目**写那份、不写本文** —— 那份不在恒读层,写多不付预算;本节只留常用指针与下面那条被钉住的。

- **接口与字段真相**:live `/api/docs-json` + contract snapshot + `EXPECTED_ROUTES`
- **模块地图** `CODEMAP.md` · **权限地图** `ai-harness/RBAC_MAP.md` · **数据模型** `prisma/schema.prisma`
- **逐版本叙事**:[`CHANGELOG.md`](../CHANGELOG.md) + `archive/handoff/`
- **安全**:审计SA全量/持码非SA仅self|USER；敏感读闭锁/extra禁PII；Decision 15.1=B/15.2=B(业务负责人最终确认:2026-07-27):C/N管理=SA|GLOBAL读码(ADMIN不直通)，部门=PRIMARY/SECONDARY/TEMPORARY/SUPPORT有效任职+组织ACTIVE；RBAC任期单轨，ops-admin现任常驻/同锁重读
  <br>🔒 **此条不得迁出** —— 被 `notification-canonical-docs.spec.ts` 钉成代码级契约(三处互证);搬走即打红 unit(历史事故 INC-16)

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
- **开启 `ACTIVITY_V11_WORKFLOW_ENABLED`**(活动 v1.1 单一 cutover gate,合同 §16.2;闸位代码
  2026-08-19 已交付,**默认关闭**)。开闸=**一次不可分割的业务真相切换**:新结算真相链
  (打卡 / 服务段 / 封场 / 结算 / 账本 / 关账 / 更正)开始受理,旧 `ActivityCheckIn` /
  `AttendanceSheet` 写入口**同时永久关闭**(410),统计读面同时改从已 committed 账本取数。
  ⚠️ **AI 不得自行开启**;开闸前先跑 `pnpm cutover:check` —— 合同 §16.1
  十条的机器可核清单(2026-08-19 交付,**不接 CI**,是维护者开闸前手动跑的前置)。它按
  A 机器可判 / B 机器可查·人判定 / C 只能人判三分型逐条报结论:A 类不过即非零退出,
  B/C 类恒标「待维护者确认」**不渲染成绿勾**。**2026-08-19 首次读数**(历史快照,勿当现值):
  A 类 9/11 过,⑦(worker runbook 零份)与 ⑨(验收 42 条仍 `it.todo`)未过。再按 §16.3 的顺序:
  先停旧写 → 部署 migration 与全套同版本应用 → 再开闸 → 跑一遍全链路 smoke。
  ⚠️ 「终审改为提交 `LedgerPostingBatch`」那座桥**仍未实施** —— 未搭之前开闸,
  历史 approved 考勤不会出现在账本读面里(见 `NEXT_TASKS` 第 7 批②)。
  ✅ **该硬前置已解除(2026-08-21,第六轮评审 A-2 + B-03 修复刀已合)**:业务复合锚点
  已闭合 —— 21 个持有 ≥2 锚点的模型上,**22 处**同链外键升级为复合外键,并落地 **12 条**
  被引用侧 unique 锚点。数据库现在证明这些 ID 属于**同一条业务主链**:两条合法活动的数据
  交叉组合插入实测得到 `23503`,非空库上的存量脏组合会让 migration **fail-closed 整体回滚**
  (实测残余约束数与基线逐一相等,零部分应用)。
  刻意**不**闭合的 4 处例外全部落在 CapacityReservation 族(第 78 migration 已拍板两锚点
  仅 active+activity_person 行必填),逐条写明理由并由判据守护「豁免过期即红」。
  「多锚点表用单列外键」已做成机器闸(`composite-anchor-closure.criteria.spec.ts`)——
  扫描面从 `schema.prisma` 动态解析,**新建的第五张同形状表自动纳管**。
  ⚠️ **只解除这一条**:⑨(验收编号仍有 `it.todo`)与「终审改为提交 `LedgerPostingBatch`」那座桥
  **仍未实施**,开闸仍须走 §16.1 清单与 §16.3 顺序。
  ✅ **2026-08-28 更新:那座桥已实施** —— 「存量考勤账本化」转换刀合入
  ([#1211](https://github.com/BA7IEE/srvf-nest-api/pull/1211),A 案;同日 D1 悬案定案
  「记录条数=账本日行数」、第 6 批代码面收口宣告):只读维护窗内一次性把存量 approved
  考勤合成 v1.1 事实链并提交真账本批次(CLI+SOP 归维护者,
  `docs/ops/legacy-attendance-ledger-conversion.md`)。
  **开闸前的仓内硬前置只剩 9a**(验收 todo 已 9→5:AC-047 执行位(#1213)、AC-009/AC-067
  永久豁免、AC-017 搁置、AC-010 改期联动(作废旧二维码重签)均 2026-08-28 落地;
  余 AC-013/AC-020/AC-025 大刀「上线后按诉求立项」+ ADV-010 卡 P2-21)与
  §16.3 顺序本身;上面两段 ⚠️ 自此为历史记录。
  ⭐ **⑦ 已不在其列(2026-08-24 订正)**:worker 运维 runbook 早在 `#1088`(`a1b25764`,2026-08-19)
  就合了(`docs/ops/activity-batch-worker-runbook.md`),本行此前一直把它当未做在写。
**2026-08-25 实跑读数:A 类 10/11 过,唯一硬红仍是 9a** —— 验收 `84 通 / 19 待 / 0 败 / 103 总`
(2026-08-24 分拣刀把 32 条待办判成 A 14 / B 4 / C 14 并接通 2 条 ⇒ 30 待;
2026-08-25 实施刀写完 A 档 11 条、退回 1 条 AC-063 到 B 档 ⇒ 19 待。逐条依据见 `NEXT_TASKS` P1-28;
**9a 仍红是预期的** —— 剩 B 档 5 + C 档 14,那些卡的是能力 / 规模方案,不是缺用例)。
⭐ **2026-08-27 实跑读数(docs 对齐刀,`743abb5b`):A 类 12/13 过,唯一硬红仍是 9a** ——
验收 `103 通 / 9 待 / 0 败 / 112 总`;B/C 签字已满 10 条,**①–⑧ 整条收口**,⑨ 卡 9a、
⑩ 待 10a/10b(部署侧产物 + 演练记录,机器无从判)。19 → 9 的链:AC-063 真竞态接通(#1185)、
AC-064/066/ADV-022 接通(#1194)、万人档 4 条转永久豁免(#1196);**剩 9 条全部 C 档能力缺口**
(AC-009/010/013/017/020/025/047/067 + ADV-010,ADV-010 卡 P2-21 分账本合并)。
  ⚠️ 账本写入口的 **service 层**跨锚点校验(`ledger-preparation.service.ts` 实测零处)
  本刀**未补** —— 数据库闭合后它是纵深冗余而非唯一防线,是否补另行判断。

## 4. 当前风险 / 债务(仅 open 项;全文与建议见 `ai-harness/NEXT_TASKS.md` + 各评审稿)

| 等级 | 债务 |
|---|---|
| **P0** | **两轮 findings 全关 + T6-1 replay 运维闭环已交付(#897/#898/#901/#903,2026-08-03);但生产开 `loginEnabled` / `messageEnabled` 仍判 NO-GO**。⏸ **剩余账卡在「备案」** —— 域名**已注册**(2026-08-19 维护者报),队长身份证换证**已完成**(2026-08-27 维护者报),现等队长有空配合推进备案流程。备案落地前,以下仍无法验证:真浏览器 Cookie 行为、双标签页并发、真实上游耗时分布**均未验**(归 T6),连同 §15.1 身份链 GO 的 OAuth 回跳全链,都要真实 HTTPS 域名;`webBaseUrl` 须为 HTTPS origin 且与前端同 origin(见 §1 部署拓扑;域名/证书规划时就按这个来)。之后还有 **T6 后一轮总评审**才谈开两个开关。⚠️ **SOP §1.6「修复批次自己再投一轮」对第三刀已拍板豁免** —— 并进 T6 之后的总评审,**豁免的是「单独投一轮」不是「免评审」**,那轮仍是开两个开关的硬门。第二轮评审原始结论(GO WITH CONDITIONS / 直接安全 BLOCKER 0 / B4 机制经双方实测正式撤回)、#901+#903 已关的三笔(代际递增 / 错注释 / replay 终态与运维闭环)、B3 有界缓解的拍板(另见 AGENTS §3 防枚举锁)、以及「上一版锁序护栏是假的」那条取证教训 —— 均已归档,逐条见 `NEXT_TASKS` P1-27 |
| P1 | 前端联调包剩运维演练 + 排错 SOP(系统侧无动作) |
| P1 | 保险 gate 未启用、旧 server=0 未验证；真实 ingress/ACL、worker/fleet、registry digest 未验，均为 production GO 硬门 |
| P1 | P1-22 gate 配置化;P1-23 isForeigner 改名;**P1-26 + 复审 M1–M6 全收口**(锁序/入队身份/终审批量化+RC+有界等待/棘轮注册表;另修一新查出的 40P01;新码 28211/40901;⚠️行为变更);S6 亦收口 |
| P2 | 多次顺序锁等待可撞 7s 总预算(评审登记不入批,触碰 member 线性化框架时处理) |
| **P1** | 企微 T5B 未上线(69 未 deploy / `messageEnabled` 未开 / FE 未适配 / T6 未立项);⚠️ **开关前须确认 fleet 只剩新 worker**,见 [`runbook`](ops/wecom-message-channel-rollout.md) |
| **P1** | **证书标准库未上线三件事**(P0 修完前都不要动):① PR-4b 第 67 migration 是**不可逆** contract(DROP 七列),production 未部署,须按 [`go-live`](ops/certificate-standard-library-go-live.md) 停写→备份验证→探针→deploy(AI 对 `migrate deploy` 恒无权);② #826–#834 + F1–F6 的对外契约破坏**已随 v0.65.0 发版(2026-08-02)**,前端适配仍未做,清单见 [`handoff/admin-web.md`](handoff/admin-web.md) §3.2 / §3.2.1;③ 首批标准**只内置法规定死内容的那批**(业余无线电 A/B/C,2026-08-25 拍板;判据「这个证书的内容队里有得选吗?有 ⇒ 人工建,没有 ⇒ 可内置」)—— **队内认定的标准仍未建**,招新只收 `first_aid` / `bsafe` 故其选择器仍恒空,按 [`初始化`](ops/certificate-standard-library-initialization.md) 执行,⚠️ `code` 打错不可挽回 |
| P2 | scoped余面;god-service;单测低;snapshot勿整读;nullable primitive→OpenAPI object(D档另立) |
| P3 | 考勤审核自由备注是否永久原文进入不可变审计，待独立隐私口径确认 |

## 5. 开工门禁

`pnpm agent:preflight` 全过才开工(global 三硬判;lane 会话用 `--lane <lane名>`);fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`;D 档降速沿 process §4;拍板未到不动代码。

## 6. 读取协议

恒读:根 `AGENTS.md` → **本文件**(权威见 AGENTS §0;Claude Code 加读 `CLAUDE.md`);`process` / baseline / V2 红线 / ARCHITECTURE / 边界 / SOP / RBAC_MAP / archive 一律按触碰读取。

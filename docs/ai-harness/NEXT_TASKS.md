# NEXT_TASKS — 后续任务拆解(P0 / P1 / P2)

> **性质**:任务提案清单(2026-06-10 Review 产出)。**每项任务仍须按 [`process.md`](../process.md) 单独立项,AI 不自动启动**(process §7)。状态列可由 AI 在 docs PR 中更新。
> P0 = 不解决阻碍 AI Harness 落地;P1 = 影响长期维护;P2 = 可优化。

---

## P0(harness 落地链路)

(P0-1 / P0-2 / P0-3 均已完成,见[已收口项归档](../archive/ai-harness/next-tasks-completed.md)。)

## P1(长期维护)

(P1-3〔Slow-4〕/ P1-7〔SMS 消费者三项〕/ P1-8〔微信小程序登录〕均已完成,P1-4 已于 2026-06-10 调研收口 —— 均见[已收口项归档](../archive/ai-harness/next-tasks-completed.md)。)

### Content / Notification 可见性业务 Decision — **✅ 已最终拍板(2026-07-27)**
- **业务负责人最终确认日期：2026-07-27**。
- **Decision 15.1=B**：management 只认 SUPER_ADMIN 或明确持有对应 GLOBAL `content.read.record` / `notification.read.record` 的账号；Role.ADMIN 不自动放行。
- **Decision 15.2=B**：department 认当前有效 PRIMARY / SECONDARY / TEMPORARY / SUPPORT Membership，且 Organization 必须 ACTIVE、未软删；适用于 App Content、App Notification、SMS/WeChat 根受众及微信实际 Effect 前最终收件人复核。
- **非阻断待评审**：考勤审核自由备注是否永久原文进入不可变审计，待独立隐私口径确认；本项不是已确认漏洞，不在当前 hardening Goal 修改。

> ⚠️ 本条虽已拍板收口,**刻意留在活跃区**:`notification-canonical-docs.spec.ts` 把它钉成契约
> (与 `current-state.md` / `notifications/CLAUDE.md` 三处互证)。它是**当前生效的业务决议**,不是完成的任务。

### P1-10 D-INSURANCE v3 顺序四 PR 收口 — **PR1–PR4 代码均已交付；PR3 runtime enable 与 PR4 migration deploy 待后续运维窗口**
- **PR1 expand-only(已交付)**:`MemberInsurance` pending/v0/nullable reviewer + nullable 双 source/双 owner Evidence RESTRICT FK 骨架 + `TeamJoinCycle.requiresInsurance=false`；约束刻意留 PR4。
- **PR2 compatibility window(已交付)**:唯一 review route + optional App expectedVersion + telemetry；consumer 保持旧语义、0 evidence。
- **PR3 enforcement cutover(本次代码交付，不含部署)**:`INSURANCE_ENFORCEMENT_ENABLED` 单 gate 同时切 App required CAS、verified-only、Activity/Team Join 最小 evidence 与 final join 保险闸；production missing/empty/invalid fail-fast，显式 false 可启动。维护者于 2026-07-19 逐字确认“旧客户端都没上线，放心操作执行”，仅解除客户端兼容等待，**不构成旧 server=0 运行证据**；真正 enable 前仍须 drain 旧 server 且禁止 true/false fleet 混跑。
- **PR4 DB closeout(代码已交付，不含部署)**:migration 已实现完整性扫描、exactly-one/kind/interval/review snapshot、全局单 owner、同 member 与 immutable trigger；任一脏数即失败且零修数/删数。生产约束尚未生效，deploy 前仍须沿 PR3 SOP 确认旧 server=0、排空旧事务并禁止混合 gate。
- Admin 队员 360 的团队保险覆盖安全投影已交付；小程序/App 端保险展示仍不在本任务范围。理赔、到期主动提醒(新增 cron 须 D 档)与保单图 attachments 接线也仍须真实诉求触发后另立项。

### P1-14 GAP-005 统一通知模块后续(S1–S5 已发,余项 ⏸ 诉求触发再立项)
- **真·全员短信批处理异步**(S5 末位切片经 D-Outbox 收口):admin `confirmed=true` 现先持久化逐收件人 generation intent，再由 HTTP 做首轮、独立 worker 续跑失败项；跨进程 active-slot 防并发重复，真实 `NotificationDelivery SENT` 才是永久去重事实。实现未新增 cron/Redis/queue/事件总线；若未来受众规模需要分片、吞吐控制或专用队列，仍须另立 D 档，不在 durable outbox 基础能力中暗增。
- **报名前 openid 非会员推送路**(S3/S5 均标注另立项):招新报名前 5 触发(报名受理/转人工/门槛/评定/公示)申请人**非队员**,站内/微信/短信(均需 member)够不着 → 现维持**查询进度 pull**;若需主动推送给未入队报名人(微信 openid 锚点),单独立项。
- **短信 admin 投递查询端点**(可选):当前 `NotificationDelivery`(channel=sms)+ `sms_send_logs` 落库,admin 查投递成败靠 `sms-send-logs` 列表(已有)/ 运维看库;若需「按通知查短信投递明细」admin 端点,诉求触发再加(沿 S2 微信 delivery 无专属查询端点的口径)。

(P1-11 招新一期〔招新前段〕+ P1-12 招新二期〔招新后段〕+ **P1-13 招新三期〔入队:志愿者→队员〕** 均已完成,见[已收口项归档](../archive/ai-harness/next-tasks-completed.md);**招新业务域三段闭环**:报名前段〔临时编号〕→ 转正后段〔建 User+Member,无部门无级别〕→ 入队〔10 项考核 + 综合评估 → 设部门 + 级别 level-1〕。**P1-12 当时拍板的「admin 手工建档 = v1 边界外」已由 v0.41.0 招新可用性收口还账关闭**:F2 admin 改资料〔PATCH,R1 白名单〕+ F3 单人手动建档〔promote-single,放行外籍+锚点择优〕——批量发号全部 skip 类自此有出路;冻结评审稿 [`recruitment-usability-closeout-review.md`](../archive/reviews/recruitment-usability-closeout-review.md)。)

### P1-20 app 侧证书图暴露给队员本人 — **⏸ 诉求触发再立项**
- **背景**:v0.41.0 招新可用性收口 F7(评审稿 §2.9 R6)落地了证书图长期档案:申请人公开上传(`certificateImages`)→ promote 建 pending `Certificate` + 图 key 搬 `Certificate.imageKeys Json`。**app 侧 `GET app/v1/my/certificates` 的 `AppMyCertificateDto` v1 刻意不含 imageKeys/图 URL**(v1 契约不动,goal 拍板另议)。
- **候选方案**:若队员需要在小程序回看本人证书图,镜像 admin 取图口径加 `GET app/v1/my/certificates/:id/image-urls`(self-scope 锁本人 memberId;短 TTL signed-URL;L3 不入日志)——须先过 App surface 语义评审(api-surface-policy §9)。
- **触发条件**:小程序前端出现真实页面诉求时单独立项(C 档;0 schema——列已在)。

### P1-15 存量队员批量导入工具 — **⏸ 不自动启动,诉求触发再立项**
- **背景**:终态 scoped-authz 序列(GAP-007,PR1–PR12 + 摘码微刀,已全量落地)的 PR11 只建了 `announcement-import`(preview/execute 两段式,导组织/任职/分管),**不建 `Member`**——双锚铁律(R7)要求执行前每条行都能按 `memberNo` 命中已存在的队员。当前给全新队员群体(如整队历史存量数据)批量建 `Member` 记录尚无专用端点,只能逐个 `POST admin/v1/members` 或运维 `psql` 直灌([`ops/scoped-authz-go-live-checklist.md` §3`](../ops/scoped-authz-go-live-checklist.md) 已登记此缺口)。
- **候选方案**:镜像 `announcement-import` 的 preview/execute 两段式设计(零写入诊断 + 幂等落库 + 逐行 `ok`/`blocked`/`already-exists` 结果),但目标表是 `Member`(可能含基础档案字段)而非组织/任职/分管;**同样受 R13 约束**——测试与文档示例一律用假数据,真实姓名/证件信息不进本仓库任何位置。
- **触发条件**:出现批量导入存量队员(> 逐个可接受量级)的真实诉求时单独立项评审(D 档,涉及 schema 是否需要新增批量端点、字段集范围、与 `POST admin/v1/members` 单条端点的关系)。
- **与 P1-18(队员账号闭环,✅ 已完成)关系**:P1-15 解决"批量把队员**档案**（`Member`)灌进来";P1-18 解决"给**已存在**队员开**登录账号**(`User`)"。两者正交——P1-15 若落地,批量导入出的 `Member` 仍可用 P1-18 已交付的 `POST admin/v1/members/accounts/bulk-grant` 批量开号能力。

### P1-22 入队专业队类型 / gate 定义配置化 — **⏸ 诉求触发再立项**
- **背景**(招新/入队十三项收口问题⑨):`PROFESSIONAL_GATE_CODES` / `GATE_VALIDITY` / `PROFESSIONAL_TEAM_GATE_BY_NODE_TYPE` 当前在 `team-join.constants.ts` 硬编码 4 种专业队及全部 gate 有效期;新增专业队、改 gate 或调整有效期都必须发后端版本。P⑦ 已拍板本 goal 只挂账,不顺手扩动态配置面。
- **候选方案**:D 档新增 gate 定义表(建议字段:`code`/`professional`/`validityType`/`validityYears`/`extendable`/`status`) + 专业队 nodeType→gate 映射表(建议字段:`nodeTypeCode`/`gateCode`/`status`),由 Query/Policy 层一次加载后供标 gate、进度派生与一键入队重校验共用;须同步设计 admin 配置端点、RBAC、audit、缓存失效与存量常量迁移/回滚方案,禁止只把其中一个消费者改成读表造成双轨。
- **触发条件**:业务提出新增第 5 种专业队、运营需自行调整 gate/有效期,或 node_type 约定开始跨版本频繁变化时单独立项。

### P1-23 `recruitment_applications.isForeigner` 历史 DB 列改名 — **⏸ 数据治理诉求触发再立项**
- **背景**(招新/入队十三项收口刀C2 遗留):API DTO/CSV/stats/audit 对外已统一改为 `isNonMainlandDocument` / `is_non_mainland_document`,含义锁定为「非大陆证件,不代表国籍」;仅 Prisma/DB 历史列仍名 `isForeigner`。直接 rename 属 D 档破坏性 schema 变更,本 goal 明确禁区,故不改列名。
- **候选方案**:先盘点所有 SQL/报表/导出/备份消费者,再做 Prisma field 映射过渡或单次 rename + 存量验证;同步 current-state/CODEMAP/留存 SOP 与回滚 SQL。不得先新增第二列长期双写。
- **触发条件**:外部 BI/报表开始直读该列,或合规审查要求物理字段名也去除“外籍”误述时单独立项。

### P2-6 #399 review P2 修复残余(4 项;**均无当前运行时危害,诉求/接线时处理**) — 2026-06-20 收口登记
> #399 全仓 review P2 六项已修(#400-#404,见 [`current-state §4`](../current-state.md) + 冻结报告顶部 ✅);以下为修复时显式接受、留待后续的残余:
- **F2 残余:attachment key owner-绑定**(P3)— F2 现把 create() 的 key 约束到 `attachments/<envPrefix>/` 派生格式正则,关闭「任意 COS 路径」面;残余 = 命名空间内、已知**完整 96-bit 随机段** key 仍可签(已知即已有权)。彻底闭合 = key↔owner 派生绑定 / 弃用模式 A 全量走模式 B(upload-url + HMAC token)。**COS 休眠,运维接通前非紧急**。
- **F1 关联:attachment.`*.other` 接 enforcement 时复核保留集**(P3)— **8 条**(review #484 G26 true-up:实测非「11」)`attachment.*.other` 权限码(member/certificate 两 owner × upload/view/update/delete 四动作);**PR7 起 `group-manager` 已绑其中 4 条**(`upload`/`view` × member/certificate,设计内决定非疏漏——绑了也不授能力因全 8 条均无 enforcement,scoping 对);余 4 条(`update`/`delete` × member/certificate)当前 seed 不绑任何 meta 角色。**将来 attachment.other 接线启用 enforcement 时**,需复核是否纳入 F1 `RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES`(`seed-rbac.e2e` 漂移哨兵 + 常量 completeness 测试会抓不一致)。
- **F5/F6 关联:dev-only 依赖 CVE**(P3)— ~~`fast-uri`(`@nestjs/cli>…>ajv`,path-traversal/host-confusion high)~~ **✅ 已随 review #484 G25 批的全局 `fast-uri` override 一并解决(2026-07-03;见下)**;~~`@types/supertest>…>form-data`(CRLF high)~~ **✅ 已修复**:当前 `@types/supertest@7.2.0 → @types/superagent@8.1.9 → form-data@4.0.5`,`pnpm why form-data` 可复核该 dev 链已解析到修复版。**+ `cos>fast-xml-parser` <5.7.0 moderate**(XMLBuilder 注入;需 4→5 **breaking major**,cos 仅解析腾讯云响应、不以不可信输入构造 XML,低危,本批拍板范围外,现状不变)。
- **F18(报告 §3):CI `pnpm audit` 门禁** ✅(2026-07-23)— 已有独立 `Production dependency audit` workflow，支持最终 SHA 手工 dispatch 与 `v*` tag 自动触发，固定执行 `pnpm audit:production` 并以 high/critical 为硬门；#750 移除无依赖安装场景下的无效 pnpm cache，确保 audit 成功后 post-job 仍整体绿色。moderate/low 继续逐条登记，不以 exit code 静默接受。
- **review #484 G10/G25:生产可达依赖 CVE overrides 收口** ✅(本 PR,2026-07-03;`pnpm audit -P` **9 → 3**)——**G10(已修)**:`qs`(经 `@nestjs/platform-express>express`,DoS)+ `js-yaml`(经 `@nestjs/swagger`,DoS)两条生产可达 moderate CVE 已通过 `pnpm.overrides` 收口(`qs` 全局 `^6.15.2` 同时覆盖 COS `request>qs` 路径;`js-yaml` 因树上另有不相关 `3.14.2` 消费者,改用 `@nestjs/swagger>js-yaml` scoped `^4.2.0` 避免误伤)。**G25(best-effort,部分收口)**:COS `request` 传递链——`tough-cookie`(`request>tough-cookie` `^4.1.3`)/ `ajv`(`conf>ajv` `^8.18.0`)/ `uuid`(仅 `tencentcloud-sdk-nodejs-common>uuid` `^11.1.1` 路径)三项已 override 收口。**残留(逐条注明,均非本批可解)**:① `request` 本体(SSRF,`.>cos-nodejs-sdk-v5>request`)——advisory 明示 patched 版本 `<0.0.0`(即无解),upstream 已弃用永不再发版,**等 COS SDK 换传输层**(或弃用 `cos-nodejs-sdk-v5`)才可能消除;② `uuid` 经 `request>uuid` 路径——**曾尝试 override 到 `^11.1.1` 但导致 2 个 unit 测试套件(`attachments.service.spec.ts` / `storage-provider.router.spec.ts`)整体加载失败**,根因是 `request` 自身冻结代码 `lib/auth.js` 用旧式深路径 `require('uuid/v4')`(uuid 7.x 起废弃该子路径导出),与 CVE patched 下限 `>=11.1.1` **结构性不可兼容**(无论选哪个 ≥11.1.1 版本都会炸),已撤销该条 override,不硬上;③ `fast-xml-parser`(`.>cos-nodejs-sdk-v5>fast-xml-parser`)——现状不变,见上 F5/F6 行(4→5 major,本批范围外)。**副作用(已处理)**:`ajv` override 到 8.x 后,ajv 自身传递依赖 `fast-uri` 引入 2 条**更高severity**(high)的新 CVE(path-traversal + host-confusion);已追加全局 `fast-uri: ^3.1.2` override 一并解决(全树仅此一个 fast-uri 消费来源 `ajv`,零冲突),此举同时消除了上面 F5/F6 登记的 dev-only fast-uri 项。回归自证:build/lint/typecheck 0 错误,unit 71 suites/2140 全绿,contract 525 全绿(snapshot 零 diff),full e2e 123 suites/2438 全绿。

- **v0.61.0 `fast-uri` 安全补丁** ✅(2026-07-23,#749)— 上述 `^3.1.2` 是 2026-07-03 初次 override 的历史值；当前已提升为 `^3.1.4`，production graph 唯一解析到 `fast-uri@3.1.4`，消除 `cos-nodejs-sdk-v5 > conf > ajv` 链的 `GHSA-v2hh-gcrm-f6hx` High。COS SDK/conf/ajv 未升级；审计仍仅有与 v0.60.0 完全相同的 3 个 COS 传递链 moderate。

### P2-7 #399 review P3 处理残余(接受+登记 2 项;**均无当前运行时危害**) — 2026-06-20 收口登记
> #399 §3 的 13 项 P3:**9 项已修**(#409-#413,见归档区 + 冻结报告 ✅ P3 处理状态)、**1 项已完成**(F18 CI audit gate,见上 P2-6 末项)、**1 项已完成移入已完成项归档区**(F13,见文末;review #484 G27),以下 2 项 R0 triage 复核后**接受+登记**:
- **F7 付费核验 cost-DoS**(P3)— 同 openid 可用不同伪造身份证号无限提交、每条直达付费实名核验(去重键 `(cycleId,idCardNumber)` 无 per-openid 上限),与已接受的 28003 枚举面**同源**(current-state §4)。**真实腾讯云实名核验休眠(DevStub 免费)→ 今日零成本**;接通才激活(类 F2/COS 接通前非紧急)。彻底修 = per-openid 配额(改报名去重语义,属产品决策)→ **真实通道接通触发再评**。
- **F8 promote 写字典码契约**(P3)— promote 写 `MemberProfile.genderCode`/`documentTypeCode` 不经 canonical 字典校验。**R0 复核降级**:`isForeignDocument` 令非 `mainland_id` 即 foreign(不进一键发号),故 promote 只写固定 canonical 码 `mainland_id`/`male`/`female`(身份证派生 / 非用户可控,**无 F3 式注入污染**),且 profile 码当前无字典校验消费点 → **零运行时危害**。真修 = 保证 prod 字典 seed 含 `male`/`female`/`mainland_id` item code(**seed/ops 不变量**;加 promote 断言反会把潜在不一致硬化成 promote 失败、且 demo seed `demo-*` 会打挂既有 e2e)→ seed/字典治理时一并保障。

## 已收口项

全部移至 [`docs/archive/ai-harness/next-tasks-completed.md`](../archive/ai-harness/next-tasks-completed.md)(冻结,不再增长)。

**本文件只留还没做完的事。** 台账一旦开始沉淀历史,就会退化成没人读得完的流水账 ——
2026-07-29 搬出时,15 条活跃条目里有 7 条已完成或已判定不做,另有一个占全文件 60% 的归档区。

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

### P1-24 通用证书标准库 + 队内认定规则 + 招新证书闭环 — **✅ 已交付(2026-07-30);剩发版与首批初始化**
- **交付**:PR-0(冻结)→ PR-1 → PR-2 → PR-3 → PR-4a(拆三刀)+ PR-4b → PR-5 → PR-6 全部合入 main([#826–#834](https://github.com/BA7IEE/srvf-nest-api/pull/834));**Endpoint 435→438 · Migration 66→67 · 权限码 214→222**。
- **⚠️ 交付后跨模型评审判 NO-GO → findings 修复批次 F1–F6**(2026-07-30):两个外部模型对 `main@bc300a66` 独立评审,21 条 findings 主会话逐条复现。修复见 [#835](https://github.com/BA7IEE/srvf-nest-api/pull/835)(并发四处统一收口)· [#836](https://github.com/BA7IEE/srvf-nest-api/pull/836)(证据授权按状态分流)· [#837](https://github.com/BA7IEE/srvf-nest-api/pull/837)(PATCH 三态 + 日期真实性 + 核验落点)· [#838](https://github.com/BA7IEE/srvf-nest-api/pull/838)(§12 资质判断)· [#839](https://github.com/BA7IEE/srvf-nest-api/pull/839)(主数据契约与审计)· F6(SOP / 初始化 / 台账)。
- **post-freeze 修正记录**:[`archive/reviews/certificate-standard-library-t0-amendments.md`](../archive/reviews/certificate-standard-library-t0-amendments.md) —— 冻结稿正文不回改,修正逐条记在这里。**冻结稿 + amendments 两份合起来才是当前需求。**

#### 🔴 第四轮独立评审未通过(`main@7b0f5c25`)—— **4 条已修完(J1/J3),门禁仍关闭等第五轮复核**

判 NO-GO,**2 P1 + 2 P2,无 P0**;主会话逐条复现,**全部属实**(含 `new Date(null) → 1970-01-01` 实测)。

**本轮与前三轮的关键区别**:前三轮修「被点名的实例」,下一轮评审就在邻居文件找到同类
(H3 修了 `certificate-standards.dto.ts`,第四轮立刻在隔壁三个证书域 DTO 找到同一形状)。
本轮改成**修「类」+ 留机器守护** —— 判据从「还有没有漏的实例」变成「这个类有没有执法位」。

**P1-① `@IsOptional()` 的 null 语义错位(证书域全清)**

`@IsOptional()` 对 `null` 与 `undefined` **都**跳过后续校验,而本仓 service 判「传没传」
一律用 `=== undefined` / `!== undefined` / `??`。语义错位 ⇒ 显式 `null` 穿过契约层抵达 service。
三种后果,**都已在真 HTTP e2e 上复现**(修复前实测,括号内是实际返回):

| 后果 | 落点 | 修复前实测 |
|---|---|---|
| **静默写错事实** | Claim 审核 `issuedAt: null` → `new Date(null)` = **1970-01-01**(不是 Invalid Date,躲得过任何 NaN 检查),被「不得晚于今天」放行,作为正式审核事实落库并**照常参与资质门槛派生** | **200**(应 400) |
| **500 而非 400** | Policy PATCH `issuerPolicy: null` / `certNumberMode: null` → `?? locked.x` 先当没传算出合法最终态,`!== undefined` 又判成传了 ⇒ `data.x = null` 进 Prisma 非空列 | **500** |
| 同上 | Certificate PATCH `standardId: null` | **500** |

⚠️ 两条**与报告原文不同**,复审时请重点看:

- **`validityMode: null` 修复前返 400 而不是 500** —— `assertValidityCombination(FIXED_MONTHS, null)`
  顺手把它拒掉了。那道闸不是为 null 设的,只是**撞上了**。同理 `issuers: null`:
  `dto.issuers ?? []` 把 null 折成空数组,让 null 成为「清空」的隐式同义词,但
  issuer 数量检查(FIXED 恰好 1 / ALLOWLIST ≥1)顺手挡住了,**所以它当前不是可达的静默清空**
  —— 报告与本仓早前注释都把这条写得比事实严重,已订正。两条仍一并收口:
  依赖「恰好被别的规则挡住」正是本轮在修的形状。
- **`validityMonths` 判定为「仅可省略」而非「可清空」**:它的 null 由 `validityMode` 派生
  (改 mode 时 service 自动归零),不由客户端独立指定;保持 FIXED_MONTHS 却清掉 months
  本就是非法组合。DTO 里那句「本 DTO 不接受 null」以前**只是一句话**,现在有执行位了。

**逐字段分类**(证书域四个 DTO,实测 **47** 处真装饰器 —— goal 写的 51 里有 4 处是
注释中提到 `@IsOptional()` 的文字,不是装饰器):

| 文件 | 真可空(留 `@IsOptional()` + `T \| null`) | 仅可省略(改 `@OmittableOnly()`) |
|---|---|---|
| `recruitment-certificate-claims.dto.ts` | 0 | 16 |
| `certificate-recognition-policies.dto.ts` | 0 | 7 |
| `certificates.dto.ts` | 4(Update 的 `recognitionIssuerId`/`issuingOrg`/`certNumber`/`expiredAt`) | 6 + 1(`issuedAt` 原为手写 `@ValidateIf`,改具名) |
| `certificate-standards.dto.ts` | 4(两处 `description` + Update 的 `levelCode`/`parentId`) | 10(两个 query DTO;H3 已做的 9 处不回退) |

**两道防御,不只 DTO**:`@OmittableOnly()` 是第一道;service 侧换成**正向类型检查**
(`typeof dto.issuedAt !== 'string'` 而不是 `=== undefined`)是第二道。最深的一道放在
`CertificateRecognitionResolver.resolveDates` —— 它是**建证 / 审核通过 / 改证三个入口共用**
的那一段,少写一处就是一个新的 1970 入口。配套新增 `parseDateOnlyStrict`
(`src/common/datetime/date-only.util.ts`),因为 `new Date(null|true|[])` 全都给 1970 而非
Invalid Date,「先 new Date 再判 NaN」这种写法拦不住。

**P1-② 这个类没有执法位**(见下方 J2,**已落地**)。

**P2-① 注释与执行位相反**:`review()` / `revokeReview()` 的注释写「⚠️ 本刀**不重算门槛**」,
而两个方法结尾都明确调用 `recomputeCertificateThresholds()`;文件头「也不接门槛派生……
三者必须在 4a-2 一次原子切换」描述的是一个**已经发生过**的未来(4a-2 早已接线)。
改注释、**不改代码**(代码是对的)。这是本项目**第五次**抓到「注释≠执行位」。

**P2-② 台账过期**:`current-state.md` §4 仍挂第三轮的 H1–H5,而它们已修完关闭 ——
继续挂着会让下一个会话去重修。已换成本轮。

**修复落点**(零 schema,**Migration 恒 67**):

| # | 落地内容 |
|---|---|
| J1 | 证书域四 DTO 47 处逐条分类;`OmittableOnly` 提到 `src/common/decorators/` 成全仓唯一定义处;service 三处正向类型检查 + resolver 兜底;新 e2e `certificate-null-contract.e2e-spec.ts`(A 段该 400 的必须 400 + B 段反向数据断言 + C 段 5 条正向可 null,防矫枉过正) |
| J2 | `eslint.harness.mjs` 第 18 条 selector + 641 条具名基线(棘轮);selftest 加阳性对照 / 反向用例 / 「只减不增」检查 |
| J3 | 清掉 `recruitment-certificate-claims.service.ts` 三处过期注释;台账换本轮 |

**修完仍须第五轮跨模型评审**(SOP [§1.6](codex-review-sop.md)),门禁由维护者解除 ——
本批次**未**触碰 `current-state.md` 的 🔴 NO-GO。

---

#### 🔴 第五轮独立评审:J1 / J3 PASS,**J2 FAIL** → 棘轮加固已交付(`main@99e7d8ca` 起 K1–K3)

**J1 / J3 复核通过**:运行时 null 契约已全关闭,注释与执行位已对齐 —— 这两条不再是 open 项。

**J2 判 FAIL:3 P1 + 1 P2,无 P0**,主会话全部复现(其中嵌套 null 与 inline disable
用一份探针实测,`pnpm lint` **RC=0** 通过 —— 即绕过成立)。四条的共同形状是:
**棘轮的判据本身是 PR 可以改的东西**,于是「防线」在最需要它的那一刻恰好失效。

| # | 缺口 | 修复前实测 | 现在拦在哪 |
|---|---|---|---|
| L1 | 基线是 `.mjs` 里的字面量,零格式校验 | 一条 `src/**` 混进去就能整目录静默豁免 | 抽成 `harness/is-optional-null-baseline.json`,六条约束(E1–E6)**加载即抛** |
| L2 | 新增违规 + **同 PR 加基线** / 修 A 加 B(总数不变) | 🟢 全绿 —— lint 与 selftest 读的都是 PR 自己的基线 | base-trusted 裁判硬判 `HEAD ⊆ BASE`,**审批盖不掉** |
| L3 | inline disable(文件级 / 行级)、嵌套 null 冒充可空 | 🟢 RC=0 —— 18 条共用一个 ruleId,一句 disable 全关;`:not(:has(TSNullKeyword))` 把 `Array<T\|null>` 当可空 | 独立 ruleId 自定义规则判**顶层**类型 + DTO 范围 `noInlineConfig` |
| L4 | 对账用 `Set`,同一身份命中 2 次与 1 次**读数相同** | 🟢 一行基线同时豁免两个字段,完全不可见 | 判据换成「每条身份**恰好**命中 1 个 AST 节点」 |

**十项变异测试全建档**,索引在 `scripts/harness-eslint.selftest.ts` 顶部(唯一目录,
含每项「修复前是否绕过」与断言落点)。修复前后对照用
`git show HEAD:eslint.harness.mjs` 的**真实旧配置**实跑,不是重建的等价物:
M6/M7 inline disable、M8 嵌套 null 三种写法、import 别名 —— 六项修复前全部 🟢 放行,
修复后全部 🔴 拦下;`T | null` / `@OmittableOnly()` / 已冻结字段三条反向控制不误杀。

**顺手关闭的一条 known-gap**:自定义规则拿得到 scope,`import { IsOptional as Opt }`
已被识破(按**导入原名**判,所以 `IsString as IsOptional` 不误报)。
⚠️ **只关了第 18 条这一条** —— 其余 17 条 `no-restricted-syntax` 选择器的同类缺口
(`UseGuards as UG` / 变量中转 / `PickType as PT` 等 5 条)**原样存在**,继续登记为
knownGap,不因为「自定义规则这件事发生过了」就算解决。

**两处结构性收益**(换独立 ruleId 的直接结果,不是顺手):
① 56 个基线块从「必须重列完整规则集,漏一条把其余 17 条对这些文件静默关掉」
变成只碰自己那一个 ruleId —— **那个排序陷阱结构性消失**(补两条回归用例钉成事实);
② 删掉自测里「报告行号 → 反查 AST 取名」的平行实现,改由规则自己吐身份串,
少一把可能刻错的尺子(`eslint.harness.mjs` 51KB → 27KB)。

`eslint-rules/**` 同 PR 纳入 `harness/redzone.json` 的 `enforcement-layer`:规则体是
**新的执法体**,不纳入保护等于把防线搬到闸门外。加 glob 当场被仓库自己的 F4 闭环
拦下(`缺样例的 glob:eslint-rules/**`)—— 守护正常工作,期望值表 + P2b 覆盖断言一并补。

**L2 的两条真触发证据**(不是结构断言 —— 本仓明确区分这两者):

| 实跑 | 结果 |
|---|---|
| 新 judge 合入 main 后首次运行([run](https://github.com/BA7IEE/srvf-nest-api/actions/runs/30634899615/job/91169893305)) | `✓ 第 18 条棘轮单调性:baseline ⊆ base(未改动(HEAD == BASE);base 641 条)` |
| 一次性对抗 PR:往基线加一行 `PaginationQueryDto.pageFAKE`([run](https://github.com/BA7IEE/srvf-nest-api/actions/runs/30635176939/job/91170830920)) | `✗ 第 18 条棘轮被破坏`,scan **fail**、approval **skipping** —— **没有可点的审批按钮**(探针 PR 已关闭删除,不合并) |

第二条同时把「取 head 版本的 GitHub API 路径」也走通了 —— 第一条只走了「基线未改动」的
快路,不足以证明整条链路。**只有第二条能证明这道闸真的会拦。**

**仍未解除 🔴 NO-GO,等第六轮跨模型评审**(SOP [§1.6](codex-review-sop.md)),由维护者解除。

**已知残留**(第六轮请重点看):
- 非 `.dto.ts` 文件里的第 18 条**仍可被 inline disable 关掉** —— `noInlineConfig` 刻意
  只配到 DTO 范围(`src/` 现有 7 处 inline disable 全是 service 侧硬删的正当具名豁免,
  扩到全仓会误伤,而一次误伤会让下一个人来把整条 `linterOptions` 删掉)。
  全仓实测该范围外目前 **0 处**真装饰器 —— 是零暴露,不是无风险。
- `scripts/tsconfig.json` 仍把 `harness-eslint.selftest.ts` 放在 `exclude`(既有缺口,
  见下方 J2 段落说明;需第三份授权,不在本 goal 范围)。

##### ✅ J2 · 立守护 + 全仓基线(**已落地**;红区授权 2026-07-31 由维护者发放)

**规则(`eslint.harness.mjs` 第 18 条 `no-nullable-is-optional`)**:凡带 `@IsOptional()` 的属性,
其 TS 类型必须含 `| null`;否则必须改用 `@OmittableOnly()`。默认对全仓生效(含 `test/` 与
`prisma/` —— 两处实测零违规,所以是白拿的)。

**棘轮的两道执行位,各管一半 —— 少任何一道都只剩单向**:

| 情形 | 谁拦 | 为什么不是另一个 |
|---|---|---|
| 往**已在基线的文件**新增违规字段 | `pnpm lint` | 豁免精确到 `类名.字段名`,新字段不在名单里 → 当场红 |
| 修好了却**忘删基线行** | `pnpm harness:selftest` | 一条用不上的豁免对 lint **静默无害**,lint 拦不到 |

**基线键为什么是「类名.字段名」而不是行号**:行号一改基线就变噪音;而 `description` 这类
字段名在同一文件的多个 DTO 类里各出现一次,只写字段名**区分不开**「已冻结的那个」和
「新加的那个」—— 后者正是棘轮要拦的东西。

**阳性对照与反向用例**(`scripts/harness-eslint.selftest.ts`,选择器覆盖闭环 17 → **18**):

```
✓ @IsOptional() 但类型不含 | null 被禁(null 会穿过契约层)      ← 阳性对照
✓ 真可空字段放行(@IsOptional() + `string | null`)              ← 反向
✓ 仅可省略字段放行(@OmittableOnly())                          ← 反向
✓ baseline 内已冻结的字段暂免第 18 条(PaginationQueryDto.page) ← 反向
✓ 选择器覆盖闭环:18/18 条均有正向用例真实触发
✓ 第 18 条棘轮:基线与现状逐条一致(641 处 / 56 文件,只减不增)
```

**棘轮双向变异测试**(故意改坏基线,断言它确实会红 —— 不是推断):

```
基线多一条陈旧行 → ✗ 已修好但基线行还在(删掉这几行):PaginationQueryDto.alreadyFixed
基线少一条       → ✗ 新增违规未登记(基线只能缩不能涨):PaginationQueryDto.page
往基线文件新增一个违规字段 → pnpm lint 当场红
同名字段挪到另一个类里     → 当场红(豁免绑类名,不是全文件通配)
```

**⚠️ `pnpm typecheck` 覆盖不到这个 selftest**:`scripts/tsconfig.json` 把
`./harness-eslint.selftest.ts` 放在 `exclude` 里(**既有缺口,非本刀引入**)。理由写在该文件
注释内:它 import `eslint.harness.mjs`,而后者顶部有 `// @ts-check`,拉进 TS 程序会暴露
2 处 implicit-any。**所以 typecheck 绿 ≠ 这个文件被检查过。** 该注释写的解除条件
(「拿到授权 → 注解那两行 → 从 exclude 删掉」)现已具备前两项,但删 exclude 需要
`scripts/tsconfig.json` 的**第三份授权**(redzone `ci-control-plane`),且不在第四轮 findings
范围内 —— **另立一小刀**,不混进本批(J2 已 +275 行,混进来会让跨模型评审更难做)。

**全仓实测规模**(本批次 J1 修完后):**641 处 / 56 文件**,全部在 `src/`(`test/` 与
`prisma/` 零违规)。两套独立实现(esquery selector + 直接走 AST)结果逐字一致。
分布前十(供后续按批次排期):

| 模块 | 处 | 模块 | 处 |
|---|---|---|---|
| activities | 95 | activity-registrations | 29 |
| member-profiles | 67 | content | 26 |
| role-bindings | 36 | announcement-import | 25 |
| recruitment | 33 | member-departments | 23 |
| positions | 32 | attendances | 22 |

(J1 修完后 certificates 40→17、recruitment 49→33;全仓 680→641,恰好等于本批次收口的 39 处。)

**为什么用棘轮而不是一次改完**:641 处 = 一个没人能评审的超大 diff,而跨模型评审是本仓
唯一兜底。棘轮让「新写的代码不能再犯」立刻生效,存量按批次还 —— 上表就是排期依据。

#### ✅ 第三轮独立评审 findings 已全部关闭(`main@1560c761`;H1–H5 = [#848](https://github.com/BA7IEE/srvf-nest-api/pull/848)–[#852](https://github.com/BA7IEE/srvf-nest-api/pull/852))

**第二轮 4 条已全部修复并经第三轮复核关闭**(G1–G4 = [#843](https://github.com/BA7IEE/srvf-nest-api/pull/843)–[#846](https://github.com/BA7IEE/srvf-nest-api/pull/846),零 schema,Migration 恒 67)。
本轮 5 条**无 P0**,主会话逐条复现,**全部属实**;其中第 ④ 条主会话判定比外部报告**更严重**(P2 → P1)。

**修复已于 2026-07-31 全部合入**(H1–H5 = [#848](https://github.com/BA7IEE/srvf-nest-api/pull/848)–[#852](https://github.com/BA7IEE/srvf-nest-api/pull/852),零 schema,**Migration 恒 67**,`handoff/admin-web.md` 与 `current-state.md` 零改动)。
两处**修复结果与报告原文不同**,已在各自 PR body 展开,复审时请重点看:

- **③ 的实际范围更宽**:不止 create 的 4 个字段、也不止 500。Update DTO 有同一形状,且
  `kind` / `categoryCode` 传 `null` 返 **200 且什么都没改**(`dto.kind ?? before.kind` 把 null 当没传吞掉)——
  静默忽略比 500 更难查。共 9 个字段收口([#850](https://github.com/BA7IEE/srvf-nest-api/pull/850))。
- **④ 的可达路径不成立**(实测,非推断):报告给的「建 DRAFT FAMILY A → 建 DRAFT FAMILY B 挂 A →
  改 A 挂 B」第二步就撞 `assertParentUsable` 的**父不能是 DRAFT**(18034,既有 e2e 一直锁着);
  报告只核了「父必为 FAMILY」「同 categoryCode」两条。进一步:**通过 API 构造不出环** ——
  设边要求父已启用、子从未启用,沿环一圈得到首次启用时刻严格递减又必须回到自己,矛盾。
  **但那是三条互不相关的规则撞出来的涌现性质**,三处代码里没有一个字提到「环」,
  放松任一条(例如允许 DRAFT 父)环即刻可达且无测试会红 —— 故仍补了显式祖先链遍历 +
  6 条单测,并删掉失效论证([#851](https://github.com/BA7IEE/srvf-nest-api/pull/851))。
  **若维护者认为「为不可达场景加防」不值得,可只保留删注释那一半。**

| # | 落点 | 机制(已复现) | 后果 |
|---|---|---|---|
| **P1** | `evaluate(false)` / `resolveManual(false)` | 只写 `recruitment_applications.statusCode = rejected`,**零 Claim 级联**。而 `APP_INACTIVE_STATUS_CODES` 含 `REJECTED` ⇒ `lockActiveApplicationOrThrow` 之后拒绝一切 Claim 写路径 | 该报名下的 `APPROVED` Claim **永久卡在非终态**:不能撤回审核 / 拒绝 / 重传 / 撤回 / 转 PROMOTED。留存 SOP 只扫 `status IN ('REJECTED','WITHDRAWN')` ⇒ **永远清理不到**;证据闸 `CLAIM_EVIDENCE_DENIED` 只含 `{WITHDRAWN, PROMOTED}` ⇒ **图片仍可签 URL**。⚠️ 与既有全库不变量**直接矛盾** —— `recruitment-certificate-concurrency` 断言「`a.statusCode IN ('promoted','withdrawn','rejected')` 下不得有非终态 Claim」,而 G1 新增的正常淘汰用例正好造出 `rejected + APPROVED`。两份 spec 在各自派生库里都绿,**合起来系统规则不能同时成立** |
| **P1** | `updateApplication()` | G2 改用 `lockActiveApplicationOrThrow`,该函数把 `rejected / withdrawn / promoted` 一律视为终态返 28041 | canonical [`handoff/admin-web.md`](../handoff/admin-web.md) 仍写「非身份字段**恒可改**…promoted/已脱敏行 → 28041」,**没说 rejected/withdrawn**。运行时与 canonical 契约分叉。**需要维护者在 A(恢复可改,仅按 promoted + sensitivePurgedAt 拒)/ B(终态一律不可改,同步改 handoff+DTO+前端+CHANGELOG breaking)之间拍板** —— 「实现变了」不自动等于「契约变了」 |
| **P1** | `POST /certificate-standards` | `CreateCertificateStandardDto` 的 `levelCode`/`parentId`(以及 `isInternal`/`sortOrder`)仍是 `@IsOptional() @IsString()`;`@IsOptional()` 对 `null` 与 `undefined` 都跳过校验,而 service 判据是 `!== undefined` ⇒ 显式 `null` 穿过 DTO 后进入字典 / 父节点查询 | **500 而非 400**。G4 只改了文档示例不再发 `null`,没修接口本身。修法:`@ValidateIf((_o, v) => v !== undefined)` 让 `null` 落进 `@IsString()` |
| **P1**(外部报告列 P2,主会话上调) | `certificate-standards.service.ts:297` | 注释写「`parentId` 只在 create 期可设、Update DTO 不含它 —— 因此循环在结构上不可能形成」。**这是一条安全论证**,而 [`amendments A-3`](../archive/reviews/certificate-standard-library-t0-amendments.md) 已放开 DRAFT 改 `parentId`,论证失效。全文件**零环检查** | 冻结稿 §5.2「禁止形成父子循环」**零执法**且可达(建 FAMILY A → 建 FAMILY B 挂 A → DRAFT 期改 A 挂 B;父必为 FAMILY ✓、同 categoryCode ✓ 两条约束都过)。成环后两节点互为子节点 ⇒ 删除守卫恒非零 ⇒ **谁都删不掉**(与第 ① 条同一「冻死」形状);admin-web 要渲染树,递归渲染会挂。**后端本身是扁平一层、不递归,所以不会挂服务** —— 但注释会阻止下一个人补上这道校验 |
| **P2** | 同文件 `:30` / `:373-376` | 「Update DTO 刻意不含 kind/categoryCode/levelCode/parentId/isInternal」「update(仅文案与排序)」「身份字段不在白名单」—— 而紧接着的执行代码正在完整处理这五个字段 | 本仓维护者看不懂代码、长期由 AI 维护,**错误注释会指挥下一个模型删掉正确实现**。这是本项目第四次抓到「注释≠执行位」 |

**修复落点**(零 schema,逐条对齐上表):

| # | PR | 落地内容 |
|---|---|---|
| ① | [#848](https://github.com/BA7IEE/srvf-nest-api/pull/848) | 抽 `withdrawClaimsOnApplicationTerminal`,**写终态的 4 条路径全部共用**(sweep 结果:评定淘汰 / 人工核验不通过此前零级联,整份撤销与发号各有一份内联实现,已收编)。同事务锁 Claim(id ASC)转 `WITHDRAWN`、保留 `PROMOTED`、审计只记条数。**曾矛盾的两条不变量现同时绿**:全库巡检已进 G1 那一组 |
| ② | [#849](https://github.com/BA7IEE/srvf-nest-api/pull/849) | **拍板方案 A** —— `updateApplication` 改用 `lockApplicationRow`,只按 `promoted` + `sensitivePurgedAt` 两道锁后守卫 + CAS 拒。`rejected`/`withdrawn` 恢复可改非身份字段。**canonical handoff 零改动**(运行时回到它已写着的契约,净变化为零);G2 的「改资料 vs 发号」并发用例仍绿 |
| ③ | [#850](https://github.com/BA7IEE/srvf-nest-api/pull/850) | `@OmittableOnly()`(= `@ValidateIf(v !== undefined)`)收口 **9 个字段** × 真 HTTP `null → 400`;`description` 单独判定为**允许 null**(DB 可空、运行时一直如此,只是让 DTO/OpenAPI 说出来,行为零变化);ops 初始化文档同步订正 |
| ④ | [#851](https://github.com/BA7IEE/srvf-nest-api/pull/851) | 祖先链遍历 `assertParentChainAcyclic`(纯算法 + 注入式加载器,policy 文件仍零 DB)接进 create/update 两条路径,**排在父级校验之前**以保住 18019 错码;删失效论证;6 单测 + 3 e2e |
| ⑤ | [#852](https://github.com/BA7IEE/srvf-nest-api/pull/852) | 清掉两处「注释≠执行位」;`certificate-standards.service.ts` **全部 18 段注释逐条核过**,其余每条描述约束的注释都对上了执行位与执行它的测试(对照表在 PR body) |

**修完仍须第四轮跨模型评审**(SOP [§1.6](codex-review-sop.md)),门禁由维护者解除 —— 本批次**未**触碰 `current-state.md` 的 🔴 NO-GO。

<details><summary>第二轮 findings(已全部关闭,保留作历史)</summary>

#### 第二轮独立评审(2026-07-30,`main@2998a708`)

四条 findings 主会话**已逐条复现机制,全部属实**。**根因一句话**:证书相关的新写路径已经统一使用报名锁
(`lockApplicationRow` / `lockOwnActiveApplicationOrThrow`),但**评定、换绑、后台改资料这些旧入口还没接入同一串行点**。
发号内核本身在 F1 已修好(`claimAtStatus` + `WHERE statusCode='publicity'` 条件行锁 + 锁后复读 + CAS),
**这轮不是上轮问题反复**。

| # | 落点 | 机制(已复现) | 后果 |
|---|---|---|---|
| **P0** | `recruitment-application-review.service.ts` `evaluate()` | `findFirst`(无 `FOR UPDATE`)读 `statusCode` → 算 `nextStatus` → `update({ where: { id } })` 无条件写。无锁、无锁后复读、无 CAS | 可把并发提交的 `withdrawn`、或证书门槛回退后的 `verified`,**覆盖回 `publicity`**。发号内核只复核「当前是不是 publicity」,且**不要求存在 APPROVED Claim** ⇒ **已撤销的报名仍可能被建 Member/User 并发出永久编号** |
| **P1** | 同文件 `updateApplication()`;`recruitment-identity.service.ts` `rebindWechat()` / `rebindPhone()` | 三处都未接入 `lockApplicationRow`。`updateApplication` 的 `promoted` / `sensitivePurgedAt` 守卫建立在**锁前**的 `findFirst` 上;换绑事务内只做冲突查询后按 `id` 无条件 `update` | 发号已脱敏(`sensitivePurgedAt` 非空、PII 已清)之后,等锁的旧请求仍可**把手机 / openid / 地址 / 换绑历史写回**;而 `sensitivePurgedAt` 非空会让留存清理**永远跳过该行** |
| **P1** | `certificates.service.ts` `verify()` | `before` 读于 `claimAtStatus()` **之前**,`alreadyExpired` 用的就是这份锁前快照,锁后未复读 | 并发 PATCH 改到期日 → 核验写错终态(两个方向都会错)。与 F1 修掉的「发号用锁前快照」是同一个病,只是没修到这儿 |
| **P2** | `ops/certificate-standard-library-initialization.md` | 示例传 `"levelCode": null` / `"parentId": null`,而 `certificate-standards.service.ts` 分支判据是 `!== undefined` —— 显式 `null` 会进字典 / 父节点查询分支 | 示例**不能按原样执行**。同文档「先建 FAMILY 还是先建 CREDENTIAL」一段仍写「`parentId` 只能创建时设、事后只能删掉重建」,与 [`amendments A-3`](../archive/reviews/certificate-standard-library-t0-amendments.md) 直接冲突 |

**修复范围**(零 schema,Migration 应恒 67):上表四个落点 + 三组真 PostgreSQL 并发 e2e ——
① 评定 vs 报名撤销 / Claim 撤回审核;② 换绑与后台改资料 vs 发号;③ PATCH 到期日 vs 核验(两个方向)。
外加全库巡检断言:`publicity` 报名不得存在证书门槛不完整的状态;`sensitivePurgedAt` 非空的报名不得被写回任何应清 PII。

**修复批次自己也要再过一轮跨模型评审**才允许发版(SOP [§1.6](codex-review-sop.md))。

</details>
- **⏸ 剩余挂账**(不属于本任务的代码范围,但没做完就不能算上线):
  - **发版**:#826–#834 与 F1–F6 全部未随版本发布(tag 仍是 v0.64.0)。
  - **PR-4b 的第 67 个 migration 未部署** —— 不可逆 contract,按 [`go-live runbook`](../ops/certificate-standard-library-go-live.md) 执行(停写 → 备份验证 → 探针 → migrate)。
  - **首批标准与认定规则未建**(刻意不 seed:认定口径是维护者拍板,不由 AI 内置)。按 [`初始化 runbook`](../ops/certificate-standard-library-initialization.md);⚠️ `code` 打错不可挽回。
  - **前端适配**:对外契约破坏清单见 [`handoff/admin-web.md`](../handoff/admin-web.md) §3.2 / §3.2.1。
- **原立项背景(保留)**:
  [`certificate-standard-library-t0-review.md`](../archive/reviews/certificate-standard-library-t0-review.md)(2026-07-29 拍板;v1.0 / v1.1 **废止**)。
- **要解决什么**:当前系统能录/审/拒/提醒证书,但答不出四个问题 —— 这是什么证 / 本队按什么规则认可 / 申请人交了什么原件 / 审核后确认了什么。四类事实拆为 `CertificateStandard`(证书身份,稳定 code)+ `CertificateRecognitionPolicy`(队内认定规则,可多版本)+ `RecruitmentCertificateClaim`(一证一行的原始申报,可暂不分类)+ `Certificate`(正式档案)。
- **拆分**:PR-0(冻结,本 PR 完成)→ PR-1(日期语义 + `certificate.read.sensitive`)→ PR-2(schema/权限/审计骨架)→ PR-3(Standard/Policy 管理 API)→ **PR-4a(写路径切换)+ PR-4b(删旧事实,同 release)**→ PR-5(证据读取 + 工作台)→ PR-6(前端联调)→ PR-7(release 收口)。
- **⚠️ 单向门**:整套方案「直接删列、不做兼容、不双写」的可行性,建立在 `Certificate = 0 行` 且 `招新证书 JSON = 0 行` 之上,**只在 production 未部署期间成立**。一旦上线跑完一轮招新,PR-4 就退化成 migration + 回填 + 双写兼容期。**这是本任务排在企业微信之前的唯一理由。**
- **⚠️ 跨仓破坏性变更**:门槛 `redCross` / `bsafe` 从「可人工标记」变为 **Claim 的只读派生投影**,`markThreshold` 传这两个 code 将返回业务错误(当前二者在 [`recruitment.constants.ts`](../../src/modules/recruitment/recruitment.constants.ts) `THRESHOLD_CODES` 中与 `patrol1/patrol2/training` 平级)。**`srvf-admin-web` 若已有该按钮,须同批适配**,不得等上线才发现。
- **档位**:C/D 混合;schema / migration / Permission seed / AuditLogEvent / 敏感读语义均须维护者红区授权。**每个 PR 开工前先跑 `pnpm harness:needs <写集>`**,把授权凑成一次请求。

### P1-25 企业微信接入(身份入口 + 工作台入口 + 通知通道) — **🟡 已冻结,排在 P1-24 之后**
- **冻结评审稿**:[`archive/reviews/wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md)(2026-07-29 维护者「按推荐」整体冻结 `D-WC-1..31`)。
- **终态**:单企业、单自建应用 Agent;`WecomIdentity → User → Member → SRVF Authz`;消息只走既有 Notification Outbox。**企业微信只回答「你是谁」,SRVF 继续回答「你能做什么」**。
- **拆分**:T0(冻结,本 PR 完成)→ T1(schema expand-only)→ T2(通道层 + 设置 + 连接诊断)→ T3(OAuth 登录/绑定/换绑/管理员清除)→ T4(User 生命周期闭环)→ T5A(受众判定重构,行为保持)→ T5B(WeCom 消息通道)→ T6(runbook + 10–30 人分层试点)。
- **⏸ 为什么排在后面**(2026-07-29 拍板):① 与 P1-24 同为 schema-touching,受 [`process.md §8`](../process.md) 「同一时刻至多一条 schema-touching lane」约束,不并行;② 写集在 Permission seed / AuditLogEvent / openapi / CODEMAP / RBAC_MAP / counts 上重叠;③ 本任务 expand-only、开关默认全 false,**何时做成本相同**,而 P1-24 有会关闭的单向门。
- **额外硬门**:身份链(T1–T4)可先落地;**消息链(T5B)的启用**必须等现有 Notification Outbox 在生产完成部署、Worker 同版本切换并通过硬门(见 [`current-state.md §2`](../current-state.md) Outbox 行)。代码可以先写,`messageEnabled` 默认 false。
- **不做清单(节选)**:不写 `User.openid`、不接通讯录同步、不加第 3 个 cron、不引入 Redis/queue、不做 PC 浏览器扫码登录、不承诺 exactly-once。全文见评审稿 §0.3 与 §17。

### P1-22 入队专业队类型 / gate 定义配置化 — **⏸ 诉求触发再立项**
- **背景**(招新/入队十三项收口问题⑨):`PROFESSIONAL_GATE_CODES` / `GATE_VALIDITY` / `PROFESSIONAL_TEAM_GATE_BY_NODE_TYPE` 当前在 `team-join.constants.ts` 硬编码 4 种专业队及全部 gate 有效期;新增专业队、改 gate 或调整有效期都必须发后端版本。P⑦ 已拍板本 goal 只挂账,不顺手扩动态配置面。
- **候选方案**:D 档新增 gate 定义表(建议字段:`code`/`professional`/`validityType`/`validityYears`/`extendable`/`status`) + 专业队 nodeType→gate 映射表(建议字段:`nodeTypeCode`/`gateCode`/`status`),由 Query/Policy 层一次加载后供标 gate、进度派生与一键入队重校验共用;须同步设计 admin 配置端点、RBAC、audit、缓存失效与存量常量迁移/回滚方案,禁止只把其中一个消费者改成读表造成双轨。
- **触发条件**:业务提出新增第 5 种专业队、运营需自行调整 gate/有效期,或 node_type 约定开始跨版本频繁变化时单独立项。

### P1-23 `recruitment_applications.isForeigner` 历史 DB 列改名 — **⏸ 数据治理诉求触发再立项**
- **背景**(招新/入队十三项收口刀C2 遗留):API DTO/CSV/stats/audit 对外已统一改为 `isNonMainlandDocument` / `is_non_mainland_document`,含义锁定为「非大陆证件,不代表国籍」;仅 Prisma/DB 历史列仍名 `isForeigner`。直接 rename 属 D 档破坏性 schema 变更,本 goal 明确禁区,故不改列名。
- **候选方案**:先盘点所有 SQL/报表/导出/备份消费者,再做 Prisma field 映射过渡或单次 rename + 存量验证;同步 current-state/CODEMAP/留存 SOP 与回滚 SQL。不得先新增第二列长期双写。
- **触发条件**:外部 BI/报表开始直读该列,或合规审查要求物理字段名也去除“外籍”误述时单独立项。

### P1-26 并发写路径审计 findings 修复 — **6 🔴 + 2 🟡 已修 · A-R2 按方案乙落地;剩 S6 三处待拍板**

- **两份独立审计,同一范围、同一 base(`7b0f5c25`),都 report-only、零 `src/` 改动**:
  - **A · Claude 版** [`concurrency-write-path-audit.md`](../archive/reviews/concurrency-write-path-audit.md) —— **56 落点 / 🔴2 / 🟡2 / 🟢52**;
    审计轴 = **逐行锁纪律**(S1「锁后不复读」在四模块**零命中**);S7 定义 = **锁的获取被绑在 authorization 分支上,另一条 surface 裸奔**。
  - **B · codex 版** [`concurrency-write-path-audit-codex.md`](../archive/reviews/concurrency-write-path-audit-codex.md) —— **64 落点 / 🔴5 / 🟡1 / 🟢58**;
    审计轴 = **跨行/跨聚合不变量**;S7 定义 = **跨行/跨聚合不变量没有共同线性化键**。
- ⚠️ **两份不是同一份报告的两个版本,是两次独立审计**。#854 合入了 A,#855 把 B 的摘要写进了指向 A 的台账条目,
  于是台账承诺的五条活 bug 在被链接的报告里一条都找不到;而 **B 的正文当时根本没进仓库**(只存在于一个工作区 stash)。本条目与本 PR 一并修正。
- **两轴都对,但只有 B 那根轴上有活 bug**:A 逐个方法核锁纪律,结论「锁用得对」经复核成立;
  B 问的是「每行都锁了,跨行不变量谁保证」。**主会话已实测确认 B 的 F2**:
  `computeContribution(tx, memberId, cycleYear)` 跨该成员当年**全部 Sheet** 聚合,而 `finalApprove` 只 claim 当前 Sheet ——
  两个并发终审各读 `before=3`、各算 `after=4`,谁都没观察到跨过 5 分,里程碑一条不发(教科书式 write skew)。
  **同一位置 A 标 🟢** —— 因为按「本方法的锁纪律」看它确实没错。
- **唯一被两份独立确认的**:Attendance Admin `edit` 只锁 Sheet、不锁 Activity/Registration(A 的 R1 = B 的 F1)。
  **交叉确认项优先级最高**,建议排在修复第一位。
- **B 的五条活 bug**:Attendance Admin `edit(records)` 可留下 cancelled Registration + live AttendanceRecord;两个不同 Sheet 的 `finalApprove` 可并发跨过 5 分阈值却零 milestone;`cancelMy` 可用锁前旧标题写 durable intent;Team Join `submit` 可在 Member 已入队后 create;final join 不收口同成员其它 live Application,可留下 frozen approved。
- **两份的 S7 定义不同,都是真形状**:A 的「锁绑在 authz 分支、另一 surface 裸奔」需**跨 surface 对照**才暴露;B 的「跨行/跨聚合不变量无共同线性化键」需**跨行**才暴露。两者都不在 S1–S6 里,建议一并纳入形状表。
- **B 的 S5 / S6 扫描**:确认 `attendance.recorded` “随事务回滚”注释没有执行位及 3 组 stale source comment;确认 Activity.capacity 递补、岗位候补隔离、自助取消通知范围共 3 处 canonical/runtime 分叉。方向须维护者拍板,不在并发修复中顺手调和。
- **B 的建议排序(其报告 §8,建议非执行)**:① Attendance Admin edit → ② Team Join submit+final join 同一 goal → ③ finalApprove 聚合 write-skew → ④ cancelMy 锁后 metadata → ⑤ submit 防御性复读。
- **B 的未审点名**(其报告 §9):`auth`/`authz`/限流(红线)· AuditLogs/Notification Outbox/Insurance 的模块内部 · notification worker 消费侧 · **并发 e2e 未跑**(5 条红均给出源码可复核交错;真实双连接 barrier spec 留给后续获授权修复 goal)。

#### 修复进度(2026-07-31;修复范围已由维护者以 goal 形式下达)

**6 条 🔴 逐条 —— 每条都先写 red-first 并发 e2e 复现交错,再修**(去重后 A-R1 = B-F1):

| 编号 | 复现结论 | 修复落点 | red-first 证据 |
|---|---|---|---|
| A-R1 = B-F1 · Admin `edit(records)` | ✅ 交错成立 | `attendances.service.ts` `edit`/`softDelete` **两条 surface 都取** Activity 聚合锁 + `claimAndRecheckRegistrations`(认领后复读复判) | 修复前:取消**成功提交**,edit 随后写入引用它的 live record → `cancelled 报名 + live 记录` |
| A-Y1 · Admin `softDelete` 缺锁 | ✅ 形状成立(后果止于误报 21033) | 同上,与 `edit`/`resubmit` 收敛为同一写法 | 修复前:占住 Activity 行锁时 `softDelete` **不等待**,径直提交 |
| B-Y1 · `submit` claim 后不复读 | ✅ 形状成立(当前被 Activity 根锁挡住) | 与 `edit` 共用 `claimAndRecheckRegistrations`,claim 后按同一批 id 复读并重判归属/状态/岗位时段 | 防御性加固,无独立红(阻断条件见 B 报告 §5) |
| B-F2 · `finalApprove` 里程碑 write skew | ✅ 交错成立(**已实测**) | `finalApprove`/`reopen` 在读贡献快照前取共享 member 键 `lockMembersForWrite` | 修复前:正式总分 **5 分**、milestone intent **0 条** |
| B-F3 · `cancelMy` 锁前 metadata | ✅ 交错成立 | 活动标题/发布人改到 claim + 证据守卫**之后**读 | 修复前:intent body 落的是**旧标题** |
| B-F4 · Team Join `submit` | ✅ 交错成立 | `submit` 事务第一步取 member 键后再判「未入队」 | 修复前:一键入队在途时 submit **建行成功**,写入时人已是队员 |
| B-F5 · final join 不级联同人申请 | ✅ 成立(不需并发) | final join 同事务按 `id ASC` 终结同人其它 live 申请为 `rejected` + `eliminationStage='already-enrolled'`,逐条写 `team-join-application.supersede` audit | 修复前:残留申请仍是 `joining`,全库巡检断言直接红 |

- **共同线性化键**:新增 `src/common/prisma/member-advisory-lock.util.ts` 的 `lockMembersForWrite` —— 队员维度**唯一**一把键(单参数 `hashtext(memberId)` advisory 空间);`TimeOverlapPolicy.lockMembersForOverlapCheck` 改为委托它,语义与调用位置零变化。
- **锁序**(修完后各路径持锁顺序,证明无环):
  - 考勤写:`Activity 行锁 → Sheet claim → Registration claim → member 键`(`submit`/`edit`/`softDelete`/`resubmit` 同向)
  - 考勤终审:`Sheet claim → member 键`(与考勤写同向:聚合行锁在前、member 键在后)
  - 入队:`member 键 → Application 行锁 → Cycle → source → Member 行锁 → 同人残留 Application`
    (键必须在**任何 Application 行锁之前**取:同一队员可同时有两条 approved 申请,两个终审各锁一条再反向争 Member + 同人级联 = 40P01;行锁图本身逐字不变)
  - 无环依据:入队路径从不请求 Activity/Sheet/Registration 行锁;考勤路径从不请求 Application/Cycle/Member 行锁。两族唯一的交点是 member 键,而任一族内取键顺序都由排序去重固定。
- **并发 e2e(全部真双 app 双连接 + 「两条独立连接」元断言)**:
  `attendance-admin-edit-registration-concurrency` · `team-join-enrollment-lifecycle-concurrency` ·
  `attendance-final-approve-contribution-milestone-concurrency` · `registration-cancel-my-locked-snapshot-concurrency`。
  含两条**全库巡检不变量**:① live 考勤记录不得挂在非 pass / 已软删报名上;② 已入队队员名下不得有 live 入队申请。
- **S5 已收口**:`attendance.recorded`「随事务回滚」是**错的**(它只是一次 Logger 输出,DB 回滚撤不回日志),注释已改正并指向 outbox 才是可回滚事件的落点;另 3 组 stale comment(App 报名「容量满拒绝」/「仅 pending|pass 可取消」、final join「消费评估延长期」)已按运行时改正。

##### A-R2 已拍板并落地 —— **方案乙:放行存量、掐断增量**(维护者 2026-07-31)

- **原缺陷**:`activities.cancel` 只把 `pending`/`waitlisted` 报名改 `cancelled`,**完全不碰 AttendanceSheet**;
  `submit` 有活动状态闸(20122),但 `edit`/`approve`/`finalApprove` 等九个写方法**从不读** `Activity.statusCode` ——
  已取消活动上的考勤单能一路走完审批并结算贡献值,喂进入队门槛。**不需要并发也可达**。
- **拍板语义(两半,缺一半就不是方案乙)**:
  - **放行存量** —— 取消前已提交的考勤单仍可 `approve → finalApprove` 并结算(工是真做了的,
    作废队员已提交的贡献代价更大);`resubmit`/`reopen`/`approve`/`finalApprove` 刻意**不**加活动状态闸。
  - **掐断增量** —— 贡献值的增量只有两条来源:新建 Sheet(`submit`,既有 20122 已拦)与
    改写既有 Sheet 的 records(`edit` 的 records 分支,本次新拦,**复用同一个 20122,零新增 BizCode**)。
- **落点**:`ActivityParticipationPolicy.canChangeAttendanceRecords`(唯一判定出口,**只拦 `cancelled`**,
  draft/published/completed 编辑行为逐字不变)+ `attendances.service.ts` `edit` records 分支;
  该读位于 K1 的 Activity `FOR UPDATE` 之内,并发 cancel 挤不进闸旁。
- **契约变化(前端需知)**:`PATCH /api/admin/v1/attendance-sheets/:id` 与
  `PATCH /api/app/v1/my/managed-activities/:activityId/attendance-sheets/:sheetId`
  在活动已取消时**新增返回 20122**(仅当请求体带 `records`);两处 `@ApiBizErrorResponse` 与 openapi 已同步。
- **执行位**:`test/e2e/attendance-cancelled-activity-increment-gate.e2e-spec.ts`(5 条,含全库巡检:
  已取消活动上的考勤单 records 数不得增长)。修复前「掐断增量②」与巡检两条**都红**。
- **刻意未做**:`cancel` **不**级联终结既有考勤单(那是方案甲),`pass` 报名也仍留在 `pass`。

##### 🛑 仍待维护者拍板(**AI 不得自行调和**)

1. **S6 四处 canonical/runtime 分叉**(逐处「改文档还是改代码」):
   | # | canonical | runtime | 现状 |
   |---|---|---|---|
   | A-S6 | `handoff/admin-web.md:80` / `miniapp.md:30`:有未撤销考勤记录的报名一定取消不了(21033) | 曾可被 Admin `edit` 并发绕过 | ✅ **已随 K1 核销**(运行时现已兑现文档,文档未改) |
   | B-D1 | `admin-web.md:73`:有 live Position 时编辑 `Activity.capacity` **不再**触发递补 | `activities.service.ts` 仍算 delta 并调跨岗位递补 | ⏳ 待拍板 |
   | B-D2 | `admin-web.md:73` / `miniapp.md:108-111`:A 岗释放/扩容只递补 A 岗 | `activity-waitlist-promotion.ts` preferred 队列空后进入其它有余量岗位的全局 FIFO fallback | ⏳ 待拍板 |
   | B-D3 | `admin-web.md:198,460` / `miniapp.md:65`:只有「取消**已通过**报名」才发 `activity-changed` | pending/pass/waitlisted 自助取消都无条件 enqueue owner intent | ⏳ 待拍板 |
2. **canonical 缺定义(先补定义再判)**:`attendances/CLAUDE.md:12` 要求所有业务写经 AttendanceAuditRecorder,
   而 App GPS 签到/签退成功路径直写 `ActivityCheckIn` 不落 AuditLog;`docs/handoff/**` 未定义 GPS 证据写是否豁免。
- **本次未做**:B-D1/D2/D3 未调和(待拍板)· `cancel` 不级联既有考勤单、`pass` 报名仍留 `pass`(方案乙刻意)· `certificates`/`recruitment`/`auth`/`authz`/限流未碰(goal 禁区)· 零 schema(Migration 恒 67)。
- **状态**:**6 🔴 + 2 🟡 已修并有 red-first 证据;A-R2 已按方案乙落地;剩 S6 三处待拍板**。本条目**关闭前须过跨模型评审**(SOP §1.6)。

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

# 能力台账(CAPABILITIES)

> **本文从 [`docs/current-state.md`](../current-state.md) §2 迁出**(2026-08-20)。
> **内容逐字搬运,未改写、未删减任何一条事实。**
>
> **权威性不变**:这些条目仍是各能力的当前终态摘要,与迁出前完全等价;
> `current-state.md` §2 现在只留指向本文的指针。

## 为什么有这份文件

`scripts/docs-readtax.ts` 守护**恒读层** —— 恰三个文件(根规则入口、`docs/current-state.md`、
Claude Code 入口)。它们每次会话都被完整注入上下文,所以每个字符都有**恒定成本**。

该脚本 `:67-69` 早就把这一天写好了处方:

> 25% 余量 ≈ 两周就会再撞顶 —— 08-02 那次正是这么红回来的。**若下次仍在两周内撞顶,
> 该动的不是预算数字而是结构**:把 §2 的逐条能力摘要挪进不付预算的位置,
> current-state 只留指针。那是独立立项,不在本 PR 范围。

**预言应验了**:预算 2026-08-15 重设为 9600(落点 74.9%),**5 天后即撞顶**,
实测约 483 字符/天 ≈ 定预算时假定值的 **3.3 倍**。

撞顶后的真实压力不是「写得啰嗦」,而是 **每加一条新能力就得先删一条既有事实** ——
那恰恰是 readtax 脚本顶部明令要避免的结果:

> ❌ 不要为腾位置删掉一条**既有事实** —— 那是这道守护最不想造成的结果

⇒ 本次按脚本自己开的方子做**结构性迁移**:不调预算数字、不删任何事实。
§2 迁出前占 **4115 字符 = 恒读预算的 43%**。

## 维护规矩

- **新增能力条目写这里,不写 current-state。** 本文不在恒读层,写多不付预算。
- current-state §2 只保留指针,**不再逐条罗列**。
- 条目按「能力 → 终态事实」写,保持既有密度;**不要展开成教程**
  (那是 `docs/ops/` 与冻结评审稿的职责)。
- ⭐ **已部署 / 未部署必须标明** —— 这是 §2 一直在承载的、**机器查不到**的事实,
  也是这份台账最不可替代的价值。删条目前先问:这条事实还有别处记着吗?

## 能力清单

> ⚠️ **「安全」那一条刻意留在 `current-state.md`,不在本文。**
> 它含 `Decision 15.1=B/15.2=B` 等关键串,被 `notification-canonical-docs.spec.ts`
> **钉成代码级契约**(三处互证:current-state / NEXT_TASKS / notifications 模块入口文档),
> 搬走会直接打红那条 unit。这不是迁移遗漏,是 **INC-16** 那条历史事故的守护在生效 ——
> 该事故的教训原话:「文档不总是『只是文档』…… **搬动/精简文档前先 grep 谁在 `readFileSync` 它**」。

- **接口与字段真相**:live `/api/docs-json` + contract snapshot + `EXPECTED_ROUTES`;**逐版本叙事**:[`CHANGELOG.md`](../../CHANGELOG.md) + `../archive/handoff/`
- **模块地图** `../CODEMAP.md` · **权限地图** `RBAC_MAP.md`(各有 check 脚本守护)· **数据模型** `prisma/schema.prisma`
- **API surface**:6前缀;跨 surface Mixed=1(禁增);同 surface 双 Controller文件=3(非 Mixed);App 禁返 L3(content-\* signed URL 例外);Integration 只接受显式 SERVICE / DELEGATED 主体;见 `../api-surface-policy.md`
- **Integration Foundation v1 PR1–PR7（未部署）**:Service Principal / Credential / Delegation Grant 控制面、独立 Service / Delegated Token、三腿交集授权与双主体 Audit 已落；PR6 新增 `/api/integration/v1/me`、Human 与机器主体物理隔离、Credential 轮换不分裂的同事务幂等地基；PR7 新增首个业务只读面 `GET /api/integration/v1/reference/activity-types`，仅 direct GLOBAL `dict.read.item` 的 Service Token 可用，Delegated 保持关闭。生产 Gate 仍为关闭；见 [`runbook`](../ops/integration-api-runbook.md)。
- **身份/会话终态**:手机/微信换绑消费 5 分钟 step-up proof 并锁后重验身份快照；logout 可由未过期 rotated ancestor 幂等撤销同 refresh family，其他 family/access 不动；详见 `../security.md`
- **多实例**:10 throttler 共用 PG bucket；RBAC/外部设置逐请求直读已提交 PG；Effect 单配置快照，DB 异常 fail-closed，零进程正确性缓存
- **Storage production**:空库 migration/seed→窄 bootstrap；固定 COS location+可解密凭证；disabled 重启不放行 Effect，null/LOCAL/unknown 禁回退；密钥不可轮换；COS 闭环已验，fleet 待验
- **贡献规则 ACTIVE 槽位**:未软删 ACTIVE 按 `activityTypeCode × attendanceRoleCode` 唯一；重复 pair fail-closed
- **Outbox**:PG lease/fence/gen/recipient/RBAC/quota；producer 事务同写 intent，provider 事务外至少一次；考勤 capped before/after 且同 application+threshold 一次；生产未部署，切换排空 API/worker/intents、禁混跑；取消通知禁 Member.id；键/目标不变
- **队员/报名真值**:正式=ACTIVE+grade level-1..7；报名 create/approve/递补锁后重验 live+ACTIVE，reopen 只回 pending
- **Attachment storage Phase1**:ledger接 Attachment；Content根锁、provider外；无key FK/非 repo-wide closure；见 [`runbook`](../ops/attachment-storage-consistency-rollout.md)
- **保险 v3(v0.59.0，未 deploy)**:PR1–PR4 gate/约束/evidence 已交付，脏数 fail-fast；Admin 360 overview 已补；切换须 drain 且禁混档
- **活动责任(v0.62.0 已 release·未部署)**:取消闭环=cancelled/null;生产迁移/配置/认领/部署未做,按 [`runbook`](../ops/activity-responsibility-workflow-rollout.md) 审批验 digest
- **安全** → **留在 [`current-state.md`](../current-state.md) §2**(见本节开头的 ⚠️,INC-16 守护)
- **可信代理边界**:`APP_TRUSTED_PROXY_CIDRS` 仅收 `none` 或精确 canonical CIDR；production/smoke 缺失拒启。真实 ingress/edge/backend ACL 尚须现场验证，反代部署不得用 `none`
- **证书标准库(PR-1→PR-6 + 评审 findings F1–F6)**:类别/等级唯一权威=`CertificateStandard`(实例侧零副本);认定规则由录入时锁定的 `recognitionPolicyId` 记住、换版**不追溯**;招新申报一证一行,发号只搬 APPROVED 且不重判。**需求 = 冻结稿 + [`t0-amendments`](../archive/reviews/certificate-standard-library-t0-amendments.md) 两份合起来**(冲突以后者为准);三份 runbook 见 `../ops/certificate-*`
- **活动（activity-business-overhaul-v1.1）**：87；永久头/保险 revision/参与投影、D83 资格 runtime 已落。D84 mode 以 v4 根锁/20152 闭合；D85–87 的冻结、资格 hash、lottery 承诺、回执和候选/岗位 guard 均零回填。第 4 批 runtime：邀请 accept 复用 canonical Form/资格/保险/身份/容量链；first_come 按场次即时 `pass|waitlisted`、不建 batch；rank/lottery 走 prepare/commit/void/get、D86 replay 和 20147 零写，同一根事务写容量/pointer/population/audit/outbox；递补仅原场次岗位。default 仅兼容旧 server/存量；资格配置/发布激活已落（draft typed RuleSet、V5 冻结激活）；活动到点 expiry 已落：复用既有两条 worker 与 `ActivityBatchJob` reconciliation、无新 cron，按最早 live session start 在 Activity 根事务内关闭 canonical pending/waitlisted 与 pending invitation，pass/容量不动，drift 20147 业务零写；整单取消/legacy writer lifecycle 也已收口：Activity 根事务关闭 canonical pending/waitlisted、追加 revision 并 CAS 投影，pass 的 active reservation 保留；legacy writer 只匹配无永久 identity 的兼容 header，漂移 20147 业务零写。
- **B7 会员受众标签（默认 HTTP 关闭）**：`ActivityPublishReview.audienceTagCodes` 为 nullable JSONB，运行时仅接受 `string[]`；NULL 保持 legacy 广播，`[]` 只取 ACTIVE 且未软删会员，非空数组按 ACTIVE、未软删的标签 OR 并集。成员赋标保留撤标历史；`ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED` 仅允许严格 `true`/`false`，dev/test 缺省 false、production/smoke 必须显式。已登录且有权限的受控 HTTP 调用在 gate 关闭时返回 503；取消通知没有扩展。
- **第 5 批（已合 main #1032，未部署）**：复用既有 QR credential、PunchEvent、EvidenceState/Seal 和服务段 revision 地基，接入负责人签发/作废/受保护 SVG 渲染、本人 QR 签到/签退/安全状态、责任人早退闭合/void/replace。所有 PunchEvent 写与整单取消按同一 Activity 根锁序串行；扫码 token 只作为请求输入、不进入读面。本批不含第 6 批工作人员代扫、代理、批量、导入或离线流程。
- **第 6 批（B6-2 子刀，未部署，尚未整体交付）**：B6-1 的短时成员凭证、staff scan、proxy、bulk job 与 CSV import 已接统一 PunchCommand/Activity 根锁/责任复验/worker fence；B6-2 按补充合同 v2 新增六条 OfflinePackage issue/revoke/upload/review HTTP wire。包 token 由 JWT_SECRET 经 HKDF/HMAC 域隔离且仅首次 issue/精确重放返回，库内仅 digest；单事件 upload 按 deviceTime 验 60 秒成员凭证，正式 PunchEvent 仍只由 `AttendancePunchCommandService` 写，异常按 22097 零写或 22098/22099 staging，review 读面不返 token/签名/hash/凭证/坐标。以上只代表 B6-2 代码面，不代表完整第 6 批或生产部署完成；PR/CI/核验/合并状态以对应 exact SHA 的外部证据为准。

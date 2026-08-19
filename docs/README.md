# docs/ — 文档地图

> 本目录是 SRVF API 的文档集合;**本文件是入口索引,不是规则源**。
> 当前事实读 [`current-state.md`](./current-state.md);长期铁律读根目录 [`../AGENTS.md`](../AGENTS.md)。

---

## 1. Active docs(当前生效,直接读)

| 文件 | 用途 |
|---|---|
| [`current-state.md`](./current-state.md) | **当前事实唯一入口**:版本、open PR、最新 release、surface 状态、当前债务、不做清单 |
| [`process.md`](./process.md) | 开发流程与协作制度:开工 checklist、PR 五档分级、release 收口、AI 协作纪律 |
| [`api-surface-policy.md`](./api-surface-policy.md) | API surface 长期边界(active 单一权威源):Admin / App / Auth / System / Open 五个 canonical 前缀 + 新增/迁移规则;原设计期顶层规范 `api-client-boundary.md` 已归档至 `archive/plans/api-client-boundary-design-period.md` |
| [`participation-bounded-context.md`](./participation-bounded-context.md) | Participation 业务上下文边界图:`activities` / `activity-registrations` / `attendances` / `contribution-rules` 4 模块的状态链条、跨模块耦合、API surface 与 governance;**不**含 `certificates`(独立 member-qualifications 上下文) |
| [`attachment-config-boundary.md`](./attachment-config-boundary.md) | 附件配置三表(`AttachmentTypeConfig` / `AttachmentMimeConfig` / `AttachmentSizeLimitConfig`)的 override-with-default 边界说明:为什么不合表、为什么不抽 facade、新增规则落点 |
| [`architecture-boundary.md`](./architecture-boundary.md) | 架构边界铁律 / active architecture boundary policy for Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect extraction decisions;承接 `AGENTS.md §2 D-7` |
| [`reference/`](./reference/) | **Harness 2.0 细则层(触碰才读)**:承接 harness v1 AGENTS 教学细则的九篇(命名与 DTO / 返回与错误码 / Swagger / auth-token / 软删与事务 / 角色保护 / 配置 / 测试纪律 / API 边界与决策锁全文);恒读入口与索引在根 `AGENTS.md` §6 |
| [`handoff/`](./handoff/) | **前后端交接层(canonical,两端对接文档唯一家)**:README(索引 + 维护协议 + **变更触发对照表**)+ `admin-web.md`(PC 后台)/ `miniapp.md`(小程序 + 招新 H5)+ `openapi.json` 便利快照;改契约同 PR 更新(AGENTS §0 反漂铁律) |
| [`srvf-foundation-baseline.md`](./srvf-foundation-baseline.md) | V2 派生项目基线规范(BizCode 段位 / 命名 / DTO / 软删除 / 验收门槛 13 项) |
| [`V2红线与复活路径.md`](./V2红线与复活路径.md) | V2 五档红线 A/B/C/D/E 与解锁触发条件 |
| [`security.md`](./security.md) | 已落地安全策略、软删除策略、token 吊销升级路径 |
| [`maintainer-guide.md`](./maintainer-guide.md) | **维护者手册(唯一一篇写给人不写给 AI 的)**:只有你能做的四件事(红区授权 / 不可逆 DB 命令 / 合红区 PR / 发版)、出事怎么办、命令速查、以及「哪些文档你不必读」 |
| [`deployment.md`](./deployment.md) | Docker 镜像、生产部署、迁移流程 |
| [`development.md`](./development.md) | 项目结构 / 路由总览 / 环境变量 / 排错 |
| [`testing.md`](./testing.md) | E2E 测试运行与覆盖范围 |
| [`docker-smoke-test.md`](./docker-smoke-test.md) | docker smoke CI 形态说明 |
| [`ops/certificate-standard-library-initialization.md`](./ops/certificate-standard-library-initialization.md) | 证书标准库首批 Standard/Policy 初始化指引(§20.3 步骤 6;**本仓刻意不内置任何证书标准** —— 认哪些证书/机构/有效期是业务拍板;含三组规则对照表 + 8 步最小 smoke + 两个顺序坑) |
| [`ops/certificate-evidence-retention-sop.md`](./ops/certificate-evidence-retention-sop.md) | 证书证据(L3)留存与手动清理 SOP(证据两个属主 / PROMOTED Claim 图**绝不可删** / 三类可清理 + 只读核对 SQL / 先删对象后清列 / 不引入 cron) |
| [`ops/certificate-standard-library-go-live.md`](./ops/certificate-standard-library-go-live.md) | 证书标准库 PR-4b **不可逆** contract migration 上线 SOP(执行前必跑的七条只读探针 + 迁移后三条结构复核 + 无列级回滚的处置边界 + 两处对外契约破坏清单) |
| [`ops/cos-production-rollout-checklist.md`](./ops/cos-production-rollout-checklist.md) | 运维侧真实 COS 上线 SOP |
| [`ops/encryption-key-freeze.md`](./ops/encryption-key-freeze.md) | Storage/SMS/WeChat/Realname 四把 production encryption key 的首发冻结、禁止直接轮换与事故处置边界 |
| [`ops/production-dependency-audit.md`](./ops/production-dependency-audit.md) | 每个 release candidate 的 production dependency high/critical 阻断与 moderate/low 逐条分析基线 |
| [`ops/sms-production-rollout-checklist.md`](./ops/sms-production-rollout-checklist.md) | 运维侧腾讯云 SMS 真实通道上线 SOP(签名/模板审核 → 凭证录入 → 真实发送验收) |
| [`ops/sms-data-retention-sop.md`](./ops/sms-data-retention-sop.md) | SMS 数据 retention 手动清理 SOP(验证码 90 天 / 发送流水 1 年,数值可改;维护者手动 psql,**不**引入 cron 清理;SQL 已 app_test 实测冻结) |
| [`ops/wechat-mini-production-rollout-checklist.md`](./ops/wechat-mini-production-rollout-checklist.md) | 运维侧微信小程序登录真实通道上线 SOP(注册小程序 → AppID/AppSecret → admin 录凭证〔仅 SA〕→ DevStub 全链 → 真实验收;系统侧已"正确但休眠") |
| [`ops/scoped-authz-go-live-checklist.md`](./ops/scoped-authz-go-live-checklist.md) | 维护者/运营侧「组织职务 + 分管 + scoped RBAC + 统一鉴权」上线初始化 SOP(一次性动作:部署迁移+seed → 建管理账号 → 录入队员 → 公告 rows 导入 → BD-2 终审绑定 → authz/explain 验收 → env 项确认) |
| [`ops/wecom-backend-configuration-sop.md`](./ops/wecom-backend-configuration-sop.md) | **企业微信后台配置 SOP + 身份链启用 runbook**(T6;冻结稿 §15.1 十五条逐条给判据 → 建应用 / 录凭证〔仅 SA〕/ 可见范围逐人 / `webBaseUrl` origin / 可信域名 / 可信 IP 生效窗口 / 密钥注入 → 「开总闸 → 诊断 → 开 `loginEnabled`」三步 → §15.4 身份链回滚。⚠️ 含「六个配置类 errcode 在 SRVF 侧全归一成 36030」的诊断边界与替代办法) |
| [`ops/wecom-pilot-playbook.md`](./ops/wecom-pilot-playbook.md) | **企业微信 10–30 人分层试点执行手册**(T6;冻结稿 §15.3 → 六类人员构成〔含**必须有**的无手机号测试账号〕/ A-B-C 三步启用 / 十项留证逐条「怎么做+期望+不符怎么办」/ 扩大条件与签署位。红线:不得以「接口能通」或「试了几天没报错」代验收) |
| [`ops/wecom-failure-injection-drills.md`](./ops/wecom-failure-injection-drills.md) | **企业微信消息链失败注入剧本**(T6;冻结稿 §15.2 条 8 四类 → 非生产复用 T5B 已有的 DEV_STUB `wecomerr-*` 前缀,核心断言恒为「有没有误记 SENT」。⚠️ 明写**生产只能安全做 Worker crash 一类**,其余三类给替代证据,不假装已在生产注入过) |
| [`ops/wecom-message-channel-rollout.md`](./ops/wecom-message-channel-rollout.md) | **企业微信应用消息通道上线 runbook**(T5B 交付 · T6 收口;混版本风险〔旧 worker 把 `notification.wecom-*` 判成 terminal dead〕/ no-effect smoke / 两个开关分两次开 / 运营五指标不得混算 / 人工 replay / §15.4 排空回滚四步与判据 SQL / §15.2 十二条 GO 检查单) |
| [`ai-harness/README.md`](./ai-harness/README.md) | **AI Harness 操作页**(derived,非规则源;规则入口在根 `AGENTS.md`):开工与守护命令 / 定位路径;同目录 `codex-review-sop.md`(跨模型评审 SOP)+ `RBAC_MAP.md`(权限地图,`docs:rbacmap:check` 守护)+ `NEXT_TASKS.md`;2026-06-10 Review 冻结档见 `archive/ai-harness/`,harness v1 快照见 `archive/harness-v1/` |

V2 设计期产物(V2-D8 立项时刻 draft 历史快照,**非当前事实权威源**):

> **当前字段 / 接口 / 错误码事实权威源 ≠ 本区块文档**;以下列三项为准:
> 1. **数据模型(字段 / 类型 / 约束 / 索引)** → [`../prisma/schema.prisma`](../prisma/schema.prisma)
> 2. **接口契约(路径 / DTO / 权限 / 错误码 schema)** → Swagger UI(`/api/docs`)+ [`../test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) `EXPECTED_ROUTES` + OpenAPI snapshot
> 3. **长期 API surface 边界与新增 / 迁移规则** → [`api-surface-policy.md`](./api-surface-policy.md)
>
> [`v2-data-model.md`](./v2-data-model.md) / [`v2-api-contract.md`](./v2-api-contract.md) 是 V2-D8 立项(2026-05-07)时刻的设计快照;V2 第一阶段及后续批次实装后**正文未逐行回填**,阅读它们仅用于了解 V2 第一阶段最初的设计意图,**不能作为字段 / 接口 / 错误码的执行依据**。

| 文件 | 用途 |
|---|---|
| [`v2-data-model.md`](./v2-data-model.md) | V2-D8 立项时刻的数据模型 draft(覆盖 `dict_types` / `dict_items` / `organizations` / `members` / `member_departments` + `users.memberId` 追加)— **字段事实以 [`../prisma/schema.prisma`](../prisma/schema.prisma) 为准** |
| [`v2-api-contract.md`](./v2-api-contract.md) | V2-D8 立项时刻的 API 契约 draft(29 接口口径)— **接口事实以 Swagger UI(`/api/docs`)+ [`../test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts) + OpenAPI snapshot 为准** |
| [`srvf-business-docs.md`](./srvf-business-docs.md) | 外部业务文档库路径索引(不在本仓库内) |

---

## 2. Archived docs(归档,仅作历史证据)

`docs/archive/**` 内的文档**只代表归档时刻的决议**,不再作为当前执行约束:

| 目录 | 内容 |
|---|---|
| [`archive/handoff/`](./archive/handoff/) | 历史 release handoff(v0.4.0 ~ v0.62.0),release 时刻快照,**合入后不回改** |
| [`archive/reviews/`](./archive/reviews/) | 历史评审稿:App API Phase 2(P2-2~P2-7)/ Phase 0.5/0.6/0.7 boundary review / Phase 1 client-boundary review / P0-D/P0-E/P0-F 评审稿 / 终态「组织职务 + 分管 + scoped RBAC + 统一鉴权」架构评审稿(`org-position-scoped-authz-terminal-design-review.md`,PR1–PR12 + 摘码微刀全序列实施完成,2026-07-03 归档)/ **第二轮全仓多维度系统性 review**(`full-repo-systematic-review-v0.34.0.md`,31 findings〔0 P0 / 1 P1 / 9 P2 / 19 P3 / 1 known-dup〕全处置完毕 #485–#490 + review #484 收口刀,2026-07-03 归档;沿 v0.26.0 报告归档先例)/ **两份已冻结·尚未实施的 T0 施工依据**(2026-07-29 拍板冻结):[`certificate-standard-library-t0-review.md`](./archive/reviews/certificate-standard-library-t0-review.md)(通用证书标准库 + 队内认定规则 + 招新证书闭环;PR-0~PR-7,PR-4 已拍板拆 4a/4b)与 [`wecom-integration-t0-terminal-review.md`](./archive/reviews/wecom-integration-t0-terminal-review.md)(企业微信接入;T0~T6,`D-WC-1..31` 按推荐冻结)—— 二者**排期串行:证书先、企业微信后**,活跃台账在 [`ai-harness/NEXT_TASKS.md`](./ai-harness/NEXT_TASKS.md) P1-24 / P1-25。**证书标准库已于 2026-07-30 实施完毕**,其 post-freeze 修正记在 [`certificate-standard-library-t0-amendments.md`](./archive/reviews/certificate-standard-library-t0-amendments.md)(冻结稿正文不回改;**两份合起来才是当前需求**,冲突时以 amendments 为准) / **通用系统集成地基 T0**(2026-08-19 冻结):[`integration-foundation-v1-t0-terminal-review.md`](./archive/reviews/integration-foundation-v1-t0-terminal-review.md) —— ServicePrincipal + DelegationGrant + 第六 canonical surface `integration/v1`;T0 → PR1–PR8,**PR1 起一行未实施**,台账 P1-30 |
| [`archive/batches/`](./archive/batches/) | 批次 5-A / 6 / 7 / 8 的 API 前评审、业务确认稿、业务访谈提纲、V2.x 立项记录(中文文件名) |
| [`archive/plans/`](./archive/plans/) | 历史阶段计划:v1.3 / v1.4 / first-release readiness / bizcode mapping / bootstrap SOP / frontend scope / API client boundary migration plan / **Harness 3.0 重构蓝图 + 规则执法矩阵**(`harness-3.0-blueprint.md` + `harness-3.0-rule-enforcement-matrix.md`,2026-07-28 拍板冻结,P1–P7 施工依据) |
| [`archive/prisma-migration-history.md`](./archive/prisma-migration-history.md) | prisma migration 历史链(2026-07-23 前),从 `CODEMAP.md` 单元格搬出并**冻结不再增长**(Harness 3.0 P4b:该链曾占 CODEMAP 27% 且无退场机制);之后的 migration 说明只写在 PR body 与 CHANGELOG |
| [`archive/legacy/`](./archive/legacy/) | 自承"历史归档"的早期收尾报告(`FINAL_REPORT.md`) |
| [`archive/ai-harness/`](./archive/ai-harness/) | 2026-06-10 全仓 Review 总报告与 AI Harness 底座设计(冻结快照;旧操作层 9 文档 + 3 模板已于同日瘦身收口为 `ai-harness/README.md` 单页,文内相对链接属预期死链);同目录 `rbac-map-stamps.md`(逐 PR 权限地图戳)与 **`next-tasks-completed.md`**(NEXT_TASKS 已收口项,2026-07-29 P7 熵清理搬出,冻结不再增长) |

---

## 3. How to decide authority

冲突时按以下顺序判定:

1. **当前事实** → [`current-state.md`](./current-state.md)
2. **长期铁律** → [`../AGENTS.md`](../AGENTS.md) + [`srvf-foundation-baseline.md`](./srvf-foundation-baseline.md) + [`V2红线与复活路径.md`](./V2红线与复活路径.md) + [`api-surface-policy.md`](./api-surface-policy.md)
3. **流程** → [`process.md`](./process.md)
4. **架构设计背景** → [`../ARCHITECTURE.md`](../ARCHITECTURE.md)(请先读其顶部"当前阶段说明")
5. **历史证据** → [`archive/**`](./archive/)

`archive/**` 内的任一文档,只有在 (1)~(4) 都未覆盖某具体场景时,才作为辅助参考。

---

## 4. What NOT to read as current truth

- ❌ `archive/handoff/v*.md`:已合入的 release 历史快照,字段、状态、PR 编号都冻结在 release 时刻;**当前版本状态以 [`current-state.md`](./current-state.md) §1 为准**
- ❌ `archive/reviews/**`:评审稿在被实施落地后,**实施细节会演进**(BizCode 段位补全、字段命名调整、限流参数调整);**实际代码以 `src/**` 为准**
  - ⚠️ **例外 —— 已冻结但尚未实施的 T0 评审稿是施工依据,不适用上一条**。当前两份:`wecom-integration-t0-terminal-review.md`(企业微信;T1–T5B 代码已合入,T6 剩「维护者执行」项)与 [`integration-foundation-v1-t0-terminal-review.md`](./archive/reviews/integration-foundation-v1-t0-terminal-review.md)(**通用系统集成地基 Integration Foundation v1**;T0 已冻结,PR1–PR8 **一行未实施**)(沿 `archive/plans/harness-3.0-blueprint.md` 先例)。它**实施完成后**才转为「以 `src/**` 为准」的历史证据;在此之前,实施若需偏离,必须暂停并另出 superseding 评审稿,**不得顺手回改冻结稿**。哪份处于哪个阶段以 [`ai-harness/NEXT_TASKS.md`](./ai-harness/NEXT_TASKS.md) 为准
  - 📌 **`certificate-standard-library-t0-review.md` 已实施完毕(2026-07-30)**,但它有一份**并列有效**的 post-freeze 修正:[`certificate-standard-library-t0-amendments.md`](./archive/reviews/certificate-standard-library-t0-amendments.md)。冻结稿正文一个字未改 —— 冻结的价值在于「当时到底是怎么定的」可复原,回改会让所有引用它的 PR 描述与审计记录指向一份已经不同的文本。**读需求时两份都要读,冲突以 amendments 为准。**
- ❌ `archive/batches/**`:各批次冻结时刻的业务决议;**业务诉求若发生变化,需通过新的评审稿覆盖**
- ❌ `archive/plans/**`:阶段开始前的执行计划;**实际执行可能偏离计划**
- ❌ `archive/legacy/FINAL_REPORT.md`:v0.1.3 时代的收尾报告;**与当前状态无关,当前版本以 [`current-state.md`](./current-state.md) §1 为准**

---

## 5. 增删文档原则

- 新增"当前生效"文档:**必须**在本文件 §1 列出,且必须明确"用途"与"权威等级"
- 新增"归档"文档:直接放入对应 `archive/<分类>/`,本文件 §2 无需逐文件列出(查 `ls archive/<dir>/` 即可)
- 删除文档:**禁止**;只允许移动到 `archive/` 子目录
- 把归档文档"复活"回 `docs/` 活跃位置:**必须**单独立项并更新本文件 §1 / §2

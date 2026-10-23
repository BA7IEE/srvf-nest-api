# Release 5 受限 500 人首发：完整实施 Goal（维护者已批准）

状态：维护者已明确回复“批准完整方案，并委托六条精确 grant（推荐）”；本节方案与精确写集据此冻结。当前仅实施 D1，D2 尚未开始。基点 `main@dc9218d0b037643f5f29ae75715ac3e4a20a1034`；远端 main 相同、open PR 为 0、最近 Release/package 均为 v0.72.0。主工作树 clean。以下临时候选和生成预览均在仓库外，不代表新 SHA 的 CI 或部署通过。

完整精确写集：60 文件 JSON（维护者确认的仓外送审材料），SHA256 `1e3a0be545d91d91ee9dc1d0a36a5b2187d614184b4fe5b25b1d3f35fa3198b9`。逐文件目的、阶段及红区范围见下表；送审JSON保存了全部现存文件基点SHA256。6 个精确红区路径已由原 `harness:needs` 实算，其余 54 个不需要 grant；原始预算（维护者确认的仓外送审材料）。本包不授权清单外文件。

## 已有决定，直接承接

- 首发受限 500 identities / 500 current segments / 500 current allocations；2500 physical slices、2000 evaluations 等全部维度继续由 `NATIVE_CONTRIBUTION_LAUNCH_LIMITS` 限制。原始 2000 identities / 10000 segments / 50000 slices 规模仍 NOT_VALIDATED。
- `docs/current-state.md:94–95`、`NEXT_TASKS` 已将 AC-013 / AC-020 / AC-025 定为上线后按诉求立项，将 AC-017 搁置。这四条保持 todo，不转“已实现”或永久豁免。六条既有永久豁免不改。
- ADV-010 / P2-21 是首次生产前必做，不能随上述四项延期。
- 既有提交推送、正式评审、满足全部要求后正常 squash 合并及核验 main CI 的授权继续沿用；不使用 admin/force/跳过审批。
- 实际服务器身份与访问方式尚未确认；不等待这些信息开展仓内工作，也不向未知目标部署。生产启用、旧数据转换、shadow、worker 操作均未授权执行。

## 需要本次确认的一项业务口径

建议：贡献值复用现有单一 `ActivityWorkflowGate.participationReadSource()`。

- 闸关：逐字保留 approved 考勤、北京自然日全局封顶 3、入队年 3 月 31 日截止、门槛 5 的既有算法。
- 闸开：仅累计 `ParticipationLedgerEntry.creditedPointsDelta`，且关联 `LedgerPostingBatch.statusCode=committed`；更正/冲回和重放自然沿真实分录生效。账本已执行日封顶，读面不二次封顶、不混入 recognized 或 preparing/pending 分数。
- 同一响应/资格计算只使用当前闸选定的一源；不把旧考勤与账本相加、不按天取大值、不在账本空时偷偷回退。readonly 不改变取数源。不新增 flag，不回写考勤。
- 旧分保护是开闸前置：沿现有 `LegacyLedgerConversionService` 的只读维护窗工具先账本化，并核对旧考勤封顶分与 committed 分的逐人总分、相关 cycle cutoff 一致；有遗漏、无法解释的 `skipped-new-chain-history` 或不一致就停止。真实数据不存在时也须留零存量的盘点证据，不能因测试样本一致而宣称生产一致。
- 开闸后若需暂停，先进入只读维护态并保留新账本读源；代码没有永久 latch，直接关闸会读回旧考勤，不能把它描述成不会丢失新进度的回退。真实恢复/快照回滚仍需另行发布批准。

该建议重开的是 `activity-workflow.gate.ts:153–156`、`participation-summary-query.service.ts:69–70`、team-join 本地 CLAUDE 和 C4 判据的“贡献值恒 approved”决定锁。已按 `AGENTS.md §3` 先声明；需维护者认可新口径后才改。

备选：保留现状，依赖修复可单独完成，ADV-010 与首次生产继续阻塞。两边相加/按天取大值会新创合并口径，未获批准，不作为本包实现。

## 风险与精确行为变化

| 范围 | 变化与风险 | 判据/回退边界 |
| --- | --- | --- |
| 入队资格及成员汇总 | 闸开后贡献值来源改变；影响 admin/App 进度、评估、final join、生涯汇总 | 真 PG/HTTP、两活动同日封顶、跨日达到 5、准备中不可见、冲回、重放、batch 与单人一致；旧数据不一致则不开闸 |
| 旧数据迁移 | 现有转换已写真账本，但原 SOP 刻意不比较贡献值 | 本轮补充总分及 cycle cutoff 对账说明和真实转换样本测试；生产执行 NOT_RUN，不改历史 SQL/转换实现 |
| 机器守护 | C4/C8 必须识别新的只读闭包；禁止通过删保护让检查变绿 | team-join 可调用读源闸，写闸滥用仍拒绝；旧 calculator 反向约束保留；新增漏闸与错误放行的对照 |
| 首发验收范围 | 四项延期使全合同 9a 持续未完成，不能冒称全合同通过 | 默认完整检查保留严格 9a；显式 `--profile r5-limited500` 单列首发结论和四项延期，仍打印完整合同未完成。任意新增/遗漏/重复 ID、skip、失败、Jest 退出异常均拒绝 |
| 生产依赖 | 7 处有界调整，其中 deepmerge-ts 7→8 是作用域限定的 major override | Prisma/client 仍 6.19.3；临时目录真实 config 加载、validate/generate 通过。Node 24.19.0 与 Node 22.23.3 均完成临时 Prisma validate/generate 和 sharp runtime 预验；Node 22 下完整 CI/容器验证仍是合并前必要检查 |
| 契约与客户端 | 贡献字段含义变化，结构不变 | 精确 3 条 description；原生成器已预览：OpenAPI 3 处、ROUTE_AUTHZ 两处 inputDigest、13 份客户端均仅摘要；663 路由声明及 assertion patterns 不变。最终摘要在完成源码后重算 |
| 实际发布 | 未确认部署服务器，不能证明实际环境数据/配置/worker状态 | main CI 与临时 Smoke 只能证明制品；目标、旧数据、转换/shadow适用性、排空/稳定观察、10a/10b均保持单列 NOT_RUN |

两处既有 E2E 行为锁需随获批口径明确更新（不降低断言）：

1. `activity-v11-participation-read-consistency.e2e-spec.ts:358`：开闸夹具已有 0.5 分 committed 分录和 2 分旧考勤；成员贡献预期 2 → 0.5，增加不等于旧分 2 的反例。
2. `activity-os-r4-d8-official-time-cutover.e2e-spec.ts:515`：开闸夹具只有 1 分旧考勤，没有贡献账本；贡献预期 1 → 0，其余官方时长、人数、记录等断言不改。

另外三份直接调用贡献纯函数的 E2E 仅补传实际应用 Gate，不改原业务断言。所有手工构造 provider 的单测、批量通知自由 helper、module DI、DTO 后果面均已列入精确写集。

## 生产依赖精确候选

package/lock 精确补丁（维护者确认的仓外送审材料）；候选取证（维护者确认的仓外送审材料）。

| 配置 | 从 | 到 | 锁定候选 |
| --- | --- | --- | --- |
| sharp | ^0.35.3 | ^0.35.5 | 0.35.5及配套平台/libvips |
| multer override | ^2.2.0 | ^2.3.0 | 2.4.0（范围实际解析值） |
| fast-uri override | ^3.1.4 | ^3.1.8 | 3.1.8 |
| @nestjs/swagger>js-yaml override | ^4.2.0 | ^4.3.2 | 4.3.2；不扩大到所有 js-yaml |
| qs override | ^6.15.2 | ^6.16.1 | 6.16.1 |
| proxy-addr override | 无 | ^2.0.8 | 2.0.8 |
| @prisma/config>deepmerge-ts override | 无 | 8.0.0 | 8.0.0；不升 Prisma/client |

候选 `package.json` SHA256 `5d2b95923e418a02dde94f8acd1ae2f5156188def5132acb0c550a64b203bf14`；`pnpm-lock.yaml` SHA256 `7cc43484424c1467ea22219ace872682fb4d4d278a5eefae6b6e85de7a8009e0`。package +7/-5，lock +216/-229。只应用该候选；若安装必须新增不在补丁内的依赖变动，先取证，不笼统 update。

临时目录：正式 `pnpm audit:production` exit 0；critical 1→0、high 14→0、moderate 7→3、low 1→0。3 项 moderate 与 `docs/ops/production-dependency-audit.md` 既有 GHSA 和接受边界相同（request、fast-xml-parser、uuid），继续显式登记，不增 ignore、不降低阈值、不写成“零漏洞”。JSON 审计仍 exit 1；这是 pnpm JSON 报告行为，不能混写正式 high 阈值命令的退出码。COS 3 的零审计候选未采纳：依赖改为供应商 fork 名字，XMLBuilder 源码仍与旧受影响文件相同，不能凭 registry 零读数认定已修复。

独立 gpt-6-astra 只读方案复核：未发现阻断性方案错误或必须补入清单的调用方；60路径/6grant、基点摘要、patch边界及数据库生命周期一致。此结论不是实现代码 PASS。实现时重点核对 PostgreSQL date 与北京时间 cutoff，以及未 committed/旧考勤重叠/截止边界的真实负例。

## DoD（每条都要有精确版本证据）

1. 实际改动为获批 60 文件的子集，6 条 grant 仅按精确路径使用，结束撤销本任务 grant；分支 clean、无夹带，原 SQL147/权限/预算/开关不变。
2. 原全合同 9a 仍诚实报告四项 todo；显式首发 profile 只承接已拍板的四项延期，ADV-010 真绑定且通过，正/反对照证明没有放行未知缺口或失效仪器。
3. ADV-010 真 PG 两应用/两池并发、可观察实际锁等待：两活动共享同人同日上限，不超 3；与另一日累计达门槛 5，真实 admin/App 进度、评估/final join 复用同一读源。准备中、重放、更正、旧考勤重叠、北京时间截止边界、readonly 和旧分转换保护均有证据。不得仅造 DayState 数字冒充整条写链。
4. 依赖候选在 Node 22 目标工具链的完整相关验证与容器构建通过；最终 SHA 的正式生产依赖审计 high/critical 为 0，同三项 moderate 继续明示。
5. 500 限制及其他全部 native 维度保持拒绝超界；原最大规模不混为已验收。SQL147 NULL/有效V3重放、preparing/pending 跨重启及最终 native guard 后 callback 拒绝真实回滚证据在本轮受影响版本重新核验或逐项注明可复用输入与局限。
6. 契约仅 3 项贡献 description 改动，fields/types/required/routes/权限断言不变；原生成物 fresh，snapshot diff 可逐行解释。
7. 固定代码独立跨模型评审通过；维护者真正复核 6b 新读面闭包并明确签字后才登记。相关普通 CI/五 E2E/Trusted/Smoke 达到要求后按已有授权正式评审和正常合并，核验实际 main push CI 与 Smoke。旧 SHA 绿灯不覆盖新 SHA。
8. 发布前结果分别列：仓内受限500 readiness、完整合同、原最大规模、实际环境条件。未证实的服务器/旧数据/转换/shadow/fleet开关一致/worker排空/稳定观察/10a10b均 NOT_RUN，仍阻止实际生产启用。

## 探针队列与 D 档串行交付

- D1：仅生产依赖修复 PR（package、lock、对应 ops、fragment、完整 Goal）。探针：实际版本、官方审计、Prisma/config、sharp runtime、quick、受影响上传/代理/SMS/存储验证及 Node22 全量 CI/容器。没有缺口才合并并验证 main。
- D2：首发范围与 ADV-010 的一个可独立验收 PR（本清单其他源码、全部测试后果、生成物与交接，完整 Goal 在仓内包含全部60路径和授权边界，可追加本阶段事实）。先跑旧路径 characterization 和新缺口红例；随后实现，定向真数据库/HTTP、守护正反例及生成物检查。红区/签字按下段处理，不夹带依赖大版本工作。
- 发布前验证：在最终合并的实际 main 上运行明确 profile、严格全合同检查、正式生产审计并 dispatch 既有只读 `release-audit.yml` 工作流核验 SHA；核验 main CI 与 ephemeral Docker Smoke。结果附原 PR，不另开纯状态 PR。若发生真正范围外问题，先集中只读排查完整后果再上报。
- 遵循 process §7.1 两轮失败熔断与精确取证；不加 timeout、不删测试/放宽断言、不盲重跑。输入未变的旧证据仅按 §7.2 明确说明后复用。
- **D7 精确例外（维护者 2026-10-22 12:01 UTC 明确回复“批准啊”）**：仅 Human 更正提交 V2/V3 首次与重放采用具名 15 秒事务预算；普通操作默认 7 秒、legacy apply、直接账本提交及每次 4 秒取锁均不变。该值是待验证工程余量，不是响应时间或生产容量承诺。所有校验、锁、审计/outbox 与原子回滚保留；增加真实 PostgreSQL 的超过 7 秒完整提交、超过 15 秒全部回滚/锁释放及同目标重试不重复生效验证。仅在同 PR 实施、定向验证、正常推送和必要最终 CI；不扩展其他预算、DDL 或生产权限。

## 授权清单与精确 grant 委托

本次确认建议一次覆盖：以上新来源口径、60 文件范围、明确两处 E2E 行为锁更新、实现/补测/清单内修复/文档与生成、提交推送及两阶段串行 PR；已有条件评审/合并/main 核验授权继续沿用。

AGENTS.md §1 原文：“**AI 不得自行发放授权。**”因此需要维护者明确委托当前会话仅通过正常 `harness:grant` CLI 发放并在结束撤销以下六条精确路径（不用目录 glob、无预算或 ACL 改动）：

```sh
pnpm harness:grant 'package.json' --reason '维护者批准 Release5完整送审包 D1；write-set sha256:1e3a0be545d91d91ee9dc1d0a36a5b2187d614184b4fe5b25b1d3f35fa3198b9'
pnpm harness:grant 'pnpm-lock.yaml' --reason '维护者批准 Release5完整送审包 D1；同一精确写集'
pnpm harness:grant 'scripts/check-activity-workflow-gate.ts' --reason '维护者批准 ADV010单闸来源口径与C4/C8闭包；同一精确写集'
pnpm harness:grant 'scripts/cutover-check.ts' --reason '维护者批准500首发profile，完整合同仍严格；同一精确写集'
pnpm harness:grant 'test/contract/__snapshots__/openapi.contract-spec.ts.snap' --reason '维护者批准精确3项贡献description；禁盲更新；同一精确写集'
pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason '维护者批准原生成器刷新inputDigest，663条权限声明不变；同一精确写集'
```

仅在所需阶段发放对应 grant；本任务 grant 清除后验证列表。若发现其他任务令牌，保留并报告，不全局清除。

本次确认是范围/实施口径和精确 grant 委托，**不能代替完成代码后的 6b 人类复核或每个新 SHA 的 Trusted environment 审批**。两者须在具体候选可审阅时按仓库要求完成。Ready/合并沿原授权有条件推进；生产及发版 tag/publish 不包含在内。

## 验证范围与数据库生命周期

- 此次送审前：只读 preflight / dev-guard / live GitHub 核对及仓外依赖、DTO原生成器预览；未运行数据库测试、未改主仓依赖或代码。候选 Prisma validate/generate 不连库，sharp 测试仅内存合成缓冲；两者已分别在 Node 24.19.0 和官方校验摘要匹配的 Node 22.23.3 下通过。
- 获批后的云工作区本地：只复用现有本机 Postgres 的 `app_test` 模板和 `app_test_w1` worker。标准 globalSetup 可幂等创建模板、对模板执行已审查 `migrate deploy`、在零连接检查后重建 worker、清理 `tmp/storage-w*`；测试夹具在 worker 内正常写入/清理，globalTeardown 回收 worker、模板保留。单条 Jest 命令串行，`--runInBand`、`SRVF_TEST_RUN_SCOPE=app_test,app_test_w1`，不并跑 contract/e2e。
- 不设置 `SRVF_D8_2_W98` / `SRVF_E4_W98` 等专用 scratch 开关；D8/E4 定向验证走标准 w1。更大的原始规模/具名 scratch 证明不因此重新获准。CI 仍在既有 GitHub-hosted 隔离 PostgreSQL/worker 中运行原五分片，配置不改。
- 标准入口：`pnpm agent:check:quick`；相关单测及完整 typecheck/lint/build/harness；`pnpm test:contract`；`pnpm exec jest --config test/jest-e2e.config.ts --runInBand --runTestsByPath <下列选定文件>`，按所涉模块覆盖、不改变 runner 配置。
- 定向 E2E 包括：新增 ADV010；team-join/admin/App/三份 member-lock/生命周期/身份不变量；notifications participation producer 和终审贡献阈值并发；app check-ins；legacy conversion；v11 participation read consistency；D8 official time；参与统计/overview/scoped authz；R5 E4 500 scale/HTTP/并发/更正/SQL147 source hash；E5 active matrix（含 preparing/pending 重启与 guard后 callback rollback）。依赖阶段另覆盖 attachments upload、app avatar、trusted-proxy identity、SMS settings/login 与已有 COS provider 单测。所有文件均现有，不为验证新增范围外源码改动。
- 原 `docs:openapi/authz/feclient/codemap/rbacmap/counts/readtax/migcount` check；`check-frozen-drafts-ledger.ts`；`cutover:check:selftest`、默认 strict 与显式 profile；`cutover --signoff` 对拍。
- 常规 CI 与 Docker Smoke 按既有自动触发；Production dependency audit 允许 dispatch 最终 SHA（工作流 contents:read，不改部署）。可做定向本地 detectOpenHandles；Nightly leaks 工作流会自动创建/评论 issue，本包不触发该外发流程，当前完整 nightly 证据不能自行写成通过。

## 禁止域与最终报告

不改 schema/migrations/SQL历史/DB函数或ACL、Permission/AuditEvent/BizCode、seed、harness预算、workflow、测试全局setup、全局auth/bootstrap、原始最大规模阈值与500所有native约束；不改旧贡献 calculator 算法；不引入新通知触发或前端页面；不强推/强合/清理他人分支或数据；不操作未确认服务器；不部署/启用/生产转换或shadow，不打tag、不发布GitHub Release。

最终交付：两个阶段 PR/最终 SHA/main CI 与 Smoke/正式 audit 证据、全部变更精确列表、四项延期与原始最大规模、具体服务器与现场验收缺项，并按 AGENTS.md §2 单列“本次未做”。

## 获批精确写集（60个唯一路径）

| 阶段 | 路径 | 目的 | 红区 |
| --- | --- | --- | --- |
| D1 | `package.json` | 7处有界版本/override调整；版本号仍0.72.0，审计high阈值不变 | 是 |
| D1 | `pnpm-lock.yaml` | pnpm10.14.0原生成锁；Prisma/client6.19.3、COS2.15.4不变；multer实际锁2.4.0 | 是 |
| D1 | `docs/ops/production-dependency-audit.md` | 登记1C/14H/7M/1L到0C/0H/3M/0L与同三项既有moderate分析，明确JSON退出码区别 | 否 |
| D1 | `changelog.d/activity-os-r5-production-audit.md` | 依赖修复fragment，不归并已发布CHANGELOG | 否 |
| D1 | `docs/plans/activity-os-r5-limited500-release-readiness.md` | 同一完整Goal、风险表、A/B方案、精确写集、已批准口径及阶段结果；不另起状态PR | 否 |
| D2 | `src/modules/team-join/team-join-progress.ts` | 必传现有Gate；off原approved封顶核；on仅SUM committed credited delta；北京日cutoff、单/批同源、空人0、不二次封顶 | 否 |
| D2 | `src/modules/team-join/team-join-progress.spec.ts` | 保留旧读数characterization，增加新源/冲回/批量/空集/日界/只读矩阵 | 否 |
| D2 | `src/modules/team-join/team-join-applications.service.ts` | admin进度、标gate、评估调用传真实Gate，权限/锁序不动 | 否 |
| D2 | `src/modules/team-join/team-join-applications.app.service.ts` | App本人进度三处调用传真实Gate，准入/锁序不动 | 否 |
| D2 | `src/modules/team-join/team-join-enrollment.service.ts` | final join贡献资格读取传真实Gate，门槛5/锁序/保险闸不动 | 否 |
| D2 | `src/modules/team-join/team-join.module.ts` | 从common ActivityWorkflowModule正常DI；不导入ActivitiesModule或改AppModule | 否 |
| D2 | `src/modules/team-join/team-join.constants.ts` | 仅更新原approved-only/封顶位置注释；3分日上限/5分资格/日期算法不改 | 否 |
| D2 | `src/modules/team-join/CLAUDE.md` | 记录新获批来源口径，保留member/事务/保险限制 | 否 |
| D2 | `src/modules/attendances/attendance-read.service.ts` | 成员生涯贡献汇总传真实Gate | 否 |
| D2 | `src/modules/attendances/attendances.service.spec.ts` | 手工构造AttendanceReadService补齐Gate假件，旧断言保留 | 否 |
| D2 | `src/modules/attendances/participation-summary-query.service.ts` | 现有admin/App成员汇总传已有Gate，更新刻意approved-only旧注释 | 否 |
| D2 | `src/modules/attendances/attendance-notification-producer.ts` | 现有考勤终审before/after批量读数及自由helper传真实Gate；不新增新账本阈值通知触发 | 否 |
| D2 | `src/modules/attendances/attendance-notification-producer.spec.ts` | 7处手工构造及封顶/跨阈值原断言保留 | 否 |
| D2 | `src/common/activity-workflow/activity-workflow.gate.ts` | 仅将贡献读面加入现有单闸取数说明；不改enabled/readonly开关行为 | 否 |
| D2 | `scripts/check-activity-workflow-gate.ts` | C4允许team-join只读取数闸，仍拦写闸滥用；C8纳入team-join统计闭包，保留contribution-calculator反向守护 | 是 |
| D2 | `src/common/activity-workflow/activity-workflow-gate.criteria.spec.ts` | 替换获批旧口径行为锁，增加漏闸/写闸滥用/真阳性/真阴性对照，其余C1-C8不放宽 | 否 |
| D2 | `scripts/cutover-check.ts` | 默认全合同9a不变；新增显式r5-limited500口径，仅四个既有延期ID可区分；采集真实Jest用例/退出码，独立报告full与首发；unknown/duplicate/missing/skip/failure fail-closed | 是 |
| D2 | `src/cutover-r5-release-profile.spec.ts` | profile解析、四延期精确匹配、ADV仍TODO必拒、遗漏/重复/新TODO/失败/仪器失效反例；导入不运行CLI | 否 |
| D2 | `src/modules/activities/activity-business-overhaul-acceptance.spec.ts` | 新R5去向表把ADV-010绑定真实PG并发入队进度用例；不改历史卡点表和六项永久豁免；四项延期保留todo | 否 |
| D2 | `docs/ai-harness/FROZEN_DRAFTS.md` | 原生成器刷新验收读数；不修改冻结历史文件 | 否 |
| D2 | `docs/ai-harness/CUTOVER_SIGNOFF.md` | 预列6b登记路径；仅在固定代码和维护者真正复核后的明确结论登记新闭包读数，不能本次范围批准自动代签 | 否 |
| D2 | `test/e2e/activity-os-r5-adv010-contribution-progress.e2e-spec.ts` | 新增真实PG两Nest/两pool并发：同人同日两活动生效、封顶3、跨日到5、真实入队读面、准备中不可见、重放/冲回、旧分转换+cutoff一致；不直接伪造有效账本 | 否 |
| D2 | `test/e2e/team-join-gate-evaluate-member-lock-concurrency.e2e-spec.ts` | 5处直接调用computeContribution传app实际Gate；原并发锁/资格断言不动 | 否 |
| D2 | `test/e2e/notifications-participation-producers.e2e-spec.ts` | 6处直接调用computeContribution传app实际Gate；现有通知断言不动 | 否 |
| D2 | `test/e2e/app-activity-check-ins.e2e-spec.ts` | 1处直接调用computeContribution传app实际Gate，旧路径断言不动 | 否 |
| D2 | `test/e2e/activity-v11-participation-read-consistency.e2e-spec.ts` | 获批新口径下唯一贡献断言2→0.5（已有committed账本），同时断言不等于旧分2；服务时长等不变 | 否 |
| D2 | `test/e2e/activity-os-r4-d8-official-time-cutover.e2e-spec.ts` | 获批新口径下唯一贡献断言1→0（夹具仅有旧考勤，没有贡献账本）；其余官方时长/汇总断言不变 | 否 |
| D2 | `src/modules/attendances/attendances.dto.ts` | 成员贡献汇总仅3项之一description及相关旧口径注释；字段/类型/required不改 | 否 |
| D2 | `src/modules/attendances/participation-summary.dto.ts` | Admin贡献汇总仅description及相关注释；不改变字段/类型 | 否 |
| D2 | `src/modules/attendances/dto/app/app-my-participation-summary.dto.ts` | App独立DTO贡献description及注释；不继承Admin | 否 |
| D2 | `test/contract/__snapshots__/openapi.contract-spec.ts.snap` | 精确替换3条贡献description（匹配完整description行），逐行审查；禁盲-u | 是 |
| D2 | `docs/ai-harness/ROUTE_AUTHZ.md` | 原生成器刷新inputDigest，权限声明/断言族不变 | 是 |
| D2 | `docs/handoff/clients/admin/client.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/admin/types.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/app/client.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/app/types.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/auth/client.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/auth/types.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/integration/client.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/integration/types.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/open/client.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/open/types.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/shared/types.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/system/client.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/clients/system/types.ts` | 原FE生成器刷新inputDigest；预览实际13份均只变摘要 | 否 |
| D2 | `docs/handoff/openapi.json` | 原生成器刷新3项schema字段description | 否 |
| D2 | `CODEMAP.md` | 原生成器更新team-join/attendances行数与E2E计数443→444 | 否 |
| D2 | `docs/current-state.md` | 承接AC013/020/025延期和AC017搁置；列500首发与原最大/生产未验；按实际写ADV/审计状态 | 否 |
| D2 | `docs/ai-harness/NEXT_TASKS.md` | P2-21/ADV010仓内闭合证据与新来源决定；保留部署旧数据核验未执行条件 | 否 |
| D2 | `docs/participation-bounded-context.md` | 更新贡献跨模块取数边界与单闸，旧考勤仍保留 | 否 |
| D2 | `docs/handoff/admin-web.md` | 说明新贡献读源、3分日上限/5分资格/cutoff不变与四项首发延期 | 否 |
| D2 | `docs/handoff/miniapp.md` | 说明本人贡献读源与首发延期，字段不变、前端实施不在本轮 | 否 |
| D2 | `docs/ops/legacy-attendance-ledger-conversion.md` | 转换后核验新增贡献总分/入队cutoff逐人一致，skipped不能自动视成功，真实环境仍待确认 | 否 |
| D2 | `docs/ops/activity-contribution-settlement.md` | 记录显式500profile、严格全合同差别、旧数据转换核对、只读回退与发布输入缺项 | 否 |
| D2 | `changelog.d/activity-os-r5-limited500-adv010.md` | 首发范围与ADV-010实现fragment，不动已发布版本章节 | 否 |

## 实施收据（只追加已核实事实）

D1 候选冻结时（2026-10-18）：package/lock 与获批摘要逐字相同，Node 22.23.3 / pnpm 10.14.0 安装和 Prisma generate 通过；正式生产审计 exit 0（0 critical / 0 high / 3 moderate / 0 low）。461 套单测共 10288 通过、5 项既存 todo、8 份 snapshot；contract 1092 通过、2 份 snapshot；上传／头像／trusted proxy／SMS settings／SMS login 五套真实PG回归共85通过。OpenAPI、FE客户端、ROUTE_AUTHZ及冻结稿台账检查通过。

首次 quick 的 typecheck/unit/harness 均 exit 0，lint 因 Node 默认约4GiB堆耗尽而 exit134，故该次 quick FAIL。按现有 CI 的 `NODE_OPTIONS=--max-old-space-size=6144` 重跑进行中；首次失败保留，不计为已全绿。最终结果附相同候选的 PR 验证节，不用后续改文档产生新代码候选来覆盖首次失败。

此处是冻结时快照。独立固定SHA评审、该SHA普通CI/Trusted/Smoke、合并与main核验另看对应PR；D2、6b、部署与生产开关尚未完成。

## D1 兼容修复补充批准（2026-10-19）

维护者明确回复“批准9个新增路径、阶段调整及两条精确 grant（推荐）”。原60文件冻结清单保留；本节向完整目标追加下列9路径，完整目标变为69路径，D1从5变为15文件。既有 `docs/ai-harness/ROUTE_AUTHZ.md` 从D2提前在D1由原生成器刷新；D2输入变化时仍须重新生成。原package/lock精确候选、两个串行PR、四项延期和500限制不变。

| 新增路径 | 本次范围 |
|---|---|
| `src/modules/activity-registrations/controllers/app-registration-upload-sessions.controller.ts` | 去除与Multer2.3+重复的文件大小+1补偿，保留原错误码及service前拒绝 |
| `src/modules/users/controllers/app-me.controller.ts` | 头像同因补偿修正，行数不变 |
| `src/modules/members/members.controller.ts` | 标准照同因补偿修正，行数不变 |
| `src/modules/attendances/controllers/app-managed-activity-onsite-operations.controller.ts` | CSV导入同因补偿修正，行数不变 |
| `test/e2e/app-me-avatar.e2e-spec.ts` | 新增精确上限正常上传及首个超额字节在service前拒绝，原断言保留 |
| `test/e2e/member-official-portrait.e2e-spec.ts` | 新增同样两项标准照边界，原断言保留 |
| `test/e2e/activity-batch6-staff-import-offline.e2e-spec.ts` | 新增同样两项CSV边界，原断言保留 |
| `test/setup/test-db.ts` | 重建复用既有同快照分类器，普通DROP；不终止连接、不重试 |
| `test/setup/test-db.lifecycle.spec.ts` | 保留并扩展同快照拒绝、脱敏、竞态及无FORCE/termination/retry检查 |

新增两条精确正常CLI grant的委托仅为 `test/setup/test-db.ts`、`test/setup/test-db.lifecycle.spec.ts`；ROUTE_AUTHZ沿用原精确委托，禁止通配grant。测试库生命周期继续仅 `app_test` / `app_test_w1`。实现、清单内修复、验证、生成物与文档、同PR推送及条件合并沿既有授权推进；每个新SHA的Trusted仍后置，6b仍待D2固定代码后实际复核，生产/转换/shadow/开关/tag不包含。

失败事实保留：[95c38e4f普通CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/39141830013) 分片2、3失败。注册上传10MiB+1进入service后才拒绝已在本地复现；补充的头像、标准照、CSV三个真实HTTP红例均为“精确10MiB成功，超限1字节调用了service”，共3通过/3预期失败。原注册上传断言逐字保留。官方Multer2.3也有同型语义，退回2.2会恢复high，故保持已批准依赖候选。

数据库失败原判定快照计数1、后独立分类none，连接来源仍 **UNKNOWN**，本地R3该套通过仅记未复现。候选使重建与既有清理入口一致：仅PostgreSQL明确分类的autovacuum不阻止普通DROP，client/parallel/unknown及损坏或失败观察仍阻断，普通DROP继续兜住检查后连接竞态。不得把策略一致性修正写成已确认原CI根因。

上述9路径及ROUTE已按获批候选落地，10份逐文件摘要与送审候选相同；package、lock、权限断言族及CODEMAP字节未变。ROUTE仅两处inputDigest变化，663条声明不变。正本不触库范围/生命周期60项回归通过；完整应用回归、最终候选CI与合并/main核验仍以PR的版本化验证记录为准。

## D2承接与集中配套授权（2026-10-19）

D1已在正常合并后核验实际main CI五E2E及Smoke；D2基点为`c8c15843423418a8fe3555a644f71eb2e3fc0d12`。这不预签D2检查，也不代表部署。本节追加承接，前面的60路径/3项metadata为原冻结送审快照；连D1兼容性扩围及本次5路径，总计74唯一路径，D2涉及61路径。

维护者明确回复“批准五路径及八项快照 grant 范围（推荐）”（会话`call_faf827c097f944a9af3215826fabb485`）。本次补齐以下原清单遗漏；原生成器仓外精确预览补丁SHA256为`8bdca72b719799e5780533efdf4fc9d75bb8f22808b2e73e71358d08148bf167`：

- `src/modules/attendances/controllers/admin-member-attendance.controller.ts`
- `src/modules/attendances/controllers/app-my-participation-summary.controller.ts`
- `src/modules/team-join/team-join.dto.ts`
- `src/modules/team-join/dto/app/app-team-join.dto.ts`
- `src/modules/attendances/participation-ledger-totals.dto.ts`

契约文本由原3条贡献description扩大为5条description+3条operation summary，共8值。snapshot委托仅原同一路径的这8值；无盲-u。13份客户端除摘要还同步admin两条、App一条方法注释。类注释明确第7批“未改四数”为历史时点；字段/type/required/nullable/route/tag/权限不变。未扩围修改已知的活动级approved metadata及另外6条时长/次数字段description旧债，不做全局替换。

C8新读者使用共享where-helper后，原双向交替传播会把一核闸位传给另一核。依原批准的两个守护路径修正为从direct种子分别计算上下行独立闭包，增加实际单核/双核漏闸、共享helper菱形负例及合法单向传播正例。仍为文件内语法近似，不宣称控制流支配或跨文件完备性，不启动P2-22注册表。

真实PG先已复现committed2分而进度0；接线后六项PG场景与125项核心单测通过，最终检查、独立评审、6b人签和本SHA Trusted仍后置。正式队员保留负责人/发起人资格，志愿者独立参与并申请入队；不通过改变负责人级别规避真实资格。并发从两实际Nest启动真实commit service命令，窗口内用真实admin/App HTTP刷新；没有公开commit HTTP入口，不称败方收到HTTP409，只断真实Biz20084及其409映射。

实际生产数据盘点/转换与shadow适用性/worker排空/稳定窗/10a10b仍NOT_RUN；原R5最大规模仍NOT_VALIDATED，500全部native维度及生产NO_GO不变。6b只在固定实现/闭包/证据经维护者实质复核后登记；本范围批准不代签。生产/开关/转换/shadow/worker/tag/Release均不执行。

### 从current-state迁入的历史9a读数（逐字保留）

以下为2026-08历史事实，不作为本轮当前读数；迁入是为了保留原证据并满足原恒读预算，预算未改。

**2026-08-25 实跑读数:A 类 10/11 过,唯一硬红仍是 9a** —— 验收 `84 通 / 19 待 / 0 败 / 103 总`
(2026-08-24 分拣刀把 32 条待办判成 A 14 / B 4 / C 14 并接通 2 条 ⇒ 30 待;
2026-08-25 实施刀写完 A 档 11 条、退回 1 条 AC-063 到 B 档 ⇒ 19 待。逐条依据见 `NEXT_TASKS` P1-28;
**9a 仍红是预期的** —— 剩 B 档 5 + C 档 14,那些卡的是能力 / 规模方案,不是缺用例)。
⭐ **2026-08-27 实跑读数(docs 对齐刀,`743abb5b`):A 类 12/13 过,唯一硬红仍是 9a** ——
验收 `103 通 / 9 待 / 0 败 / 112 总`;B/C 签字已满 10 条,**①–⑧ 整条收口**,⑨ 卡 9a、
⑩ 待 10a/10b(部署侧产物 + 演练记录,机器无从判)。19 → 9 的链:AC-063 真竞态接通(#1185)、
AC-064/066/ADV-022 接通(#1194)、万人档 4 条转永久豁免(#1196);**剩 9 条全部 C 档能力缺口**
(AC-009/010/013/017/020/025/047/067 + ADV-010,ADV-010 卡 P2-21 分账本合并)。

## D2实施后人签与原D8数值事实订正（2026-10-19）

维护者审阅实施后集中包及精确输入后明确回复「认可6b并批准D8精确更正（推荐）」（会话 `call_fba81147fb57441792b9388337fa1cfa`）。此为实际6b人类判断，区别于前面的实施范围/grant委托；已据此登记6b当前六函数/四文件并保留2026-08-26原4/3首签历史。C1–C8实际零finding；两锚分别为 `gate-settlement-read-faces=6`、`gate-read-files=4`。

| 实际C8文件 | 当前发现函数 |
|---|---|
| `src/modules/activities/activity-participation-query.service.ts` | `reconciliation`、`participationSummary` |
| `src/modules/attendances/participation-summary-query.service.ts` | `loadPositiveSummary` |
| `src/modules/meta/participation-overview-query.service.ts` | `getOverview` |
| `src/modules/team-join/team-join-progress.ts` | `computeCappedContribution`、`computeCappedContributionBatch` |

认可仍限于「读旧考勤结算列并对外产出结算量」的文件内语法发现面；不证明跨文件支配、任意ActivityCheckIn/AttendanceSheet或`$queryRaw`读者，P2-22保持开放。两核的单独/全部删闸、共享helper菱形污染与单向合法调用均有反例/正例；原calculator反向保护及写闸保护保留。

原送审包关于D8「无贡献账本」的说明有误：该既有case先按`pointsBelow:2`真实prepare/finalize/commit，再插入旧approved贡献1。首次14组读面PG为213通过/1失败/0skip，失败正是已批0与真实credited2不符。维护者本次明确把原1→0订正为原1→2；精确补丁SHA256 `3d7302ac25461a5b465f9a09f1750f48e642fb593ebb26b80f2a18ae568d5f1d`。已加同成员/活动/committed的SUM2及不等旧1断言，其他官方时间、人数、记录、直方图断言保留。独立astra复核了真实提交前置并纠正了其前轮未追透此链的判断；失败回执保留，不称首轮全绿。

完整冷lint首次发现新增E2E五处格式差异，原ESLint修正后2018文件零错；随后完整类型检查发现profile负例参数化把数组展开为字符串，已改成具名`argv`案例，逐个实际传入数组，保留全部九项拒绝断言。上述均为本清单内修正，不扩路径/grant，不改生产行为。最终完整quick、定向PG/contract与固定候选独立复审及CI另按实际版本记录。

本轮复验同一获准测试库内的真实native-admission 500/500/2500/2000及超界/长源拒绝、SQL147、E4 HTTP/并发/更正、E5 preparing/pending重启与native guard后callback回滚；常规scale套件保留原始最大规模的默认排除，不重新声明原最大规模验收。生产、Trusted及实际发布准入仍独立，10a/10b与实际目标项保持NOT_RUN。

### 最终本地验证过程的台账格式修正

最终完整quick的冷lint（2018文件）及三组typecheck通过后，全量单测为10347通过／1失败／4延期TODO。唯一失败是冻结稿与NEXT_TASKS交叉登记：本轮把P1-28固定`**状态**:`标签改成「历史状态」，令解析器读到零行；同样的P2-21带R5标签也一并修正。现恢复原规范标签及合法状态取值，P1-28原历史正文以引用段逐字保留，当前状态明确四项延期；P2-21登记当前实现/人签与实际部署边界。未修改解析器、判据或测试断言。原NEXT_TASKS状态CLI、冻结稿CLI及对应单测均通过，随后重跑完整quick；后续结果以本PR实际回执为准。

获批D8更正已在真实PG复验通过；与六个ADV010场景共7通过、零失败/skip。实际默认严格cutover exit1且唯一A红9a（108通过／4延期TODO／112总）；显式r5-limited500 exit0，仍保留完整合同未过、10a/10b待确认与生产NO_GO。此为工作稿本地证据，不预报后续CI/Trusted/main或实际目标验证。

## D2账本属主与装配补充批准（2026-10-19）

完整quick已通过462套/10348项，四项既有TODO保留；Harness首次失败19项，原因是TeamJoinModule已改变domain-map的摘要输入而原写集漏列配套字段。仅刷新摘要后，原架构扫描器另查出team-join直接聚合ParticipationLedgerEntry形成两条新增跨域读取债。仓外候选A改为直接import公开LedgerQueryService，又与既有反向依赖形成新增循环；两稿均不靠baseline/allowlist或预算放宽通过。

本补充采用消费端口/组合根：LedgerQueryService持有committed/credited单人及批量只读原语，team-join的四个贡献函数必传第五参数，三个service通过token注入，AppModule唯一生产组合点传公开属主类；participation调用方结构兼容传同类。属主不import/implements消费端口；调用方原client/事务、成员锁、授权及before/after快照不变，缺token拒绝装配，不默认旧核或另取全局client。北京civil DATE cutoff、负分录、缺成员0、空批次不查询和一次groupBy保持。

集中新增路径唯四条：`src/modules/activities/ledger-query.service.ts`、`src/modules/team-join/contribution-ledger-reader.ts`、`src/app.module.ts`、`harness/domain-map.json`，总写集74→78、D2为61→65。AppModule原禁止域仅对公开类导入及register装配两处的例外已获批；domain-map只由原计算器更新inputDigest，属主/边/公开面/例外不改，state-machines摘要输入未变。两条新精确grant仅AppModule和domain-map；其余生成/调用/说明均在原清单。本段扩围与6b冻结新闭包已获维护者明确认可，实际回复和源码对拍见下方记录；Trusted与生产仍后置。

原61稿后续11套native验证为298通过/0失败，原始最大规模与S13最大数据probe两项按既有配置未运行；preparing/pending跨真实API及worker重启、native guard后callback拒绝的196表回滚通过。该证据不替代端口候选的新Nest/PG验证。端口候选的精确源码、4项原架构门禁、三组类型、原语形态单测与生成器检查见集中送审材料；未完成项不提前写绿。新实际C8仍为6面/4文件，owner/端口/组合根调用闭包变化须经维护者实质复核后才补登6b，P2-22语法局限不关闭。

本包不重开旧贡献口径、两处已批准E2E数值、四项延期、500/native限制、SQL147/函数ACL/权限/预算、生产NO_GO或两个串行PR决定。批准后在同一D2分支/PR连续完成最终验证、评审及既有条件合并，最终SHA的Trusted仍后置；实际服务器及生产操作、tag/Release均未包含。

### 属主端口实际授权与6b补签记录

维护者于2026-10-19北京时间，针对完整78路径、精确补丁与冻结15份源码的集中问题（call_7119aadc629d40baa00589cbe6b31882）明确回复：「批准四路径、两条精确grant并认可候选6b补签（推荐）」。该回复同时覆盖四条新路径、仅AppModule两处装配的原禁止域例外、两条正常CLI精确grant委托及候选新6b闭包认可；既有正式评审、推送、条件合并及main核验授权继续，生产/Trusted另算。

已分别通过原CLI仅授权`src/app.module.ts`和`harness/domain-map.json`，应用补丁SHA256 `15aa07c66b09eca8d6e3622b830ba75a4b66c391ce329dc440b5e344a28742b2`；应用后65候选文件与冻结预览逐字相同，15份6b源码逐项对拍如下。随后仅据上述实际人判登记CUTOVER_SIGNOFF，旧签字原文保留。本次登记时，真实B版本PG、完整Harness和最终CI尚未完成，不能据本签预报通过；最终版本结果以相应PR的验证节及实际回执为准。

| 6b冻结实际输入 | SHA256 |
| --- | --- |
| `scripts/check-activity-workflow-gate.ts` | `3479a76855bcb7048bd09f0796c1da4ea922f6fb9e93df314d036e1169a0e7b6` |
| `src/app.module.ts` | `5292768b3f595720049947117e7ba96b77550b3e1e633e07bbbbb7a5f98aab79` |
| `src/common/activity-workflow/activity-workflow.gate.ts` | `ab2d72cd32edb3204dc975cf9f53bd0eda97126122ff83dc0447d21343f6d9ad` |
| `src/modules/activities/activity-participation-query.service.ts` | `fc46ef50052129dc610f1a6a50980535d63858fbc924e47f58db3cf850f904bc` |
| `src/modules/activities/ledger-query.service.ts` | `041fa250d4bba9800f6784751d320399dbc1d78168076d59f599b1a38c0791a2` |
| `src/modules/attendances/attendance-notification-producer.ts` | `cf8e38aac426416b96c5368f4b9c8494d0e3d9ccbedac58c7726bfbe8e9697c8` |
| `src/modules/attendances/attendance-read.service.ts` | `5540ad8f37e34897786c417c3c2cbf09ac1e58c1867a51741962629203cef732` |
| `src/modules/attendances/participation-summary-query.service.ts` | `315e76dc6ddb3a6c933345674a5f6f4b1c4d2d53bf4df89eb96fe7c80ad84ff4` |
| `src/modules/meta/participation-overview-query.service.ts` | `c3ef6de79a9314df9c1275770d9c8d89c088ff273a1775a9977d057fb8cc2c93` |
| `src/modules/team-join/contribution-ledger-reader.ts` | `7ac0bd8a7ff4c94a8883b034d42d4476339f792e623add8f8f145e93c272f5ea` |
| `src/modules/team-join/team-join-applications.app.service.ts` | `77675b8095e29d57c9583ee1f5a2c7984ac7886b7eb9c44795496acf760484be` |
| `src/modules/team-join/team-join-applications.service.ts` | `dffd399394ed52231a0d45cd4e28cf73c6ea298944552e96da9c6e496488db87` |
| `src/modules/team-join/team-join-enrollment.service.ts` | `63d1a1684f6100583276f7e4856d524ba49cb096c6caaa3622430714d60a8f36` |
| `src/modules/team-join/team-join-progress.ts` | `6d66c635f171533d489783318cd5bc1b73d82ebd78dc6f691ce1b02b1190de63` |
| `src/modules/team-join/team-join.module.ts` | `cb9abb8c0a766318dbba89a81667280dc7c74846660ea8f90b893cae65623ab6` |

preflight此次续作读取到同一任务原有61份未提交输入，global结果因非clean而exit1，记录保留；远端main经正常fetch核实仍为本轮D1基点且无open PR。维护者此次明确授权基于这些已冻结输入续作，未丢弃或重置原工作，也未把该preflight写成通过；最终提交后再按原入口核验clean及门禁。

本轮总范围78个唯一路径，D2实际65路径；新源码/装配/摘要之外的后果均沿原清单。后续按同一D2 PR完成最终quick、完整Harness、原架构及生成物检查、契约和14组读面/11组native真实PG、固定SHA独立复核及CI/Smoke/Trusted；原最大规模两用例保留NOT_RUN，生产NO_GO与四项延期不变。


## R5 后端接续：nightly 精确候选与剩余验收（2026-10-19，仅送审快照）

本节承接 main `7606e1f1f39ec8bef22102e58068dbda34c8ed96` 的D2已合并事实，不把受限500交付称为整个Release5完成。仅推进开发验收，生产、真实数据转换、shadow、开关、tag/Release均不执行。AC013/020/025按原决定后续立项，AC017搁置，四项保持TODO；前端/真实业务验收未完成，不自动扩入后端写集。

原2000身份/10000段/50000物理slice/8000policy units与S13仍未验收，普通CI排除了原最大用例，专用scratch旧额度不恢复。10a/10b和实际目标条件是现场发布项，继续单列NOT_RUN，不以服务器信息缺失阻挡仓内取证。

历史nightly run39162056648/job117777230976绑定c8c15843，实际checkout --depth=1。尾部已见fixture:383固定历史git show失败及bucket canonical的FAIL，最终却为too-slow；4200秒终止不能证明纯慢或句柄泄漏。取回的是完整Actions job日志归档，原tmp/leaks.log只tail200且未上传，尾部外首红和全部因果仍UNKNOWN。新depth1克隆原命令exit128，补全历史后exit0；远端与本地同一blob，前136历史迁移逐份相同。旧分类器输入FAIL+timeout仍给too-slow，仪器问题已复现。

N1候选精确五路径：

| 路径 | 仅授权该目的的候选 | 红区 |
|---|---|---|
| `.github/workflows/nightly-e2e-leaks.yml` | depth0，DB前预检固定历史及136个blob，7天完整原日志/诊断副本/独立事实artifact，分列exit/termination/FAIL/summary/handles/OOM，已见FAIL不被timeout覆盖；不改70m/85m/8GiB、矩阵/required名/触发/权限 | 是 |
| `scripts/harness-guards.selftest.ts` | 执行真实shell判定段的17场景及历史pin/prefix/完整日志守护，原判据不删不松 | 是 |
| `test/e2e/activity-os-r5-e4-bucket-canonical-migration.e2e-spec.ts` | 失败beforeAll内7阶段start/done/elapsed计数；原30秒hook、全部SQL/语句/断言与事务预算逐字保持 | 否 |
| `docs/plans/activity-os-r5-limited500-release-readiness.md` | 本节送审快照及本轮真实授权/结果收据 | 否 |
| `changelog.d/nightly-e4-historical-fixture-diagnostics.md` | 本包fragment，不改已发布版本 | 否 |

这是候选范围，尚不是批准记录。原完整Goal禁止workflow，本包仅提议上述具名例外；两条新grant须维护者精确委托后才由正常CLI代执行，不复用D1/D2已结束grant，不手改令牌。Trusted仍须维护者对新SHA本人批准；既有正常提交推送/条件合并授权不绕过任何门禁。原SQL/500保护/Jest配置/global setup/依赖均不变。

仓外候选17场景shell、追加守护块21项、浅历史拒绝/完整历史通过及4个变异均有实际校准；它们不是正式完整Harness或应用验证。未改main的真实PG bucket141+detectOpenHandles为211.52秒exit1、2 failed：407行beforeAll原30秒hook超时，业务断言未执行。未再出现历史git show错误；同步升级/建夹具/prepare/submit/oracle哪个阶段耗时仍UNKNOWN，故仅新增第五路径定位，不称已修复，不提高timeout。结束后只读观察模板app_test保留、w1/w98不存在且目标client0，仅为资源快照，不是业务回滚证明。

获批后：原完整Harness/typecheck/quick与新增守护 → 具名bucket141在原预算下单轮取证 → 失败/UNKNOWN停后续，全部通过才普通CI五分片/Smoke/新SHA Trusted及既有正常合并。每层按代码、实际测试、推送、合并分别记录；候选应用前均NOT_RUN。

N2完整nightly另需一次执行授权：只有短门/主干通过后才固定新main派发一次，不rerun/扩时/拆片；明确承接既有自动开/评论/关闭Issue的外发副作用。N1实现授权不自动包括N2。runner/job硬终止仍可能阻止always artifact，不保证所有死亡方式都能保留日志。

C1原容量队列仅只读准备，待新scratch与有限次数批准。采用现有原S13一次→全门通过才原maximum一次，严格首停，不追加样本/预热/ANALYZE/换baseline。固定源码/147份SQL/oracle与原预算：prepare/submit30秒、review15秒、summary默认5秒、整例600秒，以及既有独立oracle/native/cleanup预算；不以90秒DIAGNOSTIC_ONLY结果代替验收。具名库拟为app_test/app_test_w1/app_test_w98，先查存在性/连接/owner，来源不明或失败证据库存在即停，不强清；原lease/普通DROP/失败保留/资源观察照旧。阶段JSONL、完整8000文档/袋/NULL/hash/oracle、响应与真实事务终态/副作用/资源分列，首红之后NOT_RUN。该历史fixture容量测试不授权active超500；若需要源码/SQL/断言修复，另给精确候选，不由测量授权自动扩写。

本轮未应用候选、未提交推送/建PR/合并；完整nightly、原满额/S13、前端与真实业务验收、10a/10b和所有生产操作均NOT_RUN。实际后续批准与收据以相应PR的版本化结果核对，本送审快照不倒签。


### N1实际批准与候选应用收据（2026-10-19）

维护者对问题call_a9401137246245869f480bf8ee7e5559明确回复：“批准 N1 五路径与两条精确 grant，并附条件批准 C1；完整 nightly 暂缓（推荐）”。据此仅通过正常CLI代执行workflow和harness-guards.selftest两条具名grant，应用冻结patch `0c46ea383cc79703acd3fda46f2a0973594f5b87dd0af131bdf8a58d0f70e1da`；初次应用五文件逐份摘要与送审候选相同。上述送审快照不倒签为实现证据；本节才登记实际批准。

N1清单内实施/修正、原预算验证、正常提交推送同一Draft PR沿批准范围推进；新SHA的Trusted仍须维护者本人批准。C1仅在N1全部门通过后开放原S13一次→全部通过才原满额一次，任一失败/UNKNOWN则后项NOT_RUN。N2完整nightly继续暂缓；生产/真实转换/开关/tag/Release不执行。实际验证、提交推送及合并分别记录，不提前预报通过。

### N1清单内修正与门禁首红（2026-10-19）

仍只修改获批五路径。独立复审先发现两项缺陷，并在修正前实际复现：带前导空白的真实ANSI `FAIL` 被误判为超时；`set -e` 下缺日志会在分类前被未保护的 `tail` 提前终止。现分别容忍FAIL前导空白、将真实分类入口移到显式容错的tail前；原17场景完整保留，追加真实带空格ANSI及缩进FAIL两例，以 `bash -e -c` 执行workflow原段。复审两项均关闭，最终代码复审0 BLOCKER／0 SHOULD-FIX，不代表验收已过。

代码候选固定为 `f9ce7727ac6c3f3e9c0236673548100a56a4fafd`；本节仅追加实际结果，不改变其实现。该候选工作文件在检查期间逐份摘要未变：

| 检查 | 实际结果及边界 |
|---|---|
| 真实shell与追加守护 | 19场景／23项通过；6个变异全部检出，包括上述两项回归。不是完整Actions执行或真实日志上传证明 |
| guards完整自测 | 596 passed／0 failed／1项既有known gap |
| 完整 `pnpm harness:selftest` | guards完成后按已出现的首红停止后续，exit143；ESLint组已启动后取消、hooks组NOT_RUN，整套记CANCELLED_NOT_COMPLETE，不能记全绿 |
| `pnpm typecheck` | exit0，应用／test／scripts三组配置全部通过 |
| 格式／不变性 | 三个代码文件Prettier及diff检查通过；去除22行阶段日志后bucket文件与原main逐字相同；触发、权限、矩阵、70m／85m／8GiB及原业务预算不变 |
| 历史预检 | 可执行预检段与送审候选逐字相同，明确复用原浅历史exit128拒绝／完整历史exit0通过的校准，不称本轮重跑 |
| 派生检查 | readtax／counts／migcount／codemap／rbacmap均exit0；147迁移计数一致。CODEMAP原两项WARN保留，不顺手扩围 |
| 首轮serial quick | 在两项复审修正前实际exit1：2019文件，src1470／test548两个CLI在原300秒窗口被SIGTERM，elapsed分别301126／300728ms，`COLD_LINT_FAIL WINDOW_EXCEEDED`；其后typecheck/unit原链未执行 |
| 修正后完整quick／单测 | NOT_RUN；这两处分类器修正未解决冷lint超窗，不盲重跑或加时。inputSeal包含scripts，故也不谎称修正前后完整输入摘要相同 |

旧main CI的同2019文件冷lint实际207524ms通过，仅绑定原 `7606e1f1`，不替代本候选，不能据此认定本地超窗原因。收口preflight先因本任务五处dirty而失败；正常提交候选后在clean工作树复核通过，没有绕过守护。这一卫生门通过不解除quick失败。

**N1验收仍BLOCKED，Release5未完成。** 新增阶段日志的bucket141 PG取证、C1原S13／原满额均NOT_RUN；C1附条件额度尚未消费。原211.52秒／30秒hook失败和原容量失败继续保留，具体内层耗时原因仍UNKNOWN。本轮先冻结并正常推送可审阅分支，不启动后续普通CI／Trusted／合并；N2完整nightly继续暂缓。前端与真实业务验收、31类真实映射hold、四项延期及10a／10b现场边界不变；生产、真实数据转换、开关、tag／Release均NOT_RUN。

### N1测试生命周期修复的实际批准（2026-10-19）

维护者已对“只给这个测试设置独立的120秒初始化窗口，先关闭应用再恢复数据库，保留业务时限和全部断言；增加一个现有测试辅助文件到范围，用新隔离测试库验证并保留失败库”明确回复：“批准啊 别问”。本节记录新授权，不把此前原30秒hook保留的送审快照倒签为这次例外。

本次精确四路径：`test/e2e/activity-os-r5-e4-bucket-canonical-migration.e2e-spec.ts`、`test/helpers/activity-contribution-policy.fixture.ts`、本Goal及既有`changelog.d/nightly-e4-historical-fixture-diagnostics.md`。复用migration146的外层owner、内层客户端关闭及pending/UNKNOWN门；bucket141设施beforeAll明确120秒，正文仍用原30秒，业务方法、SQL、所有原断言和隔离不变。现有helper仅给140/141迁移增加可选deadline，零参数保留原同步路径；不新增通用helper或修改全局Jest/workflow/业务服务。

预算更正：源码prepare事务为30000ms，submit引用既有`SETTLEMENT_SUBMIT_TX_TIMEOUT_MS=120000`。此前送审将两者均称为30秒事务不准确；本刀不修改这两个业务预算，C1的提交验收口径不得由初始化窗口推定。原本地冷lint300秒超窗、旧211.52秒hook失败、b672cbb8定向111.840秒exit1及teardown的`client:in_transaction:1`均保留；b672cbb8普通PR CI14 jobs成功独立有效，不代替新候选验证。原`app_test_w1`失败库保留，147迁移和后续零连接不代表业务事务终态，仍UNKNOWN。

新隔离验证路径为`/workspace/r5-n1-lifecycle`，linked worktree派生模板`app_test_r5_n1_lifecycle_64a90c`、worker `app_test_r5_n1_lifecycle_64a90c_w1`，执行前核实实际预览及资源；不创建或重建原失败w1，不使用C1的w98。批准的生命周期unit、单次具名PG+detectOpenHandles、同一Draft PR正常提交推送及原PR CI沿本范围继续，实际结果分别登记；当前新候选检查均NOT_RUN，不预报通过。任何首红/UNKNOWN保留真实输出并停止后续测量，不改断言、追加样本或自动抬预算。

本刀不消费C1额度；C1仍须N1原批准的全部前置满足。N2完整nightly暂缓；新SHA的Trusted必须维护者本人批准，不代批、不Ready、不合并，不部署/开闸/真实转换/tag/Release。AC013/017/020/025、31类真实映射hold、前端及真实业务和10a/10b边界不变。

### N1生命周期候选的实际验证首红（2026-10-19，推送前收据）

本刀代码固定为`8f082d7ac48635d998967682ab5c6c7d6899f34c`；后续本节与同一changelog仅登记事实，不修改受测代码。跨模型复查最终0 BLOCKER／0 SHOULD-FIX，静态比对39个原断言、23个SQL调用／模板和套件／测试名不变，typed corpus前置代码逐字保持。最终spec SHA256为`36c5bc144e32585ec7454c4b11de4c54824051ebf690d3215b21cfc351a66ec3`，fixture为`0f8649041e466aa568885fcd9ac442ef7aeedec2d5bf6f9cdf140f1f3e46e85a`。

| 检查 | 实际结果及边界 |
| --- | --- |
| 生命周期unit | 2 suites／17 tests通过，exit0；之后仅移动spec中UNKNOWN抛错位置，受测生命周期helper未改。该unit不替代spec实际PG |
| scoped ESLint | 首次exit1：`no-unsafe-finally`；同范围修正为finally只登记UNKNOWN、结束后再抛错，保留原异常。最终两文件exit0，无规则禁用 |
| test类型／格式 | finally修正后`tsc --noEmit -p test/tsconfig.test.json` exit0；两文件Prettier check通过，diff check通过。完整本地quick仍未重跑，不改写旧300秒超窗 |
| 候选隔离preflight | 新linked worktree安装／Prisma生成均exit0，候选checkout后具名lane preflight exit0；全局preflight因本任务既有Draft PR拒绝的原记录保留，未关闭PR或绕过守护 |
| 单次PG＋detectOpenHandles | 2026-10-19T10:49:29Z启动，10:55:49Z正常exit1；实际进程墙钟380.188秒、Jest351.667秒、file351.397秒分别记录。新隔离模板／worker是本次唯一写库范围，没有重跑、扩时或追加样本 |
| 初始化实际阶段 | 七阶段全部完成，累计44743.960ms：140升级4393.250ms、fixture12524.322ms、source2834.721ms、prepare9510.351ms、submit15355.468ms、body25.489ms、oracle83.525ms。设施120秒不改变原正文30秒和业务prepare30秒／submit120秒 |
| 首个正文失败 | 第一例15847ms，在首次`verifyBusinessRoots(false)`的原5000ms事务内报expired，错误报告累计13296ms，位置spec:167。尚未首次deploy141，不证明非空141升级或完整roots正确；报错请求不等于耗时根因已定位 |
| 后例与资源 | 第二例被owned首错保护拒绝，typed corpus为NOT_RUN；Jest计2 failed／0 passed，正常写出JSON且`openHandles: []`，未触发外层安全终止。只读观察目标连接0、测试进程组及live Node／迁移engine 0，worker已恢复147迁移、私有oracle schema 0；不是业务正确性或回滚证明 |

本次采用既有`SRVF_KEEP_TEST_DBS=1`保留新worker供失败取证，因此globalTeardown的worker DROP记NOT_EXERCISED，不把保留当成清理通过。新模板OID48651、新worker最终OID55531；原失败`app_test_w1`仍为OID40052，未纳入本刀写库scope，未重建、清理或转换。三库完成迁移的名字／checksum摘要相同仅为catalog资源证据，不关闭旧失败或业务终态UNKNOWN。

完整原日志SHA256为`a91576b3566b0e3ff7c82dd898c6fc65e5139cf8ffcb6e5e6634e4c709082c52`。实际Jest JSON、supervisor启动／退出、阶段结果、只读资源及跨模型收据保存在本云工作区`/workspace/r5-continuation-20261019/evidence/n1-lifecycle-*`；旧日志和原授权记录均保留。本节是推送前事实快照，正常提交推送同一Draft PR #1385并跟进原PR CI的授权继续；其新SHA检查以GitHub终态核对，不预报成功，不Ready或合并。

**N1仍未验收通过，Release5未完成。** 新首红是原oracle事务过期，根因仍UNKNOWN，不调高5秒或其他原预算、不改SQL／断言。首红后Smoke、C1原S13／原满额均NOT_RUN，C1额度未消费；N2完整nightly仍暂缓。Trusted须维护者本人批准，生产NO_GO及四项延期、31类真实映射hold、前端／真实业务、10a／10b边界不变。

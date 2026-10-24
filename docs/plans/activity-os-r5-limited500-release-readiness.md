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


### C1-v2：prepare60事务可行性口径的实际批准（2026-10-23）

维护者对父会话 Sentinel_5f559a80524c8191a611fb722dc5099d 的精确六路径提案，直接回复“批准”（Sentinel_445d4e8cf59481918f522234b3e5a474，2026-10-23 11:53 UTC）。本节新增口径版本，不将旧结果倒签为通过。两条已批准云环境适配保持原内容，独立提交 e31753ed；正常preflight因未提交适配先exit1，正常提交后clean预检exit0，未改守护或手写标记。

原C1-v1仍为S13 FAIL：prepare33960.659994ms违反当时严格<30000ms；submit／完整oracle／S13 AB→BA／满额未运行。原日志SHA256为70e0891902bbda9204376f42140a8a8dfd5f891e7d3dd88555e7634a8fc29cbe，原失败w98 OID60829保留。30秒起自D4“先采用”的工程预算，未找到业务SLO、分位或硬件校准；现已批准的60秒仅prepare事务可行性候选，不是响应SLA。

v2仅将scale文件两处prepare方法墙钟<30s改为核验实际引擎start配置timeout60000/maxWait2000/ReadCommitted、唯一成功COMMIT及pending0；方法完整耗时单列记录。完整8000评价、40000关联／50000物理slice、独立全量oracle、全部权限／审计／幂等／查询数量及资源守卫保留。原独立SQL15s／配对30s／probe75s、submit120s、review15s、共享账本7s／取锁4s、摘要默认5s、初始化120s及每容量用例600s均不改。不能将全部30改60。

本次六路径：scale E2E、e4-maximum-stage-receipt helper、其src对应spec、concurrency E2E、本Goal、新changelog.d/r5-c1-prepare-acceptance-v2.md。精确原文逆转将v2还原为完整v1，再沿原冻结hash检查；不删除旧断言或重写历史SQL。复用原八阶段／事务观察器，无新框架。

执行上限：必要离线检查；小规模31秒完整提交、61秒超限全业务／receipt／审计／outbox回滚和锁释放后同键重试／重放各一次；仅两项全通过后，在原实例租约、零连接、源OID及目标不存在核验下正常rename旧w98为app_test_w98_c1_v1_failed_20261023；不FORCE，保留OID和旧证据。新w98由原入口创建，S13一次，全部门通过才原满额一次，任一FAIL／UNKNOWN首停，不追加样本或预热／ANALYZE。边界验证使用明确的模板／w1；失败库保留，成功w1才可由原入口重建。

本节为获批实施前记录：边界／rename／新S13／新满额均NOT_RUN，待实测收据追加；不预写通过。active500、四项延期及生产边界不改，无生产／Ready／合并／PR正文发布授权扩展。

#### C1-v2 当前离线收据（2026-10-23）

六路径实现已写入且尚未提交。定向lint／格式／整份v1逐字逆转与跨模型复核通过；quick的typecheck、466套默认unit（10460 passed／4 todo／8 snapshots）及Harness自测exit0，cached lint在默认约4GiB堆上限OOM exit134，quick整体exit1。沿原正式入口及既有CI 6144MiB设置的冷lint，在quick Harness仍并行时test子进程SIGKILL；cgroup达到16GiB且记录1次OOM kill，src子进程exit0，prisma未启动，冷lint整体exit1。两次失败保留，不记全绿；待重任务完全退出后才可沿原入口、原6144MiB／300秒限制独立补验，不改脚本或门限。

额外选中的观测helper单测为165 passed／4 failed；失败均来自既有VM未提供可选sliceReadDiagnostic，精确v1源文重放同样32 passed／同4 failed，不能冒称新增回归或已修复。该helper不在默认unit配置及已批准六路径内，尚未修改；最小候选仅为test/helpers/e4-prepare-phase-diagnostic.spec.ts的VM上下文补sliceReadDiagnostic: undefined一行，不改断言。预览及基线对照保存在本云工作区r5-closeout-evidence，待精确扩围。

31秒／61秒／rename／S13／满额仍全部NOT_RUN，额度均0。只读核实原失败app_test_w98仍OID60829、连接0，归档目标及w1不存在，实例已授予advisory锁0；未改名、删除或重建原失败库。

2026-10-23 12:36:27 UTC补验：重任务全部退出、cgroup内存946929664字节时，沿原pnpm lint及原6144MiB／300秒窗口单独运行，正式冷lint正常exit0（12:33:13启动，约193.6秒）。原两次资源失败保留，未改规则、输入范围或门限。模板只读预检为197张public表、152条完成migration、边界所需表齐全；仍未运行任何新PG测试。范围外一行沙箱修正尚未应用，四项既有helper失败仍open，不将全部定向检查记绿。

#### 第七路径单行修复的实际授权与补验（2026-10-23）

维护者直接回复父会话Sentinel_bb170d8c33988191903f1019b33c4483的单行请求“批准”（Sentinel_af8ac3e2c0d48191b1e3dd9ed3103ddd；原转交未附精确UTC时刻）。本轮仅在test/helpers/e4-prepare-phase-diagnostic.spec.ts的VM上下文补sliceReadDiagnostic: undefined一行，未改断言或生产代码。四套相关unit现169项全过、0失败；变更文件ESLint／Prettier及test项目TSC均exit0，跨模型复核BLOCKER0／SHOULD-FIX0。原四项沙箱失败和原lint资源失败记录保留；此前其余输入未变的正式冷lint、三项目类型、默认10460项unit及Harness结果复用，未重跑全量。真实31秒／61秒及S13／满额仍为NOT_RUN，按原一次队列继续，原失败库尚未改名。

#### C1-v2 首次31秒PG首红（2026-10-23）

14:23:40 UTC启动唯一一次31秒边界，14:24:23正常exit1；Jest1 failed／6 skipped，整例37388ms不等于prepare方法墙钟。此前实际start的60000／2000／ReadCommitted、唯一成功COMMIT／pending0、方法至少31000ms、真实约束后delay完成、单份time／contribution／evaluation／receipt及1.00总分断言已通过。首错在新增case第443行：bucketCount期望1、实际4。新增测试把四分类桶／来源误写成单条，既有policy的四分类循环及只读失败库均证实四桶四来源（volunteer_service3600秒，其余三类0秒，每桶1来源），不改业务来迎合测试。后续来源／行数／audit／独立锁释放断言NOT_RUN，整例仍FAIL，不能将部分事务断言通过冒充完整验收。

首红已停：boundary31消费1次；61秒、rename、S13、满额均0次。失败w1 OID69446与旧失败w98 OID60829均保留、连接0；实例granted advisory锁0、Jest openHandles空仅为清理后观测，不替代未执行的专门锁释放证明。原始日志SHA256 dd11a5b10bf4e8c626041de15b2aa77c2639354ea741c148d48a2a04607a5307、Jest JSON SHA256 e9473c53ef8cc9f41a9e98b12463c95c5098ca40096a5620871b53516f667ee1及只读诊断保存在本云工作区r5-closeout-evidence/c1-v2-boundary31-20261023T142340Z。

仅准备待确认候选：修正这个新增31秒case四处桶／来源数量预期1→4，保留一份证明、1.00总分、事务档位／时长及所有其他断言；未应用。继续测量须精确认可补一次31秒额度，并在任何下一次globalSetup前先保留归档本次失败w1，不得自动重建吞证据。原61秒／S13／满额均未消费，首红保护未解除；未重跑、未归档或删库、未提交推送、未触生产。

#### C1-v2 四分类预期修正的明确恢复（2026-10-23）

维护者对父会话Sentinel_47ffde50a37c8191a05d1d34e239de50的精确恢复提案回复“批准”（Sentinel_68b1f79b5f548191a0761600443fe8dc），随后对范围澄清明确回复“是”（Sentinel_614755884b4c8191a3bed2b2ca3ef51b；转交未附精确UTC时刻）。仅将新增31秒case的四处桶／来源数量改为严格4，根／评价／receipt／audit、31／61秒、业务及预算不变。定向ESLint、test TSC、格式与diff检查exit0，实际四行差异跨模型复核BLOCKER0／SHOULD-FIX0。

14:54:15 UTC已在同一postgres Unix维护后台PID221652取得既有D3租约，核对源OID69446／owner postgres／连接0／目标不存在，正常将app_test_w1改名为app_test_w1_c1_v2_boundary31_failed_20261023；原OID69446保留，租约正常释放，无FORCE或DROP。原首次31秒FAIL及其消费1次保持在旧ledger不改写；新增恢复ledger单列“额外31秒一次”及未消费61秒／S13／条件满额各一次，首FAIL／UNKNOWN仍停。此时恢复队列均未启动，旧w98 OID60829尚未改名，不预写通过。

#### C1-v2 恢复队列实测终态（2026-10-23）

全部测试进程及命令均已自然返回。31秒补跑14:55:19→14:56:03 UTC，runner43.670秒、方法31591.137946ms，整例PASS；完整写入／四桶四来源／1.00总分及独立锁释放通过。61秒14:57:16→14:58:30，runner74.044秒、方法61654.759692ms，整例PASS；实际P2028、完整public业务快照相等（含receipt／audit／outbox）、锁释放、同目标一次重试及一次重放均通过。两例openHandles空。原首次31秒FAIL仍保留，不改写为PASS。

旧w98已于14:59:55在同一postgres Unix维护后台PID222277、既有D3租约和OID／owner／零连接／目标不存在检查下，正常改名为app_test_w98_c1_v1_failed_20261023，OID60829保留、租约正常释放，无FORCE／DROP。随后原入口创建的新S13库为app_test_w98 OID74631。

S13于14:59:55启动，15:02:24正常exit1（runner148.453秒、Jest144.634秒、单例133576ms分别记录）。prepare方法34018.520667ms，真实start timeout60000／maxWait2000／ReadCommitted及唯一成功COMMIT、pending0，八阶段COMPLETE；查询275、E4查询4、屏障1；8000桶／40000来源、根evaluationCount8000和1000.00总分断言已过。此为局部prepare及根记录断言，不代表独立完整oracle通过。

首红在assertFixedE4Oracle的原只读验证事务：SQL statement_timeout30s与Prisma timeout30000均保持原值，报P2028（30024ms），完整old／candidate／stored差集及rootMatches比较未返回，不能断言真实全量一致；具体SQL内部或环境耗时根因尚无证据。submit与S13独立AB→BA均NOT_RUN，afterAll首错保护及普通DROP拒绝是留证门禁，未绕过。S13整体FAIL（1 failed／222 skipped），满额0次。无重跑、加预算、业务／SQL／断言删改或生产动作。

当前保留模板24577、首个31秒失败归档69446、旧S13归档60829、新S13失败74631；均连接0、实例granted advisory锁0、验证Node进程0、openHandles空。原普通w1已由本次正常globalTeardown清理。恢复队列消费31／61／S13各1、满额0；加上旧31失败，v2的31累计2次。旧v1 33.961秒FAIL另保留，不追溯改绿。新原始日志SHA256 24995a67dd4c1d9bdbad6a2570c3d560c306046632db24c729a12604207b4423，JSON SHA256 548386028c31e3801ebb734f9ba41ea3b2ac5d2c7b25a1e5ae1f6b13de04b905，及结果摘要保存在本云工作区r5-closeout-evidence/c1-v2-resume-S13-20261023T145955Z。


### 2026-10-24 source153 参数化来源读取候选（实施中）

- 新增迁移20261023170000_activity_contribution_source_parameterized_reads，仅把 time_revision 的 slice / result 两处 JOIN 改为按 allocation / 根 version 与 identity 参数化读取。历史144、表结构、权限、两来源分支、12列、NULL、重复度和窗口权重保持。
- SQL SHA256：8be33faf3d4e5cc3f5036117684f620be83f9c9be49acc6c168f5bf894afd0df。精确正常 CLI grant 按维护者明确委托由 AI 代理执行，文件写入后已撤销；不冒称维护者本人执行或审阅签字。
- 原w98 / OID74631来源完整消费30秒服务端57014失败及全部旧FAIL / UNKNOWN保留。31秒提交、61秒回滚已完整通过，不重复。候选尚不构成容量验收。
- 一次隔离队列：正常归档和复制失败库、仅升级153、候选计划、完整来源30秒、冻结144与实际153的12列双向EXCEPT ALL；旧参考比较120秒仅为验证器资源预算。定向升级回归通过后S13一次，全绿才原满额一次；首FAIL / UNKNOWN停止。
- 既有C1-v2逆变换、完整业务oracle30秒、prepare事务60秒、其余独立预算、外层600秒与active500准入保持。153真实3b、最终CI / Smoke及原容量仍按实际结果登记；本轮不操作生产。

### 2026-10-24 来源等价结果与 S13 现行函数绑定恢复

- 固定16组完整桶证明已通过：冻结144、参数化153及预先独立保存的public候选均50000行，完整12列双向差集均0；总57933.293ms。最终ROLLBACK、公共数据／函数元数据不变、PID／锁退出均确认。只证明该time_revision根，不替代更正回归或满额验收。
- 五套真实PG回归725 passed／3个既有W98／N1专用诊断skipped／0 failed。收集器最初把Jest“有跳过且无失败”的focused标签误判，原记录保留，独立核实后仅离线更正登记，没有重跑PG。31秒／61秒和16组亦不重复。
- 随后S13业务主体通过，prepare方法32137.743ms、真实60秒档位提交，draft／submitted完整oracle通过；整套仍FAIL：afterAll的live catalog把137历史函数4362字节当现行值，而main及HEAD已有140函数6124字节。独立AB／BA探针尚未运行；DROP正确拒绝，失败库app_test_w98／OID180715保留。原始JSON、stderr及只读catalog保存于本云工作区r5-closeout-evidence/source153-postproof-s13-20261024T045215Z，旧FAIL不改绿，满额仍0次。
- 本轮仅纠正测试版本绑定：完整140迁移SHA256 `5d7ff28a64a638440aaa1e9a798a2602f933fc9d6f8b23b68355199dad143513`及函数正文SHA256 `bbabd3144fb7639e856b3e4b349e017d0eacad6799bf02b5014b52e6cf521761`独立固定，现行MD5／字节数由此源码计算，再与数据库比较。旧137历史摘要及4044字节opening不变，声明／身份／ACL等检查不减；同一验证器同时用于S13及满额后置探针。新增精确外层逆变换先恢复完整C1-v2源文SHA256 `175a4997a170887daa6095eda23106334534a1756521f7ce0b3d65bca1e79fa4`，再走既有历史逆变换。
- 父任务明确委托本五路径修复和一次恢复队列。离线检查与独立复核通过后，须核对维护身份、D3租约、OID180715、零连接及归档目标不存在，正常改名保留为app_test_w98_c1_s13_catalog_failed_20261024；原入口建新隔离库补一次完整S13，全绿才原满额一次，首FAIL／UNKNOWN即停。恢复尚未执行，不预写结果。不改业务／迁移／预算／500准入，不代签153，不操作生产或发布被拒绝的PR正文。
- 独立复核另查明迁移E2E也直接读取scale共享helper，已先报告精确第六路径及补丁；父任务随后要求继续本修复与原队列，本轮一并接入这个必要的测试读取配套。仅在既有迁移E2E导入normalizer、完整源文还原入口和共享比较前接线，不运行新增历史迁移演练。两文件外层逆变换分别恢复完整原scale `175a4997…` 与migration `30a764e2…`，原断言均保留。81项离线单测通过，包含直接执行两份原共享比较callback；独立复核BLOCKER0／SHOULD-FIX0。全新系统无旧业务数据；旧算法清理另作只读盘点，不把它作为本次容量新增门槛。

### 2026-10-24 S13通过、原满额首审失败与失败保留修正

- S13恢复于05:31:03→05:35:13 UTC完整PASS（exit0）；prepare31846.601ms、真实60秒事务提交，draft／submitted完整oracle及独立AB／BA比较通过，全部8000评价无差集。原catalog失败库正常改名保留为app_test_w98_c1_s13_catalog_failed_20261024（OID180715），旧FAIL不改写。
- 原满额于05:35:53→05:39:27 UTC失败（exit1）。prepare31681ms、完整oracle22748.344ms、submit均已通过；firstReview为P2028，15秒事务在17500ms时已过期，阶段17674.534ms。独立前后及app关闭后均为pending_first_review／submitted，decision／notification／audit均0，支持本次回滚。finalReview、账本过账／重放及最终oracle未运行，不能宣称原容量通过。日志保存在r5-closeout-evidence/live140-binding-20261024/maximum-20261024T053553Z。
- 本次满额失败库被原专用fixture的默认finalizer删除；此前cleanup收据仅表示交给owner finalizer，并未证明最终保留。原始日志／Jest JSON及四份既有失败归档仍在；不重建或冒称恢复原失败库。
- 已按本轮明确委托，在现有测试helper及scale接线增加DROP前的纯状态门禁：专用S13／满额必须完整成功，fixture、完整业务callback及四个前置清理hook全部完成且无失败、pending或被吞UNKNOWN才沿原流程清理；partial init、FAIL、UNKNOWN及迟到完成保持拒绝。普通worker透传，独立post-DROP断言保留。离线故障覆盖与独立审阅结果另附实际收据，不以离线通过冒充数据库留证演练。
- 门禁边界：root的最终post-DROP观测位于删除之后，该阶段故障不能保留已经删除的库，本修正不声称覆盖这一不可逆时点。未改变DROP后检查，未开始任何新数据库或容量执行。
- 15秒来自2026-08-05提交f05fd92bf的“没有与人数相关步骤”假设；现行policy_v1校验已包含全量来源／评价／摘要。firstReview优化路径只执行一次原生完整校验，现有日志没有该事务的逐段计时，不能把最后报错帧归因为耗时SQL。finalReview和账本路径另有源码可证的重复全量校验，但本次未到达。下一步仅准备有界首审分段取证，不改15秒／共享7秒、业务或500准入。
- 失败保留修正离线实测：103项单测／格式／定向ESLint／应用及测试TSC／diff均exit0，独立静态复核BLOCKER0；原readiness前缀和完整冻结源文逆变换保持。首轮2项配套失败及后续lint失败原样保存在r5-closeout-evidence/retention-fix-20261024：两处超时参数改由AST分别定位后仍要求篡改被拒绝，中断测试用临时脚本文件避免node -e单参数长度限制，1500ms及全部原断言不变。本轮数据库连接、留证实库演练、S13／满额补跑均0次。153真实维护者审阅、首审修复及后续容量阶段仍未完成，不将此离线通过记作Release 5完整交付。

### 2026-10-24 未上线系统清理首批与有限首审诊断准备

- 首批已删除三个无引用的private snapshot V3／V4／V5构造器、同一providers数组的第二对重复服务及孤立ELIM_STAGE_REALNAME常量。保留现行V7／V8／V9、仍有测试调用的V2／V6、旧parser／hash基础、服务export及仍被实际读取的APP_STATUS_PENDING。未改controller／DTO／业务预算或首审逻辑，独立TS AST／引用审阅BLOCKER0；四套定向unit删除前后均62 passed，定向lint／格式／应用及测试TSC／diff均exit0。
- CODEMAP已按原生成器刷新。受保护配套尚PENDING、未尝试grant：harness/domain-map.json的模块摘要、harness/state-machines.json中eliminationStage的退役值登记，以及ROUTE_AUTHZ.md的两处inputDigest。现有boundary metadata及authz freshness因前述摘要仍FAIL，不能记作全部门禁通过。精确未应用补丁保存在r5-closeout-evidence/legacy-cleanup-batch1-20261024，非保护的状态机说明已如实列出登记差异；不绕过或放松检查。
- 首审一次诊断仅完成离线准备：来源归档app_test_w98_c1_s13_catalog_failed_20261024／已记录OID180715、submitted根cmvlxcvpi09ivmw2qal9r3hpy；在线时须重新核身份、租约、根／actor资格、零连接和目标不存在，才克隆到正常派生的新app_test_w98并记录新OID，不改旧归档。不得调用会resetDb的fixture或完整prepareE4Ledger；只用真实依赖调用一次原firstReview，不启动Nest／worker。
- 业务事务新增SQL为0；观察三把锁、两次catalog、原Version UPDATE、SET及事务终态，原15秒选项不改。到barrier最多13次应用语句，owner成功路径20次，触发器内部语句数量未知。外部最多8个固定核验SELECT、1次克隆DDL；总硬限90秒、首审响应观察25秒；无论PASS／FAIL／UNKNOWN均保留源和新库，不存在DROP分支。观测glue在证据目录，10项离线自测及独立静态复核通过；不是数据库执行结果，本轮在线次数0。

### 2026-10-24 首批机械配套完成与单次克隆首审实际结果

- 按维护者新增精确委托，AI代理逐路径执行正常grant：domain-map仅inputDigest、state-machines仅退役常量inventory登记、ROUTE_AUTHZ仅两处inputDigest；每项应用后正常撤销，无残留grant。独立核对三个candidate全文hash匹配，权限声明、转换及安全策略未变，状态登记仍inventory／no-db-check。boundary metadata及authz freshness均exit0（663端点），CODEMAP此前已通过。原pending记录为前一检查点，不再是当前阻塞。
- 真实依赖构造离线通过；观测11项、控制器9项离线分支测试及独立静态复核通过。执行前补齐克隆角色／owner／153checksum检查，确保在业务调用前拒绝；预留清理窗口，期限耗尽不派发新查询。
- 唯一在线包OBSERVED_PASS，总8509.670ms；归档源OID180715／既有submitted根资格及函数hash重新核对后克隆为新app_test_w98，实际新OID206606。不是已被删除满额库的恢复或原故障复现。8次显式外部SELECT、1次克隆、1次首审，业务新增SQL0；实际20次应用请求、含BEGIN／COMMIT共22条查询事件，原15000ms选项未改。
- 事务start至commit观测6487.779ms；三把锁1.491／0.988／1.110ms，两次catalog5.235／3.440ms，Version UPDATE2.537ms，SET屏障6445.322ms（服务端事件6444ms），commit1.344ms。此次主要耗时集中在完整校验屏障；不能将其移作旧满额17.5秒首错的根因，因为旧失败在SET派发前已过期且缺少同事务分段记录。
- 首审成功后及业务客户端关闭后均pending_final_review／submitted，decision／exactDecision／notification／audit／freshAudit各1，postingBatch0。源和新库保留且连接0，自有业务／维护PID及锁0；完整stderr为空，完整日志和终态收据在r5-closeout-evidence/first-review-once-20261024。归档仅能核对既有关键事实及本任务未写入的保管链，没有历史全库逐字fingerprint，不冒称已证明所有行未变化。
- 原满额FAIL及旧日志不改写。此包不包含prepare／submit／S13／满额／终审／过账重跑，未改业务／SQL／15秒／共享7秒／500准入；原完整容量和153真实审阅仍未完成。远端main仍4e77e9f6，本地HEAD仍e31753ed、候选改动未提交，不宣称完整R5交付。

### 2026-10-24 唯一完整满额恢复首红终态

- 维护者／父任务明确恢复一次完整满额，规模、断言、原600秒case及全部事务预算不变，不重复S13／725PG。已验证真实入口的失败保留接线与原103项通过版本完全同hash；新增证据目录观测使用原Promise旁观，6项真实guard离线分支及独立复核通过。原setup／globalSetup保持，仅附加观测setup；无业务SQL增加。启动时无并行重型任务，4vCPU／16GiB配额和PG参数不变。
- 正常D3租约／身份／OID／零连接及目标不存在核对后，已将首审PASS诊断库OID206606改名保留为app_test_w98_c1_first_review_pass_20261024；原入口新建了本轮库，不冒称恢复已删的原满额失败库。
- 本轮PID999101，整体247385.810ms，exit1／1 failed／222 unselected，STOPPED_FAIL且不重跑。fixture65572.529ms、prepare33109.657ms及原断言、完整oracle22672.045ms、submit66755.350ms及原断言均通过。首审在LEDGER阶段P2028；终审、记账、最终oracle及后置探针均NOT_RUN。
- 新分段证据：首审19198.641ms；三把锁1.652／2.319／1.665ms，catalog4.302／10.791ms，Version UPDATE2.287ms。SET请求于事务观测约46.091ms时进入engine，等待19059.336ms后拒绝；原timeout15000未改。此处是客户端请求区间，尚未分离PG执行、等待、JIT或计划成本，不能单凭耗时宣布环境根因；旧克隆6.445秒屏障PASS不替代本失败。
- DROP前门禁实际拒绝清理，本轮失败app_test_w98／OID206608保留。只读核实run仍pending_first_review、version仍submitted，first decision／notification／audit／postingBatch均0；六个具名失败／诊断归档及工作库均存在且连接0，D3锁0。原日志与本轮完整stderr／stage／trace／终态均保留于r5-closeout-evidence/full-maximum-resume-20261024；不把保留门禁的afterAll拒绝算成新的业务根因，不重写任何旧FAIL。

### 2026-10-24 屏障源码／元数据诊断与孤立探针退役

- 首审Version UPDATE只排队一次137 native guard→146 e4_assert_complete(TRUE)；没有第二次相同fullguard可直接删除。内部依次核frozen selection／policy、151 bucket hash、153一次MATERIALIZED来源、内联expected与8000组day_points及全文差集、实际评价/root摘要与上限、version_content_hash→version_v1_hash。146不调用140 expected函数或148 source-set hash，先前独立oracle不构成跨事务免校验凭据。
- 在失败OID206608和首审通过归档OID206606各取有界只读pg_proc／pg_trigger／pg_stat快照；14个相关函数、34个归一化trigger定义、119个相关索引及默认规划参数一致。根不同、业务路径不同；clone的统计计数为0不表示数据为空，累计scan／temp计数不能拆成本次屏障耗时。失败库评价／bucket／来源／result的第二次auto-analyze在07:23:52发生，晚于07:23:21首错，当前统计不能回溯失败计划；pg_stat_statements未安装，JIT／缓存／CPU／IO归因仍UNKNOWN。
- 已备一次原生15秒statement限额、上层20秒接收、整体40秒的UPDATE→SET→始终ROLLBACK诊断SQL，固定失败根／OID、原锁序、原native guard及函数pin；仅准备，未执行。目的为取得服务器SQLSTATE／完整CONTEXT，不能当作放宽应用15秒或原满额已通过。后续修复优先同一次校验内部的投影／规范化复用，保持完整校验和错误语义；若改146实现必须新增前向迁移并同步精确pin，不改历史146或直接skip。
- 本轮安全清理仅退役无引用且不被现行E2E／unit收集的test/diagnostics/e4-assert143-setup.diagnostic-spec.ts一次性旧探针；其旧源码逐字及SHA已保存在r5-closeout-evidence/barrier-readonly-diagnostic-20261024，并仍可从原Git历史取回。现行独立oracle、143生命周期回归及所有FAIL记录保持；精确引用扫描、测试TSC、CODEMAP与diff均通过。本轮未运行重型校验、EXPLAIN ANALYZE或容量测试，未改业务SQL／预算／准入。

### 2026-10-24 唯一原生回滚屏障诊断实际终态

按维护者／父任务明确执行委托，固定失败OID206608及根cmvm2mh1w09ivmwx6uexczwsd，在真实D3租约、角色／零连接／函数pin及原锁序下执行一次UPDATE＋真实SET屏障。SQLSTATE00000，屏障6859.229ms，整包7084.030ms；锁／UPDATE分别2.596／0.334／0.284／1.597ms。随后始终ROLLBACK，版本整行MD5与基线相同，run仍pending_first_review、version仍submitted，decision／notification／audit／postingBatch均0；库保留、clients／owned PID／locks均0。原生stderr为空，没有错误CONTEXT可定位内部热段；仅证明该根在当前统计、新原生会话下可于15秒内完成，不能关闭原连续满额19.059秒屏障FAIL。完整stdout／stderr／SQLSTATE与时间保存在r5-closeout-evidence/barrier-readonly-diagnostic-20261024/rollback-once-result.json。未重跑满额、改应用15秒／函数／JIT或work_mem；下一最小只读取证是原07:23:01–07:23:22失败时段已存在的PG日志，先区分服务器执行／取消记录与客户端等待，缺少原执行证据时不选择未经证实的SQL修复。

## 2026-10-24 完整守卫 selected 物化候选154

- 仅新增154，将现行146完整函数的 `selected AS MATERIALIZED` 改为 `NOT MATERIALIZED`；`documents` 与全部完整性检查保留，历史1–153不改。当前精确正文 MD5 为 `016fe8c1899166291010545a4f036415`，首审目录绑定同步，未增加兼容白名单。
- 隔离克隆单次内部计划确认 selected 物化扫描消失、documents 保留；原生屏障6969.386ms、SQLSTATE00000，整体7828.985ms，随后完整回滚并恢复146。该库统计记录500397433字节临时文件；未与同条件旧函数配对，不能宣称提速，也不关闭连续满额首审约19秒FAIL。
- 旧失败库和本轮克隆均保留。50项旧新语义控制、2项原生拒绝及4项更正回归合计600秒包尚待一次执行；任何FAIL/UNKNOWN停止并留库，不改断言或预算、不重跑满额。已有31/61秒、S13、725项PG与完整来源等价结果不重复。
- 153及154真实人工审阅、最终候选CI/Smoke尚未完成；不代签，不操作生产或扩大active500，不将候选与有限500既有交付混称完整R5。

- **本轮600秒包终态：FAIL（46888.474ms，未补跑）**。固定153初始化与夹具准备完成后，首个153→154用例被测试helper的旧 `baseline136` owner条件拒绝，尚未调用forward deploy；后两项被首红闸拒绝。50项配对比较／新原生拒绝／4项更正均NOT_RUN。新失败库OID223896保留，原克隆PASS库OID223892正常归档；九个库、连接和租约清理已核对。最小缺口是显式允许已验证fixed153 owner调用latest forward，尚未修改或重跑。此工具失败不判定候选SQL正确或错误。

- **153 owner适配恢复一次：仍FAIL（45972.221ms，首红停止）**。实际153→154迁移进程RESOLVED/CLOSED，升级后整库业务快照断言通过；随后目录逐字比较仅因默认值节点 `:location 281→259` 失败，未复用既有143源位置归一化规则。no-op／50项语义／两项原生拒绝／4项更正均NOT_RUN。新失败库OID232499及九份旧库保留，连接／租约0；尚未改比较规则或再次执行。恢复时须保留完整默认值及默认true语义、仅规范化目标单一location，no-op仍与升级后原目录严格比较，禁止改migration头凑位置。

### 2026-10-24 154语义包通过及原满额实际首红

- 经明确恢复委托，仅复用143既有目标目录规范化：单个数字location可变，默认表达式仍true，默认节点其他字段、类型、参数、owner／ACL／volatility／security等逐项不变；no-op与升级后原始目录严格比较。32项单测、test TSC、lint及独立静态复核通过。OID232499正常改名保留，未改154 SQL摘要或历史失败记录。
- 唯一恢复600秒语义包于10:47:02→10:49:05 UTC PASS，整体122562.157ms：153→154非空升级／业务快照／目录及no-op、50语义用例共200个旧新结果严格一致、原生INSERT和延迟COMMIT均23514拒绝且回滚、4项真实更正回归全部通过，无失败或跳过。语义库OID241104及更正库OID255247均保留。回执在r5-closeout-evidence/fullguard-selected-semantics-recovery2-20261024；不将此包计作满额通过。
- 随后按明确委托恢复唯一一次154完整原满额，原规模／全部断言／prepare60秒／两审15秒／case600秒不变，不主动ANALYZE或改变JIT／work_mem；复用原Promise旁观trace，新增业务SQL0。OID255247正常改名保留为app_test_w98_c1_selected154_correction_pass_20261024，原入口新建OID269046；此前全部归档保持。
- 本轮10:54:10→10:58:24 UTC STOPPED_FAIL，整体253944.089ms，1 failed／222未选中／exit1。fixture64945.284ms、prepare32957ms及原数量／查询断言、完整oracle24265.037ms、submit71011.416ms及原断言通过。首审18714.906ms、SET请求18593.163ms后P2028，原15000ms配置未改；不是单个内部SQL计时，也没有配对收益证据。154未解决连续满额首审问题，终审、记账、最终oracle及后置探针均NOT_RUN。
- 首审前、失败后与app关闭后独立事实一致：pending_first_review／submitted，decision／exactDecision／notification／audit／freshAudit各0；不能把客户端rollback拒绝误称为已独立证实服务器ROLLBACK命令成功。DROP前门禁真实拒绝，失败OID269046与全部12份旧归档均保留，连接／D3锁0。回执、完整stderr、阶段和首审trace在r5-closeout-evidence/full-maximum-selected154-20261024；首红后未补跑或新增诊断查询。
- 当前HEAD仍e31753ed，远端main只读核实仍4e77e9f6；67个待提交路径清单及逐文件摘要已保存，未提交／推送或跑最终CI。153／154真实人工审阅仍PENDING，不代签；未生产、扩大500准入、提高预算或发布被拒绝的PR正文。下一步需先解决或形成经证据支持的首审适用预算决策，再做最终候选整合验证，不能将本次语义PASS冒充完整R5交付。

### 2026-10-24 撤回未发布154与审核预算适用规则修正

- 维护者已明确委托实施review-budget-and154-withdrawal-plan-20261024.json的56路径方案。首审／终审统一60秒事务预算，覆盖approve／return／重放，不增加客户端参数、配置档或开关。原15秒来自2026-08-05 f05fd92b“没有一步与人数相关”的假设；2026-10-18 82b5ce1b加入全量贡献校验后，该假设失效。60秒为有界工程资源上限，非HTTP时限／业务SLA／性能提升；共享账本7秒、取锁4秒、prepare60秒、submit120秒和独立验证预算保持。
- 154及专用源码已可恢复归档到本云工作区r5-closeout-evidence/review60-withdraw154-20261024，正常精确migration grant已撤销。43个路径逐文件恢复为引入154前摘要，保留153有效修复、C1留证／140现行绑定和既有清理。当前迁移总数153，完整守卫恢复146唯一正文；无历史迁移回改、兼容白名单或已有154库降级。旧FAIL／UNKNOWN／语义PASS与对应库全部保留，153真实3b仍PENDING。
- 新增真实PG边界计划：首审、终审各一次16秒仍完整提交、61秒超限整笔回滚；保持真实全量守卫、锁、决定／审计／outbox，检查全部业务表快照、行锁释放、同目标重试及原有重放审计语义。两项原生INSERT／延迟COMMIT拒绝检查迁入当前测试，独立oracle不删除。先静态／单测／类型／lint及独立复核，通过后一次300秒隔离边界包，全绿才原600秒满额一次，首FAIL／UNKNOWN停止留库；本段写入时均尚未执行，不预填通过。

### 2026-10-24 审核边界完整通过、满额正式账本提交首红

- 类型、定向lint、258项定向单测、20项历史prefix独立入口、AUTHZ／CODEMAP／counts／migcount生成物检查均通过。独立复核纠正了测试w98硬编码、CI客户端入口及派发／清理窗口不一致后为0 BLOCKER／0 SHOULD-FIX；没有变更真实权限、守卫或普通7秒。临时精确grant已撤销；旧库仅正常改名保留。
- 真实153边界包11:45:33→11:49:03 UTC一次PASS，整体209493.201ms，5项测试／0失败／0跳过。先first61／final61，再first16／final16，四个受控等待各一次；61秒两项均P2028、全业务表快照完全回滚、原三把行锁可独立NOWAIT重取，同目标重试恰好一份决定／通知／批次、重放仅增加既有replayed审计；16秒两项真实提交。原生INSERT／延迟COMMIT均23514拒绝并全表回滚。边界库OID277682保留，旧154满额失败OID269046正常改名保留；回执在r5-closeout-evidence/review60-boundary-20261024。
- 条件满足后仅运行一次原完整满额，11:49:49→11:55:21 UTC，整体332259.785ms，1 failed／222未选中／exit1，首红后未补跑。新库OID286286为153／完整146正文。prepare33320ms、275查询／4 E4查询／1屏障、独立oracle21304.899ms、submit67690.400ms及原断言通过；首审17811.033ms真实COMMIT（SET17745.029ms），终审35849.319ms真实COMMIT（显式完整校验18051.766ms、commit17757.568ms），原60秒选项均已观测。
- 首错已进入正式LedgerPostingService.commitBatch：原runMemberLinearizedTransaction的7000ms预算在7563ms时过期，P2028栈为commitBatchProtocol:411→ActivityContributionSettlementService.assertVersionInTx:248。该源码在既有member／day锁内重新执行完整版本／账本校验；当前没有这段提交的细分SQL计时，不能凭错误帧指认某个内部热点或声称SQL优化完成。账本7秒及每次取锁4秒均未改，最终summary／draft及formal oracle／后置探针均NOT_RUN。
- 保留库上仅做一次有界只读状态核对（OID／角色／零其他连接及D3租约先核，statement_timeout3秒）：run=posting、version=approved，首终审approve各1；批次ready、prepared2000／total2000、committedAt为空，准备分录4000、贡献分录2000、合计1000.00，committed批次关联的正式可见分录0。此为当前状态证据，不冒称有提交前整库快照；原FAIL不改绿。库及全部14份归档均保留，原控制器清理连接／D3锁0，随后只读客户端均正常关闭。
- 本轮证据在r5-closeout-evidence/full-maximum-review60-153-20261024；153来源修复／审核60可行性与原容量整体FAIL分别登记。下一必要工作是保留完整性、共享7秒和原子切换约束下收敛正式提交校验工作量，未实施新修复或再次测试。153真实3b、最终候选提交／CI／Smoke、全仓兼容清理余项仍未完成；不代签、不生产、不扩大500或发布被拒绝PR正文。

### 2026-10-24 普通E4正式账本具名预算（实施中）

- 维护者明确委托较小9核心路径方案；仅顶层普通policy_v1 E4提交60秒，完整校验／实时基线／权限／锁与原子审计outbox保留。共享7秒、D7 15秒、取锁4秒及10槽不变；这是内部工程合同精确例外，不是性能提升。根与父键持锁后复判，旧批次重放读取自己的根。无seal字段／新迁移，153及全部失败证据保留，154不恢复。
- [工程合同修订及有限队列](activity-os-r5-e4-ledger-commit-budget.md)：定向静态／独立复核→真实8秒提交／61秒全回滚与锁释放／一次重试重放／分类漂移→全绿一次原满额。当前未运行PG边界／满额，不宣称通过；摘要5秒和oracle SQL30秒未改，PSet历史优化比较单列如实报告，未删断言。

- 本轮真实边界13:01:14 UTC开始，整体109528.253ms后首红停止，未补跑／未运行满额。61秒用例通过：实际调用61327.758ms报P2028、全业务表快照回滚、锁释放、同目标一次重试及重放不重复。随后8秒用例在进入真实审计延时前失败，新增测试复用了同一成员同一2020-03-01 08–09时段；保留库只读核对确认第二ready批次命中既有跨活动已生效段重叠谓词，未改守卫。原服务错误未保存，被注入次数断言遮住，不能冒称已捕获具体业务码。其后三项因首红保护未执行；Jest整包1passed／4failed，不算绿。OID294935保留、连接0／D3锁0，旧账本7秒失败OID286286已正常改名为app_test_w98_c1_ledger7_failed_20261024。下一恢复仅修单测试文件的整日隔离和原错误留证，不重复已通过61秒；完整候选仍未验收。

- 单测试文件恢复已按明确委托执行：完整startsAt／endsAt／全部manualSlices按目标序号整日平移，重试重放复用原输入；断言前保留原Error及完整code／cause。5组离线夹具检查、6组有界自有进程退出检查、受影响类型／lint和独立复核通过。13:16:03→13:17:03 UTC补验整体59507.132ms，4passed／0failed，61秒明确未选中并复用原PASS；8秒实际8176.418ms完整提交、原生守卫与审计outbox保持且锁释放；两种错误分类拒绝并全表未变，标准7秒／Human D7 15秒／RC／4秒原档位验证通过。OID294935正常改名保留，恢复PASS库OID303539亦保留。只在上述通过后启动本候选唯一原满额，结果尚待终态。

### 2026-10-24 普通E4预算候选唯一满额终态

- 仅在补验四项全PASS并复用原61秒PASS后运行一次原完整满额，13:17:45→13:23:32 UTC，整体346293.487ms、1failed／222未选中／exit1。新库OID312150为153／原完整146；所有归档保留、最终连接0／D3锁0，未补跑。
- prepare阶段33059.392ms（原prepare计时器33070ms、275查询／4E4／1屏障）、完整前置oracle22640.541ms、submit71139.822ms及原断言通过；首审18974.343ms、终审35744.261ms真实提交，观测均60秒。LEDGER完整阶段113855.724ms包含双审／私有准备／正式提交，不能冒称单独commit耗时；服务提交成功、replayed=false，2000条contribution_credit合计1000.00的原断言通过。
- 首错转移至正式SUMMARY_CHECKS：读取28.037ms成功，但实际4条查询超过原上限3。摘要内容断言、最终draft／formal完整oracle、后置PSet均尚未执行，不能宣称满额或完整R5通过。原3查询／5秒及所有其他预算未改。
- 只读源码与独立复核确认正式摘要expected为空时仍加载timeRevision.sourceSetHash，却不使用该关联；最小候选为仅expected存在才加载，保留草稿已知／NULL／变化hash防护及所有输出和分页。拟改query service和对应spec两路径，尚未实施；现有日志未保存四条SQL全文，第四条来源不确定，不凭猜测排除计数。先定向验证及保留库一次只读摘要检查，不自动重跑满额。153真实审阅／最终候选提交CI仍待完成。

### 2026-10-24 摘要精简及保留库后置续验

- 明确委托仅在expected存在的草稿来源校验路径加载timeRevision.sourceSetHash；正式HTTP调用不传expected，presenter使用贡献根自己的hash。两源码路径保留原完整根、100条投影、排序、NULL／变化hash拒绝及错误透传，权限调用点不动；167项定向单测（含HTTP权限拒绝、草稿、空／非法读取）、类型和lint通过，独立复核无业务阻断。AUTHZ仅原生成器两摘要、663权限声明不变，grant已撤销；CODEMAP只机械行数刷新。
- 未改名／复制OID312150，未重放submit／两审／记账。13:47:26起后置包整体80775.264ms全部通过：正式摘要2条业务查询／方法25.759ms、原5秒事务、8000评价／1000.00／hasMore／100条输出；最终draft与formal原完整oracle分别26164.071／24546.797ms通过，完整差集和根hash断言未放宽。原day oracle允许pg_temp函数并强制ROLLBACK，原SQL30秒／day事务60秒／其他事务30秒保持。
- PSet原AB、BA独立顺序均通过：candidate执行6591.337／6351.934ms分别小于old7262.349／7773.417ms；candidate临时写70055块小于old96088块，8000全行／pairs和差集0均通过。它是历史137优化基准，不是完整现行流程响应SLA。公共根／batch／分录数／提交审计outbox核对不变（非全库快照），原临时对象ABSENT、所有连接0／D3锁0、租约关闭。
- 本次是明确后置续验，不将原整轮摘要4查询FAIL改记为PASS，不把分段证据冒充最终代码一次全链验收。最终代码绑定全链、153真实人工审阅、候选提交／最终CI／Smoke及全仓兼容清理余项仍分别PENDING；生产／500准入／代签／被拒绝PR正文未动。证据e4-summary-read-20261024。

### 2026-10-24 最终冻结代码原满额全链通过

- HEAD仍e31753ed，73路径工作树候选；测试前后2890文件完整清单SHA256均为7670e2289425e4f236300644eae90aa9a237a8c9f115d7478dbb596d1a2fc60e，代码清单SHA256为a7c761081f275e67a5e3bbc885f059f521e1f18246d4e13b82c7872f456fe58d，期间无源码／预算／断言变更。153唯一新增SQL保持8be33faf摘要，154未恢复。
- 仅运行一次最终原完整满额，13:58:50→14:06:00 UTC，外层430406.046ms、exit0，1项selectedPASS／0FAIL／222未选中（不是223项全部执行）。2000身份／10000段／50000slice／8000评价；prepare34197.173ms（原计时器另记）、前置oracle24888.568ms、submit71583.499ms；首审19584.643ms／终审39722.521ms均真实60秒事务提交。LEDGER119986.536ms包含双审／私有准备／正式过账，服务与2000条贡献分录合计1000.00断言通过，不冒称单独commit耗时。
- 正式SUMMARY原同一连续流程为3查询、21.897ms，原三查询／5秒及所有输出断言通过；最终draft／formal完整oracle23682.633／22987.979ms通过，原PSet AB／BA两组速度／临时写及完整性判据通过，最后普通清理完成。prepare60／review60／具名普通E4commit60、默认7／D7 15／取锁4／10槽均保持；不升级为HTTP SLA。
- 新工作库OID320811保留；OID312150仅正常改名为app_test_w98_c1_summary4_failed_tail_pass_20261024，19个留证库／归档保持，所有连接0／D3锁0。完整原FAIL及后置续验记录均不覆写。结果在r5-final-full-frozen-20261024，已准备精确73路径清单、真实153审阅摘要和同SHA最终CI／Smoke计划，尚未提交／推送或代签。
- 此次完成原容量完整开发验收，不等于最终集成CI／main审计或生产上线。153真实3b、最终候选提交／CI／Smoke仍PENDING。全仓清理仅首批3构造器／2重复provider／孤立常量／旧诊断入口已完成，其他通知／公开旧API／实际使用版本兼容余项独立列出，不能称整个仓库已清干净。

### 2026-10-24 current-state 历史状态原文迁存

以下三段逐字保留恒读入口迁存前的历史状态；包含当时尚未完成的声明和旧候选失败，不代表当前验收结论。入口只保留现状与本记录链接，readtax既有9600字符预算和判据均不改。

```md
> **2026-10-24 普通E4提交预算例外（实施中）**：维护者明确委托普通policy_v1 submitted/time_revision账本提交独立60秒，锁后复核根／父键／更正分类；共享标准7秒、Human D7 15秒、取锁4秒和10槽不变。保留全部完整校验及同事务审计／outbox，不增加封存模型或迁移。更长连接／锁占用是明确代价，非SLA或性能提升；真实61秒回滚／锁释放／重试重放已通过；夹具恢复后8秒完整提交及另三项补验全部通过，原61秒未重跑。全部失败库保留；原满额完成正式记账后因摘要4>3首红，失败保留；精简后在OID312150续验摘要2查询／25.759ms、最终双oracle和PSet全部通过，未重放业务。最终冻结代码原满额全链已一次PASS（430.406秒含初始化、摘要3查询、最终双oracle和PSet均过，OID320811保留）；153真实人工审阅及最终提交／CI／Smoke仍PENDING，生产／active500不动。详见[精确工程合同修订](plans/activity-os-r5-e4-ledger-commit-budget.md)。

> **E4/E5 当前边界（2026-10-18）**：后端按受限500身份／current段、2500物理slice、2000评价单元推进；原R5最大规模仍未验收，旧满额超30秒的失败不关闭。更正来源hash的数据库NULL缺口已真实复现，新增147 validated CHECK修正，历史SQL／函数／ACL／预算不变。非空146→147、NULL整笔回滚与有效V3/4分录/重放已通过；preparing/pending跨API和实际worker进程重启、native guard后授权callback拒绝的PG回滚已有本轮证据，最终候选检查另记。[续推与审查记录](plans/activity-os-r5-continuation-20261018.md)。默认off，active→off仍恢复旧规则管理写，永久cutover latch未实施；前端、实际目标旧数据盘点／转换／shadow适用性、fleet、worker排空、稳定窗与生产切换均未完成。137–147的3b已由维护者实际审阅认可并登记；最终main CI、Trusted人工批准与实际发布准入分别核对；尚未部署，生产NO_GO。

> **2026-10-20 来源hash候选148**：1c3157e隔离升级6项、普通R4十五项通过；默认CI原R4满额通过，prepare 15882ms，查询334/42/805，预算和断言不变。整体CI仍FAIL：D7 Human V3 2000身份报P2028（7077/7000ms），另有文档治理失败；旧42703及receipt超30秒失败保留。148的3b／Trusted待审，原R5/E4满额与S13未验收，R5未完成、生产NO_GO。见[结果](plans/activity-os-r5-source-hash-envelope-20261019.md)。
```

### 2026-10-24 153真实认可登记与候选收口

- 维护者于2026-10-24 16:40 UTC（用户UTC+8为2026-10-25 00:40）直接回复包含“认可153迁移审阅结论并允许登记”的确认消息：“继续推进啊 批准啊”。已据真实回复更新CUTOVER_SIGNOFF六字段及migration-total=153；Codex仅代理登记认可此前解释的结论，不称用户亲自逐行审查源码，旧148–152审批原文保留。登记提交5e913fd7，签字门禁及格式通过。
- 同轮补查发现登记前已有current-state为10102/9600字符；仅将以上三段原文迁存于此、入口改为准确现状与链接，不改守卫或预算。既有满额PASS、旧FAIL和所有留证库保持；业务实现及SQL未改，没有重跑已通过容量测试。
- 最新PID测试修正提交e176b0a9仅给两条锁观测查询的四个原PID绑定加显式整数CAST，全部原断言和参数绑定保留；Harness三组596/138/68项均零失败，类型／定向lint及77项单测通过。原满额全链证明仍绑定3182ba24的业务实现，不冒充后续改动已获最终CI。
- 源码推送与本仓候选PR有独立2026-10-24 16:41 UTC用户明确许可；本记录不冒充推送／PR／最终CI／Smoke已经完成，也不授予Ready、合并、生产或扩大500准入。全仓清理仅首批完成，下一批不混入本候选。

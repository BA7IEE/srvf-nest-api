# PR1380 受限 CI 实证与收口

PR1380 仍为 Draft／BLOCKED。旧 `9c5c60d6` 的500全链通过证据保留；两个新增小夹具窗口均失败，静态修复不倒签。只在 srvf-nest-api 云环境工作，Mac 无需动作。

## 普通 CI 失败与兼容修复增量

edf5c9aa普通CI39046228028已结束FAIL：500整例实际PASS（prepare入口4次含3负例、2000 evaluations、500 ledger pairs、冻结oracle及COMMIT），501身份／501current段／2501物理slice均20225且196表不变；shape／bytes负例及单人base冻结oracle／COMMIT通过。唯一业务spec失败在unchanged-time复制证明的测试oracle：oracle0、stored4、storedDifferences4、rootMatches=true；新helper遗漏既有assertFixedE4Oracle的复制分支，不能据此判业务算法错误。当前仅复用同SHA既有合同，核四项根字段、完整evaluation文档及固定根aggregate，再递归前驱的冻结oracle／day；不改SQL/pins、expectedCount4／differences0或业务源码。原实现快测RED6通过4失败，修复GREEN10／10；完整测试类型／定向lint及最终SHA普通CI另记。未完成的resumable／unchanged COMMIT／V3／长源负例继续待实际CI；独立额度仍38／43、历史性能4／4，无新增手动DB或满额。

`50b7d635` 的第三轮普通CI [39043784343](https://github.com/BA7IEE/srvf-nest-api/actions/runs/39043784343)已结束FAIL：Fast checks／Harness／Docker及E2E2–5通过，E2E1为2失败／1694通过。新增shape／bytes实际generate均409／20225、原政策来源断言通过，各196表前后逐表及根hash一致、零变化表；两项局部通过必须保留。500及单人BASE首次prepare均HTTP400／40000，后续501反例／纠错／V3／账本未完成，不能宣称全链通过。

只读定位确定夹具prepare误展开allocation expectation，多发三个revision字段；真实`AppPrepareTimeSettlementDto`只接受operationKey／expectedDraftVersion／expectedEvidenceSealId／expectedTimeRevision。CI未保存400明细，不倒填其响应字段；新离线真实DTO＋strict whitelist复现恰三项错误，红5通过／1失败，显式四字段投影后6／6通过。allocation接受其三个revision，两个submit本已显式五字段；只改测试请求和新增三项纯契约测试，生产DTO／全局白名单／业务断言不变。测试类型34.255秒、两文件lint27.664秒通过，无app／DB调用；必要新普通CI结果另记外部包，独立尝试仍38／43、不追加手动性能或满额。

`866451fd` 的第二轮普通CI [39042031516](https://github.com/BA7IEE/srvf-nest-api/actions/runs/39042031516)也已结束FAIL，merge `19dc4ac3061ed48c1dd3147d2de69e2c46e54e6a`与head tree相同。E2E2／3／4／5和Fast checks／Harness／Docker全部通过：outbox实际spec PASS114.329秒，D6并发worker实际spec PASS19.929秒。E2E1新增两例均在真实封场返回503／20153，尚未到generate／prepare，全部196表准入验收NOT_RUN。上一轮只启用了测试职责开关，遗漏普通CI创建app时的v1.1开关；installer仅设置settlement mode，不会自动启用v1.1。

当前最小增量只在同一个`createE4Fixture`期间同时设置职责与v1.1测试开关，`finally`逐项精确恢复原值／缺省；显式断言实际ActivityWorkflowGate已启用且非只读。未改只读维护环境变量、生产默认值、旧业务断言或30／600秒预算，未新增独立DB／手动500或满额。本次测试工程类型检查47.023秒和单spec lint50.376秒通过，只读复核无阻断，没有本地应用／DB调用。当前增量的真实业务结果仍待新普通CI，不能把第二轮失败或先前500通过倒签。后续最终SHA日志在PR checks和外部补充包，仓内本段是推送前记录。

`6cd414c2` 的普通CI [39039566624](https://github.com/BA7IEE/srvf-nest-api/actions/runs/39039566624) 已结束FAIL；实际merge SHA `6622b1361a57c7389647929aac8579317fd69bea`与head tree相同。Fast checks（含正式冷lint／完整类型／全单元／构建）、Harness、Incident replay、Docker build／smoke和Golden journeys通过，E2E2／4通过，1／3／5失败。E2E1新增两例都在审批返回409／20030，尚未到generate，196表验收NOT_RUN；E2E3十例被SWC target/getter编译错误阻断；E2E5两例child在ready前退出，旧stderr未保存，不能倒填为相同根因。

当前增量完整类型、461套10266项单元／8快照（5个原todo）、五文件定向lint及权限／CODEMAP检查通过；完整冷lint／Harness交由新普通CI，旧6cd结果不倒签。当前增量将dispatcher的contributions改为必需DI：ActivitiesModule已有真实provider，缺失时Nest拒绝装配，26项定向回归通过，含真实ContributionService＋查询替身；这不是数据库验收。新spec只在createE4Fixture期间临时启用责任工作流并finally精确恢复，匹配已实测runner：审批createOwnerForPublish需要该测试配置，未造业务状态或改默认开关。两个测试child仅指定ES2022编译target，保留原ts-node／SWC preload和Nest元数据：根ES2023不在已安装ts-node10映射中，会回退ES3。无DB探针复现旧getter错误、新target编译实际provider并保留构造参数元数据；实际child/IPC及业务回归仍待下一次普通CI，不启动独立DB窗口。

准入前移只保证首次新native操作在reservation可识别的超界不创建operation receipt。后续生成失败仍可合理持久化failed job/item；failSync、旧失败回执重试和成功重放保留。两事务仍有间隔，不宣称解决等待后撤权或替代纠错实测。旧窗口实测只有整体196表指纹不等；`ActivityBatchJob`／`ActivityBatchJobItem`提交副作用属于执行链推断，不能说实测仅两表变化或排除背景写。

## 实际数据库结果

| 窗口 | 实际结果 |
| --- | --- |
| 旧500全链 `9c5c60d6` | 原业务源码 `8385d67b`；461.561秒／600，容量prepare4／4，语义32组，冻结root／day oracle零差异，账本实际COMMIT，正常清理。此后HTTP生成调度源码发生变化，不能把旧结果冒充当前SHA全链证明 |
| 首次小夹具 `f6324dc1` | 100.705秒，外层102.925秒；1库／1活动、restore0、prepare0、性能0、retry0。schema/catalog及cleanup通过，policyShape失败，其余5组NOT_RUN；累计35／40次尝试。旧safe日志未保存HTTP码，不能事后补写20225 |
| 新批准小夹具 `bb17bbce` | 81.424807874秒（清理标记81.423732889秒），外层82.076196424秒；1库／1活动、restore0，generate1／2、prepare0／5、性能0、retry0。首个真实generate HTTP409／Biz20225、data=null及原冻结政策异常来源断言通过，随后196表指纹相等断言失败。schema/catalog及cleanup通过，policyShape失败，另5组NOT_RUN；累计38／43次尝试，不是38项通过 |
| 最新清理 | app／observer关闭，正常DROP本人库，lease释放；独立databases／clients／leaseBackends／leaseLocks全0，pending0、UNKNOWN=false，进程组消失。没有重试；剩余5个组额度不构成再次建库授权 |

最新窗口未保存逐表before/after，不能声称精确变化表数或哈希。静态调用链显示 `SettlementDraftDispatchService` 在独立事务先创建job/item，底层generate拒绝后再持久化failed；这解释了政策码正确而全表指纹失败的路径。

当前最小修复把现有active准入放在Activity锁内、operation重放与原seal/run状态检查之后、首次job/item写之前；沿用draft优先、history回退及旧字段undefined→legacy冻结规则，fixture/off和既有回执路径保持，生成器原准入不删。改编排前2套15项characterization通过，修复后2套24项回归通过。仍是两事务，不能宣称并发变化或所有后续失败都零持久写。未来CI在断言前保存逐表名称及hash，不输出原始行或凭证，也不排除任何表。当前修复的真实HTTP／196表验收仍待普通CI。

## 已执行的明确委托与 CI 修复

用户 `Sentinel_3b0058ac228881919495d8a2fe269c77` 批准上述一个新尝试及累计43组上限。用户 `Sentinel_6d3c627808a481919c555c52c1cbdddc` 又明确委托执行既列五个精确grant。仓库[默认规则](../../AGENTS.md#1-机器执法清单违反--物理拦截或-ci-红不必背)要求“由维护者”运行并禁止AI自主发放；本次按更高优先级用户的具体执行指令处理，正常CLI逐个记录“用户授权、AI代执行”，不冒称维护者身份，不解释成默认规则放开。没有修改grant工具、令牌路径、Trusted或SQL签字。

五个目标：`scripts/check-cold-lint.ts`、`test/jest-e2e.config.ts`、`.github/workflows/ci.yml`、`.github/workflows/activity-os-r5-e4-validation.yml`、`docs/ai-harness/ROUTE_AUTHZ.md`。四份既审候选按原文件／候选SHA核对后正式应用；权限文档用 `pnpm docs:authz` 正式生成，独立核对仅两处inputDigest变化、663条entries与其余字节不变。旧[CI补丁](activity-os-r5-limited-ci.proposed.patch)及[权限候选](activity-os-r5-limited-ci-authz.proposed.patch)保留为历史审查材料，后者摘要已被当前源码生成值取代，不再是待执行指令。

默认配置仅排除原2000身份／10000段／50000slice用例的完整标题，同文件其他安全断言继续收集；手动正向CLI pattern可覆盖默认pattern。当前正式配置的真实 `--showConfig`／`--listTests` 核验441文件，包含原scale、新业务和纯输入spec，数据库调用0；原scale字节SHA256仍为 `5408651f58567fe8b9468f93326686ede1b6ac4da1d15028784fd0c3e3e51d87`。原满额标为 **NOT_VALIDATED_FOR_LIMITED_LAUNCH**，专用workflow只保留原 `workflow_dispatch` 历史／手动入口，移除push自动触发。required job名称、依赖、规则与其余业务断言保留。

普通CI按已授权范围收集受限500回归和新增小语义spec；独立实验不再手动重跑500或满额。spec被收集不等于已通过，结果按最终SHA记录。

## 正式非 DB 验证与剩余门禁

当前完整root／test／scripts `pnpm typecheck` 已通过；纯输入两套11项通过，不冒充live验收。冷lint脚本36项自检、权限生成物检查及边界元数据检查通过。新增源码与spec使CODEMAP计数过期，已用正式生成器刷新；3b仍因签字migration-total136、实际146失败。

冷lint旧串行原入口在300.314秒失败，单CLI候选在300.649秒失败，均保留。两原CLI并发候选覆盖2007文件、0诊断、272.441秒，峰值11.53GiB；正式入口保留共享300秒、每进程6144MiB、原globs／projects／规则及累计64MiB报告上限，所有已启动子进程结束才返回。当前正式冷lint通过：2011文件0错误0警告、内层290.146秒、外层291.482秒，峰值11.86GiB，子进程全退出；完整单元461套／10264项／8快照通过，保留5个原todo。记录在[机器记录](activity-os-r5-limited-ci-validation.json)；最终SHA的GitHub结果在PR checks及补充包，不以外部候选替代正式结果。

维护者剩余动作仅限实质门禁：实际审查[137–146 SQL目录及SHA](activity-os-r5-limited-ci-migrations-137-146.json)，按既有[3b位置](https://github.com/BA7IEE/srvf-nest-api/blob/codex/activity-os-r5-e4-github-validation/docs/ai-harness/CUTOVER_SIGNOFF.md#L222)确认；最终SHA在[Trusted](https://github.com/BA7IEE/srvf-nest-api/actions/workflows/redzone-trusted.yml)批准。AI未机械改数、代签或批准；未发现4b漂移，不另要求重签。普通required CI和Trusted未闭合前，不Ready／合并。

旧结果包Library `libfile_51b7d5b89ba48191b92d1a17d635898e`（SHA256 `a2ac5e4924f5dfcb227a9f8c0e014f200cc2639a2598722d012d604e63f5e8d1`）与上一补充包 `libfile_9f7083a83b208191801a422aa632a8bf`（SHA256 `18e2a076f7370bb8acbed1d21c247a28856c36409d960b4b6979f2c000a14ccf`）保持不变。最新窗口的journal／HTTP观测／清理、实测源码及委托grant记录另出补充包，不覆盖旧失败。

**本次未做：** 未重跑A/B、500独立窗口或原满额，未重启同一DB尝试，未放宽30／300／600秒、guard或既有断言；未改生产SQL／schema／migration／默认开关、未读写生产或用户Mac；未自主决定grant、未代签3b／Trusted、未Ready／合并／部署。


## 2026-10-17 重放／V3 尾链契约与旧 D6 独立调查

4f4db745普通CI39048441257完成FAIL：Fast checks（461套10266项／8快照、冷lint2011文件零诊断206.425秒／原300秒）、Harness、Docker及E2E2／4／5通过；E2E1首次unchanged-time复制oracle已通过，随后只因初次replayed=false／重放true的预期差异被错误整对象比较拦住，unchanged COMMIT／V3／长跨度负例仍NOT_RUN。当前显式断言两次标志并比较其余全部事实，保留原gate不重入及196表不变；V3去掉真实闭集parser不接受的请求intervalKindCode（由服务端补入），共享的两条请求均用实际parser快测。RED11通过5失败→GREEN16／16，无应用／DB调用。两次commit现在先检查真实返回状态、批次／版本锚点、落库committedAt及完整账本条数，再输出通过；长跨度负例保存前后逐表快照并call-through观察原span guard的scale_limit及真实长源输入，避免20225误归因。真实尾链仍等新SHA普通CI，不将快测当DB验收。

E2E3旧D6原2000人数用例仍是独立必过项：prepare实际HTTP500／Biz50000／P2028，原30000毫秒、记录52763毫秒，尚未进入worker2000测量／COMMIT。此前四次同源码用例通过，但未采集prepare耗时；通过轮也与D7有重叠，不能据此认定随机抖动或共享争抢，根因UNKNOWN。当前只在下一次必要普通CI的原2000 prepare复用既有有界engine request／transaction观测并记录UTC及本Jest进程CPU／event loop，无新增查询、数据／worker／超时改动。Promise在途时间和事务桥接时间不等于PG执行时间；截断／pending／安装恢复异常保留UNKNOWN。R5受限500通过不抵消D6失败。独立额度仍38／43、历史性能4／4，不建新手动库或盲重跑。

本次未做：未修改业务源码、SQL／pins、guard、原30／300／600秒或CI控制面；未重跑独立500／原满额／A-B，未触及生产或Mac，未代签3b／Trusted或Ready／合并／部署。


## 2026-10-17 当前业务验证收口与 Smoke 就绪修复

c4489ab8普通CI39051183562的五个E2E分片、Fast checks、Harness、事故回放、Docker构建及Golden journeys均通过；整体仅3b136/146签字差异FAIL。原生整例345.156秒、10检查点齐全：受限500/2000eval/500ledgerpairs、冻结oracle、两次更正真实COMMIT各4分录、重放两标志及其余事实一致、长来源原span guard拒绝20225且196表逐表/根hash零变化。旧D6原2000全链独立通过，prepare服务墙钟12.971秒、222桥接/pending0/COMPLETE，随后worker及COMMIT完成；该次模式off，不代表active R5满额2000验收。原30秒未改，旧52.763秒P2028仍FAIL，历史根因UNKNOWN。原R5满额仍NOT_VALIDATED。完整c448证据Librarylibfile_7beae1a119d081918e67e8cff6171d6f，SHA25695c7f3e2fc0f2e49e25791ab82bb48006b07f362cf459849f56c5ab1e8b6aa1f保持不变。

独立Smoke39051183515/job117449920736生日单次grep在16:54:02.780返回1，16:54:02.920清理日志已含原注册锚行及Nest started；支持启动/日志可见性竞态推断，不证明精确传输根因，旧Smoke保持FAIL。当前最小修复只将同原锚行加入已有60次health readiness条件，后续原生日assert与其余Smoke不变，既不删断言也不另加轮询窗口；60次不是严格60秒墙钟。四项离线shell检查、补丁适用性及只读复查通过，无应用/DB调用；新SHA真实Smoke/CI结果待GitHub，不以候选快测倒签。

授权判断补正：用户既有“GitHub 工作流需要的话就补上”、此前明确委托grant及持续推进指令覆盖该必要工作流小修。AGENTS37–38要求先有用户授权再以精确token落实，并未逐新路径规定再次用户往返；不能把新token等同新批准。当前正常CLI仅对.github/workflows/docker-smoke.yml登记“用户授权、AI代执行”后应用，已正常clear；未冒称维护者、未手改token或授权工具。旧c448包的“未应用/待新增授权”是当时判断记录，不重写；此补正不是把3b/Trusted或默认规则全放开。3b真实SQL审查、最终SHA Trusted、Ready/合并/生产仍独立保留。

本次未做：未新增独立DB、手动500/满额/A-B或重试，未改业务源码/测试/SQL/guards/默认开关与30/300/600秒；未操作生产或Mac，未代签3b/Trusted、Ready、合并或部署。

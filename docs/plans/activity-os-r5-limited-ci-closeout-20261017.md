# PR1380 受限 CI 实证与收口

PR1380 仍为 Draft／BLOCKED。旧 `9c5c60d6` 的500全链通过证据保留；两个新增小夹具窗口均失败，静态修复不倒签。只在 srvf-nest-api 云环境工作，Mac 无需动作。

## 普通 CI 失败与兼容修复增量

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

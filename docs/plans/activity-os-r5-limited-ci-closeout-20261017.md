# PR1380 受限 CI 收尾与维护者动作

本轮代码和可审补丁已准备，PR 仍为 Draft／BLOCKED。旧 `9c5c60d6` 的500全链通过不回退；本轮新小夹具失败，不用静态修复倒签。只在 srvf-nest-api 云环境工作，Mac 无需动作。

## 实证结果

| 项目 | 结果与限制 |
| --- | --- |
| 冷 lint 原因 | 原脚本直接启动 Node ESLint CLI，300秒在脚本内计时，不能归因于 pnpm 依赖校验。准备约6秒；原串行src真实CLI178.128秒通过，test在总300.314秒SIGTERM，prisma NOT_RUN。三个typed CLI的分析／格式化耗时累加超过原窗口 |
| 失败候选 | 单CLI合并全部globs仍在300.649秒超时。采样显示GC、synckit／structuredClone、TS AST等成本；不把采样推断成单一规则归因。失败保留 |
| lint 修复候选 | 最多两个原CLI并发，保留原globs、规则、projects、每进程6144MiB、共享300秒及64MiB报告上限，等待所有已启动子进程终止。2007文件0错误0警告，272.441秒，外层273.949秒，峰值11.53GiB；36项自检通过。交付候选与实测版规范化AST相同，虚拟替换正式脚本的类型检查零诊断 |
| 当前静态 | 修正后的test项目typecheck通过；5个相关文件定向lint通过；原8项离线夹具及新增3项合法输入反例共11项通过。以上不冒充当前完整冷lint或DB验收 |
| 唯一新DB窗口 | 测试SHA `f6324dc12a1a47e924729cb327b092724e3a0261`；100.705秒，外层102.925秒。restore0、新库1、actor fixture1、实际活动1、性能0、prepare0、retry0。8个计划语义组只尝试3组：schema／catalog及cleanup通过，policyShape失败；其余5组NOT_RUN。连原32组为35／40次尝试，不能称35项通过 |
| 新窗口失败 | 在REAL_GENERATE要求HTTP成功的夹具断言失败；实际HTTP status／业务码未被旧safe日志保存，不能事后补写20225。源码`settlement-draft.service.ts`在generate已做冻结政策准入，夹具误要求它先通过再到prepare测拒绝。现改为真实seal后直接测generate的409／20225、原异常来源及196表回滚，无伪造draft；该修复尚待普通CI实跑 |
| 清理 | app／observer关闭，正常DROP本人库，lease释放；独立databases／clients／leaseBackends／leaseLocks全0，pending0、UNKNOWN=false，进程组消失。没有重复启动数据库测试 |

新增业务spec默认由普通E2E收集：500／500／2500／2000及501／501／2501边界、原30秒事务、196表回滚、冻结root／day oracle、实际账本配对／金额／分类／日状态；另覆盖单人policy／bytes、真实unchanged-time复制和resumable、V3变时长，以及已批准纠错意图的完整长段＋短manual slice拒绝。后者不代表合法COMMIT过长current段。本轮没有实跑新增500函数或修正后的现场反例，不能据spec存在填绿。

## 普通 CI 的最小修复

[CI／lint可审补丁](activity-os-r5-limited-ci.proposed.patch)尚未应用。默认配置只排除原满额用例的**完整标题**，同文件所有其他断言仍收集；Jest真实`--showConfig`确认手动正向CLI pattern可覆盖默认pattern，邻近标题不被过滤；真实`--listTests`收集441文件，包含新增业务／离线spec和原scale文件，数据库调用0。原scale文件字节不变，SHA256 `5408651f58567fe8b9468f93326686ede1b6ac4da1d15028784fd0c3e3e51d87`。

原2000身份／10000段／50000slice容量用例标为 **NOT_VALIDATED_FOR_LIMITED_LAUNCH**；专用workflow仅保留`workflow_dispatch`历史／手动容量入口，移除标记push触发。普通required CI和夜间leaks继续通过共享配置运行全部仍适用测试，新增受限边界spec自动收集。required job名称与依赖不变，没有删改旧业务断言、放宽预算或生产SQL。

[权限生成物候选](activity-os-r5-limited-ci-authz.proposed.patch)只改ROUTE_AUTHZ两处inputDigest，663条entries及其余字节不变。正式lint／配置／workflow及ROUTE_AUTHZ目前都仍为原文件，不能把外部候选通过当作正式入口绿。验证汇总见[机器记录](activity-os-r5-limited-ci-validation.json)。

## 维护者最少动作

1. 打开选定 **srvf-nest-api 云环境的仓库终端**，确认当前分支，再由维护者本人执行下面五个精确grant。无需在Mac执行任何`/workspace`命令。限制来自[AGENTS.md §1](../../AGENTS.md)：“AI 不得自行发放授权。” 用户已授权修复范围，此处只缺维护者实际写权限令牌。

```bash
export pnpm_config_verify_deps_before_run=false
git branch --show-current
for r5_grant_path in \
  'scripts/check-cold-lint.ts' \
  'test/jest-e2e.config.ts' \
  '.github/workflows/ci.yml' \
  '.github/workflows/activity-os-r5-e4-validation.yml' \
  'docs/ai-harness/ROUTE_AUTHZ.md'
do
  pnpm harness:grant "$r5_grant_path" --reason 'PR1380续令：冷lint、500受限CI及两处权限生成摘要；3b与Trusted仍由维护者处理'
done
```

grant到位后AI可继续应用已审候选、重新生成并独立核两处权限摘要、正式冷lint及正常受限CI；修正后DB反例交由该普通CI验证，不追加本地手动窗口。当前本地35／40计数不因CI尚未运行而补齐。若另要求重新跑独立现场窗口，须明确新尝试：最小为1个新库、3个单人活动、最多600秒含90秒清理、2次generate负例及5次prepare、8个语义组、性能0；相对现有35／40至少增加3组额度，不能默认为原无重试授权。

2. 维护者实际审查[137–146 SQL逐条目录／SHA](activity-os-r5-limited-ci-migrations-137-146.json)，然后按既有[3b登记位置](https://github.com/BA7IEE/srvf-nest-api/blob/codex/activity-os-r5-e4-github-validation/docs/ai-harness/CUTOVER_SIGNOFF.md#L222)确认。当前签字覆盖136、实际146；AI不机械改数、不代签，也不要求无漂移的4b额外重签。
3. 所有变更提交后，维护者仅对最终SHA在[Trusted工作流](https://github.com/BA7IEE/srvf-nest-api/actions/workflows/redzone-trusted.yml)批准。当前required CI及Trusted人工门均未关闭，PR不得据本文件Ready／合并。

断连接续可直接使用同一保存云环境：未执行补丁均已仓内可审；完整新窗口journal／cleanup、实测版源文件与runner、失败预检、lint采样与候选结果保存在Library补充包`srvf-r5-limited-ci-admission-followup-20261017.zip`。无需转本机重跑，旧500证据包保持不变。

**本次未做：** 未重跑A／B、500或原满额，未重启同一数据库测试、未改变原30秒／300秒／600秒预算、未改生产SQL／guard／schema／migration／默认开关、未操作生产或用户Mac、未自发grant或代签3b／Trusted、未Ready／合并／部署。

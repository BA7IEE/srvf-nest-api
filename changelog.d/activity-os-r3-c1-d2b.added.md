新增 C1 D2b 活动指标三态选择、Template V3、Human 全局模板版本维护和 App 有界可选目录；接通既有创建/复制链，保留 V1/V2、旧创建 hash 与 v2–v6 审核契约。选择及模板命令在同事务复验当前身份、权限和引用，重放不重复写入；Quick V3 创建审计使用事务内当前身份。新增 additive 第 112 条迁移、两条人工授码权限与两个审计事件，不自动授给内建角色。App options 先校验可新选性再分页，超过 1000 候选明确 20183/409。D2c v7/Readiness、成果值、生产初始化与 Gate 切换不在本次范围。

### C1 D2b 契约误报申报（2026-09-06）

维护者已确认「确认 C1 D2b 契约误报申报方案 A」。下列两个 `contract-breaking`
块记录 R11 实际触发及人工处置，不声称旧请求发生破坏性变更，也不视为检查器缺陷已修复。
PR #1282 首轮可信扫描报告 14 处 B3，全部位于新增可选 `metricSelection` 对象的子字段。
`scripts/contract-semantic-diff.ts` 的 `flattenFields` 只记录字段自身的 required，
未保留新增可选祖先的条件，最小「可选 selection / 必填 selection.mode」案例可独立复现。
两个旧接口的顶层 required 清单与 base 逐字一致，`metricSelection` 均不在其中；
`activity-os-r3-c1-d2b-creation-compatibility.e2e-spec.ts` 的两种创建模式均验证省略字段时
创建及重放返回 201、选择保持 unconfigured、不新增选择审计。本次只补申报，不改运行时、
DTO、OpenAPI、测试断言或检查器；可信环境人工审批与合并许可仍须独立取得。

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/professional
reason: R11 把新增可选 metricSelection 内的七个必填子字段判为 B3；已复现为可选祖先信息丢失导致的误报。本块如实登记机器触发，不声明旧请求被改为必填，不消除该检查器缺陷。
impact: 专业创建的旧调用方仍可省略 metricSelection，顶层 required 清单未变；仅主动使用新字段的调用方须满足完整选择结构，旧创建及幂等重放已有真实 HTTP 兼容测试。
migration: 旧调用方无需迁移；新调用方按已生成 App DTO/客户端显式发送完整选择，或省略以保留 unconfigured。本申报不授权生产部署、首批数据初始化或 Gate 切换。
rollback: 若复验发现真实兼容性破坏，先停止合并；若已合入，则通过独立 revert PR 回退 D2b 应用改动。若已部署须经维护者另行审批停写和应用回退，保留第112条 additive schema及已写收据，不自动降库、删列或删数据。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/emergency
reason: R11 把新增可选 metricSelection 内的七个必填子字段判为 B3；已复现为可选祖先信息丢失导致的误报。本块如实登记机器触发，不声明旧请求被改为必填，不消除该检查器缺陷。
impact: 紧急创建的旧调用方仍可省略 metricSelection，顶层 required 清单未变；仅主动使用新字段的调用方须满足完整选择结构，旧创建及幂等重放已有真实 HTTP 兼容测试。
migration: 旧调用方无需迁移；新调用方按已生成 App DTO/客户端显式发送完整选择，或省略以保留 unconfigured。本申报不授权生产部署、首批数据初始化或 Gate 切换。
rollback: 若复验发现真实兼容性破坏，先停止合并；若已合入，则通过独立 revert PR 回退 D2b 应用改动。若已部署须经维护者另行审批停写和应用回退，保留第112条 additive schema及已写收据，不自动降库、删列或删数据。
-->

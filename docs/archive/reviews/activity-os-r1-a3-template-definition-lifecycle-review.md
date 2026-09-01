# Activity OS R1 / A3 模板 canonical/hash 与生命周期评审记录

> **状态：冻结，不回改**（2026-09-01）。本稿是 A3 这条 D 档 schema 变更的立项、拍板、风险和边界记录；后续执行状态只写滚动台账与 PR，不回写本稿。
>
> **维护者拍板**：维护者已确认 A3 的状态顺序为 `draft → active → retired`，并明确限定为「不改 legacy resolver、API、权限、Gate、seed、回填或生产部署」。维护者随后对本稿、`prisma/**` 与状态机登记发出 A3 专用红区授权；该授权不外溢到 A4 及后续切片。
>
> **上游合同**：[Activity OS T0-A 终态合同](activity-os-t0-terminal-review.md) §5；原始蓝图《SRVF 活动域终态蓝图与分阶段落地方案》§7、§21.3。A1、A2 已各自独立合入，A3 不重开它们的决策。

## 1. 结论

采用已拍板的方案 A：在不改变现有 `ActivityTemplate` 物理表和 legacy 解析路径的前提下，为
**`familyId IS NOT NULL` 的未来 Version 行**建立 canonical JSON/hash 口径与数据库生命周期防线。

本刀交付：

- 纯函数 `activity-template-definition.ts`：definition 必须是 JSON object，递归排序对象 key、数组保序；hash 输入固定为 `{ definition, schemaVersion }` 的 canonical 文本；`schemaVersion` 与所有 number 均必须为安全整数，十进制以后由强类型 definition 用字符串表达；
- 数据库约束：future Version 必须具备正 `version`、正 `schemaVersion`、JSON object `definitionJson`、小写 64 位 SHA-256 `definitionHash`；状态闭集为 `draft` / `active` / `retired`；
- 有效期：draft 可以尚未给 `effectiveFrom`；active/retired 必须有它；如给出 `effectiveTo`，它必须严格晚于 `effectiveFrom`；
- 生命周期 trigger：Version 只能从 draft 创建，draft 可编辑或激活，active 只能退役，retired 不可更新/删除；active 的定义、身份、默认配置与有效期全部冻结；
- 迁移前置：发现任何已有 `familyId IS NOT NULL` 行即 fail-closed 回滚，不猜测这些行的历史语义；legacy 行也不得通过一次 UPDATE 偷换成 Family Version；
- PostgreSQL E2E 覆盖 legacy 兼容、约束、正反生命周期、冻结、迁移前置失败和空库 replay；状态机 inventory 与派生文档同步登记。

## 2. 事实与风险

| 事实 / 风险 | 证据 | A3 处置 |
|---|---|---|
| 旧 resolver 仍按 `activityTypeCode + statusCode='active'` 读取 | `src/modules/activities/activity-publish-proposal-v2.service.ts` | 不改 resolver；只有 `familyId` 非空行受新闭集，旧行的 `statusCode` 保持原语义。 |
| A2 无 writer、无 seed、无回填 | A2 评审与全仓生产写路径检索 | migration 发现已有 Family Version 就失败，不把未知历史行强塞进新状态机。 |
| PostgreSQL 无内建、可信的通用 JSON canonical SHA-256 对等实现 | 当前依赖与 migration 能力 | 不引 `pgcrypto` 或自定义数据库 hash；DB 验证结构与 hash 形状，未来 writer 必须调用纯函数复算比对。 |
| active 定义一旦被读取、选择或快照，修改会破坏追溯 | T0-A §5 的不可变 Version 合同 | trigger 把 active 的业务字段、definition、默认配置和有效期一并冻结，只允许 `active → retired`。 |
| Family 是稳定身份，Version 才是具体定义 | T0-A §5 | Family 的 `statusCode` 继续是 A2 inventory，本刀绝不将其误当 Version lifecycle。 |

## 3. 方案比较与已拍板范围

| 方案 | 内容 | 结论 |
|---|---|---|
| A（采用） | future Family Version 条件 DB 约束 + trigger，纯函数 canonical/hash，legacy 完全旁路 | 与已拍板的逐步 additive 演进一致，能先把不可变定义的底线放入持久层。 |
| B（不采用） | 只由未来 service 自律，或把闭集一次性施加给所有旧模板 | 前者无法阻止直写和并发绕过；后者会改变 legacy resolver 的事实面、等同回填/切换。 |

## 4. 明确不做

- 不新增 controller、DTO、service writer、权限码、审计事件、Gate、seed、历史回填或生产部署；
- 不改 `activity-publish-proposal-v2.service.ts` 的 legacy resolver，不给 Activity 增加 selectedTemplateVersionId；
- 不定义模板业务字段、敏感表单内容或任何真实模板数据；
- 不宣称 DB 已验证 hash 与 JSON 内容一致。A4/A6 新增 writer 前，必须独立确定授权、审计、definition schema、hash 复验与错误码；
- 不处理 Family 自身 lifecycle、Series、模板实例化或 read projection。

## 5. 验证与回退

- 单测证明 canonical 文本的 key-order 无关、数组保序、schemaVersion 入 hash、非法 JavaScript 形状 fail-closed、hash 复验可用；
- E2E 用真实 PostgreSQL 证明 legacy 保持可写、future Version 约束与状态迁移准确、冻结不被更新/删除绕过；
- 冷库从空库 replay 当前全部 migration；另建 A2 世代非空库插入 Family Version，执行 A3 migration 必须以具名 preflight 失败且保留原行；
- 回退只限未部署前撤销本 PR。迁移一旦在任何环境实际应用，是否移除约束/trigger 必须另立 D 档评审，不能以“回退”为名改写已经退休或激活的 Version。

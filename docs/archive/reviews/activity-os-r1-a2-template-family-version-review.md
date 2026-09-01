# Activity OS R1 / A2 TemplateFamily 与 TemplateVersion expand 评审记录

> **状态：冻结，不回改**（2026-09-01）。这是本次 D 档 schema 变更的立项、拍板、风险与边界记录；后续进度只更新滚动台账与 PR，不回写本稿。
>
> **维护者拍板**：维护者于 2026-09-01 回复“按推荐批准 A2 方案 A”。随后已对本稿 §3 所列的 schema、migration、边界元数据与本稿自身发出精确红区授权。该授权不外溢到 A3、运行时切换、历史回填或生产部署。
>
> **上游合同**：[Activity OS T0-A 终态合同](activity-os-t0-terminal-review.md) §5、§10.3、§11；原始蓝图《SRVF 活动域终态蓝图与分阶段落地方案》§7.1、§19.2、§26.3。A1 已独立合入 [#1237](https://github.com/BA7IEE/srvf-nest-api/pull/1237)。

## 1. 结论

采用方案 A：新增 ActivityTemplateFamily 作为模板稳定身份，并将既有
ActivityTemplate 扩展为可逐步接管的 Version 存储行。

本刀只落以下结构：

- Family：id、code、name、categoryCode、ownerOrganizationId、scopeTypeCode、statusCode；
- Version：在既有 ActivityTemplate 上新增可空 familyId、schemaVersion、definitionJson、definitionHash、effectiveFrom、effectiveTo；
- Family code 全局唯一；同一 Family 内 version 唯一；Family owner 和 Version family 均为 Restrict 外键；
- 既有 Template 的 code/version、默认配置和 ActivityRuleSnapshot 关系逐字保留。

所有新增 Version 字段均可空、无默认、无回填。存量 Template 继续是 legacy 行，familyId 和
全部新元数据为 NULL；现有按 activityTypeCode + statusCode + version 读取模板的路径不改。

## 2. D 档依据

| 项 | 事实与证据 | 本刀结论 |
| --- | --- | --- |
| schema / migration | 新表、外键、唯一索引和既有表加列都属红区 | 按 D 档先冻结方案、精确授权、再写入与验收。 |
| legacy 兼容 | 当前模板解析仍从 ActivityTemplate 按旧字段读取 | 不改 resolver、不把 Family 接进当前发布或解析链。 |
| Version 定义 | canonical JSON、hash 和有效期语义尚未有已批准的执行口径 | A2 只储存，不加 CHECK、trigger、默认值或 writer。 |
| 组织归属 | ownerOrganizationId 一旦使用，孤儿引用会失去可追溯性 | 可空 Restrict FK，零回填。 |
| 版本号 | Future Version 需要 Family 内稳定去重 | 增加 nullable familyId + version 复合 unique；legacy NULL 行不受其约束改变。 |

## 3. 允许写集与禁止域

**允许写集**：

- prisma/schema.prisma：Family 模型、Organization 反向关系、ActivityTemplate 的六个可空 Version 元数据和索引关系；
- prisma/migrations/20260901100000_activity_os_r1_a2_template_family_version_expand/migration.sql：纯 forward expand migration；
- test/e2e/activity-os-r1-a2-template-family-version-schema-constraints.e2e-spec.ts：真实 PostgreSQL 的列形状、FK、unique 与 legacy-null 证明；
- harness/domain-map.json、harness/state-machines.json：schema 派生元数据；
- 本评审稿，以及滚动台账、模块事实、变更 fragment 与派生文档。

**明确不做**：

- 不修改当前 legacy Template resolver，包括 activities 下的 publish proposal 读取链；
- 不修改 Activity 的选定 Version 指针、发布审核、快照、canonicalizer、hash 生成、有效期判定或 Family / Version lifecycle；
- 不修改 API、DTO、Swagger、Controller、Service、权限、Gate、seed、回填或历史 Activity；
- 不增加 statusCode / categoryCode / scopeTypeCode 的闭集、CHECK、trigger 或枚举；
- 不对 definitionJson 写入真实敏感业务数据，不创建其读面或返回 DTO；
- 不执行 prisma migrate dev、db push、migrate reset，不部署生产 migration，不做生产 rollback。

## 4. 方案比较与已批准方案

| 方案 | 内容 | 风险 / 回退 | 结论 |
| --- | --- | --- | --- |
| **A（推荐，已批准）** | Family 为稳定身份；旧 Template 以可空扩展成为 Version 行；无使用者、无回填。 | 未投入使用前仅结构性撤回；任何已使用数据的清理另立 D 档。 | 采用。 |
| B | 直接回填既有 Template 并让当前 resolver 读 Family / Version。 | 同时改变历史解释、运行时真相和回退边界，超出 A2。 | 不采用。 |

## 5. 风险表与控制

| 风险 | 控制 |
| --- | --- |
| migration 意外重解释 legacy Template | 只 CREATE TABLE、ADD COLUMN、ADD INDEX / FK；没有 UPDATE、INSERT SELECT、六个新增 Version 元数据列 DEFAULT 或 seed。非空库演练先插入旧形状行，再证明六列均为 NULL。 |
| 当前 resolver 被提前切换 | 写集不含 activities 的 runtime service；独立 e2e 只直接验证数据库。 |
| 未批准的 hash / JSON / 有效期规则被固化 | A2 不新增 CHECK、trigger 或 writer；A3 才定义 canonicalization、hash 与 lifecycle。 |
| Family 分类、范围、状态值被猜测成闭集 | 三列先保持 String；无 API、seed 或写路径，状态机元数据登记为未治理 inventory。 |
| ownerOrganizationId 或 familyId 成为孤儿 | 以 Restrict FK 拒绝不存在的组织与 Family。 |
| 同 Family 重复 version | 数据库复合 unique 拒绝；不同 Family 仍可各自拥有 version 1。 |
| definitionJson 承载敏感字段 | A2 没有真实数据、读面或 DTO。用途只限未来 Template definition；查看角色和掩码待 A3 / B3 定义；保存期限和退队清理也不得在本刀假设。 |
| nonempty migration 没有被真实执行 | 复制非空 app_test、插入旧形状 Template、运行 migration 文件并验证，再销毁仅本次创建的临时 test 库。 |

## 6. 数据库形状与迁移界限

Family 持有稳定身份和分类维度；Version 持有具体定义与版本元数据。两者之间使用可空
familyId 关系，是为了让已有 Template 不经过数据变换仍保持可读。

有效期的日期先存储，不代表 A2 允许、拒绝或选择任一版本；definitionHash 先存储，也不代表
任何 hash 算法、格式、长度或重算时机已经确定。Family 的 statusCode 同样只登记为将来 lifecycle
的载体，不能被 Runtime 当作已治理状态机。

迁移不含 down migration。未使用的结构若需撤回，只能由维护者在另一次受控窗口按当时数据状态
审查；不得把“结构可删”理解成允许自动物理删除任何数据。

## 7. 验收计划

1. Prisma format、validate、generate；
2. 边界元数据校验，确认模型数与状态字符串数同步增长；
3. 真实 PostgreSQL 的独立 schema e2e，覆盖合法正对照、legacy NULL、两条 FK 和两条 unique；
4. 非生产非空库 rehearsal：旧形状 Template 插入成功，执行 migration 后旧行仍在、六个新列均为 NULL；
5. docs counts、codemap、readtax、冻结稿台账与 diff check；
6. 受影响 e2e、quick gate、contract 零漂移和 PR CI 冷跑；
7. 跨模型 review；任何 review 分歧不在本地擅自调和。

## 8. 后续边界

A2 合并、CI 绿和维护者验收完成前，不启动 A3。A3 必须独立确定 canonical JSON、hash
生成与验证、schemaVersion 演进、effective range、Family / Version 状态机、写入口、审计和
敏感字段治理；不得把 A2 的可空存储列当成这些业务语义已经成立。

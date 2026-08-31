# `modules/ai/` — 可选 Assist 边界

> 此目录是**边界声明**，不是“将来一定要注册 AI 模块”的待办。Activity OS 可以长期不接 AI；核心业务必须在没有 AI、没有 AI Key、没有外网的条件下完整运行。

## 当前基线

- **未注册** `AiModule`，本目录没有运行时 TypeScript 模块；
- **未实现** Provider、Controller、Service 或 DTO；
- **未引入** LLM SDK、向量检索或其他 AI 运行时依赖；
- Activity、报名、发布、考勤、结算、时长、贡献、成果和更正均不得等待 AI 才能完成。

本阶段不得因为“未来可能使用”而创建 `AiModule`、接入某个 SDK 或启用 `pgvector`。当前的
红区机器裁判是
[`scripts/check-ai-dependency-boundary.ts`](../../../scripts/check-ai-dependency-boundary.ts)，
并由 [`src/ai-dependency-boundary.criteria.spec.ts`](../../ai-dependency-boundary.criteria.spec.ts)
接入既有 unit runner；它会阻止核心源码直接依赖 AI 模块或 Provider 包。

## 不可跨越的核心边界

1. Activity 与其他核心模块不得 import AI 模块、模型 SDK 或 Provider，也不得在核心事务、
   `/health/ready`、发布、报名、考勤、结算、时长认定、贡献账本或更正流程中等待 AI。
2. 将来的 Assist 只能通过明确的 Application Facade 使用已授权的 Query DTO、命令 DTO 和
   白名单统计；不得直接使用 Prisma、自由 SQL、数据库连接、整表导出或原始敏感报名答案。
3. AI 的任何建议都必须有手工等价路径：模板可手工选择、草稿可从空白表单创建、缺项检查
   由确定性的 Readiness 规则完成、成果可由负责人填写、统计可由固定筛选和报表完成。
4. 如需保存建议，建议记录属于可选 Assist 域；Activity、Outcome、Settlement 和 Ledger
   不得对它建立正确性依赖或 NOT NULL 外键。删除建议数据不能影响已确认业务事实。
5. 外部 Agent 只可走 Integration surface；不得持有 Human JWT 或调用 Human-only 路由。
   代人动作仍须使用 Delegated Token、服务端解析可信 target，并受三腿授权与幂等约束。

Application Facade 与 Effect 的职责边界见
[`docs/architecture-boundary.md`](../../../docs/architecture-boundary.md)；Integration 端点的审查
矩阵见 [`docs/reference/api-client-boundary.md`](../../../docs/reference/api-client-boundary.md)。

## 何时才可以另立 AI 工作

真实产品需求出现后，必须单独评审并逐项决定，不能沿用默认预设：

- Assist 是旁路服务、外部 Agent，还是主仓内的可选模块；
- 调用的业务 Facade、输入输出 Schema、脱敏规则、人工确认点和审计边界；
- Provider、部署、可用性、限流、费用和故障降级；
- 是否真的存在“多年非结构化救援报告相似案例检索”这类检索需求。

只有最后一项得到明确产品和技术评审时，才讨论 `pgvector` 或其他语义检索。模板推荐、
草稿生成、文案补全、成果候选和结构化统计解释都不是向量数据库的前置理由。

即使将来决定在主仓注册模块，也必须先证明：核心不依赖它、手工路径已验收、Provider 故障
不影响核心 Ready、敏感字段三问已有答案，并且相应的红区变更已由维护者授权。

## No-AI 验收入口

当前基线入口是
[`test/journeys/activity-os-no-ai.e2e-spec.ts`](../../../test/journeys/activity-os-no-ai.e2e-spec.ts)：
它在当前没有 AI Runtime 的真实 Nest 启动中跑活动创建、发布、报名、审批与签到链。

后续每新增一条 Activity OS 正式业务链，都必须把对应的无 AI 手工路径纳入该 Journey 或其
同级独立 Journey；不得用“AI 已生成/已建议”替代正式业务成功断言。

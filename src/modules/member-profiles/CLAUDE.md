# member-profiles — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)。本文件只补充本模块拥有的资格事实读取边界。

## Qualification facts

- `MemberQualificationFactsService` 是活动资格 evaluator 唯一可消费的窄读取出口：在调用方已有事务内锁定当前 `Member.gradeCode`、live `MemberProfile` 的 gender/birth 与当时 ACTIVE membership/组织 closure。
- profile 缺失不是补默认值；涉及 gender 或 age 的规则必须按不满足处理。组织命中只能是要求组织自身或其 closure 子树，不能用历史 membership 或前端传值替代。
- 此 service 不返回 App DTO，不落资格 snapshot，也不读取活动、报名、证书或保险表；它只返回 evaluator 所需的最小事实。活动开始日的北京日历周岁由 evaluator 统一计算，禁止在这里再造第二口径。

## Risk points

- ❌ 不把 `documentNumber`、mobile 或其他 L3 profile 字段加入资格事实或 snapshot。
- ❌ 不让 certificates / activity-registrations 直接复制本模块的 profile、membership 或 closure 查询；扩展资格事实先在本模块收窄出口。

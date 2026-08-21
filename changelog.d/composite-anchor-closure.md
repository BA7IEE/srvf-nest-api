### Fixed

- 业务复合锚点闭合(第六轮评审 A-2 + B-03):多张表同时保存多个业务锚点(activity / session / member / identity / position / registration),但只有部分关系用了复合外键 —— 数据库因此只证明这些 ID **各自存在**,不证明它们属于**同一条业务主链**。committed 账本分录是服务时长与贡献值的正式真相、关账与更正的基线,脏组合写进去后会被冲正逻辑当作可信基线继续记账,形成难以修复的跨活动污染。本刀在 21 个持有 ≥2 锚点的模型上把 **22 处**同链外键升级为复合外键,并落地 **12 条**被引用侧 unique 锚点(PostgreSQL 复合外键要求被引用列上有精确匹配的 unique;因 `id` 本就是主键,这些 unique 仅作 FK 靶点,不新增业务约束)。`onDelete` / `onUpdate` 逐条原样保留,expand-only、零回填、零删列、零既有行重解释,**零应用代码改动**(全仓无嵌套 `connect` 写这些关系)。刻意**不**闭合的 4 处例外全部落在 CapacityReservation 族 —— 第 78 migration 已拍板其两个锚点仅 `active` + `activity_person` 行必填,闭合要么被 Prisma 拒绝(必填关系不得含可空标量列),要么让指向 session / position reservation 的投影行恒 `23503`;逐条写明理由并由判据守护。

### Added

- 「多锚点表用单列外键」机器闸(`src/modules/activities/composite-anchor-closure.criteria.spec.ts`):断言凡持有 ≥2 个业务锚点的模型,其指向同链对象的外键必须是复合的,漏一处即红并点名**哪个模型、哪个关系、缺哪个锚点、该用哪个 unique**。扫描面从 `schema.prisma` **动态解析**,刻意不写死模型名单 —— 新建的第五张同形状表自动纳管(变异实测:把扫描面改成写死四张表的名单,该条对照当场红)。例外白名单要求逐条写理由,并额外守护「豁免过期即红」:一条豁免若不再对应任何真实违规,判据自己会红,防止白名单腐烂成垃圾堆。
- `test/e2e/business-composite-anchor-closure.e2e-spec.ts`:先建两条各自完全合法的业务主链,再用 `$executeRawUnsafe` 把两条链的 ID 交叉组合插入,逐条断言 `23503` **并钉到具体约束名**(只断 SQLSTATE 时,「建在错列上」与「压根没建」长得一模一样)。配套四条正向对照证明约束不是恒拒。结构判据只读 schema 文本,证明不了迁移漏跑 / 约束建错列 / `ADD CONSTRAINT` 静默失败,这三格由本 spec 补上。

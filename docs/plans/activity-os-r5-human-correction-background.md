# R5 Human 更正后台提交候选

2026-10-30：用户已确认大批量更正后台处理、进度可查、完成后整次生效。SRVF 尚未上线，无真实业务数据；原留证测试库的数据和 UNKNOWN/FAIL 记录仍须保留。

## 实现边界

本候选受理**已由原准备人准备完成的精确 application**，复用现有 `ActivityBatchJob`、五分钟租约、generation fence、两个现有 worker 进程及轮询。提交、审核、准备仍按既有人工作流完成；受理请求携带同一个 Human commit DTO，服务器派生 actor/活动/run/申请/application/批次/base/新版本/时间账本根/操作键和冻结来源摘要。不增加 Redis、cron、进程、凭据或授权。

新增任务类型为 `human_correction_commit`，不得伪装为七种旧任务。旧 `settlement_prepare` 自动提交路径排除 Human V2/V3 更正；旧通用 job 列表、重试和取消不处理新类型。新接口每次读取、受理和人工重试都验证原 actor 的当前 GLOBAL final-review/App 资格；新任务不开放取消。

入口及字段以本候选生成的 `docs/handoff/openapi.json` 和 App client 为准。`stage` 表示排队、执行、核对、失败或已生效；整次更正为一个发布单元，提交前完成单位始终为零。`segmentCount` 是更正增量规模，不是发布进度；`attempt` 绑定租约轮次，恢复也会递增。

## 提交与恢复

1. 受理事务锁 Activity、实时判权、绑定精确 prepared 来源，再同时插入 job/item。相同幂等键和相同意图返回原 job；异参、异 actor 或同 application 的第二意图拒绝。唯一键并发冲突只允许重新读取/比较队列记录，不执行 prepare/commit。
2. worker 在 Activity 锁后重新判权，持久化 item `processing`，随后仅调用一次原 Human command。重领已存在 `processing` marker 的任务先核对，不自动再提交。
3. 原业务事务保持 Activity→run→request→application 锁序及两次业务 UPDATE、原 member/day/基线/E4/CTSP/锁后授权顺序。新 job fence 在这些原有锁及首次实时判权后校验并持有至事务结局；audit 后的 job/item 成功回执与业务处于**同一事务**。真实 COMMIT 才同时可见。
4. P2028、响应丢失、租约过期不推定回滚。独立核对事务先取 Activity `FOR UPDATE NOWAIT`，再锁当前 job generation 并读精确 application/request/batch/actor/source。如果旧事务仍持锁或状态不一致，保持 `verifying`，拒绝人工重试。
5. 只有已取得上述锁、确认 preparing/applying/ready 且来源仍完全一致，才将 job/item 记为 confirmed-unapplied，递增 generation 并释放旧 lease。旧 worker 此后在业务写入前必被 fence 拒绝。人工重试再次实时判权，复用原 job/item，不重造 prepared 前置。
6. 进度按权威 application committed + request applied + batch committed + 原 actor 已提交判定；单独 job succeeded 不能制造 100%。正常成功回执在业务同事务，丢响应后核对可从持久结果收口。

## 预算和未决验证

原 Human 提交 **15 秒**、prepare **120 秒**、unchanged **7 秒**、每次锁 **4 秒**及去重后 **10 槽**均未修改。新队列控制事务使用现有 Prisma 默认配置。后台化不缩短原事务；原大样本 native15 FAIL 保留，本候选没有证明千条/万条容量通过。

新 CHECK 类型迁移和 contract 考卷更新属于仓库红区。用户已批准六精确源码范围，并于 2026-10-31 通过 Sentinel_5010863777948191b584f119448ecd3d 明确委托 AI 执行；本轮按原官方工具逐路径 grant，理由如实记录代理执行及两条批准消息，再应用已审源码草稿、生成授权清单。没有修改守卫或冒称维护者本人手动。迁移定义已落源码，不代表 CHECK 已在数据库安装；安装前不得启用新接口。真实 DB／完整标准 contract 和端到端联调仍交唯一 DB owner 在获准阶段执行，不重放旧 prepared/UNKNOWN 请求。

测试中的 Prisma mock 执行真实服务 callbacks、where/fence 筛选和原 command 的哈希/转发；独立 Nest worker 图使用真实 providers、替换 Prisma 且不连接数据库。它们不能证明真实锁互斥、默认延迟约束、事务回滚或 COMMIT。完整 contract/e2e/CI 仍需批准后运行。

## 本次未做

未连接数据库、改权限、安装迁移、改预算、分批发布、实现自动 prepare/审核、前端页面或取消功能，未改原留证库/DB 工作树，未推送、合并或部署。没有等待虚构的生产分布，也没有增加旧业务数据迁移任务。

### 2026-10-31 整合候选边界

后台受理／查询／重试与真实业务callback使用受保护Item v2 epoch；原caller C无Item写权，实际P/U双测试身份已完成独立认证与精确授权后封存（NOLOGIN/PASSWORD NULL）。安装成功不代表当前运行资格，也不代表后台业务已提交。provider缺省关闭，真实P连接须同事务通过身份、集群及完整source-qualified目录/preflight；普通代码不创建凭据或额外写池。

新driver将同一个P客户端装配到HTTP和既有worker图，全部实际运行角色仍是C。来源目录由冻结DDL和精确批准授权推导，新30表preflight待原生编译／实际对拍，六个精确红区源码改动已按用户明确委托走官方grant流程应用。PID与backend_start必须实采；原安装回执中的NULL不追补为已知。只有同事务业务、Item/job、ledger及audit真实COMMIT可证明统一生效，纯测与回滚诊断不作替代。原15秒及其他预算未改，容量仍未通过，R5未完成。

已有 trusted connection 的 worker 通过同一个生产 `run()`／`drainOnce()` 入口只认领 Human 任务，在 claim 事务内先核实际资格；SQL 家族筛选先于租约更新，其他类型返回即拒绝。原通用 worker 保留 settlement、过期扫描和其余任务，且不认领 Human。因此 Human 路径不再启动与本次更正无关的 registration 过期扫描，无需为此给 C 增加 ActivitySession／ActivityInvitation 八列读取权限。原 Human handler、受保护 Item、锁后授权、业务守卫、核对和提交预算均未削弱。

两个实际进程入口的 installed connection 缺省仍为 null；测试图注入已审安装记录不代表已完成部署激活。生产启用还需明确可信记录／连接的启动装配与实际同身份验证，不能以本次路由纯测代替。历史 backend_start=NULL 保持未知；RESET 后自身 birth 的只读可见性补证也不等于 P/U 运行资格已实测。

### 2026-10-31 用户明确委托的源码装配

六路径 before 校验及原官方 hook 全部通过。四文件已审补丁的 after 字节先核验，contract 三条新路由仅由官方格式器换行，AST 不变；授权清单由原生成器产出 666 路由，assertion-patterns 按要求同字节写回。SDK 官方再生成的 13 个文件只更新输入摘要注释，接口签名未变。离线路由／370 schema及两份完整快照检查通过，不当作触库 standard contract 已通过。

新迁移定义使当前迁移数变为154。已同步31处固定 CURRENT_MIGRATION_COUNT、三个单测总数、显式且封闭的第154条白名单，以及官方生成的 counts／CODEMAP／RBAC_MAP；原137条历史前缀和各历史升级基线不变，未知第154条仍拒绝。官方红区判定确认这些普通配套无需新 grant。唯一额外受保护目标是 harness/permission-surface-baseline.json：三条已批准路由使同一终审权限端点数由5变8；当前仅生成单行差量预览，没有扩 grant 或写该文件。真实数据库验证仍未闭合，不称 R5 完成。


## 2026-10-31 首发后台候选：一次60秒发布，准备240秒待后续验证

用户批准消息 Sentinel_d5c4234356648191a1cdbc58c1a9c752。同意低频大批更正可以等待；本次是新验收口径，不是追认原120/15秒失败。

- V3至少1000个更正段作为本候选的“大批”选择单位（对应当前Δ1000样本，不等于人数、全根段数或权限上限）。只有服务端显式 bootstrap 候选、真实 backgroundJob/protected Item fence 同时存在才使用60秒提交；锁内重核实际schema及段数。同步Human、小批后台仍15秒；普通7秒、普通E4 60秒、单锁4秒及10槽不变。
- `HUMAN_CORRECTION_BACKGROUND_BUDGET` 默认两个开关均false，不能由HTTP DTO或可写Job提供。当前冻结执行入口只打开bulkCommit，bulkPrepare=false。原授权、同事务审计/job/item收尾、未知结局不盲重试不变。
- 准备240秒候选由独立服务端bulkPrepare配置选择，Human命令读取不可变requestHash/段数，下层锁后授权并核实际来源一致才继续；默认仍120秒。它仍使用既有Human prepare API，不代表prepare已变成后台任务。首个60秒成功后才能用合法新请求验证此候选；不得重prepare159207。
- 第一步复用prepared159207与原Job，仅显式retry一次；最新native159265 aborted，原Job generation5、Item epoch4、failed xmin159266，下一worker必须是generation7/epoch5。旧2/2输入及旧15秒窗口失效。实时鉴权、完整payload双hash、独立XID及全8000/day oracle必须重核。
- 60秒失败即停止，不再递增预算。若通过，下一阶段才验合法新请求的完整prepare→后台publish→查询；真实prepare计时不能被排除。Δ10000不作为首发门槛，后置结果仍须如实记录。当前全链/发布/生产未验收。
- 阶段600秒/总1800秒、资源与STRICT_ALL门槛不变。worker仍300秒租约，当前关停实现等待activeRound；纯测覆盖等待实际在途轮次。租约数值不是强制停止证明。部署平台SIGTERM→SIGKILL宽限未有实际回执，沿既有runbook先排空再停，不调整外部关闭时间、不据此宣称生产可部署。

旧prepare159207客户端120秒FAIL但DB committed、native159238和159265 aborted FAIL全部保留。源码/离线证据与本次新标准真实DB证据分列。

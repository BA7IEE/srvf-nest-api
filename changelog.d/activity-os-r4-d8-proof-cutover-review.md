## Activity OS R4 D8-1 证明与切换地基

- 新增不可变单例切换收据与切换后根账 binding，以 PostgreSQL 事务锁围栏保证 cutover 与普通账本 commit 线性化；旧数据不回填、不重分类、不删除。
- 新增统一参与时长真相选择器，诚实分离历史 `legacy_recognized_service` 与切换后四类秒数，更正沿根账制度聚合，不完整链 fail-closed。
- 选择器同时校验 legacy 与 classified 的 D7 收据、前驱链和 D7-2 冻结来源证明；缺失 proof slice 不回退旧 slice。1／100／2,000 身份与 10,000 行使用固定 5 条业务 SQL，合并集合超 10,000 行具名拒绝。
- 新增 App self 和 Admin scoped/GLOBAL 两个正式 JSON 证明入口；合计与 `proofSetHash` 基于完整区间集合，不受当前页影响，不返回附件内容、理由或签名 URL。
- 新增默认只读的 cutover CLI；执行要求 v1.1 已开、结算只读窗、当前激活人类身份和既有 GLOBAL 结算终审权限，不修改 Gate。
- 不新增权限码或内建角色默认授予；新增一个活跃审计事件 `activity.time-cutover.command`。D8-2 官方统计/关账接线、D8-OPS 生产切换、Gate、部署和整体复审均未在本轮执行。
- 最终代码回归修复 cutover 检查结果复用受保护只读字段名及真值选择器重复实现北京日拆分两项架构偏差；全仓405/405套、8,810项单测（5项既有todo）、build、CI同口径lint及w98四套9/9通过。维护者扩写并授权后，domain map 仅登记两个新模型属主并刷新摘要，state-machine inventory 仅刷新摘要、不新增状态机或生命周期；第129条及实际权限／审计／字典读数的3b/4b已重签。
- 最终 Harness 自证561／138／68项、OpenAPI／客户端／权限／审计／台账／派生文档检查均通过。第二轮 CI 后维护者精确扩写两份旧夹具兼容路径，当前91路径授权上限内最终实际变更88路径、零越界；`RBAC_MAP.md`、`authz-assertion-patterns.json` 与 `reset-db.ts` 最终相对基线零diff。完整 Contract + E2E 冷跑仍由 Draft PR CI 验收。
- Draft [#1341](https://github.com/BA7IEE/srvf-nest-api/pull/1341) 首轮冷跑暴露架构棘轮、Prisma 默认值映射、D8 新外键下的旧夹具清理及 D7 历史迁移索引四类兼容问题；均在既有授权路径内修复。第129条 SQL 未改，3b 摘要仍为 `bdfaeae5029b113c66cc85923a2e1b5307c69fe892a1c232edf3281c5672305e`。修复后本地全仓单测405/405套、8,810项通过（5项既有todo），C1旧迁移63/63、D7历史升级5/5、D8四套9/9、B6 30/30、contract 1,074/1,074，以及 lint/typecheck/build/Harness/派生检查通过；B6 的首轮 CI 500 本地未复现，仍交新 SHA 的 PR CI 冷跑，不把一次本地通过写成根因已修。
- 提交 `0913cad9` 的第二轮 [PR CI 35632563010](https://github.com/BA7IEE/srvf-nest-api/actions/runs/35632563010) 已通过可信红区、Fast checks、Docker、Harness、Golden journeys 及 E2E 第1／4／5组；第2／3组确定性失败收敛为两份旧夹具未把 D8 binding／receipt 放进同一条 `TRUNCATE`，现已按授权补齐并在本工作树隔离库2/2 suites、35/35 tests通过。另一次8192人提交12.288秒超时在首轮同一D8实现上2.646秒通过、本地原样复现1.039秒通过，故不抬7秒预算、不改生产代码，交新SHA冷跑复核。

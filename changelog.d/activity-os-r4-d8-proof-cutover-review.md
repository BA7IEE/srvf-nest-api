## Activity OS R4 D8-1 证明与切换地基

- 新增不可变单例切换收据与切换后根账 binding，以 PostgreSQL 事务锁围栏保证 cutover 与普通账本 commit 线性化；旧数据不回填、不重分类、不删除。
- 新增统一参与时长真相选择器，诚实分离历史 `legacy_recognized_service` 与切换后四类秒数，更正沿根账制度聚合，不完整链 fail-closed。
- 选择器同时校验 legacy 与 classified 的 D7 收据、前驱链和 D7-2 冻结来源证明；缺失 proof slice 不回退旧 slice。1／100／2,000 身份与 10,000 行使用固定 5 条业务 SQL，合并集合超 10,000 行具名拒绝。
- 新增 App self 和 Admin scoped/GLOBAL 两个正式 JSON 证明入口；合计与 `proofSetHash` 基于完整区间集合，不受当前页影响，不返回附件内容、理由或签名 URL。
- 新增默认只读的 cutover CLI；执行要求 v1.1 已开、结算只读窗、当前激活人类身份和既有 GLOBAL 结算终审权限，不修改 Gate。
- 不新增权限码或内建角色默认授予；新增一个活跃审计事件 `activity.time-cutover.command`。D8-2 官方统计/关账接线、D8-OPS 生产切换、Gate、部署和整体复审均未在本轮执行。
- 最终代码回归修复 cutover 检查结果复用受保护只读字段名及真值选择器重复实现北京日拆分两项架构偏差；全仓405/405套、8,809项单测（5项既有todo）、build、CI同口径lint及w98四套9/9通过。维护者扩写并授权后，domain map 仅登记两个新模型属主并刷新摘要，state-machine inventory 仅刷新摘要、不新增状态机或生命周期；第129条及实际权限／审计／字典读数的3b/4b已重签。
- 最终 Harness 自证561／138／68项、OpenAPI／客户端／权限／审计／台账／派生文档检查均通过；89路径授权上限内实际变更87路径、零越界，两份授权生成物经生成器确认零diff。完整 Contract + E2E 冷跑仍由 Draft PR CI 验收。

## D7-2 主干 CI 夹具清理修复

- 为 A3 与 C1 D2b 两处受控 E2E fixture cleanup transaction 显式设置 60 秒上限，避免默认 5 秒 Prisma transaction timeout 在业务断言开始前中断清理。
- 将 M3 终审 convoy 用例改为复用既有 `holdLock()`，并在终审前等待其 `acquired`；消除“终审偶尔先于占锁事务执行”的测试夹具竞态，保留 40901、时限与全部原断言。
- 为 B6 紧急创建 E2E 增加仅在意外 `create()` 失败时启用的服务端脱敏取证：只记录异常类型、允许名单数据库码和仓内相对栈位置；新增显式 `SRVF_B6_W98=1` 隔离入口，只冷建、迁移、运行并回收本工作树的 `app_test_w98`。完整 B6 30/30 在冷建 w98 上通过（21.807 秒），未复现 CI 500，因此本改动仅提供下一轮 CI 证据，不登记根因或修复完成。
- 修复 fresh-V3 2,000 身份提交在 CI 共享负载下的 `P2028`：精确 receipt anchor 匹配后，锁后仍执行 `authorizeCorrection`，但不再由应用层重复重建 8,000 个 root／16,000 条更正分录；同一事务、member/day locks 后的 `LedgerPostingBatch ready -> committed` 仍由数据库触发器执行 `ptc_assert_complete` 与 `ctsp_assert_complete(TRUE)` 最终 fail-closed 校验。V2、重放、直接提交及缺失／陈旧／不匹配锚点仍走原完整校验。
- 增加两个互补回归证明：不完整 V3 proof 直接切 committed 必须由数据库以 `23514` 拒绝；合法 fresh-V3 提交不得再次调用应用层锁后 `assertComplete`。w98 的 100 身份链和 2,000 身份链分别通过（17.347 秒／131.288 秒）；完整 D7 单进程 6/7，唯一旧 V2 2,000 身份用例与本机 60.707 秒 WAL checkpoint 重叠后失败，随后该用例独立冷跑通过（135.698 秒），最终整套冷跑交由 PR CI。
- 未改既有测试断言、测试总时限、7 秒业务事务预算、测试基础设施、schema、migration、接口、DTO、权限或 Gate；生产代码改动仅限上述 fresh-V3 重复校验收敛。

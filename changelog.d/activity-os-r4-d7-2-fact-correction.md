## D7-2 冻结事实更正与 Human 写链（实施中）

- 第127条 `20260920090000_activity_os_r4_d7_2_allocation_guard_set` 只把 correction allocation 从既有父行守卫的逐行分支迁为 AFTER INSERT 语句级集合校验；D3/D4 路径与 `ptar_receipt_guard` 保持不变。维护者已按实际 SQL SHA-256 `86497e019c94a25aeae295721df8bf5e4ee7d0c0a8a3191dd2ea688dd1c5e9c2` 重签 3b。仅 app_test_w98 的第127条冷回放、126→127 非空升级、单身份 fail-closed 反例和 2,000 身份 Human V3 链已通过；#1337 仍为 Draft，新的 PR CI、Ready、合并、生产和 Gate 均未完成。
- 修复 #1337 CI 暴露的 7 秒事务预算路径：更正时长事实物化的 allocation／receipt 写入仍按最多 1,000 行，子行最多 5,000 行；10,000 条冻结来源的 `CorrectionTimeAllocationBinding` 改为独立的最多 5,000 行批次（每批十个显式字段，共 50,000 参数），避免十次绑定写入。每类累计写入数仍须与完整冻结证明精确相等；跨活动服务段重叠判定改为等价的 `EXISTS` 集合查询，避免已有连接的结果倍增；更正账本的九项 fail-closed 形状事实改为一次主聚合、一次冲回聚合和一次反连接复核，避免物化后反复扫描同一批分录。未改业务超时、schema、migration、API、DTO、权限、Gate 或既有 E2E 断言。唯一获准的 `app_test_w98` 上，原 2,000 身份 Human V3 写链通过（81.287 秒），原 8,192 人账本规模用例通过（commit 1,111ms、28 条 SQL）。
- 修复 #1337 冷跑的 A7 旧夹具：仅将 `resetDb` 的全局受控 `TRUNCATE` fixture transaction 与两个 `beforeEach` 受控 `TRUNCATE` fixture transaction 的 Prisma timeout 设为 60 秒；保留当前库校验和精确清理 SQL，不改生产代码、业务事务预算、断言或 Jest 配置。
- 修复 D6 旧迁移冷回放的测试库连接守卫：首次非零探针会从同一个维护库立即复核；复核仍非零才保留 fail-closed 拒绝并输出脱敏聚合诊断，复核为零才重建。未增加固定等待、重试或超时，也未改业务代码、schema、migration、API、DTO、权限、Gate 或既有业务断言。
- 按 #1335 第10–13节的方案 A 新增 v3 冻结事实更正链：来源证明、待物化分配、证据绑定和更正分配绑定均只以追加模型和第125条 migration 表达；不回填、不删除既有业务数据。
- 增加 App managed activity 的提交、查询、审核、重提、准备和提交接口，以及对应的访问复核、canonical/hash、来源冻结、附件保护、准备人绑定和回放语义。
- Human 的 review、resubmit、prepare、commit 现在将 URL `activityId` 与不可变申请归属逐一核对；错误活动路径返回既有“引用不存在或不可访问”错误，不改变申请状态。
- 本轮已完成 TypeScript、Human command 定向单元验证，以及唯一获准的 `app_test_w98` 迁移与数据库 E2E 验证。第125条 migration 的新摘要尚待维护者 3b 重签，之后才会更新签字登记并推送至 Draft PR #1337；尚未 Ready、合并、操作生产或启用 Gate。
- 修复第125条 migration 对历史 V1 无时间更正申请的错误拒绝：仅当 V1 批次不存在时间更正 manifest 时沿旧路径通过；存在 manifest 仍明确拒绝，V2/V3 约束不变。
- 修复 Draft PR #1337 的 CI 夹具问题：组织并发用例仅放宽清理事务至 30 秒，业务事务和断言不变；D7-2 守护负例改用同一来源的既有 allocation，仍以 FK 合法输入断言“binding does not match its pending allocation fact”。

# T51 独立只读审查

**PASS，限于 #1446 固定 HEAD 的短信修复、账本预检加固及原生 CI。T49 的必需 CI 阻断已闭。含本人账本的共享候选 H5 部署仍为 BLOCK，本批共享新增 GRANT=0。** 本次核对了实际提交差异、GitHub 原生分片日志与必需检查，并逐一校验了固定证据目录的 9 个 Git blob。PR 仍为 OPEN / Draft，未合并。[正式 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1446) · [固定证据](https://github.com/BA7IEE/srvf-nest-api/tree/61d2f71171620d92c7d00a5f3b08510d1bd051a1/docs/ops/runtime-acl/t51)

## 已闭

1. **版本和 CI。** #1446 实时 HEAD 为 `4c8cba0af25abe4587533c513489729a5f219fbe`。三次提交依次交付 T49 预检（`de27cca0`）、短信修复和预检加固（`1309b644`）、授权清单生成摘要（`4c8cba0a`）。最后一次提交只更新两处相同的 inputDigest，672 条路由声明未变。原生必需检查四项均成功，Fast checks 及五个 Contract + E2E 分片均成功；分片 5 的原始日志明确列出短信测试文件 PASS、90/90 套件、1327/1327 用例。trusted 汇总成功，单列人工作业为 SKIPPED。另核 #1445 仍为 `dd62ce308f9142e8b3be04e9c4d52f548c0ebb17`，15/15 成功，其同 SHA 红区已闭。[分片 5](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44682887628/job/136110436475) · [必需汇总](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44682887628/job/136118449507) · [最后一次提交](https://github.com/BA7IEE/srvf-nest-api/commit/4c8cba0af25abe4587533c513489729a5f219fbe)
2. **误判已确定性复现，修复范围合适。** 短信确认代次由服务端 `randomUUID()` 生成。固定一个尾段碰巧符合手机号模式的合法 UUIDv4 后，旧实现首次确认返回 `500/50000`，错误分类为 `EVENT_KEY_SENSITIVE`；同输入修复后通过。变更只在 admin SMS 四段键结构正确、UUID 版本及变体合法、通知和队员标识均匹配时，将代次段从自由文本扫描中排除。入库使用原键，生产者和 Worker 继续校验身份、payload 形状与敏感内容。错 UUID 版本、错事件类型、错目标字段的反例均在两个入口保留拒绝。T49 历史失败缺当时的 UUID 和底层异常，只能确认本轮复现的原因。[生产与测试差异](https://github.com/BA7IEE/srvf-nest-api/compare/de27cca06000c46bbacdc4ab4abb67d4286c4f26...1309b644a46d52c0260e87d682eed8f9901d3ed5) · [旧版回执](https://github.com/BA7IEE/srvf-nest-api/blob/61d2f71171620d92c7d00a5f3b08510d1bd051a1/docs/ops/runtime-acl/t51/http-baseline.json)
3. **短信正确性断言保留。** E2E 仅在首次确认期间固定 UUID，并在 finally 恢复生成器。仍要求首次 `200/0、sent=1`，二次 `200/0、sent=0、skipped=1` 且原因为 `already-sent`，仅一条发送流水，两条不同代次均成功。新增断言核对固定代次确实存入事件键。隔离 DevStub 定向复测和最终原生分片均通过。真实供应商外发为 NOT_RUN。[固定 E2E](https://github.com/BA7IEE/srvf-nest-api/blob/4c8cba0af25abe4587533c513489729a5f219fbe/test/e2e/notifications-sms.e2e-spec.ts#L417) · [修复后回执](https://github.com/BA7IEE/srvf-nest-api/blob/61d2f71171620d92c7d00a5f3b08510d1bd051a1/docs/ops/runtime-acl/t51/http-green.json)
4. **账本预检加固通过。** SQL 在只读事务中对指定运行角色检查数据库 CONNECT、public schema 的 USAGE，以及原合同两表的 15 个列级有效 SELECT。一次性 PG 回执中，缺列、列齐但缺 USAGE、列齐但缺 CONNECT 均 exit 3；权限齐全及恢复后均 exit 0。缺 CONNECT 的场景由其他身份代查，回执如实记录 `observer_is_runtime=false`。这一组验证的是预检判定；共享候选的新授权数仍为零。[预检 SQL](https://github.com/BA7IEE/srvf-nest-api/blob/4c8cba0af25abe4587533c513489729a5f219fbe/docs/ops/runtime-acl/t49/preflight.sql) · [五组回执](https://github.com/BA7IEE/srvf-nest-api/blob/61d2f71171620d92c7d00a5f3b08510d1bd051a1/docs/ops/runtime-acl/t51/ledger.json)

## 可工程闭合

T51 的合成目录实验未重新采样共享库。最近的 T49 共享采样显示分录表 13 列均缺 SELECT、批次两列可读；T45 已为隔离角色备好七列，因此隔离余缺六列。若随后获准部署，应以实际集群、库、运行身份及当时有效权限重新预检，核对 CONNECT、USAGE 和逐列回执，再验证非所有者的本人账本。正式已结算非空账本、手机/微信及公网认证业务继续记 NOT_RUN。T48 已过的非公网配对链沿原范围复用。[共享权限风险卡](https://github.com/BA7IEE/srvf-nest-api/blob/61d2f71171620d92c7d00a5f3b08510d1bd051a1/docs/ops/runtime-acl/t51/shared-ledger-decision.md) · [T49 现场采样](https://github.com/BA7IEE/srvf-nest-api/blob/669fe55c9473a30a7a67d94f9ed0a7ba2d07372b/docs/ops/runtime-acl/t49/shared-check.json)

## 真正需人

- **共享角色授权。** 若采用当前角色部署账本，维护者需决定是否接受分录表 13 列 SELECT 的共享影响。同角色进程可直接读取跨队员、跨活动及未提交批次的关联、时长和分值。该决定仅覆盖届时实际缺失的列，B130、写权限及公网开放另有边界；回退只撤实际新增权限。[风险和撤回范围](https://github.com/BA7IEE/srvf-nest-api/blob/61d2f71171620d92c7d00a5f3b08510d1bd051a1/docs/ops/runtime-acl/t51/shared-ledger-decision.md)
- **合并、设备与开放。** #1446 的 CI 已具备维护者判断合并的条件。PR 合并或关闭、公网切流及真人开放仍各由维护者决定，设备持有人需提供可达试验 HTTPS 的授权真机。本轮没有执行这些操作。[正式 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1446) · [既有部署门禁](https://github.com/BA7IEE/srvf-nest-api/blob/669fe55c9473a30a7a67d94f9ed0a7ba2d07372b/docs/ops/runtime-acl/t49/GATE.md)

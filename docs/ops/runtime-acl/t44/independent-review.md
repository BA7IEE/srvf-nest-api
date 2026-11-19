# T44 独立只读审查

**H5 真实报名 BLOCKED；隔离报名及 32 项列权限验证 PASS；签到关闸验证 PASS、正向签到 BLOCKED；本人参与汇总和负责人结算工作台均 FAIL。** 本次只读重算了脱敏回执。两处下游 500 均可在诊断复测中按请求号关联到具体表，证据尚不足以开出完整的共享库授权清单。[T44 固定证据](https://github.com/BA7IEE/srvf-nest-api/tree/860533d1425d5f7c38dddf8641bc8df2f98ffa3a/docs/ops/runtime-acl/t44) · [复算入口](/private/tmp/srvf-t44/verify.py)

| 审查项 | 独立判定 |
|---|---|
| **队员 H5** | **BLOCKED。** ADR 001 明文规定真实凭证存储方案尚未批准，阻止真实接线。仅内存会话是提案。T44 的正式构建拒绝外部指定 `api` 模式，定向合同测试通过；“服务尚未接通”、业务 API 请求为 0 的浏览器观察来自 T43 同一 SHA。需要维护者决定凭证方案；决定后仍需完成真实数据端口、同源请求和报名读面的工程接入。真实 H5 报名、取消均为 `NOT_RUN`。[ADR 001](https://github.com/BA7IEE/SRVFMobileWeb/blob/ce14f84b5add85de11816136a0ef975a28ff7b7e/docs/adr-001-credentials.md) · [构建拒绝回执](/private/tmp/srvf-t44/h5-build-rejection.log) |
| **32 项列权限** | **PASS，限本次角色、报名与取消路径及实际 SQL 投影。** 32 项逐项对照均为完整装配时 `00000`、单独撤回该项后 `42501`。完整 HTTP 流程按整包装配实测，逐项撤权验证的是 SQL 权限。`organization_closure` 的 `FOR SHARE` 需要至少一列 UPDATE，选用的 `depth` 可以替换；证据支持一项锁权限需求，不能据此认定 `depth` 是唯一选择。[逐项回执](/private/tmp/srvf-t44/minimum.jsonl) · [实际写入投影](/private/tmp/srvf-t44/shapes.jsonl) |
| **`depth` 直接拒写** | **PASS，依赖隔离库附加的保护触发器。** 运行角色能锁定真实存在的行，直接 UPDATE 命中现存行、命中零行两种情况均返回 `42501`；所有者零行对照返回 `00000`，原数据未变。该结果不能外推为裸授 `UPDATE(depth)` 也会拒写。隔离触发器和增量权限均已撤回。[锁与写入对照](/private/tmp/srvf-t44/closure-matrix.jsonl) · [撤回检查](/private/tmp/srvf-t44/restored-check.jsonl) |
| **签到** | **关闸行为 PASS，正向签到 BLOCKED。** 在有效时间窗签发并解码二维码后，自助签到返回 `503/20153`，期望 201 的正向断言退出 1。V1.1 写门禁在验码前生效，因此此次结果不能证明服务端已接受该码。读回仍未签到，DB 中签到事件和服务时段均为 0。手机摄像头、成功签退、时长生成及结算写入为 `NOT_RUN`。[签到回执](/private/tmp/srvf-t44/scan-in.log) · [DB 读回](/private/tmp/srvf-t44/downstream-db.jsonl) |

**两处下游 500 的关联强度不同于同窗日志推断。**

- **本人参与汇总 FAIL。** 诊断复测的 `500/50000` 与应用错误记录共享 reqId `cmwntdhpb80abf991a3e405b75dd725a8`，直接关联 `ActivityTimeCutoverReceipt`。`ParticipationLedgerEntry` 的拒读仅见于同一时窗，不能归到这笔请求。诊断记录中的 SQLSTATE 为空。[汇总诊断回执](/private/tmp/srvf-t44/summary-diag.log)
- **负责人结算工作台 FAIL；普通队员越权拒绝 PASS。** 负责人诊断复测的 `500/50000` 与 `ActivitySettlementClosureRevision` 错误共享 reqId `cmwntitqt25986f4041c6ca7aaf20f44a`。普通队员访问返回 `403/30100`。两张直接关联表在隔离角色上均无 SELECT 列。另一个 `time-settlement` 读面返回 `404/20219`，其正向结果仍为 `NOT_RUN`。[工作台诊断](/private/tmp/srvf-t44/workbench-diag.log) · [原镜像回执](/private/tmp/srvf-t44/post.log) · [权限取样](/private/tmp/srvf-t44/downstream-db.jsonl)

**版本与门禁。** GitHub 实时核对，正式前端 #172 为 `104e524c0b76826a79b1d48fad37fb07dcdfb8e8`，后端 #1444 为 `713d3416830d897852929731ff7f9b638038ab7c`，移动端 #3 为 `ce14f84b5add85de11816136a0ef975a28ff7b7e`。三者均为 Draft、未合并，业务 SHA 未变。实施与撤回记录支持共享候选本轮新增 `GRANT=0`。后端红区回执为 `SCAN: success`、`REQUIRED: false`、`APPROVAL: skipped`，该步骤没有待点击的人工审批。公网验收仍为 `NOT_RUN`。[前端 PR](https://github.com/BA7IEE/srvf-admin-web/pull/172) · [后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [移动端 PR](https://github.com/BA7IEE/SRVFMobileWeb/pull/3) · [红区回执](/private/tmp/srvf-t44/redzone.log)

**隔离报名 PASS；H5、正向签到 BLOCKED；两处下游读面 FAIL。**
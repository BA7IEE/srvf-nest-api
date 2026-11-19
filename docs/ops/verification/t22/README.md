# T22 候选测试库验收

**十列授权 exit 0；公网 Member 建档 PASS；账号绑定 FAIL。** 当前 API ImageID 为 sha256:1eb4e3ca321b141bca0c9c032e919f8665179f843dc623349fcd765ee6c89ffb，对应先前核验的 revision 108feebb84b85c7e4955c5af8bbfc016702e4529。

使用 StrictHostKeyChecking=yes、BatchMode=yes 的已知 SSH 别名，核对 hostname、镜像和由候选 API 地址观测到的数据库会话角色。事务内检查 current_database()=srvf_staging，并锁表重查授权前没有任何列 INSERT。精确撤权脚本在 GRANT 前已保存。psql -v ON_ERROR_STOP=1 执行 grant.sql，提交前断言允许 INSERT 的列集合恰为批准十列、仍无表级 INSERT。grant.log 记录 COMMIT。未修改其他角色或追加任何权限。此次授权仍生效；rollback.sql 仅供撤销此次新增，在执行前需再次核查 ACL 及授权来源是否变化。

| 场景 | 实际结果 | 证据 |
|---|---|---|
| 合同外编号含下划线 | 400/40000；首版驱动错误预期 201，exit 1。修正测试输入为连字符。 | invalid-format.log |
| 标记成员创建与公网读回 | 201/0，详情 200/0，核对同一 id、编号、合成姓名与 ACTIVE 状态 | public.log |
| 重复编号最小回归 | 409/15002。候选 PG 读回 1 个匹配成员、1 条关联编号登记，原子关联断言通过 | public.log、end-state.json |
| 普通 USER 身份与禁止建档 | 登录、本人身份读取均 200/0；建档 403/30100，随后测试账号禁用 200/0。独立脚本 exit 0 | ordinary.log |
| 标记账号绑定至新成员 | 500/50000。组合脚本因本条断言 exit 1，清理路径禁用新账号并登出；最终关联 User 数 0 | public.log、correlation.json、end-state.json |
| #1416/#1417 | BLOCKED。新增成员尚未能经应用流程绑定到测试账号，活动和更正任务的双主体认证场景 NOT_RUN。 | 同上 |

绑定请求的服务器完成日志和数据库错误日志按相同 reqId 匹配，得到一组 HTTP 500 与 SQLSTATE 42501、Member 表权限拒绝。源码 member-account.service.ts 的 bindAccount 在事务入口调用 lockMemberLifecycle；该函数对 Member 使用 SELECT FOR UPDATE。行锁是与现有授权不相容的具体代码路径，日志没有保存具体失败 SQL。此证据仅归因本轮绑定错误。未直接写 User.memberId，未扩大权限。下一步需独立评审绑定操作的锁与数据库权限契约。成员及编号审计保留，未改路由、seed、审批或合并状态。

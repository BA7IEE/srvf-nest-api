# 可复核的命令与退出状态

业务接口在试验内部网执行。测试账号登录及二维码解码均在进程内完成，证据保留状态、业务码和请求 ID。运行镜像及隔离角色见 identity.json、pair.log。下列 PG 命令的现场条件均为本次隔离目录；事务测试使用试验管理员切入实际非所有者角色。脚本不接受共享库。

| 实际执行的命令或入口 | exit | 可核对结果 |
|---|---:|---|
| `VITE_DATA_SOURCE=api pnpm build` | 1 | 正式构建参数明确拒绝真实数据源 |
| `pnpm exec vitest run tests/contract/auth-transport.test.ts tests/contract/activity-form-bridge.test.ts` | 0 | 4 个离线契约断言通过 |
| `python3 trial_acl.py apply --expected-cluster 7709931013666021418` 再次 apply/check | 0 | arm.log、repeat-apply.log |
| `sh member.sh enroll`、`sh member.sh cancel` | 0 | 两个普通主体的 HTTP 与 DB 审计 |
| `psql -XqAt -v ON_ERROR_STOP=1 -f shape.sql` 等价 stdin 调用，再执行 `python3 minimal.py 7709931013666021418` | 0 | 输出 shapes.jsonl 与 minimum.jsonl，仅输出表列与 SQLSTATE |
| `psql` 执行 closure-check.sql（target 绑定到试验活动） | 0 | 单行真实锁；命中/零行修改分别拒绝。首次空夹具的额外正例准备错误 exit 3；加入事务内自反关系后断言通过 |
| 仍有 UPDATE 时直接运行 `closure_guard.py withdraw` | 1 | 检查到 “withdraw registration ACL first”，预期拒绝 |
| `sh scan.sh check-in` | 1 | 扫码写正向断言遇 503/20153；scan-in.log 含真实窗口和 reqId |
| `sh diag-summary.sh`、`sh diag-settle.sh` | 0 | 同请求 ID 复现各自的 500；只取异常表名 |
| `python3 post-run.py` | 0 | 工作台读面取样，唯一二维码经正常 API 作废并读回 |
| `sh worker.sh` | 0 | 1 次处理每条内部意图，停止 exit 0 |
| `python3 trial_acl.py withdraw --expected-cluster 7709931013666021418` 两次 | 0 | 针对原始 effective ACL 比对相同，保护函数/触发器移除，审计和业务状态保留 |
| `sh retire.sh`，再执行 `sh pair.sh` | 0 | 清理全部本次试验容器、网络、生成凭证；封存审计；静态文件和镜像仍匹配 |
| `python3 verify.py` | 0 | 离线逐项对照权限、HTTP、DB、退役及两个失败的 reqId |

装配的底层 assemble.py 与 T43 固定树同文件。入口 trial_acl.py 先装写保护再授行锁所需权限。原始门禁/分支/检查状态见 ci.json 与 redzone.log；合并、公网候选部署、供应商外发均 NOT_RUN。

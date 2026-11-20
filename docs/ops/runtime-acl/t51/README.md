# T51 短信与账本预检

开发提交为 `1309b644a46d52c0260e87d682eed8f9901d3ed5`，父提交为 `de27cca06000c46bbacdc4ab4abb67d4286c4f26`。父提交的分片 5 在第一次确认收到 500/50000；当时的日志没有请求代次和底层异常。以下固定输入在同一首发路径重现了相同错误。对历史请求仅保留现有证据能支持的归因。[开发 diff](https://github.com/BA7IEE/srvf-nest-api/compare/de27cca06000c46bbacdc4ab4abb67d4286c4f26...1309b644a46d52c0260e87d682eed8f9901d3ed5) · [旧作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44675804949/job/136087273661)

| 运行 | 断言 | 结果 |
|---|---|---|
| 修复前的元数据守卫 | 合规确认 UUIDv4，经预留扫描 | 抛出 eventKey contains forbidden sensitive material |
| 修复前 HTTP，隔离 PG、短信 DevStub | 第一次请求本应 200/0 | 500/50000，固定分类 EVENT_KEY_SENSITIVE，Jest exit 1 |
| 同一用例改用修复版本 | 首次 200/0、sent=1；再次 200/0、skipped=1；一次 SENT、一次 already-sent、两个 distinct succeeded generations | exit 0 |
| 非法确认代次、错误事件及字段，通知队列相关单测 | 保留拒绝，合法代次原样往返 | 109/109 通过 |
| 脱敏错误分类单测 | 固定摘要，协议字段白名单 | 11/11 通过 |
| 账本只读预检 | 缺列／缺 public.USAGE／缺数据库 CONNECT | 三种均 exit 3，具备及恢复后均 exit 0 |

复现命令为 `pnpm test:e2e --runInBand --runTestsByPath test/e2e/notifications-sms.e2e-spec.ts --testNamePattern 're-trigger 去重'`。修复前对照使用父提交生产源码与同一回归夹具。试验只使用专用 PostgreSQL 和 DevStub。该单条定向回归中的另 13 例未运行，完整分片以新 SHA 的原生 CI 为准。[修复前](./http-baseline.json) · [修复后](./http-green.json) · [账本隔离回执](./ledger.json) · [原生 CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44681923933)

复审重点是 UUID 判断仅限 admin SMS 的规范事件键，两个身份仍需匹配，payload、自由文本和原始持久化键按既定契约处理。修复没有 schema、数据迁移、队列格式或外部投递配置变更。回退开发提交可恢复原代码和旧预检；会同时恢复已复现的 500。现有数据与角色授权无需变更。共享 GRANT、合并、公网切换、真人投递均 NOT_RUN。[共享影响和回退边界](./shared-ledger-decision.md) · [T50 补正](./t50-recovery-correction.md)

原生 Fast checks 在首个开发提交已通过 lint 和 typecheck，随后因生成的授权清单摘要过期失败。用仓库生成器重算，差异为同一 inputDigest 的两处导出，672 条路由声明无变化。复审固定提交为 `4c8cba0af25abe4587533c513489729a5f219fbe`。本地按 CI 的 6144 MiB 参数串行跑完冷 lint 和 typecheck，均 exit 0。[生成物差异](https://github.com/BA7IEE/srvf-nest-api/compare/1309b644a46d52c0260e87d682eed8f9901d3ed5...4c8cba0af25abe4587533c513489729a5f219fbe) · [开发检查](./development.json)

最终原生检查绑定 `4c8cba0af25abe4587533c513489729a5f219fbe`。必需汇总及全部五个 E2E 分片成功，红区可信检查成功，人工审批步骤 SKIPPED。PR 保持 Draft。[最终原生作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44682887628) · [逐项回执](./native-ci.json)

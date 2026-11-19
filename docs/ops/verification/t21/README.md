# T20–T21 候选环境验收

运行 API 最近核验的 OCI revision 为 108feebb84b85c7e4955c5af8bbfc016702e4529，ImageID 为 sha256:1eb4e3ca321b141bca0c9c032e919f8665179f843dc623349fcd765ee6c89ffb。#1420 的 merge commit 9bc703caf9b8f8102cf8cecccd7c04711ed78ab0 是该 revision 的祖先。Draft #1441 的 a985743025783ef8e03e6cf6cdcdae7abfb6f92b 未部署或执行。本分支只保存取证结果，不触碰主分支或公网配置。

## T20 范围

字典类型创建 201/0、改名 200/0、GET 详情 200/0、停用 200/0，随后按独立标记查询 PG，恰好一行且标签和 INACTIVE 状态正确。缺字段返回 400/40000，匿名读取返回 401/40100。独立普通 USER 写字典返回 403/30100，随后正常禁用。#1416 与 #1417 两条匿名请求均为 401/40100，仅覆盖登录门禁。T20 的六项 PASS 不包括活动业务、结算任务、页面或超限体。见同目录三份 t20 日志。各组脚本退出 0。

## T21 矩阵

每行计一项，T20 历史结果不重复计数。

| 项目 | 状态 | 观测与范围 |
|---|---|---|
| 两名不同普通 USER 的成员准入 | PASS | 正常创建均 201/0，分别正常登录；各自 GET app/me 为 200/0，均为 MEMBER_NOT_LINKED、canUseApp=false。两个账号最终分别禁用 200/0。 |
| 普通账号自助改密闭环 | PASS | 使用自己的旧密码修改 200/0，用新密码正常登录 200/0，GET admin/me 200/0 读回相同 userId，正常登出 200/0。 |
| #1419 异常映射单测 | PASS | 与候选同内容的 filter 和 spec，已知 oversized body 错误的处理器单测 1 passed；没有经过公网网关或请求解析器。 |
| #1416 认证业务夹具 | BLOCKED | 新建 USER 无成员身份；缺可合法分配给本轮的活动管理成员与已发布活动。正向写读、错误资源与跨对象三分支均未运行。 |
| #1417 认证业务夹具 | BLOCKED | 缺当前版本有权处理隔离结算更正任务的两名业务主体及关联任务。正向、错误资源与跨对象三分支均未运行。 |
| #1419 公网超限体 | HARD_BLOCK | 本次目标是复现已记录的请求体解析异常。适用的网络安全边界限制主动复现已知漏洞，包括授权测试环境。请求发送 0 次；HTTP、业务码、响应头、响应体及请求脚本退出码均无。未调用 HTTP 工具，没有工具拦截原文。 |

只读查询候选库有 17 个活跃 Member。该聚合无法确认任何一行可供本轮重新绑定。历史验收清单对应其他镜像，RBAC 有效期至 2026-11-10；本轮没有更改既有成员或续期旧权限。创建的两名 USER 仅作为独立账号级测试主体。SA 仅作创建和停用工厂。未发外部通知，保留审计。无共享角色 GRANT、无 Member 写入，无路由变更。#1418 未修改。首发业务验收未完成。

## 证据与命令

公网调用均使用标准 TLS 校验和应用登录，由服务器端进程处理凭据；归档仅含白名单路由、状态、业务码与断言结论。以下为实际驱动命令，脚本名为执行机路径。

    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes srvf 'python3 -' < /private/tmp/srvf-t20-public.py
    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes srvf 'python3 -' < /private/tmp/srvf-t20-role.py
    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes srvf 'python3 -' < /private/tmp/srvf-t20-anon.py
    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes srvf 'python3 -' < /private/tmp/srvf-t21-account.py
    pnpm test --runInBand --runTestsByPath src/common/filters/all-exceptions.filter.spec.ts -t 'oversized body'

以上各命令 exit 0。PG 只读汇总与运行镜像默认值检查均 exit 0。对照 src/bootstrap/apply-global-setup.ts 的专用解析器范围。T21 三项 PASS 中两项为公网，一项为本地单测。

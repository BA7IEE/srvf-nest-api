# T46 队员 H5 同源 HTTPS 会话验收

维护者于 2026-11-20 确定第一版凭证方案。正式移动仓 Draft #4 已接入后端 #1439。两项移动仓原生 CI 均通过。服务器独立测试栈完成了登录、续期、退出、报名写入和本人读回。手机实机与公网 H5 验收为 **NOT_RUN**。[ADR-001](https://github.com/BA7IEE/SRVFMobileWeb/blob/5e5be8dc11daf86781cf648c8c35572b3e79df60/docs/adr-001-credentials.md)

## 配对版本

| 业务仓 | 固定源码 | 交付情况 |
| --- | --- | --- |
| SRVFMobileWeb #4 | `5e5be8dc11daf86781cf648c8c35572b3e79df60` | Draft，叠在 #3；push 和 pull_request 两项原生 check 成功。[PR](https://github.com/BA7IEE/SRVFMobileWeb/pull/4) · [PR CI](https://github.com/BA7IEE/SRVFMobileWeb/actions/runs/44663041441/job/136045603447) · [push CI](https://github.com/BA7IEE/SRVFMobileWeb/actions/runs/44663036686/job/136045588285) |
| SRVFMobileWeb #3 | `ce14f84b5add85de11816136a0ef975a28ff7b7e` | 现有页面基线，原生 CI 成功 |
| srvf-nest-api #1439 | `479594029d46bb9ab0e00e01411368830e2e6a24` | Draft，Contract/E2E 和当前提交的 Red-zone trusted approval 成功。[后端契约](https://github.com/BA7IEE/srvf-nest-api/blob/479594029d46bb9ab0e00e01411368830e2e6a24/docs/handoff/h5-session.md) · [PR](https://github.com/BA7IEE/srvf-nest-api/pull/1439) |
| srvf-nest-api #1444 | `713d3416830d897852929731ff7f9b638038ab7c` | 活动分支，CI 成功，人工 approval 检查 SKIPPED。与 #1439 的组合部署未验 |
| srvf-admin-web #172 | `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` | 原生 CI 成功。此次页面操作使用队员 H5 |

启动和交付前均核对 GitHub。构建从 #1439 精确归档执行 `pnpm build`，在与 108feebb 同迁移世代的运行镜像只读挂载编译产物。已核容器内两个认证文件的 SHA256、数据库 156 项迁移和运行身份非超级用户。内部 Docker 网络、无发布端口，TLS 反代仅信任所在网关地址 /32。浏览器在临时 NSS 库信任实验 CA，执行真实 Chromium，没有关闭证书校验。最终 H5 页面入口的服务端 SHA256 与本地 `dist-h5/index.html` 一致，为 `20ddbd44e7ed49d14e9d256f3b43e7abb84e0e427e1fcb9f21f6f1463b1f9221`。[运行核对](runtime-proof.txt) · [TLS 读回](runtime-readback.txt) · [GitHub 快照](heads.json)

## P0-E 实测

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 无会话启动、普通队员密码登录、身份与能力 | PASS。刷新返回 401/10007，登录与 me、capabilities 均为 200/0 | [最终页面记录](final.jsonl) |
| 页面刷新、双标签同时恢复、跨标签退出 | PASS。两个标签轮换均成功，退出后一同回到登录页。登录、刷新和退出命令均无写入重放 | [浏览器往返](expiry-verified.jsonl) |
| Access 自然过期，90 天 refresh family | PASS。按后端最短合法设置 1 分钟，等待 62 秒后访问受保护页面，refresh 和 me 为 200/0。数据库中 3 个 90 天 family 均发生轮换且绝对期限固定。普通业务实验使用 15 分钟 Access 和既有 7 天实验配置 | [到期续期](expiry-verified.jsonl) · [数据库](deadline.json) |
| 本人改密、另一独立浏览器会话 | PASS。正常页面 PUT 200/0，第二会话 refresh 为 401/10007。数据库留有 self-password-change | [浏览器](password-test.jsonl) · [审计](db.jsonl) |
| 禁用账号 | PASS。独立库将指定合成 USER 置为 DISABLED，已登录浏览器的 H5 refresh 返回 401/10007。这项验证覆盖账号状态门禁。正常管理员 API 禁用、同事务撤销由 #1439 当前 SHA 的真实 Nest/PG E2E 覆盖 | [请求号](boundary.jsonl) · [管理员 E2E](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44339872408/job/134964502774) |
| 自己的报名、另一个合成主体的报名、管理用户列表 | PASS。依次 200/0、404/21001、403/30100 | [逐请求证据](boundary.jsonl) |
| HttpOnly/Secure/Strict、host-only、拒错 Origin/转发头/HTTP、旧凭证重放、family 撤销 | PASS，取自 #1439 同 SHA 的真实服务端 E2E。浏览器另验 JS 无法观察到 refresh Cookie。普通窗口跨域攻击演练未另行发起 | [H5 E2E](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44339872408/job/134964502459) · [重放与撤销](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44339872408/job/134964502205) · [逐作业核对](backend-ci.json) |
| 真机 iOS/Android、微信内置浏览器、公网 H5 | NOT_RUN。Mac 的 USB 设备清单未识别到可用手机，CoreDevice 服务返回 XPC 1001。实测浏览器为服务器 Linux Chromium，390×844 视口 |

最初尝试将隔离 Access 时间压到 2 秒，后端启动校验拒绝，退出码 1。随后改用合法的 1 分钟。第一次记录文件受到两个实验进程交错写入，已弃用。表内到期证据来自单独的干净复测，脚本退出码 0。

## 队员业务页面

| 场景 | 结果 | 数据与限制 |
| --- | --- | --- |
| 普通 USER、无额外业务角色绑定，公开报名且无需保险的活动 | PASS。页面目录→详情→选择场次→确认→写入 201/0→我的活动读回 200/0，退出码 0 | 最终写入请求号 `cmwodolijb58c0f2f65061b4982995f11`。隔离库共有 3 个不同普通主体、3 条报名、3 条 registration.create 审计 |
| 本人参与汇总和账本页 | PASS。汇总与账本均 200/0。此次账本为空，只验已生效分录入口及空态 | 第一次账本请求为 500/50000。核对实际 SQL 后仅在一次性 PG 补 8 列 SELECT；完整读面成功。共享候选新增 GRANT 为 0。[首次失败](first-ledger-attempt.json) · [隔离差额](member-ledger.json) |
| 本人场次考勤状态 | PASS。真实页面读取 my-punch-state 200/0，显示定位策略待确认 | H5 扫码签到写入、真实相机/定位 **NOT_RUN**。普通队员详情没有场次 locationRequired，页面保留未知保护。本人报名读面不提供逐场岗位分配。既有 T45 隔离 HTTP 签到不计入本次 H5 |
| 需要保险的活动 | NOT_RUN 正向提交。缺少本人指定活动保险资格的权威预检回执，H5 保持未知；未将仅有自购保单等同于合格 |
| Worker/对外通知 | NOT_RUN。测试栈未启动投递消费者，退役时待处理/在途意图为 0 |

普通账号的访问、写入和读回均由非所有者应用角色处理。合成活动和账号来自独立数据库夹具。报名读面只展示服务端实际返回的报名状态，未伪造逐场分配或签到。实验结束保存 38 条审计的白名单投影及逐行摘要，移除临时容器、网络、登录材料和实验私钥。[最终页面和请求号](final.jsonl) · [数据库计数](db.jsonl) · [退役回执](retirement.txt)

## 同 SHA 开发复审与回退

1. **改动**。移动 #4 相对 #3 新增同源传输、H5 会话、业务端口、显式构建入口、ADR 和定向测试。后端复用 #1439 的 login、refresh、logout 三个入口和原 AuthService。[实际文件差额](mobile-diff.txt) · [前端源码](https://github.com/BA7IEE/SRVFMobileWeb/tree/5e5be8dc11daf86781cf648c8c35572b3e79df60/src/data/h5)
2. **安全影响**。Access 仅在本页内存。Cookie 由浏览器管理，业务 Bearer 请求使用 credentials=omit；认证请求限制同源 HTTPS。代际标记只存状态和随机数。Web Locks 不可用时阻止恢复。重点复核跨标签换账号、丢回执、退出与已发写入。
3. **数据库与业务**。前端无迁移。后端沿用原 P0-E 写集。隔离角色沿用既有试验装配，并为本人账本补充实际读取的列。共享库与公网配置均未实施。
4. **开发验证**。精确前端 SHA 的原生 CI 两项通过。初版定向核验 `pnpm typecheck`、`pnpm lint`、`pnpm build:h5` 退出 0；新增 4 个 H5 合同负例/协调用例。最终源码由隔离浏览器完成报名与本人页面。运行脚本使用全新浏览器上下文且不录屏、不追踪请求头。[页面驱动](browser-enrollment.cjs) · [改密驱动](browser-password.cjs) · [续期驱动](browser-renewal.cjs)
5. **公网前置和回退**。dp 根页和 ready 的 TLS 校验均成功。现场磁盘配置保留 Host，设置 X-Forwarded-Proto=https；当前候选的 APP_TRUSTED_PROXY_CIDRS 为 none。配对部署时须核准实际 TLS 终止代理的精确来源、同源 /api/、CSP connect-src 'self' 和后端版本。H5 静态产物可退回原未配置版本，已有服务端 family 遵循 P0-E 撤销或到期。实际公网部署/回退演练 NOT_RUN。[公网核对](public-proxy.json) · [TLS](public-tls.json)
6. **决定点**。建议独审移动 #4 当前 SHA，随后在可达的受信同源 HTTPS 拓扑做手机实机验收。后端 #1439 的红区检查已成功；新前端独审、合并和公网部署均单列。本次没有重新发起认证方向选择。

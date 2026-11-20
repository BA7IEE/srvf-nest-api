# T46 独立只读审查

**结论：PASS，限于隔离同源 HTTPS 栈的队员 H5 会话、报名与本人读回。** ADR-001 已记录 t21u 选定的方案：Access 留在页面内存，Refresh 由浏览器通过安全 Cookie 传输。手机实机、公网认证业务及实际部署均为 `NOT_RUN`。[ADR-001](https://github.com/BA7IEE/SRVFMobileWeb/blob/5e5be8dc11daf86781cf648c8c35572b3e79df60/docs/adr-001-credentials.md) · [固定证据树](https://github.com/BA7IEE/srvf-nest-api/tree/6bfc12203ef09cef5bd0474da425dfab90dfdde6/docs/ops/runtime-acl/t46)

**版本与复用方式。** GitHub 实时核对，移动端 Draft #4 HEAD 为 `5e5be8dc11daf86781cf648c8c35572b3e79df60`，后端 Draft #1439 HEAD 为 `479594029d46bb9ab0e00e01411368830e2e6a24`，均未合并。隔离后端从 #1439 固定源码构建，将编译产物只读挂载到既有运行镜像，核对了容器内认证控制器和 H5 会话模块的摘要。移动端 push、PR 两项原生 `check` 成功；后端固定提交有 Contract/E2E 及 trusted approval 成功记录。#1439 与活动分支 #1444 的组合部署尚未验证。[移动端 PR](https://github.com/BA7IEE/SRVFMobileWeb/pull/4) · [后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1439) · [运行产物回执](/private/tmp/srvf-t46/runtime-proof.txt)

**凭证边界通过。** Access 保存在当前页闭包中。`localStorage` 只保存跨标签会话状态和随机代际标记，未见 Access 或 Refresh 写入 `localStorage`、`sessionStorage`。后端对 `__Host-srvf_h5_refresh` 设置 `HttpOnly`、`Secure`、`SameSite=Strict`、`Path=/`，未设置 `Domain`；H5 响应体不返回 Refresh。浏览器驱动断言登录后 `document.cookie` 读不到该 Cookie，随后刷新又能恢复会话。对固定证据目录的回执、驱动及常见令牌格式检查未发现实际 Token 值；证据中保留的是字段名、请求号和状态码。[前端实现](/private/tmp/srvf-t46/mobile/src/data/h5/index.ts) · [Cookie 实现](/private/tmp/srvf-t46/backend/src/modules/auth/h5-session.ts) · [浏览器断言](/private/tmp/srvf-t46/evidence/docs/ops/runtime-acl/t46/browser-enrollment.cjs:19)

| 隔离 Chromium 场景 | 独立判定 |
|---|---|
| 登录、恢复、双标签、退出 | **PASS。** 无会话刷新为 `401/10007`；普通队员登录后身份与能力读回 `200/0`。页面刷新、双标签同时恢复均成功，退出后两个标签均回登录页。缩短 Access 有效期的定向实测也完成了自然到期后的续期。 |
| 改密与禁用 | **PASS。** 本人页面改密 `200/0` 后，另一独立浏览器会话刷新为 `401/10007`。禁用测试通过隔离库设置合成账号状态，已登录浏览器刷新同样为 `401/10007`；管理员页面禁用整链未在此次 Chromium 中重跑。 |
| 报名与本人读回 | **PASS。** 真实 H5 页面调用隔离后端，报名 `201/0`，reqId `cmwodolijb58c0f2f65061b4982995f11`；随后本人报名列表 `200/0`，reqId `cmwodolki906e76c82149c590b5c069c7`。这项结论来自浏览器、后端及数据库回执。需保险活动的正向报名、手机相机及 H5 签到写入仍为 `NOT_RUN`。 |

[续期与退出](/private/tmp/srvf-t46/expiry-verified.jsonl) · [改密](/private/tmp/srvf-t46/password-test.jsonl) · [禁用](/private/tmp/srvf-t46/boundary.jsonl) · [报名与读回](/private/tmp/srvf-t46/final.jsonl) · [数据库回执](/private/tmp/srvf-t46/db.jsonl)

**P0-E 与部署边界。** #1439 复用既有登录、轮换和撤销事务。专门的 90 天配置中，三个 family 均发生轮换，绝对截止时间保持固定；普通业务试验另用了既有 7 天实验配置。已测行为与 P0-E 相容。目标环境仍需配套 #1439 的 H5 接口、正式有效期配置、同源 `/api/` 和受信 TLS 代理；当前候选的受信代理列表为空。实施记录支持共享候选新增 `GRANT=0`。方向批准和原生 CI 均不能替代手机实机及公网配对验收。[期限读回](/private/tmp/srvf-t46/deadline.json) · [公网代理核对](/private/tmp/srvf-t46/evidence/docs/ops/runtime-acl/t46/public-proxy.json)

**PASS（隔离 H5）；手机实机、公网部署 NOT_RUN。**
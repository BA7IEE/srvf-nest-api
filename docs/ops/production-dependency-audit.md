# Production dependency audit

> 重复入口：`pnpm audit:production`；GitHub Actions：`Production dependency audit`（手工 dispatch 或 `v*` tag 自动执行）。
> 策略：生产依赖出现 high/critical 时失败；moderate/low 必须显示、分析并进入发布票，不能静默忽略，也不能以 audit 为由无边界升级。

## 2026-07-22 基线

`pnpm audit --prod --audit-level high`：exit 0，3 moderate，0 high，0 critical。三条均来自 `cos-nodejs-sdk-v5@2.15.4` 的传递链：

| Advisory                                                                | 路径                                  | 当前影响分析与接受边界                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GHSA-p8p7-x288-28g6` / `request@2.88.2` SSRF redirect                  | `cos-nodejs-sdk-v5 > request`         | 应用只通过受控 Storage Settings 构造 COS bucket/region 并调用官方 COS 对象 API，不提供任意 URL fetch 接口；仍保留为供应链风险，真实网络 egress/域名边界须现场验证。               |
| `GHSA-gh4j-gqv2-49f6` / `fast-xml-parser@4.5.6` comment/CDATA injection | `cos-nodejs-sdk-v5 > fast-xml-parser` | SDK 的 XMLBuilder 风险针对 comment/CDATA delimiter；本仓库 CosStorageProvider 只调用对象 put/get/delete/head/sign/ranged-read，不构造 bucket 配置或用户控制的 XML comment/CDATA。 |
| `GHSA-w5hq-g745-h8pq` / `uuid@3.4.0` v3/v5/v6 buffer bounds             | `cos-nodejs-sdk-v5 > request > uuid`  | `request` 在本安装中引用 `uuid/v4`；advisory 指向 v3/v5/v6 外部 buffer API，本仓库不直接调用该传递依赖。                                                                          |

以上是当前冻结制品的代码路径判断，不是“漏洞不存在”。下列任一变化必须重新评估：

- COS SDK、其 endpoint/redirect 行为或本仓库 egress 配置变化。
- CosStorageProvider 开始调用 XMLBuilder 相关 bucket/config/multipart API。
- 新增任意 URL、代理、回调或用户控制的 COS endpoint。
- advisory 严重度、利用条件或供应商修复版本变化。

本次不加 override、不升级 COS SDK 传递依赖、不替换 SDK。后续只有在供应商提供兼容修复或能复现冻结制品上的可利用路径时，才另立依赖升级 PR。

## 每次 release

1. 在最终候选 SHA 上运行 `pnpm audit:production`。
2. 保存命令时间、SHA、漏洞计数和 advisory/path；不保存 token 或 registry credential。
3. high/critical 非零：停止发布并单独评审。
4. moderate/low 变化：更新本页影响分析和发布票；禁止仅看 exit code。
5. tag 推送后确认 GitHub `Production dependency audit` job 成功并绑定同一 SHA。

# Production dependency audit

> 重复入口：`pnpm audit:production`；GitHub Actions：`Production dependency audit`（手工 dispatch 或 `v*` tag 自动执行）。
> 策略：生产依赖出现 high/critical 时失败；moderate/low 必须显示、分析并进入发布票，不能静默忽略，也不能以 audit 为由无边界升级。

## 2026-07-23 v0.61.0 代码候选基线

`main@1bd0dc8f0cef7cd06456104bdbf3c2db49fb7243` 在 GitHub-hosted `ubuntu-24.04` runner 运行 `pnpm audit --prod --audit-level high`：exit 0，3 moderate，0 high，0 critical；workflow 含全部 post-job 步骤整体绿色（[run 29999713821](https://github.com/BA7IEE/srvf-nest-api/actions/runs/29999713821)）。

本轮先以独立 #749 将 `fast-uri` override 从 `^3.1.2` 提升到 `^3.1.4`，消除 `cos-nodejs-sdk-v5@2.15.4 > conf@9.0.2 > ajv@8.20.0 > fast-uri@3.1.3` 的 `GHSA-v2hh-gcrm-f6hx` High；未升级 COS SDK、conf 或 ajv。修复后保留的三条 moderate 与 v0.60.0 登记完全相同，均来自 COS SDK 传递链：

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

这三条 moderate 本轮不新增 override、不升级 COS SDK 传递依赖、不替换 SDK。后续只有在供应商提供兼容修复或能复现冻结制品上的可利用路径时，才另立依赖升级 PR。

## 2026-10-18 Release 5 受限500人候选

维护者已批准[完整实施 Goal](../plans/activity-os-r5-limited500-release-readiness.md)的 D1 独立依赖修复。基点 `dc9218d0b037643f5f29ae75715ac3e4a20a1034` 的生产图为 1 critical / 14 high / 7 moderate / 1 low；获批候选的仓外预验为 0 critical / 0 high / 3 moderate / 0 low。工作区最终检查、新 SHA CI 与实际部署仍须分别核验，预验不代替发布批准。

调整限定为 sharp `^0.35.5`、multer override `^2.3.0`（锁定实际解析 2.4.0）、fast-uri `^3.1.8`、`@nestjs/swagger>js-yaml` `^4.3.2`、qs `^6.16.1`、proxy-addr `^2.0.8`，以及仅 `@prisma/config>deepmerge-ts` `8.0.0`。Prisma/client 保持 6.19.3，COS SDK 保持 2.15.4，不扩大到所有 js-yaml 或其他依赖。deepmerge-ts 的 major override 已在真实项目配置下预验 Prisma validate/generate；Node 22 下的完整检查与容器构建仍是合并前置。

候选剩余三项 moderate 正是上表 `GHSA-p8p7-x288-28g6`、`GHSA-gh4j-gqv2-49f6`、`GHSA-w5hq-g745-h8pq`，路径及接受边界沿用；它们仍是未修复的供应链风险，发布票必须继续列明，真实 egress/域名边界留现场验证。不新增 ignore、不降低 high/critical 阈值。COS 3 的依赖改名为供应商 fork，registry 零 advisory 不能证明对应代码已修复，本轮不据此升级。

仪器区别：本次 pnpm 10.14.0 的正式 `pnpm audit:production`（文本、high 阈值）在上述候选上 exit 0；`pnpm audit --prod --audit-level high --json` 因仍列出 moderate 而 exit 1。必须同时保存计数与实际命令/退出码，不把 JSON 的非零写成正式阈值未过，也不把正式 exit 0 写成零漏洞。候选冻结后以同一 SHA 重跑，并记录 GitHub Production dependency audit 的整体结论。

## 每次 release

1. 在最终候选 SHA 上运行 `pnpm audit:production`。
2. 保存命令时间、SHA、漏洞计数和 advisory/path；不保存 token 或 registry credential。
3. high/critical 非零：停止发布并单独评审。
4. moderate/low 变化：更新本页影响分析和发布票；禁止仅看 exit code。
5. 使用 workflow dispatch 验证最终候选 SHA；tag 推送后再确认 GitHub `Production dependency audit` job 整体成功并绑定 tag SHA，不能只看 audit step。

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

2026-10-19兼容补充：Multer2.3+自身将业务fileSize上限补偿为Busboy解析阈值，应用原有`+1`会叠加。注册上传、头像、标准照及CSV导入的真实HTTP红例已确认首个超额字节进入service；按维护者集中扩围批准，四入口直接配置原10MiB业务上限，保留原大小错误码及service前拒绝契约，补充三入口各两项精确边界回归。package/lock仍与上表获批摘要逐字相同，没有降回含high的旧版本或改变审计阈值。

同批仅将测试库重建接入既有同快照严格分类器，原CI短暂连接来源仍UNKNOWN；该测试设施改动不代表生产数据库根因或发布条件已验证。固定修复SHA及main的完整检查仍须分别完成，生产NO_GO，受限500不变。

## 2026-10-25 UTC 请求解析与 URI 安全补丁候选

`main@310be65f11309674538414228b4c901024869e5a` 的 CI 与 Smoke 已成功，但[正式生产依赖审计 40216895550](https://github.com/BA7IEE/srvf-nest-api/actions/runs/40216895550)为 exit 1：2 high、5 moderate、2 low。该提交没有修改 package/lock；这是既存依赖风险，不能据此豁免最终 SHA 的审计门禁。

候选只提高三个既有 override：body-parser `^2.4.0`、multer `^2.5.0`、fast-uri `^3.1.9`，实际锁定 2.4.0、2.5.0、3.1.9。body-parser 新声明要求的 content-type `^2.1.0`、iconv-lite `^0.7.3` 随同正常解析；没有升级 Nest、Express、COS SDK、conf 或 AJV，也没有新增 override 或改变业务上传限额。

- body-parser 通过 Nest 默认 Express JSON/urlencoded 解析进入请求链，修复依据为 [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)。
- multer 被头像、标准照、证件、报名和现场上传入口使用，修复依据为 [GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m)。仓内未发现自定义异步 fileFilter，当前可利用性未获证明；不以此忽略 advisory 或跳过 multipart 的鉴权、文件数、大小与 MIME 回归。
- fast-uri 的四项新 moderate/low 经 `COS SDK → conf → AJV → fast-uri` 引入，3.1.9 为同主版本补丁；修复 [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg)、[GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr)、[GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h)、[GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp)，不把新告警冒作此前已接受的三项 moderate。

Node 22.23.3 / pnpm 10.14.0 下正常 frozen install 通过；正式 `pnpm audit:production` exit 0，0 critical / 0 high / 0 low / 3 moderate。完整 JSON 报告 `pnpm audit --prod --json` exit 1，剩余 advisory ID、版本、路径仍逐字对应上表 request、fast-xml-parser、uuid 三项；接受边界没有扩大，不宣称零漏洞。

本地验证：468 单测套件 / 10,536 passed / 4 todo；类型检查通过；原冷 lint 完整覆盖 2,038 文件、0 error / 0 warning、176.8 秒，独立执行前后 OOM 计数未增加。普通 UTF-8 JSON、原始 gzip JSON、非法 JSON 的 400/40000 三项真实 HTTP 探针通过；九个上传/存储 E2E 套件 201 passed、0 skipped、0 failed。原 SIGKILL、探针转译失败及客户端误将 gzip Buffer 序列化为 JSON 的失败均留证，没有修改业务断言或工具窗口来覆盖失败。

候选 package SHA256 `94746156e49dc62a51e7c443a07d82d991081ea7d185b673f8c0713cc44f8789`；lock SHA256 `32992f6b131f28cdadd34861648d2b130fb72b317ece1ce4bc68b1e500fb8e0a`。本节记录的是本地依赖候选；它尚未推送或通过该候选的 GitHub CI/Smoke/Trusted，不代表上述 main 审计已修复，也没有生产部署。

补充验证：同一候选四文件逐字复制到独立测试检出后，1,092 项契约测试和 2 个快照通过。首次缺少库范围声明的拒绝保留；随后使用正常守卫和明确的新库清单执行，没有关闭守卫或复用上传回归库。原 31 个库名/OID 未变，四个新测试库均保留，最终连接、事务和 advisory lock 为零。

## 每次 release

1. 在最终候选 SHA 上运行 `pnpm audit:production`。
2. 保存命令时间、SHA、漏洞计数和 advisory/path；不保存 token 或 registry credential。
3. high/critical 非零：停止发布并单独评审。
4. moderate/low 变化：更新本页影响分析和发布票；禁止仅看 exit code。
5. 使用 workflow dispatch 验证最终候选 SHA；tag 推送后再确认 GitHub `Production dependency audit` job 整体成功并绑定 tag SHA，不能只看 audit step。

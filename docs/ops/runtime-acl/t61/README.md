# T61 本地制品与门禁自测

以下是实现者的自测记录。T59 的[事后独审与历史缺口](../t59/process-gap.md)、T60 的[三仓组合](../t60/release-runtime-combo-manifest.md)各自保留原时点。T61 的独立审查由调度另行安排。

## H5 本地产物

制品来自 `BA7IEE/SRVFMobileWeb@ae2e3b0ad5202a214d4dcfdc54342e52f9f270a1`，树为 `a48294c88b9fbb6eedb0a27fc0a38df7c4feffef`。本机 10 核、16 GiB，开工时 load 3.61 / 4.11 / 4.10，磁盘可用 68 GiB。两个干净检出各自执行锁文件安装和 `pnpm build:h5`，从各自生成的 `dist-h5/` 独立出包。两份清单、两份压缩包分别用 `cmp` 比对一致。

| 本地路径（均在 `/private/tmp/srvf-t60-release-artifacts/out/builds/` 下）或包内字段 | SHA-256 |
|---|---|
| `h5-ae2e3b0a.tar.gz`，223468 字节 | `dc6714e567f6a0999366200f8a104da02e7e3ec1b356aa9de69c169b529ed599` |
| [h5-ae2e3b0a.files](h5-ae2e3b0a.files)，全 40 个文件 | `78140baa655dad1aefe091c8f6e72732c8f8290085e32f14eee1663e08ede9c0` |
| `index.html` | `58ccd7a4a11710099de5dfa013adcd12665102b0353cf4f9388abad279ce8a5b` |
| `.source-stamp.json` | `5267f801896228bd6fde6212ae55fc712792590ca09c60bfcf46be7e48edf728` |

实际构建环境为本地 Linux/arm64，`node:22-bookworm-slim` 固定于 `node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`，Node v22.23.3、pnpm 10.14.0、GNU tar 1.34、gzip 1.12，各次限 2 CPU / 3 GiB。实测 Node 补丁版本与 T60 示例不同。锁文件 SHA-256 为 `571e0bd3d874ea54b6d950eb10c21f51f7d885514f6a4b3e0e6e59b93e341240`。归档采用 T60 手册的 GNU tar 参数、`SOURCE_DATE_EPOCH=1795165873`、`gzip -n -9`。两次共用依赖下载缓存，各自安装依赖、重新编译。source stamp 的 mode 为 h5，重算源指纹为 `23ad217e49904fa4153b8d8e0098a4d4e383bf3f5e45ac2cf9eedbf6bdc07cf6`。

从压缩包重新解出 40 个文件，逐一比对路径和内容。在本机回环地址的 `/h5/` 读取入口及其两条 JS/CSS 引用，返回内容与清单一致。index 与 T48 同值，此值从本次归档重算；本次包摘要与 T48 不同。实际服务器挂载、登录链路、真机和部署均未验。[复建步骤](../t60/reproducible-build-runbook.md)

## API / Worker 本地共用镜像

运行源码取自 `65bad1ccb7e6a4bb7a3cda46b49512f092d04779`，树 `5df974c3c70425566a712d7b21fc1f5b415f5519`，已核锁文件 SHA-256。使用独立 BuildKit v0.35.1，限制 2.5 CPU / 5 GiB，目标 Linux/amd64。初次 Nest 编译在约 2 GiB 的 V8 堆上耗尽内存。重试仅在临时 Dockerfile 的编译行使用 `RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm build`；运行镜像使用原 CMD 和环境。三处 FROM 固定到 amd64 基础镜像 `node@sha256:12f54cafa58d0e96554ae05871e29663ff7241836377dc9a7916449b8adb062c`。仓内原 Dockerfile 的 SHA-256 为 `d69a1af97cab79dcbf38ed555fa07de1f21bd13c53166f79f8a85374bd50aed2`，实际临时配方为 `61f73dec58cdd69b037ec4a03dab49c454651f7f2ccf625b96b359ffc055c6c6`。两次均按 T60 的 PNPM_VERSION、SOURCE_DATE_EPOCH 与 OCI revision 构建，产出本地标签 `t61-local/api:65bad1cc`。

| 本地归档或身份字段 | 实测值 |
|---|---|
| `/private/tmp/srvf-t60-release-artifacts/out/builds/api-65bad1cc.tar`（131572736 字节） | SHA-256 `da16d1245e234f1192225ab5e9121e9cb9ad0ae731ebc834f9aece2874aeb077` |
| 同目录 `api-65bad1cc.files`（镜像内 dist，3133 个文件） | SHA-256 `c0ffe57c1e245aebf690e09748ce77037b5c9adbb459705a6ff8c85e7aa17a2a` |
| 本地 Docker Image ID / 归档内平台 manifest | `sha256:ca892d7090c4dee48544567cfac1d0cd41862c7585f2cd149f3a8252bbcda26f` |
| 归档内 config digest | `sha256:713509e28960e708cb59bab74cc326f7d0099833a4097bb73c30f548edea7ccc` |
| `dist/main.js` | `e10ab72e6e77b1a299072bdb63f6eaeed82358a4feead875c465e0b03ea9c12a` |
| `dist/notification-outbox-worker.js` | `40fe6a89e0a0d5f5244bb599c50e99862f3e2b1ed2ba3d86b3f053eea8ca9462` |
| `dist/storage-consistency-worker.js` | `2e12665229e1100c6b40bdfa2acad112594cc093f39693e0a3ec4e37bb59790a` |

从归档 index 定位平台 manifest，核对 config、10 个层的 SHA-256/大小与 OCI revision。离线容器无网络，以 UID 1000 运行，Node v22.23.5、Alpine 3.24.4；三个入口通过 `node --check`，Prisma Client 和 sharp 可加载。API 镜像完成一次成功构建，跨次字节复现未验证。Admin 本批未构建，API 接库启动、Worker 领取/提交与 HTTP 业务未运行。registry digest 未授权未取得。

## 检查独审回执

仅在要据独审结果验收时运行。由收件人从审查者的原始回传或调度事件取得来源，核对真实生产者和参与过实现的名单。把规范身份、事件引用、该事件的受审提交、审查者结论及原报告字节的 SHA-256 交给脚本。实现者提供的自述或自行计算的一对回执和报告不能证明来源。GitHub 审查可从实际 review 的作者 ID、commit_id、state 和原始正文取证；子代理用其独立 actor ID 与调度回传。按来源核实是否参与过实现，同一父会话可以有不同的实际执行者。

```sh
scripts/check-true-review-before-accept.sh "$expected_head" "$implementer_id" "$trusted_source_json" "$report_md"
python3 docs/ops/runtime-acl/t61/fixtures/test-review-gate.py
```

JSON 字段为 `actor_id`、`participated_in_implementation`（布尔值）、`source_ref`、`reviewed_sha`（完整提交）、`verdict`、`report_sha256`。预期 head 取自待审 PR。该工具仅对无条件通过使用 `PASS`，拒绝、带条件、未知均不能返回成功。保留原报告正文；若审查者在首段使用 `Reviewer`、`Reviewed-SHA`、`Verdict` 字段，三项须和来源逐一相符。工具可检测输入之间的矛盾，来源真实性和具体行为证据仍由收件人核对。

fixture 自测 25 项，3 项接受、22 项拒绝。覆盖独立主审、同一父会话的独立子代理、原始普通 Markdown，以及作者代审、参与过实现、来源/报告缺失、报告被改、错 SHA、缺 SHA、正文引用 PASS、条件结论和历史 NOT_ACCEPTED。全部样本在 [fixtures/](fixtures/)，其合成身份和提交仅用于检验脚本。

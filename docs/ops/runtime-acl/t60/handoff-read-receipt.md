# T60 新主会话阅读回执

2026-11-20（北京时间）。本会话先通读本地 REQUIRED_HANDOFF，再用 GitHub 固定提交读完 `docs/process.md` 的“任务协作与交接”整节（六条），之后才核对输入、编写 `out/`。以下记录区分本机状态快照、仓内长期规则和构建依据。

## 本机实际打开的交接材料

| 本机路径 | 实读内容 | 文件 SHA-256 |
|---|---|---|
| `/private/tmp/srvf-t60-release-artifacts/notes/REQUIRED_HANDOFF.md` | 长期规则的固定链接、本机锁和缺口、T58 证据边界、生产权限边界及部署决策入口。 | `5716abe5d33accdda45ad331ee3bca68bc88bcdb6aff768ca55f0e5856f77254` |
| `/private/tmp/srvf-t60-release-artifacts/notes/parallel-decision.md` | 19:32 的并行决定只安排轻量材料，重构建留到资源有余量时。 | `7740b307d60aed201b80540043607a1e3968f60abd4f4ffbe51001b8ff822a5e` |
| `/private/tmp/srvf-mac-mutex-checkpoint.json` | 19:34:09 的快照。持锁者 `executor-t35u`，T59 开发已退出，独审会话 `01a1f37a…` 与 T60 `01a1f8bb…` 分目录并行。 | `af3240f5c65cfbf2c53949c1e4cb3ad87435d2d241214e9fb6a3687dc9bd0cc0` |
| `/Users/dengwang/Documents/coding/srvf-nest-api/tmp/srvf-handoff-checkpoints/current/t59-process-gap-note.md` | `current` 实际指向 `4c6f09cfca1e032b81a78c1b`。19:31 记录载明 #1448 合后 CI 成功，合前仅作者会话内 review_convention。按此快照为**已合并、未验收**；历史顺序照实保留。 | `68136b8293c6870b82c5658f7febdb3fc51727f2e6b13dd6fffc5f87ea3f1cd3` |
| 同一 `current/t59-process-gap-note.md`，收尾时重读 | 文件追加 19:38:23 真独审结果，#1448 总判定 **NOT_ACCEPTED（未验收）**。 | `05eae645dfca342b2851f541dc9e4f2986314b826d01ed3651502a1709e9dbe1` |
| `/private/tmp/srvf-t59-true-independent-review.md` | 已读独审报告的判定、审查身份和版本。作者会话外的复核确认内容成立；事后复核无法补回合并前缺失的独审。 | `1eed99fa8a541ace62f42fc26247abd5888fbe9b77b8c2d68f4359d1116b4f35` |
| `/private/tmp/srvf-t58-independent-review.md` | 读到旧 API 和 Admin 已核入口的证据、H5 历史与 Worker 在线状态的限制，以及直连与 API 权限区别。 | `12dd9cea4e73ab24bf3430e2ac17024e85f65dbf031e55ac2894e82109562278` |
| `/private/tmp/srvf-t48-build-inputs.json` | 隔离包、单文件、旧后端基线，内容 SHA-256 与固定仓内记录一致。 | `78009d7974a1c8610619516738138956b28e663337ecc6aecbd342106e34416b` |

## 实际读取的仓内版本

下列 Git blob 为文件对象标识，commit 固定读取时的版本。GitHub 文件通过只读 API 读取；已有本地对象通过 `git show <commit>:<path>` 读取。表内链接定位到相同内容。

| 来源 | 固定 commit / 文件对象 | 读到并用于本轮的内容 |
|---|---|---|
| [docs/process.md · 任务协作与交接](https://github.com/BA7IEE/srvf-nest-api/blob/dede3ec9c43ac76a50e57426250dc8b060b595f4/docs/process.md#任务协作与交接) | `dede3ec9c43ac76a50e57426250dc8b060b595f4` · blob `fb52b395d8387ef6e7776e024ecdb6a470bd7aac` | 明确负责人和完成条件；开工前核依赖、负载与并发；互斥限于登记资源；交接列有效决定和未验证项；未参与实现者核精确版本；集成负责人区分完成、合并、部署和验收。 |
| [docs/WORKING-STATE.md](https://github.com/BA7IEE/srvf-nest-api/blob/dede3ec9c43ac76a50e57426250dc8b060b595f4/docs/WORKING-STATE.md) | 同一 `dede3ec9…` · blob `b39dfea270a90ad0ebefad4b853f1b91dbb478d1` | 此入口指回同一 process 段落。当前任务看工作树和 PR，生产状态另查；dev-guard 为可选来源审计，旧 SHA 与路径不能套用。 |
| [docs/ops/runtime-acl/t58/deployment-decision.md](https://github.com/BA7IEE/srvf-nest-api/blob/dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1/docs/ops/runtime-acl/t58/deployment-decision.md) | `dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1` · blob `5f701ab9b14ff0fc2c88bb4b8832ae319c4d60f6` | 通读三仓制品、DB 角色与差额、隔离目标、准入及回退。正式 digest 未取得；0/13 和 0/2 两个 Worker 相关对照来自 API 登录。 |
| [t58/github.json](https://github.com/BA7IEE/srvf-nest-api/blob/dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1/docs/ops/runtime-acl/t58/github.json) · [database.json](https://github.com/BA7IEE/srvf-nest-api/blob/dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1/docs/ops/runtime-acl/t58/database.json) · [runtime.json](https://github.com/BA7IEE/srvf-nest-api/blob/dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1/docs/ops/runtime-acl/t58/runtime.json) | 同一 `dcc76942…` · blobs 依次为 `d167570fea3501b48e82a1cfd33e13dd8f89dafb`、`1b953a582a715e7bad5c78c47d774f61720aa7d7`、`1676f75f1c1ad407d6d306a8b660fdf33250a357` | 三仓 merge/tree 与受审头、Admin 的 README 差异、旧 API 的 OCI revision、Admin 入口指纹、两条 API 数据库连接以及逐列对照。 |
| [t48/build-inputs.json](https://github.com/BA7IEE/srvf-nest-api/blob/dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1/docs/ops/runtime-acl/t48/build-inputs.json) · [t54/journey.json](https://github.com/BA7IEE/srvf-nest-api/blob/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54/journey.json) | T48 文件取自 `dcc76942…`，blob `abc7ba1dfb7c49dfd03a2a4a603bb1b221a68f93`；T54 文件取自 `416ad53e9c15b7e6f25286e91c268e76ed1c3d4e` | T48 历史输入；T54 本人、另一成员和匿名查询及撤权后的结果。 |

构建依据也逐项打开，锁文件从 Git 对象算 SHA-256，数值见[本地构建手册](reproducible-build-runbook.md)。

- 后端 `65bad1ccb7e6a4bb7a3cda46b49512f092d04779`。读 `Dockerfile`、`.dockerignore`、`package.json`、`pnpm-lock.yaml`、`.github/workflows/ci.yml`；核 `src/storage-consistency-worker.ts`、`src/notification-outbox-worker.ts`、`src/modules/activities/activity-batch-worker.module.ts`、`activity-batch.worker.ts`、`human-correction-runtime-bootstrap.ts`、`ledger-ready-batch-committer.service.ts`、`controllers/app-my-participation-ledger.controller.ts`（后四项相对 `src/modules/activities/`）及 `docs/ops/activity-batch-worker-runbook.md`。核到 API 默认入口、普通 Worker 托管活动循环和业务终审人来源。[后端固定树](https://github.com/BA7IEE/srvf-nest-api/tree/65bad1ccb7e6a4bb7a3cda46b49512f092d04779)
- H5 `ae2e3b0ad5202a214d4dcfdc54342e52f9f270a1`。读 `package.json`、`pnpm-lock.yaml`、`scripts/build.mjs`、`scripts/source-fingerprint.mjs`、`vite.config.ts`、`.env.production`、`.github/workflows/check.yml`、`deploy/nginx.conf.example`。核到 `build:h5` 的输出、相对 base、隐藏 stamp 和模板 CSP。[H5 固定树](https://github.com/BA7IEE/SRVFMobileWeb/tree/ae2e3b0ad5202a214d4dcfdc54342e52f9f270a1)
- Admin `2626116889affe3bda3758f7ed1ce006272503bf`。读 `package.json`、`pnpm-lock.yaml`、`vite.config.ts`、`build/utils.ts`、`build/info.ts`、`.env`、`.env.production`、`.nvmrc`、`.npmrc`、`.github/workflows/ci.yml`、`public/platform-config.json`。核到仓内 Node 版本、production 路径、平台配置和构建时钟。[Admin 固定树](https://github.com/BA7IEE/srvf-admin-web/tree/2626116889affe3bda3758f7ed1ce006272503bf)

## T36 在这次交接中的验证

新主会话实际取得了上面两类规则。长期规则要求由独立审查者给出验收结论。启动时的临时记录将 T60 的写入限定在自己的工作区，T59 独审沿用原工作区。已核当时 load 为 4.80 / 3.97 / 3.84、磁盘可用 68 GiB。沙箱限制了进程表读取，并行登记以 19:34 的 mutex 快照为据。收尾时已收到 T59 单独出具的 NOT_ACCEPTED 结论。本轮 Docker 重构建、大规模 npm 构建、registry push、生产写、GRANT、共享配置变更和切流执行量均为零。

## T61 续会话实读

2026-11-20 19:46（北京时间），实现 owner 在独立 nest-api 工作树从 main `dede3ec9c43ac76a50e57426250dc8b060b595f4` 开工。先读 `/private/tmp/srvf-t60-release-artifacts/notes/REQUIRED_HANDOFF_T61.md`（SHA-256 `ced081e976704723de0b3942a4f976311b1f7776f4e831c3e2bc99554488f372`），重读该提交的 `docs/process.md#任务协作与交接`，并核对 `AGENTS.md`、`docs/current-state.md` 及本地 T60 产物。独立性取决于谁参与实现及谁实际审查，可核对的独立子代理也适用。#1448 历史合前缺独审，后续首发准备可继续。[固定流程](https://github.com/BA7IEE/srvf-nest-api/blob/dede3ec9c43ac76a50e57426250dc8b060b595f4/docs/process.md#任务协作与交接)

| 本次读取的本机材料 | SHA-256 | 应用于本批 |
|---|---|---|
| `/private/tmp/srvf-mac-mutex-checkpoint.json` 19:45:35 快照 | `e606c0881c966cfa577f6ace4a3468fcadca5482f2871f644afc2418f428262d` | 登记 T61 单一实现 owner，自测后由调度另交独审。 |
| `/private/tmp/srvf-t59-issue-pr-disposition.md` | `9604cffa551b64d5f697938e1a7d2b398f28141dabb8eda055bda423c9570b75` | 48 项原处置，开发者末段的自评属历史记录。 |
| `/private/tmp/srvf-t59-true-independent-review.md` | `1eed99fa8a541ace62f42fc26247abd5888fbe9b77b8c2d68f4359d1116b4f35` | 真独审的 NOT_ACCEPTED，两个关单的内容依据成立。 |
| `/Users/dengwang/Documents/coding/srvf-nest-api/tmp/srvf-handoff-checkpoints/current/check-true-review-before-accept.sh` | `c8b4808ccf468a00a17f06540291fc17d4256563f0f172ee23cb6b4f407ce881` | 实读旧脚本三参数、全文搜词和 WARN 分支，发现缺少受审 SHA 比对。 |
| 同目录 `t59-process-gap-note.md` | `05eae645dfca342b2851f541dc9e4f2986314b826d01ed3651502a1709e9dbe1` | 核到 19:38:23 事后审查，保留合并时序和未验收结论。 |

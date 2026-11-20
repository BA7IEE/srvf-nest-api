# T60 运行版本组合清单

三仓已合并，下面的提交是本批唯一构建输入。API 与 Worker 共用一次后端构建。T60 已核源码和构建入口，三端本地制品均待构建，部署和隔离业务验配均未执行。**registry digest = 未授权未取得**。

| 组件 / 仓库 | 构建提交（merge commit） | 完整 Git 树（tree） | 收货对象 |
|---|---|---|---|
| API、Worker · `BA7IEE/srvf-nest-api` #1447 | `65bad1ccb7e6a4bb7a3cda46b49512f092d04779` | `5df974c3c70425566a712d7b21fc1f5b415f5519` | 同一 runner 镜像。API 用 `node dist/main.js`，普通活动消费者使用下述 Worker 入口。 |
| H5 · `BA7IEE/SRVFMobileWeb` #5 | `ae2e3b0ad5202a214d4dcfdc54342e52f9f270a1` | `a48294c88b9fbb6eedb0a27fc0a38df7c4feffef` | `pnpm build:h5` 的 `dist-h5/`，含 `.source-stamp.json`。 |
| Admin · `BA7IEE/srvf-admin-web` #172 | `2626116889affe3bda3758f7ed1ce006272503bf` | `609cfa7eb4480f2d884c800dc6aeed51aa18f1e7` | `pnpm build` 的 `dist/`，含 `index.html`、`platform-config.json` 及静态资源。 |

后端受审头 `65d1d6ea4caaa815faac0e79ead8846b6cc3ade9`、H5 受审头 `529ee3a3c441eaaf992049cbbe6ee32f1414fa63` 各与合并提交同树。Admin 受审头 `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` 的树为 `8f4eb1aa094cd7482a5b76207db3ee068f723338`，到合并提交仅 `README.md` 有差异。三次 main CI 均成功，后端和 H5 的 CI 附件用于测试取证，Admin 该次 CI 无附件。[三仓合并、树和 CI 回执](https://github.com/BA7IEE/srvf-nest-api/blob/dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1/docs/ops/runtime-acl/t58/github.json)

## 后端材料提交

| 材料 | 固定提交 | 用途与差异 |
|---|---|---|
| T58 部署决策 | `dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1` | #1442 合并点 `abeca9a9de857ba414dcda4e0c117bd2f576aa5d` 与它同树。相对后端运行提交，差异都在 `docs/`。 |
| T59 交接约定 | `dede3ec9c43ac76a50e57426250dc8b060b595f4` | #1448 仅改 `docs/WORKING-STATE.md`、`docs/process.md`。这是读规则的版本，后端镜像的 OCI revision 应填上表的 `65bad1cc…`。 |

## 本批制品回执

| 对象 | 本地待填字段 | T60 值 |
|---|---|---|
| API / Worker 共用镜像 | 平台、OCI revision、本地 Image ID、镜像导出文件 SHA-256、镜像内 `dist/` 全清单 SHA-256、三个入口文件各自 SHA-256 | 未构建。普通 Worker 可用 `node dist/storage-consistency-worker.js` 或 `node dist/notification-outbox-worker.js`。隔离首轮选前者，无参数、单实例。 |
| H5 包 | 包、全文件清单、index、source stamp 的 SHA-256，构建 base 与实测挂载路径 | 未构建。源码 base 为 `./`。 |
| Admin 包 | 包、全文件清单、index、平台配置的 SHA-256，JS/CSS 引用、构建 base 与实测挂载路径 | 未构建。仓内 production base 为 `/`。 |

T58 对现场的强证限于旧 API（Image ID `sha256:1eb4e3ca321b141bca0c9c032e919f8665179f843dc623349fcd765ee6c89ffb`，OCI revision `108feebb84b85c7e4955c5af8bbfc016702e4529`）和已核 Admin 入口 JS（SHA-256 `28cd1e9ad7eb6c5ae7dc28d3c364b8f61671729c503ee8bfa228b3c5dc8b86fd`）。Admin 整包历史一致性、Worker 在线身份和版本、H5 在合并窗口是否变化均为 **UNKNOWN**。所核 dp 的 `/h5/` 当时返回 Admin 首页。T48 隔离包摘要只作历史对照，详见构建手册。[T58 部署决策](https://github.com/BA7IEE/srvf-nest-api/blob/dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1/docs/ops/runtime-acl/t58/deployment-decision.md) · [本地构建手册](reproducible-build-runbook.md) · [Worker 隔离方案](worker-isolation-identity-plan.md)

## T61 首次本地收货

H5 已从本清单的合并树两次独立构建。归档 `/private/tmp/srvf-t60-release-artifacts/out/builds/h5-ae2e3b0a.tar.gz` 的 SHA-256 为 `dc6714e567f6a0999366200f8a104da02e7e3ec1b356aa9de69c169b529ed599`。40 个文件全部核验，两个归档字节相同。此项更新仅涉及本地制品，registry digest 仍为未授权未取得。

API/Worker 共用的 Linux/amd64 镜像也已本地收货。归档 `/private/tmp/srvf-t60-release-artifacts/out/builds/api-65bad1cc.tar` 的 SHA-256 为 `da16d1245e234f1192225ab5e9121e9cb9ad0ae731ebc834f9aece2874aeb077`，镜像内 3133 个 dist 文件的清单 SHA-256 为 `c0ffe57c1e245aebf690e09748ce77037b5c9adbb459705a6ff8c85e7aa17a2a`。镜像中的 OCI revision 与本组合的后端提交相符。Admin 仍待构建，Worker 业务验配仍待执行。

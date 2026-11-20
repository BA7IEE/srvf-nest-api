# T62 三包本地出库

三包已在同一台机器的隔离环境验配。Admin 和 H5 的全部静态文件均可通过 HTTPS 按清单取回，API 已连接独立 PostgreSQL。普通成员登录及 Worker 领取失败，过账链尚不能验收。逐项结论、请求号及数据库错误见[隔离回执](isolation.md)。

| 应用 | 运行源码提交 | 本地包（字节） | 整包 SHA-256 |
|---|---|---|---|
| Admin | `2626116889affe3bda3758f7ed1ce006272503bf` | `admin-26261168.tar.gz`（1504444） | `04e010d4d1dd695422eb2cdb850d9800b40dc3e1d4e39d2b761ad1e1bc1507c2` |
| H5 | `ae2e3b0ad5202a214d4dcfdc54342e52f9f270a1` | `h5-ae2e3b0a.tar.gz`（223468） | `dc6714e567f6a0999366200f8a104da02e7e3ec1b356aa9de69c169b529ed599` |
| API 与普通 Worker | `65bad1ccb7e6a4bb7a3cda46b49512f092d04779` | `api-65bad1cc.tar`（131572736） | `da16d1245e234f1192225ab5e9121e9cb9ad0ae731ebc834f9aece2874aeb077` |

三份全文件清单与包同目录。Admin 和 H5 清单覆盖整个静态目录；API 清单覆盖镜像的 `/app/dist`。

| 清单 | 文件数 | 清单 SHA-256 |
|---|---:|---|
| `admin-26261168.files` | 310 | `e9f7587fbba063b106acd6471d2b672efbbd2aa251177b973a441acd4402ff23` |
| `h5-ae2e3b0a.files` | 40 | `78140baa655dad1aefe091c8f6e72732c8f8290085e32f14eee1663e08ede9c0` |
| `api-65bad1cc.files` | 3133 | `c0ffe57c1e245aebf690e09748ce77037b5c9adbb459705a6ff8c85e7aa17a2a` |

## 取得与核验

本机交付目录为 `/private/tmp/srvf-t60-release-artifacts/out/builds/`。另存于 OrbStack 本地命名卷 `srvf-release-artifacts-t62` 根目录，卷内含三包、三清单和 `SHA256SUMS`。从另一个只读挂载的容器重新计算六个摘要均相符。以下命令在持有该卷的本机执行，后两行把 Admin 两个文件导出到新目录。

```sh
docker run --rm --pull=never --network none -v srvf-release-artifacts-t62:/archive:ro -w /archive --entrypoint sha256sum postgres:16-alpine -c SHA256SUMS
dest=$(mktemp -d)
docker run --rm --pull=never --network none -v srvf-release-artifacts-t62:/archive:ro --entrypoint tar postgres:16-alpine -C /archive -cf - admin-26261168.tar.gz admin-26261168.files | tar -xf - -C "$dest"
```

Admin 从干净检出构建，git tree 为 `609cfa7eb4480f2d884c800dc6aeed51aa18f1e7`，锁文件 SHA-256 为 `d4e2ba79caa1aa0ffdd154ef84f4ff837bc2186c14f4a937413d8d76e5e6fcd0`。开工时 10 核、16 GiB、磁盘可用 69 GiB，load 为 3.87 / 3.98 / 4.18。构建使用 Linux/arm64、Node v24.14.1、pnpm 10.14.0，Node 镜像固定为 `node@sha256:fdf1c60c166aaf02dd124c08a1c67b5df800766d3c00661427b84d26138a5432`。执行 `pnpm install --frozen-lockfile`，在 UTC 用 faketime 将编译时间固定于 2026-11-20 09:11:13，再执行 `pnpm build`。对 `dist/` 按 C 排序生成 SHA-256 清单，GNU tar 固定路径顺序、时间戳 1795165873、UID/GID 0、权限 `u=rwX,go=rX`，交给 `gzip -n -9`。已解包逐文件复核，跨次重编译的字节一致性未测。脚本和日志在本机 `/private/tmp/srvf-t62-iso/work/build-admin.sh`、同目录的 `admin-build.log`，持久卷也保留 `build/admin/` 副本。H5、API 直接复用 T61 已登记的归档。[T61 构建来源](../t61/README.md)

## API 归档及导入

`api-65bad1cc.tar` 包含 OCI Image Layout 1.0.0 的 `oci-layout`、`index.json`、`blobs/sha256/` 及 Docker 兼容的 `manifest.json`。经归档索引核验平台 manifest、config 及十层内容。平台为 `linux/amd64`，本机 arm64 以仿真执行。

| 摘要的对象 | 实测或授权状态 |
|---|---|
| 完整本地 tar 文件 | 表首 API 包的 SHA-256，用于复制或导出后核验字节 |
| 归档内 amd64 manifest | `sha256:ca892d7090c4dee48544567cfac1d0cd41862c7585f2cd149f3a8252bbcda26f` |
| 归档内 config | `sha256:713509e28960e708cb59bab74cc326f7d0099833a4097bb73c30f548edea7ccc` |
| Docker 导入后的本地 RepoDigests | `t61-local/api@sha256:ca892d7090c4dee48544567cfac1d0cd41862c7585f2cd149f3a8252bbcda26f`，来自本地导入记录 |
| 目标 registry digest | 未授权、未取得 |

在含归档的目录执行。Docker 实际导入并启动过；containerd 命令供持有独立 namespace 的环境使用，本机未运行 `ctr`。

```sh
docker load --input api-65bad1cc.tar
docker image inspect t61-local/api:65bad1cc
ctr -n t62-local images import --platform linux/amd64 api-65bad1cc.tar
ctr -n t62-local images ls
```

运行目录 `/app`，用户 `node`（UID 1000），ENTRYPOINT 为 `docker-entrypoint.sh`。API 默认运行 `node dist/main.js`；本次单实例普通 Worker 运行 `node dist/storage-consistency-worker.js`，省略参数以启动活动队列和存储循环。`--once` 仅跑存储，通知 Worker 也是可选的活动队列入口。镜像内有 Node v22.23.5、Alpine 3.24.4、openssl/gcompat、生产依赖、Prisma Client、对应 musl 引擎、sharp 和 158 个迁移。引导需要独立的 PostgreSQL 连接、适配环境的 JWT/加密配置及业务开关。API 在 smoke 环境显式设置受信代理、JWT 有效期及独立的 integration 签名密钥；两运行主体分别使用各自的 DB 凭据。迁移由独立工具和隔离库迁移身份执行。[运行身份方案](../t60/worker-isolation-identity-plan.md)

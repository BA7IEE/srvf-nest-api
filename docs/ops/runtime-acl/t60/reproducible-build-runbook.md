# 固定三仓版本的本地构建手册

本轮只核对了 Git 输入。下列步骤留给独审空档、CPU 和磁盘允许时的本地构建窗口。用同一个独立 Linux 构建环境，三端串行，仅向本地输出。构建可重复执行，字节一致性需用两次独立输出验证。

## 1. 准备空目录和锁定的输入

需要 Bash、Git、Python 3、GNU tar、gzip、sha256sum、jq、Corepack 和可读三仓的凭据。镜像步骤使用专用 Docker/BuildKit 实例。前端在干净的 shell 中使用 Node 版本管理器与 pnpm，Admin 固定构建时钟的示例另需 Linux `faketime`。应用的数据库、生产密钥和云凭据都不参与构建。

```bash
set -euo pipefail
export TZ=UTC LC_ALL=C
ROOT=/private/tmp/srvf-t60-release-artifacts
RUN=$(mktemp -d "$ROOT/worktrees/build.XXXXXXXX")
E="$RUN/evidence"
mkdir "$E"
API=65bad1ccb7e6a4bb7a3cda46b49512f092d04779
H5=ae2e3b0ad5202a214d4dcfdc54342e52f9f270a1
ADMIN=2626116889affe3bda3758f7ed1ce006272503bf
checkout() {
  local repo=$1 dir=$2 commit=$3 tree=$4 lock=$5
  git init -q "$RUN/$dir"
  git -C "$RUN/$dir" remote add origin "https://github.com/BA7IEE/$repo.git"
  git -C "$RUN/$dir" fetch -q --depth=1 origin "$commit"
  git -C "$RUN/$dir" checkout -q --detach FETCH_HEAD
  (
    cd "$RUN/$dir"
    test "$(git rev-parse HEAD)" = "$commit"
    test "$(git rev-parse 'HEAD^{tree}')" = "$tree"
    test -z "$(git status --porcelain)"
    printf '%s  pnpm-lock.yaml\n' "$lock" | sha256sum -c -
    git show -s --format='%H %T %ct' > "$E/$dir.git"
  )
}
checkout srvf-nest-api api "$API" 5df974c3c70425566a712d7b21fc1f5b415f5519 32992f6b131f28cdadd34861648d2b130fb72b317ece1ce4bc68b1e500fb8e0a
checkout SRVFMobileWeb h5 "$H5" a48294c88b9fbb6eedb0a27fc0a38df7c4feffef 571e0bd3d874ea54b6d950eb10c21f51f7d885514f6a4b3e0e6e59b93e341240
checkout srvf-admin-web admin "$ADMIN" 609cfa7eb4480f2d884c800dc6aeed51aa18f1e7 d4e2ba79caa1aa0ffdd154ef84f4ff837bc2186c14f4a937413d8d76e5e6fcd0
export SOURCE_DATE_EPOCH=$(git -C "$RUN/api" show -s --format=%ct)
```

三行末尾是本次从固定 Git 对象读出的 **锁文件内容 SHA-256**。每次构建保留 OS/架构、构建环境镜像或快照 ID、Docker/BuildKit、Node/pnpm、tar/gzip、faketime 的实用版本。以下选用 `linux/amd64` 作隔离复现示例，实际目标平台须与收货记录一致。

## 2. 后端只构建一次

仓内 Dockerfile 使用三处 `node:22-alpine`、pnpm 10.14.0、Alpine 的 openssl/libc6-compat。builder 生成 Prisma Client、执行 Nest 编译，runner 含 prod 依赖、生成的 Client、dist 和 prisma，以 `node` 用户运行。构建前为目标平台登记可用基础镜像的不可变引用 `NODE_BASE=node@sha256:…`，保存精确 Node/Alpine 版本和 APK、Corepack、pnpm 依赖快照或可重放缓存。尤其 `apk add --no-cache` 会随包源变化，跨次重建应复用同一包源快照并核对实际安装的版本。

以下仅给本轮临时构建目录生成固定基础镜像的 Dockerfile，并保留其摘要。基础镜像引用与本批发布镜像的 registry digest 分开记录。

```bash
: "${NODE_BASE:?设置已核的平台专属 node 22 Alpine 基础镜像引用}"
python3 - "$RUN/api/Dockerfile" "$E/Dockerfile.pinned" "$NODE_BASE" <<'PY'
import re, sys
from pathlib import Path
src, dst, base = sys.argv[1:]
assert re.fullmatch(r"(?:docker\.io/library/)?node@sha256:[0-9a-f]{64}", base)
old = 'FROM node:${NODE_VERSION}-alpine AS '
recipe = Path(src).read_text()
assert recipe.count(old) == 3
Path(dst).write_text(recipe.replace(old, f'FROM {base} AS '))
PY
sha256sum "$RUN/api/Dockerfile" "$E/Dockerfile.pinned" > "$E/dockerfile.sha256"
tag="t60-local/api:${RUN##*/}"
docker buildx build --platform linux/amd64 --target runner --load -t "$tag" \
  --build-arg PNPM_VERSION=10.14.0 --build-arg SOURCE_DATE_EPOCH \
  --label "org.opencontainers.image.revision=$API" --iidfile "$E/api.iid" \
  --metadata-file "$E/api-build.json" -f "$E/Dockerfile.pinned" "$RUN/api"
IID=$(docker image inspect "$tag" --format '{{.Id}}')
docker image inspect "$IID" --format '{{.Id}} {{.Os}}/{{.Architecture}} {{.Config.User}} {{json .Config.Cmd}} {{index .Config.Labels "org.opencontainers.image.revision"}}' > "$E/api.identity"
test "$(docker image inspect "$IID" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$API"
docker image save -o "$E/api-image.tar" "$IID"
mkdir "$RUN/api-dist"
cid=$(docker create --network none "$IID")
trap 'docker rm "$cid" >/dev/null' EXIT
docker cp "$cid:/app/dist/." "$RUN/api-dist"
docker rm "$cid" >/dev/null
trap - EXIT
for f in main.js notification-outbox-worker.js storage-consistency-worker.js; do
  test -s "$RUN/api-dist/$f"
done
(cd "$RUN/api-dist" && sha256sum main.js notification-outbox-worker.js storage-consistency-worker.js) > "$E/api-entries.sha256"
sha256sum "$E/api-image.tar"
```

核对 `api.identity` 的平台、`node` 用户、默认命令和 revision。记录本地 Image ID 与镜像导出文件 SHA-256 各自的值。同一 ID 交给 API 和 Worker；各角色使用的入口另记。最终镜像的 registry digest 仍为 **未授权未取得**。

## 3. 两个静态包串行构建

示例在已装好对应 Node 版本的隔离 shell 内执行，使用 `nvm use` 切换。H5 的 CI 用 Node 22，仓库最低 22.12.0，示例锁 22.14.0。Admin 使用仓内 `.nvmrc` 的 v24.14.1。两端统一示例 pnpm 10.14.0，满足 Admin 的 pnpm ≥9 / CI 10.x。安装时启用仓内 `.npmrc`，按锁文件装完整开发依赖，保留包管理器缓存（含 Admin preinstall 经 npx 取得的工具版本）。运行前清除继承的 VITE 变量和本地 .env 覆盖，在隔离工具环境中启用 Corepack 的 pnpm 入口。

```bash
(
  cd "$RUN/h5"
  nvm use 22.14.0
  corepack enable
  corepack prepare pnpm@10.14.0 --activate
  test "$(node -v)" = v22.14.0
  test "$(pnpm -v)" = 10.14.0
  pnpm install --frozen-lockfile
  pnpm build:h5
  jq -e '.mode=="h5" and (.fingerprint|test("^[0-9a-f]{64}$"))' dist-h5/.source-stamp.json
  test -s dist-h5/index.html
)
(
  cd "$RUN/admin"
  nvm use
  corepack enable
  corepack prepare pnpm@10.14.0 --activate
  test "$(node -v)" = v24.14.1
  test "$(pnpm -v)" = 10.14.0
  pnpm install --frozen-lockfile
  STAMP=$(date -u -d "@$SOURCE_DATE_EPOCH" '+%F %T')
  FAKETIME_DONT_FAKE_MONOTONIC=1 faketime -f "$STAMP" pnpm build
  test -s dist/index.html
  test -s dist/platform-config.json
)
```

H5 的 `build:h5` 显式选择 h5 模式、base `./`、输出 `dist-h5/`。默认 `build` 选择 unconfigured。Admin 的 `build/utils.ts` 将 `new Date()` 格式化为 `lastBuildTime`，故上述命令固定 UTC 构建时钟，复跑时也应相同。Admin 仓内 production 设 `VITE_PUBLIC_PATH=/`、hash 路由、CDN 关闭、压缩 none。收货时记录两个实际挂载路径，按该路径解析 index 的 JS/CSS 并逐一与清单比对，检查 H5 没有回落到 Admin 首页。若目标需要另一个 base，记录它并重新生成独立包。H5 仓中的 nginx 示例限制 `connect-src 'none'`，隔离验配的 HTTPS 同源 API 路由及 CSP 需另核。

## 4. 全量哈希和复跑判定

在构建目录外生成清单。算法为文件原始字节 SHA-256，路径为相对包根的 POSIX 路径，按 UTF-8 字节排序，每行 `哈希␠␠路径`，LF 结尾，包含隐藏文件。两个静态包另做规范化归档。下列命令沿用同一 Bash 会话。

```bash
filelist() {
  python3 - "$1" <<'PY'
from hashlib import sha256
from pathlib import Path
import sys
root = Path(sys.argv[1])
for file in sorted(root.rglob('*'), key=lambda p: p.relative_to(root).as_posix().encode()):
    if file.is_symlink():
        raise SystemExit(f'核实链接目标后再出包 {file}')
    if file.is_file():
        name = file.relative_to(root).as_posix()
        if any(c in name for c in '\r\n\\'):
            raise SystemExit(f'文件名不能用本清单格式表示 {file!r}')
        print(f'{sha256(file.read_bytes()).hexdigest()}  {name}')
PY
}
filelist "$RUN/api-dist" > "$E/api.files"
for app in h5 admin; do
  dir="$RUN/admin/dist"
  if [ "$app" = h5 ]; then dir="$RUN/h5/dist-h5"; fi
  filelist "$dir" > "$E/$app.files"
  (cd "$dir" && sha256sum -c "$E/$app.files" >/dev/null)
  tar --sort=name --format=gnu --mtime="@$SOURCE_DATE_EPOCH" \
    --owner=0 --group=0 --numeric-owner --mode='u=rwX,go=rX' \
    -C "$dir" -cf - . | gzip -n -9 > "$E/$app.tar.gz"
done
(cd "$RUN/api-dist" && sha256sum -c "$E/api.files" >/dev/null)
(cd "$RUN/h5/dist-h5" && sha256sum index.html .source-stamp.json) > "$E/h5-entries.sha256"
(cd "$RUN/admin/dist" && sha256sum index.html platform-config.json) > "$E/admin-entries.sha256"
(cd "$E" && sha256sum api.files api-image.tar h5.files h5.tar.gz admin.files admin.tar.gz) > "$E/bundle.sha256"
```

在另一个全新 `RUN` 重复步骤 1–4。按组件比对 Git 输入、工具和包源，再比对入口、全文件清单、静态包、本地 Image ID 和镜像导出摘要。若不同，保留两份回执，先定位是文件内容、构建时钟、基础层还是归档格式发生变化。只有实测相同的字段能标为字节复现。绑定这批实际导出的字节后，方可填写[组合清单](release-runtime-combo-manifest.md)。

T48 的后端是 `dd62ce30…`，其 `dist-final.tgz` 以 `75c0dfa0…` 开头；当时的 H5 包 `26690daa…`、index `58ccd7a4…`、Admin 清单 `9f44857d…` 仅是历史隔离样本。三者都不能填入 T60 的制品回执。[T48 原始记录](https://github.com/BA7IEE/srvf-nest-api/blob/dcc7694258fc6dce1b1976158fd7bfdebaaaf1a1/docs/ops/runtime-acl/t48/build-inputs.json)

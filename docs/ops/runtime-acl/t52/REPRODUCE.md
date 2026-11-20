# T52 核验方法

## 两个后端 PR 的 Git 预演

在含 #1445 和 #1446 两个冻结对象的后端仓库运行下列命令。Git 报出唯一冲突并返回 1，首行给出临时 tree。将该 tree 用 git archive 展开到新的临时目录，先放入 #1445 的生成文件供读取，再运行仓库生成器与检查。重新生成的完整文件和预演 Git tree 均可与回执核对。[原始命令与哈希](backend-combination.json)

```sh
git merge-tree --write-tree dd62ce308f9142e8b3be04e9c4d52f548c0ebb17 4c8cba0af25abe4587533c513489729a5f219fbe
```

```sh
pnpm install --offline --frozen-lockfile
pnpm prisma:generate
pnpm exec tsx scripts/generate-authz-manifest.ts --write
pnpm docs:authz:check
pnpm build
pnpm test --runInBand --runTestsByPath src/modules/notifications/notification-outbox.metadata-guard.spec.ts
```

本次 Mac 默认 Prisma 缓存禁止更新时间戳，首次 generate 返回 1；改用 Prisma 官方引擎路径变量指向同一版本已安装的引擎，generate 和后续命令返回 0。

## 只读候选预检

通过启用已知主机校验的 SSH，在 PG 容器以只读目录查询核对运行角色、目标库和已有 API 会话的客户端地址。调用 [#1446 的预检 SQL](https://github.com/BA7IEE/srvf-nest-api/blob/4c8cba0af25abe4587533c513489729a5f219fbe/docs/ops/runtime-acl/t49/preflight.sql)，以其同目录的 ledger-contract.json 作为 contract 参数，传入 expected_database=srvf_staging 和 runtime_role=srvf_dp_acceptance_runtime；本次观察者为运维身份。初次尝试从单独启动的容器 Node 进程使用默认 Prisma 上下文取证返回 2；现场关联改用 pg_stat_activity，只比较库、角色和容器私网地址，无业务行或凭证输出。SQL 原文 SHA-256、退出码、逐列结果与镜像标签已归档。[只读回执](shared-preflight.json)

## 隔离非空账本

前提是独立测试主机已存在脚本内三个精确镜像，且已完成上述组合构建。在数据库夹具写入期间使用临时库所有者；读面另开仅有合同列权限的普通数据库登录。业务查询从组合构建的 dist 加载，直接调用真实查询方法。准备阶段只复用仓库 E2E 读面工厂，不经过生产发放、结算写入及 HTTP 身份链。

1. 在开发机运行 `node prepare-fixture.cjs <组合源码目录> fixture.cjs`。工厂取自 `test/e2e/activity-batch2-9b-ledger-read.e2e-spec.ts`，使用同树的 Member 夹具辅助函数和实现常量。
2. 在试验服务器以 `umask 077` 和 `mktemp -d /var/tmp/srvf-t52.XXXXXXXX` 新建专属目录。在其中放置组合源码的 prisma/ 与构建出的 dist/、`test/fixtures/r5-ci-sealed-roles.sql`（命名 sealed.sql）、`fixture.cjs`、本目录的 `reader.cjs` 和 `isolated.sh`；把 #1446 的 `check-ledger.sh`、`preflight.sql`、`ledger-contract.json` 放在 contract/。
3. 在这个专属目录运行 `bash isolated.sh`。脚本只创建带当次唯一标签的无网络 PG 和私有 socket，跑真实迁移，验证缺列、补足、分页、本人/他人/未提交及撤权后的拒绝。退出时清除该标签的容器和卷。保留聚合回执后移除该次上传目录。[隔离执行脚本](isolated.sh) · [读面断言](reader.cjs) · [工厂准备](prepare-fixture.cjs) · [本次实际输出](nonempty-isolated.json)

## GitHub 盘点

`gh pr list --state open --limit 100` 逐仓采集 PR 与 HEAD 上的 statusCheckRollup；后端用 `gh issue list --state open --limit 100` 枚举，再对近期已合 PR 读取 mergeCommit 和已完成的原生检查。用 GitHub compare 对比精确 SHA，另以 `git merge-base --is-ancestor` 核实所有列入的合并提交已进入后端 main 和 #1445。检查状态是采样时点，历史证据分支的 SHA 与本次材料新提交通常不同。[逐项作业和链接](inventory.json)

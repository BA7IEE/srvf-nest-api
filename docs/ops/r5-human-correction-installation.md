# R5 Human 后台更正：正式安装与默认关闭装配

本候选在 Prisma 正式账本追加 `20261031223000_r5_correction_set_materialization`（第155项）。唯一安装入口仍为 `pnpm exec prisma migrate deploy`；不另跑手工155 SQL，不回改1–154，不执行 reset / db push / seed。目标须无 AttendanceCorrectionRequest、尚无两个R5表；不适用于已经手工安装的测量克隆库，也不做旧业务数据转换。

## 安装前提

155不创建角色、membership、密码、HBA或连接池。安装者必须具备来源模型对象安装/owner/ACL所需既有权限。以下五个角色必须预先存在且封存：NOLOGIN、无superuser/createdb/createrole/replication/bypassrls；仅P为INHERIT，其余NOINHERIT。

| 来源代号 | 精确角色名 |
|---|---|
| O | r5_boundary_owner_h7c6 |
| C | r5_boundary_caller_h7c6 |
| M | r5_mat_writer_20261029_q1 |
| P | r5_human_queue_login_20261030_q1 |
| U | r5_untrusted_caller_login_20261030_q1 |

涉及这五角色的membership必须恰好两条：P→C（SET/INHERIT真、ADMIN假），U→C（SET真、INHERIT/ADMIN假）。迁移只验证前提和安装已冻结的对象/ACL，不替运维配置这些角色。来源已存在的 PUBLIC EXECUTE（含 ptar_slice_guard）保留原值，不扩大。迁移安装后 `r5_correction_boundary_preflight()` 仍为NULL拒绝，安装成功不代表运行许可。

2026-11-01独立 tmpfs PG16验证：一次Prisma migrate deploy完成全部155项且账本名称/校验摘要精确一致；30表、201函数、5枚举与冻结来源零差异；原生NULL守卫55000拒绝。五个测试角色均NOLOGIN/无密码，容器正常清理。它不是生产角色/认证或业务联调证明。

## 正常应用配置

三个变量归 `app.config.ts`，示例均默认关闭：

```dotenv
ACTIVITY_HUMAN_CORRECTION_BACKGROUND_MODE=off
ACTIVITY_HUMAN_CORRECTION_INSTALLED_RECORD_PATH=
ACTIVITY_HUMAN_CORRECTION_INSTALLED_RECORD_SHA256=
```

off不读取record、不增加启动资格SQL；原业务门禁不改变。`first-launch`才装配60秒大批后台提交和240秒大批V3准备候选，同步15秒、普通7秒、普通E4 60秒、单锁4秒、10槽、租约300秒不变。仅符合原大批/后台条件的业务选择器才用新预算。

启用前必须分别完成：精确目标身份/来源审查、独立安装及真实认证回执、按已批准流程绑定运行预检函数，再形成不可变的非秘密 installed-record。禁止把现场目录直接填作expected、把公开hash当认证或借管理员连接通过。附带JSON只是无效模板，状态/OID/摘要故意缺失，不能直接启用。record须普通文件、不可符号链接、不可组/全局写、≤2MiB；路径绝对、SHA256精确绑定字节。部署挂载只读，secret仍通过既有数据库凭据机制提供，不放record/日志。

HTTP普通服务保留原PrismaService/DATABASE_URL；Human服务私有模块使用显式HUMAN_CORRECTION_DATABASE_URL及独立P客户端。HTTP的两池须分配原最多5连接预算，不可互换、不可失败回退。每笔Human事务继续原身份/目录/actor/fence资格及同事务audit/Item；启用缺少来源、身份或普通连接隔离资格时拒绝。默认off不创建P客户端。

## 启动与真实未验边界

正常构建与HTTP入口：`pnpm build`，随后 `node dist/main.js`。HTTP仍受原全局配置、认证、数据库和业务Gate约束，不能仅凭本开关承流。

Human专用worker复用既有二进制/worker槽：`node dist/notification-outbox-worker.js --human-correction-only` 或 `node dist/storage-consistency-worker.js --human-correction-only`，选择其中一个，不同时启动。profile与flag双向联锁；禁止混用storage手动/once参数。在构造普通图前严格选择HumanCorrectionWorkerModule的Human实例，只启动该run循环，不启动outbox/storage循环。未启用profile时原CLI语义保留。

普通HTTP/通用worker的production图继续原StorageSettings和STRICT启动检查，使用普通连接；Human专用根图不装配这些无关生命周期，附件内容/属主/StorageObject事务校验仍完整保留。没有为受限P补权。现有核心provider仍只接受已批准q1测试库/精确角色模型，不能据此宣称生产配置已可启用。最终目标角色/数据库不同须先有独立审查和来源绑定，不是改record即可自动获准。生产完整图资格、网关长请求、HTTP/worker同版联调仍待执行。

原worker shutdown等待activeRound；部署平台实际关闭宽限须覆盖完整活动轮及回收尾部，不能用SIGKILL声称排空。240秒准备是HTTP真实请求，不属于worker租约；现有前端单请求可设300000ms，但实际网关长请求配置位置/取值尚未核实。应用GET不能恢复丢失prepare回包中的application/batch，仍需既有原意图POST恢复协议；本次不新增恢复接口或页面。

## 最小CI与启用前动作

1. 本候选默认off，运行 `pnpm agent:check:quick`；相关实际模块/CLI/业务回归须保留。完整 `pnpm typecheck` 检查src、test、scripts三个工程。
2. 隔离空PG以精确五角色fixture先行，再运行唯一Prisma deploy155并核账本/来源/NULL；不把已装测量库当冷安装对象。现有test/setup/global-setup.ts只建模板并deploy，没有五角色预置；完整CI必须在独立测试PG启动后、globalSetup前先提供这个既有来源模型，不能改成共享服务器自动增权。R5业务正例另需独立来源/认证/绑定夹具；本轮NULL守卫应保持拒绝，不能为CI直接解除。
3. 在最终同一源码上完成既有required CI（Lint/Typecheck/E2E分片、contract、Docker image、Diff guards、Trusted red-zone）。本次不push、rerun远端CI或部署。
4. 最终目标配置明确后，核全部正常图权限与真实P/U认证、运行预检绑定、平台grace及网关配置，然后安排同版HTTP/worker/实际admin-web联调。旧成功XID159309/159372不得重放；历史FAIL和分段补验边界保留。万条增量/继续性能优化不属本次首发门槛。

本次未做：生产或原测量库安装、运行账号/凭据/HBA设置、开关启用、业务重放、前后端真实联调、推送/合并/部署。


## Scoped runtime candidate (2026-11-01; not enabled or authenticated here)

The ordinary `DatabaseModule` retains its existing `PrismaService` for login,
refresh tokens, Storage and general work. `HUMAN_CORRECTION_DATABASE_URL` supplies
only the dedicated Human client. Default `off` creates no such client. An enabled
profile requires the original source/installation record and actual P/C
qualification; absence or failure never falls back to the ordinary client.
The private Human execution module binds all collaborators, pre-transaction reads,
Human preparation, acceptance/retry/reconciliation and publication to P. Business,
audit and protected Item writes keep the original transaction argument.

Both existing worker binaries select `HumanCorrectionWorkerModule` before
constructing their ordinary root when passed exactly `--human-correction-only`.
This replaces an existing worker slot; it does not add a concurrent worker.
The root contains no Storage lifecycle. Attachment reference locking and ready/
ownership checks still delegate to the original transaction-only functions.
Ordinary worker claim predicates continue to exclude Human jobs.

No identity or permission is created by this wiring. Do not expand P to support
login or Storage. HTTP N and P URLs must target the same endpoint/database,
use different logins and have explicit `connection_limit` values totalling at
most five (for example N=4, P=1). The dedicated worker only has P, at most five.
First-launch refuses simultaneous shadow mode, which could create a third pool.
The unchanged ten member slots, 4s locks, synchronous 15s, background bulk 60s/
240s and shutdown/lease budgets remain separate limits.

HTTP additionally checks the actual ordinary login/current identities in a read-
only transaction: same bound database/OID; no reachable SET-role capability to P,
Item writers, owner/DDL roles or high-privilege roles. Ownership inheritance is
checked with `pg_has_role(..., 'USAGE')`. These new checks have pure/DI coverage;
the SQL and the actual ordinary role have NOT been authenticated in PG here.
Indirect capabilities and the complete ordinary role profile remain an activation
gate. The q1 receipts only identify C/P/U, not a qualified full-product ordinary
identity. Do not claim a production HTTP loop from test-mode initialization.

Normal CI keeps ordinary V3 positives. Six explicitly bounded operator experiments
remain in the dedicated configs named by `test/r5-operator-suites.json`; regular
CI/nightly accounting includes every remaining suite and separately accounts for
all six. The mixed concurrency suite retains its pure cases and explicit DB TODOs.
A legal isolated runtime qualification fixture is still required for V3 positives;
see the scoped-runtime handoff. Never inject the retained q1 credentials/receipts
or change its Prisma migration ledger to satisfy CI.

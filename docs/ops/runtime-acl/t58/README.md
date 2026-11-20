# T58 三仓合并后的生产联动核查

**在已核的 dp 入口，没有发现三次合并使线上切换到新版本。** API 仍运行旧镜像，管理端仍提供合并前测到的入口文件；H5 路径回落到管理端页面。独立 Worker 当前没有运行证据。建议维持现场，另行安排内部配对验证。

**撤回 T57 对合并前置已满足的判断。** 三仓合并时有 GitHub 配置证据，缺宿主侧证据。本轮首次严格主机校验成功在 2026-11-20 18:20:18 北京时间。以下时间窗可以回看部分记录，不能补成合并前已核的证明。[T57 原始提交](https://github.com/BA7IEE/srvf-nest-api/blob/deb984ff5bd4a9d27b7de15dc97712058ab6d686/docs/ops/runtime-acl/t57/prod-linkage-certificate.md) · [部署准备及停止条件](deployment-decision.md)

## 合并与现场逐项对照

以下三仓 main 在采样时均等于表中合并提交。三次 main push CI 均成功；观察到的附件是验证材料。Admin 合并树相对受审树仅多一份 README 修改，后端、Mobile 各自两棵树完全相同。[GitHub 原生回执](github.json)

| 组件 | 合并时间（北京时间）及 main | 受审 tip | 现场及判定 |
|---|---|---|---|
| API | 17:11:14，`65bad1ccb7e6a4bb7a3cda46b49512f092d04779` | `65d1d6ea4caaa815faac0e79ead8846b6cc3ade9` | **未变，强证据。** 容器 `31784982…` 自 11-19 20:19:26 运行。完整 Image ID 为 `sha256:1eb4e3ca321b141bca0c9c032e919f8665179f843dc623349fcd765ee6c89ffb`，RepoDigest 未提供；OCI revision 为 `108feebb84b85c7e4955c5af8bbfc016702e4529`。PID 1 启动 `./dist/main.js`，dist 没有容器层变化，也未被卷覆盖；三个业务模块指纹与新版隔离制品不符，其中 H5 会话模块缺席。 |
| Admin | 17:13:47，`2626116889affe3bda3758f7ed1ce006272503bf` | `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` | **已核入口未变，强证据。** OpenResty 实际挂载的目录标记为 `b7f3dac00a860e32c0cbc220f29da0755bce024b`；入口 JS 的 SHA256 `28cd1e9ad7eb6c5ae7dc28d3c364b8f61671729c503ee8bfa228b3c5dc8b86fd` 与 T34/T35 相同。同主机严格 TLS 实际返回与磁盘 index 相同的字节。302 个指明范围内的文件本次清单 SHA256 为 `f490c32360e6fda779ea5ab4e1244bb9ec297017dd2466a67827fe3276fc2249`，最新 mtime 在 11-08。缺合并前完整清单与构建签名，整包逐字节不变为 UNKNOWN。 |
| Mobile H5 | 17:12:37，`ae2e3b0ad5202a214d4dcfdc54342e52f9f270a1` | `529ee3a3c441eaaf992049cbbe6ee32f1414fa63` | **当前 dp 未提供独立 H5 入口，期间变化 UNKNOWN。** `/`、`/admin/`、`/h5/` 均为 200，同一管理端 HTML，SHA256 `ae73cbd7964b002e705a9ce22c882fd2e5ec5a7f689ab510d21961b9ea3a1253`。站点目录无对应 H5 index，配置无 H5 专用上游。合并前也无 H5 独立部署基线，其他域名或外部入口未核。 |
| Worker | 后端版本同上 | 后端 tip 同上 | **历史完成时间未变，在线版本 UNKNOWN。** API 镜像内有 Worker 文件，PID 1 是 API。SRVF 唯一名称命中 Worker 的是已退出的预检容器；全机 10 个相关 Node 类进程中没有命中该 Worker 入口。通知、活动队列各 1 条，最近完成分别为 11-19 05:13:10、05:13:58 UTC，与 T34 相同；当前 pending、processing、有效租约均为 0。无在线消费者可归属到版本或 DB 登录。 |
| PG / 反代 | 随后端对照 | 同上 | **已核迁移与 dp 路由未变。** PostgreSQL 16.16，成功 156 项，逐个 checksum 对齐旧 revision；main 的两项新迁移均未施加。Nginx 配置 SHA256 `86cacf43aefd1dab3fefc67d25ea81d6f81f700a43d81c34d26ee6bb13f958fc`；登录、刷新、退出与其余 `/api/` 共四处指向 `172.25.0.2:3000`，对应上述 API。 |

配置文件和现行 OpenResty worker 同在 11-19 18:18:16 北京时间生成或启动。主机回环请求保留 dp 域名、SNI 与证书验证，合同路径 `/api/system/v1/health/live` 及 `ready` 均为 200，TLS 验证返回 0。首次使用非合同路径 `/api/health/live` 得到 404；该次采样前后增加一条到已映射 API:3000 的 TIME_WAIT 连接，只作旁证。未向公网发业务请求。API 容器设置的可信代理为 `none`。1Panel 将 dp 标作 static，实际配置同时提供反代与静态内容。[运行容器、静态清单与回环回执](runtime.json) · [数据库只读投影](database.json) · [合并前管理端实测](https://github.com/BA7IEE/srvf-nest-api/tree/a571a8c0f2b47a59bd3c85d0a80439b51ea53b41/docs/ops/runtime-acl/t35)

## 自动发布入口和时间窗

历史窗口固定为北京时间 **17:00–18:20**，覆盖最早合并前 11 分钟及最后合并后 66 分钟。此后 SSH 逐项读取当前配置和有效状态。三个仓的仓库级 webhook 均为 0。核对合并提交的九份工作流，未命中所查 registry push、远程部署动作及自托管 runner 指示；三个合并 SHA 的 GitHub Deployment 记录均为 0。GitHub 的 main 工作流及 runbook 可解释仓库侧行为，宿主证据如下。[调度与窗口回执](automation.json) · [命令与取证范围](method.md)

| 入口 | 有效配置、触发条件及记录 | 判断 |
|---|---|---|
| 系统与用户 cron | 检查系统 crontab、摄入的 cron.d、小时至月脚本及用户 spool。root 每五分钟执行云主机代理维护，系统代理另有每分钟及每半小时项；定向读取被引用脚本，未命中 SRVF、代码更新或容器部署。窗口记录 100 次 CRON CMD，没有 SRVF 或部署标记。 | 已发现的活动计划没有跟随 main 的条件。 |
| systemd / 用户单元 | 检查 189 个相关系统单元，含本地定义、service、timer 和 path。59 个 SRVF timer 全部 disabled/inactive；72 个历史 service 为 static/inactive，另 1 个历史手工收尾 service 在 11-10 失败后停留 failed。启用并在跑的 timer 属系统维护；root 用户总线无匹配单元，其余两个普通 UID 无用户总线或本地单元文件。 | 初次通配 journal 查询超时；随后定界读取窗口中全部 2,976 条 journal 的单元元数据，未达 20,001 上限，SRVF 单元或部署标识命中 0。 |
| Compose / 镜像或 Git 跟踪 | 运行 API 的 compose 使用固定本地标签、`pull_policy: never`、`restart: no`。另一个栈的 PG 按 digest 固定，迁移工具同样禁止自动拉取。检查了 9 个 SRVF 面板 compose 工作目录及父目录，API /app 和静态发布目录，无 .git。运行和停止容器中均未发现已查自动更新工具；13 个活动容器没有直接挂载 docker.sock。 | 无这些入口触发 pull/recreate 的证据。Docker 事后可读环形缓冲仅 256 条，最早已在 18:29，窗口内返回 0 **不能**作为当时没有 Docker 操作的证明。 |
| 1Panel 计划任务、脚本和 webhook | 在运行的 agent/core 的文件句柄中确认活动数据库；活动 agent 及旧 1Panel 任务库的 cronjob、job_record 均为 0，含启用及停用。agent/core 脚本库有 7/9 条，分类检索无项目、仓库跟踪、镜像跟踪、重建及 webhook 命中。task 库总计 132 条，最新记录在 01:56 北京时间；窗口内无任务。相关库无 webhook 命名表，已查 settings 无对应键。窗口内另有 176 条 agent journal，未命中项目部署。 | 未发现已配置并命中合并的面板入口。没有对外部控制系统、主机外推送或通用代理的全部能力作反证。 |

**影响判定限于这台主机、dp 路由和所列窗口。** 没有发现需要紧急回滚的线上影响；建议保持当前路由及制品。临时换版后又恢复、主机外控制器及未经记录的人工操作无法由此次事后采样完全排除。公网业务、真机微信、生产恢复演练均为 **NOT_RUN**。共享新增 GRANT 为 **0**，本轮未触发队列或投递。

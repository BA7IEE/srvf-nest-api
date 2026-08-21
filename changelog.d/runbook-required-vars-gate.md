### Added

- 「生产必填项必须在部署 runbook 里有条目」类闸(`scripts/ops-required-audit.ts`,第七轮评审包 F 的 F-01 + F-02)。两条断言,**都从事实源动态解析,不写死名单**:① 凡 `src/config/app.config.ts` 在 production / smoke 守卫下 `throw` 点名的环境变量,必须至少在一份部署 runbook 中出现;② 凡 `package.json` 里形如 `start:*-worker` 的脚本,必须至少在一份部署 runbook 中出现。落地当天实测**红 9 条**(7 条环境变量 + 2 个 worker 进程),即本刀要修的缺陷本体。

  发现口径刻意**不用** grep 中文错误消息(起草探针用的是 `grep "X 不能为空"`)—— 那是措辞耦合,下一条必填项写成「必须显式设置」就静默漏掉、判据全绿。改用 typed-AST:遍历 `app.config.ts`,记录每个 `throw` 是否落在 production 守卫的 then 分支内(两种守卫形状 `isProductionLike(` 与 `env === 'production'` 实测都在用,else 分支不继承),从守卫内 throw 的消息里抽 SCREAMING_SNAKE token,再用「`src/` 里确实存在 `process.env.<TOKEN>`」做假阳性过滤。⇒ 换措辞不影响发现,新增第 13 条必填项自动进入扫描面。两种口径独立跑出同一读数(12 条必填 / 7 条未登记),互为交叉验证。

  自证用**地板锚点**(必填变量 ≥10、worker 脚本 ≥2、每份 runbook 非空)而不是「恰 N 条」:后者每次新增必填项都要改判据,那种摩擦会诱导人把数字调大了事。采集器塌成 0 时以「仪器失效」退出、拒绝报结论 —— 空集恒等于空集会静默变绿。

  ⚠️ **本 PR 内它尚未接 CI**,故此刻仍是「手动跑才有的判据」。接 CI 需要三处红区改动(判据改名进 `scripts/check-*.ts` 保护面、`package.json` 加别名、`ci.yml` 接进 Docs guards),须维护者授权 —— 见 PR 描述。**「闸红了没人消费 = 没有执法」是本仓已记录的事故形状,这一步不做完这条闸就只是半件事。**

### Fixed

- 部署 runbook 补齐 **7 条必填环境变量**(`docs/ops/server-deployment-runbook.md` §2.6 重写为完整清单表)。此前 `ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED` / `ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED` / `ACTIVITY_V11_WORKFLOW_ENABLED` 三条在两份 runbook 里**一个字都没有**;四把 `*_ENCRYPTION_KEY`(`SMS` / `WECHAT` / `WECOM` / `REALNAME`)原文只有「五把 `*_ENCRYPTION_KEY`」的简写,**没有字面量** ⇒ 既 grep 不到也无法机器核对。七条实测均**早于** 2026-08-20 那次第一阶段 PASS(最早 06-11,最晚 08-19),即真机上必然已被赋值、只是**从未记录** —— 重建服务器时会当场丢失。

  五把加密密钥单独补一节纪律:它们做的是 PII 与第三方凭证的**静态加密**,**一经启用不得更换** —— 缺失只是启动失败(当场就知道),换掉或填错则是**用旧 key 加密的数据再也解不开**,而且不当场报错,要等某次读实名信息或调第三方时才炸,那时已分不清哪批数据受影响。要求离线备份、与数据库备份分开存放、不得入库不得写进文档。

- 部署 runbook 补上**常驻 worker 部署整节**(stage2 新增 §2.G / §2.H)。2026-08-21 复查真机:`docker-compose.server.yml` 只有 `postgres` + `api`,`docker ps -a` 里 worker 容器**从未存在过** —— 前两阶段跑完,后端一直缺着三个常驻处理器,而它**不报错**,只是消息永远不发、批任务永远不跑。补入 compose 服务块(与 api 同 `build.context` 同 `env_file`、无 `ports`)、`--no-deps` 启动命令(不加会顺手重建 api,把加 worker 变成计划外停机)、启动日志验收,并**指向**既有的 `docs/ops/activity-batch-worker-runbook.md`(那份已写了租约 / 重试常量、两入口对照与五个坑,不重写)。

  🔴 同时写进一条**误判陷阱**:真机 outbox intent 表当时 `succeeded 2 / pending 0`,看上去像 worker 在跑。推理是错的 —— `notification.service.ts:502` 把 worker 注入进了 API 自己的 service,管理面 `send-sms` 会在自己那个 HTTP 请求里内联 drain 掉刚建的 intent(request-owned fence),那 2 条是 API 干的。**全仓只此一处内联 drain**;报名审核 / 招新发号 / 入队成功三条真实业务链实测零内联,只写 intent 就返回。⇒ **「管理员手工发短信成功」证明不了 worker 在跑**,验收必须认启动日志或走真实业务事件。

  拓扑一并写清:是**三个 worker 类跑在两个进程里**,不是三个容器 —— `ActivityBatchWorker` 在两个进程内各起一份循环;API 容器一个都不跑(未注册进全局 module,且 API 侧注入 `ACTIVITY_BATCH_AUTO_COMMIT_ENABLED = false`)。

- `storage-consistency-worker` 单独给出部署决策依据(stage2 §2.H):它**不在 happy path 上** —— 附件上传 / 替换在 HTTP 请求里有内联兜底(`attachment-write.service.ts:367`、`attachment-visual-identity-upload.service.ts:390` 直接调 `orchestrator.executeEventKey()`),不部署照样能传。它真正管的是**对账与捞回中途崩掉的存储操作**:内联兜底只覆盖「请求全程活着」,请求打到一半 API 重启 / OOM / COS 超时,那条操作就停在半路无人处置,孤儿对象与悬空记录静默累积。给出部署 / 不部署对照表,由维护者决定是否纳入首次上线。

- 补记三条现场实测事实(两份 runbook 都补):部署目录 **`/www/srvf`**(原文一字未提,维护者因此白跑过命令)、容器名 **`srvf-api`** / **`srvf-postgres`**、compose 文件位置。stage2 §1.5「切 production 新增两个必填变量」补上限定 —— 那是**相对第一阶段的增量**,不是必填项全集(全集 12 条,另 10 条在 smoke 阶段就已必填)。

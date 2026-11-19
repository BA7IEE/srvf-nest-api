# T36 草稿版本确认联测

**T35 的提审阻断在服务器隔离栈修复。** 同一套首发静态页面保留了用户确认时的 `expectedDraftHash`。两种模板均从页面创建、提审成功。无需指标的活动完成独立审核发布，发起人通过 App HTTP 接口提交的发布后变更已入库待审。必填指标活动停在审核页，固定前端无法完整展示冻结的指标集。公网仍运行旧后端，本次公网认证后业务验收为 **NOT_RUN**。

## 验收矩阵

以下 HTTP 的斜线后为业务码。两个账号的数据库角色均为应用 USER。发起人持有本组织的创建权限，另一人按预置审核职责绑定同一组织。创建前活动级绑定为 0。脚本从部署静态目录启动 Chromium，真实输入、点击和勾选确认。#1416 使用正常登录后的 App 接口。

| 场景与身份 | 结果与退出码 | 读回或定位 |
|---|---|---|
| 发起人和独立审核人页面登录 | PASS，分别 200/0 | 浏览器独立上下文，两人 /me 和有效权限均 200/0 |
| 无需指标，发起人选择组织、模板、场次创建，核对后提交 | PASS，201/0 → 200/0；同流程错误摘要 409/20255；全程 exit 0 | 提审 reqId `cmwnn2lg965b8d0076006cd77d06a0e47` 与审计一致。拦截用格式合法但不匹配的摘要；本次服务器浏览器未模拟两人并发修改 |
| 无需指标，独立审核人确认发布 | PASS，页面 200/0，exit 0 | reqId `cmwnn2n8xbe6e2d3c836b3bca799ae2f7`；活动 published，initial approved，审核人和发起人不同。库内仅出现一条活动级 owner，由发布流程产生 |
| #1416 发布后提交变更 | PASS，独立审核人尝试同一活动 403/30100；发起人 200/0，exit 0 | 后者 reqId `cmwnn2nkyf35651e33e5460dc1a5b150e`；DB 只有一条 version 2 的 change/pending。独立 App 页面提交、跨活动与其他 #1416 分支 NOT_RUN |
| 必填指标，有效版本指针，发起人建草稿并提审 | PASS，201/0 → 200/0；错误摘要 409/20255 | 实际创建启用的布尔指标、指标集 v1 和指向它的 V3 模板。DB 核实选择修订 1、指针与启用版本摘要一致。提审 reqId `cmwnn6r40c94fbcf7861f61026300adad`。连续登录曾触发 429/42900，首次创建后的脚本 exit 1，等待后复用同一草稿 |
| 必填指标，独立审核人页面发布 | **BLOCKED**；读取详情 200/0。点击断言 exit 1，批准 HTTP 未发出 | 固定前端把 `metricSetPointer` 定义为仅支持空值，冻结的 base 和目标都包含真实指针，按钮 disabled。DB 为 draft、initial pending、审核人空。没有改按钮或改走批准 API。该活动的 #1416 NOT_RUN |
| 未配置指标 | NOT_RUN | 本批固定的两个首发模板均有明确选择；此状态不能由上述两行外推 |
| 通知 Worker | PASS，两条站内意图各尝试一次，均由 pending 到 succeeded，停止 exit 0 | `notification.system-broadcast` 与 `notification.targeted` 各 1 条；Worker 与 API 镜像相同。三个外发配置均关闭，网络为 internal，供应商投递 NOT_RUN；没有活动批任务结果断言 |
| 公网 dp | 正式 live、ready 均 200，curl exit 0；认证后的公网闭环 NOT_RUN | 现场 API revision 仍是 108feebb，责任制 true、控制面 off、V1.1 false，可用 V3 模板数与创建权限目录数均为 0。未将隔离镜像发布到公网 |

固定前端把非空指标指针标为“含未支持的专业内容，未完整展开”。此场景要从页面发布，审核页面须先能按冻结指针核对所引用的指标集及其版本，保留不完整即拒绝的保护。旧页面同批的系统字典只读请求出现 403/30100，未阻断无需指标的活动。[固定前端处理代码](https://github.com/BA7IEE/srvf-admin-web/blob/b7f3dac00a860e32c0cbc220f29da0755bce024b/src/views/srvf/workbench/publish-review/snapshot.ts#L171)

## 供串行独审及人工决定的六项材料

1. **固定版本。** 前端 release 为 `b7f3dac00a860e32c0cbc220f29da0755bce024b`，只读挂载实际 webroot，入口 JS SHA256 为 `28cd1e9ad7eb6c5ae7dc28d3c364b8f61671729c503ee8bfa228b3c5dc8b86fd`。后端从 `108feebb84b85c7e4955c5af8bbfc016702e4529` 回移到 `1f234b50b5614216429ec42433a1fffae636c27e`，镜像 ID `sha256:761afa14c526f18c466de26a50ded7a73ed204e26a1a3620d48b7b5751e54912`。已更新 Draft #1444，待审 head `629956260a44acf3a40a6dc7ab26728583b05140`。两提交的 src 树完全相同，Prisma、锁文件、相关测试 git diff exit 0。[隔离源码](https://github.com/BA7IEE/srvf-nest-api/tree/1f234b50b5614216429ec42433a1fffae636c27e) · [待审提交](https://github.com/BA7IEE/srvf-nest-api/commit/629956260a44acf3a40a6dc7ab26728583b05140)
2. **实际改动。** #1404 的 base 为 `5816f06df04443e545cb5fc6ea587d3c5456e911`，head 为 `53d2de0d9d26341a9605fdb002a3fcab5fd7143e`。该 head 的迁移目录树为 `4565f39b00499a6819f2b8c7102ba60b87bfc4d6`，运行版、回移与 #1444 都是 `9010ebb00fd38a493f6d122063dd7492031d8cb5`。回移涉及六个运行文件，包含 DTO、错误码、Simple 提审、事务、冻结内容核对及控制器契约，另有测试与生成的交接产物。新请求在 Activity 锁内读回草稿算摘要，在写审核记录前核对实际冻结内容。携带摘要时纳入幂等判断；旧客户端不带字段仍保留原行为。未加入迁移、权限变更或工作流变更。完整清单见 `backport-files.txt`。[实际 diff](https://github.com/BA7IEE/srvf-nest-api/commit/1f234b50b5614216429ec42433a1fffae636c27e)
3. **开发验证。** 冻结依赖安装、Prisma 生成、Nest 构建、49 项定向单测、冷 lint、typecheck 和三项契约产物校验通过。typecheck 默认堆曾耗尽，适当增加本进程堆后 exit 0。文档检查重用本次 Prisma 引擎缓存后 exit 0。本地 Jest 契约套件 globalSetup 因缺少测试库清单 exit 1；预备独立容器时发现仓库约定的容器名已被占用，预检 exit 2，未动已有容器，本地定向 E2E 未发起。实机浏览器、SQL、Worker 均独立取证。详见 `commands.tsv`、`db-final.log`、`worker.log`。
4. **审核状态。** 独审应针对 #1444 的上述完整 head 和本次隔离证据串行进行。本批未执行独审。GitHub trusted scan 和汇总检查成功，单独的 trusted approval 作业为 SKIPPED，无本次人工审批记录。合并、候选部署、路由切换均未执行。取证时 Golden journeys、镜像构建、Diff guards 已绿；Fast checks、Authenticated Human V3 和五个 Contract + E2E 分片仍在运行。各 CI 作业快照见 `ci.json`。[CI 运行](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44543534151)
5. **影响范围。** 私有 Docker 网络、无发布端口、独立 PG、156 项迁移，API 和 Worker 均使用同一隔离非所有者角色。实验库使用 T29c 权限副本，含 B130；共享候选新 GRANT=0。隔离责任制 true、shadow、V1.1 false。创建角色仅含组织内 `activity.create.record`，审核角色使用种子目录定义的组织范围。必填指标的前端发布限制仍成立。公网缺修复和同等装配，独立环境的结果无法证明公网可用。
6. **回退与退役。** 公网原镜像 `sha256:1eb4e3ca321b141bca0c9c032e919f8665179f843dc623349fcd765ee6c89ffb` 仍在运行。将来若另行批准部署，应用版本回退不涉及 schema；已写入的审核、审计及通知须保留，旧镜像会恢复 T35 的提审不兼容。此次仅退役内部环境，停止 Worker 后待处理意图为 0。已在 srvf 限权目录保存合成审计导出，SHA256 `4454f7cfea4ffa18a1cba3a3dc586845ef045f4a42e671961d593d18fb0b8175`；四个临时容器、tmpfs 库、私网及生成的凭据文件已回收，exit 0。公网切换和在线回滚演练均 NOT_RUN。

宿主登录经 ChatGPT，SSH 使用 BatchMode 和严格 host key 核验。Mac JXA 按名称定位失败（-2700），按应用路径能识别 bundle，但在当前沙箱观察为未运行；页面证据来自 srvf 的 Chromium。公网健康探针已按源码路由 `/api/system/v1/health/{live,ready}` 核正，先前尝试的非契约短路径返回 404。

同目录的 `not-required.log`、`required.log`、`required-resume.log`、`required-retry.log` 与 `db-final.log` 可用请求 ID 交叉核对。Worker 结果不含消息正文。负责人变更待审通过 HTTP 验证，页面变更与变更审核通过不在本次成功范围。

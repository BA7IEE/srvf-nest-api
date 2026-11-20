# T47 同源 H5 与活动发布组合验收

在服务器的一次性隔离栈上，管理端页面发布的同一场训练，被零业务角色绑定的队员通过真实 H5 页面报名并扫码签到。在最终 15m/90d 配置下，第二名零绑定队员也从页面完整走通，分别产生一条本人报名和一个本人签到事件，两次写入均可按请求号关联到审计。无保险队员收到 409/26030。设备为服务器桌面 Chromium，采用 390×844 视口和页面的本地二维码图片入口。

## 合并基线

| 仓库 | 本次实际组合 | 差额及合并前提 |
| --- | --- | --- |
| 后端 | main `2b3eee0a954ea65abaef3edb35fd391eaa1567e9`、Cookie #1439 `479594029d46bb9ab0e00e01411368830e2e6a24`、活动 #1444 `713d3416830d897852929731ff7f9b638038ab7c` → 本地组合 `95aa0cfd8faa09c118f5c5e3870061dfd9be86a8` → Draft #1445 `dd62ce308f9142e8b3be04e9c4d52f548c0ebb17` | #1439 从 108feebb 分出，#1444 基于本轮 main。三次祖先检查 exit 0。两条开发线重叠 17 个文件，集中在接口文档、生成客户端、契约和快照。实际冲突由组合代码重新生成。#1445 以 main 为目标，已经包含两条历史。 |
| 管理端 | main `b12093c67fdd5d7b5650dcaf15b6783984e4075a` 与 #172 `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` | 本地合并演练 `75d23f365fcf1f94093e9ff0f9f63fa6c58178b5`，相对 #172 只多 README。实跑复用 #172 已构建的静态文件，逐文件校验清单成功。 |
| 队员 H5 | main `009976a22cce757ee13d48983764c1f5b6c07764` → #3 `ce14f84b5add85de11816136a0ef975a28ff7b7e` → #4 `5e5be8dc11daf86781cf648c8c35572b3e79df60` → Draft #5 `529ee3a3c441eaaf992049cbbe6ee32f1414fa63` | GitHub compare 确认各前驱均为祖先。#4 指向 #3 的分支，#5 指向 #4 的分支。按此顺序纳入 main；若维护者 squash 或改写基线，重新核最终差额与原生 CI。#5 相对 #4 变更 12 个文件。 |

[后端组合 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1445) · [H5 组合 PR](https://github.com/BA7IEE/SRVFMobileWeb/pull/5) · [管理端 PR](https://github.com/BA7IEE/srvf-admin-web/pull/172) · [Cookie 实现](https://github.com/BA7IEE/srvf-nest-api/pull/1439) · [活动修复](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [H5 基线](https://github.com/BA7IEE/SRVFMobileWeb/pull/3) · [H5 Cookie](https://github.com/BA7IEE/SRVFMobileWeb/pull/4)

## 现场发现与修复

1. 页面一直将需保险视为资格未知，将场次定位视为未知。组合后端沿活动详情原有可见性，使用服务端解析的本人身份与现有保险规则。新预检只返回 `required`、`eligible`。详情公开场次定位要求，报名写入仍在事务内重检。本次有保险正例使用合成团险，沿测试环境兼容规则（严格保险开关默认 false）。
2. 这些字段接好后，模板活动仍无法从 H5 报名。现场该活动已发布、允许公开报名，`registrationModeCode` 为空。旧 H5 只认 `open_apply`。详情现在通过写路径同一个 `ActivityParticipationPolicy.canRegisterSelf` 计算 `publicRegistrationOpen`；H5 对缺字段保守关闭。另有契约用例覆盖模式为空时两个布尔分支。
3. Access 仅在内存，Refresh 继续由 #1439 的安全 Cookie 和原服务端 family 管理。H5 取消 Web Storage，IndexedDB 仅保存一个状态和随机代际。Web Locks 串行轮换，BroadcastChannel 通知旧标签退出，每次业务请求前后核对代际。浏览器业务回归中显式禁止读写两种 Web Storage；扫码、报名和跨标签退出正常。
4. 管理端发布发生在组合中间版本 `137518b0627e88b20ad70d5925d2f6b52f08b115`。最终构建只改变队员活动详情 service 和 DTO 两份运行时 JS。发布、审核和认证的编译文件均一致。后续 H5 使用最终产物和同一条已发布记录。原试验时间误用 UTC 导致第一份草稿结束时间已过，页面正确禁提；按北京时间重新创建，保留了原草稿。

## 验收矩阵

| 场景 | 隔离实测 | 可核对结果 |
| --- | --- | --- |
| 反代信任与 HTTPS | PASS | H5 与 /api 同源，后端仅信任本次网关 /32。直连 HTTP 与另一 Origin 均 403/40300，同源 HTTPS 200/0，响应均 no-store。第一次驱动误用了业务判权码 30100，校正为通用禁止码 40300 后 exit 0。 |
| H5 登录、刷新恢复、轮换 | PASS | 正常登录及刷新已走 #1439。DB 轮换行具备替代关系，继承绝对到期时间。前端无法观察到 HttpOnly refresh Cookie。 |
| Refresh 90 天绝对期限 | PASS（校准后新建 family） | 首轮隔离装配沿用了 7d，报名和签到写入发生在该设置下。发现后，仅在一次性 API 改为 15m/90d。同一构建先正常登录、轮换并读回原记录，再用一名新建的零绑定队员从头完成报名和签到。该队员只建一个 90 天 family，两次轮换未延长绝对期限。原有 16 个 7 天 family 未被延长。 |
| 15 分钟 Access 自然到期 | PASS | 使用实际 15m 配置，浏览器等到期限后续期 200，再取本人身份 200。未调整时钟，也未缩短令牌有效期。 |
| 本人退出与其他标签 | PASS | 一个标签正常退出，两个标签均回到登录页，再加载仍需登录。 |
| 双标签并发恢复、换账号 | PASS | 两标签同时恢复各得 200，退出均回登录页。第二个身份登录后，旧标签仍留在登录页，新账号的本人报名数为 0。 |
| 本人改密与另一独立会话 | PASS | 真实页面改密 200/0，另一浏览器上下文 refresh 得到 401/10007。 |
| 同一活动的普通发起人、独立审核人 | PASS | Simple 创建 201/0，提交携带页面确认的 expectedDraftHash 200/0，另一主体发布 200/0。发起人没有手工预绑 owner。 |
| 有保险的普通 USER 报名 | PASS | 页面选择场次和岗位后，201/0。最终 90d 请求 `cmwofny7i152d96eaa6da211745484013`，初次请求 `cmwof3wu6eca77d80a7a10c21a233070a`。本人详情 200/0，数据库一条本人报名，提交与流转审计均关联同一请求。 |
| 无保险、他人数据与后台边界 | PASS | 同一活动的无保险队员看到禁用入口，提交端亦拒绝 409/26030。他人报名 404/21001，管理用户列表 403/30100。 |
| 场次定位策略、真实二维码 | PASS（无需定位） | 页面明确显示无需定位。负责人正常签发并渲染二维码，队员从 H5 选择图片，页面解码、二次确认、提交 201/0。最终 90d 请求 `cmwofnzad874d08ee89a5f6c822ccc7df`，初次请求 `cmwof3xrj66ac956b4f35c20fe8a00a55`。本人状态 200，DB 有一条 self_qr 签到和一条开放时段；审计同时匹配请求、主体和事件。二维码已撤销 200。 |
| 需要设备定位的正例 | NOT_RUN | 当前 Simple 模板合同主动拒绝 locationRequired=true，直至支持模板坐标。前端解析 true、false、旧版缺字段已有契约测试。实际手机定位、相机取景、微信 WebView 均未验证。 |
| Worker | PASS（站内） | 组合构建在内部网络分两轮处理 1 条系统广播和 3 条定向站内意图，四条均完成，Worker 正常退出 0。外部供应商投递 NOT_RUN。 |
| 公网 H5、正式开放 | NOT_RUN | dp 入口与 ready TLS 校验均通过、HTTP 200。既有 API 基础镜像仍为 1eb4e3ca，可信代理仍为 none。公网登录、报名、签到未发起。 |

USB 枚举成功，未识别到手机。Xcode 的 xcdevice 正常返回，可用物理 iOS 设备为 0；CoreDeviceService 的 XPC 连接被系统中止，adb 与 idevice_id 均未安装。没有可通过现有授权通道实际操作的手机或微信。

## 检查与部署决定

1. **改动**。组合 PR 沿已有两条主线合并，增加本人保险预检、场次定位和活动公开报名判定；移动 PR 消费实际布尔值，同时保留所有服务端写入校验。精确文件清单见 graph.json。
2. **红区**。#1439 原 SHA 的 trusted approval 已 SUCCESS。#1444 当前 SHA 的 approval 为 SKIPPED，沿原 REQUIRED=false。#1445 相对 main 包含受保护的鉴权改动，须按它自己的 SHA 复审和查看人工检查。原 PR 的批准不能转移。[#1439 审批](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44339867727/job/134926691326) · [#1445 审批](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44667827144/job/136061481394)
3. **DB 与业务影响**。组合增量没有 migration 或共享授权。测试 API 以非所有者身份访问一次性 PG 的 156 项迁移；报名、考勤和 Worker 使用仅在该 PG 装配的试验权限。普通报名队员的业务角色绑定数为 0。共享候选新增 GRANT 为 0。
4. **验证与独审**。实际浏览器、请求号、数据库和 Worker 证据分别留档。T46 已测且本轮服务端 auth 实现一致的禁用与重放列为复用；未逐项重新触发。两项新 SHA 交给串行独立复审。[原 P0-E 验收](https://github.com/BA7IEE/srvf-nest-api/tree/6bfc12203ef09cef5bd0474da425dfab90dfdde6/docs/ops/runtime-acl/t46)
5. **可逆部署条件**。保存旧网关配置摘要、旧 API 镜像和旧静态清单，配对核新制品与真实 TLS 代理来源。先校验有效 Access 15m 和 Refresh 90d，并安排旧标签退出。新栈先通过同源恢复和非所有者报名校验，再由获批流程承接流量。恢复旧制品时同步恢复 H5 静态和 API、核入口/ready；已发生的报名、时段和审计须保留。实际遇到隔离 API 替换后反代缓存旧上游，曾返回 502；仅在试验网关测试配置并 reload，随后 ready 200。正式实施前应验证 DNS 刷新和回退后的真实请求。
6. **建议**。先独审两个最终 SHA，再由维护者处理仓库合并。公网代理、共享库能力和手机实机须单独验证。隔离结果不能作为批准 B130、切流或向真人开放的依据。

## 执行口径

- `gh pr view`、`gh api .../compare`、`git merge-base` 固定上游与包含关系，`pnpm docs:refresh` 生成组合契约。使用 Jest 的 snapshot serializer 重算两段 OpenAPI，先逐字节证明原组合快照一致，再审阅新增字段与路由。
- 首次本地 Jest 因缺测试库范围在触库前停止。自建本机 PG 被沙箱拒绝共享内存，远端隔离 specs 尝试仍受项目本机 Docker 校验约束，两个命令 exit 1。保留校验，正式测试以原生 CI 为准。已在该 SHA 的原生日志中逐名核到 OpenAPI、app-activities-detail 和 auth-h5-session 三个 spec 均 PASS。本地 typecheck 初次 heap 不足，增加 Node 内存后通过。
- `pnpm build`、`pnpm build:h5`、H5 契约测试 62 项均成功。组合中间版冷 lint 为零错误。T47 业务驱动从受限挂载读取新建夹具，通过正常登录取得会话；证据只保留状态、业务码、计数和请求号。未录制请求头、屏幕或凭证。
- 制品以一次性网关内两个 HTTPS 主机名提供，Chromium 临时信任实验 CA。基础容器只读挂载本次 dist。provenance.json 可重算完整压缩包和现场关键文件 SHA256，runtime-delta.json 列出两次组合构建的实际 JS 差异。

## 固定 SHA 原生 CI 与退役

- BA7IEE/srvf-nest-api，后端 dd62ce308f9142e8b3be04e9c4d52f548c0ebb17。SUCCESS 13 项，WAITING 1 项。[Fast checks](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44667832786/job/136061580693) [Contract + E2E (1)](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44667832786/job/136061580686)
- BA7IEE/SRVFMobileWeb，移动端 529ee3a3c441eaaf992049cbbe6ee32f1414fa63。SUCCESS 2 项。[check](https://github.com/BA7IEE/SRVFMobileWeb/actions/runs/44667834661/job/136061383971) [check](https://github.com/BA7IEE/SRVFMobileWeb/actions/runs/44667827714/job/136061362132)

站内待处理和在途意图均归零。停止测试 API 后保存脱敏审计投影与逐行摘要，随后移除本次 8 个一次性容器、内部网络和本次生成的登录文件与私钥。原候选服务未参与退役。

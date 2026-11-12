# SRVF 测试验收总入口（2026-11-12 整合快照）

本页统一记录可公开的测试结论、证据限制与接手事项。后续只在本仓库维护测试结论入口，不另建档案库、不复制多套覆盖统计。历史材料不删除、不改写；本页不取代 [当前状态](../current-state.md)、各业务设计合同或已冻结的验收记录。

**阶段结论：完整业务与普通账号 UX 验收尚未完成，没有上线通过结论。** 本次是材料整合，不是新一轮 HTTP、数据库或 GUI 执行。以下保留各自记录日期，不把历史结果当当前部署结果。

## 1. 统计口径和版本

- `LOCAL/CI`、`DEPLOYED_HTTP`、`GUI` 分开；一次 HTTP 200、空列表、拒绝响应或单元测试通过均不等于完整业务验收。
- 本次整合读取的源码 main 为 `fcf4e5d5802c42a1503b205751f737e3badd6ffc`，不是部署身份声明。
- 11 月 12 日接口盘点记录为 673 个方法＋路径、114 个第一标签分组；源码 main 的生成计数为 672。两者对应不同材料与版本范围，不修改生成计数去凑一致。接口契约仍以 [前后端交接层](../handoff/README.md) 及对应版本快照为准。
- 11 月 12 日 16:21（北京时间）那轮记录：37 个方法有认证请求观察；历史及该轮去重并集为 303 个方法。303 包含历史索引和手工转录，不是 303 项已独立复核或通过。
- 该轮“正向与适用权限均完成”的接口数为 0；其整体验收状态为 0 PASS、0 FAIL、1 BLOCKED、672 NOT_RUN。这里的 NOT_RUN 是完整验收未完成，不表示从未发过请求；0 FAIL 也不表示没有历史错误或 UI 问题。
- 该轮运行中的精确后端提交仍为 UNKNOWN。历史构建材料支持候选源码树关联，不构成运行时精确提交的独立证明。不得把 OpenAPI 一致或同一镜像关联自动写成精确版本已验证。

## 2. 已有公开源码与 CI 证据

以链接中的具体提交、条件和运行结果为准。局部通过与整体失败同时保留，不将不同候选或不同运行相加。

| 主题 | 已有记录 | 未完成/限制 |
| --- | --- | --- |
| 更正与角色检查 | [PR #1403](https://github.com/BA7IEE/srvf-nest-api/pull/1403) | 定向测试不替代部署验收 |
| 草稿提交与镜像解析 | [PR #1404](https://github.com/BA7IEE/srvf-nest-api/pull/1404) | 按 PR 记录核对可信审批及候选状态 |
| 审核范围政策读取 | [PR #1405](https://github.com/BA7IEE/srvf-nest-api/pull/1405) | CI 与隔离样本不代表当前真实站全部通过 |
| 候选镜像留存 | [PR #1406](https://github.com/BA7IEE/srvf-nest-api/pull/1406) | 不代表已部署；历史 artifact 可用性须重新核实 |
| 活动详情候选修复 | [PR #1407](https://github.com/BA7IEE/srvf-nest-api/pull/1407) | 不能由另一对象的 200 认定历史故障修复 |
| 考勤单轨方向 | [PR #1409](https://github.com/BA7IEE/srvf-nest-api/pull/1409) | 文档方向不等于旧路径已清理 |
| 当前参与日计数 | [PR #1410](https://github.com/BA7IEE/srvf-nest-api/pull/1410) | 定向数据库结果通过；整体 CI 曾失败，不能标全绿 |
| 当前结算反馈率 | [PR #1411](https://github.com/BA7IEE/srvf-nest-api/pull/1411) | 隔离 HTTP/数据库通过不代替实际部署开关验收；整体门禁未完成 |
| 打卡更正链 | [PR #1412](https://github.com/BA7IEE/srvf-nest-api/pull/1412) | 合成深链不是公开 API 已复现；整体 CI 有失败 |

以上 PR 在本次核查时均为 draft、未合并。后续以 GitHub 最新状态为准。历史 nightly 及不同运行中的失败仍按各 PR 记录保留，不因其他运行成功自动关闭。

## 3. 真实部署观察的有限结论

来源为执行记录整理，不是本次重新发送请求。角色以合成普通角色或管理员描述，不保存登录名称、具体对象标识、凭据、个人资料或管理入口。

| 日期/领域 | 已观察结果 | 尚不能证明 |
| --- | --- | --- |
| 11 月 10 日成员/组织读取 | 52 次请求包含 44 GET、4 登录、4 登出；分页与参数边界有有限成功样本，部分资源拒绝 | 跨组织全面隔离、写入链、导出脱敏、GUI |
| 11 月 10 日活动读取 | 25 次请求中 17 个认证 GET 有 16 次 200、1 次活动详情 500；另有列表筛选样本 | 整个活动模块正常、历史错误已修复 |
| 11 月 11 日无规则活动详情回归 | 同一合成活动详情 200，活动/场次/岗位资格结果一致；该轮共 4 次 HTTP | 有规则命中/不命中、非空快照、其他角色、并发、全局零写入 |
| 11 月 11 日合成成员昵称往返 | 两次修改 200，分别回读确认，最终恢复原昵称；该轮 9 次 HTTP | 全字段 CRUD、完整数据库回滚、所有审计源均覆盖 |
| 公告创建与编辑回报 | 创建 201、列表/详情 200；编辑 200 且回读一致 | 本条是较早执行回报，不作为当前发布/撤回链通过；后续结果须单独引用 |
| 较早公告发布失败回报 | 发布返回 503，回报中草稿状态保留；创建/编辑成功没有消除该失败 | 不据较早回报断言当前仍失败或已修复；缺同条件最新完整链证据 |
| 11 月 12 日普通角色读取 | 本人合成成员和报名详情有 200，对方样本有拒绝/隐藏响应；分页负例有 400 | 所有组织、角色、对象及业务状态隔离通过 |
| 11 月 12 日公开公示读取 | 200 且名单为空 | 非空公示业务、认证接口覆盖 |
| 11 月 12 日独立草稿/岗位材料 | 提供材料记录创建、读回、修改及软删；首次目标识别不确定时停止后再核实 | 本次重新执行、所有角色、发布与通知链通过 |

历史索引含 17 个方法出现 500；它们不是 17 个已确认独立根因。部分后续不存在样本返回 404，不能据此关闭原故障。有限审计检索没有命中，不证明全系统没有审计；也不能未经合同核对就判为审计缺陷。

## 4. UX 与发布准备分开验收

- 11 月 12 日页面记录：窄视口活动列表固定操作列遮挡内容；组织成员抽屉出现 `undefined`。这是 GUI 观察，不计作接口 FAIL。
- 前端 [PR #168](https://github.com/BA7IEE/srvf-admin-web/pull/168) 与 [PR #169](https://github.com/BA7IEE/srvf-admin-web/pull/169) 在来源记录中已合并；[候选 CI](https://github.com/BA7IEE/srvf-admin-web/actions/runs/43174935147) 已成功。来源记录截至 11 月 12 日 19:18（北京时间）仍未部署，不能据此推断之后的实际部署状态。
- 同日材料记录 305 项旧版公开资源与历史清单字节一致；新候选构建 307 文件完成清单核验。固定资源比较和隔离目录的原子替换试验不证明真实站点切换、浏览器缓存或线上回滚已验收。
- 普通业务角色需实际完成活动主流程。验收应覆盖 1366×768、1440×900、1920×1080、缩放及窄视口；两条报名均可见，末行及操作按钮可达，长文本/多记录可用，键盘焦点清晰，错误与零数据可区分，刷新再进入后可继续。

## 5. 网络对照不能替代 API 性能验收

本项为两端执行回报，非同时实验，也不是本次重新实测：云端首批 5 并发共 5 次 200，6.08–6.70 秒；次批 5 次连接超时，其中 3 次 CONNECT 完成而 TLS 未完成、2 次 CONNECT 未完成。用户设备 5 并发共 20 次均 200，73–132 毫秒。

请求目标是首页，不是业务 API。有限入口日志未找到其中 3 次超时的对应请求，健康检查正常。这些观察只能提示网络路径表现不同，根因仍 UNKNOWN；不能断言服务器性能正常/异常、API 容量通过或所有失败都未到达上游。

## 6. 接手后优先补齐

1. 为每轮固定源码、部署版本、角色类别、条件、时间与证据等级。无法证明的版本保持 UNKNOWN。
2. 对历史失败按同角色、同条件、同对象前提复核；不同样本的成功不替代原故障回归。权限拒绝后的下一步须先核实授权边界，不靠换角色/路径继续。
3. 完成活动、报名、考勤、结算、公告、保险与附件的非空业务闭环和独立读回。空表、一次保存或某一字段往返不能销整个模块。
4. 补普通账号 GUI、错误态、可达性和保存后连续工作验收。
5. 迁移、备份恢复、发布回滚及外部依赖各自取得证据；不由 CI、健康检查或首页并发代替。
6. 更新本页时保留历史失败与证据日期，链接同仓库的修复 PR/回归记录。不要把同一轮的请求、断言、方法数、模块数混作通过率。

## 7. 材料整合与可复核性

本轮对原有 28 个文件逐一核对了元数据和分组，27 个正文可读取；大 OpenAPI 文件的接口读取仅返回元数据，未声称逐字核验全文。旧材料包含部署细节和运行记录，未原样搬运。本页按下列分组消除重复：

- 总结与统计：原 README、decision-report、endpoints、module-coverage，统一到 §1–3；保留时间与口径，不叠加重复方法。
- 匿名/公开读取、历史转录、普通角色各批回执：统一到 §3，仅保留有限样本结论；不复制账号、请求标识与对象数据。
- 历史错误及拒绝范围：合并到 §3、§6；原失败不覆盖，不推断根因。
- UI 与构建/部署准备、资源清单、隔离试验：合并到 §4，保留“未部署/非线上验收”的时间限定。
- 原 OpenAPI：使用本仓既有契约入口，不建立第二份可能漂移的全文。

本页是可公开结论与接手入口，不是原始逐请求证据的无损迁移。未公开的原始材料不因本页存在就视为已全部入库；缺少原始回执时必须继续标明证据限制。当前状态与冻结合同以本仓既有权威文档为准，不据本摘要擅自改变发布边界。

## 本次未做

没有新跑业务 HTTP/GUI、压力测试、迁移或数据库操作；没有合并 PR、部署、修改权限、改变仓库可见性、删除历史仓库或发布凭据。本次只整合可公开测试结论，不能增加完整验收通过数。

## 8. 2026-11-13 增量测试（进行中）

本节独立记录本次实际执行；上文“本次未做”属于 11 月 12 日整合快照。测试目标为 `https://dp.srvf.team`，以下时间均为北京时间。隔离工作树基于仓库 main `6453ae5c374e224079d24e4fad818e9798ddf297`；**实际线上 API 与后台的精确部署提交均为 UNKNOWN**。OpenAPI 版本号、路由集合或静态文件哈希均不能单独证明提交身份。

### 8.1 当前判断及阻塞

- **上线结论：NO-GO。** 活动、报名、考勤、结算、公告、保险和附件的非空业务闭环与普通业务账号 UX 尚无本轮完整通过证据；历史安全及上线门禁不因本轮可访问而解除。
- 线上 OpenAPI 为 673 个唯一的 HTTP 方法＋路径，与 11 月 12 日历史清单的 673 项集合相同。历史清单对完整验收记为 0 PASS、0 FAIL、1 BLOCKED、672 NOT_RUN；本节的单点匿名观察和 GUI 失败不改变该接口完整验收统计。
- 源码 main 合同为 672 项；线上多出的唯一方法是 `GET /api/admin/v1/activity-publish-reviews/{id}/referenced-policies`。[PR #1405](https://github.com/BA7IEE/srvf-nest-api/pull/1405) 的候选合同集合与线上 673 项一致，但该 PR 当次检查仍为 draft/open。**集合一致不证明部署了该 PR。**
- 历史测试凭据文件已不存在，尚未确认独立普通队员、管理员、一审和终审账号可供本轮使用。考勤审核和结算源码存在通知 intent；线上通知配置与接收范围尚未证实。账户或外发条件不清时，相关写操作记 BLOCKED，不用同一账号冒充多个角色。
- 按本地源码基线 `fcf4e5d` 的角色和服务实现，一审、终审和提交主体存在分离要求；这是 **LOCAL** 观察，不能推断线上具体配置及执行结果。

### 8.2 本轮逐请求观察

以下仅为 **DEPLOYED_HTTP** 有限样本，不能把返回 200、404 或符合预期的 401 等同于整个业务通过。请求 ID 标为“客户端指定”时仅表示服务端回显，不能据此宣称生成方式。

| 时间 | 方法及实际目标 | 角色 | 响应摘要 | 请求 ID |
| --- | --- | --- | --- | --- |
| 02:15:30 | `GET https://dp.srvf.team/api/docs-json` | 匿名 | 200；OpenAPI 3.0.0，文档版本 0.72.0，673 个方法＋路径 | `cmwdvbxdaaad4727973b154e1fb3868be` |
| 02:18:01.108 | `GET https://dp.srvf.team/api/admin/v1/attendance-sheets?page=1&pageSize=2` | 匿名 | 401 / 40100；未登录或登录已失效，data 为 null | `cmwdvf6ohc0af398694a9dee036687b64` |
| 02:18:01.199 | `GET https://dp.srvf.team/api/admin/v1/attendance-settlements?page=1&pageSize=2` | 匿名 | 401 / 40100；未登录或登录已失效，data 为 null | `cmwdvf6qb851ffbd217b01e30cc7d7dc8` |
| 02:18:01.264 | `GET https://dp.srvf.team/api/admin/v1/organizations?page=1&pageSize=2` | 匿名 | 401 / 40100；未登录或登录已失效，data 为 null | `cmwdvf6sdfa027e7108d5c0691d3f26a3` |
| 02:18:45.689 | `GET https://dp.srvf.team/api/open/v1/contents` | 匿名 | 200 / code 0；JSON 空列表 | `srvf-qa-content-20261113-content-list`（客户端指定并回显） |
| 02:18:45.837 | `GET https://dp.srvf.team/api/open/v1/contents/srvf-qa-content-20261113-nonexistent` | 匿名 | 404 / 29001；JSON“内容不存在” | `srvf-qa-content-20261113-content-absent-detail`（客户端指定并回显） |
| 02:21:54 | `GET https://dp.srvf.team/` | 匿名 | 200；入口 HTML SHA-256 `ae73cbd7964b002e705a9ce22c882fd2e5ec5a7f689ab510d21961b9ea3a1253` | 未提供 |
| 02:23:42 | `GET https://dp.srvf.team/api/docs-json` | 匿名 | 200；OpenAPI SHA-256 `c79d0aa5014badbf69f19ed3b9ad550f22ddcee597fa7a4d773b1394167256fd` | `cmwdvmhwk4ce684c6f18da12c2c0bdc08` |
| 02:25:04.313 | `POST https://dp.srvf.team/api/auth/v1/login` | 匿名，随机合成用户名及密码 | 401 / 10004；账号或密码错误；未独立证明该用户名不存在 | `cmwdvo94xf14f545eebdac34528b2f70b` |
| 02:25:04.518 | `POST https://dp.srvf.team/api/auth/v1/login` | 匿名，空 JSON | 400 / 40000；用户名和密码必填及格式校验 | `cmwdvo9aoca40b0c42525b4b38f913882` |
| 约 02:33 | `GET https://dp.srvf.team/api/admin/v1/activities/organization-options` | 测试超级管理员，未绑定成员 | 403 / 40300；无权限访问 | `cmwdvzhjt36ccc875da8b840233c9d746` |
| 02:39:30.779 | `GET https://dp.srvf.team/api/admin/v1/members?page=1&pageSize=10&q=<合成编号>`（查询值脱敏） | 测试超级管理员 | 200 / code 0，模糊搜索 total 0 | `cmwdw6top26f020f91a95c9c70e25f150` |
| 02:40:27.690 | `POST https://dp.srvf.team/api/admin/v1/members` | 测试超级管理员；后台表单、独立合成编号 | 400 / 40000；请求仅含 `memberNo`、`displayName`，响应提示 `displayName` 不应存在且缺少 `realName`、`memberSinceDate`、`memberOriginCode` | `cmwdw81k33eb1760b57b5ddf624fc0d95` |
| 02:40:48.562 | `GET https://dp.srvf.team/api/admin/v1/members?page=1&pageSize=10&q=<合成编号>`（查询值脱敏） | 测试超级管理员 | 200 / code 0，模糊搜索 total 0；当前搜索范围内未见创建记录，不证明所有软删状态 | `cmwdw8hpeac892c46a0a6d8bacf05a031` |
| 02:43:26.380 | `GET https://dp.srvf.team/static/js/members-CY-9N_sZ.js` | 匿名 | 200；10227 字节，SHA-256 `15e0b5b7d8ed9bc79a5f62a778f30f334d73bd9dca4c2751bf0da33e3e92152a` | 未提供 |
| 02:54:45.622 | `GET https://dp.srvf.team/api/system/v1/health` | 匿名 | 200 / code 0；JSON，数据含 status | `srvf-qa-20261113-404-health`（客户端指定并回显） |
| 02:54:45.722 | `GET https://dp.srvf.team/api/system/v1/health/live` | 匿名 | 200 / code 0；JSON，数据含 status | `srvf-qa-20261113-404-health-live`（客户端指定并回显） |
| 02:54:45.800 | `GET https://dp.srvf.team/api/system/v1/health/ready` | 匿名 | 200 / code 0；JSON，数据含 status、db | `srvf-qa-20261113-404-health-ready`（客户端指定并回显） |
| 02:54:45.884 | `GET https://dp.srvf.team/api/open/v1/recruitment/publicity` | 匿名 | 200 / code 0；JSON 空列表 | `srvf-qa-20261113-404-publicity`（客户端指定并回显） |
| 02:54:46.003 | `GET https://dp.srvf.team/api/open/v1/recruitment/certificate-standards` | 匿名 | 200 / code 0；JSON 空列表 | `srvf-qa-20261113-404-certificate-standards`（客户端指定并回显） |
| 02:54:46.096 | `GET https://dp.srvf.team/api/open/v1/contents?page=1&pageSize=1` | 匿名 | 200 / code 0；JSON 空列表 | `srvf-qa-20261113-404-contents-original-query`（客户端指定并回显） |
| 02:54:46.187 | `GET https://dp.srvf.team/` | 匿名 | 200；HTML SHA-256 `ae73cbd7964b002e705a9ce22c882fd2e5ec5a7f689ab510d21961b9ea3a1253` | 未提供 |
| 02:58:23.302 | `GET https://dp.srvf.team/api/admin/v1/members?page=1&pageSize=10&q=<合成编号>`（查询值脱敏） | 测试超级管理员 | 200 / code 0，total 0；GUI 显示“暂无数据” | `cmwdwv3fi338ce7e8de616f99b69c7376` |
| 02:58:53.963 | `GET https://dp.srvf.team/api/admin/v1/members?page=1&pageSize=10` | 测试超级管理员 | 200 / code 0，total 5；清空关键词后页面恢复列表 | `cmwdwvr40cdfdedb9b82fdadd83e499e3` |
| 约 03:00:49.891 | `GET https://dp.srvf.team/favicon.ico` | 同源对照标签 | 200；被测标签单独离线期间对照标签仍可连接 | 未提供 |
| 03:00:50.122 | `GET https://dp.srvf.team/api/admin/v1/members?page=1&pageSize=10&q=<网络测试合成编号>`（查询值脱敏） | 测试超级管理员，被测标签单独离线 | `net::ERR_INTERNET_DISCONNECTED`；未得到 HTTP 状态 | 未提供 |
| 03:00:59.974 | `GET https://dp.srvf.team/api/admin/v1/members?page=1&pageSize=10&q=<网络测试合成编号>`（查询值脱敏） | 测试超级管理员，恢复联网 | 200 / code 0，total 0 | `cmwdwygbn09e24ba5751fb2c6fc6271ce` |
| 03:01:11.642 | `GET https://dp.srvf.team/api/admin/v1/members?page=1&pageSize=10` | 测试超级管理员 | 200 / code 0，total 5；清空关键词恢复列表 | `cmwdwypbk423660c31438a3ea31dbb05d` |
| 03:03:21.578 | `GET https://dp.srvf.team/favicon.ico` | 收尾临时标签 | 200；浏览器联网复核 | 未提供 |

02:18 的两条公开内容样本可证明当次返回 JSON；本轮详情使用另一合成对象，不能视为历史详情的同对象复测。空列表也不能证明公告创建或发布链通过。

02:54 的六条历史匿名 GET 复核对齐了原方法、路径、查询和匿名角色，当前均返回 JSON 而非历史 HTML 404；请求头、数据状态及部署版本不能证明相同。这是六个有限样本，不关闭其余历史方法或业务验收。

历史 HTML 404 的 76 条回执所捕获响应体均为 2147 字节，SHA-256 均与原包同期首页及本轮首页一致；其中 49 条明确记录未截断，另 27 条没有截断标记，只能确认已捕获部分一致。这是响应字节对照，不能单独证明反向代理根因。

### 8.3 GUI、历史故障和证据缺口

- **GUI FAIL**：02:16，使用现有测试 bootstrap 管理员会话，在组织架构页 `/#/srvf/base-data/organizations` 重新加载后打开测试组织的成员抽屉，合成成员名称仍出现 `undefined`。[脱敏截图](evidence/20261113/organization-member-undefined.jpg) SHA-256 为 `41fb1e4db2901b40293b67703bc89a131146c2ca1862f1369c7fe08f8d0a7cf9`。这是管理员 GUI 观察，不代表普通账号完成验收。
- **GUI 部分观察**：测试超级管理员在 1366×768、1440×900、1920×1080 的浏览器模拟视口，以及约 110% 缩放下，均实际滚动到活动列表最后一条合成记录并点击“管理”进入详情；1440×900 下还用 Tab / Shift+Tab 在“管理”“编辑”间移动，观察到焦点框，并以 Enter 进入详情。末行裁剪证据：[1366](evidence/20261113/viewport-1366x768.jpg)、[1440 与焦点](evidence/20261113/viewport-1440x900.jpg)、[1920](evidence/20261113/viewport-1920x1080.jpg)、[110% 缩放](evidence/20261113/zoom-110-percent.jpg)；截图为合成数据局部，尺寸与操作取自当次记录，详情跳转的 HTTP 回执 **NOT_CAPTURED**。这是模拟视口和管理员样本，普通账号、长内容、多记录、空态及完整流程仍须分别验证。
- **GUI 空态有限样本**：测试超级管理员在队员列表按合成编号搜索，看到[“暂无数据”](evidence/20261113/member-empty-state.jpg)；清空关键词后列表恢复，两个请求的时间与 ID 见 §8.2。此结论限于该页面和角色，活动列表及普通账号空态仍为 NOT_RUN。
- **GUI 网络错误有限样本**：仅将一个测试标签离线后，队员列表显示[网络异常提示](evidence/20261113/member-network-error.jpg)，离线前的 5 条旧行仍保留；恢复联网可重新查询并返回列表。同源对照标签仍有 200，事件和请求 ID 见 §8.2；浏览器网络缓冲区存在截断，上述记录不代表完整网络历史。测试结束后已恢复视口、缩放和联网，保留原管理员会话。
- **GUI BLOCKED**：同一未绑定成员的超级管理员打开“筹备单场次活动”，组织选择提示“无权限访问”，模板不可选；实际请求与 403 回执见 §8.2。源码基线 `fcf4e5d` 的该选择入口要求调用人满足 App 成员准入，超级管理员不豁免；该拒绝与源码预期一致，不据此判接口缺陷。当前会话不能完成该流程，也不为凑前提绑定真实成员。
- **GUI 集成 FAIL**：后台“新建队员”表单一次提交的字段与线上接口合同不一致，实际返回 400；提交前后按合成编号模糊搜索均未见记录。确切请求时间、字段及三次请求 ID 见 §8.2；当次瞬时错误提示未截屏，保留网络回执，不为补截图重复写入。400 符合接口对该请求的校验，不单独判为后端接口 FAIL；该问题阻断通过当前后台准备队员，前端候选和用户并行适配情况待核对。
- **定位与待修**：当前队员页面 JS 资源实际包含 `memberNo`、`displayName` 和可选 `gradeCode` 的创建组包；前端 main `6375148a61445972e792ce37cb401fd8e5162538` 的 [`src/api/srvf-member.ts`](https://github.com/BA7IEE/srvf-admin-web/blob/6375148a61445972e792ce37cb401fd8e5162538/src/api/srvf-member.ts) 与 `src/views/srvf/members-domain/members/` 表单/组包仍使用旧字段。静态资源哈希和源码观察不能证明线上精确 commit；已合并的 PR #169 不覆盖该表单。用户并行后台工作涉及的具体文件仍 UNKNOWN，未在另一个分支重叠修改。建议创建时显式采集并提交线上合同要求的真实姓名、入队日期和来源，分别处理昵称与等级，不臆造字段；编辑按合同白名单提交，再以独立读取、空值和 GUI 同条件复测验证。
- [前端 PR #169](https://github.com/BA7IEE/srvf-admin-web/pull/169) 有对应候选；线上入口 HTML 与 11 月 12 日旧入口哈希一致，且与当时候选入口哈希 `531c5226e4e90446ebfc79f4f1e815599f9de1902c313f25ee011ff49c6ac840` 不同。该比较只覆盖入口文件，不证明全部资源、缓存或精确部署提交。
- 历史 17 个 500 的原回执已从 11 月 11 日原始包中逐条核验，方法、路径形状、状态、时间、角色别名和请求 ID 均与原索引一致。38 个历史 HTML 404 方法的 76 条原回执也已核对；其请求 ID 均未提供。原始值和对象 ID 不复制入仓库；服务端堆栈、请求后的全部副作用及精确部署提交仍未证明，原故障同条件复测仍为 NOT_RUN。
- 本轮通过现有登录会话取得 11 月 11 日原始证据包，SHA-256 `1005fda8ab38c976f5fa01fd16fd6c3898180b88253efec63f7450fe43dfc004`；包中疑似存在凭据和个人信息，保留在本机，不上传仓库。此前 11 月 12 日索引包缺少所指原回执，本轮已从另一原包补齐逐项核验，见 §8.5。
- 报告中的“公告创建 500”暂未找到对应原始请求、角色、请求体、时间、请求 ID 或当时部署版本；对 11 月 11 日原包限定检索，内容创建、通知创建及公告导入入口均未命中 500，但不能据此断言其他材料或入口不存在该故障。保持 **BLOCKED / 缺证**，不以另一条公告请求成功关闭。
- **LOCAL 副作用分析**：基线 `fcf4e5d` 的考勤审核与结算流程可产生定向站内通知；通知公告发布若选择微信或企业微信渠道可能异步外发，CMS 内容发布是另一条路径。线上通道配置和具体收件人仍为 UNKNOWN，因此未通过发布或审批触达真实用户。对历史 17 个请求 ID 在原包内查找服务端堆栈未命中；这不证明服务端不存在日志。
- 1Panel API 所需的 `ONEPANEL_BASE_URL` 和 `ONEPANEL_API_KEY` 未配置；现有浏览器面板会话仍可读。网站 `/api` 反代上游与测试 API 容器的运行地址一致；该容器显示健康，image ID 为 `sha256:01ea21257673d5f148bb997d8c0b87979cb3e48167f3e715f67e46c3ecd15e98`，这不等于镜像 revision 或源码 commit。只读日志视图选择全部时间、最多 1000 行，当前可见范围约为 11 月 12 日 15:40:36–18:27:51 UTC，早于 11 月 11 日两条本人资料与保险故障请求；没有匹配到旧 ID，错误类型仍为 UNKNOWN。这不证明更早日志不存在。
- 密码登录空 JSON 的 400 响应同时出现中文和英文校验信息；是否在后台页面造成不清晰反馈尚未进行 GUI 验证。
- **CI，非线上验收**：[本台账草稿 PR #1414 的 Authenticated Human V3](https://github.com/BA7IEE/srvf-nest-api/actions/runs/43280735665/job/131401066280) 在测试 PostgreSQL 容器创建阶段失败，Docker 报固定本地 image ID 不存在。现有 [draft PR #1404](https://github.com/BA7IEE/srvf-nest-api/pull/1404) 已修改同一 helper，使用固定镜像引用解析当前环境的 image ID；其 head `ea4a35792e3d107cebb975235821a21de9070b34` 的[对应 CI 作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/42335075080/job/128290080942)通过，但该候选尚未合并，也不能替代本 PR 当前失败结果。未并行改写已有候选的文件；具体镜像存储机制仍待确认。
- 草稿 PR #1414 的历史提交 `df10ddc385b590366a19a4a95b0679d1af90dd64` 对应上述运行中，五片 Contract + E2E、Fast checks 和 Golden journeys 通过；Authenticated Human V3 与总汇总失败。后续提交须看其自身检查，不能复用旧 SHA 的结果，也不能将 CI 样本等同于线上业务验收。

### 8.4 接下来

继续在既有权限内核实隔离账号、组织和通知边界；取得可辨认目标后按请求 ID 和时间只读核对历史错误；补普通账号与多审核人闭环、错误态和多视口操作。逐次写入后独立读回，结果不明先查询再决定是否重试。后台现有并行适配与未部署候选保持分离。

### 8.5 当前接口清单与历史逐项索引

本节接口清单来源：`GET https://dp.srvf.team/api/docs-json`，2026-11-13T02:27:05+08:00，HTTP 200，请求 ID `cmwdvqtx4ca4cbea94c3f52bb1f84b40e`；响应 SHA-256 `c79d0aa5014badbf69f19ed3b9ad550f22ddcee597fa7a4d773b1394167256fd`。按 HTTP 方法和路径严格去重，共 673 条，与 11 月 12 日 CSV 清单逐项集合相同。历史 CSV 的 SHA-256 为 `05a1e9fa1c2e7c1d73ebfcb9c3e90c5cfb87b8985375804c7091118b68137f13`；原文件位于本机历史工作目录 `srvf-api-https-dp-srvf-team/work/srvf-test-archive/2026-11-12/endpoints.csv`。CSV 行号可回查当时的角色、请求 ID 和证据文件；本节不复制用户名、凭据或原始业务响应。

历史观察分类为：`有限2xx`＝被收录材料里至少有一次 2xx 且 code 0；`公开/登录`＝需核对匿名样本；`仅非2xx`＝所收录材料有观察但没有 2xx/code 0；`未见认证`＝所收录材料未见 bearer 观察。这些都不是验收通过。`上轮认证` 仅代表 11 月 12 日那轮是否有认证请求，不等于历史全部轮次。

<details>
<summary>展开：673 个方法和路径（含历史对照）</summary>

| 方法 | 路径 | 上轮认证 | 历史观察分类 | 上轮完整验收 | 历史 CSV 行 |
| --- | --- | --- | --- | --- | ---: |
| `GET` | `/api/admin/v1/activities` | YES | 有限2xx | `NOT_RUN` | 245 |
| `POST` | `/api/admin/v1/activities` | NO | 有限2xx | `NOT_RUN` | 246 |
| `POST` | `/api/admin/v1/activities/from-template` | NO | 未见认证 | `NOT_RUN` | 241 |
| `GET` | `/api/admin/v1/activities/options` | NO | 有限2xx | `NOT_RUN` | 247 |
| `GET` | `/api/admin/v1/activities/organization-options` | NO | 仅非2xx | `NOT_RUN` | 239 |
| `GET` | `/api/admin/v1/activities/template-version-options` | NO | 仅非2xx | `NOT_RUN` | 240 |
| `GET` | `/api/admin/v1/activities/{activityId}/attendance-sheet-draft` | NO | 仅非2xx | `NOT_RUN` | 473 |
| `GET` | `/api/admin/v1/activities/{activityId}/attendance-sheets` | NO | 仅非2xx | `NOT_RUN` | 458 |
| `POST` | `/api/admin/v1/activities/{activityId}/attendance-sheets` | NO | 未见认证 | `NOT_RUN` | 457 |
| `GET` | `/api/admin/v1/activities/{activityId}/check-ins` | NO | 仅非2xx | `NOT_RUN` | 472 |
| `GET` | `/api/admin/v1/activities/{activityId}/feedback-summary` | NO | 仅非2xx | `NOT_RUN` | 451 |
| `GET` | `/api/admin/v1/activities/{activityId}/feedbacks` | NO | 仅非2xx | `NOT_RUN` | 450 |
| `GET` | `/api/admin/v1/activities/{activityId}/participation-ledger` | NO | 仅非2xx | `NOT_RUN` | 261 |
| `GET` | `/api/admin/v1/activities/{activityId}/participation-summary` | NO | 仅非2xx | `NOT_RUN` | 263 |
| `GET` | `/api/admin/v1/activities/{activityId}/positions` | NO | 有限2xx | `NOT_RUN` | 265 |
| `POST` | `/api/admin/v1/activities/{activityId}/positions` | NO | 有限2xx | `NOT_RUN` | 264 |
| `DELETE` | `/api/admin/v1/activities/{activityId}/positions/{activityPositionId}` | NO | 有限2xx | `NOT_RUN` | 268 |
| `GET` | `/api/admin/v1/activities/{activityId}/positions/{activityPositionId}` | NO | 有限2xx | `NOT_RUN` | 266 |
| `PATCH` | `/api/admin/v1/activities/{activityId}/positions/{activityPositionId}` | NO | 有限2xx | `NOT_RUN` | 267 |
| `GET` | `/api/admin/v1/activities/{activityId}/reconciliation` | NO | 仅非2xx | `NOT_RUN` | 262 |
| `GET` | `/api/admin/v1/activities/{activityId}/registrations` | NO | 仅非2xx | `NOT_RUN` | 531 |
| `POST` | `/api/admin/v1/activities/{activityId}/registrations` | NO | 未见认证 | `NOT_RUN` | 532 |
| `PATCH` | `/api/admin/v1/activities/{activityId}/registrations/bulk-approve` | NO | 未见认证 | `NOT_RUN` | 534 |
| `PATCH` | `/api/admin/v1/activities/{activityId}/registrations/bulk-reject` | NO | 未见认证 | `NOT_RUN` | 535 |
| `GET` | `/api/admin/v1/activities/{activityId}/registrations/export` | NO | 仅非2xx | `NOT_RUN` | 533 |
| `PATCH` | `/api/admin/v1/activities/{activityId}/registrations/{id}/approve` | NO | 未见认证 | `NOT_RUN` | 536 |
| `PATCH` | `/api/admin/v1/activities/{activityId}/registrations/{id}/cancel` | NO | 未见认证 | `NOT_RUN` | 538 |
| `PATCH` | `/api/admin/v1/activities/{activityId}/registrations/{id}/reject` | NO | 未见认证 | `NOT_RUN` | 537 |
| `POST` | `/api/admin/v1/activities/{activityId}/registrations/{id}/reopen` | NO | 未见认证 | `NOT_RUN` | 539 |
| `GET` | `/api/admin/v1/activities/{activityId}/responsibilities` | NO | 仅非2xx | `NOT_RUN` | 274 |
| `POST` | `/api/admin/v1/activities/{activityId}/responsibilities/assign-initiator` | NO | 未见认证 | `NOT_RUN` | 279 |
| `POST` | `/api/admin/v1/activities/{activityId}/responsibilities/claim` | NO | 未见认证 | `NOT_RUN` | 278 |
| `POST` | `/api/admin/v1/activities/{activityId}/responsibilities/collaborators` | NO | 未见认证 | `NOT_RUN` | 275 |
| `DELETE` | `/api/admin/v1/activities/{activityId}/responsibilities/collaborators/{assignmentId}` | NO | 未见认证 | `NOT_RUN` | 276 |
| `POST` | `/api/admin/v1/activities/{activityId}/responsibilities/transfer` | NO | 未见认证 | `NOT_RUN` | 277 |
| `DELETE` | `/api/admin/v1/activities/{id}` | NO | 有限2xx | `NOT_RUN` | 250 |
| `GET` | `/api/admin/v1/activities/{id}` | NO | 仅非2xx | `NOT_RUN` | 248 |
| `PATCH` | `/api/admin/v1/activities/{id}` | NO | 未见认证 | `NOT_RUN` | 249 |
| `PATCH` | `/api/admin/v1/activities/{id}/cancel` | NO | 未见认证 | `NOT_RUN` | 255 |
| `POST` | `/api/admin/v1/activities/{id}/complete` | NO | 未见认证 | `NOT_RUN` | 256 |
| `GET` | `/api/admin/v1/activities/{id}/contribution-policy-selection` | NO | 仅非2xx | `NOT_RUN` | 227 |
| `PATCH` | `/api/admin/v1/activities/{id}/contribution-policy-selection` | NO | 未见认证 | `NOT_RUN` | 228 |
| `PUT` | `/api/admin/v1/activities/{id}/cover` | NO | 未见认证 | `NOT_RUN` | 251 |
| `PUT` | `/api/admin/v1/activities/{id}/gallery` | NO | 未见认证 | `NOT_RUN` | 252 |
| `GET` | `/api/admin/v1/activities/{id}/metric-selection` | NO | 仅非2xx | `NOT_RUN` | 223 |
| `PUT` | `/api/admin/v1/activities/{id}/metric-selection` | NO | 未见认证 | `NOT_RUN` | 224 |
| `PATCH` | `/api/admin/v1/activities/{id}/publish` | NO | 未见认证 | `NOT_RUN` | 253 |
| `POST` | `/api/admin/v1/activities/{id}/publish-reviews` | NO | 未见认证 | `NOT_RUN` | 244 |
| `PATCH` | `/api/admin/v1/activities/{id}/publish-with-audience-tags` | NO | 未见认证 | `NOT_RUN` | 254 |
| `GET` | `/api/admin/v1/activities/{id}/simple-draft` | NO | 仅非2xx | `NOT_RUN` | 242 |
| `PUT` | `/api/admin/v1/activities/{id}/simple-draft` | NO | 未见认证 | `NOT_RUN` | 243 |
| `GET` | `/api/admin/v1/activities/{id}/time-policy-selection` | NO | 仅非2xx | `NOT_RUN` | 225 |
| `PATCH` | `/api/admin/v1/activities/{id}/time-policy-selection` | NO | 未见认证 | `NOT_RUN` | 226 |
| `GET` | `/api/admin/v1/activity-metric-definitions` | NO | 仅非2xx | `NOT_RUN` | 280 |
| `POST` | `/api/admin/v1/activity-metric-definitions` | NO | 未见认证 | `NOT_RUN` | 281 |
| `GET` | `/api/admin/v1/activity-metric-definitions/{id}` | NO | 仅非2xx | `NOT_RUN` | 282 |
| `POST` | `/api/admin/v1/activity-metric-definitions/{id}/activate` | NO | 未见认证 | `NOT_RUN` | 284 |
| `PUT` | `/api/admin/v1/activity-metric-definitions/{id}/draft` | NO | 未见认证 | `NOT_RUN` | 283 |
| `POST` | `/api/admin/v1/activity-metric-definitions/{id}/retire` | NO | 未见认证 | `NOT_RUN` | 285 |
| `GET` | `/api/admin/v1/activity-metric-rule-bindings` | NO | 仅非2xx | `NOT_RUN` | 210 |
| `POST` | `/api/admin/v1/activity-metric-rule-bindings` | NO | 未见认证 | `NOT_RUN` | 209 |
| `GET` | `/api/admin/v1/activity-metric-sets` | NO | 仅非2xx | `NOT_RUN` | 302 |
| `POST` | `/api/admin/v1/activity-metric-sets` | NO | 未见认证 | `NOT_RUN` | 303 |
| `GET` | `/api/admin/v1/activity-metric-sets/{id}` | NO | 仅非2xx | `NOT_RUN` | 304 |
| `POST` | `/api/admin/v1/activity-metric-sets/{id}/activate` | NO | 未见认证 | `NOT_RUN` | 306 |
| `PUT` | `/api/admin/v1/activity-metric-sets/{id}/draft` | NO | 未见认证 | `NOT_RUN` | 305 |
| `POST` | `/api/admin/v1/activity-metric-sets/{id}/retire` | NO | 未见认证 | `NOT_RUN` | 307 |
| `GET` | `/api/admin/v1/activity-publish-reviews` | NO | 仅非2xx | `NOT_RUN` | 269 |
| `GET` | `/api/admin/v1/activity-publish-reviews/{id}` | NO | 仅非2xx | `NOT_RUN` | 270 |
| `POST` | `/api/admin/v1/activity-publish-reviews/{id}/approve` | NO | 未见认证 | `NOT_RUN` | 272 |
| `GET` | `/api/admin/v1/activity-publish-reviews/{id}/referenced-policies` | NO | 仅非2xx | `NOT_RUN` | 271 |
| `POST` | `/api/admin/v1/activity-publish-reviews/{id}/return` | NO | 未见认证 | `NOT_RUN` | 273 |
| `GET` | `/api/admin/v1/activity-template-versions` | NO | 仅非2xx | `NOT_RUN` | 229 |
| `POST` | `/api/admin/v1/activity-template-versions` | NO | 未见认证 | `NOT_RUN` | 230 |
| `GET` | `/api/admin/v1/activity-template-versions/{id}` | NO | 仅非2xx | `NOT_RUN` | 231 |
| `POST` | `/api/admin/v1/activity-template-versions/{id}/activate` | NO | 未见认证 | `NOT_RUN` | 233 |
| `PUT` | `/api/admin/v1/activity-template-versions/{id}/draft` | NO | 未见认证 | `NOT_RUN` | 232 |
| `POST` | `/api/admin/v1/activity-template-versions/{id}/retire` | NO | 未见认证 | `NOT_RUN` | 234 |
| `GET` | `/api/admin/v1/activity-time-policies` | NO | 仅非2xx | `NOT_RUN` | 286 |
| `POST` | `/api/admin/v1/activity-time-policies` | NO | 未见认证 | `NOT_RUN` | 287 |
| `GET` | `/api/admin/v1/activity-time-policies/{id}` | NO | 仅非2xx | `NOT_RUN` | 288 |
| `GET` | `/api/admin/v1/activity-time-policies/{id}/versions` | NO | 仅非2xx | `NOT_RUN` | 289 |
| `POST` | `/api/admin/v1/activity-time-policies/{id}/versions` | NO | 未见认证 | `NOT_RUN` | 290 |
| `GET` | `/api/admin/v1/activity-time-policies/{id}/versions/{versionId}` | NO | 仅非2xx | `NOT_RUN` | 291 |
| `POST` | `/api/admin/v1/activity-time-policies/{id}/versions/{versionId}/activate` | NO | 未见认证 | `NOT_RUN` | 292 |
| `POST` | `/api/admin/v1/activity-time-policies/{id}/versions/{versionId}/retire` | NO | 未见认证 | `NOT_RUN` | 293 |
| `POST` | `/api/admin/v1/announcement-import/execute` | NO | 未见认证 | `NOT_RUN` | 586 |
| `POST` | `/api/admin/v1/announcement-import/preview` | NO | 未见认证 | `NOT_RUN` | 585 |
| `GET` | `/api/admin/v1/attachments` | NO | 有限2xx | `NOT_RUN` | 90 |
| `POST` | `/api/admin/v1/attachments` | NO | 未见认证 | `NOT_RUN` | 89 |
| `GET` | `/api/admin/v1/attachments/by-owner` | NO | 有限2xx | `NOT_RUN` | 93 |
| `POST` | `/api/admin/v1/attachments/confirm-upload` | NO | 未见认证 | `NOT_RUN` | 92 |
| `POST` | `/api/admin/v1/attachments/upload-url` | NO | 未见认证 | `NOT_RUN` | 91 |
| `DELETE` | `/api/admin/v1/attachments/{id}` | NO | 未见认证 | `NOT_RUN` | 96 |
| `GET` | `/api/admin/v1/attachments/{id}` | NO | 仅非2xx | `NOT_RUN` | 94 |
| `PATCH` | `/api/admin/v1/attachments/{id}` | NO | 未见认证 | `NOT_RUN` | 95 |
| `GET` | `/api/admin/v1/attendance-settlements` | YES | 仅非2xx | `NOT_RUN` | 354 |
| `POST` | `/api/admin/v1/attendance-settlements/{id}/final-approve` | NO | 未见认证 | `NOT_RUN` | 359 |
| `POST` | `/api/admin/v1/attendance-settlements/{id}/final-return` | NO | 未见认证 | `NOT_RUN` | 360 |
| `POST` | `/api/admin/v1/attendance-settlements/{id}/first-approve` | NO | 未见认证 | `NOT_RUN` | 357 |
| `POST` | `/api/admin/v1/attendance-settlements/{id}/first-return` | NO | 未见认证 | `NOT_RUN` | 358 |
| `GET` | `/api/admin/v1/attendance-settlements/{id}/posting-batch` | NO | 仅非2xx | `NOT_RUN` | 356 |
| `GET` | `/api/admin/v1/attendance-settlements/{settlementVersionId}/review-detail` | NO | 仅非2xx | `NOT_RUN` | 355 |
| `GET` | `/api/admin/v1/attendance-sheets` | YES | 仅非2xx | `NOT_RUN` | 459 |
| `DELETE` | `/api/admin/v1/attendance-sheets/{id}` | NO | 未见认证 | `NOT_RUN` | 463 |
| `GET` | `/api/admin/v1/attendance-sheets/{id}` | NO | 仅非2xx | `NOT_RUN` | 461 |
| `PATCH` | `/api/admin/v1/attendance-sheets/{id}` | NO | 未见认证 | `NOT_RUN` | 462 |
| `PATCH` | `/api/admin/v1/attendance-sheets/{id}/approve` | NO | 未见认证 | `NOT_RUN` | 464 |
| `PATCH` | `/api/admin/v1/attendance-sheets/{id}/final-approve` | NO | 未见认证 | `NOT_RUN` | 467 |
| `PATCH` | `/api/admin/v1/attendance-sheets/{id}/final-reject` | NO | 未见认证 | `NOT_RUN` | 468 |
| `POST` | `/api/admin/v1/attendance-sheets/{id}/final-return` | NO | 未见认证 | `NOT_RUN` | 469 |
| `PATCH` | `/api/admin/v1/attendance-sheets/{id}/reject` | NO | 未见认证 | `NOT_RUN` | 465 |
| `POST` | `/api/admin/v1/attendance-sheets/{id}/reopen` | NO | 未见认证 | `NOT_RUN` | 471 |
| `POST` | `/api/admin/v1/attendance-sheets/{id}/resubmit` | NO | 未见认证 | `NOT_RUN` | 470 |
| `POST` | `/api/admin/v1/attendance-sheets/{id}/return` | NO | 未见认证 | `NOT_RUN` | 466 |
| `GET` | `/api/admin/v1/attendance-sheets/{id}/review-detail` | NO | 仅非2xx | `NOT_RUN` | 460 |
| `POST` | `/api/admin/v1/authz/action-state/batch` | NO | 未见认证 | `NOT_RUN` | 87 |
| `POST` | `/api/admin/v1/authz/explain` | NO | 未见认证 | `NOT_RUN` | 85 |
| `POST` | `/api/admin/v1/authz/explain-batch` | NO | 未见认证 | `NOT_RUN` | 86 |
| `DELETE` | `/api/admin/v1/certificate-recognition-policies/{id}` | NO | 未见认证 | `NOT_RUN` | 418 |
| `GET` | `/api/admin/v1/certificate-recognition-policies/{id}` | NO | 仅非2xx | `NOT_RUN` | 416 |
| `PATCH` | `/api/admin/v1/certificate-recognition-policies/{id}` | NO | 未见认证 | `NOT_RUN` | 417 |
| `PATCH` | `/api/admin/v1/certificate-recognition-policies/{id}/status` | NO | 未见认证 | `NOT_RUN` | 419 |
| `GET` | `/api/admin/v1/certificate-standards` | NO | 仅非2xx | `NOT_RUN` | 407 |
| `POST` | `/api/admin/v1/certificate-standards` | NO | 未见认证 | `NOT_RUN` | 408 |
| `GET` | `/api/admin/v1/certificate-standards/options` | NO | 仅非2xx | `NOT_RUN` | 409 |
| `DELETE` | `/api/admin/v1/certificate-standards/{id}` | NO | 未见认证 | `NOT_RUN` | 412 |
| `GET` | `/api/admin/v1/certificate-standards/{id}` | NO | 仅非2xx | `NOT_RUN` | 410 |
| `PATCH` | `/api/admin/v1/certificate-standards/{id}` | NO | 未见认证 | `NOT_RUN` | 411 |
| `PATCH` | `/api/admin/v1/certificate-standards/{id}/status` | NO | 未见认证 | `NOT_RUN` | 413 |
| `GET` | `/api/admin/v1/certificate-standards/{standardId}/recognition-policies` | NO | 仅非2xx | `NOT_RUN` | 414 |
| `POST` | `/api/admin/v1/certificate-standards/{standardId}/recognition-policies` | NO | 未见认证 | `NOT_RUN` | 415 |
| `GET` | `/api/admin/v1/certificates` | NO | 仅非2xx | `NOT_RUN` | 420 |
| `GET` | `/api/admin/v1/certificates/stats` | NO | 仅非2xx | `NOT_RUN` | 421 |
| `GET` | `/api/admin/v1/contents` | NO | 仅非2xx | `NOT_RUN` | 660 |
| `POST` | `/api/admin/v1/contents` | NO | 仅非2xx | `NOT_RUN` | 659 |
| `DELETE` | `/api/admin/v1/contents/{id}` | NO | 未见认证 | `NOT_RUN` | 663 |
| `GET` | `/api/admin/v1/contents/{id}` | NO | 仅非2xx | `NOT_RUN` | 661 |
| `PATCH` | `/api/admin/v1/contents/{id}` | NO | 未见认证 | `NOT_RUN` | 662 |
| `POST` | `/api/admin/v1/contents/{id}/archive` | NO | 未见认证 | `NOT_RUN` | 666 |
| `POST` | `/api/admin/v1/contents/{id}/attachments/confirm` | NO | 未见认证 | `NOT_RUN` | 668 |
| `POST` | `/api/admin/v1/contents/{id}/attachments/upload-url` | NO | 未见认证 | `NOT_RUN` | 667 |
| `DELETE` | `/api/admin/v1/contents/{id}/attachments/{attachmentId}` | NO | 未见认证 | `NOT_RUN` | 669 |
| `PUT` | `/api/admin/v1/contents/{id}/cover` | NO | 未见认证 | `NOT_RUN` | 670 |
| `POST` | `/api/admin/v1/contents/{id}/publish` | NO | 未见认证 | `NOT_RUN` | 664 |
| `POST` | `/api/admin/v1/contents/{id}/unpublish` | NO | 未见认证 | `NOT_RUN` | 665 |
| `GET` | `/api/admin/v1/me` | YES | 有限2xx | `NOT_RUN` | 84 |
| `GET` | `/api/admin/v1/member-insurances` | NO | 仅非2xx | `NOT_RUN` | 392 |
| `GET` | `/api/admin/v1/members` | NO | 仅非2xx | `NOT_RUN` | 159 |
| `POST` | `/api/admin/v1/members` | NO | 未见认证 | `NOT_RUN` | 160 |
| `POST` | `/api/admin/v1/members/accounts/bulk-grant` | NO | 未见认证 | `NOT_RUN` | 162 |
| `GET` | `/api/admin/v1/members/options` | NO | 仅非2xx | `NOT_RUN` | 161 |
| `DELETE` | `/api/admin/v1/members/{id}` | NO | 未见认证 | `NOT_RUN` | 171 |
| `GET` | `/api/admin/v1/members/{id}` | YES | 仅非2xx | `NOT_RUN` | 169 |
| `PATCH` | `/api/admin/v1/members/{id}` | NO | 未见认证 | `NOT_RUN` | 170 |
| `POST` | `/api/admin/v1/members/{id}/account` | NO | 未见认证 | `NOT_RUN` | 174 |
| `POST` | `/api/admin/v1/members/{id}/account/bind` | NO | 未见认证 | `NOT_RUN` | 175 |
| `POST` | `/api/admin/v1/members/{id}/account/reopen` | NO | 未见认证 | `NOT_RUN` | 177 |
| `PATCH` | `/api/admin/v1/members/{id}/account/status` | NO | 未见认证 | `NOT_RUN` | 178 |
| `POST` | `/api/admin/v1/members/{id}/account/unbind` | NO | 未见认证 | `NOT_RUN` | 176 |
| `GET` | `/api/admin/v1/members/{id}/audience-tags` | NO | 仅非2xx | `NOT_RUN` | 167 |
| `PUT` | `/api/admin/v1/members/{id}/audience-tags` | NO | 未见认证 | `NOT_RUN` | 168 |
| `POST` | `/api/admin/v1/members/{id}/identity-corrections` | NO | 未见认证 | `NOT_RUN` | 173 |
| `POST` | `/api/admin/v1/members/{id}/offboard` | NO | 未见认证 | `NOT_RUN` | 180 |
| `GET` | `/api/admin/v1/members/{id}/offboard-impact` | NO | 仅非2xx | `NOT_RUN` | 179 |
| `DELETE` | `/api/admin/v1/members/{id}/official-portrait` | NO | 未见认证 | `NOT_RUN` | 165 |
| `GET` | `/api/admin/v1/members/{id}/official-portrait` | NO | 仅非2xx | `NOT_RUN` | 163 |
| `POST` | `/api/admin/v1/members/{id}/official-portrait` | NO | 未见认证 | `NOT_RUN` | 164 |
| `GET` | `/api/admin/v1/members/{id}/official-portraits` | NO | 仅非2xx | `NOT_RUN` | 166 |
| `PATCH` | `/api/admin/v1/members/{id}/status` | NO | 未见认证 | `NOT_RUN` | 172 |
| `GET` | `/api/admin/v1/members/{memberId}/attendance-records` | NO | 仅非2xx | `NOT_RUN` | 474 |
| `GET` | `/api/admin/v1/members/{memberId}/certificates` | NO | 仅非2xx | `NOT_RUN` | 397 |
| `POST` | `/api/admin/v1/members/{memberId}/certificates` | NO | 未见认证 | `NOT_RUN` | 398 |
| `GET` | `/api/admin/v1/members/{memberId}/certificates/qualification-flag` | NO | 仅非2xx | `NOT_RUN` | 399 |
| `DELETE` | `/api/admin/v1/members/{memberId}/certificates/{id}` | NO | 未见认证 | `NOT_RUN` | 402 |
| `GET` | `/api/admin/v1/members/{memberId}/certificates/{id}` | NO | 仅非2xx | `NOT_RUN` | 400 |
| `PATCH` | `/api/admin/v1/members/{memberId}/certificates/{id}` | NO | 未见认证 | `NOT_RUN` | 401 |
| `GET` | `/api/admin/v1/members/{memberId}/certificates/{id}/evidence-urls` | NO | 仅非2xx | `NOT_RUN` | 405 |
| `PATCH` | `/api/admin/v1/members/{memberId}/certificates/{id}/reject` | NO | 未见认证 | `NOT_RUN` | 404 |
| `PATCH` | `/api/admin/v1/members/{memberId}/certificates/{id}/verify` | NO | 未见认证 | `NOT_RUN` | 403 |
| `GET` | `/api/admin/v1/members/{memberId}/contribution-summary` | NO | 仅非2xx | `NOT_RUN` | 475 |
| `DELETE` | `/api/admin/v1/members/{memberId}/department` | NO | 未见认证 | `NOT_RUN` | 516 |
| `GET` | `/api/admin/v1/members/{memberId}/department` | NO | 仅非2xx | `NOT_RUN` | 514 |
| `PUT` | `/api/admin/v1/members/{memberId}/department` | NO | 未见认证 | `NOT_RUN` | 515 |
| `GET` | `/api/admin/v1/members/{memberId}/emergency-contacts` | NO | 仅非2xx | `NOT_RUN` | 527 |
| `POST` | `/api/admin/v1/members/{memberId}/emergency-contacts` | NO | 未见认证 | `NOT_RUN` | 528 |
| `DELETE` | `/api/admin/v1/members/{memberId}/emergency-contacts/{id}` | NO | 未见认证 | `NOT_RUN` | 530 |
| `PATCH` | `/api/admin/v1/members/{memberId}/emergency-contacts/{id}` | NO | 未见认证 | `NOT_RUN` | 529 |
| `GET` | `/api/admin/v1/members/{memberId}/insurances` | NO | 仅非2xx | `NOT_RUN` | 389 |
| `GET` | `/api/admin/v1/members/{memberId}/insurances/overview` | YES | 仅非2xx | `NOT_RUN` | 390 |
| `POST` | `/api/admin/v1/members/{memberId}/insurances/{insuranceId}/review` | NO | 未见认证 | `NOT_RUN` | 391 |
| `GET` | `/api/admin/v1/members/{memberId}/memberships` | NO | 仅非2xx | `NOT_RUN` | 517 |
| `POST` | `/api/admin/v1/members/{memberId}/memberships` | NO | 未见认证 | `NOT_RUN` | 518 |
| `DELETE` | `/api/admin/v1/members/{memberId}/memberships/{id}` | NO | 未见认证 | `NOT_RUN` | 520 |
| `PATCH` | `/api/admin/v1/members/{memberId}/memberships/{id}` | NO | 未见认证 | `NOT_RUN` | 519 |
| `GET` | `/api/admin/v1/members/{memberId}/participation-ledger` | NO | 仅非2xx | `NOT_RUN` | 378 |
| `GET` | `/api/admin/v1/members/{memberId}/participation-summary` | YES | 仅非2xx | `NOT_RUN` | 476 |
| `GET` | `/api/admin/v1/members/{memberId}/participation-time-proof` | NO | 仅非2xx | `NOT_RUN` | 379 |
| `GET` | `/api/admin/v1/members/{memberId}/position-assignments` | NO | 仅非2xx | `NOT_RUN` | 136 |
| `GET` | `/api/admin/v1/members/{memberId}/profile` | NO | 仅非2xx | `NOT_RUN` | 422 |
| `PATCH` | `/api/admin/v1/members/{memberId}/profile` | NO | 未见认证 | `NOT_RUN` | 424 |
| `POST` | `/api/admin/v1/members/{memberId}/profile` | NO | 未见认证 | `NOT_RUN` | 423 |
| `GET` | `/api/admin/v1/members/{memberId}/registrations` | NO | 仅非2xx | `NOT_RUN` | 541 |
| `GET` | `/api/admin/v1/members/{memberId}/supervision-scope` | NO | 仅非2xx | `NOT_RUN` | 148 |
| `GET` | `/api/admin/v1/memberships` | NO | 仅非2xx | `NOT_RUN` | 521 |
| `GET` | `/api/admin/v1/memberships/conflicts` | NO | 仅非2xx | `NOT_RUN` | 522 |
| `POST` | `/api/admin/v1/memberships/transfer` | NO | 未见认证 | `NOT_RUN` | 523 |
| `GET` | `/api/admin/v1/memberships/{id}` | NO | 仅非2xx | `NOT_RUN` | 524 |
| `GET` | `/api/admin/v1/meta/dashboard-summary` | YES | 有限2xx | `NOT_RUN` | 588 |
| `GET` | `/api/admin/v1/meta/participation-overview` | NO | 仅非2xx | `NOT_RUN` | 589 |
| `POST` | `/api/admin/v1/meta/resolve-labels` | NO | 仅非2xx | `NOT_RUN` | 587 |
| `GET` | `/api/admin/v1/notification-wechat-templates` | NO | 仅非2xx | `NOT_RUN` | 441 |
| `PUT` | `/api/admin/v1/notification-wechat-templates/{typeCode}` | NO | 未见认证 | `NOT_RUN` | 442 |
| `GET` | `/api/admin/v1/notifications` | NO | 仅非2xx | `NOT_RUN` | 426 |
| `POST` | `/api/admin/v1/notifications` | NO | 未见认证 | `NOT_RUN` | 425 |
| `DELETE` | `/api/admin/v1/notifications/{id}` | NO | 未见认证 | `NOT_RUN` | 429 |
| `GET` | `/api/admin/v1/notifications/{id}` | NO | 仅非2xx | `NOT_RUN` | 427 |
| `PATCH` | `/api/admin/v1/notifications/{id}` | NO | 未见认证 | `NOT_RUN` | 428 |
| `POST` | `/api/admin/v1/notifications/{id}/archive` | NO | 未见认证 | `NOT_RUN` | 432 |
| `POST` | `/api/admin/v1/notifications/{id}/publish` | NO | 未见认证 | `NOT_RUN` | 430 |
| `POST` | `/api/admin/v1/notifications/{id}/replay-wecom` | NO | 未见认证 | `NOT_RUN` | 434 |
| `POST` | `/api/admin/v1/notifications/{id}/send-sms` | NO | 未见认证 | `NOT_RUN` | 433 |
| `POST` | `/api/admin/v1/notifications/{id}/unpublish` | NO | 未见认证 | `NOT_RUN` | 431 |
| `GET` | `/api/admin/v1/organizations` | NO | 仅非2xx | `NOT_RUN` | 113 |
| `POST` | `/api/admin/v1/organizations` | NO | 未见认证 | `NOT_RUN` | 114 |
| `GET` | `/api/admin/v1/organizations/options` | NO | 仅非2xx | `NOT_RUN` | 116 |
| `GET` | `/api/admin/v1/organizations/tree` | NO | 仅非2xx | `NOT_RUN` | 115 |
| `GET` | `/api/admin/v1/organizations/tree-options` | NO | 仅非2xx | `NOT_RUN` | 117 |
| `GET` | `/api/admin/v1/organizations/tree-with-summary` | NO | 仅非2xx | `NOT_RUN` | 118 |
| `DELETE` | `/api/admin/v1/organizations/{id}` | NO | 未见认证 | `NOT_RUN` | 121 |
| `GET` | `/api/admin/v1/organizations/{id}` | NO | 仅非2xx | `NOT_RUN` | 119 |
| `PATCH` | `/api/admin/v1/organizations/{id}` | NO | 未见认证 | `NOT_RUN` | 120 |
| `POST` | `/api/admin/v1/organizations/{id}/move` | NO | 未见认证 | `NOT_RUN` | 123 |
| `PATCH` | `/api/admin/v1/organizations/{id}/status` | NO | 未见认证 | `NOT_RUN` | 122 |
| `GET` | `/api/admin/v1/organizations/{orgId}/members/options` | NO | 仅非2xx | `NOT_RUN` | 526 |
| `GET` | `/api/admin/v1/organizations/{orgId}/memberships` | NO | 仅非2xx | `NOT_RUN` | 525 |
| `GET` | `/api/admin/v1/organizations/{orgId}/position-assignments` | NO | 仅非2xx | `NOT_RUN` | 134 |
| `POST` | `/api/admin/v1/organizations/{orgId}/position-assignments` | NO | 未见认证 | `NOT_RUN` | 135 |
| `GET` | `/api/admin/v1/organizations/{orgId}/supervisors` | NO | 仅非2xx | `NOT_RUN` | 149 |
| `GET` | `/api/admin/v1/position-assignments` | NO | 仅非2xx | `NOT_RUN` | 137 |
| `POST` | `/api/admin/v1/position-assignments/preview` | NO | 未见认证 | `NOT_RUN` | 138 |
| `GET` | `/api/admin/v1/position-assignments/{id}` | NO | 仅非2xx | `NOT_RUN` | 139 |
| `GET` | `/api/admin/v1/position-assignments/{id}/history` | NO | 仅非2xx | `NOT_RUN` | 141 |
| `POST` | `/api/admin/v1/position-assignments/{id}/revoke` | NO | 未见认证 | `NOT_RUN` | 140 |
| `GET` | `/api/admin/v1/position-rules` | NO | 仅非2xx | `NOT_RUN` | 130 |
| `POST` | `/api/admin/v1/position-rules` | NO | 未见认证 | `NOT_RUN` | 131 |
| `DELETE` | `/api/admin/v1/position-rules/{id}` | NO | 未见认证 | `NOT_RUN` | 133 |
| `PATCH` | `/api/admin/v1/position-rules/{id}` | NO | 未见认证 | `NOT_RUN` | 132 |
| `GET` | `/api/admin/v1/positions` | NO | 仅非2xx | `NOT_RUN` | 124 |
| `POST` | `/api/admin/v1/positions` | NO | 未见认证 | `NOT_RUN` | 125 |
| `GET` | `/api/admin/v1/positions/options` | NO | 仅非2xx | `NOT_RUN` | 126 |
| `DELETE` | `/api/admin/v1/positions/{id}` | NO | 未见认证 | `NOT_RUN` | 129 |
| `GET` | `/api/admin/v1/positions/{id}` | NO | 仅非2xx | `NOT_RUN` | 127 |
| `PATCH` | `/api/admin/v1/positions/{id}` | NO | 未见认证 | `NOT_RUN` | 128 |
| `GET` | `/api/admin/v1/recruitment/applications` | NO | 仅非2xx | `NOT_RUN` | 632 |
| `POST` | `/api/admin/v1/recruitment/applications/batch-mark-threshold` | NO | 未见认证 | `NOT_RUN` | 633 |
| `POST` | `/api/admin/v1/recruitment/applications/export` | NO | 未见认证 | `NOT_RUN` | 634 |
| `GET` | `/api/admin/v1/recruitment/applications/{applicationId}/certificate-claims` | NO | 仅非2xx | `NOT_RUN` | 642 |
| `GET` | `/api/admin/v1/recruitment/applications/{id}` | NO | 仅非2xx | `NOT_RUN` | 635 |
| `PATCH` | `/api/admin/v1/recruitment/applications/{id}` | NO | 未见认证 | `NOT_RUN` | 636 |
| `POST` | `/api/admin/v1/recruitment/applications/{id}/evaluate` | NO | 未见认证 | `NOT_RUN` | 641 |
| `GET` | `/api/admin/v1/recruitment/applications/{id}/id-card-image-url` | NO | 仅非2xx | `NOT_RUN` | 637 |
| `POST` | `/api/admin/v1/recruitment/applications/{id}/promote-single` | NO | 未见认证 | `NOT_RUN` | 640 |
| `POST` | `/api/admin/v1/recruitment/applications/{id}/resolve` | NO | 未见认证 | `NOT_RUN` | 638 |
| `PATCH` | `/api/admin/v1/recruitment/applications/{id}/thresholds` | NO | 未见认证 | `NOT_RUN` | 639 |
| `GET` | `/api/admin/v1/recruitment/certificate-claims/{id}` | NO | 仅非2xx | `NOT_RUN` | 643 |
| `GET` | `/api/admin/v1/recruitment/certificate-claims/{id}/image-urls` | NO | 仅非2xx | `NOT_RUN` | 644 |
| `POST` | `/api/admin/v1/recruitment/certificate-claims/{id}/review` | NO | 未见认证 | `NOT_RUN` | 645 |
| `POST` | `/api/admin/v1/recruitment/certificate-claims/{id}/revoke-review` | NO | 未见认证 | `NOT_RUN` | 646 |
| `GET` | `/api/admin/v1/recruitment/cycles` | NO | 仅非2xx | `NOT_RUN` | 625 |
| `POST` | `/api/admin/v1/recruitment/cycles` | NO | 未见认证 | `NOT_RUN` | 624 |
| `GET` | `/api/admin/v1/recruitment/cycles/{id}` | NO | 仅非2xx | `NOT_RUN` | 626 |
| `PATCH` | `/api/admin/v1/recruitment/cycles/{id}` | NO | 未见认证 | `NOT_RUN` | 627 |
| `POST` | `/api/admin/v1/recruitment/cycles/{id}/promote` | NO | 未见认证 | `NOT_RUN` | 631 |
| `GET` | `/api/admin/v1/recruitment/cycles/{id}/promote-precheck` | NO | 仅非2xx | `NOT_RUN` | 630 |
| `GET` | `/api/admin/v1/recruitment/cycles/{id}/publicity-list` | NO | 仅非2xx | `NOT_RUN` | 628 |
| `GET` | `/api/admin/v1/recruitment/cycles/{id}/stats` | NO | 仅非2xx | `NOT_RUN` | 629 |
| `GET` | `/api/admin/v1/registrations` | YES | 仅非2xx | `NOT_RUN` | 540 |
| `GET` | `/api/admin/v1/role-bindings` | NO | 仅非2xx | `NOT_RUN` | 151 |
| `POST` | `/api/admin/v1/role-bindings` | NO | 未见认证 | `NOT_RUN` | 152 |
| `POST` | `/api/admin/v1/role-bindings/batch` | NO | 未见认证 | `NOT_RUN` | 158 |
| `GET` | `/api/admin/v1/role-bindings/page` | NO | 仅非2xx | `NOT_RUN` | 153 |
| `GET` | `/api/admin/v1/role-bindings/preview` | NO | 仅非2xx | `NOT_RUN` | 154 |
| `DELETE` | `/api/admin/v1/role-bindings/{id}` | NO | 未见认证 | `NOT_RUN` | 157 |
| `GET` | `/api/admin/v1/role-bindings/{id}` | NO | 仅非2xx | `NOT_RUN` | 155 |
| `PATCH` | `/api/admin/v1/role-bindings/{id}` | NO | 未见认证 | `NOT_RUN` | 156 |
| `GET` | `/api/admin/v1/supervision-assignments` | NO | 仅非2xx | `NOT_RUN` | 142 |
| `POST` | `/api/admin/v1/supervision-assignments` | NO | 未见认证 | `NOT_RUN` | 143 |
| `POST` | `/api/admin/v1/supervision-assignments/coverage-preview` | NO | 未见认证 | `NOT_RUN` | 145 |
| `GET` | `/api/admin/v1/supervision-assignments/page` | NO | 仅非2xx | `NOT_RUN` | 144 |
| `GET` | `/api/admin/v1/supervision-assignments/{id}` | NO | 仅非2xx | `NOT_RUN` | 146 |
| `PATCH` | `/api/admin/v1/supervision-assignments/{id}` | NO | 未见认证 | `NOT_RUN` | 147 |
| `POST` | `/api/admin/v1/supervision-assignments/{id}/revoke` | NO | 未见认证 | `NOT_RUN` | 150 |
| `GET` | `/api/admin/v1/team-insurance-policies` | YES | 仅非2xx | `NOT_RUN` | 380 |
| `POST` | `/api/admin/v1/team-insurance-policies` | NO | 未见认证 | `NOT_RUN` | 381 |
| `DELETE` | `/api/admin/v1/team-insurance-policies/{id}` | NO | 未见认证 | `NOT_RUN` | 384 |
| `GET` | `/api/admin/v1/team-insurance-policies/{id}` | NO | 仅非2xx | `NOT_RUN` | 382 |
| `PATCH` | `/api/admin/v1/team-insurance-policies/{id}` | NO | 未见认证 | `NOT_RUN` | 383 |
| `GET` | `/api/admin/v1/team-insurance-policies/{id}/members` | NO | 仅非2xx | `NOT_RUN` | 385 |
| `POST` | `/api/admin/v1/team-insurance-policies/{id}/members` | NO | 未见认证 | `NOT_RUN` | 386 |
| `POST` | `/api/admin/v1/team-insurance-policies/{id}/members/add-all-active` | NO | 未见认证 | `NOT_RUN` | 387 |
| `DELETE` | `/api/admin/v1/team-insurance-policies/{id}/members/{memberId}` | NO | 未见认证 | `NOT_RUN` | 388 |
| `GET` | `/api/admin/v1/team-join/applications` | NO | 仅非2xx | `NOT_RUN` | 651 |
| `GET` | `/api/admin/v1/team-join/applications/{id}` | NO | 仅非2xx | `NOT_RUN` | 652 |
| `POST` | `/api/admin/v1/team-join/applications/{id}/evaluate` | NO | 未见认证 | `NOT_RUN` | 654 |
| `PATCH` | `/api/admin/v1/team-join/applications/{id}/gates` | NO | 未见认证 | `NOT_RUN` | 653 |
| `POST` | `/api/admin/v1/team-join/applications/{id}/join` | NO | 未见认证 | `NOT_RUN` | 655 |
| `GET` | `/api/admin/v1/team-join/cycles` | NO | 仅非2xx | `NOT_RUN` | 648 |
| `POST` | `/api/admin/v1/team-join/cycles` | NO | 未见认证 | `NOT_RUN` | 647 |
| `GET` | `/api/admin/v1/team-join/cycles/{id}` | NO | 仅非2xx | `NOT_RUN` | 649 |
| `PATCH` | `/api/admin/v1/team-join/cycles/{id}` | NO | 未见认证 | `NOT_RUN` | 650 |
| `GET` | `/api/admin/v1/users` | YES | 仅非2xx | `NOT_RUN` | 57 |
| `POST` | `/api/admin/v1/users` | NO | 未见认证 | `NOT_RUN` | 58 |
| `GET` | `/api/admin/v1/users/options` | NO | 仅非2xx | `NOT_RUN` | 59 |
| `DELETE` | `/api/admin/v1/users/{id}` | NO | 未见认证 | `NOT_RUN` | 62 |
| `GET` | `/api/admin/v1/users/{id}` | NO | 仅非2xx | `NOT_RUN` | 60 |
| `PATCH` | `/api/admin/v1/users/{id}` | NO | 未见认证 | `NOT_RUN` | 61 |
| `PUT` | `/api/admin/v1/users/{id}/password` | NO | 未见认证 | `NOT_RUN` | 63 |
| `DELETE` | `/api/admin/v1/users/{id}/phone` | NO | 未见认证 | `NOT_RUN` | 66 |
| `PATCH` | `/api/admin/v1/users/{id}/role` | NO | 未见认证 | `NOT_RUN` | 64 |
| `PATCH` | `/api/admin/v1/users/{id}/status` | NO | 未见认证 | `NOT_RUN` | 65 |
| `DELETE` | `/api/admin/v1/users/{id}/wechat` | NO | 未见认证 | `NOT_RUN` | 67 |
| `DELETE` | `/api/admin/v1/users/{id}/wecom` | NO | 未见认证 | `NOT_RUN` | 68 |
| `GET` | `/api/app/v1/activities` | YES | 有限2xx | `NOT_RUN` | 257 |
| `GET` | `/api/app/v1/activities/available` | YES | 有限2xx | `NOT_RUN` | 258 |
| `GET` | `/api/app/v1/activities/{activityId}/positions` | NO | 仅非2xx | `NOT_RUN` | 259 |
| `POST` | `/api/app/v1/activities/{activityId}/registration-upload-sessions` | NO | 仅非2xx | `NOT_RUN` | 554 |
| `POST` | `/api/app/v1/activities/{activityId}/registration-upload-sessions/{sessionId}/files` | NO | 未见认证 | `NOT_RUN` | 555 |
| `POST` | `/api/app/v1/activities/{activityId}/registrations` | NO | 未见认证 | `NOT_RUN` | 556 |
| `GET` | `/api/app/v1/activities/{activityId}/sessions/{sessionId}/my-punch-state` | NO | 仅非2xx | `NOT_RUN` | 492 |
| `POST` | `/api/app/v1/activities/{activityId}/sessions/{sessionId}/punches/check-in` | NO | 未见认证 | `NOT_RUN` | 490 |
| `POST` | `/api/app/v1/activities/{activityId}/sessions/{sessionId}/punches/check-out` | NO | 未见认证 | `NOT_RUN` | 491 |
| `GET` | `/api/app/v1/activities/{id}` | YES | 仅非2xx | `NOT_RUN` | 260 |
| `GET` | `/api/app/v1/contents` | NO | 有限2xx | `NOT_RUN` | 673 |
| `GET` | `/api/app/v1/contents/{id}` | NO | 仅非2xx | `NOT_RUN` | 674 |
| `GET` | `/api/app/v1/me` | YES | 有限2xx | `NOT_RUN` | 69 |
| `GET` | `/api/app/v1/me/account` | YES | 有限2xx | `NOT_RUN` | 70 |
| `DELETE` | `/api/app/v1/me/avatar` | NO | 仅非2xx | `NOT_RUN` | 76 |
| `GET` | `/api/app/v1/me/avatar` | NO | 有限2xx | `NOT_RUN` | 74 |
| `POST` | `/api/app/v1/me/avatar` | NO | 仅非2xx | `NOT_RUN` | 75 |
| `GET` | `/api/app/v1/me/capabilities` | YES | 有限2xx | `NOT_RUN` | 71 |
| `GET` | `/api/app/v1/me/insurances` | YES | 有限2xx | `NOT_RUN` | 393 |
| `POST` | `/api/app/v1/me/insurances` | NO | 仅非2xx | `NOT_RUN` | 394 |
| `DELETE` | `/api/app/v1/me/insurances/{id}` | NO | 仅非2xx | `NOT_RUN` | 396 |
| `PATCH` | `/api/app/v1/me/insurances/{id}` | NO | 仅非2xx | `NOT_RUN` | 395 |
| `PUT` | `/api/app/v1/me/password` | NO | 未见认证 | `NOT_RUN` | 77 |
| `PUT` | `/api/app/v1/me/phone` | NO | 未见认证 | `NOT_RUN` | 79 |
| `POST` | `/api/app/v1/me/phone/send-code` | NO | 未见认证 | `NOT_RUN` | 78 |
| `GET` | `/api/app/v1/me/profile` | YES | 有限2xx | `NOT_RUN` | 72 |
| `PATCH` | `/api/app/v1/me/profile` | NO | 仅非2xx | `NOT_RUN` | 73 |
| `POST` | `/api/app/v1/me/team-join/applications` | NO | 未见认证 | `NOT_RUN` | 656 |
| `GET` | `/api/app/v1/me/team-join/applications/current` | NO | 仅非2xx | `NOT_RUN` | 657 |
| `PATCH` | `/api/app/v1/me/team-join/applications/{id}/targets` | NO | 未见认证 | `NOT_RUN` | 658 |
| `GET` | `/api/app/v1/me/wechat` | YES | 有限2xx | `NOT_RUN` | 80 |
| `PUT` | `/api/app/v1/me/wechat` | NO | 未见认证 | `NOT_RUN` | 81 |
| `GET` | `/api/app/v1/me/wecom` | YES | 有限2xx | `NOT_RUN` | 82 |
| `PUT` | `/api/app/v1/me/wecom` | NO | 未见认证 | `NOT_RUN` | 83 |
| `GET` | `/api/app/v1/my/activities` | YES | 有限2xx | `NOT_RUN` | 545 |
| `GET` | `/api/app/v1/my/activities/{activityId}/check-in` | NO | 仅非2xx | `NOT_RUN` | 478 |
| `POST` | `/api/app/v1/my/activities/{activityId}/check-in` | NO | 未见认证 | `NOT_RUN` | 477 |
| `POST` | `/api/app/v1/my/activities/{activityId}/check-out` | NO | 未见认证 | `NOT_RUN` | 479 |
| `GET` | `/api/app/v1/my/activities/{activityId}/feedback` | NO | 仅非2xx | `NOT_RUN` | 449 |
| `PUT` | `/api/app/v1/my/activities/{activityId}/feedback` | NO | 仅非2xx | `NOT_RUN` | 448 |
| `GET` | `/api/app/v1/my/activity-batch-jobs` | YES | 有限2xx | `NOT_RUN` | 371 |
| `GET` | `/api/app/v1/my/activity-batch-jobs/{jobId}` | NO | 仅非2xx | `NOT_RUN` | 372 |
| `POST` | `/api/app/v1/my/activity-batch-jobs/{jobId}/cancel` | NO | 未见认证 | `NOT_RUN` | 375 |
| `GET` | `/api/app/v1/my/activity-batch-jobs/{jobId}/items` | NO | 仅非2xx | `NOT_RUN` | 373 |
| `POST` | `/api/app/v1/my/activity-batch-jobs/{jobId}/retry-failed` | NO | 未见认证 | `NOT_RUN` | 374 |
| `POST` | `/api/app/v1/my/activity-invitations/{invitationId}/accept` | NO | 未见认证 | `NOT_RUN` | 562 |
| `POST` | `/api/app/v1/my/activity-invitations/{invitationId}/decline` | NO | 未见认证 | `NOT_RUN` | 563 |
| `POST` | `/api/app/v1/my/attendance-member-credential/render` | NO | 仅非2xx | `NOT_RUN` | 513 |
| `GET` | `/api/app/v1/my/attendance-records` | YES | 有限2xx | `NOT_RUN` | 480 |
| `GET` | `/api/app/v1/my/certificates` | YES | 有限2xx | `NOT_RUN` | 406 |
| `GET` | `/api/app/v1/my/managed-activities` | YES | 有限2xx | `NOT_RUN` | 312 |
| `POST` | `/api/app/v1/my/managed-activities` | NO | 未见认证 | `BLOCKED` | 313 |
| `GET` | `/api/app/v1/my/managed-activities/contribution-policy-options` | NO | 仅非2xx | `NOT_RUN` | 220 |
| `GET` | `/api/app/v1/my/managed-activities/control-plane/status` | YES | 有限2xx | `NOT_RUN` | 235 |
| `POST` | `/api/app/v1/my/managed-activities/emergency` | NO | 未见认证 | `NOT_RUN` | 238 |
| `POST` | `/api/app/v1/my/managed-activities/from-template` | NO | 未见认证 | `NOT_RUN` | 236 |
| `GET` | `/api/app/v1/my/managed-activities/metric-set-options` | NO | 仅非2xx | `NOT_RUN` | 213 |
| `GET` | `/api/app/v1/my/managed-activities/organization-options` | YES | 仅非2xx | `NOT_RUN` | 311 |
| `POST` | `/api/app/v1/my/managed-activities/outcome-reports/query` | NO | 仅非2xx | `NOT_RUN` | 308 |
| `POST` | `/api/app/v1/my/managed-activities/professional` | NO | 未见认证 | `NOT_RUN` | 237 |
| `GET` | `/api/app/v1/my/managed-activities/template-version-options` | NO | 仅非2xx | `NOT_RUN` | 214 |
| `GET` | `/api/app/v1/my/managed-activities/time-policy-options` | NO | 仅非2xx | `NOT_RUN` | 217 |
| `DELETE` | `/api/app/v1/my/managed-activities/{activityId}` | NO | 仅非2xx | `NOT_RUN` | 345 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}` | NO | 仅非2xx | `NOT_RUN` | 343 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}` | NO | 仅非2xx | `NOT_RUN` | 344 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/allocation-batches` | NO | 未见认证 | `NOT_RUN` | 565 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/allocation-batches/{batchId}` | NO | 仅非2xx | `NOT_RUN` | 568 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/allocation-batches/{batchId}/commit` | NO | 未见认证 | `NOT_RUN` | 566 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/allocation-batches/{batchId}/void` | NO | 未见认证 | `NOT_RUN` | 567 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/archive` | NO | 仅非2xx | `NOT_RUN` | 316 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/attendance-sheet-draft` | NO | 仅非2xx | `NOT_RUN` | 483 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/attendance-sheets` | NO | 仅非2xx | `NOT_RUN` | 484 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/attendance-sheets` | NO | 未见认证 | `NOT_RUN` | 485 |
| `DELETE` | `/api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}` | NO | 未见认证 | `NOT_RUN` | 488 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}` | NO | 仅非2xx | `NOT_RUN` | 486 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}` | NO | 未见认证 | `NOT_RUN` | 487 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}/resubmit` | NO | 未见认证 | `NOT_RUN` | 489 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/cancel` | NO | 仅非2xx | `NOT_RUN` | 314 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/change-reviews` | NO | 未见认证 | `NOT_RUN` | 347 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/check-ins` | NO | 仅非2xx | `NOT_RUN` | 482 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/clone` | NO | 仅非2xx | `NOT_RUN` | 318 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/collaborator-options` | NO | 仅非2xx | `NOT_RUN` | 366 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/collaborators` | NO | 未见认证 | `NOT_RUN` | 367 |
| `DELETE` | `/api/app/v1/my/managed-activities/{activityId}/collaborators/{assignmentId}` | NO | 未见认证 | `NOT_RUN` | 368 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/contribution-policy-selection` | NO | 仅非2xx | `NOT_RUN` | 221 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/contribution-policy-selection` | NO | 未见认证 | `NOT_RUN` | 222 |
| `PUT` | `/api/app/v1/my/managed-activities/{activityId}/cover` | NO | 仅非2xx | `NOT_RUN` | 321 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/declare-attendance-complete` | NO | 未见认证 | `NOT_RUN` | 353 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/direct-publish` | NO | 未见认证 | `NOT_RUN` | 350 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/ending-workbench` | NO | 仅非2xx | `NOT_RUN` | 310 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/evidence-seals` | NO | 未见认证 | `NOT_RUN` | 325 |
| `PUT` | `/api/app/v1/my/managed-activities/{activityId}/gallery` | NO | 仅非2xx | `NOT_RUN` | 322 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/invitations` | NO | 仅非2xx | `NOT_RUN` | 557 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/invitations` | NO | 未见认证 | `NOT_RUN` | 558 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/invitations/{invitationId}/revoke` | NO | 未见认证 | `NOT_RUN` | 559 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/metric-candidates` | NO | 未见认证 | `NOT_RUN` | 211 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/metric-candidates/{candidateId}` | NO | 仅非2xx | `NOT_RUN` | 212 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/metric-selection` | NO | 仅非2xx | `NOT_RUN` | 215 |
| `PUT` | `/api/app/v1/my/managed-activities/{activityId}/metric-selection` | NO | 未见认证 | `NOT_RUN` | 216 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite-participations` | NO | 未见认证 | `NOT_RUN` | 564 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/onsite/bulk-punch-jobs/{jobId}` | NO | 仅非2xx | `NOT_RUN` | 512 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/onsite/import-previews/{previewId}` | NO | 仅非2xx | `NOT_RUN` | 511 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/import-previews/{previewId}/execute` | NO | 未见认证 | `NOT_RUN` | 510 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/offline-packages/{packageId}/revoke` | NO | 未见认证 | `NOT_RUN` | 501 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/offline-packages/{packageId}/upload` | NO | 未见认证 | `NOT_RUN` | 502 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/onsite/offline-review-items` | NO | 仅非2xx | `NOT_RUN` | 503 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/offline-review-items/{reviewItemId}/approve` | NO | 未见认证 | `NOT_RUN` | 504 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/offline-review-items/{reviewItemId}/reject` | NO | 未见认证 | `NOT_RUN` | 505 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/punch-events/{eventId}/replace` | NO | 未见认证 | `NOT_RUN` | 499 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/punch-events/{eventId}/void` | NO | 未见认证 | `NOT_RUN` | 498 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/sessions/{sessionId}/bulk-punch-jobs` | NO | 未见认证 | `NOT_RUN` | 508 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/sessions/{sessionId}/early-departure-close` | NO | 未见认证 | `NOT_RUN` | 497 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/sessions/{sessionId}/import-previews` | NO | 未见认证 | `NOT_RUN` | 509 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/sessions/{sessionId}/offline-packages` | NO | 未见认证 | `NOT_RUN` | 500 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/sessions/{sessionId}/proxy-punch` | NO | 未见认证 | `NOT_RUN` | 507 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/onsite/sessions/{sessionId}/staff-scan` | NO | 未见认证 | `NOT_RUN` | 506 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/outcome-confirmations` | NO | 未见认证 | `NOT_RUN` | 205 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/outcome-confirmed` | NO | 仅非2xx | `NOT_RUN` | 208 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/outcome-corrections` | NO | 未见认证 | `NOT_RUN` | 206 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/outcome-corrections/{outcomeRevisionId}/cancel` | NO | 未见认证 | `NOT_RUN` | 207 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/outcome-report` | NO | 仅非2xx | `NOT_RUN` | 309 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/outcomes` | NO | 仅非2xx | `NOT_RUN` | 203 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/outcomes` | NO | 未见认证 | `NOT_RUN` | 202 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/outcomes/{outcomeRevisionId}` | NO | 仅非2xx | `NOT_RUN` | 204 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/positions` | NO | 仅非2xx | `NOT_RUN` | 361 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/positions` | NO | 仅非2xx | `NOT_RUN` | 362 |
| `DELETE` | `/api/app/v1/my/managed-activities/{activityId}/positions/{activityPositionId}` | NO | 仅非2xx | `NOT_RUN` | 364 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/positions/{activityPositionId}` | NO | 仅非2xx | `NOT_RUN` | 363 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/publish-reviews` | NO | 未见认证 | `NOT_RUN` | 346 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/qr-credentials/{credentialId}/render` | NO | 未见认证 | `NOT_RUN` | 496 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/qr-credentials/{credentialId}/revoke` | NO | 未见认证 | `NOT_RUN` | 495 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/qualification-rules` | NO | 仅非2xx | `NOT_RUN` | 323 |
| `PUT` | `/api/app/v1/my/managed-activities/{activityId}/qualification-rules` | NO | 未见认证 | `NOT_RUN` | 324 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/registration-form` | NO | 仅非2xx | `NOT_RUN` | 319 |
| `PUT` | `/api/app/v1/my/managed-activities/{activityId}/registration-form` | NO | 未见认证 | `NOT_RUN` | 320 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/registrations` | NO | 仅非2xx | `NOT_RUN` | 547 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/registrations/bulk-approve` | NO | 未见认证 | `NOT_RUN` | 548 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/registrations/bulk-reject` | NO | 未见认证 | `NOT_RUN` | 549 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/registrations/{registrationId}/approve` | NO | 未见认证 | `NOT_RUN` | 550 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/registrations/{registrationId}/cancel` | NO | 未见认证 | `NOT_RUN` | 552 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/registrations/{registrationId}/reject` | NO | 未见认证 | `NOT_RUN` | 551 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/registrations/{registrationId}/reopen` | NO | 未见认证 | `NOT_RUN` | 553 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/responsibilities` | NO | 仅非2xx | `NOT_RUN` | 365 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/reviews/withdraw` | NO | 未见认证 | `NOT_RUN` | 348 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/sessions` | NO | 仅非2xx | `NOT_RUN` | 326 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/sessions` | NO | 仅非2xx | `NOT_RUN` | 327 |
| `DELETE` | `/api/app/v1/my/managed-activities/{activityId}/sessions/{sessionId}` | NO | 仅非2xx | `NOT_RUN` | 329 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/sessions/{sessionId}` | NO | 仅非2xx | `NOT_RUN` | 328 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/sessions/{sessionId}/positions` | NO | 仅非2xx | `NOT_RUN` | 330 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/sessions/{sessionId}/positions` | NO | 未见认证 | `NOT_RUN` | 331 |
| `DELETE` | `/api/app/v1/my/managed-activities/{activityId}/sessions/{sessionId}/positions/{positionId}` | NO | 未见认证 | `NOT_RUN` | 333 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/sessions/{sessionId}/positions/{positionId}` | NO | 未见认证 | `NOT_RUN` | 332 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/sessions/{sessionId}/qr-credentials` | NO | 仅非2xx | `NOT_RUN` | 493 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/sessions/{sessionId}/qr-credentials/{action}/issue` | NO | 未见认证 | `NOT_RUN` | 494 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/settlement` | NO | 仅非2xx | `NOT_RUN` | 337 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/settlement/close` | NO | 未见认证 | `NOT_RUN` | 336 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/settlement/generate` | NO | 未见认证 | `NOT_RUN` | 334 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/settlement/items` | NO | 仅非2xx | `NOT_RUN` | 338 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/settlement/items/{identityId}` | NO | 未见认证 | `NOT_RUN` | 339 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/settlement/submit` | NO | 未见认证 | `NOT_RUN` | 335 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/settlement/versions/{versionId}` | NO | 仅非2xx | `NOT_RUN` | 340 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/settlement/versions/{versionId}/resubmit` | NO | 未见认证 | `NOT_RUN` | 341 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/submit-change-review` | NO | 未见认证 | `NOT_RUN` | 351 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/submit-publish-review` | NO | 未见认证 | `NOT_RUN` | 349 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/template-resolution` | NO | 仅非2xx | `NOT_RUN` | 342 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/terminate` | NO | 未见认证 | `NOT_RUN` | 315 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-corrections` | NO | 仅非2xx | `NOT_RUN` | 193 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/time-corrections` | NO | 未见认证 | `NOT_RUN` | 192 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-corrections/{requestId}` | NO | 仅非2xx | `NOT_RUN` | 194 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/time-corrections/{requestId}/commit` | NO | 未见认证 | `NOT_RUN` | 198 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/time-corrections/{requestId}/commit-jobs` | NO | 未见认证 | `NOT_RUN` | 199 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-corrections/{requestId}/commit-jobs/{jobId}` | NO | 仅非2xx | `NOT_RUN` | 200 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/time-corrections/{requestId}/commit-jobs/{jobId}/retry` | NO | 未见认证 | `NOT_RUN` | 201 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/time-corrections/{requestId}/prepare` | NO | 未见认证 | `NOT_RUN` | 197 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/time-corrections/{requestId}/resubmit` | NO | 未见认证 | `NOT_RUN` | 196 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/time-corrections/{requestId}/review` | NO | 未见认证 | `NOT_RUN` | 195 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-policy-selection` | NO | 仅非2xx | `NOT_RUN` | 218 |
| `PATCH` | `/api/app/v1/my/managed-activities/{activityId}/time-policy-selection` | NO | 未见认证 | `NOT_RUN` | 219 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-settlement` | NO | 仅非2xx | `NOT_RUN` | 181 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/time-settlement/allocations` | NO | 未见认证 | `NOT_RUN` | 189 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-settlement/allocations/{allocationRevisionId}` | NO | 仅非2xx | `NOT_RUN` | 183 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/time-settlement/prepare` | NO | 未见认证 | `NOT_RUN` | 190 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-settlement/revisions/{timeRevisionId}/buckets` | NO | 仅非2xx | `NOT_RUN` | 184 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-settlement/revisions/{timeRevisionId}/ledger` | NO | 仅非2xx | `NOT_RUN` | 185 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-settlement/revisions/{timeRevisionId}/shadow` | NO | 仅非2xx | `NOT_RUN` | 187 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-settlement/revisions/{timeRevisionId}/sources` | NO | 仅非2xx | `NOT_RUN` | 188 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-settlement/sources` | NO | 仅非2xx | `NOT_RUN` | 182 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/time-settlement/submit` | NO | 未见认证 | `NOT_RUN` | 191 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/time-settlement/versions/{settlementVersionId}/correction-ledger` | NO | 仅非2xx | `NOT_RUN` | 186 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/transfer-initiator` | NO | 未见认证 | `NOT_RUN` | 369 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/transfer-owner` | NO | 未见认证 | `NOT_RUN` | 370 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/unarchive` | NO | 仅非2xx | `NOT_RUN` | 317 |
| `GET` | `/api/app/v1/my/managed-activities/{activityId}/visitors` | NO | 仅非2xx | `NOT_RUN` | 560 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/visitors` | NO | 未见认证 | `NOT_RUN` | 561 |
| `POST` | `/api/app/v1/my/managed-activities/{activityId}/withdraw-publish-review` | NO | 未见认证 | `NOT_RUN` | 352 |
| `GET` | `/api/app/v1/my/participation-ledger` | YES | 有限2xx | `NOT_RUN` | 376 |
| `GET` | `/api/app/v1/my/participation-summary` | YES | 有限2xx | `NOT_RUN` | 481 |
| `GET` | `/api/app/v1/my/participation-time-proof` | NO | 仅非2xx | `NOT_RUN` | 377 |
| `GET` | `/api/app/v1/my/registrations` | YES | 有限2xx | `NOT_RUN` | 542 |
| `POST` | `/api/app/v1/my/registrations` | NO | 仅非2xx | `NOT_RUN` | 543 |
| `GET` | `/api/app/v1/my/registrations/{id}` | YES | 仅非2xx | `NOT_RUN` | 544 |
| `PATCH` | `/api/app/v1/my/registrations/{id}/cancel` | NO | 仅非2xx | `NOT_RUN` | 546 |
| `GET` | `/api/app/v1/notifications` | YES | 有限2xx | `NOT_RUN` | 435 |
| `POST` | `/api/app/v1/notifications/subscriptions/ack` | NO | 未见认证 | `NOT_RUN` | 436 |
| `GET` | `/api/app/v1/notifications/subscriptions/status` | NO | 有限2xx | `NOT_RUN` | 437 |
| `GET` | `/api/app/v1/notifications/unread-count` | YES | 有限2xx | `NOT_RUN` | 438 |
| `GET` | `/api/app/v1/notifications/{id}` | NO | 仅非2xx | `NOT_RUN` | 439 |
| `POST` | `/api/app/v1/notifications/{id}/read` | NO | 仅非2xx | `NOT_RUN` | 440 |
| `POST` | `/api/auth/v1/delegated-token` | NO | 公开/登录 | `NOT_RUN` | 578 |
| `POST` | `/api/auth/v1/login` | NO | 有限2xx | `NOT_RUN` | 5 |
| `POST` | `/api/auth/v1/login-sms` | NO | 公开/登录 | `NOT_RUN` | 16 |
| `POST` | `/api/auth/v1/login-sms/send-code` | NO | 公开/登录 | `NOT_RUN` | 15 |
| `POST` | `/api/auth/v1/login-wechat` | NO | 公开/登录 | `NOT_RUN` | 17 |
| `POST` | `/api/auth/v1/login-wecom` | NO | 公开/登录 | `NOT_RUN` | 21 |
| `POST` | `/api/auth/v1/login-wecom/authorize` | NO | 公开/登录 | `NOT_RUN` | 20 |
| `POST` | `/api/auth/v1/logout` | NO | 有限2xx | `NOT_RUN` | 7 |
| `POST` | `/api/auth/v1/logout-all` | NO | 仅非2xx | `NOT_RUN` | 8 |
| `POST` | `/api/auth/v1/password-reset` | NO | 公开/登录 | `NOT_RUN` | 14 |
| `POST` | `/api/auth/v1/password-reset/send-code` | NO | 公开/登录 | `NOT_RUN` | 13 |
| `POST` | `/api/auth/v1/refresh` | NO | 有限2xx | `NOT_RUN` | 6 |
| `POST` | `/api/auth/v1/service-token` | NO | 公开/登录 | `NOT_RUN` | 577 |
| `POST` | `/api/auth/v1/step-up/password` | NO | 仅非2xx | `NOT_RUN` | 9 |
| `POST` | `/api/auth/v1/step-up/sms` | NO | 仅非2xx | `NOT_RUN` | 11 |
| `POST` | `/api/auth/v1/step-up/sms/send-code` | NO | 仅非2xx | `NOT_RUN` | 10 |
| `POST` | `/api/auth/v1/step-up/wechat` | NO | 仅非2xx | `NOT_RUN` | 12 |
| `POST` | `/api/auth/v1/wechat-bind` | NO | 公开/登录 | `NOT_RUN` | 19 |
| `POST` | `/api/auth/v1/wechat-bind/send-code` | NO | 公开/登录 | `NOT_RUN` | 18 |
| `POST` | `/api/auth/v1/wecom-bind` | NO | 公开/登录 | `NOT_RUN` | 23 |
| `POST` | `/api/auth/v1/wecom-bind/authorize` | NO | 仅非2xx | `NOT_RUN` | 24 |
| `POST` | `/api/auth/v1/wecom-bind/send-code` | NO | 公开/登录 | `NOT_RUN` | 22 |
| `GET` | `/api/integration/v1/me` | NO | 公开/登录 | `NOT_RUN` | 583 |
| `GET` | `/api/integration/v1/reference/activity-types` | NO | 公开/登录 | `NOT_RUN` | 584 |
| `GET` | `/api/open/v1/contents` | NO | 公开/登录 | `NOT_RUN` | 671 |
| `GET` | `/api/open/v1/contents/{id}` | NO | 公开/登录 | `NOT_RUN` | 672 |
| `POST` | `/api/open/v1/recruitment/applications` | NO | 公开/登录 | `NOT_RUN` | 612 |
| `POST` | `/api/open/v1/recruitment/applications/query` | NO | 公开/登录 | `NOT_RUN` | 614 |
| `POST` | `/api/open/v1/recruitment/applications/query-by-phone` | NO | 公开/登录 | `NOT_RUN` | 617 |
| `POST` | `/api/open/v1/recruitment/applications/rebind-phone` | NO | 公开/登录 | `NOT_RUN` | 623 |
| `POST` | `/api/open/v1/recruitment/applications/rebind-wechat` | NO | 公开/登录 | `NOT_RUN` | 622 |
| `POST` | `/api/open/v1/recruitment/applications/recognize` | NO | 公开/登录 | `NOT_RUN` | 613 |
| `POST` | `/api/open/v1/recruitment/applications/withdraw` | NO | 公开/登录 | `NOT_RUN` | 621 |
| `POST` | `/api/open/v1/recruitment/certificate-claims` | NO | 公开/登录 | `NOT_RUN` | 618 |
| `POST` | `/api/open/v1/recruitment/certificate-claims/{id}/resubmit` | NO | 公开/登录 | `NOT_RUN` | 619 |
| `POST` | `/api/open/v1/recruitment/certificate-claims/{id}/withdraw` | NO | 公开/登录 | `NOT_RUN` | 620 |
| `GET` | `/api/open/v1/recruitment/certificate-standards` | NO | 公开/登录 | `NOT_RUN` | 611 |
| `POST` | `/api/open/v1/recruitment/identity/send-code` | NO | 公开/登录 | `NOT_RUN` | 615 |
| `POST` | `/api/open/v1/recruitment/identity/verify-code` | NO | 公开/登录 | `NOT_RUN` | 616 |
| `GET` | `/api/open/v1/recruitment/publicity` | NO | 公开/登录 | `NOT_RUN` | 610 |
| `GET` | `/api/system/v1/attachment-mime-configs` | NO | 仅非2xx | `NOT_RUN` | 596 |
| `POST` | `/api/system/v1/attachment-mime-configs` | NO | 未见认证 | `NOT_RUN` | 597 |
| `DELETE` | `/api/system/v1/attachment-mime-configs/{id}` | NO | 未见认证 | `NOT_RUN` | 600 |
| `GET` | `/api/system/v1/attachment-mime-configs/{id}` | NO | 仅非2xx | `NOT_RUN` | 598 |
| `PATCH` | `/api/system/v1/attachment-mime-configs/{id}` | NO | 未见认证 | `NOT_RUN` | 599 |
| `PATCH` | `/api/system/v1/attachment-mime-configs/{id}/status` | NO | 未见认证 | `NOT_RUN` | 601 |
| `GET` | `/api/system/v1/attachment-size-limit-configs` | NO | 仅非2xx | `NOT_RUN` | 602 |
| `POST` | `/api/system/v1/attachment-size-limit-configs` | NO | 未见认证 | `NOT_RUN` | 603 |
| `DELETE` | `/api/system/v1/attachment-size-limit-configs/{id}` | NO | 未见认证 | `NOT_RUN` | 606 |
| `GET` | `/api/system/v1/attachment-size-limit-configs/{id}` | NO | 仅非2xx | `NOT_RUN` | 604 |
| `PATCH` | `/api/system/v1/attachment-size-limit-configs/{id}` | NO | 未见认证 | `NOT_RUN` | 605 |
| `GET` | `/api/system/v1/attachment-type-configs` | NO | 仅非2xx | `NOT_RUN` | 590 |
| `POST` | `/api/system/v1/attachment-type-configs` | NO | 未见认证 | `NOT_RUN` | 591 |
| `DELETE` | `/api/system/v1/attachment-type-configs/{id}` | NO | 未见认证 | `NOT_RUN` | 594 |
| `GET` | `/api/system/v1/attachment-type-configs/{id}` | NO | 仅非2xx | `NOT_RUN` | 592 |
| `PATCH` | `/api/system/v1/attachment-type-configs/{id}` | NO | 未见认证 | `NOT_RUN` | 593 |
| `PATCH` | `/api/system/v1/attachment-type-configs/{id}/status` | NO | 未见认证 | `NOT_RUN` | 595 |
| `GET` | `/api/system/v1/audit-logs` | NO | 仅非2xx | `NOT_RUN` | 25 |
| `GET` | `/api/system/v1/audit-logs/{id}` | NO | 仅非2xx | `NOT_RUN` | 26 |
| `GET` | `/api/system/v1/authz/me/effective-permissions` | YES | 有限2xx | `NOT_RUN` | 88 |
| `GET` | `/api/system/v1/contribution-policies` | NO | 仅非2xx | `NOT_RUN` | 294 |
| `POST` | `/api/system/v1/contribution-policies` | NO | 未见认证 | `NOT_RUN` | 295 |
| `GET` | `/api/system/v1/contribution-policies/{id}` | NO | 仅非2xx | `NOT_RUN` | 296 |
| `GET` | `/api/system/v1/contribution-policies/{id}/versions` | NO | 仅非2xx | `NOT_RUN` | 297 |
| `POST` | `/api/system/v1/contribution-policies/{id}/versions` | NO | 未见认证 | `NOT_RUN` | 298 |
| `GET` | `/api/system/v1/contribution-policies/{id}/versions/{versionId}` | NO | 仅非2xx | `NOT_RUN` | 299 |
| `POST` | `/api/system/v1/contribution-policies/{id}/versions/{versionId}/activate` | NO | 未见认证 | `NOT_RUN` | 300 |
| `POST` | `/api/system/v1/contribution-policies/{id}/versions/{versionId}/retire` | NO | 未见认证 | `NOT_RUN` | 301 |
| `GET` | `/api/system/v1/contribution-rules` | NO | 仅非2xx | `NOT_RUN` | 443 |
| `POST` | `/api/system/v1/contribution-rules` | NO | 未见认证 | `NOT_RUN` | 444 |
| `DELETE` | `/api/system/v1/contribution-rules/{id}` | NO | 未见认证 | `NOT_RUN` | 447 |
| `GET` | `/api/system/v1/contribution-rules/{id}` | NO | 仅非2xx | `NOT_RUN` | 445 |
| `PATCH` | `/api/system/v1/contribution-rules/{id}` | NO | 未见认证 | `NOT_RUN` | 446 |
| `GET` | `/api/system/v1/contribution-shadow/windows` | NO | 仅非2xx | `NOT_RUN` | 452 |
| `GET` | `/api/system/v1/contribution-shadow/windows/{windowId}/attempts/{attemptId}/comparisons` | NO | 仅非2xx | `NOT_RUN` | 456 |
| `GET` | `/api/system/v1/contribution-shadow/windows/{windowId}/candidates` | NO | 仅非2xx | `NOT_RUN` | 454 |
| `GET` | `/api/system/v1/contribution-shadow/windows/{windowId}/candidates/{auditLogId}` | NO | 仅非2xx | `NOT_RUN` | 455 |
| `GET` | `/api/system/v1/contribution-shadow/windows/{windowId}/summary` | NO | 仅非2xx | `NOT_RUN` | 453 |
| `GET` | `/api/system/v1/delegation-grants` | NO | 仅非2xx | `NOT_RUN` | 580 |
| `POST` | `/api/system/v1/delegation-grants` | NO | 未见认证 | `NOT_RUN` | 579 |
| `GET` | `/api/system/v1/delegation-grants/{id}` | NO | 仅非2xx | `NOT_RUN` | 581 |
| `POST` | `/api/system/v1/delegation-grants/{id}/revoke` | NO | 未见认证 | `NOT_RUN` | 582 |
| `GET` | `/api/system/v1/dict-items` | NO | 有限2xx | `NOT_RUN` | 106 |
| `POST` | `/api/system/v1/dict-items` | NO | 未见认证 | `NOT_RUN` | 107 |
| `GET` | `/api/system/v1/dict-items/tree` | NO | 仅非2xx | `NOT_RUN` | 108 |
| `DELETE` | `/api/system/v1/dict-items/{id}` | NO | 未见认证 | `NOT_RUN` | 111 |
| `GET` | `/api/system/v1/dict-items/{id}` | NO | 仅非2xx | `NOT_RUN` | 109 |
| `PATCH` | `/api/system/v1/dict-items/{id}` | NO | 未见认证 | `NOT_RUN` | 110 |
| `PATCH` | `/api/system/v1/dict-items/{id}/status` | NO | 未见认证 | `NOT_RUN` | 112 |
| `GET` | `/api/system/v1/dict-types` | YES | 有限2xx | `NOT_RUN` | 100 |
| `POST` | `/api/system/v1/dict-types` | NO | 未见认证 | `NOT_RUN` | 101 |
| `DELETE` | `/api/system/v1/dict-types/{id}` | NO | 未见认证 | `NOT_RUN` | 104 |
| `GET` | `/api/system/v1/dict-types/{id}` | NO | 仅非2xx | `NOT_RUN` | 102 |
| `PATCH` | `/api/system/v1/dict-types/{id}` | NO | 未见认证 | `NOT_RUN` | 103 |
| `PATCH` | `/api/system/v1/dict-types/{id}/status` | NO | 未见认证 | `NOT_RUN` | 105 |
| `GET` | `/api/system/v1/health` | NO | 有限2xx | `NOT_RUN` | 2 |
| `GET` | `/api/system/v1/health/live` | NO | 公开/登录 | `NOT_RUN` | 3 |
| `GET` | `/api/system/v1/health/ready` | NO | 公开/登录 | `NOT_RUN` | 4 |
| `GET` | `/api/system/v1/permissions` | NO | 仅非2xx | `NOT_RUN` | 27 |
| `POST` | `/api/system/v1/permissions` | NO | 未见认证 | `NOT_RUN` | 28 |
| `GET` | `/api/system/v1/permissions/catalog` | NO | 仅非2xx | `NOT_RUN` | 29 |
| `DELETE` | `/api/system/v1/permissions/{id}` | NO | 未见认证 | `NOT_RUN` | 31 |
| `PATCH` | `/api/system/v1/permissions/{id}` | NO | 未见认证 | `NOT_RUN` | 30 |
| `GET` | `/api/system/v1/rbac/me/permissions` | YES | 有限2xx | `NOT_RUN` | 44 |
| `POST` | `/api/system/v1/rbac/reload` | NO | 未见认证 | `NOT_RUN` | 45 |
| `GET` | `/api/system/v1/realname-settings` | NO | 仅非2xx | `NOT_RUN` | 607 |
| `PATCH` | `/api/system/v1/realname-settings` | NO | 未见认证 | `NOT_RUN` | 608 |
| `POST` | `/api/system/v1/realname-settings/reset-credentials` | NO | 未见认证 | `NOT_RUN` | 609 |
| `GET` | `/api/system/v1/roles` | NO | 仅非2xx | `NOT_RUN` | 32 |
| `POST` | `/api/system/v1/roles` | NO | 未见认证 | `NOT_RUN` | 33 |
| `GET` | `/api/system/v1/roles/options` | NO | 仅非2xx | `NOT_RUN` | 34 |
| `DELETE` | `/api/system/v1/roles/{id}` | NO | 未见认证 | `NOT_RUN` | 37 |
| `GET` | `/api/system/v1/roles/{id}` | NO | 仅非2xx | `NOT_RUN` | 35 |
| `PATCH` | `/api/system/v1/roles/{id}` | NO | 未见认证 | `NOT_RUN` | 36 |
| `GET` | `/api/system/v1/roles/{id}/permissions` | NO | 仅非2xx | `NOT_RUN` | 38 |
| `PUT` | `/api/system/v1/roles/{id}/permissions` | NO | 未见认证 | `NOT_RUN` | 39 |
| `POST` | `/api/system/v1/roles/{id}/permissions/preview` | NO | 未见认证 | `NOT_RUN` | 40 |
| `GET` | `/api/system/v1/service-principals` | NO | 仅非2xx | `NOT_RUN` | 570 |
| `POST` | `/api/system/v1/service-principals` | NO | 未见认证 | `NOT_RUN` | 569 |
| `GET` | `/api/system/v1/service-principals/{id}` | NO | 仅非2xx | `NOT_RUN` | 571 |
| `PATCH` | `/api/system/v1/service-principals/{id}` | NO | 未见认证 | `NOT_RUN` | 572 |
| `GET` | `/api/system/v1/service-principals/{id}/credentials` | NO | 仅非2xx | `NOT_RUN` | 575 |
| `POST` | `/api/system/v1/service-principals/{id}/credentials` | NO | 未见认证 | `NOT_RUN` | 574 |
| `POST` | `/api/system/v1/service-principals/{id}/credentials/{credentialId}/revoke` | NO | 未见认证 | `NOT_RUN` | 576 |
| `PATCH` | `/api/system/v1/service-principals/{id}/status` | NO | 未见认证 | `NOT_RUN` | 573 |
| `GET` | `/api/system/v1/sms-send-logs` | NO | 仅非2xx | `NOT_RUN` | 49 |
| `GET` | `/api/system/v1/sms-settings` | NO | 仅非2xx | `NOT_RUN` | 46 |
| `PATCH` | `/api/system/v1/sms-settings` | NO | 未见认证 | `NOT_RUN` | 47 |
| `POST` | `/api/system/v1/sms-settings/reset-credentials` | NO | 未见认证 | `NOT_RUN` | 48 |
| `GET` | `/api/system/v1/storage-settings` | NO | 仅非2xx | `NOT_RUN` | 97 |
| `PATCH` | `/api/system/v1/storage-settings` | NO | 未见认证 | `NOT_RUN` | 98 |
| `POST` | `/api/system/v1/storage-settings/reset-credentials` | NO | 未见认证 | `NOT_RUN` | 99 |
| `GET` | `/api/system/v1/users/{userId}/roles` | NO | 仅非2xx | `NOT_RUN` | 41 |
| `POST` | `/api/system/v1/users/{userId}/roles` | NO | 未见认证 | `NOT_RUN` | 42 |
| `DELETE` | `/api/system/v1/users/{userId}/roles/{roleId}` | NO | 未见认证 | `NOT_RUN` | 43 |
| `GET` | `/api/system/v1/wechat-settings` | NO | 仅非2xx | `NOT_RUN` | 50 |
| `PATCH` | `/api/system/v1/wechat-settings` | NO | 未见认证 | `NOT_RUN` | 51 |
| `POST` | `/api/system/v1/wechat-settings/reset-credentials` | NO | 未见认证 | `NOT_RUN` | 52 |
| `GET` | `/api/system/v1/wecom-settings` | NO | 仅非2xx | `NOT_RUN` | 53 |
| `PATCH` | `/api/system/v1/wecom-settings` | NO | 未见认证 | `NOT_RUN` | 54 |
| `POST` | `/api/system/v1/wecom-settings/reset-credentials` | NO | 未见认证 | `NOT_RUN` | 55 |
| `POST` | `/api/system/v1/wecom-settings/test-connection` | NO | 未见认证 | `NOT_RUN` | 56 |

</details>

历史索引来源是 `SRVF-API-inventory-20261112.zip` 的 `evidence/older-coverage-current.json`，ZIP SHA-256 `c0ad955da7608690ce254dff63d46beeeee44527b336966ccfd2941f8c05dcba`，该成员 SHA-256 `860dc0886fc3cc2b0ea46021e8c4848f6da6bd69cd3dc654abe43889af09e03b`。该索引包未包含所指原始回执；本轮另从 `SRVF-API-Test-Evidence-2026-11-11.zip` 核验下列 93 条原回执，原包 SHA-256 `1005fda8ab38c976f5fa01fd16fd6c3898180b88253efec63f7450fe43dfc004`。只记录字段名和证据定位，具体值与对象 ID 均脱敏；完整运行时请求头、服务端堆栈及历史与现网精确部署提交均为 UNKNOWN。

<details>
<summary>展开：17 个历史 500 的逐项原回执</summary>

| 方法与路径 | 历史时间（+08） | 角色 | 响应 | 请求 ID | 已记录字段名 | 原包内回执 | 本轮同条件复测 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PATCH /api/app/v1/me/profile` | 2026-11-11T18:27:12.215032+08:00 | member_a | 500 / 50000 | `qa-r3-fault-regression-member_a-0010` | `body: nickname` | `evidence/authenticated-r3-fault-regression.jsonl:11` | NOT_RUN；前置条件未满足 |
| `GET /api/app/v1/my/managed-activities/{activityId}/time-corrections/{requestId}/commit-jobs/{jobId}` | 2026-11-11T18:26:47.626288+08:00 | member_a | 500 / 50000 | `qa-r3-fault-regression-member_a-0004` | 无已记录字段 | `evidence/authenticated-r3-fault-regression.jsonl:5` | NOT_RUN；前置条件未满足 |
| `POST /api/app/v1/my/managed-activities/{activityId}/cancel` | 2026-11-11T18:32:52.599868+08:00 | member_b | 500 / 50000 | `qa-negative-mutation-member_b-0011` | `body: operationKey, reason, strongConfirmed` | `evidence/authenticated-negative-mutation.jsonl:14` | NOT_RUN；前置条件未满足 |
| `POST /api/app/v1/my/managed-activities/{activityId}/archive` | 2026-11-11T18:33:01.970140+08:00 | member_b | 500 / 50000 | `qa-negative-mutation-member_b-0013` | `body: operationKey, reason` | `evidence/authenticated-negative-mutation.jsonl:18` | NOT_RUN；前置条件未满足 |
| `POST /api/app/v1/my/managed-activities/{activityId}/unarchive` | 2026-11-11T18:33:06.069235+08:00 | member_b | 500 / 50000 | `qa-negative-mutation-member_b-0014` | `body: operationKey, reason` | `evidence/authenticated-negative-mutation.jsonl:20` | NOT_RUN；前置条件未满足 |
| `POST /api/app/v1/my/managed-activities/{activityId}/clone` | 2026-11-11T18:32:56.716016+08:00 | member_b | 500 / 50000 | `qa-negative-mutation-member_b-0012` | `body: title` | `evidence/authenticated-negative-mutation.jsonl:16` | NOT_RUN；前置条件未满足 |
| `POST /api/app/v1/my/managed-activities/{activityId}/sessions` | 2026-11-11T18:33:20.157739+08:00 | member_b | 500 / 50000 | `qa-negative-mutation-member_b-0017` | `body: capacity, checkInCloseAt, checkInOpenAt, checkOutCloseAt, checkOutOpenAt, code, earlyLeaveThresholdMinutes, endAt, lateGraceMinutes, locationRequired, locationText, name, sortOrder, startAt` | `evidence/authenticated-negative-mutation.jsonl:26` | NOT_RUN；前置条件未满足 |
| `PATCH /api/app/v1/my/managed-activities/{activityId}/sessions/{sessionId}` | 2026-11-11T18:33:24.508200+08:00 | member_b | 500 / 50000 | `qa-negative-mutation-member_b-0018` | `body: name` | `evidence/authenticated-negative-mutation.jsonl:28` | NOT_RUN；前置条件未满足 |
| `DELETE /api/app/v1/my/managed-activities/{activityId}/sessions/{sessionId}` | 2026-11-11T18:33:28.758897+08:00 | member_b | 500 / 50000 | `qa-negative-mutation-member_b-0019` | 无已记录字段 | `evidence/authenticated-negative-mutation.jsonl:30` | NOT_RUN；前置条件未满足 |
| `GET /api/app/v1/my/managed-activities/{activityId}/template-resolution` | 2026-11-11T18:26:52.167313+08:00 | member_a | 500 / 50000 | `qa-r3-fault-regression-member_a-0005` | 无已记录字段 | `evidence/authenticated-r3-fault-regression.jsonl:6` | NOT_RUN；前置条件未满足 |
| `POST /api/app/v1/me/insurances` | 2026-11-11T18:27:28.972548+08:00 | member_a | 500 / 50000 | `qa-r3-fault-regression-member_a-0014` | `body: coverageEnd, coverageStart, insurerName, policyNumber` | `evidence/authenticated-r3-fault-regression.jsonl:17` | NOT_RUN；前置条件未满足 |
| `PATCH /api/app/v1/me/insurances/{id}` | 2026-11-11T18:34:11.099986+08:00 | member_b | 500 / 50000 | `qa-negative-mutation-member_b-0028` | `body: expectedVersion, insurerName` | `evidence/authenticated-negative-mutation.jsonl:48` | NOT_RUN；前置条件未满足 |
| `DELETE /api/app/v1/me/insurances/{id}` | 2026-11-11T18:34:15.873132+08:00 | member_b | 500 / 50000 | `qa-negative-mutation-member_b-0029` | `query: expectedVersion` | `evidence/authenticated-negative-mutation.jsonl:50` | NOT_RUN；前置条件未满足 |
| `GET /api/app/v1/my/managed-activities/{activityId}/onsite/offline-review-items` | 2026-11-11T18:26:56.261970+08:00 | member_a | 500 / 50000 | `qa-r3-fault-regression-member_a-0006` | `query: page, pageSize` | `evidence/authenticated-r3-fault-regression.jsonl:7` | NOT_RUN；前置条件未满足 |
| `GET /api/app/v1/my/managed-activities/{activityId}/onsite/import-previews/{previewId}` | 2026-11-11T18:27:00.210246+08:00 | member_a | 500 / 50000 | `qa-r3-fault-regression-member_a-0007` | `query: page, pageSize` | `evidence/authenticated-r3-fault-regression.jsonl:8` | NOT_RUN；前置条件未满足 |
| `GET /api/app/v1/my/managed-activities/{activityId}/onsite/bulk-punch-jobs/{jobId}` | 2026-11-11T18:27:04.065659+08:00 | member_a | 500 / 50000 | `qa-r3-fault-regression-member_a-0008` | 无已记录字段 | `evidence/authenticated-r3-fault-regression.jsonl:9` | NOT_RUN；前置条件未满足 |
| `POST /api/app/v1/activities/{activityId}/registration-upload-sessions` | 2026-11-11T18:34:06.991384+08:00 | member_b | 500 / 50000 | `qa-negative-mutation-member_b-0027` | 无已记录字段 | `evidence/authenticated-negative-mutation.jsonl:46` | NOT_RUN；前置条件未满足 |

</details>

**中间样本，非同条件回归（DEPLOYED_HTTP）**：11 月 12 日普通 A 对另一组合成不存在对象访问上述四条读取方法，均返回 404/20001：`template-resolution` 请求 ID `aa8a4c99-ce6b-42ec-98e8-0680e68070ba`；`offline-review-items` 为 `ec32b787-2e43-48ab-9e7a-7a94a0ed96fd`；`import-previews` 为 `18a975ad-8409-47e1-a058-e445791f216e`；`bulk-punch-jobs` 为 `a00dbbe5-08ef-4fb5-91ce-9084dcae729f`。它们不能关闭原 500。

<details>
<summary>展开：38 个历史 HTML 404 的逐项原回执</summary>

| 方法与路径 | 历史原回执：时间（+08）、角色、请求 ID、来源 | 已记录字段名 | 11 月 12 日或本轮有限样本 | 同条件回归状态 |
| --- | --- | --- | --- | --- |
| `GET /api/system/v1/health` | 2026-11-11T15:47:12.680994+08:00；anonymous；ID `未提供`；`evidence/identity-health.json:records[1]`<br>2026-11-11T18:26:40.971404+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:4` | 无已记录字段<br>无已记录字段 | 2026-11-12T14:51:34.548640+08:00 200/0 ID `cmwd6weo57e4219fcdd447c7699ba2f70`<br>2026-11-13T02:54:45.622126+08:00 200/0 ID `srvf-qa-20261113-404-health`（客户端指定并回显） | 匿名、方法、路径、查询已复测；其余条件 UNKNOWN |
| `GET /api/system/v1/health/live` | 2026-11-11T15:47:16.982128+08:00；anonymous；ID `未提供`；`evidence/identity-health.json:records[2]`<br>2026-11-11T18:26:42.083413+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:3` | 无已记录字段<br>无已记录字段 | 2026-11-13T02:54:45.722135+08:00 200/0 ID `srvf-qa-20261113-404-health-live`（客户端指定并回显） | 匿名、方法、路径、查询已复测；其余条件 UNKNOWN |
| `GET /api/system/v1/health/ready` | 2026-11-11T15:47:20.965086+08:00；anonymous；ID `未提供`；`evidence/identity-health.json:records[3]`<br>2026-11-11T18:26:45.642526+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:5` | 无已记录字段<br>无已记录字段 | 2026-11-12T14:51:34.641492+08:00 200/0 ID `cmwd6wer1a29b0383f019e2a40b229f9d`<br>2026-11-13T02:54:45.800060+08:00 200/0 ID `srvf-qa-20261113-404-health-ready`（客户端指定并回显） | 匿名、方法、路径、查询已复测；其余条件 UNKNOWN |
| `POST /api/auth/v1/logout-all` | 2026-11-11T15:49:20.950216+08:00；anonymous；ID `未提供`；`evidence/no_auth.jsonl:line 1`<br>2026-11-11T18:30:07.633095+08:00；lifecycle；ID `未提供`；`evidence/authenticated-route-regression.jsonl:43` | `body: __srvf_audit_invalid_field`<br>无已记录字段 | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/step-up/password` | 2026-11-11T15:49:22.050334+08:00；anonymous；ID `未提供`；`evidence/no_auth.jsonl:line 2`<br>2026-11-11T18:26:57.746312+08:00；lifecycle；ID `未提供`；`evidence/authenticated-route-regression.jsonl:10` | `body: __srvf_audit_invalid_field`<br>`body: action, password` | 2026-11-12T14:51:34.948723+08:00 401/40100 ID `cmwd6wezed64d061742bb82bef8d6f5e8` | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/step-up/sms/send-code` | 2026-11-11T15:49:33.514514+08:00；anonymous；ID `未提供`；`evidence/no_auth.jsonl:line 3`<br>2026-11-11T18:27:01.910798+08:00；lifecycle；ID `未提供`；`evidence/authenticated-route-regression.jsonl:11` | `body: __srvf_audit_invalid_field`<br>`body: action` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/step-up/sms` | 2026-11-11T15:49:34.614923+08:00；anonymous；ID `未提供`；`evidence/no_auth.jsonl:line 4`<br>2026-11-11T18:27:05.897640+08:00；lifecycle；ID `未提供`；`evidence/authenticated-route-regression.jsonl:12` | `body: __srvf_audit_invalid_field`<br>`body: action, code` | 无本轮样本<br>2026-11-13T03:43:39.594+08:00 401/40100 ID `cmwdyhbd213b818ccb38a15b2a0b22a20`（匿名 phase1 无效请求体） | 匿名原无效请求体已复测；认证条件 UNKNOWN |
| `POST /api/auth/v1/step-up/wechat` | 2026-11-11T15:49:39.244842+08:00；anonymous；ID `未提供`；`evidence/no_auth.jsonl:line 5`<br>2026-11-11T18:27:09.955651+08:00；lifecycle；ID `未提供`；`evidence/authenticated-route-regression.jsonl:13` | `body: __srvf_audit_invalid_field`<br>`body: action, code` | 无本轮样本<br>2026-11-13T03:43:39.695+08:00 401/40100 ID `cmwdyhbg21b2b3972e0e1188e53a1e778`（匿名 phase1 无效请求体） | 匿名原无效请求体已复测；认证条件 UNKNOWN |
| `POST /api/auth/v1/password-reset/send-code` | 2026-11-11T15:49:16.959113+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[3] / PUB-004`<br>2026-11-11T18:27:13.964848+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:14` | 无已记录字段<br>`body: phone` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/password-reset` | 2026-11-11T15:49:21.774807+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[4] / PUB-005`<br>2026-11-11T18:27:18.018740+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:15` | 无已记录字段<br>`body: code, newPassword, phone` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/login-sms/send-code` | 2026-11-11T15:49:26.506701+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[5] / PUB-006`<br>2026-11-11T18:27:22.126262+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:16` | 无已记录字段<br>`body: phone` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/login-sms` | 2026-11-11T15:49:33.255148+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[6] / PUB-007`<br>2026-11-11T18:27:26.824479+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:17` | 无已记录字段<br>`body: code, phone` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/login-wechat` | 2026-11-11T15:49:37.934311+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[7] / PUB-008`<br>2026-11-11T18:27:31.423108+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:18` | 无已记录字段<br>`body: code` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/wechat-bind/send-code` | 2026-11-11T15:49:43.447029+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[8] / PUB-009`<br>2026-11-11T18:27:35.159418+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:19` | 无已记录字段<br>`body: phone` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/wechat-bind` | 2026-11-11T15:49:48.575207+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[9] / PUB-010`<br>2026-11-11T18:27:39.138068+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:20` | 无已记录字段<br>`body: code, phone, smsCode` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/login-wecom/authorize` | 2026-11-11T15:52:18.600099+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[37] / PUB-038`<br>2026-11-11T18:27:43.117196+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:21` | `body: returnPath`<br>`body: returnPath` | 无本轮样本<br>2026-11-13T03:38:24.850+08:00 400/40000 ID `cmwdyaki6a40d7585a2c2ab5b10d7d309`（匿名原无效请求体；未跟随跳转） | 匿名、方法、路径与无效请求体已复测；其余条件 UNKNOWN |
| `POST /api/auth/v1/login-wecom` | 2026-11-11T15:49:53.703682+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[11] / PUB-012`<br>2026-11-11T18:27:47.239215+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:22` | 无已记录字段<br>`body: code, state` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/wecom-bind/send-code` | 2026-11-11T15:49:58.545823+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[12] / PUB-013`<br>2026-11-11T18:27:51.304141+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:23` | 无已记录字段<br>`body: bindingTicket, phone` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/wecom-bind` | 2026-11-11T15:50:03.351655+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[13] / PUB-014`<br>2026-11-11T18:27:55.525774+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:24` | 无已记录字段<br>`body: bindingTicket, phone, smsCode` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/auth/v1/wecom-bind/authorize` | 2026-11-11T15:49:40.345009+08:00；anonymous；ID `未提供`；`evidence/no_auth.jsonl:line 6`<br>2026-11-11T18:30:02.991687+08:00；lifecycle；ID `未提供`；`evidence/authenticated-route-regression.jsonl:42` | `body: __srvf_audit_invalid_field`<br>`body: returnPath` | 2026-11-13T04:10:15.229+08:00 服务端日志时间 401 ID `srvf-qa-resume-f577c180847c416cad177c7e2ded53c7`；本地接收脚本异常，响应体和头部未捕获 | 匿名原无效请求体有状态样本；其余条件及响应类型 UNKNOWN |
| `POST /api/auth/v1/service-token` | 2026-11-11T16:02:11.241843+08:00；anonymous；ID `未提供`；`evidence/no_auth.jsonl:line 582`<br>2026-11-11T18:27:59.864667+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:25` | `body: __srvf_audit_invalid_field`<br>无已记录字段 | 2026-11-13T04:08:24.129+08:00 503/37030 ID `srvf-qa-resume-725f8f63ab0e42a0ae93ba0696bcbcdb`（客户端指定并回显；匿名原无效请求体） | 匿名原无效请求体已复测；请求头、版本和签发流程 UNKNOWN |
| `POST /api/auth/v1/delegated-token` | 2026-11-11T16:02:12.341885+08:00；anonymous；ID `未提供`；`evidence/no_auth.jsonl:line 583`<br>2026-11-11T18:28:04.934272+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:26` | `body: __srvf_audit_invalid_field`<br>`body: delegationGrantId` | 2026-11-13T04:08:24.371+08:00 401/37011 ID `srvf-qa-resume-f7aee42e68e447fcadcceee2aac08cfe`（客户端指定并回显；匿名原无效请求体） | 匿名原无效请求体已复测；请求头、版本和签发流程 UNKNOWN |
| `GET /api/open/v1/recruitment/publicity` | 2026-11-11T15:50:08.770148+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[14] / PUB-015`<br>2026-11-11T18:26:48.724294+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:6` | 无已记录字段<br>无已记录字段 | 2026-11-12T16:18:37.782848+08:00 200/0 ID `cmwda0cvufec4533d3df73f8084836e3b`<br>2026-11-13T02:54:45.883713+08:00 200/0 ID `srvf-qa-20261113-404-publicity`（客户端指定并回显） | 匿名、方法、路径、查询已复测；其余条件 UNKNOWN |
| `GET /api/open/v1/recruitment/certificate-standards` | 2026-11-11T15:50:15.283017+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[15] / PUB-016`<br>2026-11-11T18:26:49.824616+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:8` | 无已记录字段<br>无已记录字段 | 2026-11-12T14:54:37.057935+08:00 200/0 ID `cmwd70bhn2069ba9d71684fd21b8e238f`<br>2026-11-13T02:54:46.002946+08:00 200/0 ID `srvf-qa-20261113-404-certificate-standards`（客户端指定并回显） | 匿名、方法、路径、查询已复测；其余条件 UNKNOWN |
| `POST /api/open/v1/recruitment/applications` | 2026-11-11T15:50:21.531028+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[16] / PUB-017`<br>2026-11-11T18:28:09.285708+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:27` | 无已记录字段<br>`body: idCardImage, payload, signatureImage` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/open/v1/recruitment/applications/recognize` | 2026-11-11T15:50:26.535828+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[17] / PUB-018`<br>2026-11-11T18:28:13.061461+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:28` | 无已记录字段<br>`body: documentTypeCode, idCardImage` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/open/v1/recruitment/applications/query` | 2026-11-11T15:50:31.254341+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[18] / PUB-019`<br>2026-11-11T18:28:16.933479+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:29` | 无已记录字段<br>`body: wechatCode` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/open/v1/recruitment/identity/send-code` | 2026-11-11T15:50:37.254870+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[19] / PUB-020`<br>2026-11-11T18:28:22.032350+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:30` | 无已记录字段<br>`body: phone` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/open/v1/recruitment/identity/verify-code` | 2026-11-11T15:50:42.182679+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[20] / PUB-021`<br>2026-11-11T18:28:26.003598+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:31` | 无已记录字段<br>`body: code, phone` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/open/v1/recruitment/applications/query-by-phone` | 2026-11-11T15:50:48.246758+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[21] / PUB-022`<br>2026-11-11T18:28:29.826997+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:32` | 无已记录字段<br>`body: code, phone` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/open/v1/recruitment/certificate-claims` | 2026-11-11T15:50:53.199348+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[22] / PUB-023`<br>2026-11-11T18:28:33.463766+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:33` | 无已记录字段<br>`body: categoryHintCode, images` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/open/v1/recruitment/certificate-claims/{id}/resubmit` | 2026-11-11T15:50:58.063295+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[23] / PUB-024`<br>2026-11-11T18:28:37.017356+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:34` | 无已记录字段<br>`body: categoryHintCode, images, version` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/open/v1/recruitment/certificate-claims/{id}/withdraw` | 2026-11-11T15:51:03.317603+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[24] / PUB-025`<br>2026-11-11T18:28:41.450791+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:35` | 无已记录字段<br>`body: version` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/open/v1/recruitment/applications/withdraw` | 2026-11-11T15:51:08.519534+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[25] / PUB-026`<br>2026-11-11T18:28:45.350033+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:36` | 无已记录字段<br>`body: code, phone, wechatCode` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/open/v1/recruitment/applications/rebind-wechat` | 2026-11-11T15:51:13.905643+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[26] / PUB-027`<br>2026-11-11T18:28:49.046895+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:37` | 无已记录字段<br>`body: code, newWechatCode, phone` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `POST /api/open/v1/recruitment/applications/rebind-phone` | 2026-11-11T15:51:18.602200+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[27] / PUB-028`<br>2026-11-11T18:28:53.134336+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:38` | 无已记录字段<br>`body: code, newPhone, newPhoneCode, phone` | 无本轮样本 | NOT_RUN；原条件未全部复核 |
| `GET /api/open/v1/contents` | 2026-11-11T15:51:23.347508+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[28] / PUB-029`<br>2026-11-11T18:26:50.925797+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:7` | `query: pageSize`<br>`query: page, pageSize` | 2026-11-12T14:54:37.157216+08:00 200/0 ID `cmwd70bkja83aad1dea2074698c05457c`<br>2026-11-12T14:54:37.581221+08:00 400/40000 ID `cmwd70bn3388ddc83436365a656f9f39a`<br>2026-11-12T14:54:37.688778+08:00 400/40000 ID `cmwd70bzh807747f0bce6631d759a42bb`<br>2026-11-12T14:54:37.803746+08:00 200/0 ID `cmwd70c2da044c6c2c367bad2fd9fcc8d`<br>本轮 200/0 ID `srvf-qa-content-20261113-content-list`<br>2026-11-13T02:54:46.096125+08:00 200/0 ID `srvf-qa-20261113-404-contents-original-query`（客户端指定并回显） | 匿名、方法、路径、查询已复测；其余条件 UNKNOWN |
| `GET /api/open/v1/contents/{id}` | 2026-11-11T15:51:28.374859+08:00；anonymous；ID `未提供`；`evidence/public-tests.json:records[29] / PUB-030`<br>2026-11-11T18:26:53.858768+08:00；anonymous；ID `未提供`；`evidence/authenticated-route-regression.jsonl:9` | 无已记录字段<br>无已记录字段 | 本轮 404/29001 ID `srvf-qa-content-20261113-content-absent-detail`<br>2026-11-13T03:15:32.701+08:00 404/29001 ID `srvf-qa-resume-20261113-history-html404-content-detail`（客户端指定并回显；同一历史合成对象） | 匿名、方法、历史对象路径与查询已复测；其余条件 UNKNOWN |

</details>

## 9. 2026-11-13 续测

本节承接 §8 和草稿 PR #1414，不把旧样本重新计作新通过。测试地址为 `https://dp.srvf.team`；时间为北京时间，实际部署 SHA 仍为 UNKNOWN。

| 时间 | 方法与实际目标 | 测试角色 | 本轮结果 | 请求 ID |
| --- | --- | --- | --- | --- |
| 03:14:17.513–03:14:18.938 | `GET https://dp.srvf.team/api/docs-json` | 匿名 | 200；版本 0.72.0、673 个方法与路径；SHA-256 `c79d0aa5014badbf69f19ed3b9ad550f22ddcee597fa7a4d773b1394167256fd`，与 §8 一致 | `cmwdxfjtlb96fe8bd576a63f451c597b8` |
| 03:15:32.701 | `GET https://dp.srvf.team/api/open/v1/contents/<历史合成对象ID>`（对象 ID 脱敏） | 匿名 | 404 / 29001，JSON；方法、历史合成对象路径及无查询条件与原第 3 轮对齐，原头部、两次部署和数据状态仍未知 | `srvf-qa-resume-20261113-history-html404-content-detail`（客户端指定并回显） |
| 约 03:20:14 | `GET https://dp.srvf.team/api/system/v1/dict-items/tree?typeId=<字典ID>`（ID 脱敏） | 现有测试管理员 | 200；队员级别字典中 `level-1` 显示正式队员 1 级且启用 | `cmwdxn7cybb38e64384f56eb85421905b` |
| 约 03:20:22 | `GET https://dp.srvf.team/api/system/v1/dict-items/tree?typeId=<字典ID>`（ID 脱敏） | 现有测试管理员 | 200；入队来源字典中 `manual` 显示管理员录入且启用 | `cmwdxndb5a1eadabb8b14dcf362f5dfa8` |
| 约 03:23:12 | `GET https://dp.srvf.team/api/admin/v1/members?memberNo=<合成编号>&page=1&pageSize=10`（编号脱敏） | 现有测试管理员 | 200 / code 0，total 0；当前查询范围未见匹配，不排除软删或永久占号 | `cmwdxr0yzea094ef490184429fad59452` |
| 03:25:50.655 | `GET https://dp.srvf.team/api/admin/v1/members?memberNo=<同一合成编号>&page=1&pageSize=10`（编号脱敏） | 现有测试管理员 | 200 / code 0，total 0；工具异常后的独立回查，仍不能单独排除软删、永久占号或晚提交 | `cmwdxuerg597e4d8a2058ba01832bbe43` |
| 03:35:32.784 | `GET https://dp.srvf.team/api/admin/v1/members?memberNo=<同一合成编号>&page=1&pageSize=10`（编号脱敏） | 现有测试管理员 | 200 / code 0，total 0；再次查重，仍不排除软删或永久占号 | `cmwdy6vyo9d7fde2a0becd44e0b791bc6` |
| 03:36:39.025 | `POST https://dp.srvf.team/api/admin/v1/members` | 现有测试管理员；合成成员 A | 201 / code 0；单次将浏览器请求体适配为 `memberNo`、`realName`、`memberSinceDate`、`memberOriginCode`、`gradeCode`，不表示原表单修复 | `cmwdy8b72d6d26240723c4022a5e0624f` |
| 03:37:30.751 | `GET https://dp.srvf.team/api/admin/v1/members?memberNo=<合成成员A编号>&page=1&pageSize=10`（编号脱敏） | 现有测试管理员 | 200 / code 0，total 1；与创建回执的成员 ID 和合成字段一致，状态 ACTIVE；列表未返回 version | `cmwdy9exof934315c251c82a237bf1e93` |
| 03:38:24.850 | `POST https://dp.srvf.team/api/auth/v1/login-wecom/authorize` | 匿名；与历史第 3 轮相同的无效 `returnPath` 数组 | 400 / 40000，JSON；未返回 Location 或设置 Cookie，禁止自动跟随跳转 | `cmwdyaki6a40d7585a2c2ab5b10d7d309` |
| 03:39:52.815 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员A-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；合成字段与创建回执一致，ACTIVE，`hasAccount=false`，未返回 version | `cmwdycgeycb4390278d723763357249e0` |
| 03:39:52.817 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员A-ID>/memberships`（ID 脱敏） | 现有测试管理员 | 200 / code 0；空数组，初始无组织归属 | `cmwdycgfl9027f41a3b68d9b7cacdab46` |
| 03:40:59.525 | `GET https://dp.srvf.team/api/system/v1/dict-items/tree?typeId=<组织类型字典ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；`functional-dept` 有 1 项且 ACTIVE | `cmwdydvt86dfc0260eaca016b9a2f18fc` |
| 03:43:19.405 | `GET https://dp.srvf.team/api/admin/v1/members?memberNo=<合成成员B编号>&page=1&pageSize=10`（编号脱敏） | 现有测试管理员 | 200 / code 0，total 0；精确查重 | `cmwdygvv07d8a0e01cffce3f8aff6ec2c` |
| 03:43:39.594 | `POST https://dp.srvf.team/api/auth/v1/step-up/sms` | 匿名；历史 phase1 无效请求体 | 401 / 40100，JSON；无 Cookie 或 Location | `cmwdyhbd213b818ccb38a15b2a0b22a20` |
| 03:43:39.695 | `POST https://dp.srvf.team/api/auth/v1/step-up/wechat` | 匿名；历史 phase1 无效请求体 | 401 / 40100，JSON；无 Cookie 或 Location | `cmwdyhbg21b2b3972e0e1188e53a1e778` |
| 03:44:00.825 | `POST https://dp.srvf.team/api/admin/v1/members` | 现有测试管理员；合成成员 B | 201 / code 0；单次请求体适配，独立回读见后续请求 | `cmwdyhrp97a81e83320371f4778c61c0b` |
| 03:44:30.716 | `GET https://dp.srvf.team/api/admin/v1/members?memberNo=<合成成员B编号>&page=1&pageSize=10`（编号脱敏） | 现有测试管理员 | 200 / code 0，total 1；ID 及合成字段与创建回执一致，ACTIVE，`hasAccount=false` | `cmwdyierjb89987ad47b71da20c5c43e9` |
| 03:44:46.495 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员B-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；字段一致，ACTIVE，`hasAccount=false`，无 version | `cmwdyiqz7a276700c09b9fb4e7cc8b825` |
| 03:44:46.498 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员B-ID>/memberships`（ID 脱敏） | 现有测试管理员 | 200 / code 0；空数组，初始无组织归属 | `cmwdyiqzg3ec1900e34f8222e31903ea4` |
| 03:45:47.246 | `GET https://dp.srvf.team/api/admin/v1/organizations?parentId=null&status=ACTIVE&page=1&pageSize=10` | 现有测试管理员 | 200 / code 0，total 1；返回节点 `parentId=null`、ACTIVE、类型 headquarters | `cmwdyk1tef48649d8e2a5a99cb3709b5b` |
| 03:48:12.188 | `GET https://dp.srvf.team/api/admin/v1/organizations?codeContains=<合成组织A编号>&page=1&pageSize=100`（编号脱敏） | 现有测试管理员 | 200 / code 0，total 0；子串查询无匹配，不排除历史软删占用 | `cmwdyn5pm841974d53b75f185128bac58` |
| 03:48:59.181 | `POST https://dp.srvf.team/api/admin/v1/organizations` | 现有测试管理员；合成组织 A | 201 / code 0；请求体字段为 `name`、`code`、`parentId`、`nodeTypeCode`，隔离浏览器适配写入；目标路由以容器有界日志和请求 ID 独立核实，不代表原组织表单通过 | `cmwdyo5ywee510c7c90e52df3222785bf` |
| 03:49:33.247 | `GET https://dp.srvf.team/api/admin/v1/organizations/<合成组织A-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；合成字段、父节点、functional-dept 及 ACTIVE 与创建回执一致，未返回 version | `cmwdyow71b4ea5c8f508a0856879ea184` |
| 03:52:36.513 | `GET https://dp.srvf.team/api/admin/v1/organizations?codeContains=<合成组织B编号>&page=1&pageSize=100`（编号脱敏） | 现有测试管理员 | 200 / code 0，total 0；子串查询无匹配 | `cmwdystln4daeadf8178d8fc51ff3ec7c` |
| 03:53:06.268 | `POST https://dp.srvf.team/api/admin/v1/organizations` | 现有测试管理员；合成组织 B | 201 / code 0；同源单次适配写入，目标路由以容器有界日志和请求 ID 独立核实 | `cmwdytgk3638205e7d7274fd1dbbe3c1d` |
| 03:53:31.923 | `GET https://dp.srvf.team/api/admin/v1/organizations/<合成组织B-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；合成字段、父节点、类型与 ACTIVE 一致；ID 不同于组织 A，未返回 version | `cmwdyu0cmd2f2e9ff157bcc556a40d649` |
| 03:55:28.313 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员A-ID>/memberships`（ID 脱敏） | 现有测试管理员 | 200 / code 0；空数组 | `cmwdywi7fff38218344dd3b72e4f68739` |
| 03:56:00.676 | `GET https://dp.srvf.team/api/admin/v1/organizations/<合成组织A-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；组织 ACTIVE | `cmwdyx74mbb452f98b8bd69c7ea8a3ce2` |
| 03:56:24.986 | `POST https://dp.srvf.team/api/admin/v1/members/<合成成员A-ID>/memberships`（ID 脱敏） | 现有测试管理员；成员 A、组织 A | 201 / code 0；单次适配请求体 `organizationId` 与 `membershipType=PRIMARY`；目标路由以有界容器日志核实 | `cmwdyxpvvb40eabf1a9d47e3c87a7c735` |
| 03:56:38.797 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员A-ID>/memberships`（ID 脱敏） | 现有测试管理员 | 200 / code 0；count 1，成员、组织和归属 ID 一致，PRIMARY / ACTIVE | `cmwdyy0jnc9b662d06599636345b170d9` |
| 03:56:59.562 | `GET https://dp.srvf.team/api/admin/v1/memberships/<合成归属A-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；成员、组织及归属 ID 一致，PRIMARY / ACTIVE，startedAt 有效，endedAt=null | `cmwdyygk91743af8a1a64169e3a1309c5` |
| 03:57:13.454 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员B-ID>/memberships`（ID 脱敏） | 现有测试管理员 | 200 / code 0；空数组 | `cmwdyyran03e0dbcc4a1e06fb167cfbd4` |
| 03:58:45.392 | `GET https://dp.srvf.team/api/admin/v1/organizations/<合成组织B-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；组织 ACTIVE | `cmwdz0q91d629e7f27886b8256a7c0f74` |
| 03:59:10.329 | `POST https://dp.srvf.team/api/admin/v1/members/<合成成员B-ID>/memberships`（ID 脱敏） | 现有测试管理员；成员 B、组织 B | 201 / code 0；单次适配请求体 `organizationId` 与 `membershipType=PRIMARY`；目标路由以有界容器日志核实 | `cmwdz19gm92c2f600e1395d0809fb93e2` |
| 03:59:24.930 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员B-ID>/memberships`（ID 脱敏） | 现有测试管理员 | 200 / code 0；count 1，成员、组织和归属 ID 一致，PRIMARY / ACTIVE | `cmwdz1ktc765d81a2e328771a59cfd95e` |
| 03:59:50.309 | `GET https://dp.srvf.team/api/admin/v1/memberships/<合成归属B-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；成员、组织及归属 ID 一致，PRIMARY / ACTIVE，startedAt 有效，endedAt=null | `cmwdz24b69b15e75ff5362ffd406f23c8` |
| 04:08:24.129 | `POST https://dp.srvf.team/api/auth/v1/service-token` | 匿名；历史无效请求体 | 503 / 37030，JSON；Integration API 未启用，响应未见 token 字段 | `srvf-qa-resume-725f8f63ab0e42a0ae93ba0696bcbcdb`（客户端指定并回显） |
| 04:08:24.371 | `POST https://dp.srvf.team/api/auth/v1/delegated-token` | 匿名；历史无效请求体 | 401 / 37011，JSON；认证拒绝，响应未见 token 字段 | `srvf-qa-resume-f7aee42e68e447fcadcceee2aac08cfe`（客户端指定并回显） |
| 04:10:15.229（服务端日志时间） | `POST https://dp.srvf.team/api/auth/v1/wecom-bind/authorize` | 匿名；历史无效请求体 | 本地接收脚本异常；目标容器有界日志按请求 ID 恢复方法、实际路径及 HTTP 401。响应体、业务码、Content-Type、Cookie 和 Location 均 UNKNOWN，未重试；[脱敏恢复记录](evidence/20261113/history-wecom-bind-recovered.json) | `srvf-qa-resume-f577c180847c416cad177c7e2ded53c7`（客户端指定） |
| 04:17:37.993 | `GET https://dp.srvf.team/api/admin/v1/users?page=1&pageSize=100&q=<合成用户名A>`（用户名脱敏） | 现有测试管理员 | 200 / code 0，total 0 | `cmwdzp0497de0586bf51bb001df1abdf9` |
| 04:18:06.419 | `POST https://dp.srvf.team/api/admin/v1/users` | 现有测试管理员；合成账号 A | 201 / code 0；账号 ACTIVE / USER，实际服务端路由经有界日志核对 | `cmwdzpm25c26450e9a39986f4f74f4cff` |
| 04:18:22.708 | `GET https://dp.srvf.team/api/admin/v1/users/<合成账号A-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；USER / ACTIVE，未绑定成员，无邮箱和手机号 | `cmwdzpym5ac4ad33b09fa24c47d2eaec2` |
| 04:18:29.284 | `GET https://dp.srvf.team/api/system/v1/users/<合成账号A-ID>/roles`（ID 脱敏） | 现有测试管理员 | 200 / code 0；空数组 | `cmwdzq3pvea7aad6b397eaad63b7cf972` |
| 04:18:41.858 | `GET https://dp.srvf.team/api/admin/v1/role-bindings?principalType=USER&principalId=<合成账号A-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；空数组 | `cmwdzqdfg400bbc4e365766143af9a046` |
| 04:19:03.920 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员A-ID>`（ID 脱敏） | 现有测试管理员 | 200；绑定前 `hasAccount=false`，userId 为空 | `cmwdzquf1c4156fd11320afc7a123c922` |
| 04:19:28.367 | `POST https://dp.srvf.team/api/admin/v1/members/<合成成员A-ID>/account/bind`（ID 脱敏） | 现有测试管理员；合成账号 A | 200 / code 0；实际服务端路由经有界日志核对 | `cmwdzrda6849eb7f08d913404585960bc` |
| 04:19:41.416 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员A-ID>`（ID 脱敏） | 现有测试管理员 | 200；`hasAccount=true`，绑定账号 ACTIVE，USER ID 匹配 | `cmwdzrnch43c4a89083b86dbbfb68da11` |
| 04:19:46.544 | `GET https://dp.srvf.team/api/admin/v1/users/<合成账号A-ID>`（ID 脱敏） | 现有测试管理员 | 200；memberId 匹配，USER / ACTIVE | `cmwdzrraxc64fcb277a3b3a65d745f0af` |
| 04:19:59.291 | `GET https://dp.srvf.team/api/admin/v1/users?page=1&pageSize=100&q=<合成用户名B>`（用户名脱敏） | 现有测试管理员 | 200 / code 0，total 0 | `cmwdzs14w87488c0b542007c08691d121` |
| 04:20:20.197 | `POST https://dp.srvf.team/api/admin/v1/users` | 现有测试管理员；合成账号 B | 201 / code 0；实际服务端路由经有界日志核对 | `cmwdzsha17a88d6c75d683b89c93c9eab` |
| 04:20:33.339 | `GET https://dp.srvf.team/api/admin/v1/users/<合成账号B-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；USER / ACTIVE，未绑定成员，无邮箱和手机号 | `cmwdzsrf340dee7a2ebc92610edb4834d` |
| 04:20:38.914 | `GET https://dp.srvf.team/api/system/v1/users/<合成账号B-ID>/roles`（ID 脱敏） | 现有测试管理员 | 200 / code 0；空数组 | `cmwdzsvpi23914db7ed0e73893b0a51fc` |
| 04:20:44.345 | `GET https://dp.srvf.team/api/admin/v1/role-bindings?principalType=USER&principalId=<合成账号B-ID>`（ID 脱敏） | 现有测试管理员 | 200 / code 0；空数组 | `cmwdzszwf36fd748ee25c9be7faa82dce` |
| 04:21:01.376 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员B-ID>`（ID 脱敏） | 现有测试管理员 | 200；绑定前 `hasAccount=false` | `cmwdztd1j8bbff5cb2ebed32d73c254f5` |
| 04:21:25.470 | `POST https://dp.srvf.team/api/admin/v1/members/<合成成员B-ID>/account/bind`（ID 脱敏） | 现有测试管理员；合成账号 B | 200 / code 0；实际服务端路由经有界日志核对 | `cmwdztvnh64fc905228fdd953ed466f9b` |
| 04:21:38.153 | `GET https://dp.srvf.team/api/admin/v1/members/<合成成员B-ID>`（ID 脱敏） | 现有测试管理员 | 200；`hasAccount=true`，绑定账号 ACTIVE，USER ID 匹配 | `cmwdzu5f1632e69115ead37475bf689d6` |
| 04:21:43.242 | `GET https://dp.srvf.team/api/admin/v1/users/<合成账号B-ID>`（ID 脱敏） | 现有测试管理员 | 200；memberId 匹配，USER / ACTIVE | `cmwdzu9ea3664aeef6ec3e3f493d4ae15` |

- 历史 HTML 404 的 38 个方法中，累计 13 个已有对齐方法、路径及相应查询或无效请求体的匿名有限样本；其中企业微信绑定授权样本只恢复 HTTP 状态，响应类型未知。其余 25 项涉及有状态 POST、身份、短信或外部服务，未确认隔离条件前不盲目重放。企业微信登录授权负例未发起 OAuth 跳转，两个 step-up 负例均被匿名守卫拒绝。上述令牌负例[脱敏回执](evidence/20261113/history-integration-token-invalid.json)不含凭据，也未签发 token；源码中的限流器可能写入限流桶，本轮未证明其实际写入状态。所有样本均不等于已认证流程或完整业务验收。
- **LOCAL**：已核对并行前端分支 `codex/retire-legacy-attendance-consumer-20261112` 的候选 `e0ec0425302b746ee51048a8f6183516f9a71f7e`：其写集包括 `src/api/srvf-member.ts` 和 `members/cockpit.vue`，该会话仍在运行。新建队员的完整合同修复与共享文件重叠，未通过重复 API 或类型断言绕开，也未改动对方工作树；等待安全的串行集成条件。
- **LOCAL 行为回归**：隔离前端分支 `codex/member-create-contract-test-20261113` 基于 `6375148a61445972e792ce37cb401fd8e5162538`，新增测试 `tests/member_create_contract.behavior.test.mjs`（当前工作树 SHA-256 `14d449dd21a974a4e156784c259681769c810d755f5b06f15d71822c1956ec89`；先前误将中间版本摘要 `c59e56091bcd157cf24566a74b176f55b57152a04389d9004d8f4f6131e4282c` 写为最终版本），未提交或推送。真实成员创建 API 包装器经 Axios 发往本机合成 fixture 的正确合同对照通过；使用同一修正后夹具，基线的真实 `useMembers` 提交编排 FAIL，序列化字段仅 `memberNo`/`displayName`；将并行会话候选 `1fe9ae3afa340237c63603f700c18a89c8fe6857` 的独立基线补丁仅应用至本隔离工作树后，2/2 测试通过。回调桩模拟表单校验，不能算 GUI 或线上验收；本机回环端口测试后均验证释放，未请求线上。首次 `location` 缺失及候选缺少字典方法均为已修正的夹具问题，不算产品失败；候选未部署。
- 同一 **LOCAL 候选** 的独立补丁 SHA-256 `f6562e6bda02b583178980c8b50fb1f9b33e173fbe9c57589ee4d797ca54865b`，13 个补丁目标文件的 Git blob 与审查包后像一致；针对相关文件的只读 ESLint、Prettier 检查和 `pnpm exec vue-tsc --noEmit --skipLibCheck` 均通过。候选仍是独立工作树中的未提交变更，不等于仓库 main、部署或真实 GUI 回归通过。
- 旧测试凭据文件、QA/SRVF 环境变量及目标域名钥匙串元数据未发现可用隔离账号。当前已知的管理员浏览器会话未绑定成员；普通角色和跨组织业务链仍 BLOCKED。不得从原始回执提取令牌或在本台账保存凭据。
- **DEPLOYED_RUNTIME，只读运维证据**：04:10:15.229 之后至 04:17:12 之前，在已与真实请求日志关联的目标 API 容器中，只读检查编译产物及单个非秘密配置项。HTTP 请求日志序列化器用非凭据合成样本验证仅输出方法和去除查询串的路径，不输出请求体；配置含密码、令牌和认证头等字段的脱敏路径。活动责任开关 `ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED` 的容器环境值及编译解析结果均为 `false`。精确操作时间 UNKNOWN；这不证明运行进程内存配置、代理/自定义日志或浏览器扩展的行为，亦不证明部署 SHA。见[脱敏记录](evidence/20261113/runtime-logger-activity-flag.json)。
- **LOCAL 角色方案，尚未授权**：普通成员自助报名和本人打卡按本地合同不需要管理员角色；具体报名结果依分配模式而定，不能预设都要人工审批。若由成员 A 提交活动与考勤/结算，另需不同于 A、B 的合成一审 R1 和终审 R2；候选为组织 A 范围内的 `activity-publish-reviewer`、`attendance-first-reviewer`、`attendance-final-reviewer`，分别先核对线上角色和 scope。`org-admin` 是较宽的候选，源码目录约 50 项权限且包含通知相关权限，不得仅为凑前置盲目授予。发布及审核可能产生通知意图；结算终审同步成功不等于已入账，后台 worker 配置与实际账本状态仍需验证。以上均未做线上角色授权，不代替运行环境判权。
- 单条合成队员创建准备时，隔离浏览器工具发生异常；保留的浏览器事件中未找到目标 POST，同编号回查 total 0，但事件缓冲标记截断。随后在独立 1Panel 终端只读核对目标 API 容器的 UTC 19:23:00–19:26:10 日志：命令退出 0，共 24 行，两次已知 GET 的请求 ID 各命中 2 行，按 JSON 方法和目标路径匹配的 POST 为 0；匹配表达式用合成 JSON 正负例验证。日志查询执行于北京时间 03:28:40–03:34:13 区间内，精确时刻未捕获。此结果支持请求未到达该容器，仍不能排除其他格式或异步情况；未显示、保存原始日志或凭据。核对后才考虑一次受控重试，不换编号盲目重放。
- 后续在修正工具匹配逻辑、重新查重后，使用隔离浏览器分别单次适配请求体，线上创建合成成员 A、B 均返回 201 / code 0；当时各自独立列表和详情回读为 ACTIVE 且与合成字段一致，成员归属均为空、未绑定账号。此为 **DEPLOYED_HTTP** 有限数据准备，不能视为后台原表单已修复；后续组织和账号准备见下文。
- 合成组织 A、B 在用户明确说明目标测试库及数据均为合成后，分别于唯一 ACTIVE 根节点下创建，未修改根或既有组织。由于单标签适配前的浏览器事件仍显示原路径，额外按各自创建 request ID 查目标容器限定时间日志，确认实际均为 `POST /api/admin/v1/organizations`；各自独立详情回读一致，两个 ID 不同。该记录为 **DEPLOYED_HTTP** 数据准备，不能冒充原组织表单 GUI 验收。
- 合成成员 A→组织 A 与成员 B→组织 B 的 PRIMARY 归属分别单次写入，均通过成员归属列表、归属详情和有界容器日志独立核对：两条均为 ACTIVE、startedAt 有效、endedAt=null，且成员/组织/归属 ID 与各自回执一致。该时点两人尚未绑定登录账号；后续绑定见逐请求记录，不等于普通角色业务或跨组织权限通过。
- 两个合成 USER 的创建和各自成员绑定使用受控浏览器请求体适配，创建前均查重，创建后均回读 ACTIVE / USER，无邮箱、手机号，普通角色列表与 role bindings 为空；绑定后分别从成员与账号两端回读一致。4 次写入的实际目标与状态均用目标容器[有界日志统计](evidence/20261113/account-ab-route-summary.json)按请求 ID 独立核对。口令未写入本台账、截图或仓库；这不证明其他代理、浏览器扩展或自定义日志的行为。普通账号尚未登录验证，不代表原 GUI 创建表单已修复。
- **LOCAL 重入修复候选**：在首个合成 POST 保持未完成、或异步表单校验尚未完成时直接重入 `beforeSure`，并行候选均可发出重复请求；这是回调层面证据，真实 GUI 双击是否可触发及后端是否阻止重复入库均未验。已在我方独立工作树追加校验前提交锁，校验中/请求中重入、无效/异常释放锁及服务端 500 提示等本地行为测试 6/6 通过；针对性 ESLint、Prettier、类型和 diff 检查通过。[差量补丁](evidence/20261113/member-create-inflight-guard.patch)及[本地验证记录](evidence/20261113/member-create-inflight-guard-local.json)只含附加防护与回归测试，补丁 SHA-256 为 `a4d54fb4566095f823550cd5045b1d515dc6c523abdfd970957f412ba9c0e4b7`，须先有上述并行候选；对应前端源码未提交、推送或部署，不改并行会话工作树。
- 续测开始时 PR #1414 的 head 为 `06000af93206e485749c26a414e6f018a49335f3`。该 head 的 Authenticated Human V3 在测试容器创建阶段失败，Fast checks、Golden journeys 与部分分片通过，其余分片当时仍运行；新提交的检查应分别核对。

# Integration API 运行手册

> 适用范围：Integration Foundation v1 的 Service Principal、Credential、Delegation Grant、
> Service / Delegated Token、`/api/integration/v1/*` 与幂等回执。
>
> 当前已接入的业务面只有 `GET /api/integration/v1/reference/activity-types`。它是**仅 Service
> Token、direct GLOBAL RoleBinding** 的只读参考面；Delegated Token 不可调用它。生产 Gate 默认
> 保持关闭。本手册不构成开启 Gate、部署 migration 或创建真实调用方的授权。

## 1. 上线边界

- Integration 与 Human 身份链物理隔离。不得把 Service Principal 伪装成 User，也不得将
  Integration principal 写入 `request.user`。
- 数据库不向外部系统开放；所有调用经短期 Token 和 Integration surface 进入领域服务。
- `INTEGRATION_API_ENABLED=false` 是唯一业务 Gate。关闭时控制面仍可预配置主体、凭证与 Grant，
  但 Token 签发和 Integration surface 必须统一 fail-closed。
- 开启 Gate 前，维护者必须确认已部署批准版本、既有 Human 登录与五个既有 surface 无漂移、并且
  已完成本手册的非生产探针。不得借此开启活动 v1.1 workflow Gate 或任何无关生产开关。

## 2. 环境变量与 Secret

| 变量 | 运行要求 |
| --- | --- |
| `INTEGRATION_API_ENABLED` | production / smoke 必须显式为 `true` 或 `false`；首次部署固定为 `false`。 |
| `INTEGRATION_JWT_SECRET` | 独立高熵 Secret；production / smoke 至少 48 字符，且绝不能等于 Human 的 `JWT_SECRET`。Gate 开启时任何环境都不得为空。 |
| `INTEGRATION_SERVICE_TOKEN_EXPIRES_IN` | 可省略，默认 10 分钟；仅接受正整数秒或 `s` / `m` 时长，最长 30 分钟。 |
| `INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN` | 同上；Delegated Token 不签发 refresh token。 |
| `SERVICE_TOKEN_THROTTLE_LIMIT` / `SERVICE_TOKEN_THROTTLE_TTL_SECONDS` | Client Credentials 限流参数；缺省分别为 10 次和 60 秒。 |

- issuer 与 audience 固定为 `srvf-dp` / `srvf-integration`，不是可由调用方或普通部署参数改写的值。
- Integration Secret 必须由受控 Secret Manager 生成和保存；不得进入 Git、终端历史、工单、聊天、
  日志、Audit、OpenAPI 示例或测试快照。
- Client Secret 由服务端生成，原值只在创建 Credential 的成功响应中出现一次。接收方应立即写入
  自己服务端的 Secret Manager；浏览器、小程序和 App 前端禁止持有它。
- 不得把权限码、角色、组织范围、Client Secret 或 Secret hash 放进 Token。授权每请求从
  PostgreSQL 当前事实重新计算。

## 3. 控制面预配置 SOP

以下操作由持有控制面权限的 Human 管理员执行；Service Principal 自身永远不能持有这些权限。

1. 在 `INTEGRATION_API_ENABLED=false` 下创建 Service Principal，记录服务端生成的 `clientId`、
   用途、属主组织和负责人。`clientId` 不复用，主体不做物理删除。
2. 为该主体建立**直接** RoleBinding。当前首个业务读面要求该绑定为 `GLOBAL`，并通过
   `dict.read.item` 的机器资格门；局部组织、活动、资源或 SELF scope 都不能读取全局活动类型参考表。
3. 创建一个 Credential。只把一次性展示的原始 Secret 交给受控 Secret Manager，列表、详情和
   运维记录只保留 Credential 元数据，不抄录 Secret 或 hash。
4. 仅在确有“代表固定真人”需求时创建 Delegation Grant。Grant 的 subject 只能由控制面固定，
   权限和范围始终取 Service Principal ∩ User ∩ Grant 的交集。当前活动类型读面不接受 Delegated
   Token，`dict.read.item` 也保持 `delegatedAccessAllowed=false`。
5. 记录负责人、用途、批准人、创建时间、Credential 到期策略和撤销预案；这些记录不得包含 Secret、
   Token 或 hash。

## 4. 非生产联调与最小探针

先在受控的非生产环境完成下列探针，再提交 Gate 开启申请。

1. 用 Client Credentials 调 `POST /api/auth/v1/service-token`，确认取得短期 Service Token，
   响应没有 refresh token；不要把 Authorization 头或 Token 粘贴进记录。
2. 用该 Token 调 `GET /api/integration/v1/me`，确认只返回最小主体信息，不返回原始权限、
   Secret 或完整主体对象。
3. 用拥有 direct GLOBAL `dict.read.item` 的 Service Principal 调
   `GET /api/integration/v1/reference/activity-types`，确认只得到 ACTIVE 项的
   `code`、`label`、`sortOrder` 与确定性分页；此 GET 不以 body 中的伪 subject 为准，也不写业务
   Audit。
4. 验证反向边界：Human JWT 调 Integration surface、Service Token 调 Human-only 路由、
   Delegated Token 调活动类型读面、未绑定或局部 scope 的 Service Principal 调该读面，均必须拒绝。
5. 如未来有允许 Delegated 的业务面，再单独验证 Grant 的 User / Service Principal / 权限 / 范围 /
   有效期任一失效都会在下一请求拒绝；不得用 `/me` 成功替代业务面授权验证。
6. 撤销测试 Credential、SUSPEND 测试主体或撤销测试 Grant 后，验证既有 Token 下一请求立即失败；
   测试结束后按环境 SOP 清理测试配置。

## 5. Gate 开启与变更审批

Gate 开启是维护者的显式生产变更，不是部署脚本、AI 或外部系统的默认动作。申请中至少应写清：

- 已部署的 release tag / image digest，以及相应 migration 已按生产 SOP 审核和执行；
- Secret 已独立保存、Human JWT 未受影响、非生产探针与反向拒绝测试通过；
- 首个 Service Principal、最小权限、负责人、Credential 轮换日和止损负责人；
- 调用量预期、限流参数、观察窗口和回退动作；
- 不启用的范围：不开放数据库、不开放全部内部 API、不向浏览器分发 Client Secret、不开放外部审批或终审。

批准后先在受控环境把 `INTEGRATION_API_ENABLED` 设为 `true`，观察 Token 签发、BizCode、主体 ID
和 operation 的聚合指标；异常立即按 §7 止损。不得拆出多个半启用 Gate。

## 6. Credential、Grant 与幂等操作

- 轮换采用“新建 B → 外部系统切到 B → 验证 → 撤销 A”；禁止原地修改 Secret。每个主体同时最多
  两条 ACTIVE 且未过期 Credential。
- 单个 Credential 泄露时先撤销该 Credential；需要整体隔离时 SUSPEND Service Principal；有代人风险
  时同时 REVOKE 相关 Grant。保留 Audit、receipt 和业务数据，不做物理删除。
- 未来任何 Integration 写接口都必须带 `Idempotency-Key`。幂等域是
  `servicePrincipalId + operation + Idempotency-Key`；同 key 同 hash 重放首次结果，不同 hash 返回
  `37023`。领域写、回执和最小非敏感响应快照必须在同一事务。
- 当前活动类型端点是 GET 只读面，不要求 `Idempotency-Key`；不得把此例外复制到未来写接口。

## 7. 观测、事故处置与止损

日志和排障记录只可按 requestId、Service Principal ID、operation、BizCode 聚合；Delegated 场景可按
on-behalf-of User ID 审计，但不得记录 Authorization、JWT 内容、Client Secret、Secret hash、完整
响应快照或 Idempotency-Key。

- 运行时日志对 `clientSecret`、`secretHash`、`rawSecret`、`serviceToken`、`delegatedToken` 与
  `credentialSecret` 同时覆盖顶层、单层嵌套和当前 `req.body` 形状；自动 HTTP logger 仍不记录请求 body。
  这层遮蔽是已知形状的纵深防御，不得据此把任意新嵌套对象当作可安全记录。

| 场景 | 首要动作 |
| --- | --- |
| 怀疑 Secret 泄露或调用方失控 | 立即关闭 `INTEGRATION_API_ENABLED`；再撤销受影响 Credential，必要时 SUSPEND 主体与 REVOKE Grant。 |
| `37010` Client Credentials 统一失败 | 由控制面核查 clientId、Credential、主体状态与到期，不向调用方透露具体失败分支。 |
| `37011` Token 无效 | 重新认证，并核查主体、Credential 或 Grant 是否已撤销、停用或过期。 |
| `37017` 主体类型不适用 | 改用路由明确允许的 Token，不得改路由声明绕过 Principal Admission。 |
| `37023` 幂等冲突 | 保留原请求重试；新业务意图使用新 key，不得删除 receipt 绕过冲突。 |
| `37030` Gate 关闭 | 先完成审批和非生产探针，再由维护者开启；不得临时绕过 Gate。 |

## 8. 回滚与不可逆边界

第一回退动作永远是将 `INTEGRATION_API_ENABLED=false`，随后按需要撤销 Credential、SUSPEND
Service Principal、REVOKE Grant。关闭 Gate 不影响 Human Auth surface。

`PrincipalType.SERVICE_PRINCIPAL` 是 PostgreSQL enum 的前向兼容变更，不是真正可逆操作。一旦数据库
存在该类型的 RoleBinding，旧 Prisma Client 可能无法识别查询结果。因此激活后优先“关 Gate + 向前修复”，
不要盲目回退到 pre-foundation 二进制。确需回退旧二进制时，必须由维护者先审批清理或迁出新类型绑定；AI
不得执行该数据操作。

## 9. Release 与 handoff

- 版本 release 只代表代码与契约里程碑，不等于生产部署或 Gate 开启。发版须遵循
  [`docs/process.md`](../process.md) 的两段式 `release:prepare` / 人审合并 /
  `release:finish` 流程。
- release handoff 记录当前 API、控制面、Gate 默认值、首个活动类型只读面、未开放的 Delegated 业务面、
  回退边界与待维护者确认的生产动作；合入后作为历史快照不回改。
- 新增业务接入必须另立 PR，先确认唯一领域真相链；不得借本手册或 release 直接开放活动/考勤写接口。

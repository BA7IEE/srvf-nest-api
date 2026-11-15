# 常规单场次活动 API（L2 候选）

后端基点 `e37aadb7b094cc770578de4ba52b22587da7bfd8`，隔离分支 `codex/activityos-v1-single-session-20261102`。新增 API 已做普通业务身份的真实隔离验证；受保护契约登记及完整 CI 尚未完成，未合并、部署或开启生产。字段完整定义以同候选的 `openapi.json`、`clients/admin/client.ts` / `types.ts` 为准。

## 身份和授权

六入口均使用真实当前登录人、有效正式成员本人和现有组织资格，不接受代造 memberId/CurrentUser 或 SUPER_ADMIN 代发。模板摘要不要求 GLOBAL 模板管理权。创建使用现有 `activity.create.record` 的目标组织授权；保存使用 `activity.update.record`、本人草稿资格及目标组织授权。配置了时长／贡献政策时，读取须具备对应 `activity.time-policy.read`／`activity.contribution-policy.read`，保存还须对应 `.select`，均遵循现有明确 scope；创建采用原模板政策初始化的授权。权限码之间不互相代替。

审核继续使用既有 Admin 发布审核 API 的 read/publish/return 授权、组织 RoleBinding 和独立审核限制。接口权限登记不创建角色、授予 grant 或改变 SQL ACL。

## 六个入口

以下路径均以 `/api/admin/v1/activities` 开头；统一响应包与现有 API 一致。

| 方法／路径 | 输入和结果 |
| --- | --- |
| `GET /organization-options` | 返回本人可发起组织：organizationId、name、pathLabel、source、membershipType |
| `GET /template-version-options` | organizationId 必填，page/pageSize 沿现有分页；与 #1395 同源校验，分页前筛选简单模板，保留同一 13 字段安全摘要，零 definitionJson |
| `POST /from-template` | 201；必填 operationKey、templateVersionId、title、organizationId、startAt、endAt、location、defaultPlaceVisibilityCode；可选 instance、places、confirmedCapacity |
| `GET /{id}/simple-draft` | 200；服务端最终活动／单场次／单默认岗位／地点／有权政策摘要、精确模板版本/hash、draftHash、editable 和真实最新 review |
| `PUT /{id}/simple-draft` | 200；完整 title、organizationId、startAt、endAt、location、instance、places 加 expectedDraftHash；返回同一完整最终投影 |
| `POST /{id}/publish-reviews` | 200；operationKey（8–128 字符）、confirmation=true；可选 expectedDraftHash 为确认时读取的 draftHash；调用现行 proposal，返回真实 review，成功提交不代表 published |

`GET` 与 `PUT simple-draft` 共用一个路径；共 5 个新增路径、6 个方法。Admin DTO 物理独立，不派生 App DTO。ID 8–64 字符；标题 1–100、文字地点 1–200；日期使用 ISO8601。

`instance` 在创建时可省略；传入时四个字段必须齐全，更新时必须传完整块：

```ts
{
  capacity: number | null;              // 正整数 <= 2147483647，null 明确不限
  registrationDeadline: string | null;  // ISO8601，沿现有校验不晚于结束
  description: string | null;           // <= 2000 字符，null 清空
  registrationNotes: string | null;     // <= 2000 字符，null 清空
}
```

`confirmedCapacity` 仍只确认模板人数，必须与模板相等，不能用它覆盖本次人数。旧 App Quick 在未传新增块时的行为/hash/replay 保持不变；新 Admin 的 `single_session_v1` 布局意图单独进入 hash，不能与旧 App 操作键混用。相同创建内容重试复用原 operationKey，改内容须新键；返回的 createdStatusCode 是首次创建状态，当前状态另读。

地点沿既有 presetId／inline 二选一、坐标系和可见性校验。Admin 只接受活动级用途，不接收 sessionCode；同一份快照应用到活动与唯一场次。每种用途至多一个、恰有一个 primary，最多六种。更新须保留现有用途结构，不能借简单保存删除其他地点。读取以 inline 返回本地快照，不会自动跟随后续预设变化；纯文字不是坐标，也不自动启用定位签到。

## 一致性、冲突和实际状态

首版限北京时间同日、first_come、一个有效场次、一个默认参与岗位。模板须支持该简单布局；复杂模板、差异化岗位时段或窗口不被自动简化。服务端还比对**当前实例**：岗位继承／显式完整时段及签到签退／准备窗口须与批准布局一致。专业入口改过这些安排后，简单读取和保存返回 BAD_REQUEST，保留原安排；通过原专业入口显式恢复合法安排后才可重新读写。

保存按批准偏移同步父子时间与容量，地点和兼容投影、现有政策对新时段的复核、审计均由一个根事务完成；不更换模板或政策、不嵌套 public transaction，不事后补审计。根锁与后续阻塞锁后重新读取当前身份、权限和草稿状态。等待期间撤权、待审核、政策失效或任何尾部失败均不能发布部分配置。

- `expectedDraftHash` 是有权完整草稿事实的并发栅栏，不是授权凭据；冲突为 `ACTIVITY_SIMPLE_DRAFT_STALE`（20255、HTTP409）。
- 创建同键异参为原 `ACTIVITY_CREATE_FROM_TEMPLATE_OPERATION_KEY_CONFLICT`；待审拒绝、正式发布后需变更审核、权限/政策/组织错误继续使用已有业务码。复杂当前结构为 BAD_REQUEST（40000、HTTP400）。其他字段错误见生成 OpenAPI。
- 保存成功 → 读取最终事实 → 确认预览 → 单独提交审核。pending 时活动仍可能是 draft；审核批准后才以实际 published 状态为准。
- 更新没有新增持久化更新回执。响应丢失时先读当前事实核对完整目标，不能盲重试或宣称已回滚；创建/提审沿各自既有幂等键。

## 本轮真实证据和边界

q6 是全新 socket-only PG16.15 隔离集群，155 迁移正常安装；三个业务账号均 USER、组织范围授权、GLOBAL binding=0。六入口及独立审核发布通过；父子／两地点／审计同 XID1415，注入审计失败的 XID1423 独立 aborted；实际根锁等待后撤权返回403。普通发布人经现有专业 PATCH 缩短岗位、改变签到窗口后，简单 GET/PUT 均拒绝且配置不变；显式恢复后继续发布成功。该阶段正常销毁，其他客户端/prepared transaction 和容器/卷均为零。

这不是生产数据库最小权限身份验收：SQL 连接是隔离 fixture owner。结束／正式结算／更正本轮未重跑，按先前真实证据原范围复用；组合到本次新根的后半链 NOT_RUN。UI/L3/A16 按用户最新优先级延期，不作为 API 编码阻断，也不计通过。生产目标、155 前置、运行身份/开关与备份恢复另核；本轮不含生产操作。

## 提审确认指纹（本地候选）

Admin 提审新增可选 `expectedDraftHash`（64 位小写十六进制）。客户端确认后提交同一次 GET simple-draft 的 `draftHash`，不再先读后自行比较；服务端在 Activity 行锁事务内比较，过期返回既有 `ACTIVITY_SIMPLE_DRAFT_STALE`，不创建 review 或提交审计。刷新并重新确认后使用新幂等键；失败请求未写回执时也可用原键携带刷新后的指纹。

授权和身份复核仍先于重放。同一 operationKey 的完整请求（含提供的 expectedDraftHash）先匹配既有回执，再检查新提交的版本，因此新增 review 导致 draftHash 变化不会破坏成功请求重试。已成功的键改指纹或去掉指纹返回 operationKey 冲突。省略该字段保持旧版“提交锁内最新草稿”语义和原哈希字节，**旧客户端没有确认版本保护**。App DTO 不变。

带版本的新提审在同一 Activity 行锁内、授权与完整幂等重放之后，先检查资格配置和 simple 指纹；随后由现有 buildInitial 完成引用校验与锁定，对**将直接保存到 review 的同一个快照**运行简单配置白名单。偏离允许配置返回 `ACTIVITY_SIMPLE_REVIEW_REQUIRES_PROFESSIONAL_FLOW`（20256／409），提示使用专业流程，不自动删除或覆盖配置。资格 RuleSet 的 draft／active 状态在活动、场次、岗位任一层级存在即拒绝；retired 历史不阻止当前无规则草稿。

| 范围 | 新简单提审允许的配置 |
|---|---|
| 可见的活动／场次／岗位字段与地点 | 保持既有 simple 形态校验与指纹检查；本次实例值可不同于模板。地点仍由既有 root/session 一致性检查约束 |
| 活动隐藏字段 | 性别限制、保险、公开报名、报名方式、可见性、默认定位与半径、归档天数须等于精确模板值；模板未写时沿既有物化／DB 默认：null、isPublicRegistration=true、requiresInsurance=false、archiveWaitingDays=7。content、registrationSchema、活动旧经纬度须为 null |
| 场次隐藏字段 | locationText 等于当前活动地点；集合／执行／撤离点、坐标、半径为 null；locationRequired=false、locationPolicySourceCode=template、accuracyWarningMeters=100；迟到／早退阈值及排序等于模板 |
| 岗位隐藏字段 | 性别限制、定位、半径、职责、装备说明与排序等于模板及既有 nullable 默认；负责人和资格引用须为 null |
| 报名表 | 与模板的完整 canonical definition 一致；模板无表时不得另加。模板自带 governed 表保留 |
| 指标 | requirement 与完整版本 pointer 等于模板；旧模板未声明时仅允许 not_required／null |
| 时长与贡献政策 | 实例 selection document 等于既有模板物化 helper 的结果。拒绝新增 activity/session/position 覆盖，即便恰好指向相同政策；模板政策继续由现有 builder 校验、解析和锁定 |

白名单保留 `false`、`0`、null 的区别；不以“非空”作为专业配置判据。活动、场次、岗位使用完整类型化 expected 对象，新增快照字段必须补明确决策；字段矩阵单测逐项改变隐藏字段，真实数据库用例覆盖组合变化、正常非空模板默认值、并发、重放及撤权。分类与语义标签由已显示 activityTypeCode 的静态注册表派生；resolvedConfig 由既有 builder 按已检查原始值、选中模板和系统默认派生，不是额外可自由填写的输入。

**这是受限模板白名单，不是完整快照确认。** 允许继承模板固定配置不代表用户已看过这些字段；simple GET 仍不提供政策全文、表单正文等全部内容。hash 更新只证明版本变化，不能证明阅读。产品若要让简单页接受模板外专业配置，仍须增加完整展示和同一业务快照的确认绑定，不能只扩大 hash。

成功请求的同键重放先于本白名单，并继续复核当前授权。省略 expectedDraftHash 的旧客户端保留原行为与原请求哈希；专业 App 提审也保持原契约。新保护不是对所有旧客户端的强制升级。只回退业务配置而不改变成功 operationKey 不能复用该键提交新请求。

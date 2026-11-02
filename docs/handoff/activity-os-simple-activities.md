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
| `POST /{id}/publish-reviews` | 200；operationKey（8–128 字符）和 confirmation=true；调用现行 proposal，返回真实 review，成功提交不代表 published |

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

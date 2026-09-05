# C1 D2a 指标目录交付、初始化与回退

状态：D2a 当前分支在制，尚未合并或生产部署。生产 migration、首批内容与人员授码须单独审批。
不新增 Gate；已有 Activity OS 控制面和其他生产开关不变。D2b/D2c 尚未实施。

## 入口与可达性

前缀 `/api/admin/v1`，两个资源 `activity-metric-definitions`、`activity-metric-sets` 各六个操作：

| 操作 | 路径后缀 | 成功状态 | 权限 |
|---|---|---|---|
| GET 列表 | 无 | 200，items/total/page/pageSize | activity-metric.read.catalog |
| GET 详情 | /:id | 200 | activity-metric.read.catalog |
| POST 创建 | 无 | 201 | activity-metric.manage.definition 或 manage.set |
| PUT 编辑草稿 | /:id/draft | 200 | 同对应管理码 |
| POST 激活 | /:id/activate | 200 | 同对应管理码 |
| POST 退役 | /:id/retire | 200 | 同对应管理码 |

三权限仅 Human GLOBAL，可由现有角色管理入口人工配置自定义角色，不由 seed 自动分配给任何内建角色。
SUPER_ADMIN 沿统一 RBAC 短路；普通 ADMIN 不直通。无权限先拒绝，不能通过不存在的资源枚举目录。
read 不隐含 write，definition write 不隐含 set write，write 也不隐含 read。
列表沿 page/pageSize=1/20、上限100，code/statusCode 精确筛选，定义可筛 kindCode；createdAt DESC,id DESC。

## 版本输入与命令重放

创建传 operationKey + definition；编辑再传 expectedDefinitionHash；激活/退役只传 key/hash。
operationKey 必须非空、首尾无空白、最多128字符；hash 是64位小写十六进制。详情/:id 使用 IdParamDto。
完整字段以生成的 OpenAPI 和 Admin client 为准，拒绝未知字段及任意 JSON 扩展。
五类型沿 D1：非负整数、非负定点小数、布尔、短文本、单选。小数字符串必须规范化，不能带无意义尾零。
definition 的 code/version/schemaVersion 构成固定身份，更新不可改身份。只有 draft 可编辑，激活后内容冻结。
集可暂存空草稿，激活必须非空且精确引用当前 active 定义。集项 key/sortOrder/definitionId 各自唯一，上限100。
草稿集引用的 draft 定义后来被编辑时，需重选最新 hash 并保存集；不把详情返回的当前引用 hash 当作集已重新保存。

命令成功仅返回 id/code/version/schemaVersion/statusCode/definitionHash。相同 actor+operation+key、相同规范输入
会返回第一次的原始六字段结果，即使资源后来已修改或退役；前端需 GET 详情获取当前状态。
复用 key 却更换输入或目标为20169；不同 key 占用相同 code/version 为20168，不是重放。
请求或重放必须仍有当前权限；撤权后不能凭旧 key 取收据。失败不写半套目录/收据/审计。

## 首批初始化（维护者另批后执行）

1. 先审查 migration、3b/4b、可信红区、CI 与合并证据。不得把本地 app_test deploy 当生产完成。
2. 维护者审定指标含义、单位/边界/选项；没有业务内容 seed，不凭占位数据上线。
3. 通过正式角色管理入口创建自定义角色，按职责人工授予上述必要权限并绑定 Human GLOBAL；高风险授码沿既有二次验证。
4. 通过目录 API 创建定义、逐版本激活，再创建并激活精确引用的指标集。保存成功收据，GET 核对当前定义与 hash。
5. 检查 activity.metric-definition.command / activity.metric-set.command 审计，确认只含操作、code/version、前后 hash/status，不含 key 或配置全文。
6. 活动和模板选用入口尚不存在，不继续写 Activity/Template 指标字段，不启动成果登记。

## 错误与停止条件

| BizCode | 含义/动作 |
|---|---|
| 20164 / 20165 | 定义或集输入无效，按字段规则修正 |
| 20166 / 20167 | 定义或集不存在 |
| 20168 / 20169 | 版本身份占用 / key 已用于不同请求，不盲目重试 |
| 20170 | 版本 hash 已变化，刷新详情后重新决策 |
| 20171 | 当前状态不允许该操作，不改库绕过 |
| 20172 | 引用无效、非 active 或 hash 不一致，重选精确版本 |
| 20173 | 收据损坏或形状不符，停止重试并人工调查 |

认证/权限仍沿40100/30100；未知基础设施或程序异常保留500，不伪装成业务冲突。

## 回退

停止目录新写：维护者撤销人工配置的管理权限并停止 SUPER_ADMIN 目录操作；必要时回滚整套 D2a 新入口代码。
保留 additive 收据表、历史版本及审计，不 DROP 表、不改旧 migration、不物理删除命令收据。
退役是正常业务生命周期，不是撤销历史。前端隐藏尚未发布的目录功能，不影响原574个端点。
没有生产自动回滚、内容回填或数据清理脚本；本次测试仅 app_test、app_test_w1、app_test_w98 获批。

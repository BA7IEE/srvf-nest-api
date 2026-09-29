# D5 分类时长影子对账操作说明

## 用途与边界

只读比较同一次已提交结算的新旧时长。`matched` 只代表两项金额精确相等，不代表政策已获批准、正式入账、生产切换或允许开证明。D6/D7/D8 不由本接口代办。

入口：`GET /api/app/v1/my/managed-activities/{activityId}/time-settlement/revisions/{timeRevisionId}/shadow?page=1&pageSize=100`。

使用已有 `activity.time-settlement.read` 显式权限，且必须满足当前 App 身份、组织范围、负责人或指定版本实际审核资格。历史报告也即时检查撤权。不可用版本和跨活动锚按既有不可用错误处理；不得尝试拼接双方各自 latest。只接受 submitted 时长修订。

## 读取和解释

1. 保留 `activityId`、`settlementRunId`、`settlementVersionId`、`timeRevisionId` 和全部 hash。旧 `legacyContentHash` 是存储版本锚，不是服务端重新验算旧版本所有金额后的证明。
2. 分页内容在 `resultPage`；`summary` 始终覆盖新旧身份并集。旧小时以精确十进制换算为秒，0.01 小时为 36 秒。差额为新减旧，计算与认定分开。
3. 仅 volunteer_service 对比旧服务时长；其余类别单独展示，不混加。未知计算值和单侧缺项不填零；`not_comparable` 必须人工核查。
4. `manual_recognition_present` 只表示存在人工认定，不说明差异已获豁免。`unexplained` 不可自动接受。双方为空显示 `empty=true`，不算验收成功。
5. 身份 ID 仍是受控信息；报告不输出姓名、手机号或原始调整备注。不要把访问令牌、带凭据的请求或完整服务日志装入证据包。

## 完整导出与永久留存

导出前由维护者指定永久存储位置、责任人、可访问主体和备份方式；未指定可以验证代码，但不能登记真实影子验收或 D8 放行。仓库不假定已有归档服务，不自动上传、不自动删除业务证据。

按 `resultPage.total` 收集所有页。每页的格式版本、比较器版本、版本锚、`inputFingerprint`、摘要及总数必须完全一致；任意变化都应放弃此次拼接并重新导出，保留原证据和原因。核验身份无重复、收齐分母，且 `total = matched + different + notComparable`。

在受控存储中保存完整响应页及 manifest，至少包含：验证代码 SHA、formatVersion、comparatorVersion、双方版本锚和 hash、inputFingerprint、页数及身份总数、每页文件 SHA-256、采集时间、操作者、未解释差异清单、人工审批结论及归档位置。采集时间不参与比较器确定性 hash。不得只保存第一页或截屏代替完整报告。

本阶段没有自动调整、豁免、正式入账或清理按钮。业务数据及历史证据不删除；临时隔离测试证据不能冒充永久业务归档。

### Added

- 活动业务改造 v1.1 第 2 批第 ⑨b 刀新增审核读面：跨活动结算审核工作台、不可变审核详情，以及 `LedgerPostingBatch` 的 preparing／ready／committed 进度投影。
- 新增我的、指定队员和指定活动三条参与账本分页读面；所有账本条目均经统一查询服务只读取已 `committed` 的批次。

### Security

- 审核与管理员账本读面复用既有 `attendance.read.sheet` 权限；无权的队员、活动和结算版本探测统一拒绝，App 读面仅按当前登录身份的队员范围返回。

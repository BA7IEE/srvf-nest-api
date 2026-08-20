### Changed

- **队员身份主档终态升级(issue #1048 T1)**:`Member` 成为 `memberNo + realName + nickname` 的唯一日常身份事实源,新增 `memberSinceDate`(发号日)与 `memberOriginCode`(来源字典 `join_source`);`Member.displayName` 与 `MemberProfile` 的 `realName` / `joinedDate` / `joinSourceCode` 一并删除,**不留兼容层、不双写**。
- 人员展示标签全仓统一为 `编号 · 姓名(外号)`(外号为空时不带括号),唯一实现在 `src/common/identity/member-label.util.ts`。⚠️ **用户可见变更**:报名自助取消通知原本用本模块私有的 `姓名（编号）` 格式,现随之改为统一格式。
- 字典 `join_source` 补齐 `manual`(管理员录入)与 `import`(历史录入)两条 —— 此前只有 `recruitment`,而这两条来源真实存在,缺码会逼调用方自己编自由串。**label 待维护者与队里确认后定稿,code 已按长期契约锁定**。

### API breaking change

- 共 100 个 operation 受影响(99 个响应字段删除 + `POST /api/admin/v1/members` 另有三个新增必填请求字段)。逐条申报见下方 `contract-breaking` 块。

<!-- contract-breaking
operation: GET /api/admin/v1/users
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/users
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/users/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/users/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: DELETE /api/admin/v1/users/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PUT /api/admin/v1/users/{id}/password
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/users/{id}/role
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/users/{id}/status
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: DELETE /api/admin/v1/users/{id}/phone
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: DELETE /api/admin/v1/users/{id}/wechat
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: DELETE /api/admin/v1/users/{id}/wecom
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/me
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/me/profile
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/app/v1/me/profile
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PUT /api/app/v1/me/password
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/organizations/{orgId}/position-assignments
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/organizations/{orgId}/position-assignments
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/members/{memberId}/position-assignments
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/position-assignments
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/position-assignments/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/position-assignments/{id}/revoke
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/position-assignments/{id}/history
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/supervision-assignments
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data[].supervisor.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/supervision-assignments
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.supervisor.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/supervision-assignments/page
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].supervisor.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/supervision-assignments/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.supervisor.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/supervision-assignments/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.supervisor.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/organizations/{orgId}/supervisors
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data[].supervisionAssignment.supervisor.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/supervision-assignments/{id}/revoke
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.supervisor.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/role-bindings
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data[].principal.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/role-bindings
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.principal.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/role-bindings/page
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].principal.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/role-bindings/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.principal.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/role-bindings/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.principal.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: DELETE /api/admin/v1/role-bindings/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.principal.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/members
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/members
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`;建档必须显式给出姓名 / 发号日 / 来源码 —— 三者都是业务事实,后端不替维护者内置默认值。
impact: 响应删除字段:`data.displayName`;请求新增必填:`realName`、`memberSinceDate`、`memberOriginCode`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`;建档表单补三个必填项;历史队员批量录入脚本必须显式传 `memberSinceDate`(历史日期)与 `memberOriginCode=import`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/members/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/members/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: DELETE /api/admin/v1/members/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/members/{id}/status
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/members/{id}/account/bind
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/members/{id}/account/unbind
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/members/{id}/account/status
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/members/{id}/offboard
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activities/{activityId}/reconciliation
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.registeredParticipants[].displayName`、`data.temporaryParticipants[].displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activities/{activityId}/responsibilities
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.initiator.displayName`、`data.owner.member.displayName`、`data.collaborators[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/activities/{activityId}/responsibilities/collaborators
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: DELETE /api/admin/v1/activities/{activityId}/responsibilities/collaborators/{assignmentId}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/activities/{activityId}/responsibilities/transfer
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.initiator.displayName`、`data.owner.member.displayName`、`data.collaborators[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/activities/{activityId}/responsibilities/claim
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/activities/{activityId}/responsibilities/assign-initiator
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.initiator.displayName`、`data.owner.member.displayName`、`data.collaborators[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.initiator.displayName`、`data.owner.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}/settlement/items
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.initiator.displayName`、`data.owner.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/app/v1/my/managed-activities/{activityId}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.initiator.displayName`、`data.owner.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/direct-publish
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.initiator.displayName`、`data.owner.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/declare-attendance-complete
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.initiator.displayName`、`data.owner.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}/responsibilities
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.initiator.displayName`、`data.owner.member.displayName`、`data.collaborators[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}/collaborator-options
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/collaborators
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: DELETE /api/app/v1/my/managed-activities/{activityId}/collaborators/{assignmentId}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/transfer-initiator
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.initiator.displayName`、`data.owner.member.displayName`、`data.collaborators[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/transfer-owner
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.initiator.displayName`、`data.owner.member.displayName`、`data.collaborators[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/activity-batch-jobs
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].createdBy.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/activity-batch-jobs/{jobId}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.createdBy.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/activity-batch-jobs/{jobId}/retry-failed
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.createdBy.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/activity-batch-jobs/{jobId}/cancel
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.createdBy.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/team-insurance-policies/{id}/members
reason: 扁平冗余字段 `memberDisplayName` 随主档改名为 `memberRealName` + `memberLabel`。
impact: 响应删除字段:`data.items[].memberDisplayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: `memberDisplayName` → `memberRealName`,需要完整标签读 `memberLabel`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/team-insurance-policies/{id}/members
reason: 扁平冗余字段 `memberDisplayName` 随主档改名为 `memberRealName` + `memberLabel`。
impact: 响应删除字段:`data.memberDisplayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: `memberDisplayName` → `memberRealName`,需要完整标签读 `memberLabel`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: DELETE /api/admin/v1/team-insurance-policies/{id}/members/{memberId}
reason: 扁平冗余字段 `memberDisplayName` 随主档改名为 `memberRealName` + `memberLabel`。
impact: 响应删除字段:`data.memberDisplayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: `memberDisplayName` → `memberRealName`,需要完整标签读 `memberLabel`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/certificates
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/members/{memberId}/profile
reason: `MemberProfile` 的 realName / joinedDate / joinSourceCode 三列已搬到 `Member` 主档,档案不再承载。
impact: 响应删除字段:`data.realName`、`data.joinedDate`、`data.joinSourceCode`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 姓名 / 发号日 / 来源改从队员主档端点读(`realName` / `memberSinceDate` / `memberOriginCode`)。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/members/{memberId}/profile
reason: `MemberProfile` 的 realName / joinedDate / joinSourceCode 三列已搬到 `Member` 主档,档案不再承载。
impact: 响应删除字段:`data.realName`、`data.joinedDate`、`data.joinSourceCode`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 姓名 / 发号日 / 来源改从队员主档端点读(`realName` / `memberSinceDate` / `memberOriginCode`)。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/members/{memberId}/profile
reason: `MemberProfile` 的 realName / joinedDate / joinSourceCode 三列已搬到 `Member` 主档,档案不再承载。
impact: 响应删除字段:`data.realName`、`data.joinedDate`、`data.joinSourceCode`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 姓名 / 发号日 / 来源改从队员主档端点读(`realName` / `memberSinceDate` / `memberOriginCode`)。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activities/{activityId}/feedbacks
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activities/{activityId}/check-ins
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activities/{activityId}/attendance-sheet-draft
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.absentRegistrations[].displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}/check-ins
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}/attendance-sheet-draft
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.absentRegistrations[].displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}/attendance-sheets/{sheetId}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.records[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/members/{memberId}/memberships
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/members/{memberId}/memberships
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/members/{memberId}/memberships/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: DELETE /api/admin/v1/members/{memberId}/memberships/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/memberships
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/memberships/transfer
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/memberships/{id}
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/organizations/{orgId}/memberships
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activities/{activityId}/registrations
reason: 扁平冗余字段 `memberDisplayName` 随主档改名为 `memberRealName` + `memberLabel`。
impact: 响应删除字段:`data.items[].memberDisplayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: `memberDisplayName` → `memberRealName`,需要完整标签读 `memberLabel`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/registrations
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`;扁平冗余字段 `memberDisplayName` 随主档改名为 `memberRealName` + `memberLabel`。
impact: 响应删除字段:`data.items[].memberDisplayName`、`data.items[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`;`memberDisplayName` → `memberRealName`,需要完整标签读 `memberLabel`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/members/{memberId}/registrations
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`;扁平冗余字段 `memberDisplayName` 随主档改名为 `memberRealName` + `memberLabel`。
impact: 响应删除字段:`data.items[].memberDisplayName`、`data.items[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`;`memberDisplayName` → `memberRealName`,需要完整标签读 `memberLabel`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}/registrations
reason: `Member.displayName` 退役 —— 身份主档改为 `realName` + `nickname`,并由后端拼装统一标签 `label`。
impact: 响应删除字段:`data.items[].member.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 读 `label` 直接渲染(格式 `编号 · 姓名(外号)`,外号为空不带括号);需要分字段时读 `realName` / `nickname`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/announcement-import/preview
reason: 本端点的 `row.displayName` 是**公告导入行里的「姓名」列**(用于按姓名反查队员做辅助解析),不是 `Member.displayName`;随全仓字段命名统一改名为 `realName`,语义逐字不变。
impact: 响应删除字段:`data.positions[].row.displayName`、`data.supervisions[].row.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 请求体与响应里的 `positions[].displayName` / `supervisions[].displayName` 改为 `realName`,取值与用途不变(仅 preview 的辅助解析用,execute 仍**只认 memberNo 双锚**、绝不按姓名自动落库)。前端重新 codegen 后改字段名即可。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/announcement-import/execute
reason: 本端点的 `row.displayName` 是**公告导入行里的「姓名」列**(用于按姓名反查队员做辅助解析),不是 `Member.displayName`;随全仓字段命名统一改名为 `realName`,语义逐字不变。
impact: 响应删除字段:`data.positions[].row.displayName`、`data.supervisions[].row.displayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: 请求体与响应里的 `positions[].displayName` / `supervisions[].displayName` 改为 `realName`,取值与用途不变(仅 preview 的辅助解析用,execute 仍**只认 memberNo 双锚**、绝不按姓名自动落库)。前端重新 codegen 后改字段名即可。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/team-join/applications
reason: 扁平冗余字段 `memberDisplayName` 随主档改名为 `memberRealName` + `memberLabel`。
impact: 响应删除字段:`data.items[].memberDisplayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: `memberDisplayName` → `memberRealName`,需要完整标签读 `memberLabel`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/team-join/applications/{id}
reason: 扁平冗余字段 `memberDisplayName` 随主档改名为 `memberRealName` + `memberLabel`。
impact: 响应删除字段:`data.memberDisplayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: `memberDisplayName` → `memberRealName`,需要完整标签读 `memberLabel`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: PATCH /api/admin/v1/team-join/applications/{id}/gates
reason: 扁平冗余字段 `memberDisplayName` 随主档改名为 `memberRealName` + `memberLabel`。
impact: 响应删除字段:`data.memberDisplayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: `memberDisplayName` → `memberRealName`,需要完整标签读 `memberLabel`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/team-join/applications/{id}/evaluate
reason: 扁平冗余字段 `memberDisplayName` 随主档改名为 `memberRealName` + `memberLabel`。
impact: 响应删除字段:`data.memberDisplayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: `memberDisplayName` → `memberRealName`,需要完整标签读 `memberLabel`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/team-join/applications/{id}/join
reason: 扁平冗余字段 `memberDisplayName` 随主档改名为 `memberRealName` + `memberLabel`。
impact: 响应删除字段:`data.memberDisplayName`。调用方目前只有 srvf-admin-web(维护者 2026-08-20 确认「尚未真正投用,可随意改」),无第三方调用方。
migration: `memberDisplayName` → `memberRealName`,需要完整标签读 `memberLabel`。前端重新 codegen 后按新字段改绑定。
rollback: revert 本 PR(含 migration `20260820100000_member_identity_master_record`)。⚠️ 该 migration 含 DROP COLUMN、**不可逆**,revert 代码不会把已删的列变回来 —— 若已在有数据的库上 deploy,真回滚必须同时恢复库快照。无 feature gate、无兼容层(维护者拍板不留兼容态)。
-->
